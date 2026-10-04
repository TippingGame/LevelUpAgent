/** Small dependency-free ZIP writer (stored entries; PNGs are already compressed). */
export function createSpineZip(
  files: { name: string; data: Uint8Array }[],
): Uint8Array {
  if (files.length > 100) throw new Error("Too many archive entries.");
  const encoder = new TextEncoder(),
    entries: Uint8Array[] = [],
    directory: Uint8Array[] = [],
    names = new Set<string>();
  let offset = 0;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  for (const file of files) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(file.name) ||
      file.name.startsWith("/") ||
      file.name.split("/").some((s) => !s || s === ".." || s === ".") ||
      names.has(file.name)
    )
      throw new Error("Invalid archive filename.");
    names.add(file.name);
    const name = encoder.encode(file.name),
      data = file.data;
    let crc = 0xffffffff;
    for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = new Uint8Array(30 + name.length),
      view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(12, 33, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);
    header.set(name, 30);
    const central = new Uint8Array(46 + name.length),
      cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    entries.push(header, data);
    directory.push(central);
    offset += header.length + data.length;
    if (offset > 64 * 1024 * 1024)
      throw new Error("Spine export exceeds 64 MiB.");
  }
  const size = directory.reduce((sum, d) => sum + d.length, 0),
    end = new Uint8Array(22),
    ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  const output = new Uint8Array(offset + size + 22);
  let cursor = 0;
  for (const bytes of [...entries, ...directory, end]) {
    output.set(bytes, cursor);
    cursor += bytes.length;
  }
  return output;
}
