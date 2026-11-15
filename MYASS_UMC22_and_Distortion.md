# UMC22 Guitar Input & DSP Distortion Ideas

## 1. What actually goes into the UMC22?

For the MYASS setup, the signal chain is:

```text
Guitar
  ↓
¼″ instrument cable
  ↓
Behringer UMC22
  ↓
USB
  ↓
Computer / Raspberry Pi
  ↓
C++ DSP
  ↓
Audio output
  ↓
Amp
```

The UMC22 receives the guitar's **analog electrical signal**. It is not receiving notes, MIDI, or a higher-level representation of the guitar.

A guitar pickup produces a changing analog voltage waveform. For example, a guitar string can produce a waveform that looks roughly like:

```text
Voltage
  ^
  |       /‾‾\       /‾‾  |      /    \     /    \
  |_____/      \___/      \____
  |
  +------------------------------> time
```

The UMC22's job is to:

1. Receive the analog guitar signal.
2. Amplify/condition it to an appropriate level.
3. Convert the analog signal into digital samples with its ADC.
4. Send those samples to the computer over USB.

---

## 2. What does the C++ program actually get?

Once the UMC22 converts the signal to digital audio, the C++ program sees a stream of numerical samples.

Conceptually, it might look like:

```cpp
-0.12
 0.04
 0.31
 0.57
 0.42
-0.03
-0.38
-0.61
...
```

If the interface is running at **48,000 samples/second**, there are potentially 48,000 samples per second per audio channel.

A simplified signal path is:

```text
Guitar
  ↓
analog voltage
  ↓
UMC22 ADC
  ↓
digital audio samples
  ↓
C++ program
```

The important thing for MYASS is that the DSP operates on these samples.

A distortion function can therefore be as simple as:

```cpp
float distort(float x)
{
    return ...;
}
```

where `x` is an individual audio sample.

---

# 3. Hard Clipping

Hard clipping is one of the simplest forms of distortion.

```cpp
float distort(float x)
{
    return std::clamp(x, -0.3f, 0.3f);
}
```

Instead of allowing the waveform to continue increasing, values above the threshold are chopped off.

Conceptually:

```text
Clean:

       /      /  _____/    \_____

Hard clipped:

     ______
    /      ___/        \___
```

### Sound

Hard clipping tends to produce an aggressive, buzzy, harsh character.

The sharp corners introduced into the waveform add harmonic content.

---

# 4. Soft Clipping

Instead of suddenly chopping the waveform, soft clipping gradually flattens it.

A simple example is:

```cpp
float distort(float x)
{
    return std::tanh(3.0f * x);
}
```

Small signals remain relatively close to their original values, while larger signals gradually approach a limit.

Conceptually:

```text
Soft clipping:

              ______
            /
          /
_________/
```

rather than a sudden hard cutoff.

### Sound

Soft clipping generally produces a smoother, warmer saturation character than hard clipping.

---

# 5. Overdrive

Overdrive can be thought of as a relatively mild form of nonlinear saturation.

For example:

```cpp
float distort(float x)
{
    return std::tanh(1.5f * x);
}
```

Increasing the drive:

```cpp
float distort(float x)
{
    return std::tanh(8.0f * x);
}
```

pushes the signal much harder into saturation.

A MYASS control could therefore expose something like:

```text
Drive = 0%
Drive = 25%
Drive = 50%
Drive = 75%
Drive = 100%
```

---

# 6. Fuzz

Fuzz pushes the signal toward extreme clipping.

A deliberately extreme example:

```cpp
float distort(float x)
{
    return std::copysign(1.0f, x);
}
```

This essentially turns the waveform into a square wave:

```text
     ┌───────┐
     │       │
─────┘       └─────
```

Real fuzz pedals use more complicated circuits and nonlinearities, but this is a useful DSP experiment.

### Sound

Very aggressive, buzzy, compressed, and heavily distorted.

---

# 7. Asymmetric Distortion

Normal clipping can treat positive and negative portions of the waveform identically.

You can deliberately make them different:

```cpp
float distort(float x)
{
    if (x > 0.2f)
        x = 0.2f;

    if (x < -0.5f)
        x = -0.5f;

    return x;
}
```

Now the positive side clips at `0.2`, while the negative side clips at `-0.5`.

Conceptually:

```text
Positive side:
  clips early

Negative side:
  clips later
```

This is **asymmetric clipping**.

Asymmetry changes the harmonic content of the signal and can introduce even-harmonic content.

This could be a particularly interesting MYASS control:

```text
Symmetry
<────────●──────>
```

