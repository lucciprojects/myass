#include "effects/StandardEffects.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <utility>

namespace {
const std::vector<std::string> MIX_ONLY{"mix"};

bool matches(const std::string& key, const char* name) {
    return key == name;
}
} // namespace

// ---------- HardClip ----------

std::vector<std::string> HardClipEffect::paramKeys() const {
    return {"threshold", "mix"};
}

bool HardClipEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "threshold")) {
        return clampInto(value, 0.01f, 1.0f, threshold_);
    }

    return false;
}

float HardClipEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return threshold_;
}

float HardClipEffect::processWet(float input) {
    return std::clamp(input, -threshold_, threshold_);
}

// ---------- Tanh (softclip / overdrive) ----------

std::vector<std::string> TanhEffect::paramKeys() const {
    return {"drive", "mix"};
}

bool TanhEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "drive")) {
        return clampInto(value, 0.5f, 20.0f, drive_);
    }

    return false;
}

float TanhEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return drive_;
}

float TanhEffect::processWet(float input) {
    return std::tanh(input * drive_);
}

// ---------- Fuzz ----------

std::vector<std::string> FuzzEffect::paramKeys() const {
    return {"drive", "mix"};
}

bool FuzzEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "drive")) {
        return clampInto(value, 1.0f, 50.0f, drive_);
    }

    return false;
}

float FuzzEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return drive_;
}

float FuzzEffect::processWet(float input) {
    // Approaches a square wave as drive rises, without the hard edge of
    // copysign at every setting.
    return std::copysign(std::tanh(std::fabs(input) * drive_), input);
}

// ---------- Asymmetric ----------

std::vector<std::string> AsymmetricEffect::paramKeys() const {
    return {"ceiling", "floor", "mix"};
}

bool AsymmetricEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "ceiling")) {
        return clampInto(value, 0.01f, 1.0f, ceiling_);
    }

    if (matches(key, "floor")) {
        return clampInto(value, 0.01f, 1.0f, floor_);
    }

    return false;
}

float AsymmetricEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    if (matches(key, "ceiling")) {
        return ceiling_;
    }

    return floor_;
}

float AsymmetricEffect::processWet(float input) {
    return std::clamp(input, -floor_, ceiling_);
}

// ---------- Wavefold ----------

std::vector<std::string> WavefoldEffect::paramKeys() const {
    return {"fold", "mix"};
}

bool WavefoldEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "fold")) {
        return clampInto(value, 1.0f, 20.0f, fold_);
    }

    return false;
}

float WavefoldEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return fold_;
}

float WavefoldEffect::processWet(float input) {
    return std::sin(input * fold_);
}

// ---------- Bitcrush ----------

std::vector<std::string> BitcrushEffect::paramKeys() const {
    return {"levels", "mix"};
}

bool BitcrushEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "levels")) {
        return clampInto(value, 2.0f, 256.0f, levels_);
    }

    return false;
}

float BitcrushEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return levels_;
}

float BitcrushEffect::processWet(float input) {
    const float levels = std::max(2.0f, levels_);
    const float clamped = std::clamp(input, -1.0f, 1.0f);

    return std::round(clamped * levels) / levels;
}

// ---------- Downsample ----------

std::vector<std::string> DownsampleEffect::paramKeys() const {
    return {"divisor", "mix"};
}

bool DownsampleEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "divisor")) {
        return clampInto(value, 1.0f, 48.0f, divisor_);
    }

    return false;
}

float DownsampleEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return divisor_;
}

float DownsampleEffect::processWet(float input) {
    const auto period = static_cast<std::size_t>(std::max(1.0f, divisor_));

    if (counter_ + 1 >= period) {
        counter_ = 0;
        held_ = input;
    } else {
        counter_ += 1;
    }

    return held_;
}

// ---------- Rectify ----------

std::vector<std::string> RectifyFullEffect::paramKeys() const {
    return MIX_ONLY;
}

bool RectifyFullEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    return false;
}

