import { Emitter } from './emitter.js';
import { Link, sleep } from './link.js';
import { canonicalUuid } from './bytes.js';
import { msg } from './msg.js';

/**
 * Tauri desktop bridge. The Rust side (`apps/desktop/src-tauri`: bluest for Bluetooth LE,
 * serialport for serial ports) implements the command and event contract documented in
 * docs/tauri.md; this module adapts it to the same device-handle and Link interfaces the Web
 * Bluetooth and Web Serial transports expose, so drivers and the UI need no changes.
 *
 * Every listener of a device or link is removed again: on close, on a remote close and when an
 * open fails, also when the Link base class does not call `_close()`. The adapter listener of
 * TauriBleProvider.onAvailabilityChange() stays until the caller removes it.
 */

/**
 * Fixed error texts of the Rust bridge (ble.rs, serial.rs). Commands reject with them as they
 * are, and apps show them through their translation function, so they are listed here to be
 * extracted for translation. Keep them identical to the Rust source. Texts the bridge builds at
 * run time (an invalid UUID, a missing characteristic, DTR/RTS warnings, system errors) stay
 * English.
 */
export const BRIDGE_ERRORS = [
  msg('Bluetooth device is not connected'),
  msg('Device not found, scan again'),
  msg('The Bluetooth scan stopped'),
  msg('The Bluetooth scan did not start'),
  msg('The device did not report any GATT characteristics'),
  msg('Notifications could not be enabled'),
  msg('Enabling notifications timed out'),
  msg('Bluetooth write timed out'),
  msg('Serial port is not open'),
  msg('Serial write timed out'),
];

/** @returns {any} */
function tauri() {
  return typeof window !== 'undefined' ? /** @type {any} */ (window).__TAURI__ : undefined;
}

export function isTauri() {
  return !!tauri()?.core?.invoke;
}

/**
 * Commands reject with the Rust error text (a string); turn it into an Error like everywhere else.
 * @param {string} cmd @param {Record<string, any>} [args]
 */
async function invoke(cmd, args) {
  try {
    return await tauri().core.invoke(cmd, args);
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * @param {string} event
 * @param {(payload: any) => void} handler
 * @returns {Promise<() => void>}
 */
async function listen(event, handler) {
  return tauri().event.listen(event, (/** @type {any} */ e) => handler(e.payload));
}

/** @param {() => void} fn @returns {() => void} a function that runs `fn` on its first call only */
function once(fn) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    fn();
  };
}

