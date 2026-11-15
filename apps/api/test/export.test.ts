import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import type { EffectSlot } from "@myass/protocol";
import {
  AgentUnavailableError,
  type ControlClient,
} from "../src/agent/control.client.js";
import { BundleService } from "../src/projects/bundle.service.js";
import { ExportService } from "../src/projects/export.service.js";
import {
  emptyManifest,
  type Manifest,
} from "../src/projects/manifest.js";
import { mixdown } from "../src/projects/mixdown.js";
import { OperationQueue } from "../src/projects/operation-queue.js";
import { ProjectStore } from "../src/projects/project.store.js";
import { decodeWav } from "../src/projects/wav.js";
import { crc32 } from "../src/zip/crc32.js";
import { InvalidBundleError } from "../src/zip/errors.js";
import { MAX_BUNDLE_BYTES, readZip } from "../src/zip/zip-reader.js";
import {
  writeZip,
  type ZipEntrySource,
} from "../src/zip/zip-writer.js";

const TEMP_ROOT = process.env.MYASS_TEST_TMP ?? "/tmp/opencode";
const LOCAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CENTRAL_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(TEMP_ROOT, "myass-export-"));
}

function bufferEntry(name: string, data: Buffer): ZipEntrySource {
  return {
    name,
    size: data.length,
    mtime: new Date("2024-01-02T03:04:06Z"),
    open: () => Readable.from([data]),
  };
}

function firstSignature(buffer: Buffer, signature: Buffer): number {
  const offset = buffer.indexOf(signature);
  assert.notEqual(offset, -1, "signature not found");
  return offset;
}

function patchAll(buffer: Buffer, from: string, to: string): void {
  const fromBuffer = Buffer.from(from);
  const toBuffer = Buffer.from(to);
  assert.equal(fromBuffer.length, toBuffer.length);

  let offset = buffer.indexOf(fromBuffer);
  let replacements = 0;

  while (offset !== -1) {
    toBuffer.copy(buffer, offset);
    replacements += 1;
    offset = buffer.indexOf(fromBuffer, offset + toBuffer.length);
  }

  assert.ok(replacements >= 2, "expected local and central names");
}

async function zipBuffer(
  root: string,
  entries: ZipEntrySource[],
): Promise<Buffer> {
  const zipPath = path.join(root, `${randomUUID()}.zip`);
  await writeZip(zipPath, entries);
  return readFile(zipPath);
}

function layerManifest(
  index: number,
  samples: number,
  overrides: Partial<Manifest["layers"][number]> = {},
): Manifest["layers"][number] {
  return {
    index,
    file: `layers/${index}.wav`,
    samples,
    level: 100,
    muted: false,
    playing: true,
    truncated: false,
    chain: { slots: [] },
    revision: 1,
    ...overrides,
  };
}

interface SeedLayer {
  samples: Float32Array;
  level?: number;
  muted?: boolean;
}

