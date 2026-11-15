#pragma once

#include "effects/MixableEffect.h"

#include <cstddef>
#include <memory>
#include <string>
#include <vector>

// The toolbox. Each class is small; the kind name is supplied by the factory
// so TanhEffect can back both "softclip" and "overdrive".
class HardClipEffect final : public MixableEffect {
public:
    explicit HardClipEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float threshold_ = 0.3f;
};

class TanhEffect final : public MixableEffect {
public:
    explicit TanhEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float drive_ = 3.0f;
};

class FuzzEffect final : public MixableEffect {
public:
    explicit FuzzEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float drive_ = 12.0f;
};

class AsymmetricEffect final : public MixableEffect {
public:
    explicit AsymmetricEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float ceiling_ = 0.2f;
    float floor_ = 0.5f;
};

class WavefoldEffect final : public MixableEffect {
public:
    explicit WavefoldEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float fold_ = 4.0f;
};

class BitcrushEffect final : public MixableEffect {
public:
    explicit BitcrushEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float levels_ = 12.0f;
};

class DownsampleEffect final : public MixableEffect {
public:
    explicit DownsampleEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float divisor_ = 4.0f;
    std::size_t counter_ = 0;
    float held_ = 0.0f;
};

class RectifyFullEffect final : public MixableEffect {
public:
    explicit RectifyFullEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
};

class RectifyHalfEffect final : public MixableEffect {
public:
    explicit RectifyHalfEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
};

class GainEffect final : public MixableEffect {
public:
    explicit GainEffect(const char* name) : name_(name) {}

    const char* name() const override { return name_; }
    std::vector<std::string> paramKeys() const override;
    bool setParam(const std::string& key, float value) override;
    float param(const std::string& key) const override;

protected:
    float processWet(float input) override;

private:
    const char* name_;
    float gain_ = 1.0f;
};

// Returns nullptr for an unknown kind.
std::unique_ptr<Effect> createEffect(const std::string& kind);

// Chains turn into snapshots and back as a way of deep copying: each effect
// falls back to its parameter list, so cloning needs no per-effect code. The
// copy is fresh, which means state held between samples (bits, held values)
// restarts at a record rather than carrying over from the live board.
EffectSnapshot snapshotOf(const Effect& effect);
std::unique_ptr<Effect> cloneEffect(const Effect& effect);
EffectChain cloneChain(const EffectChain& chain);

// Whether two chains are the same board. Used to tell the UI when a layer's
// saved chain differs from what is live, so the paste button is visible only
// when it does anything.
bool chainsEqual(const EffectChain& a, const EffectChain& b);
