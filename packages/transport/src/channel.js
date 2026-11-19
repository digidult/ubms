import { Emitter } from './emitter.js';
import { withTimeout } from './link.js';
import { msg } from './msg.js';

/**
 * @typedef {Object} AssemblerLike
 * @property {(chunk: Uint8Array) => void} push
 * @property {() => void} reset
 *
 * @typedef {Object} FrameDescription
 * @property {string} name
 * @property {() => any} [decode]
 *
 * @typedef {Object} RequestOptions
 * @property {(frame: Uint8Array) => boolean} match accepts the response frame
 * @property {number} [timeout] milliseconds to wait for the response after the write, per attempt
 *   (default 2000)
 * @property {number} [retries] extra attempts after a timeout (default 0)
 * @property {string} [name] command name for the log
 * @property {() => any} [decode] lazy decoder of the command bytes for the log
 *
 * @typedef {RequestOptions & {
 *   until: (frames: Uint8Array[]) => boolean,
 *   partialOnTimeout?: boolean
 * }} RequestManyOptions
 */

/**
 * Binds a Link to a frame assembler and offers request/response helpers.
 * All sends and requests are serialized, so a poll loop and a settings write never interleave
 * on the wire. Every complete frame is logged (with a lazy decoder) and emitted as `frame`.
 */
export class FrameChannel extends Emitter {
  /**
   * @param {import('./link.js').Link} link
   * @param {Object} opts
   * @param {(handlers: { onFrame: (frame: Uint8Array) => void, onDiscard: (bytes: Uint8Array, reason: string) => void }) => AssemblerLike} opts.createAssembler
   * @param {(frame: Uint8Array) => FrameDescription | null} [opts.describe]
   * @param {import('./log.js').ProtocolLog} [opts.log]
   * @param {string} [opts.source]
   */
  constructor(link, { createAssembler, describe, log, source }) {
    super();
    this.link = link;
    this.log = log ?? link.log;
    this.source = source ?? link.id;
    this.describe = describe;
    this.assembler = createAssembler({
      onFrame: (frame) => this.#onFrame(frame),
      onDiscard: (bytes, reason) => this.log?.add({ kind: 'debug', source: this.source, text: `Discarded ${bytes.length} byte(s): ${reason}`, bytes }),
    });
    /** @type {Set<{ match: (f: Uint8Array) => boolean, resolve: (f: Uint8Array) => void }>} */
    this.waiters = new Set();
    /** @type {Promise<any>} */
    this.queue = Promise.resolve();
    /** @type {(() => void) | null} */
    this.unsubscribe = null;
    this.framesIn = 0;
    this.lastFrameAt = 0;
  }

  start() {
    if (this.unsubscribe) return this;
    this.unsubscribe = this.link.on('data', (chunk) => this.assembler.push(chunk));
    return this;
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.waiters.clear();
    this.assembler.reset();
  }

  /** @param {Uint8Array} frame */
  #onFrame(frame) {
    this.framesIn++;
    this.lastFrameAt = Date.now();
    let description = null;
    try {
      description = this.describe?.(frame) ?? null;
    } catch {
      description = null;
    }
    this.log?.frame(frame, { source: this.source, name: description?.name ?? 'Frame', decode: description?.decode });
    for (const w of [...this.waiters]) {
      if (w.match(frame)) w.resolve(frame);
    }
    this.emit('frame', frame);
  }

  /**
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  exclusive(task) {
    const p = this.queue.then(task, task);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Fire-and-forget command (still serialized with requests).
   * @param {Uint8Array} bytes
   * @param {import('./link.js').WriteMeta} [meta]
   */
  send(bytes, meta) {
    return this.exclusive(() => this.link.write(bytes, meta));
  }

  /**
   * Wait for the next frame accepted by `match` (no write).
   * @param {(frame: Uint8Array) => boolean} match
   * @param {number} [timeout]
   * @returns {Promise<Uint8Array>}
   */
  waitFor(match, timeout = 2000) {
    const { promise, cancel } = this.#listen(match);
    return withTimeout(promise, timeout, msg('No response from the device')).finally(cancel);
  }

  /**
   * Register a waiter for the next frame accepted by `match`, without a timeout.
   * @param {(frame: Uint8Array) => boolean} match
   * @returns {{ promise: Promise<Uint8Array>, cancel: () => void }}
   */
  #listen(match) {
    /** @type {any} */
    let waiter;
    /** @type {Promise<Uint8Array>} */
    const promise = new Promise((resolve) => {
      waiter = {
        match,
        resolve: (/** @type {Uint8Array} */ f) => {
          this.waiters.delete(waiter);
          resolve(f);
        },
      };
      this.waiters.add(waiter);
    });
    return { promise, cancel: () => void this.waiters.delete(waiter) };
  }

  /**
   * Write a command and wait for the matching response frame.
   * @param {Uint8Array} bytes
   * @param {RequestOptions} opts
   * @returns {Promise<Uint8Array>}
   */
  request(bytes, opts) {
    return this.exclusive(() => this.requestUnqueued(bytes, opts));
  }

  /**
   * Same as `request` but without taking the queue. Only call it from inside `exclusive()`.
   * @param {Uint8Array} bytes
   * @param {RequestOptions} opts
   * @returns {Promise<Uint8Array>}
   */
  async requestUnqueued(bytes, { match, timeout = 2000, retries = 0, name, decode }) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // Listen before the write so a fast answer is not missed, but start the timeout after it: a
      // slow write (chunked, or a BLE write with response) must not use up the response time.
      const response = this.#listen(match);
      try {
        await this.link.write(bytes, { name, decode });
        return await withTimeout(response.promise, timeout, msg('No response from the device'));
      } catch (err) {
        lastErr = err;
        if (/** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
        if (attempt < retries) this.log?.warn(`No response to ${name ?? 'request'}, retrying (${attempt + 1}/${retries})`, { source: this.source });
      } finally {
        response.cancel();
      }
    }
    throw lastErr;
  }

  /**
   * Write a command and collect several response frames (multi-frame answers).
   * @param {Uint8Array} bytes
   * @param {RequestManyOptions} opts
   * @returns {Promise<Uint8Array[]>}
   */
  requestMany(bytes, opts) {
    return this.exclusive(() => this.requestManyUnqueued(bytes, opts));
  }

  /**
   * @param {Uint8Array} bytes
   * @param {RequestManyOptions} opts
   * @returns {Promise<Uint8Array[]>}
   */
  async requestManyUnqueued(bytes, { match, until, timeout = 2000, partialOnTimeout = true, name, decode }) {
    /** @type {Uint8Array[]} */
    const frames = [];
    /** @type {any} */
    let waiter;
    const done = new Promise((resolve) => {
      waiter = {
        match,
        resolve: (/** @type {Uint8Array} */ f) => {
          frames.push(f);
          if (until(frames)) {
            this.waiters.delete(waiter);
            resolve(frames);
          }
        },
      };
      this.waiters.add(waiter);
    });
    try {
      await this.link.write(bytes, { name, decode });
      return /** @type {Uint8Array[]} */ (await withTimeout(done, timeout, msg('Incomplete response from the device')));
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'TIMEOUT' && partialOnTimeout && frames.length) return frames;
      throw err;
    } finally {
      this.waiters.delete(waiter);
    }
  }
}
