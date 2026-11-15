// Lossless project audio: 48 kHz mono, 32-bit IEEE float, canonical 44-byte
// header. Chosen over a compressed format so a save is bit-exact and a restore
// cannot drift after repeated load/save cycles. The agent may end up on an ARM
// board, so every field is written explicitly little-endian rather than trusting
// the host's byte order.

const HEADER_BYTES = 44;
const FORMAT_IEEE_FLOAT = 3;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 32;
const BYTES_PER_SAMPLE = 4;

export class InvalidWavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWavError";
  }
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new InvalidWavError(`invalid sample rate: ${sampleRate}`);
  }

  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buffer = Buffer.allocUnsafe(HEADER_BYTES + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(FORMAT_IEEE_FLOAT, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(
    sampleRate * CHANNELS * BYTES_PER_SAMPLE,
    28,
  );
  buffer.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeFloatLE(samples[index], HEADER_BYTES + index * BYTES_PER_SAMPLE);
  }

  return buffer;
}

export function decodeWav(buffer: Buffer): {
  sampleRate: number;
  samples: Float32Array;
} {
  if (buffer.length < HEADER_BYTES) {
    throw new InvalidWavError("file is shorter than a WAV header");
  }

  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new InvalidWavError("missing RIFF marker");
  }

  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new InvalidWavError("missing WAVE marker");
  }

  // A canonical file is exactly one RIFF size and no trailing chunks. Refusing
  // trailing bytes keeps a corrupted download from silently losing audio.
  if (buffer.readUInt32LE(4) !== buffer.length - 8) {
    throw new InvalidWavError("RIFF size does not match the file length");
  }

  if (buffer.toString("ascii", 12, 16) !== "fmt ") {
    throw new InvalidWavError("missing fmt chunk");
  }

  if (buffer.readUInt32LE(16) !== 16) {
    throw new InvalidWavError("fmt chunk is not 16 bytes");
  }

  if (buffer.readUInt16LE(20) !== FORMAT_IEEE_FLOAT) {
    throw new InvalidWavError("only 32-bit IEEE float WAVs are supported");
  }

  if (buffer.readUInt16LE(22) !== CHANNELS) {
    throw new InvalidWavError("only mono WAVs are supported");
  }

  const sampleRate = buffer.readUInt32LE(24);

  if (sampleRate <= 0) {
    throw new InvalidWavError("sample rate must be positive");
  }

  if (buffer.readUInt16LE(34) !== BITS_PER_SAMPLE) {
    throw new InvalidWavError("only 32-bit samples are supported");
  }

  if (buffer.readUInt16LE(32) !== CHANNELS * BYTES_PER_SAMPLE) {
    throw new InvalidWavError("block alignment does not match mono float32");
  }

  if (buffer.toString("ascii", 36, 40) !== "data") {
    throw new InvalidWavError("missing data chunk");
  }

  const dataBytes = buffer.readUInt32LE(40);

  if (dataBytes % BYTES_PER_SAMPLE !== 0) {
    throw new InvalidWavError("data chunk is not a whole number of samples");
  }

  if (HEADER_BYTES + dataBytes !== buffer.length) {
    throw new InvalidWavError("data chunk does not fill the file");
  }

  // Copied into a fresh Float32Array rather than returned as a view on the
  // Buffer: Node may hand back a pooled Buffer with a non-zero byte offset, and
  // a Float32Array view would then reject the alignment.
  const samples = new Float32Array(dataBytes / BYTES_PER_SAMPLE);

  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readFloatLE(HEADER_BYTES + index * BYTES_PER_SAMPLE);
  }

  return { sampleRate, samples };
}
