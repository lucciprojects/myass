const TABLE = (() => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value =
        value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
})();

export function crc32Init(): number {
  return 0xffffffff;
}

export function crc32Update(state: number, bytes: Buffer): number {
  let crc = state;

  for (let index = 0; index < bytes.length; index += 1) {
    crc = TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }

  return crc >>> 0;
}

export function crc32Final(state: number): number {
  return (state ^ 0xffffffff) >>> 0;
}

export function crc32(bytes: Buffer): number {
  return crc32Final(crc32Update(crc32Init(), bytes));
}
