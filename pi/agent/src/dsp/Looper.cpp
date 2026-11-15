#include "dsp/Looper.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace {
// Shared by every layer, so a level sent as 0-100 on the wire and a level read
// back for the UI round trip through the same normalised storage the audio
// path uses.
float percentToLevel(float percent) {
    return std::clamp(percent, 0.0f, 100.0f) / 100.0f;
}

// A short sine burst per beat. The accent is the downbeat; the decay is short
// enough that the click reads as a tick rather than a tone and never masks the
// guitar. All of it is synthesised here so the agent needs no click sample file.
constexpr float CLICK_ACCENT_HZ = 1600.0f;
constexpr float CLICK_BEAT_HZ = 1200.0f;
constexpr float CLICK_ACCENT_GAIN = 0.35f;
constexpr float CLICK_BEAT_GAIN = 0.22f;
constexpr float CLICK_DECAY_SECONDS = 0.0012f;
constexpr float CLICK_LENGTH_SECONDS = 0.003f;
constexpr double TWO_PI = 6.283185307179586476925286766559;
} // namespace

Looper::Looper(const LooperConfig& config)
    : config_(config)
    , capacity_(static_cast<std::size_t>(
          std::max(1.0f, config.maxSeconds) *
          static_cast<float>(std::max(1, config.sampleRate))))
    , layers_(static_cast<std::size_t>(std::max(1, config.maxLayers))) {
    for (auto& layer : layers_) {
        // Reserved once, here. The audio path only ever indexes into this, and
        // that is what keeps starting a record free of allocation.
        layer.data.resize(capacity_, 0.0f);
    }
}

float Looper::process(float input) {
    float sum = 0.0f;

    // True freeze-pause: while paused the clock holds its position and the
    // loops fall silent. The dry input still passes (this contribution is
    // added on top of it), and resuming picks up at the exact sample that was
    // frozen, every layer still in phase.
    if (paused_) {
        return 0.0f;
    }

    for (auto& layer : layers_) {
        // A countdown crossing begins the take on a sample boundary. Arming
        // scheduled the start at the next cycle boundary (or countdown from
        // now for the very first take), so the clock sets the pen down exactly
        // where the loop expects it.
        if (layer.waiting && clock_ >= layer.startAt) {
            layer.waiting = false;
            layer.recording = true;
        }

        // A first take that reached its scheduled end finishes here, one
        // sample early, so the last write that happened sits at exactly
        // length - 1.
        if (layer.recording && layer.length == 0 && layer.stopAt > 0 &&
            clock_ >= layer.stopAt) {
            layer.recording = false;

            if (transportActive()) {
                // Boundary reached: the take filled the cycle, as forced-match
                // requires. A normal stop, not a truncation.
                layer.length = cycleLength_;
                layer.truncated = false;
            } else {
                // The boot take reached the length it was armed with. A
                // bar-quantized take always does; only a FREE take that hit the
                // 32-second ceiling has really been cut short.
                layer.length = layer.stopAt - layer.startAt;
                cycleLength_ = layer.length;
                layer.truncated = !layer.quantized;
            }

            layer.playing = true;
            layer.revision += 1;
            revision_ += 1;
        }

        // Read before write. The read only ever happens for a layer already
        // playing: an overdub hears the existing pass laid in while the new one
        // is being written, instead of doubling on the single frame the new
        // material lands.
        if (layer.playing && layer.length > 0 && !layer.muted) {
            float sample = layer.data[phaseIndex()];

            // The chain this layer captured when it was armed, not the live
            // board. All of these released back into the engine's lock scope,
            // so the chain is stable for the whole block.
            for (const auto& effect : layer.chain) {
                if (effect->enabled()) {
                    sample = effect->process(sample);
                }
            }

            sum += sample * layer.level;
        }

        if (!layer.recording) {
            continue;
        }

        if (layer.length > 0) {
            // An overdub writes exactly where it reads: the same derived
            // phase index, so what is laid over returns in cycle with the
            // original. Wraps until the player stops by hand.
            layer.data[phaseIndex()] += input * config_.overdubGain;
        } else {
            // A first take writes forward from its own start. Stored at unity,
            // not at overdubGain: nothing is stacking on top of it yet, and a
            // riff should come back at the level it was played. Assignment
            // rather than accumulation, so a layer re-recorded over an earlier
            // take cannot inherit the old one past the new end.
            const std::size_t index = clock_ - layer.startAt;

            if (index < capacity_) {
                layer.data[index] = input;
            }
        }
    }

    // The click is added on the way out, after every layer write. It is never
    // part of `input`, so no take can capture it; and it is silent unless a
    // count-in or a take is running, so plain playback stays clean.
    sum += nextClickSample();

    clock_ += 1;

    return sum;
}

