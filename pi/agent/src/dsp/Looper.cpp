#include "dsp/Looper.h"

#include <algorithm>
#include <cstdint>

namespace {
// Shared by every layer, so a level sent as 0-100 on the wire and a level read
// back for the UI round trip through the same normalised storage the audio
// path uses.
float percentToLevel(float percent) {
    return std::clamp(percent, 0.0f, 100.0f) / 100.0f;
}
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
                // The boot take hit its max cap.
                layer.length = layer.stopAt - layer.startAt;
                cycleLength_ = layer.length;
                layer.truncated = true;
            }

            layer.playing = true;
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
        // same start, and the take runs until stopped or the cap hits.
        origin_ = layer.startAt;
        layer.stopAt = layer.startAt + maxSamples;
        layer.playing = false;
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
        return;
    }

    if (transportActive()) {
        // A take stopped before its boundary is discarded rather than padded:
        // a shorter loop is impossible under the one-cycle rule, so what
        // remains is either the whole boundary or nothing.
        layer.startAt = 0;
        layer.stopAt = 0;
        return;
    }

    // The boot take: how far it got is the loop length. Nothing recorded
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
}

void Looper::pasteChain(int index, EffectChain chain) {
    if (valid(index)) {
        layers_[static_cast<std::size_t>(index)].chain = std::move(chain);
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
    }
}

void Looper::setLevel(int index, float percent) {
    if (valid(index)) {
        layers_[static_cast<std::size_t>(index)].level = percentToLevel(percent);
    }
}

void Looper::clear(int index) {
    if (valid(index)) {
        reset(layers_[static_cast<std::size_t>(index)]);
        resetTransportIfEmpty();
    }
}

void Looper::clearAll() {
    for (auto& layer : layers_) {
        reset(layer);
    }

    resetTransportIfEmpty();
}

void Looper::undo() {
    for (int index = static_cast<int>(layers_.size()) - 1; index >= 0; --index) {
        if (layers_[static_cast<std::size_t>(index)].length > 0) {
            reset(layers_[static_cast<std::size_t>(index)]);
            resetTransportIfEmpty();
            return;
        }
    }
}

LooperState Looper::state() const {
    const float rate = static_cast<float>(std::max(1, config_.sampleRate));

    LooperState result;
    result.maxSeconds = config_.maxSeconds;
    result.countdownSeconds = config_.countdownSeconds;

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
        // The next boundary at least a countdown away. Targeting the boundary
        // rather than clock_ + countdown is what makes every arm click in on
        // the same beat, whether it lands mid-cycle or on one.
        const std::size_t countdown = secondsToSamples(config_.countdownSeconds);
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

    return clock_ + secondsToSamples(config_.countdownSeconds);
}

bool Looper::anyFirstTakeArmed() const {
    for (const auto& layer : layers_) {
        if (layer.length == 0 && (layer.waiting || layer.recording)) {
            return true;
        }
    }

    return false;
}