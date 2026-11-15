import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ZipEntrySource } from "./zip-writer.js";

/** A ZIP entry backed by a file; each open starts a fresh read stream. */
export async function fileEntry(
  filePath: string,
  name: string,
): Promise<ZipEntrySource> {
  const info = await stat(filePath);

  return {
    name,
    size: info.size,
    mtime: info.mtime,
    open: () => createReadStream(filePath),
  };
}
