#pragma once

#include <atomic>
#include <memory>
#include <string>
#include <utility>
#include <vector>

// One effect in a chain, in the form the wire protocol speaks: the kind plus
// the addressable parameters. Chains serialize to these and back, which is also
// how a chain is copied into a looper layer without each effect needing its own
// clone method.
struct EffectSnapshot {
    std::string kind;
    bool enabled = false;
    std::vector<std::pair<std::string, float>> params;
};

using EffectChain = std::vector<std::unique_ptr<class Effect>>;

class Effect {
public:
    virtual ~Effect() = default;

    virtual const char* name() const = 0;

    virtual void setEnabled(bool enabled) = 0;
    virtual bool enabled() const = 0;

    // Every key this effect accepts. Used to validate a chain before it
    // reaches the audio thread.
    virtual std::vector<std::string> paramKeys() const = 0;

    // Returns false when the key is unknown, so a bad chain can be rejected
    // instead of silently ignored.
    virtual bool setParam(const std::string& key, float value) = 0;
    virtual float param(const std::string& key) const = 0;

    // Not const: downsample holds a sample counter between calls.
    virtual float process(float input) = 0;
};