void Looper::record(int index, float maxSeconds, EffectChain chain) {
    if (!valid(index)) {
        return;
    }

    Layer& layer = layers_[static_cast<std::size_t>(index)];

    if (layer.recording || layer.waiting) {
        return;
    }

    const float maxClamped =
        std::clamp(maxSeconds, 0.001f, config_.maxSeconds);
    const std::size_t maxSamples = secondsToSamples(maxClamped);

    // The chain that was live at the moment the player armed the take is the
    // sound this layer keeps, permanently, until it is pasted over or the
    // layer clears. Copied at arm rather than at stop so a chain change during
    // the countdown does not change what the take will sound like.
    layer.chain = std::move(chain);
    layer.truncated = false;
    layer.quantized = false;
    layer.startAt = scheduleStart();
    layer.maxSamples = maxSamples;

    if (layer.length > 0) {
        // Overdub: begin at the next boundary, wrap until stopped by hand, and
        // keep hearing the old pass while doing it.
        layer.stopAt = 0;
        layer.playing = true;
    } else if (transportActive()) {
        // A later first take is forced to fill the cycle: one pass, ending at
        // the boundary it started on. The player's max choice is ignored; the
        // loop is the loop.
        layer.stopAt = layer.startAt + cycleLength_;
        layer.maxSamples = cycleLength_;
        layer.playing = false;
    } else {
        // The boot take defines the cycle. The phase origin is fixed now so
        // that anything else armed before this take crosses lines up with the
        // same start.
        origin_ = layer.startAt;

        if (bars_ > 0) {
            // Bar-quantized: the length was chosen before arming, so the take
            // stops itself on the last bar line and `max=` is ignored.
            const std::size_t length =
                std::min(loopSamplesForBars(bars_), capacity_);

            layer.stopAt = layer.startAt + length;
            layer.maxSamples = length;
            layer.quantized = true;
        } else {
            // FREE: the take runs until stopped or the cap hits.
            layer.stopAt = layer.startAt + maxSamples;
            layer.playing = false;
        }
    }

    layer.waiting = true;
    layer.recording = false;
}

void Looper::stop(int index) {
    if (!valid(index)) {
        return;
    }

    Layer& layer = layers_[static_cast<std::size_t>(index)];

    if (layer.waiting) {
        // Cancelling a countdown leaves the layer exactly as it was. Arming
        // again later starts a fresh take with a fresh countdown.
        layer.waiting = false;
        return;
    }

    if (!layer.recording) {
        return;
    }

    layer.recording = false;

    if (layer.length > 0) {
        // An overdub finishes; length and chain stay as they were.
        layer.playing = true;
        layer.revision += 1;
        revision_ += 1;
        return;
    }

    if (transportActive()) {
        // A take stopped before its boundary is discarded rather than padded:
        // a shorter loop is impossible under the one-cycle rule, so what
        // remains is either the whole boundary or nothing.
        layer.startAt = 0;
        layer.stopAt = 0;
        layer.quantized = false;
        return;
    }

    if (layer.quantized) {
        // The bars were chosen before arming, so a partial take is not a loop.
        // Discard it rather than adopt a length the player did not ask for.
        reset(layer);
        return;
    }

    // The FREE boot take: how far it got is the loop length. Nothing recorded
    // (stopped before the first sample) is a cancel, same as a countdown one.
    const std::size_t length = clock_ - layer.startAt;

    if (length == 0) {
        layer.startAt = 0;
        layer.stopAt = 0;
        return;
    }

    layer.length = length;
    cycleLength_ = length;
    layer.playing = true;
    layer.revision += 1;
    revision_ += 1;
}

