#include "dsp/DspEngine.h"

#include "effects/StandardEffects.h"

#include <utility>

void DspEngine::applyChain(EffectChain chain) {
    std::lock_guard<std::mutex> lock(mutex_);
    effects_ = std::move(chain);
}

DspEngine::DspEngine(const LooperConfig& looperConfig)
    : looper_(looperConfig) {
}

void DspEngine::processBlock(float* buffer, int frames) {
    std::lock_guard<std::mutex> lock(mutex_);

    for (int frame = 0; frame < frames; ++frame) {
        const float input = buffer[frame];

        // The instrument through the live chain...
        float sample = input;

        for (const auto& effect : effects_) {
            if (effect->enabled()) {
                sample = effect->process(sample);
            }
        }

        // ...plus the loops through the chains each layer captured when it was
        // armed. The loop no longer passes through the live board: a take keeps
        // the sound it was recorded with, so changing the board does not
        // re-colour what is already looping.
        buffer[frame] = sample + looper_.process(input);
    }
}

void DspEngine::loopRecord(int layer, float maxSeconds) {
    std::lock_guard<std::mutex> lock(mutex_);

    // The chain copied into the layer is a fresh deep copy, not a view. The
    // layer would otherwise share the live effects and a later commit would
    // re-colour every take that was recorded under it.
    looper_.record(layer, maxSeconds, cloneChain(effects_));
}

void DspEngine::loopPasteChain(int layer) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.pasteChain(layer, cloneChain(effects_));
}

void DspEngine::loopStop(int layer) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.stop(layer);
}

void DspEngine::loopTogglePlay(int layer) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.togglePlay(layer);
}

void DspEngine::loopTogglePause() {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.togglePause();
}

void DspEngine::loopToggleMute(int layer) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.toggleMute(layer);
}

void DspEngine::loopSetLevel(int layer, float percent) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.setLevel(layer, percent);
}

void DspEngine::loopClear(int layer) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.clear(layer);
}

void DspEngine::loopClearAll() {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.clearAll();
}

void DspEngine::loopUndo() {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.undo();
}

bool DspEngine::loopSetTempo(float bpm, int beatsPerBar) {
    std::lock_guard<std::mutex> lock(mutex_);
    return looper_.setTempo(bpm, beatsPerBar);
}

bool DspEngine::loopSetBars(int bars) {
    std::lock_guard<std::mutex> lock(mutex_);
    return looper_.setBars(bars);
}

void DspEngine::loopSetClickMode(ClickMode mode) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.setClickMode(mode);
}

DspEngine::LayerDump DspEngine::dumpLayer(
    int layer,
    std::size_t offset,
    std::size_t count
) const {
    std::lock_guard<std::mutex> lock(mutex_);

    const Looper::Dump dump = looper_.dump(layer, offset, count);

    LayerDump result;
    result.busy = dump.busy;
    result.offset = offset;
    result.total = dump.total;
    result.samples = dump.samples;
    result.count = dump.samples.size();

    return result;
}

bool DspEngine::commitProject(StagedProject& staged) {
    std::lock_guard<std::mutex> lock(mutex_);

    // A load replaces every buffer, so it cannot run while one of them is
    // still being written by a take.
    if (looper_.anyTakeActive()) {
        return false;
    }

    if (!looper_.load(staged.loop)) {
        return false;
    }

    // The board is part of the project, but only when the bundle carried one.
    // An older project with no board leaves the live chain alone.
    if (staged.setsBoard) {
        effects_ = std::move(staged.board);
    }

    return true;
}

std::vector<EffectSnapshot> DspEngine::loopChainSnapshot(int layer) const {
    std::lock_guard<std::mutex> lock(mutex_);

    const EffectChain& chain = looper_.chain(layer);

    std::vector<EffectSnapshot> result;
    result.reserve(chain.size());

    for (const auto& effect : chain) {
        result.push_back(snapshotOf(*effect));
    }

    return result;
}

void DspEngine::setLoopChain(int layer, EffectChain chain) {
    std::lock_guard<std::mutex> lock(mutex_);
    looper_.pasteChain(layer, std::move(chain));
}

std::size_t DspEngine::loopCapacitySamples() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return looper_.capacity();
}

LooperState DspEngine::loopState() const {
    std::lock_guard<std::mutex> lock(mutex_);

    LooperState state = looper_.state();

    // The looper does not know what board is live; the engine does. Flag each
    // layer so the UI can show whether the paste button would change anything.
    for (std::size_t index = 0; index < state.layers.size(); ++index) {
        state.layers[index].chainCurrent =
            chainsEqual(looper_.chain(index), effects_);
    }

    return state;
}

float DspEngine::loopMaxSeconds() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return looper_.maxSeconds();
}

std::vector<EffectSnapshot> DspEngine::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);

    std::vector<EffectSnapshot> result;
    result.reserve(effects_.size());

    for (const auto& effect : effects_) {
        result.push_back(snapshotOf(*effect));
    }

    return result;
}
