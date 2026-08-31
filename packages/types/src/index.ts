export type EffectType = "distortion" | "delay" | "reverb";

export interface EffectParameterDefinition {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
}

export interface EffectDefinition {
  type: EffectType;
  name: string;
  description: string;
  parameters: EffectParameterDefinition[];
}

export interface EffectInstance {
  id: string;
  type: EffectType;
  enabled: boolean;
  parameters: Record<string, number>;
}

export interface SignalChain {
  effects: EffectInstance[];
}

export interface Preset {
  id: string;
  name: string;
  description: string | null;
  chain: SignalChain;
}

export interface Device {
  id: string;
  name: string;
  status: "online" | "offline";
  firmwareVersion: string;
}

export interface DeviceTelemetry {
  deviceId: string;
  cpuPercent: number;
  temperatureC: number;
  sampleRate: number;
  bufferSize: number;
}