/** @param {unknown} err */
function text(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Availability from the result of `ble_adapter_state`: `{ state, reason, detail }` (an older
 * bridge returned only the state string).
 * @param {any} raw
 * @returns {{ available: boolean, reason?: string, state?: string }}
 */
function adapterAvailability(raw) {
  const s = typeof raw === 'string' ? { state: raw } : raw ?? {};
  if (s.state === 'on') return { available: true };
  // 'error' comes with the system's own message, which says more than a generic text.
  const reason = s.reason === 'error' && s.detail ? String(s.detail) : s.reason ?? (s.state === 'off' ? 'powered-off' : 'adapter-unavailable');
  return { available: false, reason, state: s.state ?? 'unavailable' };
}

/**
 * Counts scan() calls. The bridge runs one scan for the whole app and handles scan commands in
 * the order they arrive, so a `ble_scan_stop` sent for a scan that a newer scan() replaced would
 * run after the newer `ble_scan_start` and end the newer scan.
 */
let scanCount = 0;

/** Native BLE through Tauri: scanning happens in-app, there is no browser chooser. */
export class TauriBleProvider {
  /** @param {{ log?: import('./log.js').ProtocolLog }} [opts] */
  constructor({ log } = {}) {
    this.id = 'tauri-ble';
    this.kind = 'ble';
    this.log = log;
    this.capabilities = { scan: true, chooser: false };
  }

  async availability() {
    if (!isTauri()) return { available: false, reason: 'not-tauri' };
    try {
      return adapterAvailability(await invoke('ble_adapter_state'));
    } catch (err) {
      return { available: false, reason: text(err) };
    }
  }

  /**
   * Calls `handler` when the bridge reports that the adapter was switched on or off
   * (`ble://adapter`). The handler should ask availability() again: the bridge emits the event
   * only once it has found an adapter, so callers keep their other triggers (window focus).
   * @param {() => void} handler
   * @returns {Promise<() => void>} removes the listener
   */
  async onAvailabilityChange(handler) {
    return once(await listen('ble://adapter', () => handler()));
  }

  /**
   * Scan for devices. Calls `onDevice` when a device is found and when it changes (the bridge
   * merges advertisements per device and repeats an unchanged one at most once per second).
   * Starting a scan stops a running one, so the stop function of a replaced scan only removes
   * its listener.
   * @param {{ namePrefixes?: string[], services?: (string|number)[], manufacturerIds?: number[], timeoutMs?: number }} filters
   * @param {(device: { id: string, name: string, rssi?: number, services?: string[] }) => void} onDevice
   * @returns {Promise<() => Promise<void>>} stop function
   */
  async scan(filters, onDevice) {
    const unlisten = await listen('ble://device', onDevice);
    // Counted after listen(): when listen() fails, no ble_scan_start follows, so the stop
    // function of the running scan must keep working.
    const scanId = ++scanCount;
    try {
      await invoke('ble_scan_start', {
        filters: {
          namePrefixes: filters.namePrefixes ?? [],
          services: (filters.services ?? []).map(canonicalUuid),
          manufacturerIds: filters.manufacturerIds ?? [],
        },
        timeoutMs: filters.timeoutMs ?? 15000,
      });
    } catch (err) {
      unlisten();
      throw err;
    }
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      unlisten();
      // A newer scan() replaced this one: its ble_scan_start stopped this scan in the bridge.
      if (scanId === scanCount) await invoke('ble_scan_stop').catch(() => {});
    };
  }

  /**
   * A handle for a scanned or remembered device. The bridge opens a device by its id, so a
   * remembered id connects without a new scan.
   * @param {{ id: string, name?: string }} device
   */
  get(device) {
    return new TauriBleDevice(device.id, device.name ?? device.id, this.log);
  }

  /** Devices are not remembered by the bridge; the app stores ids itself. */
  async known() {
    return [];
  }
}

export class TauriBleDevice extends Emitter {
  /** @param {string} id @param {string} name @param {import('./log.js').ProtocolLog} [log] */
  constructor(id, name, log) {
    super();
    this.id = id;
    this.name = name;
    this.log = log;
    this.kind = 'ble';
    this.connected = false;
    /** @type {any[] | null} */
    this.services = null;
    /** @type {Promise<() => void> | null} the one `ble://disconnected` listener of this device */
    this.listening = null;
    /** Counts disconnect() calls: a connect that started before one gives up instead of retrying. */
    this.epoch = 0;
  }

  describe() {
    return { kind: 'ble', id: this.id, name: this.name, backend: 'tauri' };
  }

