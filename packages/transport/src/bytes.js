/**
 * Byte helpers shared by transports and protocol drivers.
 * Everything works on Uint8Array, so the code runs unchanged in browsers, Node and Tauri webviews.
 */

/**
 * Normalize any byte-like input to a Uint8Array (copying views so later mutation of the source is harmless).
 * @param {Uint8Array | ArrayBuffer | DataView | ArrayLike<number>} input
 * @returns {Uint8Array}
 */
export function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
  }
  return Uint8Array.from(/** @type {ArrayLike<number>} */ (input), (v) => v & 0xff);
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).toUpperCase().padStart(2, '0'));

/**
 * Uppercase hex string.
 * @param {Uint8Array | ArrayLike<number>} bytes
 * @param {string} [separator]
 */
export function hex(bytes, separator = '') {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && separator) out += separator;
    out += HEX[bytes[i] & 0xff];
  }
  return out;
}

/** Hex of a single byte, `0x` prefixed. */
export function hexByte(value) {
  return '0x' + HEX[value & 0xff];
}

/**
 * Parse hex text. Accepts spaces, commas, colons, newlines and `0x` prefixes.
 * @param {string} text
 * @returns {Uint8Array}
 */
export function fromHex(text) {
  const clean = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '');
  if (clean.length % 2 !== 0) throw new Error('Hex string has an odd number of digits');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * @param {...(Uint8Array | ArrayLike<number>)} parts
 * @returns {Uint8Array}
 */
export function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** @param {ArrayLike<number>} a @param {ArrayLike<number>} b */
export function equals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {ArrayLike<number>} bytes
 * @param {ArrayLike<number>} prefix
 * @param {number} [offset]
 */
export function startsWith(bytes, prefix, offset = 0) {
  if (bytes.length - offset < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[offset + i] !== prefix[i]) return false;
  return true;
}

/**
 * Find a byte pattern.
 * @param {ArrayLike<number>} bytes
 * @param {ArrayLike<number>} pattern
 * @param {number} [from]
 * @returns {number} index or -1
 */
