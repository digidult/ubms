import { BaseDriver, msg, fieldMap } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import { alarmsFromBits, r, ymd } from '../common/util.js';
import {
  DATA_FRAME_LENGTH,
  FRAME_TYPE,
  JK_ALARM_BITS,
  PB_DEFAULT_ADDRESS,
  PB_TRIGGER,
  PB_TRIGGER_TYPE,
  UART_CMD,
  UART_SOURCE,
  UART_WARNING_BITS,
  VARIANT,
  cellInfoProblem,
  createBleAssembler,
  createPbAssembler,
  createUartAssembler,
  describe,
  deviceInfoRequest,
  encodeCommand,
  encodeWrite,
  isAckFrame,
  isDataFrameOfType,
  isModbusException,
  isPbWriteAck,
  isUartReadReply,
  looksLikeJk04CellInfo,
  looksLikeJk04Settings,
  parseCellInfo,
  parseDeviceInfo,
  parseEventLog,
  parseJk04CellInfo,
  parseSettings,
  parseUartFrame,
  pbTriggerRequest,
  settingsRequest,
  softwareMajor,
  splitUartVersion,
  uartReadAll,
  uartSwitchWrite,
} from './protocol.js';
import { BATTERY_TYPES, bleWriteFrame, buildJkSchema, buildJkUartSchema, decodeJkSettings, guardProblem, pbWriteFrame } from './settings.js';
import { createJkSimulator } from './simulator.js';

/**
 * JK BMS drivers (docs/protocols/jk.md):
 * - `jk-ble`: JK02_24S, JK02_32S and JK04 over Bluetooth. The BMS streams cell info frames after
 *   a settings request (0x96), so the driver publishes from the stream and `poll()` is a watchdog.
 * - `jk-pb-rs485`: JK-PB over RS485 with the Modbus FC 0x10 trigger requests that return
 *   JK02_32S frames, settings written as Modbus FC 0x10 registers.
 * - `jk-uart`: the JK-B "4E 57" protocol on the UART / RS485 port.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 */

export const JK_VENDOR = 'JK BMS';

/** Labels of the battery temperature sensors (literal for the translation checker). */
const TEMP_LABELS = [msg('Temperature 1'), msg('Temperature 2'), msg('Temperature 3'), msg('Temperature 4'), msg('Temperature 5')];

/** Balancer action (C140 / C172, JK04 byte 220), spec 9.6. */
const BALANCER_STATES = /** @type {Record<number, string>} */ ({ 0: msg('Off'), 1: msg('Charging balancer'), 2: msg('Discharging balancer') });
/** Charge stage (C280, firmware 15 and later), spec 9.6. */
const CHARGE_STAGES = /** @type {Record<number, string>} */ ({ 0: msg('Bulk'), 1: msg('Absorption'), 2: msg('Float') });

const VARIANT_UNCONFIRMED = msg('The protocol variant is not confirmed yet, so nothing is written. Wait for live data and try again.');

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/** @param {number} v */
const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** Sleep until a point in time (no-op when it has passed). @param {number} at epoch ms */
const waitUntil = (at) => {
  const ms = at - Date.now();
  return ms > 0 ? sleep(ms) : Promise.resolve();
};

/**
 * Drop undefined properties.
 * @template {Record<string, any>} T
 * @param {T} o
 * @returns {T}
 */
