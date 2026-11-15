import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  Injectable,
} from "@nestjs/common";
import {
  ProjectIdSchema,
  type FlExportManifest,
  type ProjectExportKind,
} from "@myass/protocol";
import { ControlClient } from "../agent/control.client.js";
import { fileEntry } from "../zip/file-entry.js";
import { writeZip, type ZipEntrySource } from "../zip/zip-writer.js";
import { BundleService } from "./bundle.service.js";
import { InvalidProjectError, type Manifest } from "./manifest.js";
import { mixdown, type MixLayer } from "./mixdown.js";
import { OperationQueue } from "./operation-queue.js";
import { ProjectNotFoundError, ProjectStore } from "./project.store.js";
import { decodeWav, encodeWav } from "./wav.js";

const SAMPLE_RATE = 48000;

export interface ProjectDownload {
  stream: Readable;
  size: number;
  filename: string;
  /** Exposed so the cleanup test can prove the temp file disappears. */
  zipPath: string;
}

interface BuiltLayer {
  index: number;
  file: string;
  dryFile: string;
  level: number;
  muted: boolean;
  chain: Manifest["layers"][number]["chain"];
  peak: number;
}

function peakOf(samples: Float32Array): number {
  let peak = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index]);

    if (magnitude > peak) {
      peak = magnitude;
    }
  }

  return peak;
}

function slug(name: string): string {
  const value = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return value.length > 0 ? value : "project";
}

function readme(manifest: FlExportManifest): string {
  const bars = manifest.bars > 0 ? `${manifest.bars} bars` : "FREE";
  const hot = [
    ...manifest.layers
      .filter((layer) => layer.peak > 1)
      .map((layer) => `layer ${layer.index + 1}: ${layer.peak.toFixed(3)}`),
    ...(manifest.mixPeak > 1 ? [`mix: ${manifest.mixPeak.toFixed(3)}`] : []),
  ];
  const lines = [
    `MYASS export - ${manifest.name}`,
    `Tempo: ${manifest.bpm} BPM, ${manifest.beatsPerBar}/4, ${bars} (${manifest.loopSeconds.toFixed(3)} s)`,
    `In FL Studio: set the project tempo to ${manifest.bpm} and drop every stem at bar 1.`,
    "",
    "stems-processed/  the loops exactly as they sound in MYASS",
    "stems-dry/        the raw takes, for re-amping or new effects",
    "mix.wav           processed stems mixed at their saved levels",
    "",
    "Muted layers are included as stems but excluded from mix.wav.",
    "Files are 48 kHz mono 32-bit float. Peaks above 0 dBFS are listed below;",
    "lower the FL mixer fader or add a limiter if your interface clips.",
    "",
  ];

  lines.push(
    hot.length > 0 ? "Peaks above 0 dBFS:" : "No peaks above 0 dBFS.",
    ...hot,
  );

  return `${lines.join("\n")}\n`;
}

/**
 * Turns a stored project into a downloadable ZIP. Bundles are a pure file
 * copy; FL exports run every layer through a private render chain so the live
 * board is never touched.
 */
@Injectable()
export class ExportService {
  constructor(
    private readonly control: ControlClient,
    private readonly store: ProjectStore,
    private readonly queue: OperationQueue,
    private readonly bundles: BundleService,
  ) {}

