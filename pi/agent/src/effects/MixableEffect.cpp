#include "effects/MixableEffect.h"

#include <algorithm>

void MixableEffect::setEnabled(bool enabled) {
    enabled_.store(enabled);
}

bool MixableEffect::enabled() const {
    return enabled_.load();
}

float MixableEffect::process(float input) {
    if (mix_ >= 1.0f) {
        return processWet(input);
    }

    if (mix_ <= 0.0f) {
        return input;
    }

    const float wet = processWet(input);
    return input + (wet - input) * mix_;
}

bool MixableEffect::setMix(float percent) {
    mix_ = std::clamp(percent, 0.0f, 100.0f) / 100.0f;
    return true;
}

float MixableEffect::mix() const {
    return mix_ * 100.0f;
}

bool MixableEffect::clampInto(float value, float min, float max, float& out) {
    out = std::clamp(value, min, max);
    return true;
}