function compact(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/**
 * Cell numbers (1-based) of a bit mask, for display.
 * @param {number} mask
 */
const cellList = (mask) => {
  const out = [];
  for (let b = 0; b < 32; b++) if (((mask >>> b) & 1) === 1) out.push(b + 1);
  return out.join(', ');
};

// ---------------------------------------------------------------------------------------------
// Snapshot and device info mapping
// ---------------------------------------------------------------------------------------------

/**
 * Unified snapshot from a JK02 cell info frame (spec 6.1, 9). JK reports current positive while
 * charging, like the model; power is voltage x current because the frame's power has no sign.
 * @param {Record<string, any>} c parsed cell info
 * @param {{ variant?: string, settings?: Record<string, any> | null, firmwareMajor?: number }} [opts]
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function jk02Snapshot(c, { variant = VARIANT.JK02_32S, settings = null, firmwareMajor = NaN } = {}) {
  const is32 = variant !== VARIANT.JK02_24S;
  // Presence bits (spec 9.4) are used on JK02_32S only: the JK02_24S mapping is unverified.
  // A raw -2000 (null after parsing) always means "no sensor".
  const mask = c.temperatureSensorMask;
  const useMask = is32 && Number.isInteger(mask) && mask !== 0;
  /** @type {TemperatureReading[]} */
  const temperatures = [];
  /** @param {string} id @param {string} label @param {number|null|undefined} value @param {TemperatureReading['kind']} kind @param {number} bit */
  const add = (id, label, value, kind, bit) => {
    if (value === null || value === undefined) return;
    if (useMask && ((mask >>> bit) & 1) === 0) return;
    temperatures.push({ id, label, value, kind });
  };
  add('mos', msg('MOSFET temperature'), c.temperatureMos, 'mos', 0);
  add('t1', TEMP_LABELS[0], c.temperature1, 'cell', 1);
  add('t2', TEMP_LABELS[1], c.temperature2, 'cell', 2);
  if (is32) {
    add('t3', TEMP_LABELS[2], c.temperature3, 'cell', 3);
    // C256 and C258 exist from software 14 on ([AIO] `_temp_pos`). Below that they read 0 with
    // all presence bits set (captures of JK-B2A8S20P sw 11.48 [AIO] and 11.50 [BM]), which would
    // show two sensors at 0 degrees C. An unknown version keeps them (mask and -2000 still apply).
    if (!(firmwareMajor < 14)) {
      add('t4', TEMP_LABELS[3], c.temperature4, 'cell', 4);
      add('t5', TEMP_LABELS[4], c.temperature5, 'cell', 5);
    }
  }

  /** @type {Record<string, ExtraValue>} */
  const extra = {
    balancer: { label: msg('Balancer state'), value: BALANCER_STATES[c.balancingAction] ?? String(c.balancingAction) },
    heating: { label: msg('Heating'), value: !!c.heating },
  };
  if (c.heatingCurrent) extra.heatingCurrent = { label: msg('Heating current'), value: c.heatingCurrent, unit: 'A', decimals: 2 };
  if (c.emergencyTimeCountdown > 0) extra.emergency = { label: msg('Emergency mode, time left'), value: c.emergencyTimeCountdown / 60, unit: 'min', decimals: 1 };
  if (is32) {
    // [AIO] reads the charge stage from firmware 15 on (spec 6.1).
    if (firmwareMajor >= 15 && CHARGE_STAGES[c.chargeStatus]) extra.chargeStage = { label: msg('Charge stage'), value: CHARGE_STAGES[c.chargeStatus] };
    extra.chargerPlugged = { label: msg('Charger connected'), value: !!c.chargerPlugged };
    const type = BATTERY_TYPES.find((t) => t.value === c.batteryType);
    if (type) extra.batteryType = { label: msg('Battery type'), value: type.label };
    if (c.timeEnterSleep > 0) extra.timeToSleep = { label: msg('Time until sleep'), value: c.timeEnterSleep / 3600, unit: 'h', decimals: 1 };
    extra.dry1 = { label: msg('Dry contact 1 active'), value: (c.dryContactMask & 0x02) !== 0 };
    extra.dry2 = { label: msg('Dry contact 2 active'), value: (c.dryContactMask & 0x04) !== 0 };
  }
  if (c.wireResistanceWarningMask) extra.wireWarning = { label: msg('Wire resistance warning on cells'), value: cellList(c.wireResistanceWarningMask) };
  const timers = /** @type {Array<[string, string, string]>} */ ([
    ['timerChargeOcpRelease', 'releaseChargeOcp', msg('Charge overcurrent release in')],
    ['timerDischargeOcpRelease', 'releaseDischargeOcp', msg('Discharge overcurrent release in')],
    ['timerChargeScpRelease', 'releaseChargeScp', msg('Charge short circuit release in')],
    ['timerDischargeScpRelease', 'releaseDischargeScp', msg('Discharge short circuit release in')],
    ['timerOvRelease', 'releaseOv', msg('Overvoltage release in')],
    ['timerUvRelease', 'releaseUv', msg('Undervoltage release in')],
  ]);
  for (const [name, key, label] of timers) if (c[name] > 0) extra[key] = { label, value: c[name], unit: 's', decimals: 0 };

  // Charge and discharge: MOSFET states. Balancer and heater: the feature switches of the last
  // settings frame (S126, S282 bit 0), which are what the switch settings write; whether the
  // heater runs right now is the `heating` extra value.
  /** @type {NonNullable<BmsSnapshot['switches']>} */
  const switches = { charge: !!c.chargingMos, discharge: !!c.dischargingMos };
  if (settings && settings.balancerSwitch !== undefined) switches.balance = !!settings.balancerSwitch;
  if (is32) {
    if (settings && settings.heatingEnabled !== undefined) switches.heater = !!settings.heatingEnabled;
    switches.precharge = c.precharging !== 0;
  }

  return compact({
    voltage: c.totalVoltage,
    current: c.current,
    power: c.power,
    soc: c.soc,
    soh: c.soh,
    capacityRemaining: c.capacityRemaining,
    capacityFull: c.fullChargeCapacity > 0 ? c.fullChargeCapacity : undefined,
    capacityNominal: settings?.nominalCapacity > 0 ? settings?.nominalCapacity : undefined,
    cycles: c.cycleCount,
    cycleCapacity: c.totalCycleCapacity,
    uptime: c.totalRuntime,
    cells: c.cellVoltages,
    cellResistances: c.cellResistances.map((/** @type {number} */ v) => r(v * 1000, 3)),
    balancingActive: c.balancingAction !== 0,
    balanceCurrent: c.balanceCurrent,
    temperatures,
    switches,
    alarms: alarmsFromBits(c.errorsBitmask, is32 ? JK_ALARM_BITS : JK_ALARM_BITS.filter((b) => b.bit < 16), 'alarm bit'),
    extra,
  });
}

/**
 * Unified snapshot from a JK04 cell info frame: cells, lead resistances, balancer, runtime. JK04
 * has no pack voltage, current, SOC or temperatures (spec 6.4); the voltage is the cell sum.
 * @param {Record<string, any>} c parsed JK04 cell info
 * @param {{ settings?: Record<string, any> | null }} [opts]
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function jk04Snapshot(c, { settings = null } = {}) {
  return compact({
    voltage: c.totalVoltage,
    uptime: c.totalRuntime,
    cells: c.cellVoltages.map((/** @type {number} */ v) => r(v, 4)),
    cellResistances: c.cellResistances.map((/** @type {number} */ v) => r(v * 1000, 3)),
    balancingActive: c.balancingAction !== 0,
    balanceCurrent: r(c.balanceCurrent, 3),
    switches: settings && settings.balancerSwitch !== undefined ? { balance: !!settings.balancerSwitch } : undefined,
    extra: { balancer: { label: msg('Balancer state'), value: BALANCER_STATES[c.balancingAction] ?? String(c.balancingAction) } },
  });
}