export function indexOf(bytes, pattern, from = 0) {
  const last = bytes.length - pattern.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    for (let j = 0; j < pattern.length; j++) if (bytes[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Classic hexdump: offset, hex bytes, printable ASCII.
 * @param {Uint8Array} bytes
 * @param {number} [width]
 * @returns {string}
 */
export function hexdump(bytes, width = 16) {
  const lines = [];
  for (let off = 0; off < bytes.length; off += width) {
    const row = bytes.subarray(off, off + width);
    const h = hex(row, ' ').padEnd(width * 3 - 1, ' ');
    let a = '';
    for (const b of row) a += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    lines.push(`${off.toString(16).toUpperCase().padStart(4, '0')}  ${h}  ${a}`);
  }
  return lines.join('\n');
}

function check(bytes, offset, size) {
  if (offset < 0 || offset + size > bytes.length) {
    throw new RangeError(`Read of ${size} byte(s) at offset ${offset} is outside a ${bytes.length}-byte frame`);
  }
}

/** @param {Uint8Array} b @param {number} o */
export const u8 = (b, o) => (check(b, o, 1), b[o]);
/** @param {Uint8Array} b @param {number} o */
export const i8 = (b, o) => (check(b, o, 1), (b[o] << 24) >> 24);
/** @param {Uint8Array} b @param {number} o */
export const u16le = (b, o) => (check(b, o, 2), b[o] | (b[o + 1] << 8));
/** @param {Uint8Array} b @param {number} o */
export const u16be = (b, o) => (check(b, o, 2), (b[o] << 8) | b[o + 1]);
/** @param {Uint8Array} b @param {number} o */
export const i16le = (b, o) => (u16le(b, o) << 16) >> 16;
/** @param {Uint8Array} b @param {number} o */
export const i16be = (b, o) => (u16be(b, o) << 16) >> 16;
/** @param {Uint8Array} b @param {number} o */
export const u32le = (b, o) => (check(b, o, 4), (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
/** @param {Uint8Array} b @param {number} o */
export const u32be = (b, o) => (check(b, o, 4), ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
/** @param {Uint8Array} b @param {number} o */
export const i32le = (b, o) => u32le(b, o) | 0;
/** @param {Uint8Array} b @param {number} o */
export const i32be = (b, o) => u32be(b, o) | 0;

/**
 * Decode an ASCII/Latin-1 string, stopping at the first NUL and trimming whitespace.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} len
 */
export function ascii(b, o, len) {
  check(b, o, len);
  let s = '';
  for (let i = o; i < o + len; i++) {
    if (b[i] === 0) break;
    s += String.fromCharCode(b[i]);
  }
  return s.trim();
}

/**
 * Encode a string into a fixed-size zero-padded ASCII field.
 * @param {string} text
 * @param {number} size
 */
export function asciiBytes(text, size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < Math.min(size, text.length); i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** @param {Uint8Array} b @param {number} o @param {number} v */
export function setU16le(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}
/** @param {Uint8Array} b @param {number} o @param {number} v */
export function setU16be(b, o, v) {
  b[o] = (v >>> 8) & 0xff;
  b[o + 1] = v & 0xff;
}
/** @param {Uint8Array} b @param {number} o @param {number} v */
export function setU32le(b, o, v) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
/** @param {Uint8Array} b @param {number} o @param {number} v */
export function setU32be(b, o, v) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

/**
 * Sequential reader with a cursor, for protocols whose layout depends on earlier fields.
 */
export class ByteReader {
  /** @param {Uint8Array} bytes @param {number} [offset] */
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }
  get remaining() {
    return this.bytes.length - this.offset;
  }
  /** @param {number} n */
  skip(n) {
    check(this.bytes, this.offset, n);
    this.offset += n;
    return this;
  }
  u8() {
    const v = u8(this.bytes, this.offset);
    this.offset += 1;
    return v;
  }
  i8() {
    const v = i8(this.bytes, this.offset);
    this.offset += 1;
    return v;
  }
  u16le() {
    const v = u16le(this.bytes, this.offset);
    this.offset += 2;
    return v;
  }
  u16be() {
    const v = u16be(this.bytes, this.offset);
    this.offset += 2;
    return v;
  }
  i16le() {
    const v = i16le(this.bytes, this.offset);
    this.offset += 2;
    return v;
  }
  i16be() {
    const v = i16be(this.bytes, this.offset);
    this.offset += 2;
    return v;
  }
  u32le() {
    const v = u32le(this.bytes, this.offset);
    this.offset += 4;
    return v;
  }
  u32be() {
    const v = u32be(this.bytes, this.offset);
    this.offset += 4;
    return v;
  }
  i32le() {
    const v = i32le(this.bytes, this.offset);
    this.offset += 4;
    return v;
  }
  i32be() {
    const v = i32be(this.bytes, this.offset);
    this.offset += 4;
    return v;
  }
  /** @param {number} n */
  take(n) {
    check(this.bytes, this.offset, n);
    const v = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  /** @param {number} n */
  ascii(n) {
    const v = ascii(this.bytes, this.offset, n);
    this.offset += n;
    return v;
  }
}

/** Base UUID suffix used to expand 16-bit and 32-bit Bluetooth UUIDs. */
const BLE_BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/**
 * Canonical 128-bit lowercase Bluetooth UUID string (same result as `BluetoothUUID.canonicalUUID`).
 * @param {number | string} uuid 16/32-bit number, short hex string ("ffe0", "0xFFE0") or full UUID
 * @returns {string}
 */
export function canonicalUuid(uuid) {
  if (typeof uuid === 'number') return (uuid >>> 0).toString(16).padStart(8, '0') + BLE_BASE_SUFFIX;
  const s = uuid.trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s) || /^[0-9a-f]{8}$/.test(s)) return s.padStart(8, '0') + BLE_BASE_SUFFIX;
  return s;
}

/**
 * Short form of a canonical UUID for display ("ffe0") when it uses the Bluetooth base UUID.
 * @param {string} uuid
 */
export function shortUuid(uuid) {
  const c = canonicalUuid(uuid);
  if (c.endsWith(BLE_BASE_SUFFIX) && c.startsWith('0000')) return c.slice(4, 8);
  return c;
}
