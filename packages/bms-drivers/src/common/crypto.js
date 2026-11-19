/**
 * Small pure JavaScript crypto helpers for protocols that wrap their frames in a cipher (Deye
 * Bluetooth session). Drivers never use browser crypto (WebCrypto is asynchronous, missing in
 * insecure contexts and not part of the driver contract), so the few primitives a protocol needs
 * live here: SHA-256 and AES-128 (ECB block, CBC with or without PKCS#7 padding).
 *
 * These helpers serve protocol compatibility only. They make no claim of constant time execution
 * and must not protect secrets.
 */

// ---------------------------------------------------------------------------------------------
// SHA-256 (FIPS 180-4)
// ---------------------------------------------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @param {number} x @param {number} n */
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 digest.
 * @param {ArrayLike<number>} data bytes
 * @returns {Uint8Array} 32 bytes
 */
export function sha256(data) {
  const len = data.length;
  // Message, 0x80, zero padding, 64 bit big-endian bit length; total a multiple of 64 bytes.
  const total = Math.ceil((len + 9) / 64) * 64;
  const m = new Uint8Array(total);
  for (let i = 0; i < len; i++) m[i] = data[i] & 0xff;
  m[len] = 0x80;
  const bits = len * 8;
  const hi = Math.floor(bits / 0x100000000);
  const lo = bits >>> 0;
  m[total - 8] = hi >>> 24;
  m[total - 7] = (hi >>> 16) & 0xff;
  m[total - 6] = (hi >>> 8) & 0xff;
  m[total - 5] = hi & 0xff;
  m[total - 4] = lo >>> 24;
  m[total - 3] = (lo >>> 16) & 0xff;
  m[total - 2] = (lo >>> 8) & 0xff;
  m[total - 1] = lo & 0xff;

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) {
      const i = off + 4 * t;
      w[t] = ((m[i] << 24) | (m[i + 1] << 16) | (m[i + 2] << 8) | m[i + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K256[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[4 * i] = h[i] >>> 24;
    out[4 * i + 1] = (h[i] >>> 16) & 0xff;
    out[4 * i + 2] = (h[i] >>> 8) & 0xff;
    out[4 * i + 3] = h[i] & 0xff;
  }
  return out;
}

/**
 * Lower case hex text of the SHA-256 digest.
 * @param {ArrayLike<number>} data
 */
export function sha256Hex(data) {
  let s = '';
  for (const b of sha256(data)) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Latin-1 bytes of a text (one byte per character; protocol strings are ASCII).
 * @param {string} text
 */
export function latin1(text) {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

// ---------------------------------------------------------------------------------------------
// AES-128 (FIPS 197)
// ---------------------------------------------------------------------------------------------

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);

/** @param {number} a */
const xtime = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

/** Multiplication in GF(2^8). @param {number} a @param {number} b */
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8 && b; i++) {
    if (b & 1) p ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return p;
}

(() => {
  // S-box from the multiplicative inverse and the affine transformation.
  for (let x = 0; x < 256; x++) {
    let inv = 0;
    if (x) {
      for (let y = 1; y < 256; y++) {
        if (gmul(x, y) === 1) {
          inv = y;
          break;
        }
      }
    }
    let s = inv;
    let r = inv;
    for (let k = 0; k < 4; k++) {
      r = ((r << 1) | (r >> 7)) & 0xff;
      s ^= r;
    }
    SBOX[x] = s ^ 0x63;
  }
  for (let x = 0; x < 256; x++) INV_SBOX[SBOX[x]] = x;
})();

/**
 * Round keys of an AES-128 key (11 × 16 bytes).
 * @param {ArrayLike<number>} key 16 bytes
 */
export function aes128ExpandKey(key) {
  if (key.length !== 16) throw new Error('AES-128 needs a 16 byte key');
  const w = new Uint8Array(176);
  for (let i = 0; i < 16; i++) w[i] = key[i] & 0xff;
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      const r0 = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[r0];
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

/** @param {Uint8Array} s @param {Uint8Array} rk @param {number} round */
function addRoundKey(s, rk, round) {
  const o = round * 16;
  for (let i = 0; i < 16; i++) s[i] ^= rk[o + i];
}

/**
 * Encrypt one block in place.
 * @param {Uint8Array} s 16 byte state (column major, as the input bytes)
 * @param {Uint8Array} rk expanded key
 */
function encryptState(s, rk) {
  const t = new Uint8Array(16);
  addRoundKey(s, rk, 0);
  for (let round = 1; round <= 10; round++) {
    // SubBytes and ShiftRows: row r moves left by r columns.
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[c * 4 + r] = SBOX[s[((c + r) % 4) * 4 + r]];
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = t[c * 4];
        const a1 = t[c * 4 + 1];
        const a2 = t[c * 4 + 2];
        const a3 = t[c * 4 + 3];
        s[c * 4] = xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3;
        s[c * 4 + 3] = xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3);
      }
    } else {
      s.set(t);
    }
    addRoundKey(s, rk, round);
  }
}

