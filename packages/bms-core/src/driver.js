import { Emitter } from '@ubms/transport';
import { deriveSnapshot } from './model.js';
import { msg } from './msg.js';

/**
 * Driver contract.
 *
 * A *driver definition* is static metadata plus a factory. It says which links the protocol can
 * use (BLE GATT profiles, serial settings), how to recognise devices by name, and creates driver
 * instances bound to an open Link.
 *
 * A *driver instance* speaks the protocol on one Link: it probes the device, produces snapshots,
 * reads device information, and reads/writes settings described by a declarative schema.
 *
 * @typedef {import('@ubms/transport/web-bluetooth').BleChannelProfile & { id: string, label?: string }} BleProfile
 * @typedef {import('@ubms/transport/web-serial').SerialOptions & { id: string, label?: string }} SerialProfile
 *
 * @typedef {Object} BleRequirements
 * @property {BleProfile[]} profiles GATT profiles the protocol can run on
 * @property {string[]} [namePrefixes] advertised name prefixes (chooser filters)
 * @property {RegExp[]} [namePatterns] name patterns used to rank candidates during detection
 * @property {(string|number)[]} [advertisedServices] services the device advertises (chooser filters)
 * @property {number[]} [manufacturerIds] company ids in manufacturer data (chooser filters)
 * @property {(string|number)[]} [optionalServices] extra services to request access to (not used as
 *   channel profiles, for example vendor configuration services)
 *
 * @typedef {Object} SerialRequirements
 * @property {SerialProfile[]} profiles serial settings to try, most likely first
 * @property {string} [note] English hint about wiring / adapters
 * @property {boolean} [autoDetect] false keeps the definition out of automatic and family wide
 *   serial detection: its probe would disturb other devices (for example SLCAN commands for a
 *   USB-CAN adapter) or other probes would disturb its adapter. It is tried only when the user
 *   selects this driver explicitly.
 *
 * @typedef {Object} DriverDefinition
 * @property {string} id unique id, for example 'jk-ble'
 * @property {string} family brand family shown in the type selector: 'jk', 'ant', 'daly'
 * @property {string} vendor display name of the brand
 * @property {string} protocol English protocol label, for example 'JK02 (Bluetooth)'
 * @property {'bms'|'balancer'|'meter'} deviceType 'meter' covers power meters and electronic loads
 *   (no cells); the UI renders only what the snapshot contains
 * @property {string} [description] English
 * @property {{ ble?: BleRequirements, serial?: SerialRequirements }} links
 * @property {(ctx: DriverContext) => BaseDriver} create
 * @property {boolean} [experimental]
 *
 * @typedef {Object} DriverContext
 * @property {import('@ubms/transport').Link} link an open link
 * @property {import('@ubms/transport').ProtocolLog} log
 * @property {string} [profileId] BLE or serial profile that was opened
 * @property {Record<string, any>} [options] user options (for example RS485 device address). The
 *   same object is passed to every driver instance created for one connection target (detection
 *   candidates, reconnects), so drivers may keep app-local values such as passwords in it.
 *
 * @typedef {Object} ProbeResult
 * @property {string} [variant] protocol variant detected (for example 'JK02_32S')
 * @property {number} [confidence] 0..1
 * @property {Partial<import('./model.js').DeviceInfo>} [info]
 *
 * @typedef {Object} DriverCapabilities
 * @property {boolean} settings the driver can read settings
 * @property {boolean} writeSettings the driver can write settings
 * @property {boolean} streaming the device pushes data without polling
 * @property {number} pollIntervalMs recommended poll interval
 * @property {number} [minPollIntervalMs]
 */

/**
 * Base class for driver instances. Events: `snapshot`, `info`, `settings`, `variant`.
 */
export class BaseDriver extends Emitter {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super();
    this.definition = definition;
    this.ctx = ctx;
    this.link = ctx.link;
    this.log = ctx.log;
    /** @type {string | undefined} */
    this.variant = undefined;
    /** @type {import('./model.js').BmsSnapshot | null} */
    this.lastSnapshot = null;
    /** @type {import('./model.js').DeviceInfo | null} */
    this.lastInfo = null;
    /**
     * Set by readSettings() when values are missing for a known reason (English, msg() literal),
     * for example a device that answered every parameter read with empty pages. The session
     * clears it before each read and shows it with the values.
     * @type {string | null}
     */
    this.settingsNotice = null;
  }

  /** @returns {DriverCapabilities} */
  get capabilities() {
    return { settings: false, writeSettings: false, streaming: false, pollIntervalMs: 1000 };
  }

  /**
   * Check that the device speaks this protocol. Must not change device state.
   * @param {{ timeout?: number }} [_opts]
   * @returns {Promise<ProbeResult | null>}
   */
  async probe(_opts) {
    return null;
  }

  /** Begin streaming or prepare polling (called once after a successful probe). */
  async start() {}

  /** Request fresh data; emits `snapshot` when complete. */
  async poll() {}

  /** Stop streaming, release resources (does not close the link). */
  async stop() {}

  /** @returns {Promise<import('./model.js').DeviceInfo | null>} */
  async readInfo() {
    return this.lastInfo;
  }

  /** @returns {import('./settings.js').SettingsSchema | null} */
  getSettingsSchema() {
    return null;
  }

  /** @returns {Promise<Record<string, any>>} */
  async readSettings() {
    throw new Error(msg('Settings are not supported by this driver'));
  }

  /**
   * @param {string} _id
   * @param {any} _value engineering units
   * @returns {Promise<void>}
   */
  async writeSetting(_id, _value) {
    throw new Error(msg('Writing settings is not supported by this driver'));
  }

  /**
   * Run an action field (type 'action'), for example restart or factory reset.
   * @param {string} _id
   * @param {any} [_arg]
   * @returns {Promise<void>}
   */
  async runAction(_id, _arg) {
    throw new Error(msg('Actions are not supported by this driver'));
  }

  /**
   * Publish a snapshot (derived values are added here).
   * @param {Omit<import('./model.js').BmsSnapshot, 'timestamp'> & { timestamp?: number }} s
   */
  publish(s) {
    const snap = deriveSnapshot({ ...s, timestamp: s.timestamp ?? Date.now() });
    this.lastSnapshot = snap;
    this.emit('snapshot', snap);
    return snap;
  }

  /** @param {import('./model.js').DeviceInfo} info */
  publishInfo(info) {
    this.lastInfo = { ...(this.lastInfo ?? {}), ...info };
    this.emit('info', this.lastInfo);
    return this.lastInfo;
  }

  /** @param {string} variant */
  setVariant(variant) {
    if (this.variant === variant) return;
    this.variant = variant;
    this.log?.event(`Protocol variant: ${variant}`, { source: this.definition.id });
    this.emit('variant', variant);
  }

  dispose() {
    this.removeAllListeners();
  }
}
