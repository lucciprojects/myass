"use client";

import { useEffect, useMemo, useRef } from "react";
import { EFFECT_INFO, EFFECT_PARAMS } from "@myass/protocol";
import type { EffectKind, EffectSlot } from "@myass/protocol";
import styles from "./waveform.module.css";

/**
 * These panels are a visual aid, not an instrument. They approximate what the
 * effect functions do to a wave, computed in the browser, and they are not a
 * measurement of live audio nor a guarantee of the C++ output. Keeping them
 * off the agent is deliberate: a picture does not justify putting anything on
 * the control thread that the audio loop also touches.
 *
 * The consequence is that the transfer math below is a second, simplified
 * copy of the DSP. If the C++ changes, this can drift. That is an acceptable
 * trade for a decorative readout, and it would not be for anything load
 * bearing.
 */

// A low fundamental, where the harmonics the chain adds read most clearly.
const FREQUENCY = 220;
const FRAMES = 512;
const SAMPLE_RATE = 48000;
const AMPLITUDE = 1;

// The transfer view folds the same input level down to one output, so buckets
// rather than a literal polyline is what makes the curve readable.
const BUCKETS = 240;
const PANEL_HEIGHT = 200;

const INK = {
  grid: "#5e3012",
  axis: "#b69a72",
  input: "#9c6c3f",
  output: "#ffd93d",
  label: "#82582f",
};

/** Clamped read of a slot param, falling back to the effect's default. */
function readParam(slot: EffectSlot, key: string): number {
  const value = slot.params[key];
  const spec = EFFECT_PARAMS[slot.kind]?.[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return EFFECT_INFO[slot.kind]?.defaults[key] ?? 0;
  }

  if (!spec) {
    return value;
  }

  return Math.min(spec.max, Math.max(spec.min, value));
}

/**
 * The wet signal for one effect at one input level. Every kind mixes against
 * the dry signal, so blend once here rather than in each branch.
 */
function wetSample(kind: EffectKind, slot: EffectSlot, x: number): number {
  switch (kind) {
    case "hardclip": {
      const threshold = readParam(slot, "threshold");
      return Math.max(-threshold, Math.min(threshold, x));
    }

    case "softclip":
    case "overdrive":
      return Math.tanh(x * readParam(slot, "drive"));

    case "fuzz": {
      // Square-ish, softening as drive drops.
      const drive = readParam(slot, "drive");
      return Math.sign(x) * Math.tanh(Math.abs(x) * drive);
    }

    case "asymmetric": {
      // Different ceiling above and below zero, which is what adds the even
      // harmonics.
      const ceiling = readParam(slot, "ceiling");
      const floor = readParam(slot, "floor");
      return Math.max(-floor, Math.min(ceiling, x));
    }

    case "wavefold":
      return Math.sin(x * readParam(slot, "fold"));

    case "bitcrush": {
      const levels = Math.max(2, readParam(slot, "levels"));
      const clamped = Math.max(-1, Math.min(1, x));
      return Math.round(clamped * levels) / levels;
    }

    case "rectifyFull":
      return Math.abs(x);

    case "rectifyHalf":
      return Math.max(x, 0);

    case "gain":
      return x * readParam(slot, "gain");

    // downsample has memory, so it is not a function of a single sample and
    // cannot be drawn as a transfer curve. The waveform view below handles it.
    case "downsample":
      return x;

    default:
      return x;
  }
}

/** One effect applied to a whole signal, including its dry/wet blend. */
function applySlot(signal: number[], slot: EffectSlot): number[] {
  if (!slot.enabled) {
    return signal;
  }

  const mix = Math.max(0, Math.min(1, readParam(slot, "mix") / 100));

  // downsample holds a sample for several frames, so it needs the index and
  // cannot go through the per sample path.
  if (slot.kind === "downsample") {
    const period = Math.max(1, Math.round(readParam(slot, "divisor")));
    const out: number[] = [];

    for (let i = 0; i < signal.length; i += 1) {
      const dry = signal[i];
      // A fresh hold on every period boundary, otherwise the held value.
      const wet = i % period === 0 ? dry : out[i - 1] ?? dry;
      out.push(dry + (wet - dry) * mix);
    }

    return out;
  }

  return signal.map((sample) => {
    const dry = sample;
    const wet = wetSample(slot.kind, slot, dry);
    return dry + (wet - dry) * mix;
  });
}

/** The test signal, and the chain applied to it in slot order. */
function render(slots: EffectSlot[]): { input: number[]; output: number[] } {
  const input = Array.from({ length: FRAMES }, (_, i) =>
    Math.sin((2 * Math.PI * FREQUENCY * i) / SAMPLE_RATE) * AMPLITUDE,
  );

  return { input, output: slots.reduce(applySlot, input) };
}

