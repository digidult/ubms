import { Emitter } from './emitter.js';
import { fromHex, hex } from './bytes.js';
import { msg } from './msg.js';

/**
 * Protocol log: a bounded, observable list of everything that crossed a link, with optional
 * decoded views of frames. It is the single source for the log screen, exports and replays.
 *
 * Entry kinds:
 * - `tx`    bytes written to the device (one entry per logical write, before chunking)
 * - `rx`    raw bytes as received (one entry per notification / serial read)
 * - `frame` a complete, validated frame produced by the framer (decoded lazily)
 * - `event` connection lifecycle and driver milestones
 * - `warn`, `error`, `debug` diagnostics
 *
 * @typedef {'tx'|'rx'|'frame'|'event'|'warn'|'error'|'debug'} LogKind
 *
 * @typedef {Object} LogEntry
 * @property {number} id
 * @property {number} t epoch milliseconds (fractional where the platform allows)
 * @property {LogKind} kind
 * @property {string} [source] link or driver id
 * @property {Uint8Array} [bytes]
 * @property {string} [name] frame or command name
 * @property {string} [text] human readable message
 * @property {Record<string, any>} [fields] eagerly decoded content
 * @property {() => any} [decode] lazy decoder for `bytes`
 */

const now = () =>
  typeof performance !== 'undefined' && performance.timeOrigin
    ? performance.timeOrigin + performance.now()
    : Date.now();

export const LOG_FORMAT = 'ubms-protocol-log';
export const LOG_FORMAT_VERSION = 1;

/** @type {Set<string>} */
const LOG_KINDS = new Set(['tx', 'rx', 'frame', 'event', 'warn', 'error', 'debug']);

export class ProtocolLog extends Emitter {
  /** @param {{ capacity?: number }} [opts] */
  constructor({ capacity = 5000 } = {}) {
    super();
    this.capacity = capacity;
    /** @type {LogEntry[]} */
    this.list = [];
    this.nextId = 1;
    /** Optional metadata about the current session, included in exports. */
    this.meta = {};
  }

  get size() {
    return this.list.length;
  }

  /**
   * @param {Omit<LogEntry, 'id' | 't'> & { t?: number }} entry
   * @returns {LogEntry}
   */
  add(entry) {
    const e = /** @type {LogEntry} */ ({ ...entry, id: this.nextId++, t: entry.t ?? now() });
    this.list.push(e);
    if (this.list.length > this.capacity * 1.1) this.list.splice(0, this.list.length - this.capacity);
    this.emit('entry', e);
    return e;
  }

  /** @param {Uint8Array} bytes @param {Partial<LogEntry>} [meta] */
  tx(bytes, meta = {}) {
    return this.add({ ...meta, kind: 'tx', bytes });
  }
  /** @param {Uint8Array} bytes @param {Partial<LogEntry>} [meta] */
  rx(bytes, meta = {}) {
    return this.add({ ...meta, kind: 'rx', bytes });
  }
  /** @param {Uint8Array} bytes @param {Partial<LogEntry>} [meta] */
  frame(bytes, meta = {}) {
    return this.add({ ...meta, kind: 'frame', bytes });
  }
  /** @param {string} text @param {Partial<LogEntry>} [meta] */
  event(text, meta = {}) {
    return this.add({ ...meta, kind: 'event', text });
  }
  /** @param {string} text @param {Partial<LogEntry>} [meta] */
  warn(text, meta = {}) {
    return this.add({ ...meta, kind: 'warn', text });
  }
  /** @param {unknown} err @param {Partial<LogEntry>} [meta] */
  error(err, meta = {}) {
    const text = err instanceof Error ? err.message : String(err);
    return this.add({ ...meta, kind: 'error', text });
  }
  /** @param {string} text @param {Partial<LogEntry>} [meta] */
  debug(text, meta = {}) {
    return this.add({ ...meta, kind: 'debug', text });
  }

  /** @returns {LogEntry[]} */
  entries() {
    return this.list.slice();
  }

  clear() {
    this.list = [];
    this.emit('clear');
  }

  /**
   * Decoded content of an entry (eager fields or lazy decoder), or undefined.
   * @param {LogEntry} entry
   */
  static decoded(entry) {
    if (entry.fields) return entry.fields;
    if (entry.decode) {
      try {
        return entry.decode();
      } catch (err) {
        return { decodeError: err instanceof Error ? err.message : String(err) };
      }
    }
    return undefined;
  }

  /**
   * Serializable export (JSON). Bytes become uppercase hex.
   * @param {{ includeDecoded?: boolean, meta?: Record<string, any> }} [opts]
   */
  export({ includeDecoded = false, meta = {} } = {}) {
    return {
      format: LOG_FORMAT,
      version: LOG_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      meta: { ...this.meta, ...meta },
      entries: this.list.map((e) => {
        /** @type {Record<string, any>} */
        const out = { t: Math.round(e.t * 1000) / 1000, kind: e.kind };
        if (e.source) out.source = e.source;
        if (e.name) out.name = e.name;
        if (e.text) out.text = e.text;
        if (e.bytes) out.hex = hex(e.bytes);
        if (includeDecoded) {
          const d = ProtocolLog.decoded(e);
          if (d !== undefined) out.fields = d;
        }
        return out;
      }),
    };
  }

  /**
   * Parse an exported log (for viewing or replay). Any file that is not a valid export (not
   * JSON, another format, a damaged entry) throws one translatable error.
   * @param {any} json
   * @returns {{ meta: Record<string, any>, entries: LogEntry[] }}
   */
  static parseExport(json) {
    const invalid = () => new Error(msg('This file is not a protocol log'));
    let data;
    try {
      data = typeof json === 'string' ? JSON.parse(json) : json;
    } catch {
      throw invalid();
    }
    if (!data || typeof data !== 'object' || data.format !== LOG_FORMAT) throw invalid();
    if (data.entries !== undefined && !Array.isArray(data.entries)) throw invalid();
    let id = 1;
    const entries = (data.entries ?? []).map((/** @type {any} */ e) => {
      if (!e || typeof e !== 'object' || !LOG_KINDS.has(e.kind)) throw invalid();
      if (e.hex !== undefined && typeof e.hex !== 'string') throw invalid();
      let bytes;
      try {
        bytes = e.hex ? fromHex(e.hex) : undefined;
      } catch {
        throw invalid();
      }
      return {
        id: id++,
        t: Number(e.t) || 0,
        kind: e.kind,
        source: e.source,
        name: e.name,
        text: e.text,
        bytes,
        fields: e.fields,
      };
    });
    return { meta: data.meta ?? {}, entries };
  }

  /**
   * One-line text rendering, used for "copy" and text export.
   * @param {LogEntry} e
   * @param {number} [t0] reference time for relative timestamps
   */
  static formatLine(e, t0) {
    const time = t0 !== undefined ? `+${((e.t - t0) / 1000).toFixed(3)}s` : new Date(e.t).toISOString().slice(11, 23);
    const tag = e.kind.toUpperCase().padEnd(5, ' ');
    const parts = [time, tag];
    if (e.name) parts.push(`[${e.name}]`);
    if (e.text) parts.push(e.text);
    if (e.bytes) parts.push(`(${e.bytes.length} B) ${hex(e.bytes, ' ')}`);
    return parts.join(' ');
  }
}
