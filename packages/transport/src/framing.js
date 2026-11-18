import { concat, indexOf } from './bytes.js';

/**
 * Reassembles complete frames from a byte stream that arrives in arbitrary chunks
 * (BLE notifications of 20 to 244 bytes, serial reads of any size, several frames per chunk).
 *
 * The protocol is described by:
 * - `sync`: one or more start patterns (preambles);
 * - `length(buf)`: total frame length for a buffer that starts with a sync pattern,
 *   `0` when more bytes are needed to know it, `-1` when the header is invalid;
 * - `validate(frame)`: optional checksum check.
 *
 * On a bad header or checksum only the first byte is dropped and the search restarts, so a frame
 * that begins inside a truncated one is still found. Dropped bytes are reported through `onDiscard`
 * in one batch (not byte by byte).
 */
export class FrameAssembler {
  /**
   * @param {Object} opts
   * @param {ArrayLike<number>[]} opts.sync
   * @param {(buf: Uint8Array) => number} opts.length
   * @param {(frame: Uint8Array) => boolean} [opts.validate]
   * @param {(frame: Uint8Array) => void} opts.onFrame
   * @param {(bytes: Uint8Array, reason: string) => void} [opts.onDiscard]
   * @param {number} [opts.maxLength] frames longer than this are treated as invalid headers
   * @param {number} [opts.staleMs] a partial frame older than this is dropped when new data arrives
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    if (!opts.sync?.length) throw new Error('FrameAssembler needs at least one sync pattern');
    this.sync = opts.sync.map((s) => Uint8Array.from(s));
    this.lengthOf = opts.length;
    this.validate = opts.validate;
    this.onFrame = opts.onFrame;
    this.onDiscard = opts.onDiscard;
    this.maxLength = opts.maxLength ?? 4096;
    this.staleMs = opts.staleMs ?? 1500;
    this.now = opts.now ?? (() => Date.now());
    /** @type {Uint8Array} */
    this.buf = new Uint8Array(0);
    /** @type {number[]} */
    this.pendingDiscard = [];
    this.pendingReason = '';
    this.lastPush = 0;
    this.maxSyncLen = Math.max(...this.sync.map((s) => s.length));
  }

  /** Drop everything buffered (for example after a reconnect). */
  reset() {
    if (this.buf.length) this.#discard(this.buf, 'reset');
    this.buf = new Uint8Array(0);
    this.#flushDiscard();
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    const now = this.now();
    if (this.buf.length && this.staleMs > 0 && now - this.lastPush > this.staleMs) {
      this.#discard(this.buf, 'stale partial frame');
      this.buf = new Uint8Array(0);
    }
    this.lastPush = now;
    this.buf = this.buf.length ? concat(this.buf, chunk) : Uint8Array.from(chunk);
    this.#process();
    this.#flushDiscard();
  }

  #findSync() {
    let best = -1;
    for (const s of this.sync) {
      const i = indexOf(this.buf, s, 0);
      if (i >= 0 && (best < 0 || i < best)) best = i;
    }
    return best;
  }

  /** Length of the longest buffer suffix that could still become a sync pattern. */
  #partialSyncTail() {
    const max = Math.min(this.maxSyncLen - 1, this.buf.length);
    for (let k = max; k > 0; k--) {
      const tail = this.buf.subarray(this.buf.length - k);
      for (const s of this.sync) {
        let ok = true;
        for (let j = 0; j < k; j++) {
          if (tail[j] !== s[j]) {
            ok = false;
            break;
          }
        }
        if (ok) return k;
      }
    }
    return 0;
  }

  #process() {
    while (this.buf.length) {
      const start = this.#findSync();
      if (start < 0) {
        const keep = this.#partialSyncTail();
        const drop = this.buf.length - keep;
        if (drop > 0) this.#discard(this.buf.subarray(0, drop), 'no frame start');
        this.buf = this.buf.slice(drop);
        return;
      }
      if (start > 0) {
        this.#discard(this.buf.subarray(0, start), 'bytes before frame start');
        this.buf = this.buf.slice(start);
      }
      const len = this.lengthOf(this.buf);
      if (len === 0) return; // need more bytes for the header
      if (len < 0 || len > this.maxLength) {
        this.#discard(this.buf.subarray(0, 1), 'invalid header');
        this.buf = this.buf.slice(1);
        continue;
      }
      if (this.buf.length < len) return; // wait for the rest
      const frame = this.buf.slice(0, len);
      if (this.validate && !this.validate(frame)) {
        this.#discard(this.buf.subarray(0, 1), 'checksum mismatch');
        this.buf = this.buf.slice(1);
        continue;
      }
      this.buf = this.buf.slice(len);
      this.#flushDiscard();
      this.onFrame(frame);
    }
  }

  /** @param {Uint8Array} bytes @param {string} reason */
  #discard(bytes, reason) {
    if (!this.onDiscard || !bytes.length) return;
    if (this.pendingDiscard.length && this.pendingReason !== reason) this.#flushDiscard();
    this.pendingReason = reason;
    for (const b of bytes) this.pendingDiscard.push(b);
  }

  #flushDiscard() {
    if (!this.pendingDiscard.length) return;
    const bytes = Uint8Array.from(this.pendingDiscard);
    const reason = this.pendingReason;
    this.pendingDiscard = [];
    this.pendingReason = '';
    this.onDiscard?.(bytes, reason);
  }
}

/**
 * Convenience: assembler for protocols with a fixed frame length.
 * @param {Object} opts
 * @param {ArrayLike<number>[]} opts.sync
 * @param {number} opts.size
 * @param {(frame: Uint8Array) => boolean} [opts.validate]
 * @param {(frame: Uint8Array) => void} opts.onFrame
 * @param {(bytes: Uint8Array, reason: string) => void} [opts.onDiscard]
 */
export function fixedLengthAssembler({ sync, size, validate, onFrame, onDiscard }) {
  return new FrameAssembler({ sync, length: () => size, validate, onFrame, onDiscard, maxLength: size });
}
