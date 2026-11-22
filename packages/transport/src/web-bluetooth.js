import { Emitter } from './emitter.js';
import { Link, withTimeout, sleep } from './link.js';
import { canonicalUuid, toBytes } from './bytes.js';
import { msg } from './msg.js';

/**
 * Web Bluetooth transport.
 *
 * Flow: provider.request() shows the browser chooser and returns a device handle,
 * handle.connect() opens GATT, handle.discover() lists the services the page may access,
 * handle.openChannel(profile) returns an open Link bound to a notify/write characteristic pair.
 *
 * Note: Web Bluetooth only exposes services listed in the request `filters` or `optionalServices`,
 * so the caller must pass every service any candidate driver might use.
 *
 * @typedef {Object} BleFilter
 * @property {string} [name]
 * @property {string} [namePrefix]
 * @property {(string|number)[]} [services]
 * @property {{ companyIdentifier: number, dataPrefix?: Uint8Array, mask?: Uint8Array }[]} [manufacturerData]
 *
 * @typedef {Object} BleRequestOptions
 * @property {BleFilter[]} [filters]
 * @property {(string|number)[]} [optionalServices]
 * @property {number[]} [optionalManufacturerData]
 * @property {boolean} [acceptAllDevices]
 *
 * @typedef {Object} BleChannelProfile
 * @property {string|number} service
 * @property {string|number} notify characteristic delivering notifications
 * @property {string|number} write characteristic used for writes (may equal `notify`)
 * @property {'auto'|'with-response'|'without-response'|'prefer-without-response'} [writeMode]
 *   'auto' uses write with response when the characteristic supports it;
 *   'prefer-without-response' uses write without response when supported, otherwise with response
 * @property {number} [chunkSize] max bytes per GATT write (default 20, safe without MTU exchange)
 * @property {number} [chunkDelayMs]
 *
 * @typedef {Object} BleServiceInfo
 * @property {string} uuid canonical 128-bit
 * @property {{ uuid: string, properties: Record<string, boolean> }[]} characteristics
 */

/** @returns {any} */
function bluetooth() {
  return typeof navigator !== 'undefined' ? /** @type {any} */ (navigator).bluetooth : undefined;
}

/** One wrapper per BluetoothDevice, so repeated request() and known() calls do not stack listeners. */
const deviceWrappers = new WeakMap();

/** Longest wait for an advertisement before connecting to a device from getDevices(). */
const ADVERTISEMENT_WAIT_MS = 10000;

function cancelledError() {
  const err = new Error(msg('Connection cancelled'));
  /** @type {any} */ (err).code = 'cancelled';
  return err;
}

export class WebBluetoothProvider {
  /** @param {{ log?: import('./log.js').ProtocolLog }} [opts] */
  constructor({ log } = {}) {
    this.id = 'web-bluetooth';
    this.kind = 'ble';
    this.log = log;
  }

  /** @returns {Promise<{ available: boolean, reason?: string }>} */
  async availability() {
    if (typeof window !== 'undefined' && window.isSecureContext === false) return { available: false, reason: 'insecure-context' };
    const bt = bluetooth();
    if (!bt) return { available: false, reason: 'unsupported' };
    try {
      if (typeof bt.getAvailability === 'function' && (await bt.getAvailability()) === false) {
        return { available: false, reason: 'adapter-unavailable' };
      }
    } catch {
      /* some browsers throw here; requestDevice will report the real problem */
    }
    return { available: true };
  }

  /**
   * Show the browser device chooser.
   * @param {BleRequestOptions} options
   * @returns {Promise<WebBleDevice>}
   */
  async request(options) {
    const bt = bluetooth();
    if (!bt) throw new Error(msg('This browser cannot use Bluetooth devices'));
    const req = /** @type {any} */ ({});
    const optionalServices = [...new Set((options.optionalServices ?? []).map(canonicalUuid))];
    if (options.acceptAllDevices || !options.filters?.length) {
      req.acceptAllDevices = true;
    } else {
      req.filters = options.filters.map((f) => {
        const out = /** @type {any} */ ({});
        if (f.name) out.name = f.name;
        if (f.namePrefix) out.namePrefix = f.namePrefix;
        if (f.services?.length) out.services = f.services.map(canonicalUuid);
        if (f.manufacturerData?.length) out.manufacturerData = f.manufacturerData;
        return out;
      });
    }
    if (optionalServices.length) req.optionalServices = optionalServices;
    if (options.optionalManufacturerData?.length) req.optionalManufacturerData = options.optionalManufacturerData;
    this.log?.event(`Requesting Bluetooth device (${req.acceptAllDevices ? 'all devices' : `${req.filters.length} filter(s)`})`);
    const device = await bt.requestDevice(req);
    return this.#wrap(device, false);
  }

