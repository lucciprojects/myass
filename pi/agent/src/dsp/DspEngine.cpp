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
