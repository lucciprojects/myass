# MYASS Architecture

## 1. Overview

MYASS is divided into three software components:

```text
                 MYASS
                   │
       ┌───────────┼───────────┐
       │           │           │
       ▼           ▼           ▼
     WEB          API          PI
   Next.js      Node.js       C++
       │           │           │
       │           │           ▼
       │           │        DSP Engine
       │           │           │
       │           │           ▼
       │           │        UMC22
       │           │
       └───────────┴── Network
```

## 2. Audio Path

The audio path is entirely local to the Raspberry Pi.

```text
Guitar
  ↓
UMC22 input
  ↓
USB
  ↓
Raspberry Pi
  ↓
Audio Engine
  ↓
Effects
  ↓
USB
  ↓
UMC22 output
  ↓
Amplifier
```

The internet is never part of the audio path.

## 3. Control Path

Control messages are separate from audio.

```text
Web UI
   ↓
API
   ↓
WebSocket
   ↓
Pi Agent
   ↓
DSP parameters
```

For local development, the Web UI may eventually communicate directly with the Pi.

## 4. Effects

Effects are independent modules.

Initial effect:

```text
Distortion
```

Future effects:

```text
Compressor
EQ
Delay
Reverb
Chorus
Flanger
Tremolo
Pitch
Synth
Cabinet simulation
```

## 5. Effect Interface

Every effect should eventually implement a common interface.

Conceptually:

```text
Effect
├── process()
├── setParameter()
├── getParameter()
├── bypass()
└── reset()
```

This allows effects to be chained together.

## 6. Signal Chain

The long-term signal chain is represented as:

```text
Input
  ↓
Effect 1
  ↓
Effect 2
  ↓
Effect 3
  ↓
Output
```

Eventually the chain should become a configurable graph rather than a fixed sequence.

## 7. Presets

A preset represents an effect chain and its parameters.

Example:

```json
{
  "name": "Yodel Hell",
  "effects": [
    {
      "type": "distortion",
      "enabled": true,
      "parameters": {
        "drive": 0.72,
        "tone": 0.55,
        "level": 0.65
      }
    }
  ]
}
```

## 8. Real-Time Requirements

The DSP engine must prioritize:

* predictable latency
* no audio dropouts
* no memory allocation in the real-time processing loop
* stable sample rate
* stable buffer size

The web application must never block the audio thread.

## 9. Initial Audio Target

Initial target:

```text
Sample rate: 48 kHz
Bit depth: 24-bit
```

Buffer size will be selected experimentally based on the Pi/UMC22 combination.

## 10. v0.1 Success Criteria

MYASS v0.1 is successful when:

1. Guitar audio reaches the Pi.
2. The Pi processes the audio.
3. Distortion can be applied.
4. Processed audio reaches the amplifier.
5. Distortion parameters can be changed without stopping audio.
6. The system remains stable for extended playback.
