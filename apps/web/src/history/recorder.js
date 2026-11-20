import { historyRecord, historyDeviceMeta, deviceHistoryKey, usableSerial, chartedExtras } from '@ubms/bms-core';

/**
 * Records the readings of the connected device for the Charts view.
 *
 * - The device key (`deviceHistoryKey`) needs the device info: after 'connected' the recorder
 *   waits for a serial number (at most 5 s), buffers records until the key is known, then writes
 *   the device meta and keeps it up to date (name, cell count, temperature labels).
 * - A record is taken from a snapshot at most every `prefs.historyIntervalMs`.
 * - Records are written in batches: every 10 s, on disconnect, when the page is hidden or closed.
 * - A live tail (the last two hours of the current device, including what the store held from
 *   earlier connections) feeds the charts without reading the store for every update.
 * - Demo sessions record into a memory store that is never persisted.
 * - With `prefs.historyEnabled` off nothing is written, the live tail still works.
 *
 * @typedef {import('@ubms/bms-core/history').HistoryRecord} HistoryRecord
 * @typedef {import('@ubms/bms-core/history').HistoryDeviceMeta} HistoryDeviceMeta
 * @typedef {import('@ubms/ui/timeseries').SeriesStore} SeriesStore
 *
 * @typedef {Object} RecorderPrefs
 * @property {boolean} historyEnabled
 * @property {number} historyIntervalMs
 * @property {number} historyRetentionDays 0 keeps everything
 *
 * @typedef {Object} LiveHistory the recording of the connected device
 * @property {number} id counts connections, changes for every new device session
 * @property {string | null} key history key, null until the device info is known
 * @property {SeriesStore} store where the records go (the memory store for demo sessions)
 * @property {boolean} demo demo or replay session: memory only
 * @property {HistoryDeviceMeta | null} meta
 * @property {HistoryRecord[]} tail records of the last two hours, oldest first
 * @property {number} epoch changes when the tail is replaced (key resolved, history cleared)
 * @property {number} rev changes with every new record
 * @property {string | null} error last storage error, English
 */

export const LIVE_WINDOW_MS = 2 * 3600 * 1000;
export const FLUSH_INTERVAL_MS = 10000;
export const INFO_WAIT_MS = 5000;
const DAY_MS = 24 * 3600 * 1000;
/** Trim the tail only when it is this much longer than the window (avoids a splice per record). */
const TRIM_SLACK_MS = 5 * 60 * 1000;

/**
 * Records of `stored` that are older than the first record of `tail`, followed by `tail`.
 * @param {HistoryRecord[]} stored sorted
 * @param {HistoryRecord[]} tail sorted
 * @returns {HistoryRecord[]}
 */
export function mergeRecords(stored, tail) {
  if (!tail.length) return stored.slice();
  if (!stored.length) return tail.slice();
  const first = tail[0].t;
  const out = [];
  for (const r of stored) {
    if (r.t >= first) break;
    out.push(r);
  }
  for (const r of tail) out.push(r);
  return out;
}

/**
 * Is the link id of a session target stable across connections? Bluetooth device ids are (Web
 * Bluetooth per origin, the desktop bridge per system); a desktop serial port path names the port.
 * Web Serial ports have no stable identity, demo links are new every time.
 * @param {any} target session target
 * @returns {string} the stable id or ''
 */
export function stableLinkId(target) {
  if (!target?.handle) return '';
  if (target.kind === 'ble') return String(target.handle.id ?? '');
  if (target.kind === 'serial') {
    const d = typeof target.handle.describe === 'function' ? target.handle.describe() : null;
    return d?.backend === 'tauri' ? String(target.handle.id ?? '') : '';
  }
  return '';
}

/**
 * The RS485 address or board number a serial session was opened with (the Connect screen sets
 * `options.address`), or undefined.
 * @param {any} target session target
 * @returns {number | undefined}
 */
export function busAddress(target) {
  const address = target?.kind === 'serial' ? target.options?.address : undefined;
  return Number.isInteger(address) ? address : undefined;
}