/**
 * Decrypt one block in place.
 * @param {Uint8Array} s
 * @param {Uint8Array} rk
 */
function decryptState(s, rk) {
  const t = new Uint8Array(16);
  addRoundKey(s, rk, 10);
  for (let round = 9; round >= 0; round--) {
    // InvShiftRows and InvSubBytes: row r moves right by r columns.
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[((c + r) % 4) * 4 + r] = INV_SBOX[s[c * 4 + r]];
    s.set(t);
    addRoundKey(s, rk, round);
    if (round > 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        s[c * 4] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[c * 4 + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[c * 4 + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[c * 4 + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
      }
    }
  }
}

/**
 * AES-128 encryption of one 16 byte block (ECB).
 * @param {ArrayLike<number>} key 16 bytes
 * @param {ArrayLike<number>} block 16 bytes
 */
export function aes128EncryptBlock(key, block) {
  if (block.length !== 16) throw new Error('AES block must be 16 bytes');
  const s = Uint8Array.from(block);
  encryptState(s, aes128ExpandKey(key));
  return s;
}

/**
 * AES-128 decryption of one 16 byte block (ECB).
 * @param {ArrayLike<number>} key
 * @param {ArrayLike<number>} block
 */
export function aes128DecryptBlock(key, block) {
  if (block.length !== 16) throw new Error('AES block must be 16 bytes');
  const s = Uint8Array.from(block);
  decryptState(s, aes128ExpandKey(key));
  return s;
}

/**
 * PKCS#7 padding to a multiple of 16 bytes (always adds 1 to 16 bytes).
 * @param {ArrayLike<number>} data
 */
export function pkcs7Pad(data) {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(Uint8Array.from(data));
  out.fill(pad, data.length);
  return out;
}

/**
 * Removes PKCS#7 padding; returns null when the padding is invalid.
 * @param {Uint8Array} data
 * @returns {Uint8Array | null}
 */
export function pkcs7Unpad(data) {
  if (!data.length || data.length % 16) return null;
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 16) return null;
  for (let i = data.length - pad; i < data.length; i++) if (data[i] !== pad) return null;
  return data.slice(0, data.length - pad);
}

/**
 * AES-128-CBC encryption.
 * @param {ArrayLike<number>} key 16 bytes
 * @param {ArrayLike<number>} iv 16 bytes
 * @param {ArrayLike<number>} data
 * @param {{ padding?: boolean }} [opts] padding true (default) adds PKCS#7; false needs a multiple
 *   of 16 bytes
 */
export function aes128CbcEncrypt(key, iv, data, { padding = true } = {}) {
  if (iv.length !== 16) throw new Error('AES-CBC needs a 16 byte IV');
  const input = padding ? pkcs7Pad(data) : Uint8Array.from(data);
  if (input.length % 16) throw new Error('AES-CBC without padding needs whole blocks');
  const rk = aes128ExpandKey(key);
  const out = new Uint8Array(input.length);
  let prev = Uint8Array.from(iv);
  for (let off = 0; off < input.length; off += 16) {
    const s = new Uint8Array(16);
    for (let i = 0; i < 16; i++) s[i] = input[off + i] ^ prev[i];
    encryptState(s, rk);
    out.set(s, off);
    prev = s;
  }
  return out;
}

/**
 * AES-128-CBC decryption.
 * @param {ArrayLike<number>} key
 * @param {ArrayLike<number>} iv
 * @param {ArrayLike<number>} data a multiple of 16 bytes
 * @param {{ padding?: boolean }} [opts] padding true (default) removes PKCS#7 and returns null
 *   when it is invalid
 * @returns {Uint8Array | null}
 */
export function aes128CbcDecrypt(key, iv, data, { padding = true } = {}) {
  if (iv.length !== 16) throw new Error('AES-CBC needs a 16 byte IV');
  if (!data.length || data.length % 16) return null;
  const rk = aes128ExpandKey(key);
  const out = new Uint8Array(data.length);
  let prev = Uint8Array.from(iv);
  for (let off = 0; off < data.length; off += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = data[off + i] & 0xff;
    const s = Uint8Array.from(block);
    decryptState(s, rk);
    for (let i = 0; i < 16; i++) out[off + i] = s[i] ^ prev[i];
    prev = block;
  }
  return padding ? pkcs7Unpad(out) : out;
}
