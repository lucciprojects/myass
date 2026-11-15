import { z } from "zod";

export const DeviceValuesSchema = z.object({
  input: z.number(),
  output: z.number(),
});

export const EffectKindSchema = z.enum([
  "hardclip",
  "softclip",
  "overdrive",
  "fuzz",
  "asymmetric",
  "wavefold",
  "bitcrush",
  "downsample",
  "rectifyFull",
  "rectifyHalf",
  "gain",
]);

export const EffectSlotSchema = z.object({
  id: z.string(),
  kind: EffectKindSchema,
  enabled: z.boolean(),
  params: z.record(z.string(), z.number()),
});

export const ChainSchema = z.object({
  slots: z.array(EffectSlotSchema),
});

/**
 * One looper layer as the agent reports it. seconds is the loop length and is 0
 * for an empty layer, position is the playhead within it. level is 0-100 to
 * match the rest of the wire protocol; the agent stores it normalised.
 *
 * waiting is true while a countdown is running before a take; countdown is the
 * time left, nonzero only while waiting, so the UI can tick 3..2..1 off the
 * wire. max is the length in seconds this layer was armed with, which after a
 * later take is reported as the cycle length it was forced to match.
 * chainCurrent is whether the layer's saved chain equals the live board, so the
 * UI can show when pasting would actually change anything.
 */
export const LooperLayerSchema = z.object({
  index: z.number().int().nonnegative(),
  playing: z.boolean(),
  recording: z.boolean(),
  waiting: z.boolean(),
  muted: z.boolean(),
  truncated: z.boolean(),
  chainCurrent: z.boolean(),
  // No bounds here even though the range is 0-100: this schema parses what the
  // agent sends, and a float rounding surprise must not turn into a 500. The
  // clamp belongs on the action schema below, where it is user input.
  level: z.number(),
  seconds: z.number().nonnegative(),
  position: z.number().nonnegative(),
  countdown: z.number().nonnegative(),
  max: z.number().nonnegative(),
});

export const LooperStateSchema = z.object({
  maxSeconds: z.number().positive(),
  // The countdown scale the agent arms with, so the UI counts down on the same
  // clock as the audio thread.
  countdownSeconds: z.number().positive(),
  // The cycle length in seconds, 0 when no loop is running.
  transportSeconds: z.number().nonnegative(),
  // True while the master transport is frozen at a sample: the loops are
  // silent and resume exactly where they stopped.
  paused: z.boolean(),
  layers: z.array(LooperLayerSchema),
});

/**
 * Verbs map one to one onto the agent's LOOP command, which takes the layer as a
 * bare positional argument and the value after it. clear with no layer wipes
 * every layer; undo clears the most recent one. record takes an optional max in
 * seconds for the take; chain pastes the current live chain onto the layer.
 */
export const LooperActionSchema = z
  .object({
    action: z.enum([
      "record",
      "stop",
      "play",
      "mute",
      "level",
      "clear",
      "undo",
      "chain",
    ]),
    layer: z.number().int().nonnegative().optional(),
    value: z.number().min(0).max(100).optional(),
    max: z.number().positive().optional(),
  })
  .refine(
    (action) =>
      action.action === "clear" || action.action === "undo" ||
      action.action === "play" || action.layer !== undefined,
    {
      message:
        "record, stop, mute, level and chain all need a layer; play may drive the whole transport",
    },
  )
  .refine((action) => action.action !== "level" || action.value !== undefined, {
    message: "level needs a value",
  });

/**
 * A test signal rendered through a chain. This is a visual approximation of
 * what the effect functions do to a wave, not a measurement of live audio and
 * not a prediction of the C++ output. The UI computes it locally so the
 * panels update while dragging a slider.
 */
export const WaveformSchema = z.object({
  frequency: z.number(),
  frames: z.number().int().positive(),
  input: z.array(z.number()),
  output: z.array(z.number()),
});

/**
 * One place the rig can be heard: a PipeWire Audio/Sink node, discovered from
 * the running graph rather than hardcoded — the amp's USB codec, the
 * computer's own speakers, or whichever Bluetooth headset is connected. node
 * is the stable node.name (survives reboots and reconnection); description is
 * what the UI shows for it.
 */
export const OutputSinkSchema = z.object({
  node: z.string(),
  description: z.string(),
});

/** Body of POST /devices/output: pick the sink to route the rig to. */
export const OutputRouteSchema = z.object({
  node: z.string(),
});

export const OutputStateSchema = z.object({
  // Where the agent's stream is linked right now.
  sink: OutputSinkSchema,
  // Every sink the rig could move to.
  sinks: z.array(OutputSinkSchema),
});

export type ParamCurve = "linear" | "log";
export type ParamUnit = "percent" | "ratio";

export interface EffectParamSpec {
  label: string;
  min: number;
  max: number;
  curve: ParamCurve;
  unit?: ParamUnit;
}

export interface EffectInfo {
  name: string;
  description: string;
  defaults: Record<string, number>;
}

const mixParam: EffectParamSpec = {
  label: "Mix",
  min: 0,
  max: 100,
  curve: "linear",
  unit: "percent",
};

const drive = (max: number): EffectParamSpec => ({
  label: "Drive",
  min: 0.5,
  max,
  curve: "linear",
});

/**
 * Single source of truth for effect parameters. The frontend renders sliders
 * from this, the API validates against it, and the C++ implementations clamp
 * to these same ranges. All three must stay in step.
 */
export const EFFECT_PARAMS: Record<
  EffectKind,
  Record<string, EffectParamSpec>
