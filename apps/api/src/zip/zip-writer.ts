import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { crc32Final, crc32Init, crc32Update } from "./crc32.js";

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const VERSION = 20;
// Bit 11 tells every unzip tool that names are UTF-8 rather than CP437.
const UTF8_FLAG = 0x0800;
const MAX_UINT32 = 0xffffffff;

export interface ZipEntrySource {
  name: string;
  size: number;
  mtime?: Date;
  /** Called once to measure and once to write, so it must open a fresh stream. */
  open(): Readable;
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  mtime: Date | undefined;
}

function assertEntryName(name: string): void {
  if (name.length === 0 || name.length > 0xffff) {
    throw new Error(`invalid ZIP entry name: ${name}`);
  }

  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`ZIP entry name must be a relative forward-slash path: ${name}`);
  }

  const segments = name.split("/");

  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`ZIP entry name has an unsafe segment: ${name}`);
  }
}

function dosTimestamp(value: Date | undefined): { time: number; date: number } {
  const date = value && !Number.isNaN(value.getTime()) ? value : new Date(0);

  if (date.getUTCFullYear() < 1980) {
    // 1980-01-01 00:00:00, the earliest representable DOS date.
    return { time: 0, date: (1 << 5) | 1 };
  }

  const year = Math.min(127, date.getUTCFullYear() - 1980);

  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      (date.getUTCSeconds() >> 1),
    date: (year << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }

  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }

  return Buffer.from(chunk as Uint8Array);
}

async function writeFully(output: Writable, bytes: Buffer): Promise<void> {
  if (!output.write(bytes)) {
    await once(output, "drain");
  }
}

/**
 * Writes a store-only ZIP. The first pass measures and checksums every entry;
 * the second writes it. That costs one extra read but keeps sizes and CRCs in
 * the local headers, so no data descriptors are needed and every unzip tool
 * (including FL Studio's browser) sees an ordinary archive.
 */
export async function writeZip(
  zipPath: string,
  entries: ZipEntrySource[],
): Promise<void> {
  for (const entry of entries) {
    assertEntryName(entry.name);

    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_UINT32 - 1
    ) {
      throw new Error(`ZIP entry ${entry.name} is too large`);
    }
  }

  await mkdir(path.dirname(zipPath), { recursive: true });

  const output = createWriteStream(zipPath);

  try {
    let offset = 0;
    const central: CentralEntry[] = [];

    for (const entry of entries) {
      const name = Buffer.from(entry.name, "utf8");
      let state = crc32Init();
      let measured = 0;

      for await (const chunk of entry.open()) {
        const bytes = asBuffer(chunk);
        state = crc32Update(state, bytes);
        measured += bytes.length;
      }

      if (measured !== entry.size) {
        throw new Error(
          `ZIP entry ${entry.name} is ${measured} bytes, expected ${entry.size}`,
        );
      }

      const crc = crc32Final(state);
      const stamp = dosTimestamp(entry.mtime);
      const local = Buffer.alloc(30);

      local.writeUInt32LE(LOCAL_SIGNATURE, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(UTF8_FLAG, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(entry.size, 18);
      local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);

      await writeFully(output, local);
      await writeFully(output, name);

      let written = 0;

      for await (const chunk of entry.open()) {
        const bytes = asBuffer(chunk);
        written += bytes.length;
        await writeFully(output, bytes);
      }

      if (written !== entry.size) {
        throw new Error(
          `ZIP entry ${entry.name} changed size while writing`,
        );
      }

      central.push({
        name,
        crc,
        size: entry.size,
        offset,
        mtime: entry.mtime,
      });
      offset += 30 + name.length + entry.size;
    }

    const centralOffset = offset;

    for (const entry of central) {
      const stamp = dosTimestamp(entry.mtime);
      const header = Buffer.alloc(46);

      header.writeUInt32LE(CENTRAL_SIGNATURE, 0);
      header.writeUInt16LE(VERSION, 4);
      header.writeUInt16LE(VERSION, 6);
      header.writeUInt16LE(UTF8_FLAG, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(entry.offset, 42);

      await writeFully(output, header);
      await writeFully(output, entry.name);
      offset += 46 + entry.name.length;
    }

    const centralSize = offset - centralOffset;

    if (offset > MAX_UINT32 || centralSize > MAX_UINT32) {
      throw new Error("ZIP archive exceeds the 4 GB store-only limit");
    }

    const eocd = Buffer.alloc(22);

    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    eocd.writeUInt16LE(0, 20);

    await writeFully(output, eocd);
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    await rm(zipPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
