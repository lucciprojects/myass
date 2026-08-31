#pragma once

#include "Effect.h"

class Distortion : public Effect {
public:
Distortion();

void process(
    float* buffer,
    int numSamples
);

void reset() override;

void setDrive(float drive);
float getDrive() const;

private:
float drive;
};
