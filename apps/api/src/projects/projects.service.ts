import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ProjectIdSchema,
  type LooperState,
  type ProjectList,
  type ProjectLoadResult,
  type ProjectStatus,
  type ProjectSummary,
} from "@myass/protocol";
import {
  AgentUnavailableError,
  type ControlClient,
  type ProjectPayload,
} from "../agent/control.client.js";
import {
  emptyManifest,
  InvalidProjectError,
  type Manifest,
  type ManifestLayer,
} from "./manifest.js";
import { OperationQueue } from "./operation-queue.js";
import {
  ProjectNotFoundError,
  ProjectStore,
  emptySummary,
  summaryOf,
  type StoredProject,
} from "./project.store.js";

const WORKING_ID = "working";
const WORKING_NAME = "Working session";
const SAMPLE_RATE = 48000;
const BEATS_PER_BAR = 4;
const MAX_LOOP_SECONDS = 32;

interface CachedLayer {
  revision: number;
  samples: Float32Array;
}

type CaptureReason = "autosave" | "save" | "restore";

/**
 * Owns the recording library and the working session. The agent is a real-time
 * buffer with no filesystem knowledge; this service snapshots it into 48 kHz
 * float WAVs, restores snapshots through the staged project protocol, and
 * keeps the reserved working/ directory current.
 */