  /**
   * Devices this origin was already granted (no chooser). Empty when the browser lacks getDevices().
   * @returns {Promise<WebBleDevice[]>}
   */
  async known() {
    const bt = bluetooth();
    if (!bt?.getDevices) return [];
    try {
      const devices = await bt.getDevices();
      return devices.map((/** @type {any} */ d) => this.#wrap(d, true));
    } catch {
      return [];
    }
  }

  /**
   * @param {any} device BluetoothDevice
   * @param {boolean} granted the device comes from getDevices(): the browser may not have seen it
   *   since it started, so the first connect waits for an advertisement
   * @returns {WebBleDevice}
   */
  #wrap(device, granted) {
    let handle = deviceWrappers.get(device);
    if (!handle) {
      handle = new WebBleDevice(device, this.log);
      handle.awaitAdvertisement = granted;
      deviceWrappers.set(device, handle);
    }
    return handle;
  }
}

/**
 * Handle to one Bluetooth device. Emits `disconnect` when GATT drops.
 */
export class WebBleDevice extends Emitter {
  /** @param {any} device BluetoothDevice @param {import('./log.js').ProtocolLog} [log] */
  constructor(device, log) {
    super();
    this.device = device;
    this.log = log;
    this.kind = 'ble';
    /** @type {any} */
    this.server = null;
    /** Wait for an advertisement before the next GATT connect (devices from getDevices()). */
    this.awaitAdvertisement = false;
    /** Counts disconnect() calls: a connect that started before one gives up instead of retrying. */
    this.epoch = 0;
    /** Connects started since the last disconnect() that are still running. */
    this.liveConnects = 0;
    /** @type {Set<() => void>} rejects the steps of connects in progress; disconnect() calls them */
    this.cancels = new Set();
    this.onDisconnected = () => {
      this.log?.warn(`Bluetooth device disconnected: ${this.name}`);
      this.emit('disconnect', { reason: 'gatt-disconnected' });
    };
    device.addEventListener('gattserverdisconnected', this.onDisconnected);
  }

  get id() {
    return this.device.id;
  }

  get name() {
    return this.device.name || 'Unnamed device';
  }

  get connected() {
    return !!this.device.gatt?.connected;
  }

  describe() {
    return { kind: 'ble', id: this.id, name: this.name };
  }

  /**
   * Connect with up to `attempts` tries. disconnect() cancels a connect in progress: it rejects
   * with code 'cancelled' at once and makes no further attempt.
   * @param {{ timeoutMs?: number, attempts?: number }} [opts]
   */
  async connect({ timeoutMs = 20000, attempts = 2 } = {}) {
    if (this.connected) return;
    const epoch = this.epoch;
    this.liveConnects++;
    try {
      if (this.awaitAdvertisement) await this.#watchAdvertisement(timeoutMs, epoch);
      let lastErr;
      for (let i = 1; i <= attempts; i++) {
        if (epoch !== this.epoch) break;
        let abandoned = false;
        try {
          this.log?.event(`Connecting GATT to ${this.name} (attempt ${i}/${attempts})`);
          const pending = this.device.gatt.connect();
          // Browsers may finish a connect that disconnect() could not abort: release it then.
          Promise.resolve(pending).then(
            () => abandoned && this.#dropStale(),
            () => {},
          );
          const server = await this.#unlessCancelled(withTimeout(pending, timeoutMs, msg('Bluetooth connection timed out')), epoch);
          if (epoch !== this.epoch) {
            abandoned = true;
            this.#dropStale();
            break;
          }
          this.server = server;
          this.awaitAdvertisement = false;
          this.log?.event(`GATT connected: ${this.name}`);
          return;
        } catch (err) {
          lastErr = err;
          if (epoch !== this.epoch) {
            // Leave the shared GATT object alone: a newer connect to this device may be running.
            abandoned = true;
            break;
          }
          this.log?.warn(`GATT connect failed: ${err instanceof Error ? err.message : err}`);
          try {
            this.device.gatt.disconnect();
          } catch {
            /* ignore */
          }
          if (i < attempts) await sleep(600);
        }
      }
      if (epoch !== this.epoch) throw cancelledError();
      throw lastErr;
    } finally {
      if (epoch === this.epoch) this.liveConnects--;
    }
  }