void Looper::pasteChain(int index, EffectChain chain) {
    if (valid(index)) {
        layers_[static_cast<std::size_t>(index)].chain = std::move(chain);
        bumpRevision();
    }
}

void Looper::togglePlay(int index) {
    if (!valid(index)) {
        return;
    }

    Layer& layer = layers_[static_cast<std::size_t>(index)];

    if (layer.length == 0) {
        return;
    }

    layer.playing = !layer.playing;
    bumpRevision();

    // There is no position to rewind: the read index is derived from the
    // shared clock, so a play command does not move the loop, it only decides
    // whether the layer contributes. That is what keeps every layer locked to
    // the same beat.
}

void Looper::togglePause() {
    paused_ = !paused_;
}

void Looper::toggleMute(int index) {
    if (valid(index)) {
        Layer& layer = layers_[static_cast<std::size_t>(index)];
        layer.muted = !layer.muted;
        bumpRevision();
    }
}

void Looper::setLevel(int index, float percent) {
    if (valid(index)) {
        layers_[static_cast<std::size_t>(index)].level = percentToLevel(percent);
        bumpRevision();
    }
}

void Looper::clear(int index) {
    if (valid(index)) {
        Layer& layer = layers_[static_cast<std::size_t>(index)];

        reset(layer);
        layer.revision += 1;
        resetTransportIfEmpty();
        bumpRevision();
    }
}

void Looper::clearAll() {
    for (auto& layer : layers_) {
        reset(layer);
        layer.revision += 1;
    }

    resetTransportIfEmpty();
    bumpRevision();
}

void Looper::undo() {
    for (int index = static_cast<int>(layers_.size()) - 1; index >= 0; --index) {
        Layer& layer = layers_[static_cast<std::size_t>(index)];

        if (layer.length > 0) {
            reset(layer);
            layer.revision += 1;
            resetTransportIfEmpty();
            bumpRevision();
            return;
        }
    }
}

LooperState Looper::state() const {
    const float rate = static_cast<float>(std::max(1, config_.sampleRate));

    LooperState result;
    result.maxSeconds = config_.maxSeconds;

    // The count-in is one bar, so the UI's countdown scale follows the tempo
    // rather than a fixed three seconds.
    result.countdownSeconds =
        static_cast<float>(barSamples()) / rate;

    result.sampleRate = config_.sampleRate;
    result.bpm = bpm_;
    result.beatsPerBar = beatsPerBar_;
    result.bars = bars_;
    result.click = clickMode_;
    result.loopSamples = cycleLength_;
    result.revision = revision_;

    if (transportActive()) {
        result.transportSeconds = static_cast<float>(cycleLength_) / rate;
    }

    result.paused = paused_;

    result.layers.reserve(layers_.size());

    for (std::size_t index = 0; index < layers_.size(); ++index) {
        const Layer& layer = layers_[index];

        LoopLayerState entry;
        entry.index = static_cast<int>(index);
        entry.playing = layer.playing;
        entry.recording = layer.recording;
        entry.waiting = layer.waiting;
        entry.muted = layer.muted;
        entry.truncated = layer.truncated;
        entry.level = layer.level * 100.0f;
        entry.seconds = static_cast<float>(layer.length) / rate;
        entry.samples = layer.length;
        entry.revision = layer.revision;
        entry.maxSeconds = static_cast<float>(layer.maxSamples) / rate;

        if (layer.waiting) {
            const std::int64_t remaining =
                static_cast<std::int64_t>(layer.startAt) -
                static_cast<std::int64_t>(clock_);
            entry.countdown = remaining > 0
                ? static_cast<float>(remaining) / rate
                : 0.0f;
        }

        if (layer.recording && layer.length == 0) {
            // A take still being captured shows how far it has got.
            entry.position = static_cast<float>(clock_ - layer.startAt) / rate;
        } else if (transportActive()) {
            // Every layer shares the transport playhead, so loops recorded at
            // different times stay locked to the same beat and the UI draws
            // all the heads at the same place.
            entry.position = static_cast<float>(phaseIndex()) / rate;
        }

        result.layers.push_back(entry);
    }

    return result;
}

