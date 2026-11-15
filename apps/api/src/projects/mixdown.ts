export interface MixLayer {
  samples: Float32Array;
  /** 0-100, as the manifest and UI store it. */
  level: number;
  muted: boolean;
}

export interface MixResult {
  mix: Float32Array;
  /** Absolute peak of each layer before level and mute are applied. */
  peaks: number[];
}

/**
 * Mixes processed stems at their saved levels. No clamping: float WAV keeps
 * the headroom, and the export README warns about peaks above 0 dBFS so the
 * user can decide how to tame them in the DAW.
 */
export function mixdown(layers: MixLayer[], loopSamples: number): MixResult {
  const mix = new Float32Array(loopSamples);
  const peaks: number[] = [];

  for (const layer of layers) {
    let peak = 0;

    for (let index = 0; index < layer.samples.length; index += 1) {
      const magnitude = Math.abs(layer.samples[index]);

      if (magnitude > peak) {
        peak = magnitude;
      }
    }

    peaks.push(peak);

    if (layer.muted) {
      continue;
    }

    const gain = layer.level / 100;
    const count = Math.min(loopSamples, layer.samples.length);

    // A shorter layer is treated as zero-padded rather than refused; phase 2
    // already guarantees equal lengths, so this only protects the export.
    for (let index = 0; index < count; index += 1) {
      mix[index] += layer.samples[index] * gain;
    }
  }

  return { mix, peaks };
}
