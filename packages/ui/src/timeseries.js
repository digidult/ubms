import { msg } from './i18n.js';

/**
 * Generic time series store for device web apps: append-only records per key (one key per
 * device), metadata per key, range reads, pruning. Backends: IndexedDB (browser), files through
 * Tauri commands (desktop) and memory (tests, demo sessions); `fallbackBackend()` picks the second
 * of two backends when the first cannot be used.
 *
 * A record is a plain object whose first key is a numeric `t` (epoch ms, stored as an integer),
 * followed by any JSON values. The store keeps that order, so a serialized record always starts
 * with `{"t":<integer>`.
 *
 * Also here: min/max downsampling for charts and CSV helpers.
 *
 * @typedef {Record<string, any> & { t: number }} SeriesRecord
 *
 * @typedef {Object} SeriesStoreInfo
 * @property {'indexeddb'|'file'|'memory'} kind
 * @property {boolean} persistent data survives a restart of the app
 * @property {string} [dir] folder of the data files (file backend)
 * @property {boolean} [portable] the desktop app runs as a portable copy (file backend)
 * @property {string} [reason] which rule chose the folder, English (file backend)
 * @property {boolean} [persisted] the browser keeps the data under storage pressure
 *   (`navigator.storage.persisted()`; filled in by the app, IndexedDB only)
 *
 * @typedef {Object} SeriesKeyInfo
 * @property {string} key
 * @property {any} meta parsed metadata, null when none was written
 * @property {number} [count] number of records (IndexedDB and memory)
 * @property {number} [bytes] size of the data file (file backend)
 * @property {number} [first] time of the first record (IndexedDB and memory)
 * @property {number} [last] time of the last record (the file backend reads it from the end of
 *   the record file, or reports the file modification time when the bridge does not)
 * @property {number} [modified] modification time of the record file (of the meta file when
 *   there are no records), epoch ms (file backend)
 *
 * @typedef {Object} SeriesBackend
 * @property {() => Promise<SeriesStoreInfo>} info
 * @property {(key: string, records: SeriesRecord[]) => Promise<void>} append
 * @property {(key: string, range: { from?: number, to?: number }) => Promise<SeriesRecord[]>} read
 *   records within [from, to] sorted by time; a missing bound is open
 * @property {(key: string, meta: any) => Promise<void>} writeMeta
 * @property {() => Promise<SeriesKeyInfo[]>} list
 * @property {(key: string) => Promise<void>} remove
 * @property {(key: string, before: number) => Promise<number>} prune removes records with
 *   t < before, returns how many were removed
 *
 * @typedef {SeriesBackend & { backend: SeriesBackend }} SeriesStore
 */

/**
 * @param {unknown} v
 * @returns {v is number}
 */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Normalize a record: integer `t` as the first key. Returns null for a record without a time.
 * @param {any} r
 * @returns {SeriesRecord | null}
 */
function normalize(r) {
  if (!r || typeof r !== 'object' || !isNum(r.t)) return null;
  const t = Math.round(r.t);
  if (r.t === t && Object.keys(r)[0] === 't') return r;
  const { t: _drop, ...rest } = r;
  return { t, ...rest };
}

/**
 * @param {{ from?: number, to?: number }} [range]
 * @returns {{ from: number, to: number }}
 */
function bounds(range = {}) {
  return { from: isNum(range.from) ? range.from : -Infinity, to: isNum(range.to) ? range.to : Infinity };
}

/**
 * Wrap a backend: normalizes records, serializes the operations of each key (a read sees every
 * append that was started before it) and sorts the key list by the last record, newest first.
 * @param {SeriesBackend} backend
 * @returns {SeriesStore}
 */