const EffectChain& Looper::chain(int index) const {
    static const EffectChain EMPTY;

    if (!valid(index)) {
        return EMPTY;
    }

    return layers_[static_cast<std::size_t>(index)].chain;
}

bool Looper::valid(int index) const {
    return index >= 0 && index < static_cast<int>(layers_.size());
}

bool Looper::setTempo(float bpm, int beatsPerBar) {
    if (!(bpm >= 40.0f && bpm <= 240.0f)) {
        return false;
    }

    // 4/4 for v1. The field exists so 3/4 is a validation change, not a
    // re-layout of the transport.
    if (beatsPerBar != 4) {
        return false;
    }

    if (hasContent() || anyTakeActive()) {
        return false;
    }

    const bool changed = bpm != bpm_ || beatsPerBar != beatsPerBar_;

    bpm_ = bpm;
    beatsPerBar_ = beatsPerBar;

    // A bar count that no longer fits in the buffer cannot survive a slower
    // tempo; fall back to FREE rather than silently clamping to a length the
    // player did not pick.
    if (bars_ > 0 && loopSamplesForBars(bars_) > capacity_) {
        bars_ = 0;
    }

    if (changed) {
        bumpRevision();
    }

    return true;
}

bool Looper::setBars(int bars) {
    if (bars < 0 || bars > 64) {
        return false;
    }

    if (hasContent() || anyTakeActive()) {
        return false;
    }

    if (bars > 0 && loopSamplesForBars(bars) > capacity_) {
        return false;
    }

    if (bars != bars_) {
        bars_ = bars;
        bumpRevision();
    }

    return true;
}

void Looper::setClickMode(ClickMode mode) {
    if (mode == clickMode_) {
        return;
    }

    clickMode_ = mode;
    clickBeat_ = -1;
    clickAge_ = 0;
    bumpRevision();
}

bool Looper::load(LoopLoad& load) {
    // Validate the whole project before touching a single layer. A load that
    // fails halfway would leave a rig that is neither the old session nor the
    // new one.
    if (!(load.bpm >= 40.0f && load.bpm <= 240.0f)) {
        return false;
    }

    if (load.beatsPerBar != 4) {
        return false;
    }

    if (load.bars < 0 || load.bars > 64) {
        return false;
    }

    if (load.loopSamples > capacity_) {
        return false;
    }

    if (load.layers.size() > layers_.size()) {
        return false;
    }

    for (const auto& layer : load.layers) {
        if (layer.data.empty()) {
            continue;
        }

        // Every layer plays off one shared cycle, so a project whose layers
        // disagree on length cannot be represented and is refused.
        if (layer.samples != load.loopSamples) {
            return false;
        }

        if (layer.data.size() != layer.samples) {
            return false;
        }
    }

    for (std::size_t index = 0; index < layers_.size(); ++index) {
        Layer& target = layers_[index];

        if (index >= load.layers.size() || load.layers[index].data.empty()) {
            reset(target);
            // A project replaces the whole session, so an empty layer must not
            // keep a chain from the session it just displaced.
            target.chain.clear();
            target.revision += 1;
            continue;
        }

        LoopLoadLayer& source = load.layers[index];

        // Moved, not copied. The resize only pads the tail the phase index can
        // never reach, and costs nothing when the project is at the cap.
        target.data = std::move(source.data);

        if (target.data.size() < capacity_) {
            target.data.resize(capacity_, 0.0f);
        }

        target.length = source.samples;
        target.maxSamples = source.samples;
        target.playing = source.playing;
        target.recording = false;
        target.waiting = false;
        target.muted = source.muted;
        target.truncated = source.truncated;
        target.quantized = false;
        target.startAt = 0;
        target.stopAt = 0;
        target.level = std::clamp(source.level, 0.0f, 1.0f);
        target.chain = std::move(source.chain);
        target.revision += 1;
    }

    bpm_ = load.bpm;
    beatsPerBar_ = load.beatsPerBar;
    bars_ = load.bars;
    clickMode_ = load.click;

    cycleLength_ = load.loopSamples;
    origin_ = clock_;

    // Restoring is a deliberate act, so it never starts making noise on its
    // own: the player presses play.
    paused_ = true;

    clickBeat_ = -1;
    clickAge_ = 0;

    revision_ += 1;

    return true;
}

