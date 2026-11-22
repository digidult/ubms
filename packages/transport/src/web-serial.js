import { Link } from './link.js';
import { msg } from './msg.js';

/**
 * Web Serial transport (USB-UART / RS485 adapters, Chrome and Edge on desktop; Android Chrome
 * supports it in recent versions).
 *
 * The browser cannot tell which device sits behind a USB-UART adapter, so filtering by BMS type is
 * impossible: the chooser can only be narrowed to known adapter chips.
 *
 * @typedef {Object} SerialOptions
 * @property {number} baudRate
 * @property {7|8} [dataBits]
 * @property {1|2} [stopBits]
 * @property {'none'|'even'|'odd'} [parity]
 * @property {'none'|'hardware'} [flowControl]
 * @property {number} [bufferSize]
 * @property {{ dataTerminalReady?: boolean, requestToSend?: boolean, break?: boolean }} [signals]
 *   output signals applied after opening (some isolated RS485 adapters need DTR/RTS)
 */

/** Common USB-UART bridge chips, used for naming and as optional chooser filters. */
export const USB_SERIAL_ADAPTERS = [
  { usbVendorId: 0x1a86, usbProductId: 0x7523, name: 'CH340' },
  { usbVendorId: 0x1a86, usbProductId: 0x5523, name: 'CH341' },
  { usbVendorId: 0x1a86, usbProductId: 0x55d4, name: 'CH9102' },
  { usbVendorId: 0x1a86, usbProductId: 0x55d3, name: 'CH343' },
  { usbVendorId: 0x10c4, usbProductId: 0xea60, name: 'CP210x' },
  { usbVendorId: 0x0403, usbProductId: 0x6001, name: 'FT232R' },
  { usbVendorId: 0x0403, usbProductId: 0x6015, name: 'FT231X' },
  { usbVendorId: 0x0403, usbProductId: 0x6010, name: 'FT2232' },
  { usbVendorId: 0x067b, usbProductId: 0x2303, name: 'PL2303' },
  { usbVendorId: 0x067b, usbProductId: 0x23a3, name: 'PL2303GC' },
];

/** @returns {any} */
function serial() {
  return typeof navigator !== 'undefined' ? /** @type {any} */ (navigator).serial : undefined;
}

let portCounter = 0;

/** One wrapper per SerialPort object, so a port keeps its id for the lifetime of the page. */
const portWrappers = new WeakMap();

/**
 * Differs on every page load. Web Serial exposes no serial number, so ports that cannot be told
 * apart (no USB ids, or several granted ports with the same USB ids) get ids with this token: an id
 * remembered on an earlier page then never selects another adapter of the same type.
 */
const pageToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** @param {any} port SerialPort @returns {{ usbVendorId?: number, usbProductId?: number }} */
function portInfo(port) {
  try {
    return port.getInfo?.() ?? {};
  } catch {
    return {};
  }
}

/** `usb-<vendor>-<product>`, or '' when the port has no USB ids. @param {any} port */
function usbKey(port) {
  const { usbVendorId, usbProductId } = portInfo(port);
  return usbVendorId ? `usb-${usbVendorId.toString(16)}-${usbProductId?.toString(16)}` : '';
}

export class WebSerialProvider {
  /** @param {{ log?: import('./log.js').ProtocolLog }} [opts] */
  constructor({ log } = {}) {
    this.id = 'web-serial';
    this.kind = 'serial';
    this.log = log;
  }

  /** @returns {Promise<{ available: boolean, reason?: string }>} */
  async availability() {
    if (typeof window !== 'undefined' && window.isSecureContext === false) return { available: false, reason: 'insecure-context' };
    if (!serial()) return { available: false, reason: 'unsupported' };
    return { available: true };
  }

  /**
   * Show the browser port chooser.
   * @param {{ adaptersOnly?: boolean }} [opts] restrict the chooser to known USB-UART chips
   * @returns {Promise<WebSerialPort>}
   */
  async request({ adaptersOnly = false } = {}) {
    const s = serial();
    if (!s) throw new Error(msg('This browser cannot open serial ports'));
    const filters = adaptersOnly ? USB_SERIAL_ADAPTERS.map(({ usbVendorId, usbProductId }) => ({ usbVendorId, usbProductId })) : [];
    this.log?.event(`Requesting serial port${adaptersOnly ? ' (known USB-UART adapters only)' : ''}`);
    const port = await s.requestPort(filters.length ? { filters } : {});
    /** @type {any[]} */
    let granted = [];
    try {
      granted = await s.getPorts();
    } catch {
      /* without the list the port counts as ambiguous */
    }
    return this.#wrap([port, ...granted], granted)[0];
  }

  /** Ports this origin was already granted. @returns {Promise<WebSerialPort[]>} */
  async known() {
    const s = serial();
    if (!s) return [];
    try {
      const ports = await s.getPorts();
      return this.#wrap(ports, ports);
    } catch {
      return [];
    }
  }

