import type { EffectKind } from "@myass/protocol";

export interface PresetSlot {
  kind: EffectKind;
  enabled: boolean;
  params: Record<string, number>;
}

export interface ChainPreset {
  name: string;
  slots: PresetSlot[];
}

export const CHAIN_PRESETS: ChainPreset[] = [
  {
    name: "Clean Boost",
    slots: [{ kind: "gain", enabled: true, params: { gain: 1.5, mix: 100 } }],
  },
  {
    name: "Crunch",
    slots: [
      { kind: "overdrive", enabled: true, params: { drive: 3, mix: 100 } },
      { kind: "hardclip", enabled: true, params: { threshold: 0.4, mix: 60 } },
    ],
  },
  {
    name: "Blues Breakup",
    slots: [
      { kind: "softclip", enabled: true, params: { drive: 2, mix: 100 } },
      { kind: "asymmetric", enabled: true, params: { ceiling: 0.5, floor: 0.7, mix: 50 } },
    ],
  },
  {
    name: "Fuzz",
    slots: [
      { kind: "gain", enabled: true, params: { gain: 2.5, mix: 100 } },
      { kind: "fuzz", enabled: true, params: { drive: 12, mix: 100 } },
    ],
  },
  {
    name: "Digital Ruin",
    slots: [
      { kind: "bitcrush", enabled: true, params: { levels: 8, mix: 100 } },
      { kind: "downsample", enabled: true, params: { divisor: 6, mix: 100 } },
    ],
  },
  {
    name: "Experimental",
    slots: [
      { kind: "wavefold", enabled: true, params: { fold: 5, mix: 70 } },
      { kind: "rectifyFull", enabled: true, params: { mix: 40 } },
      { kind: "hardclip", enabled: true, params: { threshold: 0.2, mix: 50 } },
    ],
  },
];