  /** Registers this device's disconnect listener once; it stays until disconnect() or dispose(). */
  #listen() {
    if (!this.listening) {
      const pending = listen('ble://disconnected', (p) => {
        if (p?.id !== this.id || !this.connected) return;
        this.connected = false;
        this.services = null;
        this.log?.warn(`Bluetooth link lost: ${this.name}`);
        this.emit('disconnect', { reason: 'disconnected' });
      });
      this.listening = pending;
      pending.catch(() => {
        if (this.listening === pending) this.listening = null;
      });
    }
    return this.listening;
  }

  #unlisten() {
    const pending = this.listening;
    this.listening = null;
    pending?.then(
      (off) => off(),
      () => {},
    );
  }

  /**
   * Connect with up to `attempts` tries, like the Web Bluetooth transport. The bridge releases a
   * failed attempt itself; ble_disconnect between attempts also covers a link it no longer tracks.
   * @param {{ timeoutMs?: number, attempts?: number }} [opts]
   */
  async connect({ timeoutMs = 20000, attempts = 2 } = {}) {
    if (this.connected) return;
    const epoch = this.epoch;
    await this.#listen();
    /** @type {unknown} */
    let lastErr = new Error(msg('Bluetooth connection timed out'));
    for (let i = 1; i <= Math.max(1, attempts); i++) {
      if (epoch !== this.epoch) break;
      try {
        this.log?.event(`Connecting to ${this.name} (attempt ${i}/${attempts})`);
        const services = await invoke('ble_connect', { id: this.id, timeoutMs });
        if (epoch !== this.epoch) break; // disconnect() came first; the bridge closes the link
        this.services = services;
        this.connected = true;
        this.log?.event(`Connected: ${this.name}`);
        return;
      } catch (err) {
        lastErr = err;
        if (epoch !== this.epoch) break;
        this.log?.warn(`Connect failed: ${text(err)}`);
        await invoke('ble_disconnect', { id: this.id }).catch(() => {});
        if (i < attempts) await sleep(600);
      }
    }
    if (epoch !== this.epoch) {
      const err = new Error(msg('Connection cancelled'));
      /** @type {any} */ (err).code = 'cancelled';
      throw err;
    }
    throw lastErr;
  }

  async discover() {
    if (!this.connected) await this.connect();
    return this.services ?? (await invoke('ble_services', { id: this.id }));
  }

  /** @param {import('./web-bluetooth.js').BleChannelProfile} profile */
  async openChannel(profile) {
    if (!this.connected) await this.connect();
    const link = new TauriBleLink(this, profile, this.log);
    await link.open();
    return link;
  }

  /** Also cancels a connect in progress. */
  async disconnect() {
    this.epoch++;
    this.connected = false;
    this.services = null;
    this.#unlisten();
    await invoke('ble_disconnect', { id: this.id }).catch(() => {});
  }

  dispose() {
    this.#unlisten();
    this.removeAllListeners();
  }
}

class TauriBleLink extends Link {
  /** @param {TauriBleDevice} handle @param {import('./web-bluetooth.js').BleChannelProfile} profile @param {any} log */
  constructor(handle, profile, log) {
    super({ kind: 'tauri-ble', name: handle.name, log, chunkSize: profile.chunkSize ?? 20, chunkDelayMs: profile.chunkDelayMs ?? 0 });
    this.handle = handle;
    this.profile = profile;
    this.service = canonicalUuid(profile.service);
    this.notifyUuid = canonicalUuid(profile.notify);
    this.writeUuid = canonicalUuid(profile.write);
    /** Removes this link's listeners; safe to call more than once. */
    this.release = () => {};
    /** True while the bridge holds a subscription for this link. */
    this.subscribed = false;
  }

  describe() {
    return { ...super.describe(), service: this.service, notify: this.notifyUuid, write: this.writeUuid };
  }

  async _open() {
    const { handle, service, notifyUuid } = this;
    // The bridge picks the characteristic by service, UUID and properties (a JK module has a
    // write FFE1 and a notify FFE1) and reports which one sent a value.
    const offNotify = once(
      await listen('ble://notify', (p) => {
        if (p.id !== handle.id || canonicalUuid(p.characteristic) !== notifyUuid) return;
        if (p.service && canonicalUuid(p.service) !== service) return;
        this._receive(Uint8Array.from(p.data));
      }),
    );
    this.release = offNotify;
    try {
      await invoke('ble_subscribe', { id: handle.id, service, characteristic: notifyUuid });
    } catch (err) {
      this.release();
      throw err;
    }
    this.subscribed = true;
    if (!handle.connected) {
      this.release();
      throw new Error(msg('Bluetooth disconnected'));
    }
    const offDisconnect = handle.on('disconnect', () => {
      this.release();
      this._remoteClosed(msg('Bluetooth disconnected'));
    });
    this.release = once(() => {
      offNotify();
      offDisconnect();
    });
  }

  async _close() {
    const subscribed = this.subscribed;
    this.subscribed = false;
    this.release();
    // After a remote close the bridge has dropped the connection and its subscription already.
    if (!subscribed || !this.handle.connected) return;
    await invoke('ble_unsubscribe', { id: this.handle.id, service: this.service, characteristic: this.notifyUuid }).catch(() => {});
  }

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    await invoke('ble_write', {
      id: this.handle.id,
      service: this.service,
      characteristic: this.writeUuid,
      data: Array.from(bytes),
      // The bridge falls back to the other write type when the characteristic lacks this one.
      withResponse: this.profile.writeMode !== 'without-response' && this.profile.writeMode !== 'prefer-without-response',
    });
  }
}

