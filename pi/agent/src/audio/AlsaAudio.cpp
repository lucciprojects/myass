#include "audio/AlsaAudio.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

namespace {
constexpr unsigned int SAMPLE_RATE = 48000;
constexpr unsigned int CHANNELS = 2;
constexpr snd_pcm_format_t FORMAT = SND_PCM_FORMAT_S16_LE;

// Upper bound on the block size read() and write() will accept. Their staging
// buffers are sized from this, and both refuse anything larger rather than
// writing past the end.
constexpr int MAX_FRAMES = 2048;

// The period and the buffer together set the scale of the input to output
// delay. They used to be left to snd_pcm_set_params, whose last argument is a
// latency request in microseconds: at 500000 that asked for half a second of
// buffering on the capture stream and another half on the playback stream,
// which is where the seconds of delay came from. The period is now pinned
// explicitly rather than inherited, because capture hands over whole periods
// and a frame cannot move until the rest of its period has arrived.
// 256 frames is 5.3ms.
constexpr snd_pcm_uframes_t DEVICE_PERIOD = 256;

// The buffer, not the period, is what bounds the delay: everything queued in
// it sits there before it is heard. Two periods is 512 frames, 10.7ms. More
// periods buy resilience against underruns at the cost of latency, so raise
// this if the output crackles on a loaded machine.
constexpr unsigned int PERIODS_PER_BUFFER = 2;

// How long to keep retrying a transfer that reports -EAGAIN before calling the
// stream stalled. One block is 5.3ms, so 250ms is about 47 blocks: far beyond
// scheduling jitter, and short enough that a wedged device is reported while
// someone is still watching the log.
//
// Without this the streams are blocking, so a device that stops delivering
// parks the audio thread forever. The control server is a separate thread and
// keeps answering, which makes a dead rig look perfectly healthy.
constexpr int STALL_TIMEOUT_MS = 250;

// How long to sleep between transfer attempts while a stream is between
// periods. One period is 5.3ms, so this crosses it in about eleven tries:
// short enough not to appear as latency, long enough that a starved stream does
// not spin a core.
constexpr std::chrono::microseconds RETRY_INTERVAL{500};

// Escape hatch, and the switch that tells a broken wait apart from a dead
// device. MYASS_AUDIO_WAIT=0 opens the streams blocking, which is how the agent
// behaved before stall detection existed: real time throughput, but a device
// that stops delivering parks the audio thread with nothing logged.
bool boundedWait() {
    const char* const value = std::getenv("MYASS_AUDIO_WAIT");
    return value == nullptr || std::string(value) != "0";
}

// Configures one stream for the lowest latency it will accept and reports what
// it actually granted, handing the granted buffer size back through
// grantedBuffer so the caller can total the two streams. Returns false if any
// step fails, having already said why on stderr.
bool configureLowLatency(
    snd_pcm_t* pcm,
    const char* label,
    snd_pcm_uframes_t* grantedBuffer
) {
    snd_pcm_hw_params_t* hw = nullptr;

    if (snd_pcm_hw_params_malloc(&hw) < 0) {
        std::cerr << "Out of memory allocating " << label << " params\n";
        return false;
    }

    // Anything that fails from here has to free hw before returning.
    struct ParamsGuard {
        snd_pcm_hw_params_t* hw;

        ~ParamsGuard() {
            snd_pcm_hw_params_free(hw);
        }
    } guard{hw};

    snd_pcm_uframes_t period = DEVICE_PERIOD;
    snd_pcm_uframes_t buffer = DEVICE_PERIOD * PERIODS_PER_BUFFER;
    unsigned int rate = SAMPLE_RATE;
    int dir = 0;

    // Each step is checked on its own, so the message names the call that
    // actually failed. Accumulating the codes and reporting one number would
    // throw away both the step and the real errno.
    const auto step = [&](int code, const char* what) {
        if (code < 0) {
            std::cerr << "Failed to set " << label << ' ' << what << ": "
                      << snd_strerror(code) << '\n';
            return false;
        }

        return true;
    };

    // "near" all the way down: the device picks the closest it can do, and we
    // read back what it picked. Pinning the rate exactly is not worth failing
    // the open over, because the resampler that a mismatch would need is a
    // far larger cost than the fraction of a cent involved.
    if (!step(snd_pcm_hw_params_any(pcm, hw), "base params") ||
        !step(snd_pcm_hw_params_set_access(
                  pcm, hw, SND_PCM_ACCESS_RW_INTERLEAVED), "access") ||
        !step(snd_pcm_hw_params_set_format(pcm, hw, FORMAT), "format") ||
        !step(snd_pcm_hw_params_set_channels(pcm, hw, CHANNELS), "channels") ||
        !step(snd_pcm_hw_params_set_rate_near(pcm, hw, &rate, &dir),
              "rate") ||
        !step(snd_pcm_hw_params_set_period_size_near(
                  pcm, hw, &period, &dir), "period") ||
        !step(snd_pcm_hw_params_set_buffer_size_near(pcm, hw, &buffer),
              "buffer")) {
        return false;
    }

    const int applied = snd_pcm_hw_params(pcm, hw);

    if (applied < 0) {
        std::cerr << "Failed to configure " << label << ": "
                  << snd_strerror(applied) << '\n';
        return false;
    }

    // Read the values back rather than trust what was asked for. The device
    // may have granted something else entirely, and these are the only numbers
    // that explain any delay a player hears.
    snd_pcm_uframes_t actualPeriod = 0;
    snd_pcm_uframes_t actualBuffer = 0;
    unsigned int actualRate = 0;

    snd_pcm_hw_params_get_period_size(hw, &actualPeriod, &dir);
    snd_pcm_hw_params_get_buffer_size(hw, &actualBuffer);
    snd_pcm_hw_params_get_rate(hw, &actualRate, &dir);

    std::cout << "ALSA " << label << ": " << actualRate << "Hz, "
              << actualPeriod << " frame period, " << actualBuffer
              << " frame buffer ("
              << (actualBuffer * 1000 / actualRate) << "ms)\n";

    *grantedBuffer = actualBuffer;

    return true;
}

void zeroBlock(float* buffer, int frames) {
    for (int frame = 0; frame < frames; ++frame) {
        buffer[frame] = 0.0f;
    }
}

// Outcome of one transfer attempt, plus what the device actually reported.
struct TransferResult {
    enum class Status {
        Complete,  // frames moved, see moved
        Stalled,   // nothing transferred within the deadline
        Failed,    // the device reported an error
    };

