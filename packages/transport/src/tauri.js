import { Emitter } from './emitter.js';
import { Link } from './link.js';
import { canonicalUuid } from './bytes.js';

/**
 * Tauri desktop bridge (next project stage). The Rust side (btleplug + serialport) implements the
 * command and event contract documented in docs/tauri.md; this module adapts it to the same
 * device-handle and Link interfaces the Web Bluetooth and Web Serial transports expose, so drivers
 * and the UI need no changes.
 *
 * Status: experimental. The contract is fixed, the Rust implementation does not exist yet.
 */

/** @returns {any} */
function tauri() {
  return typeof window !== 'undefined' ? /** @type {any} */ (window).__TAURI__ : undefined;
}

export function isTauri() {
  return !!tauri()?.core?.invoke;
}

/** @param {string} cmd @param {Record<string, any>} [args] */
function invoke(cmd, args) {
  return tauri().core.invoke(cmd, args);
}

/**
 * @param {string} event
 * @param {(payload: any) => void} handler
 * @returns {Promise<() => void>}
 */
async function listen(event, handler) {
  return tauri().event.listen(event, (/** @type {any} */ e) => handler(e.payload));
}

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
      const state = await invoke('ble_adapter_state');
      return state === 'on' ? { available: true } : { available: false, reason: 'adapter-unavailable' };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Scan for devices. Calls `onDevice` for every advertisement.
   * @param {{ namePrefixes?: string[], services?: (string|number)[], timeoutMs?: number }} filters
   * @param {(device: { id: string, name: string, rssi?: number, services?: string[] }) => void} onDevice
   * @returns {Promise<() => Promise<void>>} stop function
   */
  async scan(filters, onDevice) {
    const unlisten = await listen('ble://device', onDevice);
    await invoke('ble_scan_start', {
      filters: { namePrefixes: filters.namePrefixes ?? [], services: (filters.services ?? []).map(canonicalUuid) },
      timeoutMs: filters.timeoutMs ?? 15000,
    });
    return async () => {
      unlisten();
      await invoke('ble_scan_stop').catch(() => {});
    };
  }

  /** @param {{ id: string, name?: string }} device */
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
    /** @type {Array<() => void>} */
    this.unlisteners = [];
  }

  describe() {
    return { kind: 'ble', id: this.id, name: this.name, backend: 'tauri' };
  }

  async connect({ timeoutMs = 20000 } = {}) {
    if (this.connected) return;
    this.unlisteners.push(
      await listen('ble://disconnected', (p) => {
        if (p.id !== this.id) return;
        this.connected = false;
        this.emit('disconnect', { reason: 'disconnected' });
      }),
    );
    this.services = await invoke('ble_connect', { id: this.id, timeoutMs });
    this.connected = true;
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

  async disconnect() {
    await invoke('ble_disconnect', { id: this.id }).catch(() => {});
    this.connected = false;
  }

  dispose() {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    this.removeAllListeners();
  }
}

class TauriBleLink extends Link {
  /** @param {TauriBleDevice} handle @param {import('./web-bluetooth.js').BleChannelProfile} profile @param {any} log */
  constructor(handle, profile, log) {
    super({ kind: 'tauri-ble', name: handle.name, log, chunkSize: profile.chunkSize ?? 20, chunkDelayMs: profile.chunkDelayMs ?? 0 });
    this.handle = handle;
    this.profile = profile;
    /** @type {() => void} */
    this.unlisten = () => {};
    this.offDisconnect = () => {};
  }

  async _open() {
    const notify = canonicalUuid(this.profile.notify);
    this.unlisten = await listen('ble://notify', (p) => {
      if (p.id === this.handle.id && canonicalUuid(p.characteristic) === notify) this._receive(Uint8Array.from(p.data));
    });
    await invoke('ble_subscribe', { id: this.handle.id, service: canonicalUuid(this.profile.service), characteristic: notify });
    this.offDisconnect = this.handle.on('disconnect', () => this._remoteClosed('Bluetooth disconnected'));
  }

  async _close() {
    this.offDisconnect();
    this.unlisten();
    await invoke('ble_unsubscribe', {
      id: this.handle.id,
      service: canonicalUuid(this.profile.service),
      characteristic: canonicalUuid(this.profile.notify),
    }).catch(() => {});
  }

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    await invoke('ble_write', {
      id: this.handle.id,
      service: canonicalUuid(this.profile.service),
      characteristic: canonicalUuid(this.profile.write),
      data: Array.from(bytes),
      withResponse: this.profile.writeMode !== 'without-response',
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
    /** @type {Array<() => void>} */
    this.unlisteners = [];
  }

  async _open() {
    this.handleId = await invoke('serial_open', { path: this.port.info.path, ...this.options });
    this.unlisteners.push(
      await listen('serial://data', (p) => {
        if (p.handle === this.handleId) this._receive(Uint8Array.from(p.data));
      }),
      await listen('serial://closed', (p) => {
        if (p.handle === this.handleId) this._remoteClosed(p.reason ?? 'Serial port closed');
      }),
    );
  }

  async _close() {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    if (this.handleId) await invoke('serial_close', { handle: this.handleId }).catch(() => {});
    this.handleId = null;
  }

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    await invoke('serial_write', { handle: this.handleId, data: Array.from(bytes) });
  }
}