Looper::Dump Looper::dump(int index, std::size_t offset, std::size_t count) const {
    Dump result;

    if (!valid(index)) {
        return result;
    }

    const Layer& layer = layers_[static_cast<std::size_t>(index)];
    result.total = layer.length;

    if (layer.waiting || layer.recording) {
        result.busy = true;
        return result;
    }

    if (offset >= layer.length) {
        return result;
    }

    const std::size_t available = layer.length - offset;
    const std::size_t take = std::min(count, available);

    result.samples.assign(
        layer.data.begin() + static_cast<std::ptrdiff_t>(offset),
        layer.data.begin() + static_cast<std::ptrdiff_t>(offset + take)
    );

    return result;
}

bool Looper::hasContent() const {
    return std::any_of(
        layers_.begin(),
        layers_.end(),
        [](const Layer& layer) { return layer.length > 0; }
    );
}

bool Looper::anyTakeActive() const {
    return std::any_of(
        layers_.begin(),
        layers_.end(),
        [](const Layer& layer) {
            return layer.waiting || layer.recording;
        }
    );
}

std::size_t Looper::barSamples() const {
    const double samplesPerBeat =
        60.0 * static_cast<double>(std::max(1, config_.sampleRate)) /
        static_cast<double>(std::max(1.0f, bpm_));
    const long long rounded = std::llround(samplesPerBeat);

    return static_cast<std::size_t>(std::max(1LL, rounded)) *
           static_cast<std::size_t>(std::max(1, beatsPerBar_));
}

std::size_t Looper::beatSamples() const {
    return barSamples() / static_cast<std::size_t>(std::max(1, beatsPerBar_));
}

std::size_t Looper::loopSamplesForBars(int bars) const {
    return barSamples() * static_cast<std::size_t>(std::max(0, bars));
}

std::uint64_t Looper::layerRevision(int index) const {
    if (!valid(index)) {
        return 0;
    }

    return layers_[static_cast<std::size_t>(index)].revision;
}

void Looper::bumpRevision() {
    revision_ += 1;
}

const Looper::Layer* Looper::clickSource() const {
    const Layer* result = nullptr;

    for (const auto& layer : layers_) {
        if (!layer.waiting && !layer.recording) {
            continue;
        }

        if (result == nullptr || layer.startAt < result->startAt) {
            result = &layer;
        }
    }

    return result;
}

bool Looper::clickEnabledNow() const {
    if (clickMode_ == ClickMode::Off) {
        return false;
    }

    // The count-in always clicks, whatever mode brought us here: it is the
    // thing the player is counting.
    const bool countingIn = std::any_of(
        layers_.begin(),
        layers_.end(),
        [](const Layer& layer) { return layer.waiting; }
    );

    if (countingIn) {
        return true;
    }

    if (clickMode_ != ClickMode::CountInRecording) {
        return false;
    }

    return std::any_of(
        layers_.begin(),
        layers_.end(),
        [](const Layer& layer) { return layer.recording; }
    );
}

