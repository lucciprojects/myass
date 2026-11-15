import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  EffectSlot,
  LooperLayer,
  LooperState,
} from "@myass/protocol";
import type {
  ControlClient,
  ProjectPayload,
} from "../src/agent/control.client.js";
import {
  emptyManifest,
  InvalidProjectError,
  parseManifest,
  type Manifest,
} from "../src/projects/manifest.js";
import { OperationQueue } from "../src/projects/operation-queue.js";
import {
  ProjectStore,
  type StoredProject,
} from "../src/projects/project.store.js";
import { ProjectsService } from "../src/projects/projects.service.js";
import {
  InvalidWavError,
  decodeWav,
  encodeWav,
} from "../src/projects/wav.js";

const TEMP_ROOT = process.env.MYASS_TEST_TMP ?? "/tmp/opencode";

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(TEMP_ROOT, "myass-projects-"));
}

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  return { ...emptyManifest("working", "Working session"), ...overrides };
}

function layerManifest(
  index: number,
  overrides: Partial<Manifest["layers"][number]> = {},
): Manifest["layers"][number] {
  return {
    index,
    file: `layers/${index}.wav`,
    samples: 100,
    level: 100,
    muted: false,
    playing: true,
    truncated: false,
    chain: { slots: [] },
    revision: 1,
    ...overrides,
  };
}

function layerState(
  index: number,
  samples: number,
  overrides: Partial<LooperLayer> = {},
): LooperLayer {
  return {
    index,
    playing: true,
    recording: false,
    waiting: false,
    muted: false,
    truncated: false,
    chainCurrent: true,
    level: 100,
    seconds: samples / 48000,
    position: 0,
    countdown: 0,
    max: samples / 48000,
    samples,
    revision: 1,
    ...overrides,
  };
}

function baseState(): LooperState {
  return {
    maxSeconds: 32,
    countdownSeconds: 2,
    transportSeconds: 0,
    paused: true,
    sampleRate: 48000,
    bpm: 120,
    beatsPerBar: 4,
    bars: 4,
    click: "countin-record",
    loopSamples: 0,
    revision: 0,
    layers: [],
  };
}

class FakeAgent {
  state: LooperState = baseState();
  audio = new Map<number, Float32Array>();
  chains = new Map<number, EffectSlot[]>();
  board: EffectSlot[] = [];
  dumps: number[] = [];
  loads: ProjectPayload[] = [];

  isConnected(): boolean {
    return true;
  }

  async getLooper(): Promise<LooperState> {
    return structuredClone(this.state);
  }

  async dumpLayer(layer: number): Promise<Float32Array> {
    this.dumps.push(layer);
    const samples = this.audio.get(layer);

    if (!samples) {
      throw new Error(`no fake audio for layer ${layer}`);
    }

    return samples;
  }

  async getLayerChain(layer: number): Promise<EffectSlot[]> {
    return this.chains.get(layer) ?? [];
  }

  async getChain(): Promise<{ slots: EffectSlot[] }> {
    return { slots: this.board };
  }

  async loadProject(project: ProjectPayload): Promise<void> {
    this.loads.push(project);

    const previous = this.state;

    this.state = {
      ...previous,
      paused: true,
      bpm: project.bpm,
      beatsPerBar: project.beatsPerBar,
      bars: project.bars,
      click: project.click,
      loopSamples: project.loopSamples,
      transportSeconds: project.loopSamples / 48000,
      revision: previous.revision + 1,
      layers: project.layers.map((layer) => {
        const samples = layer.samples.length;

        return layerState(layer.index, samples, {
          level: layer.level,
          muted: layer.muted,
          playing: layer.playing,
          truncated: layer.truncated,
          revision: 1,
        });
      }),
    };
  }
}

function setContent(
  agent: FakeAgent,
  revision: number,
  entries: Array<{
    index: number;
    samples: Float32Array;
    revision?: number;
    level?: number;
  }>,
): void {
  const loopSamples = entries[0]?.samples.length ?? 0;

  agent.state = {
    ...agent.state,
    revision,
    loopSamples,
    transportSeconds: loopSamples / 48000,
    layers: entries.map((entry) =>
      layerState(entry.index, entry.samples.length, {
        revision: entry.revision ?? 1,
        level: entry.level ?? 100,
      }),
    ),
  };

  for (const entry of entries) {
    agent.audio.set(entry.index, entry.samples);
  }
}