---

# 8. Wavefolding

Instead of simply clipping large values, wavefolding can reflect the waveform back into the allowed range.

Conceptually:

```text
Normal:

       /      /  _____/    \_____

Folded:

       /\  /      /  \/  _____/        \____
```

A simple experimental nonlinear function might be:

```cpp
float distort(float x)
{
    return std::sin(x * 5.0f);
}
```

An actual wavefolder can use a more deliberate folding algorithm.

### Sound

Wavefolding can create complex harmonic content and can move beyond traditional guitar-pedal distortion into more experimental/synth-like territory.

---

# 9. Bitcrushing

Bitcrushing deliberately reduces the numerical resolution of the audio.

For example:

```cpp
float bitcrush(float x)
{
    const float levels = 16.0f;

    return std::round(x * levels) / levels;
}
```

Instead of many possible values:

```text
0.213481
0.213492
0.213503
0.213517
...
```

you get a smaller set of discrete values:

```text
0.25
0.25
0.25
0.25
0.1875
0.1875
...
```

### Sound

Bitcrushing tends to sound digital, crunchy, glitchy, or like a deliberately low-resolution audio system.

---

# 10. Sample-Rate Reduction

Another digital effect is deliberately reducing the effective sample rate.

Instead of processing every sample independently:

```text
sample sample sample sample sample sample sample
```

you can hold samples for several frames:

```text
sample       sample       sample
████         ████         ████
```

This produces a deliberately degraded digital sound.

Combining sample-rate reduction with bitcrushing can create especially extreme digital effects.

---

# 11. Rectification

Rectification changes the waveform by flipping negative values upward.

A very simple full-wave rectifier is:

```cpp
float distort(float x)
{
    return std::abs(x);
}
```

Original:

```text
     /    /  ___/    \___
          \  /
           \/
```

After full-wave rectification:

```text
     /\    /    /  \  /  ___/    \/    \___
```

This substantially changes the harmonic content and can create an octave-up-like character.

---

# 12. Chaining Effects

The really interesting part of MYASS is that these effects do not have to exist in isolation.

You can chain multiple DSP stages:

```text
Guitar
  ↓
Input Gain
  ↓
Pre-EQ
  ↓
Overdrive
  ↓
Hard Clip
  ↓
Wavefolder
  ↓
Post-EQ
  ↓
Output Gain
  ↓
Amp
```

For example:

```cpp
float process(float x)
{
    x *= drive;

    x = std::tanh(x);

    x = std::clamp(x, -clip, clip);

    x = std::sin(x * foldAmount);

    return x * outputGain;
}
```

Now the website can eventually expose controls such as:

```text
┌─────────────────────────────┐
│       MYASS DISTORTION      │
│                             │
│ Drive       ███████░░  70%  │
│ Clip        █████░░░░  50%  │
│ Softness    ███░░░░░░  30%  │
│ Symmetry    ███████░░  70%  │
│ Fold        ██░░░░░░░  20%  │
│ Bit Crush   █░░░░░░░░  10%  │
│                             │
│        [ DISTORT ON ]       │
└─────────────────────────────┘
```

---

# 13. How This Fits Into MYASS

The UMC22 itself does **not** determine what distortion effects are possible.

Its main role is to get the physical guitar signal into the digital domain.

Once the guitar has become digital samples, the C++ DSP code can mathematically transform those samples.

The basic concept is:

```text
Guitar
  ↓
UMC22
  ↓
Digital samples
  ↓
C++ DSP
  ↓
Modified digital samples
  ↓
Audio output
  ↓
Amp
```

For the MYASS MVP, a very simple first experiment is:

```text
Distortion OFF:
input sample → output sample unchanged

Distortion ON:
input sample → distortion function → output sample changed
```

For example:

```cpp
float process(float x)
{
    if (!distortionEnabled)
        return x;

    return std::tanh(3.0f * x);
}
```

That gives a clean, easy-to-test foundation before adding more complicated effects.

---

# 14. Potential MYASS Distortion Toolbox

Once the basic path is working, possible effects include:

- Hard clipping
- Soft clipping
- Overdrive
- Fuzz
- Asymmetric clipping
- Wavefolding
- Bitcrushing
- Sample-rate reduction
- Half-wave rectification
- Full-wave rectification
- Gain/saturation stages
- EQ before/after distortion
- Combinations of multiple nonlinear stages

The important DSP concept is that most of these can ultimately be expressed as transformations of the incoming audio samples.

That makes them a natural fit for the C++ DSP engine in MYASS.