  /**
   * `promise`, or a rejection with code 'cancelled' as soon as disconnect() runs.
   * @template T @param {Promise<T>} promise @param {number} epoch @returns {Promise<T>}
   */
  #unlessCancelled(promise, epoch) {
    if (epoch !== this.epoch) {
      promise.catch(() => {});
      return Promise.reject(cancelledError());
    }
    /** @type {() => void} */
    let cancel = () => {};
    const cancelled = new Promise((_, reject) => {
      cancel = () => reject(cancelledError());
    });
    this.cancels.add(cancel);
    return /** @type {Promise<T>} */ (Promise.race([promise, cancelled])).finally(() => this.cancels.delete(cancel));
  }

  /** A cancelled connect completed anyway: drop it unless a newer connect owns the link. */
  #dropStale() {
    if (this.liveConnects > 0 || this.server) return;
    try {
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    } catch {
      /* ignore */
    }
  }

  /**
   * Chrome connects only to devices it has seen since it started, so gatt.connect() on a device from
   * getDevices() can fail with "Bluetooth Device is no longer in range". Wait for one advertisement
   * first, as Chrome's samples do. Does nothing without watchAdvertisements() support. disconnect()
   * ends the wait.
   * @param {number} timeoutMs connect timeout, which also bounds the wait
   * @param {number} epoch the connect's epoch
   */
  async #watchAdvertisement(timeoutMs, epoch) {
    const device = this.device;
    if (typeof device.watchAdvertisements !== 'function') return;
    const ms = timeoutMs > 0 ? Math.min(timeoutMs, ADVERTISEMENT_WAIT_MS) : ADVERTISEMENT_WAIT_MS;
    const abort = new AbortController();
    /** @type {() => void} */
    let onAdvertisement = () => {};
    const seen = new Promise((resolve) => {
      onAdvertisement = () => resolve(true);
    });
    device.addEventListener('advertisementreceived', onAdvertisement);
    try {
      this.log?.event(`Waiting for an advertisement from ${this.name}`);
      await this.#unlessCancelled(withTimeout(Promise.all([device.watchAdvertisements({ signal: abort.signal }), seen]), ms), epoch);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code === 'cancelled') return;
      if (code === 'TIMEOUT') this.log?.warn(`No advertisement from ${this.name}, connecting anyway`);
      else this.log?.debug(`Cannot watch advertisements: ${err instanceof Error ? err.message : err}`);
    } finally {
      device.removeEventListener('advertisementreceived', onAdvertisement);
      abort.abort();
    }
  }

  /**
   * List accessible services and their characteristics.
   * @returns {Promise<BleServiceInfo[]>}
   */
  async discover() {
    if (!this.connected) await this.connect();
    const services = await this.device.gatt.getPrimaryServices();
    /** @type {BleServiceInfo[]} */
    const out = [];
    for (const s of services) {
      /** @type {BleServiceInfo['characteristics']} */
      let chars = [];
      try {
        const list = await s.getCharacteristics();
        chars = list.map((/** @type {any} */ c) => ({
          uuid: c.uuid,
          properties: {
            read: !!c.properties.read,
            write: !!c.properties.write,
            writeWithoutResponse: !!c.properties.writeWithoutResponse,
            notify: !!c.properties.notify,
            indicate: !!c.properties.indicate,
          },
        }));
      } catch (err) {
        this.log?.debug(`Cannot list characteristics of ${s.uuid}: ${err instanceof Error ? err.message : err}`);
      }
      out.push({ uuid: s.uuid, characteristics: chars });
    }
    this.log?.event(`Services: ${out.map((s) => s.uuid.slice(4, 8)).join(', ') || 'none'}`);
    return out;
  }

  /**
   * Open a byte channel on a notify/write characteristic pair.
   * @param {BleChannelProfile} profile
   * @returns {Promise<WebBleLink>}
   */
  async openChannel(profile) {
    if (!this.connected) await this.connect();
    const link = new WebBleLink(this, profile, this.log);
    await link.open();
    return link;
  }

  /** Also cancels a connect in progress. */
  async disconnect() {
    this.epoch++;
    this.liveConnects = 0;
    this.server = null;
    for (const cancel of [...this.cancels]) cancel();
    try {
      // Without a link this does nothing; where the browser supports it, it aborts a pending connect.
      this.device.gatt?.disconnect();
    } catch {
      /* ignore */
    }
  }

  dispose() {
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.removeAllListeners();
    if (deviceWrappers.get(this.device) === this) deviceWrappers.delete(this.device);
  }
}