/** Native serial ports through Tauri: the app lists ports itself (paths like COM3, /dev/ttyUSB0). */
export class TauriSerialProvider {
  /** @param {{ log?: import('./log.js').ProtocolLog }} [opts] */
  constructor({ log } = {}) {
    this.id = 'tauri-serial';
    this.kind = 'serial';
    this.log = log;
    this.capabilities = { list: true, chooser: false };
  }

  async availability() {
    return isTauri() ? { available: true } : { available: false, reason: 'not-tauri' };
  }

  /** @returns {Promise<TauriSerialPort[]>} */
  async list() {
    const ports = await invoke('serial_list');
    return ports.map((/** @type {any} */ p) => new TauriSerialPort(p, this.log));
  }

  async known() {
    return this.list();
  }
}

export class TauriSerialPort {
  /** @param {{ path: string, name?: string, usbVendorId?: number, usbProductId?: number }} info @param {any} log */
  constructor(info, log) {
    this.info = info;
    this.log = log;
    this.kind = 'serial';
  }
  get id() {
    return this.info.path;
  }
  get name() {
    return this.info.name ?? this.info.path;
  }
  describe() {
    return { kind: 'serial', backend: 'tauri', ...this.info };
  }
  /** @param {import('./web-serial.js').SerialOptions} options */
  async openLink(options) {
    const link = new TauriSerialLink(this, options, this.log);
    await link.open();
    return link;
  }
}

class TauriSerialLink extends Link {
  /** @param {TauriSerialPort} port @param {import('./web-serial.js').SerialOptions} options @param {any} log */
  constructor(port, options, log) {
    super({ kind: 'tauri-serial', name: `${port.name} @ ${options.baudRate}`, log });
    this.port = port;
    this.options = options;
    /** @type {string | null} */
    this.handleId = null;
    /** Removes this link's listeners; safe to call more than once. */
    this.release = () => {};
  }

  async _open() {
    /** @type {Array<{ closed: boolean, p: any }> | null} events that arrive before the handle is known */
    let early = [];
    const onData = (/** @type {any} */ p) => {
      if (early) early.push({ closed: false, p });
      else if (p.handle === this.handleId) this._receive(Uint8Array.from(p.data));
    };
    const onClosed = (/** @type {any} */ p) => {
      if (early) early.push({ closed: true, p });
      else if (p.handle === this.handleId) this.#lost(p.reason ?? msg('Serial port closed'));
    };
    // Listen before opening: the reader thread forwards bytes as soon as the port is open.
    const offData = once(await listen('serial://data', onData));
    this.release = offData;
    try {
      const offClosed = once(await listen('serial://closed', onClosed));
      this.release = once(() => {
        offData();
        offClosed();
      });
      const opened = await invoke('serial_open', { path: this.port.info.path, ...this.options });
      // { handle, warnings }; an older bridge returned the handle alone.
      const { handle, warnings = [] } = typeof opened === 'string' ? { handle: opened } : opened;
      this.handleId = handle;
      for (const w of warnings) this.log?.warn(String(w), { source: this.id });
    } catch (err) {
      this.release();
      throw err;
    }
    const queued = early;
    early = null;
    for (const e of queued) {
      if (e.p.handle !== this.handleId) continue;
      if (e.closed) {
        // The port failed before the handle was known: the open fails.
        await this._close();
        throw new Error(String(e.p.reason ?? msg('Serial port closed')));
      }
      this._receive(Uint8Array.from(e.p.data));
    }
  }

  /** The bridge reported a read error; it has forgotten the port already. @param {string} reason */
  #lost(reason) {
    const handle = this.handleId;
    this.handleId = null;
    this.release();
    // Closing again is harmless and also covers an older bridge.
    if (handle) invoke('serial_close', { handle }).catch(() => {});
    this._remoteClosed(reason);
  }

  async _close() {
    const handle = this.handleId;
    this.handleId = null;
    this.release();
    if (handle) await invoke('serial_close', { handle }).catch(() => {});
  }

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    if (!this.handleId) throw new Error(msg('The connection is not open'));
    await invoke('serial_write', { handle: this.handleId, data: Array.from(bytes) });
  }
}