/**
 * Unified snapshot from a 4E57 "read all" reply (spec 6.6, 9.2, 9.3).
 * @param {Record<string, any>} st parsed reply
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function uartSnapshot(st) {
  /** @type {TemperatureReading[]} */
  const temperatures = [];
  if (st.temperatureMos !== undefined) temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: st.temperatureMos, kind: 'mos' });
  if (st.temperature1 !== undefined) temperatures.push({ id: 't1', label: msg('Battery box temperature'), value: st.temperature1, kind: 'ambient' });
  if (st.temperature2 !== undefined) temperatures.push({ id: 't2', label: msg('Battery temperature'), value: st.temperature2, kind: 'cell' });
  const status = st.status ?? 0;
  // Status word 0x8C (spec 9.3): bits 0 and 1 follow the MOSFET switches. Bit 2 is not the balancer
  // switch setting: in the captures it is set only while balancing runs, so it is reported as
  // balancingActive (inferred from captures, [JK4E57] calls it balance switch state) and the switch
  // comes from the setting 0x9D, which is what `switch.balance` writes. Bit 3 ("battery present"
  // in [JK4E57]) is 0 in every capture of a working pack, so it is deliberately not shown.
  /** @type {NonNullable<BmsSnapshot['switches']>} */
  const switches = {};
  if (st.status !== undefined) {
    switches.charge = (status & 1) !== 0;
    switches.discharge = (status & 2) !== 0;
  }
  if (st.balancerSwitch !== undefined) switches.balance = !!st.balancerSwitch;
  return compact({
    voltage: st.totalVoltage,
    current: st.current,
    soc: st.soc,
    cycles: st.cycleCount,
    cycleCapacity: st.totalCycleCapacity,
    capacityNominal: st.capacitySetting > 0 ? st.capacitySetting : undefined,
    uptime: st.systemWorkingMinutes !== undefined ? st.systemWorkingMinutes * 60 : undefined,
    cells: st.cellVoltages,
    temperatures,
    balancingActive: st.status !== undefined ? (status & 4) !== 0 : undefined,
    switches: Object.keys(switches).length ? switches : undefined,
    alarms: alarmsFromBits(st.warnings ?? 0, UART_WARNING_BITS, 'warning bit'),
  });
}

/**
 * Device info from a parsed device info frame (spec 6.3, 10).
 * @param {Record<string, any>} d
 * @param {string} [variant]
 * @returns {DeviceInfo}
 */
export function deviceInfoModel(d, variant) {
  const date = String(d.manufacturingDate ?? '');
  const iso = /^\d{6}$/.test(date) ? ymd(2000 + Number(date.slice(0, 2)), Number(date.slice(2, 4)), Number(date.slice(4, 6))) : date || undefined;
  return compact({
    vendor: JK_VENDOR,
    model: d.model || undefined,
    name: d.deviceName || undefined,
    hardwareVersion: d.hardwareVersion || undefined,
    softwareVersion: d.softwareVersion || undefined,
    serialNumber: d.serialNumber || undefined,
    manufactureDate: iso,
    protocol: variant,
    uptime: d.uptime,
    powerOnCount: d.powerOnCount,
  });
}

/**
 * Device info from a 4E57 reply (spec 10): versions from ID 0xB7, model from 0xBA when it holds
 * one, device ID 0xB4 unless it is the default user data text.
 * @param {Record<string, any>} st
 * @returns {DeviceInfo}
 */
