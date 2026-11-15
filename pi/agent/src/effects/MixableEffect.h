#pragma once

#include "effects/Effect.h"

#include <atomic>
#include <string>

// Every effect in the toolbox blends against the dry signal, so the mix
// parameter lives here once instead of being repeated in each subclass.
class MixableEffect : public Effect {
public:
    void setEnabled(bool enabled) override;
    bool enabled() const override;

    float process(float input) override;

protected:
    virtual float processWet(float input) = 0;

    // Takes 0-100 to match the units used on the wire and in the UI, and
    // stores it normalised.
    bool setMix(float percent);
    float mix() const;

    static bool clampInto(float value, float min, float max, float& out);

    // Atomic even though the chain is immutable once published: it costs
    // nothing and keeps a future live per-slot toggle off the critical path.
    std::atomic<bool> enabled_{true};
    float mix_ = 1.0f;
};
