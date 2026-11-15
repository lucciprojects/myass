export type BundleErrorCode =
  | "bad_zip"
  | "bad_crc"
  | "bad_manifest"
  | "bad_wav"
  | "too_large"
  | "extra_entry";

/** A rejected import. The code is part of the API response, not just a log. */
export class InvalidBundleError extends Error {
  constructor(
    readonly code: BundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "InvalidBundleError";
  }
}
