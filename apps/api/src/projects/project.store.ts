import {
  access,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  emptyManifest,
  InvalidProjectError,
  parseManifest,
  readManifest,
  type Manifest,
} from "./manifest.js";
import { decodeWav, encodeWav } from "./wav.js";

// Only a UUID or the reserved working id can name a directory. Everything else
// is refused before a path is built, which is the path-traversal guard.
export const PROJECT_ID_PATTERN =
  /^(?:working|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const WORKING_ID = "working";
const WORKING_NAME = "Working session";

export function isValidProjectId(id: string): boolean {
  return PROJECT_ID_PATTERN.test(id);
}

/** One project in memory: its manifest plus the PCM each manifest layer names. */
export interface StoredProject {
  manifest: Manifest;
  layers: Map<number, Float32Array>;
}

/** Listing shape shared by the wire protocol and the store. */
export interface ProjectSummary {
  id: string;
  name: string;
  valid: boolean;
  updatedAt: string;
  bpm: number;
  beatsPerBar: number;
  bars: number;
  sampleRate: number;
  loopSeconds: number;
  layerCount: number;
  sizeBytes: number;
}

export interface CopyOptions {
  name?: string;
  linkedProjectId?: string | null;
  linkedRevision?: number;
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`no project ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

function defaultRoot(): string {
  // src/projects and dist/projects are both two levels below the API package,
  // so the same expression points at apps/api/data/projects in either case.
  return fileURLToPath(new URL("../../data/projects", import.meta.url));
}

export function summaryOf(manifest: Manifest): ProjectSummary {
  return {
    id: manifest.id,
    name: manifest.name,
    valid: true,
    updatedAt: manifest.updatedAt,
    bpm: manifest.bpm,
    beatsPerBar: manifest.beatsPerBar,
    bars: manifest.bars,
    sampleRate: manifest.sampleRate,
    loopSeconds: manifest.loopSamples / manifest.sampleRate,
    layerCount: manifest.layers.length,
    sizeBytes: manifest.sizeBytes,
  };
}

export function emptySummary(): ProjectSummary {
  return {
    id: WORKING_ID,
    name: WORKING_NAME,
    valid: true,
    updatedAt: new Date(0).toISOString(),
    bpm: 120,
    beatsPerBar: 4,
    bars: 4,
    sampleRate: 48000,
    loopSeconds: 0,
    layerCount: 0,
    sizeBytes: 0,
  };
}

function invalidSummary(id: string): ProjectSummary {
  return {
    id,
    name: id,
    valid: false,
    updatedAt: new Date(0).toISOString(),
    bpm: 0,
    beatsPerBar: 4,
    bars: 0,
    sampleRate: 48000,
    loopSeconds: 0,
    layerCount: 0,
    sizeBytes: 0,
  };
}

async function writeSynced(file: string, data: Buffer): Promise<void> {
  const handle = await open(file, "w");

  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Filesystem-only project library. It has no agent knowledge; the service
 * above it turns looper state into these manifests and back. All mutation is
 * atomic at the directory level so a crash leaves either the old project or
 * the new one, never a half-written one.
 */
export class ProjectStore {
  private readonly root: string;

  constructor(root: string = process.env.MYASS_PROJECTS_DIR ?? defaultRoot()) {
    this.root = path.resolve(root);
  }

  /** Scratch space for exports, on the same filesystem as the projects. */
  get tempRoot(): string {
    return path.join(this.root, ".tmp");
  }

  /**
   * Resolves a file inside a project. Layer names come from a validated
   * manifest, but this repeats the check so a future caller cannot join an
   * arbitrary path onto the library.
   */
  filePath(id: string, relative: string): string {
    this.assertId(id);

    const segments = relative.split("/");

    if (
      relative.length === 0 ||
      relative.includes("\\") ||
      path.isAbsolute(relative) ||
      segments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new InvalidProjectError(`unsafe project file: ${relative}`);
    }

    return path.join(this.directory(id), ...segments);
  }

  async list(): Promise<ProjectSummary[]> {
    let entries;

    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const summaries: ProjectSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidProjectId(entry.name)) {
        continue;
      }

      try {
        const manifest = await readManifest(
          path.join(this.root, entry.name, "manifest.json"),
        );

        if (manifest.id !== entry.name) {
          throw new InvalidProjectError(
            `manifest id ${manifest.id} does not match directory ${entry.name}`,
          );
        }

        summaries.push(summaryOf(manifest));
      } catch {
        // A corrupt project must not hide the rest of the library.
        summaries.push(invalidSummary(entry.name));
      }
    }

    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  async read(id: string): Promise<StoredProject> {
    this.assertId(id);

    if (!(await this.exists(id))) {
      throw new ProjectNotFoundError(id);
    }

    const manifest = await readManifest(this.manifestPath(id));

    if (manifest.id !== id) {
      throw new InvalidProjectError(
        `manifest id ${manifest.id} does not match requested ${id}`,
      );
    }

    const layers = new Map<number, Float32Array>();

    for (const layer of manifest.layers) {
      const file = path.join(this.directory(id), layer.file);

      let buffer: Buffer;

      try {
        buffer = await readFile(file);
      } catch (error) {
        throw new InvalidProjectError(
          `cannot read ${layer.file}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }

      const decoded = decodeWav(buffer);

      if (decoded.sampleRate !== manifest.sampleRate) {
        throw new InvalidProjectError(
          `${layer.file} is ${decoded.sampleRate} Hz, expected ${manifest.sampleRate}`,
        );
      }

      if (decoded.samples.length !== layer.samples) {
        throw new InvalidProjectError(
          `${layer.file} has ${decoded.samples.length} samples, manifest says ${layer.samples}`,
        );
      }

      layers.set(layer.index, decoded.samples);
    }

    return { manifest, layers };
  }

  async readManifest(id: string): Promise<Manifest> {
    this.assertId(id);

    if (!(await this.exists(id))) {
      throw new ProjectNotFoundError(id);
    }

    return readManifest(this.manifestPath(id));
  }

  async readManifestIfExists(id: string): Promise<Manifest | null> {
    this.assertId(id);

    try {
      await access(this.manifestPath(id));
    } catch {
      return null;
    }

    return readManifest(this.manifestPath(id));
  }

  async write(project: StoredProject): Promise<ProjectSummary> {
    const { manifest } = project;
    this.assertId(manifest.id);

    await mkdir(this.root, { recursive: true });

    const staging = path.join(this.root, `.staging-${randomUUID()}`);

    try {
      await mkdir(path.join(staging, "layers"), { recursive: true });

      let wavBytes = 0;

      // Validation happens per layer while staging, not up front, so a bad
      // layer late in a project exercises the same rollback as a disk error.
      for (const layer of manifest.layers) {
        const samples = project.layers.get(layer.index);

        if (!samples) {
          throw new InvalidProjectError(
            `layer ${layer.index} is in the manifest without audio`,
          );
        }

        if (samples.length !== layer.samples) {
          throw new InvalidProjectError(
            `layer ${layer.index} has ${samples.length} samples, manifest says ${layer.samples}`,
          );
        }

        const wav = encodeWav(samples, manifest.sampleRate);
        await writeSynced(path.join(staging, layer.file), wav);
        wavBytes += wav.length;
      }

      for (const index of project.layers.keys()) {
        if (!manifest.layers.some((layer) => layer.index === index)) {
          throw new InvalidProjectError(
            `layer ${index} has audio but is not in the manifest`,
          );
        }
      }

      // sizeBytes includes the manifest itself. Two passes settle the digit
      // count of the number before the final file is written.
      let sizeBytes = wavBytes + Buffer.byteLength(JSON.stringify(manifest));
      let stored: Manifest = { ...manifest, sizeBytes };

      const firstJson = JSON.stringify({ ...manifest, sizeBytes }, null, 2);
      sizeBytes = wavBytes + Buffer.byteLength(firstJson);
      stored = { ...manifest, sizeBytes };
      const finalJson = JSON.stringify(stored, null, 2);

      await writeSynced(
        path.join(staging, "manifest.json"),
        Buffer.from(finalJson, "utf8"),
      );

      await this.replace(staging, manifest.id);

      return summaryOf(stored);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async writeManifest(id: string, manifest: Manifest): Promise<ProjectSummary> {
    this.assertId(id);
    this.assertId(manifest.id);

    if (manifest.id !== id) {
      throw new InvalidProjectError(
        `manifest id ${manifest.id} does not match requested ${id}`,
      );
    }

    if (!(await this.exists(id))) {
      throw new ProjectNotFoundError(id);
    }

    const checked = parseManifest(manifest);
    const directory = this.directory(id);
    const temp = path.join(directory, `.manifest-${randomUUID()}.json`);

    try {
      await writeSynced(
        temp,
        Buffer.from(JSON.stringify(checked, null, 2), "utf8"),
      );
      await rename(temp, this.manifestPath(id));
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }

    return summaryOf(checked);
  }

  /**
   * Copies audio and a rewritten manifest. A copy to an existing id keeps that
   * project's name and creation time, so SAVE over a named project does not
   * silently rename it.
   */
  async copy(
    fromId: string,
    toId: string,
    options: CopyOptions = {},
  ): Promise<ProjectSummary> {
    const source = await this.read(fromId);
    const target = await this.readManifestIfExists(toId);
    const now = new Date().toISOString();

    const manifest: Manifest = {
      ...source.manifest,
      id: toId,
      name: options.name ?? target?.name ?? source.manifest.name,
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
      linkedProjectId: options.linkedProjectId ?? null,
      linkedRevision: options.linkedRevision ?? 0,
      sizeBytes: 0,
    };

    return this.write({ manifest, layers: source.layers });
  }

  async remove(id: string): Promise<void> {
    this.assertId(id);

    const trash = path.join(this.root, `.trash-${randomUUID()}`);

    try {
      await rename(this.directory(id), trash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProjectNotFoundError(id);
      }

      throw error;
    }

    await rm(trash, { recursive: true, force: true });
  }

  async exists(id: string): Promise<boolean> {
    if (!isValidProjectId(id)) {
      return false;
    }

    try {
      return (await stat(this.directory(id))).isDirectory();
    } catch {
      return false;
    }
  }

  async createWorkingIfMissing(): Promise<void> {
    if (await this.exists(WORKING_ID)) {
      return;
    }

    await this.write({
      manifest: emptyManifest(WORKING_ID, WORKING_NAME),
      layers: new Map(),
    });
  }

  /** Copies the current working session aside before an adoption, and leaves
   * the working directory in place so a failed adoption can be retried. */
  async backupWorking(): Promise<string | null> {
    if (!(await this.exists(WORKING_ID))) {
      return null;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      `working-backup-${stamp}-${randomUUID().slice(0, 8)}`,
    );

    await cp(this.directory(WORKING_ID), destination, { recursive: true });

    return destination;
  }

  private async replace(staging: string, id: string): Promise<void> {
    const target = this.directory(id);
    const trash = path.join(this.root, `.trash-${randomUUID()}`);
    let movedOld = false;

    // rename() cannot replace a non-empty directory, so the old project steps
    // aside first. If the second rename fails, it steps back.
    try {
      await rename(target, trash);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    try {
      await rename(staging, target);
    } catch (error) {
      if (movedOld) {
        await rename(trash, target).catch(() => undefined);
      }

      throw error;
    }

    if (movedOld) {
      await rm(trash, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private directory(id: string): string {
    return path.join(this.root, id);
  }

  private manifestPath(id: string): string {
    return path.join(this.directory(id), "manifest.json");
  }

  private assertId(id: string): void {
    if (!isValidProjectId(id)) {
      throw new ProjectNotFoundError(id);
    }
  }
}