/** Canvas backing store scaled for the display, in CSS pixels. */
function prepare(canvas: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;

  if (width === 0) {
    return null;
  }

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(PANEL_HEIGHT * ratio);

  const ctx = canvas.getContext("2d");

  if (!ctx) {
    return null;
  }

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, PANEL_HEIGHT);

  return { ctx, width, height: PANEL_HEIGHT };
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  ctx.strokeStyle = INK.grid;
  ctx.lineWidth = 1;

  for (let i = 1; i < 4; i += 1) {
    const y = Math.round((height / 4) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = INK.axis;
  const mid = Math.round(height / 2) + 0.5;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
) {
  ctx.fillStyle = INK.label;
  ctx.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText(text, x, y);
}

function polyline(
  ctx: CanvasRenderingContext2D,
  points: Array<[number, number]>,
  colour: string,
  thickness: number,
) {
  if (points.length === 0) {
    return;
  }

  ctx.strokeStyle = colour;
  ctx.lineWidth = thickness;
  ctx.lineJoin = "round";
  ctx.beginPath();

  points.forEach(([x, y], i) => {
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
}

/**
 * Input on x, output on y. Samples are bucketed by input level and plotted
 * left to right, so the curve reads as a function instead of a zigzag.
 */
function drawTransfer(
  canvas: HTMLCanvasElement,
  wave: { input: number[]; output: number[] },
) {
  const prepared = prepare(canvas);

  if (!prepared) {
    return;
  }

  const { ctx, width, height } = prepared;

  let peak = 0;

  for (const value of wave.input) {
    peak = Math.max(peak, Math.abs(value));
  }

  for (const value of wave.output) {
    peak = Math.max(peak, Math.abs(value));
  }

  // Keep unity on screen so a chain that only attenuates is not drawn
  // filling the whole box.
  const range = Math.max(peak, 0.5) * 1.15;
  const toX = (value: number) => width / 2 + (value / range) * (width / 2);
  const toY = (value: number) => height / 2 - (value / range) * (height / 2);

  drawFrame(ctx, width, height);

  // Dashed unity line, so "how far from clean" is readable at a glance.
  ctx.save();
  ctx.strokeStyle = INK.input;
  ctx.setLineDash([3, 3]);
  polyline(
    ctx,
    [
      [toX(-range), toY(-range)],
      [toX(range), toY(range)],
    ],
    INK.input,
    1,
  );
  ctx.restore();

  const sums = new Float64Array(BUCKETS);
  const counts = new Float64Array(BUCKETS);

  for (let i = 0; i < wave.input.length; i += 1) {
    const level = (wave.input[i] + 1) / 2;
    const bucket = Math.min(
      BUCKETS - 1,
      Math.max(0, Math.floor(level * BUCKETS)),
    );

    sums[bucket] += wave.output[i];
    counts[bucket] += 1;
  }

  const points: Array<[number, number]> = [];

  for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
    if (counts[bucket] === 0) {
      continue;
    }

    const level = (bucket + 0.5) / BUCKETS;
    const input = level * 2 - 1;
    points.push([toX(input), toY(sums[bucket] / counts[bucket])]);
  }

  polyline(ctx, points, INK.output, 1.75);

  drawLabel(ctx, "IN", 6, 12);
  drawLabel(ctx, "OUT", width - 26, 12);
  drawLabel(ctx, "+1", toX(range) - 12, height - 6);
  drawLabel(ctx, "-1", toX(-range), height - 6);
}

/**
 * Time on x, amplitude on y, with the input ghosted behind the output. Where
 * the two separate is the harmonic content the chain added.
 */
function drawTrace(
  canvas: HTMLCanvasElement,
  wave: { input: number[]; output: number[] },
) {
  const prepared = prepare(canvas);

  if (!prepared) {
    return;
  }

  const { ctx, width, height } = prepared;

  let peak = 0;

  for (const value of wave.input) {
    peak = Math.max(peak, Math.abs(value));
  }

  for (const value of wave.output) {
    peak = Math.max(peak, Math.abs(value));
  }

  const range = Math.max(peak, 0.5) * 1.15;
  const count = Math.max(wave.input.length, 2);
  const toX = (index: number) => (index / (count - 1)) * width;
  const toY = (value: number) => height / 2 - (value / range) * (height / 2);

  drawFrame(ctx, width, height);

  polyline(
    ctx,
    wave.input.map((value, i) => [toX(i), toY(value)] as [number, number]),
    INK.input,
    1,
  );

  polyline(
    ctx,
    wave.output.map((value, i) => [toX(i), toY(value)] as [number, number]),
    INK.output,
    1.75,
  );

  drawLabel(ctx, "IN", 6, 12);
  drawLabel(ctx, `OUT  ${FREQUENCY}Hz`, width - 82, 12);
}

export function WaveformPanel({ slots }: { slots: EffectSlot[] }) {
  const transferRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<HTMLCanvasElement>(null);

  // Recomputed as the chain is dragged, which is the whole point: no network
  // round trip and no agent work per frame.
  const wave = useMemo(() => render(slots), [slots]);

  const hasStateful = slots.some(
    (slot) => slot.enabled && slot.kind === "downsample",
  );

  useEffect(() => {
    const transfer = transferRef.current;
    const trace = traceRef.current;

    if (!transfer || !trace) {
      return;
    }

    const paint = () => {
      drawTransfer(transfer, wave);
      drawTrace(trace, wave);
    };

    paint();

    // The bitmaps are sized in device pixels, so a resize without a redraw
    // leaves the traces stretched.
    const observer = new ResizeObserver(paint);
    observer.observe(transfer);
    observer.observe(trace);

    return () => observer.disconnect();
  }, [wave]);

  return (
    <section className={styles.panel}>
      <figure className={styles.figure}>
        <header className={styles.header}>
          <h2 className={styles.title}>TRANSFER</h2>
          <span className={styles.hint}>
            {hasStateful ? "approx, downsample has memory" : "approx"}
          </span>
        </header>

        <canvas ref={transferRef} className={styles.canvas} />
      </figure>

      <figure className={styles.figure}>
        <header className={styles.header}>
          <h2 className={styles.title}>WAVEFORM</h2>
          <span className={styles.hint}>
            {FREQUENCY}Hz sine, {FRAMES} frames
          </span>
        </header>

        <canvas ref={traceRef} className={styles.canvas} />
      </figure>
    </section>
  );
}
