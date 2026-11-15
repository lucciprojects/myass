import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { InvalidBundleError } from "../zip/errors.js";
import { fileEntry } from "../zip/file-entry.js";
import { MAX_BUNDLE_BYTES, readZip } from "../zip/zip-reader.js";
import { writeZip, type ZipEntrySource } from "../zip/zip-writer.js";
import {
  InvalidProjectError,
  parseManifest,
  type Manifest,
} from "./manifest.js";
import { OperationQueue } from "./operation-queue.js";
import { ProjectStore, type ProjectSummary } from "./project.store.js";
import { decodeWav } from "./wav.js";

export { MAX_BUNDLE_BYTES };

const SAMPLE_RATE = 48000;
const MAX_LOOP_SAMPLES = 32 * SAMPLE_RATE;

/**
 * The re-upload format: the project's own manifest and WAVs in a store-only
 * ZIP. Export writes the files verbatim, so import -> export -> import is a
 * fixed point apart from the generated id and timestamps.
 */
@Injectable()
export class BundleService {
  constructor(
    private readonly store: ProjectStore,
    private readonly queue: OperationQueue,
  ) {}

  async exportToZip(id: string, zipPath: string): Promise<void> {
    const manifest = await this.store.readManifest(id);
    const entries: ZipEntrySource[] = [
      await fileEntry(this.store.filePath(id, "manifest.json"), "manifest.json"),
    ];

    for (const layer of manifest.layers) {
      entries.push(
        await fileEntry(this.store.filePath(id, layer.file), layer.file),
      );
    }

    await writeZip(zipPath, entries);
  }

  async importFromZip(buffer: Buffer): Promise<ProjectSummary> {
    return this.queue.run("import", async () => {
      const files = readZip(buffer);
      const byName = new Map(files.map((file) => [file.name, file]));
      const manifestFile = byName.get("manifest.json");

      if (!manifestFile) {
        throw new InvalidBundleError(
          "bad_manifest",
          "bundle has no manifest.json",
        );
      }

      let value: unknown;

      try {
        value = JSON.parse(manifestFile.read().toString("utf8"));
      } catch (error) {
        if (error instanceof InvalidBundleError) {
          throw error;
        }

        throw new InvalidBundleError(
          "bad_manifest",
          `manifest is not valid JSON: ${this.message(error)}`,
        );
      }

      let manifest: Manifest;

      try {
        manifest = parseManifest(value);
      } catch (error) {
        if (error instanceof InvalidProjectError) {
          throw new InvalidBundleError("bad_manifest", error.message);
        }

        throw error;
      }

      const expected = new Set(manifest.layers.map((layer) => layer.file));

      // Only the manifest and the WAVs it names are part of the format. A
      // README is tolerated for forward compatibility; anything else is a
      // sign this is not a MYASS bundle.
      for (const file of files) {
        if (file.name === "manifest.json" || file.name === "README.txt") {
          continue;
        }

        if (!expected.has(file.name)) {
          throw new InvalidBundleError(
            "extra_entry",
            `unexpected bundle entry: ${file.name}`,
          );
        }
      }

      if (manifest.loopSamples > MAX_LOOP_SAMPLES) {
        throw new InvalidBundleError(
          "bad_manifest",
          `loop is longer than ${MAX_LOOP_SAMPLES / SAMPLE_RATE}s`,
        );
      }

      if (manifest.layers.length > 0 && manifest.loopSamples === 0) {
        throw new InvalidBundleError(
          "bad_manifest",
          "bundle has layers but no loop length",
        );
      }

      const layers = new Map<number, Float32Array>();

      for (const layer of manifest.layers) {
        const file = byName.get(layer.file);

        if (!file) {
          throw new InvalidBundleError(
            "bad_manifest",
            `bundle is missing ${layer.file}`,
          );
        }

        let decoded;

        try {
          decoded = decodeWav(file.read());
        } catch (error) {
          if (error instanceof InvalidBundleError) {
            throw error;
          }

          throw new InvalidBundleError(
            "bad_wav",
            `${layer.file}: ${this.message(error)}`,
          );
        }

        if (decoded.sampleRate !== SAMPLE_RATE) {
          throw new InvalidBundleError(
            "bad_wav",
            `${layer.file} is ${decoded.sampleRate} Hz, expected ${SAMPLE_RATE}`,
          );
        }

        if (decoded.samples.length !== layer.samples) {
          throw new InvalidBundleError(
            "bad_wav",
            `${layer.file} has ${decoded.samples.length} samples, ` +
              `manifest says ${layer.samples}`,
          );
        }

        if (decoded.samples.length !== manifest.loopSamples) {
          throw new InvalidBundleError(
            "bad_manifest",
            `${layer.file} is ${decoded.samples.length} samples, ` +
              `but the bundle loop is ${manifest.loopSamples}`,
          );
        }

        layers.set(layer.index, decoded.samples);
      }

      const now = new Date().toISOString();
      const id = randomUUID();
      const imported: Manifest = {
        ...manifest,
        id,
        createdAt: now,
        updatedAt: now,
        linkedProjectId: null,
        linkedRevision: 0,
        revision: 0,
        sizeBytes: 0,
        layers: manifest.layers.map((layer) => ({
          ...layer,
          revision: 0,
        })),
      };

      return this.store.write({ manifest: imported, layers });
    });
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