function samplesOf(length: number, start = 0): Float32Array {
  return Float32Array.from({ length }, (_, index) => start + index / length);
}

test("wav round-trips float32 samples exactly", () => {
  for (const length of [0, 1, 1000, 384000]) {
    const source = samplesOf(length);

    if (length > 0) {
      source[0] = -0;
    }

    if (length > 1) {
      source[1] = 1.401298464324817e-45;
    }

    const decoded = decodeWav(encodeWav(source, 48000));

    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.samples.length, length);

    for (let index = 0; index < length; index += 1) {
      assert.ok(
        Object.is(decoded.samples[index], source[index]),
        `sample ${index} differs at length ${length}`,
      );
    }
  }
});

test("wav decoder rejects non-mono and non-float files", () => {
  const source = samplesOf(16);
  const stereo = Buffer.from(encodeWav(source, 48000));
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => decodeWav(stereo), InvalidWavError);

  const sixteenBit = Buffer.from(encodeWav(source, 48000));
  sixteenBit.writeUInt16LE(16, 34);
  assert.throws(() => decodeWav(sixteenBit), InvalidWavError);

  const trailing = Buffer.concat([encodeWav(source, 48000), Buffer.from([0])]);
  assert.throws(() => decodeWav(trailing), InvalidWavError);

  assert.throws(() => decodeWav(Buffer.from("not a wav")), InvalidWavError);
});

test("manifest rejects old versions, missing fields, and escaping paths", () => {
  const base = manifest({ layers: [layerManifest(0)] });

  assert.throws(
    () => parseManifest({ ...base, version: 2 }),
    InvalidProjectError,
  );

  const { name: _dropped, ...withoutName } = base;
  assert.throws(() => parseManifest(withoutName), InvalidProjectError);

  assert.throws(
    () =>
      parseManifest({
        ...base,
        layers: [layerManifest(0, { file: "../0.wav" })],
      }),
    InvalidProjectError,
  );

  const sorted = parseManifest({
    ...base,
    layers: [layerManifest(1), layerManifest(0)],
  });
  assert.deepEqual(
    sorted.layers.map((layer) => layer.index),
    [0, 1],
  );
});

test("store leaves the previous project intact when a write fails mid-way", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const id = randomUUID();
  const good: StoredProject = {
    manifest: manifest({
      id,
      name: "Good",
      loopSamples: 4,
      layers: [layerManifest(0, { samples: 4 })],
    }),
    layers: new Map([[0, Float32Array.from([1, 2, 3, 4])]]),
  };

  await store.write(good);

  // Layer 1 is in the manifest but has no audio, so staging fails after layer
  // 0 has already been written. The old directory must survive.
  await assert.rejects(
    store.write({
      manifest: {
        ...good.manifest,
        layers: [
          layerManifest(0, { samples: 4 }),
          layerManifest(1, { samples: 4 }),
        ],
      },
      layers: new Map([[0, Float32Array.from([9, 9, 9, 9])]]),
    }),
    InvalidProjectError,
  );

  const after = await store.read(id);
  assert.deepEqual([...after.layers.get(0)!], [1, 2, 3, 4]);

  const entries = await readdir(root);
  assert.equal(
    entries.filter((entry) => entry.startsWith(".staging-")).length,
    0,
  );

  await rm(root, { recursive: true, force: true });
});