async function seedProject(
  store: ProjectStore,
  layers: SeedLayer[],
  options: { name?: string; bpm?: number; bars?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const loopSamples = layers[0]?.samples.length ?? 0;
  const manifest: Manifest = {
    ...emptyManifest(id, options.name ?? "Song"),
    bpm: options.bpm ?? 120,
    bars: options.bars ?? 4,
    loopSamples,
    layers: layers.map((layer, index) =>
      layerManifest(index, layer.samples.length, {
        level: layer.level ?? 100,
        muted: layer.muted ?? false,
      }),
    ),
  };

  await store.write({
    manifest,
    layers: new Map(layers.map((layer, index) => [index, layer.samples])),
  });

  return id;
}

class FakeRenderer {
  calls = 0;

  constructor(
    private readonly gain = 0.5,
    private readonly fail = false,
  ) {}

  async renderChain(
    _slots: EffectSlot[],
    pcm: Float32Array,
  ): Promise<Float32Array> {
    this.calls += 1;

    if (this.fail) {
      throw new AgentUnavailableError("no agent at 127.0.0.1:3002");
    }

    return Float32Array.from(pcm, (value) => value * this.gain);
  }
}

async function waitForGone(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(file);
    } catch {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail(`temp file was not deleted: ${file}`);
}

test("zip writer and reader round-trip binary entries", async () => {
  const root = await tempDirectory();
  const payload = Buffer.from([0x00, 0xff, 0x00, 0x01, 0x80]);
  const text = Buffer.from("hello");
  const empty = Buffer.alloc(0);
  const zipPath = path.join(root, "roundtrip.zip");

  await writeZip(zipPath, [
    bufferEntry("a.bin", payload),
    bufferEntry("dir/b.txt", text),
    bufferEntry("empty", empty),
  ]);

  const files = readZip(await readFile(zipPath));

  assert.deepEqual(
    files.map((file) => file.name),
    ["a.bin", "dir/b.txt", "empty"],
  );
  assert.equal(files[0].crc32, crc32(payload));
  assert.deepEqual([...files[0].read()], [...payload]);
  assert.equal(files[1].read().toString("utf8"), "hello");
  assert.equal(files[2].read().length, 0);

  await rm(root, { recursive: true, force: true });
});

test("zip reader rejects malformed archives", async () => {
  const root = await tempDirectory();
  const valid = await zipBuffer(root, [
    bufferEntry("hello.txt", Buffer.from("hello")),
  ]);

  const compressed = Buffer.from(valid);
  const compressedCentral = firstSignature(compressed, CENTRAL_SIGNATURE);
  compressed.writeUInt16LE(8, compressedCentral + 10);
  assert.throws(
    () => readZip(compressed),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_zip",
  );

  const escaped = await zipBuffer(root, [
    bufferEntry("ab/cd/ef", Buffer.from("hello")),
  ]);
  patchAll(escaped, "ab/cd/ef", "../../ef");
  assert.throws(
    () => readZip(escaped),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_zip",
  );

  const absolute = await zipBuffer(root, [
    bufferEntry("ab/cd.txt", Buffer.from("hello")),
  ]);
  patchAll(absolute, "ab/cd.txt", "/b/cd.txt");
  assert.throws(
    () => readZip(absolute),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_zip",
  );

  const backslash = await zipBuffer(root, [
    bufferEntry("a/b.txt", Buffer.from("hello")),
  ]);
  patchAll(backslash, "a/b.txt", "a\\b.txt");
  assert.throws(
    () => readZip(backslash),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_zip",
  );

  const duplicates = await zipBuffer(root, [
    bufferEntry("same.txt", Buffer.from("one")),
    bufferEntry("same.txt", Buffer.from("two")),
  ]);
  assert.throws(
    () => readZip(duplicates),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_zip",
  );

  const badCrc = await zipBuffer(root, [
    bufferEntry("hello.txt", Buffer.from("hello")),
  ]);
  const badCrcCentral = firstSignature(badCrc, CENTRAL_SIGNATURE);
  badCrc.writeUInt32LE(0, badCrcCentral + 16);
  const [badFile] = readZip(badCrc);
  assert.throws(
    () => badFile.read(),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_crc",
  );

  const oversized = await zipBuffer(root, [
    bufferEntry("hello.txt", Buffer.from("hello")),
  ]);
  const oversizedCentral = firstSignature(oversized, CENTRAL_SIGNATURE);
  const huge = MAX_BUNDLE_BYTES + 1;
  oversized.writeUInt32LE(huge, oversizedCentral + 20);
  oversized.writeUInt32LE(huge, oversizedCentral + 24);
  assert.throws(
    () => readZip(oversized),
    (error) =>
      error instanceof InvalidBundleError && error.code === "too_large",
  );

  const tooMany = await zipBuffer(
    root,
    Array.from({ length: 65 }, (_, index) =>
      bufferEntry(`f${index}.txt`, Buffer.from("x")),
    ),
  );
  assert.throws(
    () => readZip(tooMany),
    (error) =>
      error instanceof InvalidBundleError && error.code === "too_large",
  );

  await rm(root, { recursive: true, force: true });
});

test("bundle export and import preserve the WAV bytes", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const bundle = new BundleService(store, new OperationQueue());
  const id = await seedProject(store, [
    { samples: Float32Array.from([0.1, 0.2, 0.3, 0.4]) },
    { samples: Float32Array.from([1, 0, -1, 0]) },
  ]);
  const zipPath = path.join(root, "bundle.zip");

  await bundle.exportToZip(id, zipPath);
  const files = readZip(await readFile(zipPath));

  assert.deepEqual(
    files.map((file) => file.name),
    ["manifest.json", "layers/0.wav", "layers/1.wav"],
  );

  const imported = await bundle.importFromZip(await readFile(zipPath));
  assert.notEqual(imported.id, id);

  const original = await store.read(id);
  const roundTrip = await store.read(imported.id);

  for (const index of [0, 1]) {
    assert.deepEqual(
      [...roundTrip.layers.get(index)!],
      [...original.layers.get(index)!],
    );
  }

  const manifest = await store.readManifest(imported.id);
  assert.equal(manifest.name, "Song");
  assert.equal(manifest.loopSamples, 4);
  assert.equal(manifest.linkedProjectId, null);
  assert.equal(manifest.revision, 0);

  await rm(root, { recursive: true, force: true });
});

test("bundle import rejects a mismatched loop length", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const bundle = new BundleService(store, new OperationQueue());
  const id = await seedProject(store, [
    { samples: Float32Array.from([0.1, 0.2, 0.3, 0.4]) },
  ]);
  const zipPath = path.join(root, "bundle.zip");

  await bundle.exportToZip(id, zipPath);

  const files = readZip(await readFile(zipPath));
  const originalManifest = JSON.parse(
    files
      .find((file) => file.name === "manifest.json")!
      .read()
      .toString("utf8"),
  );
  originalManifest.loopSamples = 5;
  const manifestBytes = Buffer.from(
    JSON.stringify(originalManifest, null, 2),
  );

  const badPath = path.join(root, "bad.zip");
  await writeZip(
    badPath,
    files.map((file) => ({
      name: file.name,
      size: file.name === "manifest.json" ? manifestBytes.length : file.size,
      mtime: new Date("2024-01-01T00:00:00Z"),
      open: () =>
        Readable.from([
          file.name === "manifest.json" ? manifestBytes : file.read(),
        ]),
    })),
  );

  await assert.rejects(
    bundle.importFromZip(await readFile(badPath)),
    (error) =>
      error instanceof InvalidBundleError && error.code === "bad_manifest",
  );

  await rm(root, { recursive: true, force: true });
});