export class WebBleLink extends Link {
  /**
   * @param {WebBleDevice} handle
   * @param {BleChannelProfile} profile
   * @param {import('./log.js').ProtocolLog} [log]
   */
  constructor(handle, profile, log) {
    super({ kind: 'ble', name: handle.name, log, chunkSize: profile.chunkSize ?? 20, chunkDelayMs: profile.chunkDelayMs ?? 0 });
    this.handle = handle;
    this.profile = profile;
    /** @type {any} */
    this.notifyChar = null;
    /** @type {any} */
    this.writeChar = null;
    /** @param {any} event */
    this.onValue = (event) => this._receive(toBytes(event.target.value));
    this.offDisconnect = () => {};
  }

  describe() {
    return {
      ...super.describe(),
      service: canonicalUuid(this.profile.service),
      notify: canonicalUuid(this.profile.notify),
      write: canonicalUuid(this.profile.write),
    };
  }

  async _open() {
    const gatt = this.handle.device.gatt;
    const service = await gatt.getPrimaryService(canonicalUuid(this.profile.service));
    // Some modules expose two characteristics with the same UUID (for example JK BMS: FFE1 for
    // writing and another FFE1 for notifications), so list all matches and pick by properties.
    const all = async (/** @type {string} */ uuid) => {
      try {
        const list = await service.getCharacteristics(uuid);
        if (list?.length) return list;
      } catch {
        /* fall back to the single lookup below */
      }
      return [await service.getCharacteristic(uuid)];
    };
    const notifyUuid = canonicalUuid(this.profile.notify);
    const writeUuid = canonicalUuid(this.profile.write);
    const notifyList = await all(notifyUuid);
    const writeList = writeUuid === notifyUuid ? notifyList : await all(writeUuid);
    this.notifyChar = notifyList.find((/** @type {any} */ c) => c.properties.notify || c.properties.indicate) ?? notifyList[0];
    this.writeChar = writeList.find((/** @type {any} */ c) => c.properties.write || c.properties.writeWithoutResponse) ?? writeList[0];
    if (notifyList.length > 1 || writeList.length > 1) {
      this.log?.debug(`Several characteristics share a UUID; notify and write were chosen by their properties`, { source: this.id });
    }
    this.notifyChar.addEventListener('characteristicvaluechanged', this.onValue);
    await this.notifyChar.startNotifications();
    this.offDisconnect = this.handle.on('disconnect', () => this._remoteClosed(msg('Bluetooth disconnected')));
  }

  async _close() {
    this.offDisconnect();
    try {
      this.notifyChar?.removeEventListener('characteristicvaluechanged', this.onValue);
      if (this.handle.connected) await this.notifyChar?.stopNotifications();
    } catch {
      /* the device may already be gone */
    }
  }

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    const c = this.writeChar;
    const mode = this.profile.writeMode ?? 'auto';
    const withoutResponse =
      mode === 'without-response' ||
      (mode === 'prefer-without-response' && c.properties.writeWithoutResponse) ||
      (mode === 'auto' && c.properties.writeWithoutResponse && !c.properties.write);
    if (withoutResponse && c.writeValueWithoutResponse) return c.writeValueWithoutResponse(bytes);
    if (c.writeValueWithResponse) return c.writeValueWithResponse(bytes);
    return c.writeValue(bytes);
  }
}
