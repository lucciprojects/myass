import type { EffectDefinition } from "@myass/types";

export const effectDefinitions: EffectDefinition[] = [
  {
    type: "distortion",
    name: "Distortion",
    description: "Nonlinear gain and clipping.",
    parameters: [
      { id: "drive", name: "Drive", min: 0, max: 1, default: 0.5 },
      { id: "tone", name: "Tone", min: 0, max: 1, default: 0.5 },
      { id: "level", name: "Level", min: 0, max: 1, default: 0.8 },
    ],
  },
  {
    type: "delay",
    name: "Delay",
    description: "Time-based echo effect.",
    parameters: [
      { id: "time", name: "Time", min: 1, max: 2000, default: 400, unit: "ms" },
      { id: "feedback", name: "Feedback", min: 0, max: 1, default: 0.3 },
      { id: "mix", name: "Mix", min: 0, max: 1, default: 0.25 },
    ],
  },
  {
    type: "reverb",
    name: "Reverb",
    description: "Spatial ambience.",
    parameters: [
      { id: "size", name: "Size", min: 0, max: 1, default: 0.5 },
      { id: "mix", name: "Mix", min: 0, max: 1, default: 0.2 },
    ],
  },
];