  async download(
    id: string,
    kind: ProjectExportKind,
  ): Promise<ProjectDownload> {
    if (!ProjectIdSchema.safeParse(id).success) {
      throw new ProjectNotFoundError(id);
    }

    return this.queue.run("export", async () => {
      const manifest = await this.store.readManifest(id);

      await mkdir(this.store.tempRoot, { recursive: true });

      const zipPath = path.join(
        this.store.tempRoot,
        `export-${randomUUID()}.zip`,
      );

      try {
        if (kind === "bundle") {
          await this.bundles.exportToZip(id, zipPath);
        } else {
          await this.exportFl(id, manifest, zipPath);
        }

        const info = await stat(zipPath);
        const stream = createReadStream(zipPath);
        const cleanup = () => {
          void rm(zipPath, { force: true }).catch(() => undefined);
        };

        // A cancelled download destroys the stream; a completed one emits
        // close after its file descriptor is released. Either way the temp
        // archive goes away.
        stream.once("close", cleanup);
        stream.once("error", cleanup);

        return {
          stream,
          size: info.size,
          filename: `${slug(manifest.name)}-${kind}.zip`,
          zipPath,
        };
      } catch (error) {
        await rm(zipPath, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  private async exportFl(
    id: string,
    manifest: Manifest,
    zipPath: string,
  ): Promise<void> {
    const work = path.join(this.store.tempRoot, `fl-${randomUUID()}`);
    const processedDir = path.join(work, "stems-processed");
    const dryDir = path.join(work, "stems-dry");

    try {
      await mkdir(processedDir, { recursive: true });
      await mkdir(dryDir, { recursive: true });

      const processed: MixLayer[] = [];
      const built: BuiltLayer[] = [];

      for (const layer of manifest.layers) {
        const decoded = decodeWav(
          await readFile(this.store.filePath(id, layer.file)),
        );

        if (decoded.sampleRate !== SAMPLE_RATE) {
          throw new InvalidProjectError(
            `${layer.file} is ${decoded.sampleRate} Hz, expected ${SAMPLE_RATE}`,
          );
        }

        if (decoded.samples.length !== manifest.loopSamples) {
          throw new InvalidProjectError(
            `${layer.file} is ${decoded.samples.length} samples, ` +
              `the project loop is ${manifest.loopSamples}`,
          );
        }

        const rendered = await this.control.renderChain(
          layer.chain.slots,
          decoded.samples,
        );

        if (rendered.length !== manifest.loopSamples) {
          throw new InvalidProjectError(
            `processed layer ${layer.index} is ${rendered.length} samples, ` +
              `expected ${manifest.loopSamples}`,
          );
        }

        const number = String(layer.index + 1).padStart(2, "0");
        const stem = `${number}-layer-${layer.index + 1}.wav`;
        const file = `stems-processed/${stem}`;
        const dryFile = `stems-dry/${stem}`;

        await writeFile(
          path.join(work, file),
          encodeWav(rendered, SAMPLE_RATE),
        );
        await writeFile(
          path.join(work, dryFile),
          encodeWav(decoded.samples, SAMPLE_RATE),
        );

        processed.push({
          samples: rendered,
          level: layer.level,
          muted: layer.muted,
        });
        built.push({
          index: layer.index,
          file,
          dryFile,
          level: layer.level,
          muted: layer.muted,
          chain: layer.chain,
          peak: peakOf(rendered),
        });
      }

      const mixed = mixdown(processed, manifest.loopSamples);

      await writeFile(
        path.join(work, "mix.wav"),
        encodeWav(mixed.mix, SAMPLE_RATE),
      );

      const exportManifest: FlExportManifest = {
        format: "myass-fl-export",
        version: 1,
        name: manifest.name,
        bpm: manifest.bpm,
        beatsPerBar: manifest.beatsPerBar,
        bars: manifest.bars,
        loopSamples: manifest.loopSamples,
        loopSeconds: manifest.loopSamples / SAMPLE_RATE,
        createdAt: new Date().toISOString(),
        layers: built.map((layer, index) => ({
          index: layer.index,
          file: layer.file,
          dryFile: layer.dryFile,
          level: layer.level,
          muted: layer.muted,
          chain: layer.chain,
          // mixdown returns peaks in the same order as the processed layers.
          peak: mixed.peaks[index] ?? layer.peak,
        })),
        mixPeak: peakOf(mixed.mix),
      };

      await writeFile(
        path.join(work, "manifest.json"),
        JSON.stringify(exportManifest, null, 2),
      );
      await writeFile(path.join(work, "README.txt"), readme(exportManifest));

      const entries: ZipEntrySource[] = [
        await fileEntry(path.join(work, "manifest.json"), "manifest.json"),
        await fileEntry(path.join(work, "README.txt"), "README.txt"),
      ];

      for (const layer of exportManifest.layers) {
        entries.push(
          await fileEntry(path.join(work, layer.file), layer.file),
        );
      }

      for (const layer of exportManifest.layers) {
        entries.push(
          await fileEntry(path.join(work, layer.dryFile), layer.dryFile),
        );
      }

      entries.push(await fileEntry(path.join(work, "mix.wav"), "mix.wav"));
      await writeZip(zipPath, entries);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