export class HistoryRecorder {
  /**
   * @param {Object} opts
   * @param {import('@ubms/bms-core').BmsSession} opts.session
   * @param {SeriesStore} opts.store persistent store (IndexedDB, desktop files or memory)
   * @param {SeriesStore} opts.demoStore memory store for demo sessions
   * @param {() => RecorderPrefs} opts.prefs current preferences
   * @param {(live: LiveHistory | null) => void} [opts.onChange] called after every change
   * @param {(message: string) => void} [opts.warn] reports storage errors (once per error text)
   * @param {() => number} [opts.now]
   */
  constructor({ session, store, demoStore, prefs, onChange = () => {}, warn = () => {}, now = () => Date.now() }) {
    this.session = session;
    this.store = store;
    this.demoStore = demoStore;
    this.prefs = prefs;
    this.onChange = onChange;
    this.warn = warn;
    this.now = now;
    /** @type {LiveHistory | null} */
    this.live = null;
    this.ids = 0;
    /** Records waiting to be written. */
    /** @type {HistoryRecord[]} */
    this.buffer = [];
    /** Time of the last record taken, for the interval. */
    this.lastT = -Infinity;
    /** JSON of the meta written last, so unchanged meta is not written again. */
    this.metaJson = '';
    /** Cell count and temperature labels of the last snapshot, to notice changes cheaply. */
    this.shape = '';
    /** The session is reconnecting: 'connected' continues the same recording. */
    this.reconnecting = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.infoTimer = undefined;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.flushTimer = undefined;
    /** @type {Promise<void>} the latest flush */
    this.flushing = Promise.resolve();

    this.unbind = [
      session.on('state', (/** @type {{ state: string }} */ e) => this.#onState(e.state)),
      session.on('snapshot', (/** @type {any} */ s) => this.#onSnapshot(s)),
      session.on('info', () => this.#onInfo()),
    ];
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const flush = () => {
        this.flush();
      };
      const hidden = () => {
        if (document.visibilityState === 'hidden') this.flush();
      };
      window.addEventListener('pagehide', flush);
      document.addEventListener('visibilitychange', hidden);
      this.unbind.push(
        () => window.removeEventListener('pagehide', flush),
        () => document.removeEventListener('visibilitychange', hidden),
      );
    }
  }

  dispose() {
    for (const u of this.unbind) u();
    this.unbind = [];
    this.#end();
  }

  /** @param {string} state */
  #onState(state) {
    if (state === 'connected') {
      if (this.live && this.reconnecting) {
        this.reconnecting = false;
        return;
      }
      this.#begin();
    } else if (state === 'reconnecting') {
      this.reconnecting = true;
      this.flush();
    } else if (this.live) {
      // idle, error, disconnecting, a new connection: the recording of this device ends.
      this.#end();
    }
  }

  #begin() {
    this.#end();
    const target = /** @type {any} */ (this.session.target);
    const demo = !target || target.kind === 'link';
    this.live = {
      id: ++this.ids,
      key: null,
      store: demo ? this.demoStore : this.store,
      demo,
      meta: null,
      tail: [],
      epoch: 0,
      rev: 0,
      error: null,
    };
    this.buffer = [];
    this.lastT = -Infinity;
    this.metaJson = '';
    this.shape = '';
    this.reconnecting = false;
    const id = this.live.id;
    this.infoTimer = setTimeout(() => {
      if (this.live?.id === id && !this.live.key) this.#resolveKey();
    }, INFO_WAIT_MS);
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    // The serial number may have arrived with the probe already.
    if (usableSerial(this.session.info?.serialNumber)) this.#resolveKey();
    this.onChange(this.live);
  }