@Injectable()
export class ProjectsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly layerCache = new Map<number, CachedLayer>();
  private readonly unsubscribers: Array<() => void> = [];
  private working: Manifest | null = null;
  private status: ProjectStatus = "saved";
  private ready = false;
  private restorePromise: Promise<void> | null = null;

  constructor(
    private readonly control: ControlClient,
    private readonly store: ProjectStore,
    private readonly queue: OperationQueue,
  ) {}

  onModuleInit(): void {
    // Registered before the first command so a connection that lands while
    // startup is still running is not missed. initialize() also checks
    // isConnected() for a socket that connected before Nest finished wiring.
    this.unsubscribers.push(
      this.control.onConnect(() => {
        void this.restore().catch((error) => {
          this.logger.warn(
            `restore after connect failed: ${this.message(error)}`,
          );
        });
      }),
    );
    this.unsubscribers.push(
      this.control.onDisconnect(() => {
        this.status = "agentOffline";
      }),
    );

    void this.initialize().catch((error) => {
      this.logger.error(`project store init failed: ${this.message(error)}`);
    });
  }

  onModuleDestroy(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }

    this.unsubscribers.length = 0;
  }

  /** Public so tests can await the same startup path Nest runs. */
  async initialize(): Promise<void> {
    await this.store.createWorkingIfMissing();
    this.working = await this.store.readManifest(WORKING_ID);

    if (this.control.isConnected()) {
      await this.restore();
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  markOffline(): void {
    this.status = "agentOffline";
  }

  async autosave(): Promise<void> {
    if (!this.ready || this.queue.busy() !== null) {
      return;
    }

    try {
      await this.queue.run("autosave", async () => {
        this.status = "saving";

        try {
          await this.capture("autosave");
          this.status = "saved";
        } catch (error) {
          if (error instanceof AgentUnavailableError) {
            this.status = "agentOffline";
            return;
          }

          throw error;
        }
      });
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        this.status = "agentOffline";
        return;
      }

      throw error;
    }
  }

  /**
   * Snapshots the agent into working/. A take that is still counting in or
   * recording is skipped: the agent refuses a dump while busy, and the take is
   * not committed yet. Manual saves turn that into a 409 instead of racing.
   */
  async capture(reason: CaptureReason): Promise<void> {
    const state = await this.control.getLooper();
    const busy = state.layers.find((layer) => layer.recording || layer.waiting);

    if (busy) {
      if (reason === "autosave") {
        return;
      }

      throw new ConflictException(
        `layer ${busy.index} is still ${busy.recording ? "recording" : "counting in"}`,
      );
    }

    const previous = await this.workingManifest();

    // Anything a save would capture bumps the global revision, so equality
    // means nothing has changed since the last write.
    if (previous && previous.revision === state.revision) {
      return;
    }

    if (state.sampleRate !== SAMPLE_RATE) {
      throw new InvalidProjectError(
        `agent sample rate is ${state.sampleRate}, expected ${SAMPLE_RATE}`,
      );
    }

    if (state.beatsPerBar !== BEATS_PER_BAR) {
      throw new InvalidProjectError(
        `agent meter is ${state.beatsPerBar}/4, only 4/4 is supported`,
      );
    }

    const active = state.layers.filter((layer) => layer.samples > 0);
    const board = await this.control.getChain();
    const layers: ManifestLayer[] = [];
    const audio = new Map<number, Float32Array>();

    for (const layer of active) {
      const cached = this.layerCache.get(layer.index);
      const samples =
        cached &&
        cached.revision === layer.revision &&
        cached.samples.length === layer.samples
          ? cached.samples
          : await this.control.dumpLayer(layer.index);

      if (samples.length !== layer.samples) {
        throw new InvalidProjectError(
          `dump of layer ${layer.index} returned ${samples.length} samples, ` +
            `agent reports ${layer.samples}`,
        );
      }

      // Chains are captured on every write tick, not only when the layer
      // revision moves: pasting a chain bumps the global revision and leaves
      // the layer revision alone.
      const slots = await this.control.getLayerChain(layer.index);

      this.layerCache.set(layer.index, {
        revision: layer.revision,
        samples,
      });
      audio.set(layer.index, samples);
      layers.push({
        index: layer.index,
        file: `layers/${layer.index}.wav`,
        samples: layer.samples,
        level: layer.level,
        muted: layer.muted,
        playing: layer.playing,
        truncated: layer.truncated,
        chain: { slots },
        revision: layer.revision,
      });
    }

    for (const index of [...this.layerCache.keys()]) {
      if (!active.some((layer) => layer.index === index)) {
        this.layerCache.delete(index);
      }
    }

    const base = previous ?? emptyManifest(WORKING_ID, WORKING_NAME);
    const manifest: Manifest = {
      ...base,
      id: WORKING_ID,
      name: WORKING_NAME,
      updatedAt: new Date().toISOString(),
      sampleRate: SAMPLE_RATE,
      bpm: state.bpm,
      beatsPerBar: BEATS_PER_BAR,
      bars: state.bars,
      loopSamples: state.loopSamples,
      click: state.click,
      chain: board,
      layers,
      revision: state.revision,
      sizeBytes: 0,
    };

    const summary = await this.store.write({ manifest, layers: audio });
    this.working = { ...manifest, sizeBytes: summary.sizeBytes };
  }

  async list(): Promise<ProjectList> {
    const all = await this.store.list();
    const working = await this.workingManifest();
    const workingSummary =
      all.find((summary) => summary.id === WORKING_ID) ??
      (working ? summaryOf(working) : emptySummary());

    return {
      working: workingSummary,
      projects: all
        .filter((summary) => summary.id !== WORKING_ID)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      busy: this.queue.busy(),
      status: this.control.isConnected() ? this.status : "agentOffline",
      dirty: working ? working.revision !== working.linkedRevision : false,
      linkedProjectId: working?.linkedProjectId ?? null,
    };
  }

  async saveAs(name: string): Promise<ProjectSummary> {
    return this.queue.run("save-as", async () => {
      await this.capture("save");

      const id = randomUUID();
      const revision = this.working?.revision ?? 0;
      const summary = await this.store.copy(WORKING_ID, id, { name });
      await this.linkWorking(id, revision);

      return summary;
    });
  }

  async save(id: string): Promise<ProjectSummary> {
    this.assertNamed(id);

    return this.queue.run("save", async () => {
      await this.store.readManifest(id);
      await this.capture("save");

      const revision = this.working?.revision ?? 0;
      const summary = await this.store.copy(WORKING_ID, id);
      await this.linkWorking(id, revision);

      return summary;
    });
  }

  async load(id: string): Promise<ProjectLoadResult> {
    if (!ProjectIdSchema.safeParse(id).success) {
      throw new ProjectNotFoundError(id);
    }

    return this.queue.run("load", async () => {
      const state = await this.control.getLooper();
      const busy = state.layers.find((layer) => layer.recording || layer.waiting);

      if (busy) {
        throw new ConflictException(
          `layer ${busy.index} is still ${busy.recording ? "recording" : "counting in"}`,
        );
      }

      const project = await this.store.read(id);
      this.validateProject(project);
      await this.control.loadProject(this.toPayload(project));

      const loaded = await this.control.getLooper();
      await this.store.copy(id, WORKING_ID, {
        name: WORKING_NAME,
        linkedProjectId: id,
        linkedRevision: project.manifest.revision,
      });
      const synced = await this.syncWorkingRevisions(loaded, id);

      this.working = synced;
      this.rebuildCache(project, loaded);
      this.status = "saved";

      return { loaded: true, state: loaded };
    });
  }

  async rename(id: string, name: string): Promise<ProjectSummary> {
    this.assertNamed(id);

    return this.queue.run("rename", async () => {
      const manifest = await this.store.readManifest(id);
      const updated: Manifest = {
        ...manifest,
        name,
        updatedAt: new Date().toISOString(),
      };
      const summary = await this.store.writeManifest(id, updated);

      return summary;
    });
  }

  async remove(id: string): Promise<void> {
    this.assertNamed(id);

    return this.queue.run("delete", async () => {
      await this.store.remove(id);
      const working = await this.workingManifest();

      // A deleted project must not stay linked from the working session, or
      // the UI would offer to save into a directory that no longer exists.
      if (working?.linkedProjectId === id) {
        const updated: Manifest = {
          ...working,
          linkedProjectId: null,
          linkedRevision: working.revision,
          updatedAt: new Date().toISOString(),
        };
        await this.store.writeManifest(WORKING_ID, updated);
        this.working = updated;
      }
    });
  }

  /**
   * Called on connect and retried by the poller. Empty agent plus non-empty
   * working restores the last session paused. A non-empty agent on first
   * contact is adopted as the working session, with the previous one copied
   * aside.
   */
  async restore(): Promise<void> {
    if (this.restorePromise) {
      return this.restorePromise;
    }

    const promise = this.queue.run("restore", () => this.performRestore());
    this.restorePromise = promise;

    try {
      await promise;
    } finally {
      if (this.restorePromise === promise) {
        this.restorePromise = null;
      }
    }
  }

  async tryRestore(): Promise<void> {
    if (this.ready || !this.control.isConnected()) {
      return;
    }

    await this.restore();
  }

  private async performRestore(): Promise<void> {
    await this.store.createWorkingIfMissing();

    const state = await this.control.getLooper();
    const working = await this.store.read(WORKING_ID);
    const busy = state.layers.some((layer) => layer.recording || layer.waiting);

    if (busy) {
      // Do not race a take that was already running when the API came up.
      this.ready = true;
      this.status = "saved";
      return;
    }

    const agentEmpty = state.layers.every((layer) => layer.samples === 0);

    if (agentEmpty) {
      if (working.manifest.layers.length > 0) {
        this.validateProject(working);
        await this.control.loadProject(this.toPayload(working));

        const loaded = await this.control.getLooper();
        this.working = await this.syncWorkingRevisions(
          loaded,
          working.manifest.linkedProjectId,
        );
        this.rebuildCache(working, loaded);
      } else {
        this.working = working.manifest;
      }
    } else if (this.matchesWorking(state, working.manifest)) {
      this.working = working.manifest;
      this.rebuildCache(working, state);
    } else {
      if (working.manifest.layers.length > 0) {
        const backup = await this.store.backupWorking();

        if (backup) {
          this.logger.log(`backed up working session to ${backup}`);
        }
      }

      await this.capture("restore");
    }

    this.ready = true;
    this.status = "saved";
  }

  private matchesWorking(state: LooperState, working: Manifest): boolean {
    if (state.revision !== working.revision) {
      return false;
    }

    const active = state.layers.filter((layer) => layer.samples > 0);

    if (active.length !== working.layers.length) {
      return false;
    }

    return active.every((layer) => {
      const entry = working.layers.find((item) => item.index === layer.index);

      return (
        entry !== undefined &&
        entry.revision === layer.revision &&
        entry.samples === layer.samples
      );
    });
  }

  private async syncWorkingRevisions(
    state: LooperState,
    linkedProjectId: string | null,
  ): Promise<Manifest> {
    const current = await this.store.readManifest(WORKING_ID);
    const revisionByIndex = new Map(
      state.layers.map((layer) => [layer.index, layer.revision]),
    );
    const updated: Manifest = {
      ...current,
      updatedAt: new Date().toISOString(),
      // The load bumps the agent's revisions; moving them into the working
      // manifest keeps an untouched restore from looking dirty.
      revision: state.revision,
      linkedRevision: state.revision,
      linkedProjectId,
      layers: current.layers.map((layer) => ({
        ...layer,
        revision: revisionByIndex.get(layer.index) ?? layer.revision,
      })),
    };

    await this.store.writeManifest(WORKING_ID, updated);

    return updated;
  }

  private rebuildCache(project: StoredProject, state: LooperState): void {
    const revisionByIndex = new Map(
      state.layers.map((layer) => [layer.index, layer.revision]),
    );

    this.layerCache.clear();

    for (const entry of project.manifest.layers) {
      const samples = project.layers.get(entry.index);

      if (samples) {
        this.layerCache.set(entry.index, {
          revision: revisionByIndex.get(entry.index) ?? entry.revision,
          samples,
        });
      }
    }
  }

  private async linkWorking(
    projectId: string,
    revision: number,
  ): Promise<void> {
    const manifest = await this.store.readManifest(WORKING_ID);
    const updated: Manifest = {
      ...manifest,
      linkedProjectId: projectId,
      linkedRevision: revision,
      updatedAt: new Date().toISOString(),
    };

    await this.store.writeManifest(WORKING_ID, updated);
    this.working = updated;
  }

  private validateProject(project: StoredProject): void {
    const { manifest } = project;

    if (manifest.sampleRate !== SAMPLE_RATE) {
      throw new InvalidProjectError(
        `project is ${manifest.sampleRate} Hz, expected ${SAMPLE_RATE}`,
      );
    }

    if (manifest.beatsPerBar !== BEATS_PER_BAR) {
      throw new InvalidProjectError(
        `project is ${manifest.beatsPerBar}/4, only 4/4 is supported`,
      );
    }

    if (manifest.loopSamples > MAX_LOOP_SECONDS * SAMPLE_RATE) {
      throw new InvalidProjectError(
        `project loop is ${manifest.loopSamples / SAMPLE_RATE}s, the cap is ${MAX_LOOP_SECONDS}s`,
      );
    }

    if (manifest.layers.length > 0 && manifest.loopSamples === 0) {
      throw new InvalidProjectError("project has layers but no loop length");
    }

    for (const entry of manifest.layers) {
      const samples = project.layers.get(entry.index);

      if (!samples) {
        throw new InvalidProjectError(
          `layer ${entry.index} is missing its audio`,
        );
      }

      if (samples.length !== manifest.loopSamples) {
        throw new InvalidProjectError(
          `layer ${entry.index} is ${samples.length} samples, ` +
            `the project loop is ${manifest.loopSamples}`,
        );
      }
    }
  }

  private toPayload(project: StoredProject): ProjectPayload {
    const { manifest } = project;

    return {
      bpm: manifest.bpm,
      beatsPerBar: BEATS_PER_BAR,
      bars: manifest.bars,
      click: manifest.click,
      loopSamples: manifest.loopSamples,
      layers: manifest.layers.map((entry) => ({
        index: entry.index,
        samples: project.layers.get(entry.index) ?? new Float32Array(0),
        level: entry.level,
        muted: entry.muted,
        playing: entry.playing,
        truncated: entry.truncated,
        chain: entry.chain.slots,
      })),
      board: manifest.chain.slots,
    };
  }

  private async workingManifest(): Promise<Manifest | null> {
    if (this.working) {
      return this.working;
    }

    try {
      this.working = await this.store.readManifest(WORKING_ID);
      return this.working;
    } catch {
      return null;
    }
  }

  private assertNamed(id: string): void {
    if (!ProjectIdSchema.safeParse(id).success) {
      throw new ProjectNotFoundError(id);
    }

    if (id === WORKING_ID) {
      throw new BadRequestException("the working session cannot be renamed, saved as, or deleted");
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
