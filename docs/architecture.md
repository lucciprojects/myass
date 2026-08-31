# MYASS Architecture

## Core principle

The web application controls the device; it is not part of the audio path.

```text
CONTROL
iPhone -> Web -> API -> Device

AUDIO
Guitar -> UMC22 -> Pi DSP -> UMC22 -> Amp
```

## Runtime boundaries

### Web

Responsible for:

- UI
- navigation
- preset browsing/editing
- device control
- optimistic interaction
- device telemetry display

TanStack Query owns server state. Local React state/Zustand should only be used for UI state that does not belong on the server.

### API

Responsible for:

- domain logic
- authentication later
- persistence
- preset management
- device registry
- WebSocket/device connection management
- protocol validation

### Device

The future Raspberry Pi agent is responsible for:

- audio I/O
- real-time DSP
- effect chain execution
- low-latency parameter updates
- device telemetry

### Simulator

The simulator is a development implementation of the device contract.

It must behave like a device from the API's perspective.

## Domain model

```text
Device
  |
  +-- current preset
  |
  +-- connection
  |
  +-- telemetry

Preset
  |
  +-- ordered EffectInstance[]
          |
          +-- EffectDefinition
          +-- parameters
          +-- enabled
```

## Why the protocol is shared

`packages/protocol` contains Zod schemas and TypeScript types used by:

- API
- simulator
- future Pi agent

The UI does not invent device messages. It calls application-level API/device-client functions.
