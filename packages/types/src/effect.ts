export type EffectType =
  | "distortion"
  | "delay"
  | "reverb";

export interface Effect {
  id: string;
  type: EffectType;
  enabled: boolean;
  parameters: Record<string, number>;
}