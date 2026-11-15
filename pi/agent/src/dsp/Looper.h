#pragma once

#include "effects/Effect.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// Where the metronome is allowed to sound. The click is generated on the way
// out and never written into a layer, so no take can capture it.
enum class ClickMode { Off, CountIn, CountInRecording };

// Sized once, at construction, from LooperConfig. Changing any of these needs
// a restart: every layer buffer is allocated up front precisely so the audio
// thread never has to allocate, and a loop that can grow would break that.
struct LooperConfig {
    int sampleRate = 48000;
    int maxLayers = 8;

    // Longest single loop. 32s is 6MB per layer, so 8 layers is 49MB. That is
    // the ceiling for bar counts as much as it is for FREE takes: a project
    // load may not exceed it either.
    float maxSeconds = 32.0f;

    // Applied only to overdub passes, never to a first take. A first take is
    // stored at unity so a riff comes back at the level it was played; this is
    // what stops later passes from running away as they accumulate.
    float overdubGain = 0.7f;

    // Musical time. The count-in is derived from these rather than being a
    // fixed wall-clock duration: one bar at the current tempo, so a take always
    // starts on a downbeat. bars = 0 means FREE, the pre-tempo behaviour where
    // stopping the take defines its length.
    float bpm = 120.0f;
    int beatsPerBar = 4;
    int bars = 0;
    ClickMode click = ClickMode::CountInRecording;
};

// One layer of a project load. The buffer is moved in rather than copied, so
// the audio thread only pays for the swap, never for assembling the project.
struct LoopLoadLayer {
    std::vector<float> data;
    std::size_t samples = 0;
    float level = 1.0f;   // normalised 0-1, already converted by the caller
    bool muted = false;
    bool playing = false;
    bool truncated = false;
    EffectChain chain;
};

// A whole project as one transaction: either every layer and the grid apply,
// or nothing changes.
struct LoopLoad {
    // Index aligned with the looper's layers; an empty data buffer means the
    // layer is empty in the project.
    std::vector<LoopLoadLayer> layers;
    float bpm = 120.0f;
    int beatsPerBar = 4;
    int bars = 0;
    ClickMode click = ClickMode::CountInRecording;
    std::size_t loopSamples = 0;
};


struct LoopLayerState {
    int index = 0;
    bool playing = false;
    bool recording = false;
    bool waiting = false;
    bool muted = false;
    float level = 1.0f;

    // 0 means the layer is empty and has nothing to play.
    float seconds = 0.0f;

    // Seconds into the shared cycle, not a private counter. Every layer reports
    // the same number, which is what staying in phase means.
    float position = 0.0f;

    // The max this layer was armed with (seconds). 0 for a layer that has
    // never been armed. The chain never reports the effective cap back as
    // anything smaller after the fact.
    float maxSeconds = 0.0f;

    // Seconds left before an armed take begins. Only nonzero while waiting,
    // so a UI can tick a 3..2..1 countdown off the wire rather than off its
    // own clock.
    float countdown = 0.0f;

    // True when recording stopped because the max was reached rather than
    // because the player asked it to.
    bool truncated = false;

    // Exact integer length in samples. seconds is derived from it for the
    // existing UI; this field exists so a project round trip never has to
    // recover a WAV length by rounding a float back up.
    std::size_t samples = 0;

    // Bumped only when this layer's audio changes. The API's auto-save poller
    // compares it against the copy it already has and dumps only on a mismatch.
    std::uint64_t revision = 0;

    // Whether this layer's saved chain is the same board as the live one. Set
    // by the engine rather than the looper, because only the engine knows what
    // is live.
    bool chainCurrent = false;
};

struct LooperState {
    std::vector<LoopLayerState> layers;
    float maxSeconds = 0.0f;
    float countdownSeconds = 0.0f;

    // The length of the cycle, 0 when no loop is running. After the first take
    // every later take is forced to match this, which is the whole "layers stay
    // in phase" wager.
    float transportSeconds = 0.0f;

    // True while the master transport is frozen: the clock holds its position
    // and no layer contributes until the player resumes.
    bool paused = false;

    // Musical time and the derived grid. loopSamples is the authoritative
    // cycle length; transportSeconds is its float form for the existing UI.
    int sampleRate = 48000;
    float bpm = 120.0f;
    int beatsPerBar = 4;
    int bars = 0;
    ClickMode click = ClickMode::CountInRecording;
    std::size_t loopSamples = 0;

    // Global change counter. Anything that alters what a project save would
    // capture bumps it; the per-layer counters narrow that down to audio.
    std::uint64_t revision = 0;
};

