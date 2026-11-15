import { crc32 } from "./crc32.js";
import { InvalidBundleError } from "./errors.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_UINT32 = 0xffffffff;

export const MAX_BUNDLE_BYTES = 96 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 64;

export interface ZipFile {
  name: string;
  size: number;
  crc32: number;
  read(): Buffer;
}

function bad(message: string, code: "bad_zip" | "too_large" = "bad_zip") {
  return new InvalidBundleError(code, message);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < 22) {
    throw bad("file is too short to be a ZIP archive");
  }

  const earliest = Math.max(0, buffer.length - 22 - 0xffff);

  for (let offset = buffer.length - 22; offset >= earliest; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) {
      continue;
    }

    const commentLength = buffer.readUInt16LE(offset + 20);

    if (offset + 22 + commentLength === buffer.length) {
      return offset;
    }
  }

  throw bad("end of central directory not found");
}

function assertEntryName(name: string): void {
  if (name.length === 0) {
    throw bad("ZIP entry has an empty name");
  }

  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw bad(`ZIP entry is not a relative path: ${name}`);
  }

  const segments = name.split("/");

  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw bad(`ZIP entry has an unsafe segment: ${name}`);
  }
}

/**
 * Parses a store-only ZIP held in memory. Bundles are capped at 96 MB, so the
 * simple synchronous reader is enough and keeps the import path free of
 * temporary extraction directories.
 */
export function readZip(buffer: Buffer): ZipFile[] {
  const eocd = findEndOfCentralDirectory(buffer);

  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const totalEntries = buffer.readUInt16LE(eocd + 10);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw bad("multi-disk archives are not supported");
  }

  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw bad(
      `archive has ${totalEntries} entries, the limit is ${MAX_ZIP_ENTRIES}`,
      "too_large",
    );
  }

  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (centralOffset + centralSize > eocd) {
    throw bad("central directory runs past the end record");
  }

  const centralEnd = centralOffset + centralSize;
  const names = new Set<string>();
  const files: ZipFile[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralEnd) {
      throw bad("central directory is truncated");
    }

    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw bad("bad central directory signature");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    if ((flags & 0x0001) !== 0) {
      throw bad("encrypted ZIP entries are not supported");
    }

    if (method !== 0) {
      throw bad(`ZIP compression method ${method} is not supported`);
    }

    if (
      compressedSize === MAX_UINT32 ||
      uncompressedSize === MAX_UINT32 ||
      localOffset === MAX_UINT32
    ) {
      throw bad("ZIP64 archives are not supported", "too_large");
    }

    if (compressedSize !== uncompressedSize) {
      throw bad("store-only entry has mismatched sizes");
    }

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > centralEnd) {
      throw bad("central directory name runs past the directory");
    }

    const name = buffer.toString("utf8", nameStart, nameEnd);
    assertEntryName(name);

    if (names.has(name)) {
      throw bad(`duplicate ZIP entry: ${name}`);
    }

    names.add(name);

    totalUncompressed += uncompressedSize;

    if (totalUncompressed > MAX_BUNDLE_BYTES) {
      throw bad(
        `archive expands to ${totalUncompressed} bytes, the limit is ${MAX_BUNDLE_BYTES}`,
        "too_large",
      );
    }

    if (localOffset + 30 > centralOffset) {
      throw bad(`local header for ${name} is outside the archive`);
    }

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw bad(`bad local header for ${name}`);
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + uncompressedSize;

    if (dataEnd > centralOffset) {
      throw bad(`data for ${name} runs past the archive`);
    }

    const data = buffer.subarray(dataStart, dataEnd);

    files.push({
      name,
      size: uncompressedSize,
      crc32: crc,
      read(): Buffer {
        if (data.length !== uncompressedSize) {
          throw new InvalidBundleError(
            "bad_zip",
            `${name} is truncated`,
          );
        }

        if (crc32(data) !== crc) {
          throw new InvalidBundleError(
            "bad_crc",
            `${name} failed its checksum`,
          );
        }

        return Buffer.from(data);
      },
    });

    cursor = nameEnd + extraLength + commentLength;
  }

  if (cursor !== centralEnd) {
    throw bad("central directory has trailing data");
  }

  return files;
}
