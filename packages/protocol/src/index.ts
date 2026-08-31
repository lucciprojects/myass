import { z } from "zod";

export const SetParameterCommand = z.object({
  type: z.literal("effect.set_parameter"),
  requestId: z.string(),
  effectId: z.string(),
  parameter: z.string(),
  value: z.number(),
});

export const BypassEffectCommand = z.object({
  type: z.literal("effect.set_bypass"),
  requestId: z.string(),
  effectId: z.string(),
  bypassed: z.boolean(),
});

export const LoadPresetCommand = z.object({
  type: z.literal("preset.load"),
  requestId: z.string(),
  presetId: z.string(),
});

export const DeviceTelemetryEvent = z.object({
  type: z.literal("device.telemetry"),
  deviceId: z.string(),
  cpuPercent: z.number(),
  temperatureC: z.number(),
  sampleRate: z.number(),
  bufferSize: z.number(),
});

export const ParameterChangedEvent = z.object({
  type: z.literal("effect.parameter_changed"),
  requestId: z.string(),
  effectId: z.string(),
  parameter: z.string(),
  value: z.number(),
});

export const EffectBypassChangedEvent = z.object({
  type: z.literal("effect.bypass_changed"),
  requestId: z.string(),
  effectId: z.string(),
  bypassed: z.boolean(),
});

export const PresetLoadedEvent = z.object({
  type: z.literal("preset.loaded"),
  requestId: z.string(),
  presetId: z.string(),
});

export const DeviceMessage = z.discriminatedUnion("type", [
  ParameterChangedEvent,
  EffectBypassChangedEvent,
  PresetLoadedEvent,
  DeviceTelemetryEvent,
]);

export const DeviceCommand = z.discriminatedUnion("type", [
  SetParameterCommand,
  BypassEffectCommand,
  LoadPresetCommand,
]);

export type DeviceCommand = z.infer<typeof DeviceCommand>;
export type DeviceMessage = z.infer<typeof DeviceMessage>;