test("auto-save dumps only layers whose audio changed", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const agent = new FakeAgent();
  const projects = new ProjectsService(
    agent as unknown as ControlClient,
    store,
  );

  await projects.initialize();

  const first = samplesOf(100);
  setContent(agent, 1, [{ index: 0, samples: first, revision: 1 }]);
  await projects.autosave();
  assert.deepEqual(agent.dumps, [0]);

  let working = await store.readManifest("working");
  assert.equal(working.layers[0].samples, 100);
  assert.equal(working.layers[0].level, 100);

  // A level change bumps the global revision but not the layer revision: the
  // manifest is rewritten, the audio is not dumped again.
  agent.state.layers[0].level = 40;
  agent.state.revision = 2;
  await projects.autosave();
  assert.deepEqual(agent.dumps, [0]);

  working = await store.readManifest("working");
  assert.equal(working.layers[0].level, 40);

  // A second layer appears: only it is dumped.
  const second = samplesOf(100, 1);
  agent.state.layers = [
    layerState(0, 100, { revision: 1, level: 40 }),
    layerState(1, 100, { revision: 1 }),
  ];
  agent.audio.set(1, second);
  agent.state.revision = 3;
  agent.state.loopSamples = 100;
  await projects.autosave();

  assert.deepEqual(agent.dumps, [0, 1]);
  working = await store.readManifest("working");
  assert.deepEqual(
    working.layers.map((layer) => layer.index),
    [0, 1],
  );

  await rm(root, { recursive: true, force: true });
});

test("clear-all empties the working session", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const agent = new FakeAgent();
  const projects = new ProjectsService(
    agent as unknown as ControlClient,
    store,
  );

  await projects.initialize();
  setContent(agent, 1, [{ index: 0, samples: samplesOf(4), revision: 1 }]);
  await projects.autosave();

  agent.state = { ...agent.state, layers: [], loopSamples: 0, revision: 2 };
  await projects.autosave();

  const working = await store.readManifest("working");
  assert.equal(working.layers.length, 0);
  assert.equal(working.loopSamples, 0);
  assert.deepEqual(await readdir(path.join(root, "working", "layers")), []);

  await rm(root, { recursive: true, force: true });
});

test("restore loads a non-empty working session into an empty agent", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);

  await store.createWorkingIfMissing();
  await store.write({
    manifest: manifest({
      loopSamples: 4,
      revision: 1,
      layers: [layerManifest(0, { samples: 4 })],
    }),
    layers: new Map([[0, Float32Array.from([0.1, 0.2, 0.3, 0.4])]]),
  });

  const agent = new FakeAgent();
  const projects = new ProjectsService(
    agent as unknown as ControlClient,
    store,
  );

  await projects.initialize();

  assert.equal(agent.loads.length, 1);
  assert.equal(agent.loads[0].loopSamples, 4);
  assert.equal(agent.state.layers[0].samples, 4);
  assert.equal(agent.state.paused, true);
  assert.equal(projects.isReady(), true);

  await rm(root, { recursive: true, force: true });
});

test("restore backs up and adopts a non-empty agent", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);

  await store.createWorkingIfMissing();
  await store.write({
    manifest: manifest({
      loopSamples: 4,
      revision: 1,
      layers: [layerManifest(0, { samples: 4 })],
    }),
    layers: new Map([[0, Float32Array.from([1, 1, 1, 1])]]),
  });

  const agent = new FakeAgent();
  setContent(agent, 5, [
    { index: 0, samples: Float32Array.from([9, 9, 9, 9]), revision: 5 },
  ]);

  const projects = new ProjectsService(
    agent as unknown as ControlClient,
    store,
  );

  await projects.initialize();

  assert.equal(agent.loads.length, 0);

  const entries = await readdir(root);
  assert.ok(
    entries.some((entry) => entry.startsWith("working-backup-")),
    "expected the previous working session to be backed up",
  );

  const working = await store.read("working");
  assert.deepEqual([...working.layers.get(0)!], [9, 9, 9, 9]);

  // The backup is a real project directory, not just an empty marker.
  const backup = entries.find((entry) => entry.startsWith("working-backup-"))!;
  const backupManifest = await readFile(
    path.join(root, backup, "manifest.json"),
    "utf8",
  );
  assert.match(backupManifest, /myass-project/);

  await rm(root, { recursive: true, force: true });
});

test("operation queue serializes concurrent work", async () => {
  const queue = new OperationQueue();
  const order: string[] = [];

  const first = queue.run("save", async () => {
    order.push("save-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("save-end");
  });
  const second = queue.run("load", async () => {
    order.push("load");
  });

  await Promise.all([first, second]);
  assert.deepEqual(order, ["save-start", "save-end", "load"]);

  await assert.rejects(
    queue.run("autosave", async () => {
      throw new Error("boom");
    }),
  );
  await queue.run("save", async () => {
    order.push("recovered");
  });
  assert.equal(order.at(-1), "recovered");
});