    Status status = Status::Complete;

    // Frames transferred on Complete, or the negative errno on Failed. Not
    // meaningful on Stalled.
    snd_pcm_sframes_t moved = 0;
};

// Runs a transfer, retrying while the stream sits between periods.
//
// Readiness is answered by the transfer itself reporting -EAGAIN, never by a
// file descriptor. Both descriptor routes were tried on the pipewire plugin this
// agent runs against and both were wrong: poll() over
// snd_pcm_poll_descriptors and snd_pcm_wait each time out against a stream that
// is demonstrably streaming, so every block burned the whole 250ms deadline and
// the rig managed 8 blocks in 2 seconds while calling a healthy device stalled.
// A plugin is free to leave its descriptors unusable, so the fix is to stop
// depending on them.
//
// On a blocking handle attempt() never returns -EAGAIN, so the loop runs once
// and the deadline is never reached. That is what MYASS_AUDIO_WAIT=0 buys:
// real time throughput with no stall detection.
template <typename Attempt>
TransferResult awaitTransfer(Attempt attempt) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(STALL_TIMEOUT_MS);

    for (;;) {
        const snd_pcm_sframes_t moved = attempt();

        if (moved >= 0) {
            return {TransferResult::Status::Complete, moved};
        }

        if (moved != -EAGAIN) {
            return {TransferResult::Status::Failed, moved};
        }

        if (std::chrono::steady_clock::now() >= deadline) {
            return {TransferResult::Status::Stalled, 0};
        }

        std::this_thread::sleep_for(RETRY_INTERVAL);
    }
}
} // namespace

AlsaAudio::AlsaAudio()
    : boundedWaitEnabled(boundedWait()) {
    if (!boundedWaitEnabled) {
        std::cerr << "MYASS_AUDIO_WAIT=0: blocking transfers, "
                     "no stall detection\n";
    }
}

AlsaAudio::~AlsaAudio() {
    close();
}

bool AlsaAudio::open() {
    int result;

    // Non-blocking is what makes awaitTransfer possible: the transfers have to
    // be free to report that the stream is between periods instead of parking
    // inside alsa-lib until a period arrives.
    const int openFlags = boundedWaitEnabled ? SND_PCM_NONBLOCK : 0;

    result = snd_pcm_open(
        &input_,
        "pipewire",
        SND_PCM_STREAM_CAPTURE,
        openFlags
    );

    if (result < 0) {
        std::cerr << "Failed to open input: "
                  << snd_strerror(result) << '\n';
        return false;
    }

    result = snd_pcm_open(
        &output_,
        "pipewire",
        SND_PCM_STREAM_PLAYBACK,
        openFlags
    );

    if (result < 0) {
        std::cerr << "Failed to open output: "
                  << snd_strerror(result) << '\n';
        close();
        return false;
    }

    snd_pcm_uframes_t captureBuffer = 0;
    snd_pcm_uframes_t playbackBuffer = 0;

    if (!configureLowLatency(input_, "capture", &captureBuffer)) {
        close();
        return false;
    }

    if (!configureLowLatency(output_, "playback", &playbackBuffer)) {
        close();
        return false;
    }

    // The two figures above are the ALSA side of the delay. Whatever PipeWire
    // buffers in its own graph sits on top and is not visible from here, so
    // this total is a lower bound rather than the whole story.
    const snd_pcm_uframes_t total = captureBuffer + playbackBuffer;

    std::cout << "ALSA buffering: " << total << " frames ("
              << (total * 1000 / SAMPLE_RATE)
              << "ms) across both streams, before PipeWire graph latency\n";

    return true;
}