  /**
   * Return the wrapper of each port and mark the ports that are the only granted one with their
   * USB ids: their id stays the same across page loads.
   * @param {any[]} ports SerialPort objects
   * @param {any[]} granted every port this origin may use
   * @returns {WebSerialPort[]}
   */
  #wrap(ports, granted) {
    return ports.map((port) => {
      let handle = portWrappers.get(port);
      if (!handle) {
        handle = new WebSerialPort(port, this.log);
        portWrappers.set(port, handle);
      }
      const key = usbKey(port);
      handle.unique = !!key && granted.includes(port) && !granted.some((p) => p !== port && usbKey(p) === key);
      return handle;
    });
  }
}

export class WebSerialPort {
  /** @param {any} port SerialPort @param {import('./log.js').ProtocolLog} [log] */
  constructor(port, log) {
    this.port = port;
    this.log = log;
    this.kind = 'serial';
    this.serial = ++portCounter;
    /** Set by the provider while no other granted port has the same USB ids. */
    this.unique = false;
  }

  get info() {
    return portInfo(this.port);
  }

  /**
   * `usb-<vendor>-<product>` for the only granted port with these USB ids (stable across page
   * loads), otherwise an id that is valid for this page only.
   */
  get id() {
    const key = usbKey(this.port);
    return key && this.unique ? key : `${key || 'serial'}-${pageToken}-${this.serial}`;
  }

  get name() {
    const { usbVendorId, usbProductId } = this.info;
    if (usbVendorId === undefined) return 'Serial port';
    const known = USB_SERIAL_ADAPTERS.find((a) => a.usbVendorId === usbVendorId && a.usbProductId === usbProductId);
    const ids = `${usbVendorId.toString(16).padStart(4, '0')}:${(usbProductId ?? 0).toString(16).padStart(4, '0')}`;
    return known ? `${known.name} (${ids})` : `USB serial (${ids})`;
  }

  describe() {
    return { kind: 'serial', id: this.id, name: this.name, ...this.info };
  }

  /**
   * Open the port and return an open Link. Close the link before reopening with other options.
   * @param {SerialOptions} options
   * @returns {Promise<WebSerialLink>}
   */
  async openLink(options) {
    const link = new WebSerialLink(this, options, this.log);
    await link.open();
    return link;
  }
}

export class WebSerialLink extends Link {
  /**
   * @param {WebSerialPort} handle
   * @param {SerialOptions} options
   * @param {import('./log.js').ProtocolLog} [log]
   */
  constructor(handle, options, log) {
    super({ kind: 'serial', name: `${handle.name} @ ${options.baudRate}`, log });
    this.handle = handle;
    this.options = options;
    /** @type {any} */
    this.reader = null;
    /** @type {Promise<void> | null} */
    this.readLoop = null;
    this.closing = false;
    /** True while this link holds the port open, so a failed open never closes a port it did not open. */
    this.portOpen = false;
    /** @param {any} e */
    this.onDisconnect = (e) => {
      if (e.target === this.handle.port || e.port === this.handle.port) this._remoteClosed(msg('Serial port disconnected'));
    };
  }

  describe() {
    return { ...super.describe(), ...this.options, ...this.handle.info };
  }

  async _open() {
    const { signals, ...rest } = this.options;
    const port = this.handle.port;
    await port.open({ dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096, ...rest });
    this.portOpen = true;
    if (signals && port.setSignals) {
      try {
        await port.setSignals(signals);
      } catch (err) {
        this.log?.warn(`Cannot set serial signals: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.closing = false;
    serial()?.addEventListener?.('disconnect', this.onDisconnect);
    this.readLoop = this.#read();
  }

  async #read() {
    const port = this.handle.port;
    while (port.readable && !this.closing) {
      this.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value?.length) this._receive(value);
        }
      } catch (err) {
        // Framing/parity/buffer-overrun errors are recoverable: the loop gets a fresh reader.
        if (!this.closing) this.log?.warn(`Serial read error: ${err instanceof Error ? err.message : err}`, { source: this.id });
      } finally {
        try {
          this.reader.releaseLock();
        } catch {
          /* ignore */
        }
        this.reader = null;
      }
    }
    if (!this.closing) this._remoteClosed(msg('Serial stream ended'));
  }

  /** @param {Uint8Array} bytes */
  async _write(bytes) {
    const writer = this.handle.port.writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  async _close() {
    this.closing = true;
    serial()?.removeEventListener?.('disconnect', this.onDisconnect);
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      await this.readLoop;
    } catch {
      /* ignore */
    }
    if (!this.portOpen) return;
    this.portOpen = false;
    try {
      await this.handle.port.close();
    } catch (err) {
      this.log?.debug(`Serial close: ${err instanceof Error ? err.message : err}`);
    }
  }
}
