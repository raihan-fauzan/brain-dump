// Minimal ZIP writer: store-only (no compression), UTF-8 names.
// Emits a standard archive readable by any unzip tool / OS file manager.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  push(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  u16(v) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.push(b);
  }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

/**
 * Build a ZIP archive.
 * @param {{name: string, data: string|Uint8Array, date?: Date}[]} files
 * @returns {Uint8Array}
 */
export function createZip(files, date = new Date()) {
  const { time, date: dosDate } = dosDateTime(date);
  const local = new Writer();
  const central = new Writer();
  const entries = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = typeof file.data === "string" ? enc.encode(file.data) : file.data;
    const crc = crc32(data);
    const localOffset = offset;

    // local file header
    const lh = new Writer();
    lh.u32(0x04034b50);
    lh.u16(20);        // version needed
    lh.u16(0x0800);    // UTF-8 names
    lh.u16(0);         // stored
    lh.u16(time);
    lh.u16(dosDate);
    lh.u32(crc);
    lh.u32(data.length);
    lh.u32(data.length);
    lh.u16(nameBytes.length);
    lh.u16(0);         // extra len
    lh.push(nameBytes);
    lh.push(data);

    local.push(lh.bytes());
    offset += lh.length;

    central.u32(0x02014b50);
    central.u16(20);   // version made by
    central.u16(20);   // version needed
    central.u16(0x0800);
    central.u16(0);
    central.u16(time);
    central.u16(dosDate);
    central.u32(crc);
    central.u32(data.length);
    central.u32(data.length);
    central.u16(nameBytes.length);
    central.u16(0);    // extra
    central.u16(0);    // comment
    central.u16(0);    // disk start
    central.u16(0);    // internal attrs
    central.u32(0);    // external attrs
    central.u32(localOffset);
    central.push(nameBytes);

    entries.push({ name: file.name, size: data.length });
  }

  const cd = central.bytes();
  const eocd = new Writer();
  eocd.u32(0x06054b50);
  eocd.u16(0);
  eocd.u16(0);
  eocd.u16(files.length);
  eocd.u16(files.length);
  eocd.u32(cd.length);
  eocd.u32(offset);
  eocd.u16(0);

  const out = new Uint8Array(offset + cd.length + eocd.length);
  out.set(local.bytes(), 0);
  out.set(cd, offset);
  out.set(eocd.bytes(), offset + cd.length);
  return out;
}

/** Zip filename stamped with local date. */
export function exportFilename(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `brain-dump-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.zip`;
}

// ---------- reading ----------

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const MAX_ENTRY_BYTES = 10 * 1024 * 1024;

/** Locate the end-of-central-directory record, scanning backwards. */
function findEocd(view) {
  const min = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress ZIP entries (use uncompressed archives).");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a ZIP archive. Supports stored (0) and deflate (8) entries.
 * @param {Uint8Array} bytes
 * @returns {Promise<{name: string, data: Uint8Array}[]>}
 */
export async function readZip(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22) {
    throw new Error("That file is not a ZIP archive.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd === -1) throw new Error("That file is not a ZIP archive.");

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported. Try a smaller archive.");
  }

  const decoder = new TextDecoder();
  const files = [];
  let p = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CD_SIG) break;

    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // directory entry
    if (localOffset + 30 > view.byteLength) continue;

    // The local header repeats the name/extra lengths, which may differ.
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compressedSize > bytes.byteLength) {
      throw new Error(`Archive is truncated (${name}).`);
    }

    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      files.push({ name, data: raw });
    } else if (method === 8) {
      const inflated = await inflateRaw(raw);
      if (inflated.byteLength > MAX_ENTRY_BYTES) {
        throw new Error(`Entry too large to import: ${name}`);
      }
      files.push({ name, data: inflated });
    }
    // Other methods (bzip2, zstd...) are skipped rather than guessed at.
  }

  return files;
}