float RectifyFullEffect::param(const std::string& key) const {
    return mix();
}

float RectifyFullEffect::processWet(float input) {
    return std::fabs(input);
}

std::vector<std::string> RectifyHalfEffect::paramKeys() const {
    return MIX_ONLY;
}

bool RectifyHalfEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    return false;
}

float RectifyHalfEffect::param(const std::string& key) const {
    return mix();
}

float RectifyHalfEffect::processWet(float input) {
    return std::max(input, 0.0f);
}

// ---------- Gain ----------

std::vector<std::string> GainEffect::paramKeys() const {
    return {"gain", "mix"};
}

bool GainEffect::setParam(const std::string& key, float value) {
    if (matches(key, "mix")) {
        return setMix(value);
    }

    if (matches(key, "gain")) {
        return clampInto(value, 0.0f, 4.0f, gain_);
    }

    return false;
}

float GainEffect::param(const std::string& key) const {
    if (matches(key, "mix")) {
        return mix();
    }

    return gain_;
}

float GainEffect::processWet(float input) {
    return input * gain_;
}

// ---------- factory ----------

std::unique_ptr<Effect> createEffect(const std::string& kind) {
    if (kind == "hardclip") {
        return std::make_unique<HardClipEffect>("hardclip");
    }

    if (kind == "softclip") {
        return std::make_unique<TanhEffect>("softclip");
    }

    if (kind == "overdrive") {
        return std::make_unique<TanhEffect>("overdrive");
    }

    if (kind == "fuzz") {
        return std::make_unique<FuzzEffect>("fuzz");
    }

    if (kind == "asymmetric") {
        return std::make_unique<AsymmetricEffect>("asymmetric");
    }

    if (kind == "wavefold") {
        return std::make_unique<WavefoldEffect>("wavefold");
    }

    if (kind == "bitcrush") {
        return std::make_unique<BitcrushEffect>("bitcrush");
    }

    if (kind == "downsample") {
        return std::make_unique<DownsampleEffect>("downsample");
    }

    if (kind == "rectifyFull") {
        return std::make_unique<RectifyFullEffect>("rectifyFull");
    }

    if (kind == "rectifyHalf") {
        return std::make_unique<RectifyHalfEffect>("rectifyHalf");
    }

    if (kind == "gain") {
        return std::make_unique<GainEffect>("gain");
    }

    return nullptr;
}

// ---------- chain copy and compare ----------

EffectSnapshot snapshotOf(const Effect& effect) {
    EffectSnapshot snap;
    snap.kind = effect.name();
    snap.enabled = effect.enabled();

    for (const auto& key : effect.paramKeys()) {
        snap.params.emplace_back(key, effect.param(key));
    }

    return snap;
}

std::unique_ptr<Effect> cloneEffect(const Effect& effect) {
    const std::string kind = effect.name();
    auto copy = createEffect(kind);

    if (copy == nullptr) {
        return nullptr;
    }

    copy->setEnabled(effect.enabled());

    for (const auto& key : effect.paramKeys()) {
        copy->setParam(key, effect.param(key));
    }

    return copy;
}

EffectChain cloneChain(const EffectChain& chain) {
    EffectChain copy;
    copy.reserve(chain.size());

    for (const auto& effect : chain) {
        auto cloned = cloneEffect(*effect);

        if (cloned) {
            copy.push_back(std::move(cloned));
        }
    }

    return copy;
}

bool chainsEqual(const EffectChain& a, const EffectChain& b) {
    if (a.size() != b.size()) {
        return false;
    }

    for (std::size_t index = 0; index < a.size(); ++index) {
        if (std::string(a[index]->name()) != b[index]->name()) {
            return false;
        }

        if (a[index]->enabled() != b[index]->enabled()) {
            return false;
        }

        if (a[index]->paramKeys() != b[index]->paramKeys()) {
            return false;
        }

        for (const auto& key : a[index]->paramKeys()) {
            if (a[index]->param(key) != b[index]->param(key)) {
                return false;
            }
        }
    }

    return true;
}