float Looper::nextClickSample() {
    if (!clickEnabledNow()) {
        clickBeat_ = -1;
        clickAge_ = 0;
        return 0.0f;
    }

    const Layer* source = clickSource();

    if (source == nullptr) {
        clickBeat_ = -1;
        clickAge_ = 0;
        return 0.0f;
    }

    // Anchored at the take's start, not at the cycle origin: a FREE loop can be
    // any length, and the count-in bar must still land its downbeat on the
    // sample where the take begins.
    const std::int64_t offset =
        static_cast<std::int64_t>(clock_) -
        static_cast<std::int64_t>(source->startAt) +
        static_cast<std::int64_t>(barSamples());

    if (offset >= 0) {
        const std::int64_t beat =
            offset / static_cast<std::int64_t>(beatSamples());

        if (beat != clickBeat_) {
            clickBeat_ = beat;
            clickAge_ = 0;
            clickAccent_ =
                (beat % static_cast<std::int64_t>(beatsPerBar_)) == 0;
        }
    }

    const std::size_t length = static_cast<std::size_t>(
        static_cast<float>(config_.sampleRate) * CLICK_LENGTH_SECONDS
    );

    if (clickAge_ >= length) {
        return 0.0f;
    }

    const float rate = static_cast<float>(std::max(1, config_.sampleRate));
    const float t = static_cast<float>(clickAge_) / rate;
    const float hz = clickAccent_ ? CLICK_ACCENT_HZ : CLICK_BEAT_HZ;
    const float gain = clickAccent_ ? CLICK_ACCENT_GAIN : CLICK_BEAT_GAIN;
    const float envelope = std::exp(-t / CLICK_DECAY_SECONDS);
    const float phase = static_cast<float>(
        TWO_PI * static_cast<double>(hz) * static_cast<double>(t)
    );

    clickAge_ += 1;

    return gain * envelope * std::sin(phase);
}

void Looper::reset(Layer& layer) {
    // The buffer itself is left alone. length is what gates playback, so a
    // stale sample past the new end is unreachable, and zeroing megabytes on
    // a clear would be a pointless stall.
    layer.length = 0;
    layer.maxSamples = 0;
    layer.playing = false;
    layer.recording = false;
    layer.waiting = false;
    layer.startAt = 0;
    layer.stopAt = 0;
    layer.truncated = false;
    layer.quantized = false;
}

void Looper::resetTransportIfEmpty() {
    const bool any = std::any_of(
        layers_.begin(),
        layers_.end(),
        [](const Layer& layer) { return layer.length > 0; }
    );

    if (!any) {
        cycleLength_ = 0;
        origin_ = 0;
    }
}

bool Looper::transportActive() const {
    return cycleLength_ > 0;
}

std::size_t Looper::phaseIndex() const {
    if (!transportActive()) {
        return 0;
    }

    return (clock_ - origin_) % cycleLength_;
}

std::size_t Looper::secondsToSamples(float seconds) const {
    return static_cast<std::size_t>(
        seconds * static_cast<float>(config_.sampleRate)
    );
}

std::size_t Looper::scheduleStart() {
    if (transportActive()) {
        // The next boundary at least a count-in away. Targeting the boundary
        // rather than clock_ + countdown is what makes every arm click in on
        // the same beat, whether it lands mid-cycle or on one.
        const std::size_t countdown = barSamples();
        const std::size_t target = clock_ + countdown;

        const std::size_t elapsed = target - origin_;
        const std::size_t cycles = (elapsed + cycleLength_ - 1) / cycleLength_;

        return origin_ + cycles * cycleLength_;
    }

    if (anyFirstTakeArmed()) {
        // A second first take armed before the first one has started lines up
        // with the same boot point instead of starting its own clock.
        return origin_;
    }

    return clock_ + barSamples();
}

bool Looper::anyFirstTakeArmed() const {
    for (const auto& layer : layers_) {
        if (layer.length == 0 && (layer.waiting || layer.recording)) {
            return true;
        }
    }

    return false;
}