test("mixdown applies levels, mute, peaks, and zero padding", () => {
  const result = mixdown(
    [
      {
        samples: Float32Array.from([0.5, 0.5, 0.5, 0.5]),
        level: 50,
        muted: false,
      },
      { samples: Float32Array.from([1, 1]), level: 100, muted: true },
      {
        samples: Float32Array.from([0.25, 0.25, 0.25, 0.25]),
        level: 100,
        muted: false,
      },
    ],
    4,
  );

  assert.deepEqual([...result.mix], [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual(result.peaks, [0.5, 1, 0.25]);
});

test("FL export writes the expected stems, mix, manifest, and README", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const queue = new OperationQueue();
  const bundle = new BundleService(store, queue);
  const renderer = new FakeRenderer(0.5);
  const exporter = new ExportService(
    renderer as unknown as ControlClient,
    store,
    queue,
    bundle,
  );
  const id = await seedProject(
    store,
    [
      { samples: Float32Array.from([1, 0.5, 0.25, 0]), level: 100 },
      { samples: Float32Array.from([0.5, 0.5, 0.5, 0.5]), level: 50 },
    ],
    { name: "My Song" },
  );

  const download = await exporter.download(id, "fl");
  const files = readZip(await readFile(download.zipPath));
  const byName = new Map(files.map((file) => [file.name, file]));

  assert.deepEqual(
    files.map((file) => file.name),
    [
      "manifest.json",
      "README.txt",
      "stems-processed/01-layer-1.wav",
      "stems-processed/02-layer-2.wav",
      "stems-dry/01-layer-1.wav",
      "stems-dry/02-layer-2.wav",
      "mix.wav",
    ],
  );

  const processed = decodeWav(
    byName.get("stems-processed/01-layer-1.wav")!.read(),
  ).samples;
  const dry = decodeWav(
    byName.get("stems-dry/02-layer-2.wav")!.read(),
  ).samples;
  const mix = decodeWav(byName.get("mix.wav")!.read()).samples;

  assert.deepEqual([...processed], [0.5, 0.25, 0.125, 0]);
  assert.deepEqual([...dry], [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual([...mix], [0.625, 0.375, 0.25, 0.125]);

  for (const file of files) {
    if (file.name.endsWith(".wav")) {
      assert.equal(decodeWav(file.read()).samples.length, 4);
    }
  }

  const exportManifest = JSON.parse(
    byName.get("manifest.json")!.read().toString("utf8"),
  );
  assert.equal(exportManifest.format, "myass-fl-export");
  assert.equal(exportManifest.layers.length, 2);
  assert.equal(exportManifest.loopSamples, 4);

  const readme = byName.get("README.txt")!.read().toString("utf8");
  assert.match(readme, /MYASS export - My Song/);
  assert.match(readme, /Tempo: 120 BPM, 4\/4, 4 bars/);

  const closed = once(download.stream, "close");
  download.stream.destroy();
  await closed;
  await waitForGone(download.zipPath);

  await rm(root, { recursive: true, force: true });
});

test("FL export fails without an agent while bundle export still works", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const queue = new OperationQueue();
  const bundle = new BundleService(store, queue);
  const exporter = new ExportService(
    new FakeRenderer(0.5, true) as unknown as ControlClient,
    store,
    queue,
    bundle,
  );
  const id = await seedProject(store, [
    { samples: Float32Array.from([1, 0, 0.5, 0]) },
  ]);

  await assert.rejects(
    exporter.download(id, "fl"),
    (error) => error instanceof AgentUnavailableError,
  );

  const download = await exporter.download(id, "bundle");
  assert.ok(download.size > 0);

  const closed = once(download.stream, "close");
  download.stream.destroy();
  await closed;
  await waitForGone(download.zipPath);

  await rm(root, { recursive: true, force: true });
});

test("temp ZIP is deleted when the download stream closes", async () => {
  const root = await tempDirectory();
  const store = new ProjectStore(root);
  const queue = new OperationQueue();
  const bundle = new BundleService(store, queue);
  const exporter = new ExportService(
    new FakeRenderer() as unknown as ControlClient,
    store,
    queue,
    bundle,
  );
  const id = await seedProject(store, [
    { samples: Float32Array.from([0.25, 0.5, 0.25, 0]) },
  ]);

  const download = await exporter.download(id, "bundle");
  const closed = once(download.stream, "close");

  download.stream.destroy();
  await closed;
  await waitForGone(download.zipPath);

  await rm(root, { recursive: true, force: true });
});