void AlsaAudio::close() {
    if (input_) {
        snd_pcm_close(input_);
        input_ = nullptr;
    }

    if (output_) {
        snd_pcm_close(output_);
        output_ = nullptr;
    }
}

bool AlsaAudio::read(float* buffer, int frames) {
    static int16_t samples[MAX_FRAMES * CHANNELS];

    // The staging buffer is fixed size, so a caller asking for more than it
    // can hold would overrun it. Refuse instead.
    if (frames <= 0 || frames > MAX_FRAMES) {
        std::cerr << "Refusing read of " << frames
                  << " frames, limit is " << MAX_FRAMES << '\n';
        return false;
    }

    const TransferResult transfer = awaitTransfer(
        [&] { return snd_pcm_readi(input_, samples, frames); });

    if (transfer.status == TransferResult::Status::Stalled) {
        // No recovery call here on purpose. A timeout means the stream was
        // starved, not broken, and preparing a healthy stream over a late block
        // would cost more than the silence. A device that has actually gone
        // returns a real error on the next attempt, which is handled below
        // with the errno the device gave rather than a guessed one.
        //
        // Logged once. The counter below is the ongoing signal, and it is
        // already in the periodic line, so a line per stall would be spam
        // rather than information.
        if (stalls_ == 1) {
            std::cerr << "ALSA capture stalled: no transfer in "
                      << STALL_TIMEOUT_MS << "ms, counting the rest\n";
        }

        stalls_ += 1;
        zeroBlock(buffer, frames);
        return true;
    }

    if (transfer.status == TransferResult::Status::Failed) {
        // Silence, not whatever the caller had there before. Returning true
        // without filling the buffer replays the previous 256 samples, which
        // sounds like a dropout every time it happens.
        zeroBlock(buffer, frames);

        const int recovered = snd_pcm_recover(
            input_, static_cast<int>(transfer.moved), 1);

        if (recovered < 0) {
            std::cerr << "Failed to read audio: "
                      << snd_strerror(recovered) << '\n';
            return false;
        }

        return true;
    }

    // A short transfer leaves the tail of samples holding the previous block,
    // which would replay stale audio as if it were live. It should not happen
    // with hw params, so the log line is the point: if the rig sounds wrong,
    // this is the only trace of why.
    if (transfer.moved < frames) {
        std::cerr << "ALSA capture short read: " << transfer.moved << " of "
                  << frames << " frames\n";

        std::fill(
            samples + transfer.moved * CHANNELS,
            samples + frames * CHANNELS,
            static_cast<int16_t>(0));
    }

    for (int frame = 0; frame < frames; ++frame) {
        // UMC22 guitar is plugged into the RIGHT input.
        const int16_t sample = samples[frame * CHANNELS + 1];

        buffer[frame] =
            static_cast<float>(sample) / 32768.0f;
    }

    return true;
}

bool AlsaAudio::write(const float* buffer, int frames) {
    static int16_t samples[MAX_FRAMES * CHANNELS];

    // Same bound as read(), same reason.
    if (frames <= 0 || frames > MAX_FRAMES) {
        std::cerr << "Refusing write of " << frames
                  << " frames, limit is " << MAX_FRAMES << '\n';
        return false;
    }

    for (int frame = 0; frame < frames; ++frame) {
        float sample = buffer[frame];

        if (sample > 1.0f) {
            sample = 1.0f;
        }

        if (sample < -1.0f) {
            sample = -1.0f;
        }

        const int16_t converted =
            static_cast<int16_t>(sample * 32767.0f);

        // Send the same processed signal to L and R.
        samples[frame * CHANNELS] = converted;
        samples[frame * CHANNELS + 1] = converted;
    }

    // A stalled playback stream gets the block dropped rather than queued. The
    // samples would be stale by the time they were heard, so silence is the
    // better artefact, and the next block is only 5.3ms behind.
    const TransferResult transfer = awaitTransfer(
        [&] { return snd_pcm_writei(output_, samples, frames); });

    if (transfer.status == TransferResult::Status::Stalled) {
        if (stalls_ == 1) {
            std::cerr << "ALSA playback stalled: no transfer in "
                      << STALL_TIMEOUT_MS << "ms, dropping the rest\n";
        }

        stalls_ += 1;
        return true;
    }

    if (transfer.status == TransferResult::Status::Failed) {
        const int recovered = snd_pcm_recover(
            output_, static_cast<int>(transfer.moved), 1);

        if (recovered < 0) {
            std::cerr << "Failed to write audio: "
                      << snd_strerror(recovered) << '\n';
            return false;
        }
    }

    return true;
}