import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ChainSchema } from "@myass/protocol";

// The manifest is the contract between the store, the agent restore path, and
// (in phase 4) the FL export. It is versioned so an older API refuses a newer
// project instead of guessing at fields it does not understand.

export const MANIFEST_VERSION = 1;

const TimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be a timestamp");

export const LayerManifestSchema = z
  .object({
    index: z.number().int().min(0).max(7),
    file: z.string(),
    samples: z.number().int().min(1),
    level: z.number().min(0).max(100),
    muted: z.boolean(),
    playing: z.boolean(),
    truncated: z.boolean(),
    chain: ChainSchema,
    revision: z.number().int().min(0),
  })
  .refine((layer) => layer.file === `layers/${layer.index}.wav`, {
    message: "layer file must live at layers/<index>.wav",
    path: ["file"],
  });

export const ManifestSchema = z.object({
  format: z.literal("myass-project"),
  version: z.literal(MANIFEST_VERSION),
  id: z.string(),
  name: z.string().min(1).max(120),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  sampleRate: z.literal(48000),
  bpm: z.number().min(40).max(240),
  beatsPerBar: z.literal(4),
  bars: z.number().int().min(0).max(64),
  loopSamples: z.number().int().min(0),
  click: z.enum(["off", "countin", "countin-record"]),
  // The live effect board at capture time. Restoring a project puts this back
  // on the board, separately from the per-layer chains below.
  chain: ChainSchema,
  layers: z.array(LayerManifestSchema),
  linkedProjectId: z.string().nullable().default(null),
  linkedRevision: z.number().int().min(0).default(0),
  // Cached so listing the library never has to stat every WAV.
  sizeBytes: z.number().int().min(0).default(0),
  // Agent global revision this snapshot came from. Dirty tracking compares it
  // with linkedRevision.
  revision: z.number().int().min(0).default(0),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestLayer = z.infer<typeof LayerManifestSchema>;

export class InvalidProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectError";
  }
}

export function parseManifest(value: unknown): Manifest {
  const parsed = ManifestSchema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidProjectError(
      `invalid project manifest: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const layers = [...parsed.data.layers].sort((a, b) => a.index - b.index);

  if (new Set(layers.map((layer) => layer.index)).size !== layers.length) {
    throw new InvalidProjectError("manifest has duplicate layer indices");
  }

  return { ...parsed.data, layers };
}

export async function readManifest(file: string): Promise<Manifest> {
  let text: string;

  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new InvalidProjectError(
      `cannot read manifest: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    return parseManifest(JSON.parse(text));
  } catch (error) {
    if (error instanceof InvalidProjectError) {
      throw error;
    }

    throw new InvalidProjectError(
      `manifest is not valid JSON: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

/** A blank working session, used before the first take and after CLEAR ALL. */
export function emptyManifest(
  id: string,
  name: string,
  now = new Date().toISOString(),
): Manifest {
  return {
    format: "myass-project",
    version: MANIFEST_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    sampleRate: 48000,
    bpm: 120,
    beatsPerBar: 4,
    bars: 4,
    loopSamples: 0,
    click: "countin-record",
    chain: { slots: [] },
    layers: [],
    linkedProjectId: null,
    linkedRevision: 0,
    sizeBytes: 0,
    revision: 0,
  };
}