export function createSeriesStore(backend) {
  /** @type {Map<string, Promise<any>>} */
  const queues = new Map();

  /**
   * Run `fn` after the previous operations on the same key.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function run(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return next;
  }

  /** Wait for every pending operation. */
  function idle() {
    return Promise.all([...queues.values()]).then(() => undefined);
  }

  return {
    backend,
    info: () => backend.info(),
    append(key, records) {
      const clean = [];
      for (const r of records ?? []) {
        const n = normalize(r);
        if (n) clean.push(n);
      }
      if (!clean.length) return Promise.resolve();
      return run(String(key), () => backend.append(String(key), clean));
    },
    read(key, range = {}) {
      const b = bounds(range);
      if (b.from > b.to) return Promise.resolve([]);
      return run(String(key), () => backend.read(String(key), range));
    },
    writeMeta(key, meta) {
      return run(String(key), () => backend.writeMeta(String(key), meta));
    },
    async list() {
      await idle();
      const items = await backend.list();
      return items.sort((a, b) => (b.last ?? b.modified ?? 0) - (a.last ?? a.modified ?? 0) || a.key.localeCompare(b.key));
    },
    remove(key) {
      return run(String(key), () => backend.remove(String(key)));
    },
    prune(key, before) {
      if (!isNum(before)) return Promise.resolve(0);
      return run(String(key), () => backend.prune(String(key), before));
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * Index of the first record with t >= time (records sorted by t).
 * @param {Array<{ t: number }>} arr
 * @param {number} time
 */
function lowerBound(arr, time) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Index of the first record with t > time (records sorted by t).
 * @param {Array<{ t: number }>} arr
 * @param {number} time
 */
function upperBound(arr, time) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].t <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * In-memory backend for tests and demo sessions. Nothing survives a reload.
 * @returns {SeriesBackend}
 */
export function memoryBackend() {
  /** @type {Map<string, SeriesRecord[]>} */
  const data = new Map();
  /** @type {Map<string, any>} */
  const metas = new Map();
  /** @param {any} v */
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async info() {
      return { kind: 'memory', persistent: false };
    },
    async append(key, records) {
      let arr = data.get(key);
      if (!arr) data.set(key, (arr = []));
      for (const rec of records) {
        const r = { ...rec };
        const last = arr.at(-1);
        if (!last || last.t < r.t) {
          arr.push(r);
          continue;
        }
        const i = lowerBound(arr, r.t);
        if (arr[i]?.t === r.t) arr[i] = r;
        else arr.splice(i, 0, r);
      }
    },
    async read(key, range) {
      const arr = data.get(key);
      if (!arr) return [];
      const { from, to } = bounds(range);
      return arr.slice(lowerBound(arr, from), upperBound(arr, to));
    },
    async writeMeta(key, meta) {
      metas.set(key, clone(meta));
    },
    async list() {
      const keys = new Set([...metas.keys(), ...[...data.keys()].filter((k) => data.get(k)?.length)]);
      return [...keys].map((key) => {
        const arr = data.get(key) ?? [];
        return { key, meta: clone(metas.get(key)) ?? null, count: arr.length, first: arr[0]?.t, last: arr.at(-1)?.t };
      });
    },
    async remove(key) {
      data.delete(key);
      metas.delete(key);
    },
    async prune(key, before) {
      const arr = data.get(key);
      if (!arr) return 0;
      const n = lowerBound(arr, before);
      arr.splice(0, n);
      return n;
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * A backend that uses `primary` when it works and `secondary` otherwise, for example IndexedDB
 * with memory as the fallback. The choice is made once, on first use: when `primary.info()`
 * rejects (IndexedDB missing, site data blocked, the database cannot be opened), every operation
 * goes to `secondary` from then on and `info()` reports it. Later errors of a working primary
 * (a full disk, an aborted transaction) reach the caller as usual.
 * @param {SeriesBackend} primary
 * @param {SeriesBackend} secondary
 * @returns {SeriesBackend}
 */
export function fallbackBackend(primary, secondary) {
  /** @type {Promise<SeriesBackend> | null} */
  let chosen = null;
  const pick = () =>
    (chosen ??= primary.info().then(
      () => primary,
      () => secondary,
    ));
  return {
    info: async () => (await pick()).info(),
    append: async (key, records) => (await pick()).append(key, records),
    read: async (key, range) => (await pick()).read(key, range),
    writeMeta: async (key, meta) => (await pick()).writeMeta(key, meta),
    list: async () => (await pick()).list(),
    remove: async (key) => (await pick()).remove(key),
    prune: async (key, before) => (await pick()).prune(key, before),
  };
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // No `error` handler: a failed request bubbles its error event to the transaction before the
    // transaction has `tx.error` set (it would reject with null). The abort that follows carries it.
    tx.onabort = () => reject(tx.error ?? new Error(msg('Transaction aborted')));
  });
}

/**
 * IndexedDB backend. Object store `records` (key path [key, t], index `key`) holds the records
 * with an added `key` property; object store `meta` (key path `key`) holds `{ key, meta }`.
 * Records of one key with the same `t` replace each other.
 * @param {string} [dbName]
 * @returns {SeriesBackend}
 */
export function indexedDbBackend(dbName = 'ubms-history') {
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;

  /** @returns {Promise<IDBDatabase>} */
  function db() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error(msg('IndexedDB is not available')));
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('records')) {
          const rec = d.createObjectStore('records', { keyPath: ['key', 't'] });
          rec.createIndex('key', 'key', { unique: false });
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const d = req.result;
        // Another tab upgrading the schema: close so it can proceed, reopen on the next call.
        d.onversionchange = () => {
          d.close();
          opening = null;
        };
        d.onclose = () => {
          opening = null;
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(msg('The history database is blocked by another tab')));
    });
    opening.catch(() => {
      opening = null;
    });
    return opening;
  }

  /**
   * Key range of one series key between two times.
   * @param {string} key
   * @param {number} from
   * @param {number} to
   * @param {boolean} [openUpper]
   */
  const keyRange = (key, from, to, openUpper = false) => IDBKeyRange.bound([key, from], [key, to], false, openUpper);

  /**
   * Strip the added `key` property, keeping `t` first.
   * @param {any} v
   * @returns {SeriesRecord}
   */
  const unwrap = (v) => {
    const { key: _key, ...rec } = v;
    return rec;
  };

  return {
    async info() {
      // Opens the database, so a profile that blocks site data (or a broken database) is
      // reported here and `fallbackBackend()` can switch to memory.
      await db();
      return { kind: 'indexeddb', persistent: true };
    },
    async append(key, records) {
      const d = await db();
      const tx = d.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      for (const r of records) store.put({ key, ...r });
      await done(tx);
    },
    async read(key, range) {
      const { from, to } = bounds(range);
      const d = await db();
      const store = () => d.transaction('records', 'readonly').objectStore('records');
      let lo = from;
      let hi = to;
      if (!isNum(lo) || !isNum(hi)) {
        const s = store();
        const r = keyRange(key, from, to);
        const [a, b] = await Promise.all([request(s.openCursor(r, 'next')), request(s.openCursor(r, 'prev'))]);
        if (!a || !b) return [];
        lo = a.value.t;
        hi = b.value.t;
      }
      // Long ranges are read as parallel slices in separate transactions (measured about 25 %
      // faster in Chromium for 100 000 records); slices keep the time order.
      const parts = hi - lo > 6 * 3600000 ? 4 : 1;
      const step = (hi - lo) / parts;
      const slices = await Promise.all(
        Array.from({ length: parts }, (_, k) => {
          const last = k === parts - 1;
          return request(store().getAll(keyRange(key, lo + k * step, last ? hi : lo + (k + 1) * step, !last)));
        }),
      );
      const out = [];
      for (const rows of slices) for (const row of rows) out.push(unwrap(row));
      return out;
    },
    async writeMeta(key, meta) {
      const d = await db();
      const tx = d.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, meta });
      await done(tx);
    },
    async list() {
      const d = await db();
      const tx = d.transaction(['records', 'meta'], 'readonly');
      const records = tx.objectStore('records');
      /** @type {Map<string, any>} */
      const metas = new Map();
      for (const row of await request(tx.objectStore('meta').getAll())) metas.set(row.key, row.meta ?? null);
      /** @type {string[]} */
      const keys = [];
      // One step per series key: after the first record of a key, jump past all of its records
      // (no record has t = Infinity). A 'nextunique' cursor on the key index visits every record
      // in Chromium (about 3 s for 300 000 records), this takes milliseconds.
      await new Promise((resolve, reject) => {
        const req = records.openKeyCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return resolve(undefined);
          const key = /** @type {any[]} */ (cur.key)[0];
          keys.push(String(key));
          cur.continue([key, Infinity]);
        };
      });
      const all = new Set([...metas.keys(), ...keys]);
      /** @type {SeriesKeyInfo[]} */
      const out = [];
      for (const key of all) {
        const range = keyRange(key, -Infinity, Infinity);
        const count = await request(records.count(range));
        const first = count ? await request(records.openCursor(range, 'next')) : null;
        const last = count ? await request(records.openCursor(range, 'prev')) : null;
        out.push({ key, meta: metas.get(key) ?? null, count, first: first?.value?.t, last: last?.value?.t });
      }
      return out;
    },
    async remove(key) {
      const d = await db();
      const tx = d.transaction(['records', 'meta'], 'readwrite');
      tx.objectStore('records').delete(keyRange(key, -Infinity, Infinity));
      tx.objectStore('meta').delete(key);
      await done(tx);
    },
    async prune(key, before) {
      const d = await db();
      const tx = d.transaction('records', 'readwrite');
      const store = tx.objectStore('records');
      const range = keyRange(key, -Infinity, before, true);
      const n = await request(store.count(range));
      if (n) store.delete(range);
      await done(tx);
      return n;
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * File backend of the desktop app (Tauri commands `history_*`, see docs/tauri.md). Records are
 * stored as JSON lines; `JSON.stringify` keeps `t` first and never writes a raw line break.
 * @param {(cmd: string, args?: Record<string, any>) => Promise<any>} invoke Tauri `invoke`
 * @returns {SeriesBackend}
 */
export function tauriFileBackend(invoke) {
  /** @param {string} s */
  const parse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return {
    async info() {
      const r = (await invoke('history_info')) ?? {};
      return { kind: 'file', persistent: true, dir: String(r.dir ?? ''), portable: !!r.portable, reason: String(r.reason ?? '') };
    },
    async append(key, records) {
      if (!records.length) return;
      await invoke('history_append', { key, lines: records.map((r) => JSON.stringify(r)) });
    },
    async read(key, range) {
      /** @type {Record<string, any>} */
      const args = { key };
      if (isNum(range?.from)) args.from = range.from;
      if (isNum(range?.to)) args.to = range.to;
      /** @type {string[]} */
      const lines = (await invoke('history_read', args)) ?? [];
      /** @type {SeriesRecord[]} */
      const out = [];
      let sorted = true;
      for (let k = 0; k < lines.length; k++) {
        const r = parse(lines[k]);
        // A week is about 300 000 lines: let each text go once it is parsed, so the texts and the
        // records do not both stay in memory until the end.
        lines[k] = '';
        if (!r || typeof r !== 'object' || !isNum(r.t)) continue;
        if (out.length && out[out.length - 1].t > r.t) sorted = false;
        out.push(r);
      }
      // Lines are in append order; a clock change on the computer can leave them out of order.
      if (!sorted) out.sort((a, b) => a.t - b.t);
      return out;
    },
    async writeMeta(key, meta) {
      await invoke('history_write_meta', { key, meta: JSON.stringify(meta ?? null) });
    },
    async list() {
      /** @type {Array<{ key: string, meta: string | null, bytes: number, modified: number, last?: number | null }>} */
      const items = (await invoke('history_list')) ?? [];
      return items.map((it) => ({
        key: it.key,
        meta: typeof it.meta === 'string' ? parse(it.meta) : null,
        bytes: Number(it.bytes) || 0,
        modified: Number(it.modified) || 0,
        // The time of the last record line; a bridge without it: the change of the record file.
        last: isNum(it.last) ? it.last : Number(it.modified) || undefined,
      }));
    },
    async remove(key) {
      await invoke('history_remove', { key });
    },
    async prune(key, before) {
      return Number(await invoke('history_prune', { key, before: Math.round(before) })) || 0;
    },
  };
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * Min/max downsampling for line charts. Splits [from, to] into `buckets` equal time slots and keeps
 * per slot the first, lowest, highest and last point, in time order, so peaks survive at any
 * zoom level. Points outside [from, to] and points without a finite value are dropped. `points`
 * must be sorted by time. Returns the input slice unchanged when it is small enough.
 * @template {{ t: number, v: number }} P
 * @param {P[]} points
 * @param {number} from
 * @param {number} to
 * @param {number} buckets for example the plot width in device pixels
 * @returns {P[]}
 */
export function downsampleMinMax(points, from, to, buckets) {
  if (!points?.length) return [];
  const lo = lowerBound(points, isNum(from) ? from : -Infinity);
  const hi = upperBound(points, isNum(to) ? to : Infinity);
  const n = Math.max(1, Math.floor(buckets) || 1);
  if (hi - lo <= n * 4 || !(to > from) || !isNum(from) || !isNum(to)) {
    const out = [];
    for (let i = lo; i < hi; i++) if (isNum(points[i].v)) out.push(points[i]);
    return out;
  }
  const span = to - from;
  /** @type {P[]} */
  const out = [];
  let bucket = -1;
  let first = -1;
  let min = -1;
  let max = -1;
  let last = -1;
  const flush = () => {
    if (first < 0) return;
    // Sort the four indexes (at most 4 values) and emit each once.
    const idx = [first, min, max, last].sort((a, b) => a - b);
    let prev = -1;
    for (const i of idx) {
      if (i !== prev) out.push(points[i]);
      prev = i;
    }
  };
  for (let i = lo; i < hi; i++) {
    const p = points[i];
    if (!isNum(p.v)) continue;
    const b = Math.min(n - 1, Math.floor(((p.t - from) / span) * n));
    if (b !== bucket) {
      flush();
      bucket = b;
      first = min = max = last = i;
      continue;
    }
    last = i;
    if (p.v < points[min].v) min = i;
    if (p.v > points[max].v) max = i;
  }
  flush();
  return out;
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * Format one CSV value: numbers with a dot decimal separator, empty for missing values, strings
 * quoted when they contain a comma, a quote or a line break. Strings that a spreadsheet would run
 * as a formula (leading =, +, -, @) get a leading apostrophe unless they are plain numbers.
 * @param {unknown} value
 * @returns {string}
 */
export function csvEscape(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build CSV text: comma separated, dot decimal, CRLF line ends (also after the last row).
 * @param {unknown[]} header
 * @param {Iterable<unknown[]>} rows
 * @param {{ bom?: boolean }} [opts] bom: start with U+FEFF so spreadsheet apps detect UTF-8
 * @returns {string}
 */
export function toCsv(header, rows, { bom = false } = {}) {
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}
