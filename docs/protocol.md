# MYASS Device Protocol

Messages are JSON over WebSocket.

## Command

```json
{
  "type": "effect.set_parameter",
  "requestId": "uuid",
  "effectId": "distortion-1",
  "parameter": "drive",
  "value": 0.72
}
```

## Acknowledgement

```json
{
  "type": "effect.parameter_changed",
  "requestId": "uuid",
  "effectId": "distortion-1",
  "parameter": "drive",
  "value": 0.72
}
```

## Telemetry

```json
{
  "type": "device.telemetry",
  "deviceId": "sim-001",
  "cpuPercent": 12.5,
  "temperatureC": 43.2,
  "sampleRate": 48000,
  "bufferSize": 128
}
```

The protocol is intentionally small in v0.1. New messages should be added with explicit Zod schemas and tests.