export function uartDeviceInfo(st) {
  const { hardwareVersion, softwareVersion } = splitUartVersion(st.softwareVersion);
  const model = /JK[-_][0-9A-Z]+/.exec(st.manufacturerId ?? '')?.[0];
  const date = String(st.manufacturingDate ?? '');
  return compact({
    vendor: JK_VENDOR,
    model,
    hardwareVersion,
    softwareVersion,
    serialNumber: st.deviceId && !/^Input/i.test(st.deviceId) ? st.deviceId : undefined,
    manufactureDate: /^\d{4}$/.test(date) ? `20${date.slice(0, 2)}-${date.slice(2, 4)}` : date || undefined,
    protocol: VARIANT.UART,
    uptime: st.systemWorkingMinutes !== undefined ? st.systemWorkingMinutes * 60 : undefined,
    extra: st.manufacturerId ? { manufacturerId: { label: msg('Manufacturer ID'), value: st.manufacturerId } } : undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// BLE driver: JK02_24S, JK02_32S, JK04
// ---------------------------------------------------------------------------------------------

/** [BM] waits 0.1 s before every request (spec 4.1 step 2). */
const BLE_SETTLE_MS = 100;
/** A write right after a settings request is acknowledged but dropped (spec 4.2 step 1). */
const WRITE_SETTLE_MS = 1000;
/** Read back about 1 s after a write (spec 4.2 step 3). */
const READBACK_DELAY_MS = 1000;
/** At most about two snapshots per second from the stream. */
const PUBLISH_INTERVAL_MS = 450;
/** Re-request the stream after this silence (spec 4.1 step 7), at most every RETRIGGER_MS. */
const STREAM_STALL_MS = 5000;
const RETRIGGER_MS = 3000;
/** Poll reports an error after this silence. */
const STREAM_LOST_MS = 15000;
const ACK_TIMEOUT_MS = 1500;

/** True when a cell info frame decodes plausibly in the JK02_24S layout (spec 3.4 step 7). @param {Uint8Array} frame */
const plausibleAs24s = (frame) => cellInfoProblem(parseCellInfo(frame, VARIANT.JK02_24S), VARIANT.JK02_24S) === null;

export class JkBleDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: createBleAssembler, describe: (f) => describe(f, this.variant), log: ctx.log }).start();
    this.offFrame = this.channel.on('frame', (/** @type {Uint8Array} */ f) => this.#onFrame(f));
    /** True once the layout is known well enough to write (spec 1.2, 11.3). */
    this.variantConfirmed = false;
    /** Software major version from the device info frame. */
    this.firmwareMajor = NaN;
    /** @type {Uint8Array | null} */
    this.deviceFrame = null;
    /** @type {Uint8Array | null} */
    this.settingsFrame = null;
    /** @type {{ frame: Uint8Array, variant: string | undefined, value: Record<string, any> } | null} */
    this.settingsCache = null;
    /** Last plausible cell info. @type {Record<string, any> | null} */
    this.cell = null;
    /** @type {ReturnType<typeof parseEventLog> | null} */
    this.eventLog = null;
    this.streaming = false;
    this.streamSince = 0;
    /** Last cell info frame of any content: the stream is alive. */
    this.lastCellAt = 0;
    /** Last plausible cell info frame: the data is alive. */
    this.lastValidCellAt = 0;
    this.lastPublishAt = 0;
    this.lastSettingsRequestAt = 0;
    this.lastTriggerAt = 0;
    this.lastWriteAt = 0;
    /** Time of the next settings frame refresh after a write (0: none). */
    this.refreshAt = 0;
    /** @type {{ key: string, schema: import('@ubms/bms-core/settings').SettingsSchema } | null} */
    this.schemaCache = null;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: this.variantConfirmed, streaming: true, pollIntervalMs: 1000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    const variant = this.variant ?? VARIANT.JK02_32S;
    const cellCount = variant === VARIANT.JK04 ? 0 : (this.#settings()?.cellCount ?? this.cell?.cellCount ?? 0);
    const key = `${variant}:${cellCount}`;
    if (this.schemaCache?.key !== key) this.schemaCache = { key, schema: buildJkSchema({ variant, link: 'ble', cellCount }) };
    return this.schemaCache.schema;
  }

  /** Parsed last settings frame in the current layout. */
  #settings() {
    const frame = this.settingsFrame;
    if (!frame) return null;
    if (this.settingsCache?.frame !== frame || this.settingsCache.variant !== this.variant) {
      this.settingsCache = { frame, variant: this.variant, value: parseSettings(frame, this.variant ?? VARIANT.JK02_32S) };
    }
    return this.settingsCache.value;
  }

  /**
   * Request with log names, outside the channel queue (call inside `channel.exclusive`).
   * @param {Uint8Array} bytes
   * @param {(frame: Uint8Array) => boolean} match
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  #request(bytes, match, { timeout = 2000, retries = 1 } = {}) {
    const d = describe(bytes, this.variant);
    return this.channel.requestUnqueued(bytes, { match, timeout, retries, name: d?.name, decode: d?.decode });
  }

  /** Settings request 0x96: answers a settings frame and (re)starts the cell info stream. */
  async #sendSettingsRequest() {
    const bytes = settingsRequest();
    const d = describe(bytes, this.variant);
    this.lastSettingsRequestAt = Date.now();
    this.lastTriggerAt = this.lastSettingsRequestAt;
    await this.channel.send(bytes, { name: d?.name, decode: d?.decode });
  }

  /** @param {Uint8Array} frame */
  #onFrame(frame) {
    if (frame.length !== DATA_FRAME_LENGTH) return; // ACK frames are matched by the request waiters
    try {
      switch (frame[4]) {
        case FRAME_TYPE.DEVICE_INFO:
          this.deviceFrame = frame;
          if (this.variant) this.publishInfo(deviceInfoModel(parseDeviceInfo(frame), this.variant));
          break;
        case FRAME_TYPE.SETTINGS:
          this.settingsFrame = frame;
          break;
        case FRAME_TYPE.CELL_INFO:
          this.#onCellInfo(frame);
          break;
        case FRAME_TYPE.EVENT_LOG:
          this.eventLog = parseEventLog(frame);
          break;
        default:
      }
    } catch (err) {
      this.log?.warn(`JK frame: ${errorText(err)}`);
    }
  }

  /** @param {Uint8Array} frame cell info frame */
  #onCellInfo(frame) {
    const now = Date.now();
    this.lastCellAt = now;
    if (!this.variant) return; // the probe is still running
    if (!this.variantConfirmed) this.#confirmFromData(frame);
    const jk04 = this.variant === VARIANT.JK04;
    const c = jk04 ? parseJk04CellInfo(frame) : parseCellInfo(frame, this.variant);
    const problem = cellInfoProblem(c, this.variant);
    if (problem) {
      this.log?.warn(`JK cell info ignored, implausible ${problem}`);
      return;
    }
    this.lastValidCellAt = now;
    this.cell = c;
    if (now - this.lastPublishAt < PUBLISH_INTERVAL_MS) return;
    this.lastPublishAt = now;
    this.publish(jk04 ? jk04Snapshot(c, { settings: this.#settings() }) : jk02Snapshot(c, { variant: this.variant, settings: this.#settings(), firmwareMajor: this.firmwareMajor }));
  }

  /**
   * Firmware below 11 is JK02_24S or a JK04 balancer; the first cell info frame tells them apart
   * (spec 11.3). With an unreadable version only a JK04 can be confirmed from the data. JK02_24S
   * needs a frame that also decodes plausibly in that layout: a JK04 frame that fails the strict
   * JK04 test (a cell below 0.5 V) must not enable 24S register writes on a balancer.
   * @param {Uint8Array} frame
   */
  #confirmFromData(frame) {
    if (looksLikeJk04CellInfo(frame)) {
      this.variantConfirmed = true;
      this.setVariant(VARIANT.JK04);
    } else if (this.firmwareMajor < 11 && plausibleAs24s(frame)) {
      this.variantConfirmed = true;
      this.setVariant(VARIANT.JK02_24S);
    }
  }

  /**
   * Settings request plus the first cell info frame, to tell JK02_24S from JK04 (spec 11.3).
   * Read only: 0x96 only answers and starts the stream.
   * @param {number} timeout
   * @returns {Promise<string | undefined>}
   */
  async #detectFromData(timeout) {
    this.lastSettingsRequestAt = Date.now();
    this.lastTriggerAt = this.lastSettingsRequestAt;
    this.streamSince = this.lastSettingsRequestAt;
    /** @type {Uint8Array[]} */
    let frames = [];
    try {
      const d = describe(settingsRequest());
      frames = await this.channel.requestMany(settingsRequest(), {
        match: (f) => f.length === DATA_FRAME_LENGTH && (f[4] === FRAME_TYPE.SETTINGS || f[4] === FRAME_TYPE.CELL_INFO),
        until: (fs) => fs.some((f) => f[4] === FRAME_TYPE.CELL_INFO),
        timeout,
        partialOnTimeout: true,
        name: d?.name,
        decode: d?.decode,
      });
    } catch {
      return undefined;
    }
    const cell = frames.find((f) => f[4] === FRAME_TYPE.CELL_INFO);
    if (cell) {
      if (looksLikeJk04CellInfo(cell)) return VARIANT.JK04;
      return this.firmwareMajor < 11 && plausibleAs24s(cell) ? VARIANT.JK02_24S : undefined;
    }
    const settings = frames.find((f) => f[4] === FRAME_TYPE.SETTINGS);
    if (settings && looksLikeJk04Settings(settings)) return VARIANT.JK04;
    return undefined;
  }

  /**
   * Read only probe (spec 11.2): device info request 0x97, accept only a valid 300 byte frame of
   * type 0x03, select the layout from the software version (spec 1.2) and, below version 11,
   * from the data (JK02_24S or JK04, spec 11.3).
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const attempt = Math.max(500, Math.min(1500, Math.floor(timeout / 2)));
    await sleep(BLE_SETTLE_MS);
    /** @type {Uint8Array} */
    let frame;
    try {
      frame = await this.channel.exclusive(() => this.#request(deviceInfoRequest(), isDataFrameOfType(FRAME_TYPE.DEVICE_INFO), { timeout: attempt, retries: 1 }));
    } catch {
      return null;
    }
    const d = parseDeviceInfo(frame);
    this.deviceFrame = frame;
    this.firmwareMajor = softwareMajor(d.softwareVersion);
    let variant = this.firmwareMajor < 11 ? VARIANT.JK02_24S : VARIANT.JK02_32S;
    let confirmed = this.firmwareMajor >= 11;
    if (!confirmed) {
      const detected = await this.#detectFromData(Math.max(2000, timeout));
      if (detected) {
        variant = detected;
        confirmed = true;
      }
    }
    this.variantConfirmed = confirmed;
    this.setVariant(variant);
    const info = deviceInfoModel(d, variant);
    this.publishInfo(info);
    this.log?.event(
      `JK ${d.model || 'BMS'}, hardware ${d.hardwareVersion || '?'}, software ${d.softwareVersion || '?'}: ${variant}${confirmed ? '' : ' (not confirmed yet, writes disabled)'}`,
    );
    return { variant, confidence: confirmed ? 1 : 0.6, info };
  }

  /** Settings frame and cell info stream (spec 4.1 step 5). */
  async start() {
    this.streaming = true;
    this.streamSince = Date.now();
    await this.#sendSettingsRequest();
  }

  /**
   * Watchdog: the BMS streams by itself. Re-request the stream when it stalls, refresh the
   * settings frame after writes, report an error after a long time without plausible data
   * (frames that are all ignored as implausible keep the stream alive but carry no data).
   */
  async poll() {
    if (!this.streaming) return;
    const now = Date.now();
    if (this.refreshAt && now >= this.refreshAt) {
      this.refreshAt = 0;
      await this.#sendSettingsRequest();
      return;
    }
    const quiet = now - Math.max(this.lastCellAt, this.streamSince);
    if (quiet > STREAM_STALL_MS && now - this.lastTriggerAt > RETRIGGER_MS) {
      this.log?.event('JK: no cell info for a few seconds, requesting the stream again');
      await this.#sendSettingsRequest();
    }
    if (now - Math.max(this.lastValidCellAt, this.streamSince) > STREAM_LOST_MS) throw new Error(msg('No data from the BMS for several seconds'));
  }

  async stop() {
    this.streaming = false;
  }

  async readInfo() {
    let frame = this.deviceFrame;
    if (!frame) {
      try {
        frame = await this.channel.exclusive(() => this.#request(deviceInfoRequest(), isDataFrameOfType(FRAME_TYPE.DEVICE_INFO), { timeout: 2000, retries: 1 }));
        this.deviceFrame = frame;
      } catch (err) {
        this.log?.warn(`JK device info: ${errorText(err)}`);
        return this.lastInfo;
      }
    }
    return this.publishInfo(deviceInfoModel(parseDeviceInfo(frame), this.variant));
  }

  /**
   * Fresh settings frame (0x96, at least 1 s after the last write) plus, on JK02_32S, a fresh
   * device info frame for the values stored there (spec 4.2, 7.7).
   */
  async readSettings() {
    return this.channel.exclusive(async () => {
      await waitUntil(this.lastWriteAt + READBACK_DELAY_MS);
      this.lastSettingsRequestAt = Date.now();
      this.lastTriggerAt = this.lastSettingsRequestAt;
      this.settingsFrame = await this.#request(settingsRequest(), isDataFrameOfType(FRAME_TYPE.SETTINGS), { timeout: 3000, retries: 1 });
      if (this.variant === VARIANT.JK02_32S) {
        try {
          this.deviceFrame = await this.#request(deviceInfoRequest(), isDataFrameOfType(FRAME_TYPE.DEVICE_INFO), { timeout: 2000, retries: 1 });
        } catch (err) {
          this.log?.warn(`JK device info for settings: ${errorText(err)}`);
        }
      }
      return decodeJkSettings(this.getSettingsSchema(), {
        settings: this.#settings(),
        device: this.deviceFrame ? parseDeviceInfo(this.deviceFrame) : null,
      });
    });
  }

  /**
   * Write frame and wait for the ACK (spec 3.3). A missing ACK is only logged: the ACK does not
   * prove that the value was applied anyway, the read-back does.
   * @param {Uint8Array} bytes
   */
  async #write(bytes) {
    try {
      await this.#request(bytes, isAckFrame, { timeout: ACK_TIMEOUT_MS, retries: 0 });
    } catch (err) {
      if (/** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
      this.log?.warn('JK: no ACK after the write; the read-back shows whether it was applied');
    }
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = fieldMap(this.getSettingsSchema()).get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    if (!this.variantConfirmed) throw new Error(VARIANT_UNCONFIRMED);
    if (f.meta?.guard) {
      const current = this.#settings()?.[f.meta.name];
      if (current === undefined) throw new Error(msg('Read the settings first'));
      const problem = guardProblem(f, current);
      if (problem) throw new Error(problem);
    }
    const bytes = bleWriteFrame(f, value);
    await this.channel.exclusive(async () => {
      await waitUntil(this.lastSettingsRequestAt + WRITE_SETTLE_MS);
      await this.#write(bytes);
      this.lastWriteAt = Date.now();
      this.refreshAt = this.lastWriteAt + READBACK_DELAY_MS;
    });
  }

  /**
   * @param {string} id
   * @param {any} [arg] SOC in % for the SOC calibration (default 100)
   */
  async runAction(id, arg) {
    const f = fieldMap(this.getSettingsSchema()).get(id);
    if (!f || f.type !== 'action') throw new Error(msg('Unknown action'));
    if (!this.variantConfirmed) throw new Error(VARIANT_UNCONFIRMED);
    const m = f.meta;
    /** @type {Uint8Array} */
    let bytes;
    if (m.kind === 'soc') {
      const soc = arg === undefined || arg === null ? m.value : Number(arg);
      if (!Number.isInteger(soc) || soc < 0 || soc > 100) throw new Error(msg('Invalid value'));
      bytes = encodeWrite(m.register, 1, soc);
    } else if (m.kind === 'command') {
      bytes = encodeWrite(m.register, m.length, m.value);
    } else {
      bytes = encodeCommand(m.register);
    }
    await this.channel.exclusive(async () => {
      await waitUntil(this.lastSettingsRequestAt + WRITE_SETTLE_MS);
      await this.#write(bytes);
      this.lastWriteAt = Date.now();
      this.refreshAt = this.lastWriteAt + READBACK_DELAY_MS;
    });
  }

  dispose() {
    this.offFrame();
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// JK-PB over RS485 (Modbus trigger protocol)
// ---------------------------------------------------------------------------------------------

/** At least 100 to 120 ms between requests (spec 4.3). */
const PB_GAP_MS = 120;
/** Answer within 35 to 50 ms; read timeout 0.5 to 1 s with one retry (spec 4.3). */
const PB_TIMEOUT_MS = 1000;
/** Settings frame refresh for the snapshot (balancer switch, nominal capacity). */
const PB_SETTINGS_REFRESH_MS = 30000;

export class JkPbDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    const a = Number(ctx.options?.address ?? PB_DEFAULT_ADDRESS);
    /** DIP switch address of the pack, 0..15 (0 is the parallel bus master, spec 2.3). */
    this.address = Number.isInteger(a) && a >= 0 && a <= 15 ? a : PB_DEFAULT_ADDRESS;
    this.channel = new FrameChannel(ctx.link, { createAssembler: createPbAssembler(), describe: (f) => describe(f, VARIANT.JK02_32S), log: ctx.log }).start();
    this.lastIoAt = 0;
    /** @type {Uint8Array | null} */
    this.deviceFrame = null;
    /** @type {Uint8Array | null} */
    this.settingsFrame = null;
    this.settingsAt = 0;
    /** @type {Record<string, any> | null} */
    this.cell = null;
    this.firmwareMajor = NaN;
    /** @type {{ key: string, schema: import('@ubms/bms-core/settings').SettingsSchema } | null} */
    this.schemaCache = null;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 1000, minPollIntervalMs: 500 };
  }

  getSettingsSchema() {
    const cellCount = this.#settings()?.cellCount ?? this.cell?.cellCount ?? 0;
    const key = String(cellCount);
    if (this.schemaCache?.key !== key) this.schemaCache = { key, schema: buildJkSchema({ variant: VARIANT.JK02_32S, link: 'pb', cellCount }) };
    return this.schemaCache.schema;
  }

  #settings() {
    return this.settingsFrame ? parseSettings(this.settingsFrame, VARIANT.JK02_32S) : null;
  }

  /**
   * Trigger request (spec 3.6.3): collect the 300 byte frame and the FC 0x10 answer of this
   * address. The frame carries no address: it belongs to the pack whose answer follows it
   * directly ([DSB]); a settings frame is matched by the DIP address at S270 instead ([TX]).
   * Frames of other packs on a shared bus (spec 4.3), the master's unrequested frames and a frame
   * whose answer is missing are never taken. Only call inside `channel.exclusive`.
   * @param {number} register PB_TRIGGER value
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #trigger(register, { timeout = PB_TIMEOUT_MS, retries = 1 } = {}) {
    const type = PB_TRIGGER_TYPE[register];
    const bytes = pbTriggerRequest(this.address, register);
    const d = describe(bytes);
    /** @param {Uint8Array} f */
    const own = (f) => isPbWriteAck(f, this.address, register) || isModbusException(f, this.address);
    /** @type {unknown} */
    let lastErr = new Error(msg('No response from the device'));
    for (let attempt = 0; attempt <= retries; attempt++) {
      await waitUntil(this.lastIoAt + PB_GAP_MS);
      /** @type {Uint8Array[]} */
      let frames;
      try {
        frames = await this.channel.requestManyUnqueued(bytes, {
          // Answers of every address are kept: they separate the frames of the packs.
          match: (f) => f.length === DATA_FRAME_LENGTH || f.length === 8 || f.length === 5,
          until: (fs) => fs.some(own),
          timeout,
          partialOnTimeout: true,
          name: d?.name,
          decode: d?.decode,
        });
      } catch (err) {
        lastErr = err;
        if (/** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
        continue;
      } finally {
        this.lastIoAt = Date.now();
      }
      const end = frames.findIndex(own);
      const answer = end >= 0 ? frames[end] : null;
      if (answer && isModbusException(answer, this.address)) {
        this.log?.warn(`JK-PB: trigger ${h4(register)} refused with Modbus exception ${answer[2]}`);
        throw new Error(msg('The BMS refused the command'));
      }
      const frame = this.#ownFrame(end >= 0 ? frames.slice(0, end) : frames, type, !!answer);
      if (frame) {
        if (!answer) this.log?.warn(`JK-PB: settings frame without the FC 0x10 answer for ${h4(register)}, taken by its DIP address`);
        return frame;
      }
      if (answer) lastErr = new Error(msg('Incomplete response from the device'));
    }
    throw lastErr;
  }

  /**
   * This pack's frame among the frames received before its answer (all frames when it did not
   * answer), see `#trigger`.
   * @param {Uint8Array[]} before
   * @param {number} type expected frame type
   * @param {boolean} answered this address answered the trigger
   */
  #ownFrame(before, type, answered) {
    const last = before.at(-1);
    const lastFits = answered && last?.length === DATA_FRAME_LENGTH && last[4] === type;
    if (type !== FRAME_TYPE.SETTINGS) return lastFits ? last : null;
    const own = before.filter((f) => f.length === DATA_FRAME_LENGTH && f[4] === type && f[270] === this.address).at(-1);
    if (!own && lastFits) this.log?.warn(`JK-PB: the settings frame before the answer of address ${this.address} carries DIP address ${last?.[270]}, ignored`);
    return own ?? null;
  }

  /**
   * Request spacing and the FC 0x10 answer of a settings write; an exception means refused.
   * @param {Uint8Array} bytes
   * @param {number} register
   */
  async #writeRegister(bytes, register) {
    await waitUntil(this.lastIoAt + PB_GAP_MS);
    const d = describe(bytes);
    try {
      const answer = await this.channel.requestUnqueued(bytes, {
        match: (f) => isPbWriteAck(f, this.address, register) || isModbusException(f, this.address),
        timeout: PB_TIMEOUT_MS,
        retries: 1,
        name: d?.name,
        decode: d?.decode,
      });
      if (isModbusException(answer, this.address)) {
        this.log?.warn(`JK-PB: write of ${h4(register)} refused with Modbus exception ${answer[2]}`);
        throw new Error(msg('The BMS refused the value'));
      }
    } finally {
      this.lastIoAt = Date.now();
    }
  }

  /**
   * Read only probe (spec 11.4): device info trigger, or the cell info trigger for a bus master
   * that does not answer 0x161C (spec 4.3).
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const attempt = Math.max(500, Math.min(PB_TIMEOUT_MS, Math.floor(timeout / 2)));
    try {
      this.deviceFrame = await this.channel.exclusive(() => this.#trigger(PB_TRIGGER.DEVICE_INFO, { timeout: attempt, retries: 1 }));
    } catch {
      try {
        const frame = await this.channel.exclusive(() => this.#trigger(PB_TRIGGER.CELL_INFO, { timeout: attempt, retries: 0 }));
        this.cell = parseCellInfo(frame, VARIANT.JK02_32S);
      } catch {
        return null;
      }
    }
    if (this.address === 0) this.log?.warn('JK-PB: address 0 is the parallel bus master; packs polled by a client should use 1 to 15');
    this.setVariant(VARIANT.JK02_32S);
    /** @type {DeviceInfo} */
    let info = { vendor: JK_VENDOR, protocol: VARIANT.JK02_32S };
    if (this.deviceFrame) {
      const d = parseDeviceInfo(this.deviceFrame);
      this.firmwareMajor = softwareMajor(d.softwareVersion);
      info = deviceInfoModel(d, VARIANT.JK02_32S);
    }
    this.publishInfo(info);
    return { variant: VARIANT.JK02_32S, confidence: 1, info };
  }

  /** Settings frame once (cell count, balancer switch, nominal capacity), spec 4.3. */
  async start() {
    try {
      await this.channel.exclusive(async () => {
        this.settingsFrame = await this.#trigger(PB_TRIGGER.SETTINGS);
        this.settingsAt = Date.now();
      });
    } catch (err) {
      this.log?.warn(`JK-PB settings: ${errorText(err)}`);
    }
  }

  async poll() {
    await this.channel.exclusive(async () => {
      if (Date.now() - this.settingsAt > PB_SETTINGS_REFRESH_MS) {
        try {
          this.settingsFrame = await this.#trigger(PB_TRIGGER.SETTINGS);
        } catch (err) {
          this.log?.warn(`JK-PB settings: ${errorText(err)}`);
        }
        this.settingsAt = Date.now();
      }
      const c = parseCellInfo(await this.#trigger(PB_TRIGGER.CELL_INFO), VARIANT.JK02_32S);
      const problem = cellInfoProblem(c, VARIANT.JK02_32S);
      if (problem) throw new Error(`Implausible cell info (${problem})`);
      this.cell = c;
      this.publish(jk02Snapshot(c, { variant: VARIANT.JK02_32S, settings: this.#settings(), firmwareMajor: this.firmwareMajor }));
    });
  }

  async readInfo() {
    if (!this.deviceFrame) {
      try {
        this.deviceFrame = await this.channel.exclusive(() => this.#trigger(PB_TRIGGER.DEVICE_INFO));
      } catch (err) {
        this.log?.warn(`JK-PB device info: ${errorText(err)}`);
        return this.lastInfo;
      }
    }
    const d = parseDeviceInfo(this.deviceFrame);
    this.firmwareMajor = softwareMajor(d.softwareVersion);
    return this.publishInfo(deviceInfoModel(d, VARIANT.JK02_32S));
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      this.settingsFrame = await this.#trigger(PB_TRIGGER.SETTINGS);
      this.settingsAt = Date.now();
      try {
        this.deviceFrame = await this.#trigger(PB_TRIGGER.DEVICE_INFO);
      } catch (err) {
        this.log?.warn(`JK-PB device info for settings: ${errorText(err)}`);
      }
      return decodeJkSettings(this.getSettingsSchema(), {
        settings: this.#settings(),
        device: this.deviceFrame ? parseDeviceInfo(this.deviceFrame) : null,
      });
    });
  }

  /**
   * FC 0x10 write (spec 3.6.2, 7). Switches in the controls word 0x1114 are read, changed and
   * written back as a whole (spec 8.1).
   * @param {string} id
   * @param {any} value
   */
  async writeSetting(id, value) {
    const f = fieldMap(this.getSettingsSchema()).get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    await this.channel.exclusive(async () => {
      const needsFrame = f.meta.write?.bit !== undefined || !!f.meta.guard;
      if (needsFrame) {
        this.settingsFrame = await this.#trigger(PB_TRIGGER.SETTINGS);
        this.settingsAt = Date.now();
      }
      const s = this.#settings();
      if (f.meta.guard) {
        const problem = guardProblem(f, s?.[f.meta.name]);
        if (problem) throw new Error(problem);
      }
      const bytes = pbWriteFrame(this.address, f, value, s?.controlsBitmask);
      await this.#writeRegister(bytes, f.meta.write.register);
      this.settingsAt = 0; // the next poll reads the settings frame again (switch states)
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// JK-B UART / RS485 "4E 57"
// ---------------------------------------------------------------------------------------------

/** At least 100 ms between packets (spec 2.2). */
const UART_GAP_MS = 100;

export class JkUartDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: createUartAssembler, describe: (f) => describe(f), log: ctx.log }).start();
    this.schema = buildJkUartSchema();
    this.fields = fieldMap(this.schema);
    /** @type {Record<string, any> | null} */
    this.status = null;
    this.lastIoAt = 0;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // [SY] polls every 5 s; the protocol asks for at least 100 ms between packets (spec 4.4).
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * "Read all" request and reply (spec 4.4). Only call inside `channel.exclusive`.
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #readAll({ timeout = 2000, retries = 1 } = {}) {
    await waitUntil(this.lastIoAt + UART_GAP_MS);
    const bytes = uartReadAll();
    const d = describe(bytes);
    try {
      const frame = await this.channel.requestUnqueued(bytes, { match: isUartReadReply, timeout, retries, name: d?.name, decode: d?.decode });
      this.status = parseUartFrame(frame);
      return this.status;
    } finally {
      this.lastIoAt = Date.now();
    }
  }

  /**
   * Read only probe (spec 11.5): a "read all" reply with a valid cell block.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const attempt = Math.max(500, Math.min(2000, Math.floor(timeout / 2)));
    /** @type {Record<string, any>} */
    let st;
    try {
      st = await this.channel.exclusive(() => this.#readAll({ timeout: attempt, retries: 1 }));
    } catch {
      return null;
    }
    if (!st.cellVoltages?.length) return null;
    this.setVariant(VARIANT.UART);
    const info = uartDeviceInfo(st);
    this.publishInfo(info);
    return { variant: VARIANT.UART, confidence: 1, info };
  }

  async poll() {
    const st = await this.channel.exclusive(() => this.#readAll());
    this.publish(uartSnapshot(st));
  }

  async readInfo() {
    return this.status ? this.publishInfo(uartDeviceInfo(this.status)) : this.lastInfo;
  }

  async readSettings() {
    const st = await this.channel.exclusive(() => this.#readAll());
    return decodeJkSettings(this.schema, { uart: st });
  }

  /**
   * One byte switch writes, the only writes the spec confirms on this port (spec 6.6).
   * @param {string} id
   * @param {any} value
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    const w = f.meta?.write;
    if (f.readOnly || !w || w.link !== 'uart') throw new Error(msg('This value is read only'));
    const bytes = uartSwitchWrite(w.dataId, value ? 1 : 0);
    const d = describe(bytes);
    await this.channel.exclusive(async () => {
      await waitUntil(this.lastIoAt + UART_GAP_MS);
      try {
        // The reply repeats the data id at byte 11 (spec 6.6); an adapter echo has source PC.
        await this.channel.requestUnqueued(bytes, {
          match: (fr) => fr[8] === UART_CMD.WRITE && fr[9] !== UART_SOURCE.PC && fr[11] === w.dataId,
          timeout: 1500,
          name: d?.name,
          decode: d?.decode,
        });
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
        this.log?.warn('JK UART: no answer to the write; the read-back shows whether it was applied');
      } finally {
        this.lastIoAt = Date.now();
      }
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

/**
 * GATT profile (spec 2.1): service FFE0, characteristic FFE1 for writes and notifications, write
 * without response as the official app does, 20 byte writes.
 */
const BLE_PROFILE = {
  id: 'jk-ffe0',
  label: 'FFE0/FFE1',
  service: 0xffe0,
  notify: 0xffe1,
  write: 0xffe1,
  writeMode: /** @type {const} */ ('without-response'),
  chunkSize: 20,
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const jkBleDefinition = {
  id: 'jk-ble',
  family: 'jk',
  vendor: JK_VENDOR,
  protocol: msg('JK02 / JK04 (Bluetooth)'),
  deviceType: 'bms',
  description: msg('JK BMS and JK-PB over Bluetooth (JK02 protocol, 24 and 32 cell layouts) and JK04 active balancers.'),
  links: {
    ble: {
      profiles: [BLE_PROFILE],
      // Names are user defined (spec 2.1, 11.1): "JK-" / "JK_" model names and the JK-PB default
      // name (serial number such as 506036N46002293, optionally with -00) rank first. ANT BMS
      // shares the UUIDs, so detection relies on the validated device info answer.
      namePrefixes: ['JK-', 'JK_'],
      namePatterns: [/^JK[-_]/i, /^\d{6}[A-Z]\d{8}(-\d{2})?$/],
      advertisedServices: [0xffe0],
      // Company 0x0B65 (payload 88 A0 + address) and 0x4B4A ("JK"), spec 2.1.
      manufacturerIds: [0x0b65, 0x4b4a],
    },
  },
  create: (ctx) => new JkBleDriver(jkBleDefinition, ctx),
  demo: { name: 'JK_PB2A16S20P (demo)', chunkSize: 20, create: createJkSimulator },
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const jkPbDefinition = {
  id: 'jk-pb-rs485',
  family: 'jk',
  vendor: JK_VENDOR,
  protocol: msg('JK-PB RS485 (Modbus)'),
  deviceType: 'bms',
  description: msg('JK-PB inverter BMS on its RS485 port: Modbus trigger requests that return the full data frames.'),
  links: {
    serial: {
      profiles: [{ id: 'jk-pb-rs485-115200', label: 'RS485 115200 8N1', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' }],
      note: msg('RS485 port of the JK-PB (RJ45 pins 1, 2, 3 = B, A, GND). The device address is set with the DIP switches; address 1 is used unless configured.'),
    },
  },
  create: (ctx) => new JkPbDriver(jkPbDefinition, ctx),
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const jkUartDefinition = {
  id: 'jk-uart',
  family: 'jk',
  vendor: JK_VENDOR,
  protocol: msg('JK-B UART (4E 57)'),
  deviceType: 'bms',
  description: msg('JK-B smart BMS on the UART or RS485 "GPS" port (4E 57 protocol). Only the MOSFET and balancer switches are written.'),
  links: {
    serial: {
      profiles: [{ id: 'jk-uart-115200', label: 'UART 115200 8N1', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' }],
      note: msg('3.3 V TTL UART on the 4 pin GPS port, or the JK RS485 adapter on it. Never connect the VBAT pin to the adapter: it carries the pack voltage.'),
    },
  },
  create: (ctx) => new JkUartDriver(jkUartDefinition, ctx),
};