/**
 * A multi-layer looper with one shared transport clock.
 *
 * There is exactly one counter inside this class -- clock_ -- and every layer
 * derives its read index from it as (clock - origin) mod cycle. Layers recorded
 * at different times cannot drift apart because a layer does not hold a
 * position at all. This is the difference between a looper that stays in phase
 * and a tape machine with independent decks.
 *
 * The first recording starts a countdown, then runs until stopped or capped,
 * and its length becomes the cycle. Every later take counts down to the next
 * cycle boundary, records exactly one cycle, and stops there: this is the
 * "first recording sets it, later layers forced to match" rule. A take stopped
 * before its boundary is discarded rather than padded, because a shorter loop
 * is impossible under that rule and a silent tail would only confuse.
 *
 * Note for a future FL-studio-style mode (independent lengths, manual
 * shortening): the forced-match rule lives in record() and the read index in
 * phaseIndex(). To allow per-layer lengths, make phaseIndex take the layer's
 * own length and remove the clamp of maxSamples in record(); everything else
 * (origin, countdown targeting, auto-stop) already works for any length.
 *
 * Each layer owns a copy of the chain that was live when it was armed, so a
 * loop keeps the sound it was recorded with and playback never touches the
 * live board. The copy exists because the chain the engine holds is rebuilt
 * from scratch on every commit.
 *
 * Every buffer is allocated in the constructor. The audio path only ever
 * indexes into them, so a record or play command arriving on the control
 * thread costs a few stores and can never stall the block.
 *
 * Not internally synchronised. DspEngine owns the lock that covers both this
 * and the effect chain, because a block must not observe a half-changed
 * looper either.
 */
class Looper {
public:
    explicit Looper(const LooperConfig& config);

    /**
     * One sample of the audio path. Returns the loop contribution for this
     * sample; the caller adds it to the processed input.
     *
     * Read before write, so during an overdub you hear the existing pass and
     * the new one together, and the new one lands for the next time round.
     */
    float process(float input);

    // Transport. All of these are called on the control thread with the engine
    // lock held, so none of them block or allocate.
    void record(int layer, float maxSeconds, EffectChain chain);
    void stop(int layer);
    void togglePlay(int layer);
    void togglePause();
    void toggleMute(int layer);
    void setLevel(int layer, float percent);
    void clear(int layer);
    void clearAll();
    void undo();

    // Replaces the layer's saved chain with the given one. This is the paste
    // button: take the live board and put it on a layer whose take was recorded
    // under an older setting.
    void pasteChain(int layer, EffectChain chain);

    // Musical time. Both refuse while a layer holds audio or a take is armed:
    // there is no time-stretch, so moving the grid under existing audio would
    // silently change what the player already committed to.
    bool setTempo(float bpm, int beatsPerBar);
    bool setBars(int bars);

    // Never fails; Off, CountIn and CountInRecording are all valid states.
    void setClickMode(ClickMode mode);

    // Replaces the entire loop with a saved project. Validates everything
    // first and returns false without touching anything if the project does
    // not fit; on success the rig lands paused.
    bool load(LoopLoad& load);

    // What a dump of one layer looks like. busy is set while a take is being
    // written, because reading a buffer mid-take would send a half-recorded
    // loop to the project store.
    struct Dump {
        bool busy = false;
        std::size_t total = 0;
        std::vector<float> samples;
    };
    Dump dump(int index, std::size_t offset, std::size_t count) const;

    bool hasContent() const;
    bool anyTakeActive() const;

    // The sample grid derived from bpm and beatsPerBar.
    std::size_t barSamples() const;
    std::size_t beatSamples() const;
    std::size_t loopSamplesForBars(int bars) const;

    std::uint64_t revision() const { return revision_; }
    std::uint64_t layerRevision(int index) const;

    LooperState state() const;

    int layerCount() const { return config_.maxLayers; }
    float maxSeconds() const { return config_.maxSeconds; }
    std::size_t capacity() const { return capacity_; }

    // Exposed so the engine can compare a layer's saved board against the live
    // one when building state.
    const EffectChain& chain(int index) const;

private:
    struct Layer {
        std::vector<float> data;
        std::size_t length = 0;
        std::size_t maxSamples = 0;
        bool playing = false;
        bool recording = false;
        bool waiting = false;
        std::size_t startAt = 0;
        std::size_t stopAt = 0;
        bool muted = false;
        bool truncated = false;
        bool quantized = false;
        float level = 1.0f;
        std::uint64_t revision = 0;
        EffectChain chain;
    };

    bool valid(int index) const;
    static void reset(Layer& layer);
    void resetTransportIfEmpty();

    bool transportActive() const;
    std::size_t phaseIndex() const;
    std::size_t secondsToSamples(float seconds) const;
    std::size_t scheduleStart();
    bool anyFirstTakeArmed() const;

    // The layer whose count-in or take the click should follow. Null when no
    // take is pending or running.
    const Layer* clickSource() const;
    bool clickEnabledNow() const;
    float nextClickSample();
    void bumpRevision();

    LooperConfig config_;
    std::size_t capacity_ = 0;

    // The whole transport: a sample count and the cycle it came from. clock_
    // advances once per process(); origin_ is the clock at the start of the
    // current cycle; cycleLength_ is the cycle in samples, 0 when no loop is
    // running.
    std::size_t clock_ = 0;
    std::size_t origin_ = 0;
    std::size_t cycleLength_ = 0;

    // True while the transport is frozen. process() holds the clock and is
    // silent; a take cannot progress while paused, so the UI must not arm.
    bool paused_ = false;

    // Musical time and its change counter.
    float bpm_ = 120.0f;
    int beatsPerBar_ = 4;
    int bars_ = 0;
    ClickMode clickMode_ = ClickMode::CountInRecording;
    std::uint64_t revision_ = 0;

    // Click envelope: which beat last fired, how far into its 3ms burst we are,
    // and whether that burst is the accented downbeat. Keeping this here rather
    // than in a render callback means the click costs the same on every block.
    long long clickBeat_ = -1;
    std::size_t clickAge_ = 0;
    bool clickAccent_ = false;

    std::vector<Layer> layers_;
};