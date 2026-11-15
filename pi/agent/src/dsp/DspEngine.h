#pragma once

#include "dsp/Looper.h"
#include "effects/Effect.h"

#include <memory>
#include <mutex>
#include <string>
#include <utility>
#include <vector>

class DspEngine {
public:
    explicit DspEngine(const LooperConfig& looperConfig = LooperConfig{});

    // The caller has already built and validated the chain, so this only
    // swaps. That keeps the lock hold time to a pointer move and means a
    // rejected slot can never half-apply on the audio thread.
    void applyChain(EffectChain chain);

    // One lock per block rather than per sample.
    void processBlock(float* buffer, int frames);

    std::vector<EffectSnapshot> snapshot() const;

    // Transport. Each takes the same lock processBlock does, so a block never
    // observes a half-changed looper.
    void loopRecord(int layer, float maxSeconds);
    void loopStop(int layer);
    void loopTogglePlay(int layer);
    void loopTogglePause();
    void loopToggleMute(int layer);
    void loopSetLevel(int layer, float percent);
    void loopClear(int layer);
    void loopClearAll();
    void loopUndo();
    void loopPasteChain(int layer);

    // Musical time. Both return false when the looper is busy, which the
    // control server turns into `error busy`.
    bool loopSetTempo(float bpm, int beatsPerBar);
    bool loopSetBars(int bars);
    void loopSetClickMode(ClickMode mode);

    // Transfer. A dump copies one chunk under the lock and reports busy rather
    // than reading a buffer that is still being recorded.
    struct LayerDump {
        bool busy = false;
        std::size_t offset = 0;
        std::size_t count = 0;
        std::size_t total = 0;
        std::vector<float> samples;
    };
    LayerDump dumpLayer(int layer, std::size_t offset, std::size_t count) const;

    // A project assembled by the control thread outside the lock, then applied
    // with one short critical section.
    struct StagedProject {
        LoopLoad loop;
        EffectChain board;
        bool setsBoard = false;
    };
    bool commitProject(StagedProject& staged);

    // Per-layer captured chains, read and written independently of the live
    // board.
    std::vector<EffectSnapshot> loopChainSnapshot(int layer) const;
    void setLoopChain(int layer, EffectChain chain);

    std::size_t loopCapacitySamples() const;

    LooperState loopState() const;
    float loopMaxSeconds() const;

private:
    mutable std::mutex mutex_;
    EffectChain effects_;

    // Deliberately not part of effects_: the chain is rebuilt from scratch on
    // every commit, which would delete a recording the moment anyone touched a
    // slider. The looper is the one piece of persistent state in the audio
    // path, so it sits beside the chain and shares its lock.
    Looper looper_;
};
