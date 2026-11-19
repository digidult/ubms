import { Emitter } from './emitter.js';
import { msg } from './msg.js';

let linkCounter = 0;

/**
 * A Link is a bidirectional byte channel to one device: a BLE characteristic pair, a serial port,
 * a Tauri-managed connection or an in-memory pipe. Protocol drivers only ever see this interface.
 *
 * Events:
 * - `data`  (Uint8Array) bytes received from the device
 * - `state` ({ state, reason? }) lifecycle changes
 * - `close` ({ reason, remote }) the link closed (remote = true when the device or OS closed it)
 *
 * Subclasses implement `_open`, `_close`, `_write`. `_close` releases what `_open` acquired
 * (listeners, native handles, the port). It runs on `close()`, after a remote close and after a
 * failed `_open`, so it must tolerate a partly opened transport.
 *
 * @typedef {'closed'|'opening'|'open'|'closing'} LinkState
 *
 * @typedef {Object} WriteMeta
 * @property {string} [name] command name for the log
 * @property {() => any} [decode] lazy decoder for the log
 */
export class Link extends Emitter {
  /**
   * @param {Object} opts
   * @param {string} opts.kind  'ble' | 'serial' | 'memory' | 'tauri-ble' | 'tauri-serial' | ...
   * @param {string} [opts.id]
   * @param {string} [opts.name] human readable device name
   * @param {import('./log.js').ProtocolLog} [opts.log]
   * @param {number} [opts.chunkSize] split writes into chunks of at most this many bytes
   * @param {number} [opts.chunkDelayMs] pause between chunks
   */
  constructor({ kind, id, name, log, chunkSize = 0, chunkDelayMs = 0 }) {
    super();
    this.kind = kind;
    this.id = id ?? `${kind}-${++linkCounter}`;
    this.name = name ?? kind;
    this.log = log;
    this.chunkSize = chunkSize;
    this.chunkDelayMs = chunkDelayMs;
    /** @type {LinkState} */
    this.state = 'closed';
    /** @type {Promise<void>} */
    this.writeChain = Promise.resolve();
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  get isOpen() {
    return this.state === 'open';
  }

  /** Static description for the UI and log exports. */
  describe() {
    return { kind: this.kind, id: this.id, name: this.name };
  }

  async open() {
    if (this.state === 'open') return;
    if (this.#cleanup) await this.#cleanup;
    this.#setState('opening');
    try {
      await this._open();
    } catch (err) {
      // _open() may have added listeners or opened handles before it failed.
      await this.#release();
      this.#setState('closed');
      throw err;
    }
    this.#setState('open');
    this.log?.event(`Link opened: ${this.name}`, { source: this.id });
  }

  async close() {
    if (this.state === 'closed') {
      // After a remote close, wait for the cleanup that _remoteClosed() started.
      await this.#cleanup;
      return;
    }
    if (this.state === 'closing') return;
    this.#setState('closing');
    try {
      await this._close();
    } finally {
      this.#setState('closed');
      this.log?.event(`Link closed: ${this.name}`, { source: this.id });
      this.emit('close', { reason: 'local', remote: false });
    }
  }

  /**
   * Write bytes. Writes are serialized; long writes are split into `chunkSize` pieces.
   * @param {Uint8Array} bytes
   * @param {WriteMeta} [meta]
   */
  write(bytes, meta = {}) {
    const run = async () => {
      if (this.state !== 'open') throw new Error(msg('The connection is not open'));
      this.log?.tx(bytes, { source: this.id, name: meta.name, decode: meta.decode });
      this.bytesOut += bytes.length;
      if (!this.chunkSize || bytes.length <= this.chunkSize) {
        await this._write(bytes);
        return;
      }
      for (let off = 0; off < bytes.length; off += this.chunkSize) {
        await this._write(bytes.subarray(off, off + this.chunkSize));
        if (this.chunkDelayMs && off + this.chunkSize < bytes.length) await sleep(this.chunkDelayMs);
      }
    };
    const p = this.writeChain.then(run, run);
    this.writeChain = p.catch(() => {});
    return p;
  }

  /**
   * Called by subclasses when bytes arrive.
   * @param {Uint8Array} bytes
   */
  _receive(bytes) {
    if (!bytes.length) return;
    this.bytesIn += bytes.length;
    this.log?.rx(bytes, { source: this.id });
    this.emit('data', bytes);
  }

  /**
   * Called by subclasses when the remote side or the OS closed the link.
   * @param {string} reason
   */
  _remoteClosed(reason) {
    if (this.state === 'closed') return;
    // Release what _open() acquired. Not while opening or closing: _close() would then run alongside
    // the pending _open() or _close().
    if (this.state === 'open') this.#cleanup = this.#releaseLater();
    this.#setState('closed', reason);
    this.log?.warn(`Link lost: ${reason}`, { source: this.id });
    this.emit('close', { reason, remote: true });
  }

  /** @type {Promise<void> | null} cleanup after a remote close, until it finishes */
  #cleanup = null;

  /**
   * Run _close() after the current call stack: a subclass often reports a remote close from inside
   * the read loop or the event handler that its _close() waits for or removes.
   * @returns {Promise<void>}
   */
  #releaseLater() {
    const cleanup = Promise.resolve()
      .then(() => this.#release())
      .finally(() => {
        if (this.#cleanup === cleanup) this.#cleanup = null;
      });
    return cleanup;
  }

  /** Run _close(). A failure is only logged: the link counts as closed either way. */
  async #release() {
    try {
      await this._close();
    } catch (err) {
      this.log?.debug(`Link cleanup failed: ${err instanceof Error ? err.message : err}`, { source: this.id });
    }
  }

  /** @param {LinkState} state @param {string} [reason] */
  #setState(state, reason) {
    this.state = state;
    this.emit('state', { state, reason });
  }

  /* c8 ignore start */
  /** @returns {Promise<void>} */
  async _open() {}
  /** @returns {Promise<void>} */
  async _close() {}
  /**
   * @param {Uint8Array} _bytes
   * @returns {Promise<void>}
   */
  async _write(_bytes) {
    throw new Error('Not implemented');
  }
  /* c8 ignore stop */
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Promise with a timeout. Rejects with an Error whose `code` is 'TIMEOUT'.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [message]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message = 'Timed out') {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message);
      /** @type {any} */ (err).code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