> = {
  hardclip: {
    threshold: { label: "Threshold", min: 0.01, max: 1, curve: "linear" },
    mix: mixParam,
  },
  softclip: {
    drive: drive(20),
    mix: mixParam,
  },
  overdrive: {
    drive: drive(20),
    mix: mixParam,
  },
  fuzz: {
    drive: { label: "Drive", min: 1, max: 50, curve: "linear" },
    mix: mixParam,
  },
  asymmetric: {
    ceiling: { label: "Ceiling", min: 0.01, max: 1, curve: "linear" },
    floor: { label: "Floor", min: 0.01, max: 1, curve: "linear" },
    mix: mixParam,
  },
  wavefold: {
    fold: { label: "Fold", min: 1, max: 20, curve: "linear" },
    mix: mixParam,
  },
  bitcrush: {
    // Logarithmic: a linear 2-256 slider is unusable.
    levels: { label: "Levels", min: 2, max: 256, curve: "log", unit: "ratio" },
    mix: mixParam,
  },
  downsample: {
    divisor: { label: "Divisor", min: 1, max: 48, curve: "log", unit: "ratio" },
    mix: mixParam,
  },
  rectifyFull: {
    mix: mixParam,
  },
  rectifyHalf: {
    mix: mixParam,
  },
  gain: {
    gain: { label: "Gain", min: 0, max: 4, curve: "linear" },
    mix: mixParam,
  },
};

export const EFFECT_INFO: Record<EffectKind, EffectInfo> = {
  hardclip: {
    name: "Hard Clip",
    description: "Chops peaks at a fixed ceiling. Aggressive and buzzy.",
    defaults: { threshold: 0.3, mix: 100 },
  },
  softclip: {
    name: "Soft Clip",
    description: "Gradual saturation via tanh. Smoother and warmer.",
    defaults: { drive: 3, mix: 100 },
  },
  overdrive: {
    name: "Overdrive",
    description: "Mild tanh saturation. The classic blues-grit starting point.",
    defaults: { drive: 3, mix: 100 },
  },
  fuzz: {
    name: "Fuzz",
    description: "Extreme clipping toward a square wave. Very buzzy.",
    defaults: { drive: 12, mix: 100 },
  },
  asymmetric: {
    name: "Asymmetric",
    description: "Clips the two halves differently, adding even harmonics.",
    defaults: { ceiling: 0.2, floor: 0.5, mix: 100 },
  },
  wavefold: {
    name: "Wavefold",
    description: "Reflects the signal back into range. Experimental.",
    defaults: { fold: 4, mix: 80 },
  },
  bitcrush: {
    name: "Bitcrush",
    description: "Reduces numerical resolution. Crunchy and digital.",
    defaults: { levels: 12, mix: 100 },
  },
  downsample: {
    name: "Downsample",
    description: "Holds samples for several frames. Degraded digital sound.",
    defaults: { divisor: 4, mix: 100 },
  },
  rectifyFull: {
    name: "Full Rectify",
    description: "Flips negatives up. Adds octave-up-like harmonics.",
    defaults: { mix: 100 },
  },
  rectifyHalf: {
    name: "Half Rectify",
    description: "Keeps only the positive half of the waveform.",
    defaults: { mix: 100 },
  },
  gain: {
    name: "Gain",
    description: "Plain level stage. Useful for driving what follows.",
    defaults: { gain: 1.5, mix: 100 },
  },
};

export type IssueReason = "unknown_param" | "missing_param" | "out_of_range";

export interface ChainIssue {
  slotId: string;
  slotIndex: number;
  kind: EffectKind;
  param: string;
  reason: IssueReason;
}

/**
 * A chain is only worth sending to the agent if every slot's params match its
 * kind exactly, so reject the whole document rather than let the agent
 * half-apply it.
 */
export function validateChain(chain: Chain): ChainIssue[] {
  const issues: ChainIssue[] = [];

  chain.slots.forEach((slot, slotIndex) => {
    const specs = EFFECT_PARAMS[slot.kind];

    for (const param of Object.keys(slot.params)) {
      if (!(param in specs)) {
        issues.push({
          slotId: slot.id,
          slotIndex,
          kind: slot.kind,
          param,
          reason: "unknown_param",
        });
      }
    }

    for (const [param, spec] of Object.entries(specs)) {
      const value = slot.params[param];

      if (value === undefined) {
        issues.push({
          slotId: slot.id,
          slotIndex,
          kind: slot.kind,
          param,
          reason: "missing_param",
        });
        continue;
      }

      if (value < spec.min || value > spec.max) {
        issues.push({
          slotId: slot.id,
          slotIndex,
          kind: slot.kind,
          param,
          reason: "out_of_range",
        });
      }
    }
  });

  return issues;
}

export type DeviceValues = z.infer<typeof DeviceValuesSchema>;
export type EffectKind = z.infer<typeof EffectKindSchema>;
export type EffectSlot = z.infer<typeof EffectSlotSchema>;
export type Chain = z.infer<typeof ChainSchema>;
export type Waveform = z.infer<typeof WaveformSchema>;
export type LooperLayer = z.infer<typeof LooperLayerSchema>;
export type LooperState = z.infer<typeof LooperStateSchema>;
export type LooperAction = z.infer<typeof LooperActionSchema>;
export type OutputSink = z.infer<typeof OutputSinkSchema>;
export type OutputState = z.infer<typeof OutputStateSchema>;

export const EFFECT_KINDS = EffectKindSchema.options;
