#include "Distortion.h"

#include <algorithm>
#include <cmath>

Distortion::Distortion()
: drive(1.0f)
{
}

void Distortion::process(
float* buffer,
int numSamples
)
{
    for (int i = 0; i < numSamples; ++i) {
        buffer[i] = std::tanh(buffer[i] * drive);
    }
}

void Distortion::reset()
{
}

void Distortion::setDrive(float value)
{
    drive = std::clamp(value, 0.0f, 20.0f);
}

float Distortion::getDrive() const
{
    return drive;
}
