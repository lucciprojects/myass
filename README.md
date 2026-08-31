# MYASS

## Mike's Yodelling Audial String Synthesizer

MYASS is a Raspberry Pi-based programmable guitar effects platform controlled through a web interface.

The long-term goal is to create a digital guitar pedal that can be configured from a browser or iPhone, with real-time audio processing performed locally on the Raspberry Pi.

## v0.1 Goal

The first version has one job:

```text
Guitar
   ↓
Behringer UMC22
   ↓
Raspberry Pi
   ↓
MYASS DSP
   ↓
Behringer UMC22
   ↓
Guitar Amp
```

The first effect will be distortion.

The web interface will eventually allow the user to change distortion parameters in real time.

## Architecture

MYASS consists of three major components:

### Web

The browser/iPhone interface.

Technology:

* Next.js
* React
* TypeScript
* Tailwind CSS

### API

The application backend.

Technology:

* Node.js
* TypeScript
* Fastify

The API will eventually handle:

* presets
* devices
* authentication
* cloud synchronization
* firmware updates

### Pi Agent

The software running directly on the Raspberry Pi.

Responsibilities:

* audio input
* real-time DSP
* audio output
* receiving control commands
* reporting device status

The audio signal must never travel through the cloud API.

## Audio Architecture

```text
Guitar
   │
   ▼
UMC22 ADC
   │
   ▼
Raspberry Pi
   │
   ▼
MYASS Audio Engine
   │
   ▼
Effect Chain
   │
   ▼
UMC22 DAC
   │
   ▼
Amplifier
```

## Development Philosophy

Build the smallest working system first.

1. Verify USB audio.
2. Pass guitar audio through the Pi.
3. Add distortion.
4. Control distortion from the Pi.
5. Control distortion over the network.
6. Build the web interface.
7. Add presets.
8. Add additional effects.
9. Build the pedalboard interface.

## Hardware

Initial hardware:

* Raspberry Pi 4
* Behringer UMC22
* Guitar
* Guitar amplifier
* Standard 1/4" guitar cables

## Status

MYASS v0.1 is under active development.