  #end() {
    clearTimeout(this.infoTimer);
    clearInterval(this.flushTimer);
    this.infoTimer = undefined;
    this.flushTimer = undefined;
    const live = this.live;
    if (!live) return;
    // Records taken before the device info arrived still get a key and are written.
    if (!live.key) this.#resolveKey();
    this.flush();
    this.live = null;
    this.reconnecting = false;
    this.onChange(null);
  }

  #onInfo() {
    const live = this.live;
    if (!live) return;
    if (!live.key) {
      if (usableSerial(this.session.info?.serialNumber)) this.#resolveKey();
      return;
    }
    this.#refreshMeta();
  }

  /** Device meta from the session as it is now. */
  #meta() {
    const s = this.session;
    return historyDeviceMeta({
      definition: /** @type {any} */ (s.definition ?? undefined),
      info: s.info,
      snapshot: s.snapshot,
      deviceName: this.#deviceName(),
      address: busAddress(s.target),
    });
  }

  /**
   * Name for the key and the meta. Bluetooth advertises a name per device; a serial port's name is
   * the adapter's (the same for every battery behind the same adapter type), so the device's own
   * name or model comes first there.
   */
  #deviceName() {
    const s = this.session;
    const target = /** @type {any} */ (s.target);
    const link = target?.handle?.name ?? s.link?.name ?? '';
    if (target?.kind !== 'serial') return link;
    return s.info?.name || s.info?.model || link;
  }

  #resolveKey() {
    const live = this.live;
    if (!live || live.key) return;
    clearTimeout(this.infoTimer);
    this.infoTimer = undefined;
    const s = this.session;
    const target = /** @type {any} */ (s.target);
    live.key = deviceHistoryKey({
      info: s.info,
      definition: /** @type {any} */ (s.definition ?? undefined),
      linkKind: target?.kind ?? '',
      linkId: stableLinkId(target),
      deviceName: this.#deviceName(),
      // Packs on one RS485 bus share the port: the address from the Connect screen tells them apart.
      address: busAddress(target),
    });
    live.meta = this.#meta();
    const key = live.key;
    const id = live.id;
    const store = live.store;
    const persist = this.#persisting();
    if (persist) {
      const days = Number(this.prefs().historyRetentionDays) || 0;
      if (days > 0) store.prune(key, this.now() - days * DAY_MS).catch((err) => this.#failed(err));
      this.#writeMeta();
    }
    // Everything recorded so far waits in the tail; it is written with the next flush.
    if (persist) this.buffer.push(...live.tail);
    // Show what the store holds from earlier connections in the live window as well.
    const from = this.now() - LIVE_WINDOW_MS;
    store
      .read(key, { from })
      .then((stored) => {
        if (this.live?.id !== id || !stored.length) return;
        this.live.tail = mergeRecords(/** @type {HistoryRecord[]} */ (stored), this.live.tail);
        this.live.epoch++;
        this.onChange(this.live);
      })
      .catch((err) => this.#failed(err));
    this.onChange(live);
  }

  /** Records go to the store: recording is on and the key is known. */
  #persisting() {
    return !!this.live?.key && this.prefs().historyEnabled !== false;
  }

  #writeMeta() {
    const live = this.live;
    if (!live?.key || !live.meta) return;
    const json = JSON.stringify(live.meta);
    if (json === this.metaJson) return;
    this.metaJson = json;
    live.store.writeMeta(live.key, live.meta).catch((err) => this.#failed(err));
  }

  #refreshMeta() {
    const live = this.live;
    if (!live?.key) return;
    live.meta = this.#meta();
    if (this.#persisting()) this.#writeMeta();
    this.onChange(live);
  }

  /** @param {any} snapshot */
  #onSnapshot(snapshot) {
    const live = this.live;
    if (!live || !snapshot) return;
    const record = historyRecord(snapshot);
    const interval = Math.max(250, Number(this.prefs().historyIntervalMs) || 2000);
    // Polls jitter a little: accept a record slightly early instead of skipping a whole poll.
    if (record.t - this.lastT < interval - Math.min(250, interval * 0.1)) return;
    if (record.t <= (live.tail.at(-1)?.t ?? -Infinity)) return; // never out of order
    this.lastT = record.t;
    live.tail.push(record);
    const oldest = record.t - LIVE_WINDOW_MS;
    if (live.tail[0].t < oldest - TRIM_SLACK_MS) {
      let n = 0;
      while (n < live.tail.length && live.tail[n].t < oldest) n++;
      live.tail.splice(0, n);
    }
    if (this.#persisting()) {
      this.buffer.push(record);
      // Recording switched on during the connection: the meta is written with the first record.
      if (!this.metaJson) this.#writeMeta();
    }
    const shape = `${snapshot.cells?.length ?? 0}|${(snapshot.temperatures ?? []).map((/** @type {any} */ x) => x?.label ?? '').join(',')}|${chartedExtras(snapshot.extra)
      .map(([id]) => id)
      .join(',')}`;
    // A meta computed before the first snapshot (or before the cell count changed) lacks the cell
    // count, the temperature labels and the charted extra values.
    if (shape !== this.shape) {
      this.shape = shape;
      if (live.key) this.#refreshMeta();
    }
    live.rev++;
    this.onChange(live);
  }

  /**
   * Write the buffered records now.
   * @returns {Promise<void>}
   */
  flush() {
    const live = this.live;
    if (!live?.key || !this.buffer.length) return this.flushing;
    const batch = this.buffer;
    this.buffer = [];
    if (this.prefs().historyEnabled === false) return this.flushing;
    const p = live.store.append(live.key, batch).catch((err) => this.#failed(err));
    this.flushing = p;
    return p;
  }

  /**
   * Forget the live tail and the unwritten records of the connected device; recording goes on.
   * Call it right before the stored history is removed: a later flush is then queued behind the
   * removal and holds only readings taken after it. The meta is written again with the next
   * record (also queued behind the removal), not here, where the removal would delete it.
   */
  clearLive() {
    const live = this.live;
    if (!live) return;
    live.tail = [];
    this.buffer = [];
    this.metaJson = '';
    live.epoch++;
    this.onChange(live);
  }

  /** @param {unknown} err */
  #failed(err) {
    const message = err instanceof Error ? err.message : String(err);
    const live = this.live;
    if (live && live.error !== message) {
      live.error = message;
      this.warn(message);
      this.onChange(live);
    }
  }
}
