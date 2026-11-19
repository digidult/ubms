import { BaseDriver, alarm, buildSchema, cellStats, field, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import { JK_VENDOR, JkBleDriver, deviceInfoModel, jk04Snapshot } from './driver.js';
import {
  DATA_FRAME_LENGTH,
  FRAME_TYPE,
  JK04_SETTINGS_LAYOUT,
  VARIANT,
  describe,
  deviceInfoRequest,
  isDataFrameOfType,
  looksLikeJk04CellInfo,
  looksLikeJk04Settings,
  parseDeviceInfo,
  parseJk04Settings,
  settingsRequest,
  softwareMajor,
} from './protocol.js';
import { JK04_START_VOLTAGE_READ_ONLY, decodeJkSettings } from './settings.js';
import {
  BAL_CMD,
  BAL_DEFAULT_ADDRESS,
  BAL_MAX_ADDRESS,
  BAL_VARIANT,
  balancerRating,
  balancerStatusProblem,
  createBalancerAssembler,
  describeBalancer,
  encodeBalancerRequest,
  looksLikeJk04BalancerInfo,
  parseBalancerStatus,
  parseBalancerWriteAnswer,
} from './balancer-protocol.js';
import { createJkBalancerRs485Simulator } from './balancer-simulator.js';

/**
 * JK active balancer drivers (docs/protocols/jk-balancer.md, "spec" below), device type
 * 'balancer':
 * - `jk-balancer-ble`: JK04 balancers over Bluetooth (JK-B2A16S, JK-B2A24S, JK-B5A24S). The
 *   protocol code is the one of `jk-ble` (spec 1.3), so the driver extends JkBleDriver: it only
 *   recognises balancers, maps the balancer fields and has its own settings schema, in which the
 *   balance start voltage is read only (spec 12 item 1).
 * - `jk-balancer-rs485`: the RS485 port of the JK-DZ11-B2A24S (spec 2.2, 4.2, 6.5).
 *
 * Not covered: the JK-BD models are BMSes and use `jk-ble` / `jk-uart` (spec 1.2); the 2024
 * balancers with software 11.x may speak JK02_32S, which no capture confirms, so `jk-ble` keeps
 * them (spec 1.3, 12 item 17); the CAN variant JK-DZ08 needs a CAN link (spec 2.3).
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

const STATE_LABELS = {
  off: msg('Off'),
  idle: msg('Idle'),
  charging: msg('Charging balancer'),
  discharging: msg('Discharging balancer'),
  both: msg('Balancing now'),
};

const CELL_COUNT = msg('Must match the number of connected cells. A wrong value stops correct balancing.');
const NO_WRITE = msg('No write command is known for this value, so it is shown but never written.');
const RS485_MAX_CURRENT = msg(
  'The vendor document allows 0.03 to 1 A, so at most 1 A is written. A JK-DZ11-B2A24S reports 2 A, which is shown, but writes above 1 A are not confirmed. A value the balancer does not accept is reported as not applied.',
);
const NOT_APPLIED = msg('The balancer answered with its previous value, so the new value was not applied.');
const IMPLAUSIBLE = msg('The balancer sent implausible data');

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

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

// ---------------------------------------------------------------------------------------------
// Snapshot mapping
// ---------------------------------------------------------------------------------------------

/**
 * Per cell balancing flags of an active balancer. Neither protocol has per cell flags: the device
 * reports the transfer direction (into the lowest cell or out of the highest cell, one at a time,
 * spec 9.1, 9.2) and its 0-based indexes of the highest and lowest cell. The flag follows those
 * indexes, the cells the device chose; an index outside the cell list falls back to the extreme
 * of the voltages. The statistics (cellStats) still come from the voltages (spec 12 item 2).
 * @param {number[]} cells
 * @param {{ charging: boolean, discharging: boolean, minIndex?: number, maxIndex?: number }} state
 * @returns {boolean[]}
 */
export function balancingFlags(cells, { charging, discharging, minIndex, maxIndex }) {
  const flags = cells.map(() => false);
  const stats = charging || discharging ? cellStats(cells) : undefined;
  if (!stats) return flags;
  /** @param {number | undefined} i @param {number} fallback */
  const pick = (i, fallback) => (Number.isInteger(i) && /** @type {number} */ (i) >= 0 && /** @type {number} */ (i) < cells.length ? /** @type {number} */ (i) : fallback);
  if (charging) flags[pick(minIndex, stats.minIndex)] = true;
  if (discharging) flags[pick(maxIndex, stats.maxIndex)] = true;
  return flags;
}

/**
 * @param {boolean} charging
 * @param {boolean} discharging
 * @param {boolean | undefined} switchOn
 */
function stateLabel(charging, discharging, switchOn) {
  if (charging && discharging) return STATE_LABELS.both;
  if (charging) return STATE_LABELS.charging;
  if (discharging) return STATE_LABELS.discharging;
  return switchOn === false ? STATE_LABELS.off : STATE_LABELS.idle;
}

/**
 * Balancer configuration shown with the live data.
 * @param {{ trigger?: number, maxCurrent?: number, startVoltage?: number, cellCount?: number, detected?: number }} v
 * @returns {Record<string, ExtraValue>}
 */
function configExtra({ trigger, maxCurrent, startVoltage, cellCount, detected }) {
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  if (Number.isFinite(trigger)) extra.triggerDelta = { label: msg('Balance trigger voltage difference'), value: /** @type {number} */ (trigger), unit: 'V', decimals: 3 };
  if (Number.isFinite(maxCurrent)) extra.maxBalanceCurrent = { label: msg('Maximum balance current'), value: /** @type {number} */ (maxCurrent), unit: 'A', decimals: 2 };
  if (Number.isFinite(startVoltage)) extra.startVoltage = { label: msg('Balance start voltage'), value: /** @type {number} */ (startVoltage), unit: 'V', decimals: 2 };
  if (Number.isFinite(cellCount)) extra.cellCount = { label: msg('Cell count'), value: /** @type {number} */ (cellCount), decimals: 0 };
  if (Number.isFinite(detected)) extra.cellCountDetected = { label: msg('Detected cell count'), value: /** @type {number} */ (detected), decimals: 0 };
  return extra;
}

/**
 * Balancer fields of a JK04 cell info frame and the last settings frame.
 * @param {Record<string, any>} c parsed JK04 cell info (parseJk04CellInfo)
 * @param {Record<string, any> | null} settings parsed JK04 settings (parseJk04Settings)
 * @param {number[]} cells cell voltages of the snapshot
 */
function jk04BalancerFields(c, settings, cells) {
  // Action 1 moves energy into the lowest cell, 2 out of the highest cell (spec 9.1).
  const charging = c.balancingAction === 1;
  const discharging = c.balancingAction === 2;
  return {
    balancing: balancingFlags(cells, { charging, discharging, minIndex: c.cellVoltageMinIndex, maxIndex: c.cellVoltageMaxIndex }),
    extra: {
      balancer: { label: msg('Balancer state'), value: stateLabel(charging, discharging, settings ? !!settings.balancerSwitch : undefined) },
      ...configExtra({
        trigger: settings?.balanceTriggerVoltage,
        maxCurrent: settings?.maxBalanceCurrent,
        startVoltage: settings?.balanceStartVoltage,
        cellCount: settings?.cellCount,
      }),
    },
  };
}

/**
 * Unified snapshot of a JK04 balancer: the JK04 snapshot of `jk-ble` (cells, lead resistances,
 * signed balance current, the cell sum as voltage, time since power-on) plus per cell balancing
 * flags and the configuration of the settings frame. JK04 has no temperature, current, SOC or
 * alarm field (spec 6.1, 12 item 15), so the snapshot has none.
 * @param {Record<string, any>} c parsed JK04 cell info
 * @param {{ settings?: Record<string, any> | null }} [opts] parsed JK04 settings
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function jk04BalancerSnapshot(c, { settings = null } = {}) {
  const s = jk04Snapshot(c, { settings });
  const add = jk04BalancerFields(c, settings, s.cells ?? []);
  return { ...s, balancing: add.balancing, extra: { ...s.extra, ...add.extra } };
}

/**
 * Unified snapshot of an RS485 status answer (spec 6.5, 9.2). The balance current is unsigned on
 * the wire; it gets the JK04 sign: positive into the lowest cell, negative out of the highest.
 * @param {Record<string, any>} st parsed status (parseBalancerStatus)
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function balancerRs485Snapshot(st) {
  // Byte 11: bit 0 into the lowest cell, bit 1 out of the highest cell per [JKBAL485]. It was 0
  // in every capture, so the direction, the current sign and the per cell flags derived from it
  // are unverified on hardware (spec 6.5, 9.2).
  const charging = (st.balanceStatus & 0x01) !== 0;
  const discharging = (st.balanceStatus & 0x02) !== 0;
  const cells = /** @type {number[]} */ (st.cellVoltages);
  const current = discharging && !charging ? -st.balanceCurrent : st.balanceCurrent;
  const alarms = [];
  // Bit 0 ("cell count set incorrectly") was set in every capture although the counts matched
  // (spec 9.2), so the mismatch is derived from the detected and the configured count.
  if (st.cellCountDetected !== st.cellCount) alarms.push(alarm('cell_count_mismatch', { source: `detected ${st.cellCountDetected}, configured ${st.cellCount}` }));
  if (st.alarmBitmask & 0x02) alarms.push(alarm('wire_resistance', { source: 'alarm bit 1' }));
  // "Battery overvoltage": JK says battery for the pack and monomer for a cell. A balancer has no
  // MOSFET to open, so it is a warning.
  if (st.alarmBitmask & 0x04) alarms.push(alarm('pack_overvoltage', { severity: 'warning', source: 'alarm bit 2' }));
  return compact({
    voltage: st.totalVoltage,
    cells,
    balancing: balancingFlags(cells, { charging, discharging, minIndex: st.cellVoltageMinIndex, maxIndex: st.cellVoltageMaxIndex }),
    balancingActive: charging || discharging,
    balanceCurrent: current === 0 ? 0 : current,
    // Optional probe on the T1 connector; the value without a probe is unknown (spec 6.5).
    temperatures: st.temperature === null || st.temperature === undefined ? undefined : [{ id: 't1', label: msg('Temperature'), value: st.temperature, kind: /** @type {const} */ ('other') }],
    switches: { balance: !!st.balancerSwitch },
    alarms,
    extra: {
      balancer: { label: msg('Balancer state'), value: stateLabel(charging, discharging, !!st.balancerSwitch) },
      ...configExtra({ trigger: st.balanceTriggerVoltage, maxCurrent: st.maxBalanceCurrent, cellCount: st.cellCount, detected: st.cellCountDetected }),
    },
  });
}

/**
 * Device info of the RS485 port: it reports no model or version (spec 10), only its address.
 * @param {Record<string, any>} st parsed status
 * @returns {DeviceInfo}
 */
export function balancerRs485Info(st) {
  return { vendor: JK_VENDOR, protocol: BAL_VARIANT.RS485, extra: { address: { label: msg('Device address'), value: st.address } } };
}

// ---------------------------------------------------------------------------------------------
// Settings schemas
// ---------------------------------------------------------------------------------------------

/**
 * JK04 balancer settings (spec 6.2, 7): float32 values written with register = settings offset
 * - 6, all confirmed by app captures with read-back, except the balance start voltage (spec 12
 * item 1), which stays read only.
 * @param {{ maxCurrent?: number }} [opts] balance current rating of the model in A (spec 7.5)
 * @returns {SettingsSchema}
 */
export function buildJk04BalancerSchema({ maxCurrent } = {}) {
  /** @param {string} name */
  const layout = (name) => /** @type {(typeof JK04_SETTINGS_LAYOUT)[number]} */ (JK04_SETTINGS_LAYOUT.find((s) => s.name === name));
  /**
   * @param {string} id
   * @param {string} name
   * @param {Partial<SettingField>} [props]
   */
  const w = (id, name, props = {}) => {
    const s = layout(name);
    return field(id, { ...props, meta: { kind: 'reg', source: 'settings', name, scale: 1, write: { link: 'ble', register: s.register, length: s.length, float: s.type === 'f32' } } });
  };
  /**
   * @param {string} id
   * @param {string} name
   * @param {Partial<SettingField>} [props]
   */
  const ro = (id, name, props = {}) => field(id, { ...props, readOnly: true, meta: { kind: 'reg', source: 'settings', name } });
  return buildSchema([
    w('switch.balance', 'balancerSwitch'),
    w('balance.trigger_delta', 'balanceTriggerVoltage', { min: 0.002, max: 1 }),
    w('balance.max_current', 'maxBalanceCurrent', { decimals: 2, min: 0.1, max: maxCurrent ?? 10 }),
    ro('balance.start_voltage', 'balanceStartVoltage', { description: JK04_START_VOLTAGE_READ_ONLY }),
    w('cell.power_off_voltage', 'powerOffVoltage', { min: 2, max: 3.7 }),
    w('system.cell_count', 'cellCount', { min: 2, max: 24, step: 1, danger: true, description: CELL_COUNT }),
    w('jk.voltage_reference', 'voltageCalibration', {
      label: msg('Voltage reference'),
      group: 'calibration',
      unit: 'V',
      decimals: 4,
      min: 2.8,
      max: 3.2,
      danger: true,
      advanced: true,
      description: msg('ADC reference of the balancer (about 3.03 V); it scales every voltage reading.'),
    }),
  ]);
}

/**
 * RS485 balancer settings (spec 7): read from the status answer, written with the commands of
 * spec 5.3 as u16 values. The switch write is confirmed on hardware; the others follow the vendor
 * document, and the echo of every write is checked (spec 4.2). The maximum balance current is
 * written within the vendor range 30..1000 mA only: the 2000 mA read from a JK-DZ11-B2A24S is
 * shown, but no write above 1000 mA is documented (unverified, spec 5.3, 7.1, 12 item 6), and
 * the answer carries no model to tell a 1 A unit from a 2 A unit (spec 10).
 * @returns {SettingsSchema}
 */
export function buildJkBalancerRs485Schema() {
  /**
   * @param {string} id
   * @param {string} name
   * @param {number} command
   * @param {number} scale engineering units per raw unit
   * @param {Partial<SettingField>} [props]
   */
  const w = (id, name, command, scale, props = {}) => field(id, { ...props, meta: { kind: 'reg', source: 'status', name, scale, write: { link: 'rs485', command } } });
  return buildSchema([
    w('switch.balance', 'balancerSwitch', BAL_CMD.SWITCH, 1),
    w('balance.trigger_delta', 'balanceTriggerVoltage', BAL_CMD.TRIGGER, 0.001, { min: 0.002, max: 1 }),
    w('balance.max_current', 'maxBalanceCurrent', BAL_CMD.MAX_CURRENT, 0.001, { decimals: 2, min: 0.03, max: 1, description: RS485_MAX_CURRENT }),
    w('system.cell_count', 'cellCount', BAL_CMD.CELL_COUNT, 1, { min: 2, max: 24, step: 1, danger: true, description: CELL_COUNT }),
    field('system.address', { readOnly: true, description: NO_WRITE, meta: { kind: 'reg', source: 'status', name: 'address' } }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// BLE driver: JK04 balancers
// ---------------------------------------------------------------------------------------------

/** [BM] waits 0.1 s before the first request, like `jk-ble`. */
const BLE_SETTLE_MS = 100;

export class JkBalancerBleDriver extends JkBleDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    /** @type {{ frame: Uint8Array, value: Record<string, any> } | null} */
    this.balancerSettingsCache = null;
    /** @type {{ key: string, schema: SettingsSchema } | null} */
    this.balancerSchema = null;
    /** Device info frame the rating was read from. @type {Uint8Array | null} */
    this.ratingFrame = null;
    /** Balance current rating of the model in A (spec 7.5). @type {number | undefined} */
    this.rating = undefined;
  }

  /** Parsed last settings frame (JK04 layout), or null. */
  balancerSettings() {
    const frame = this.settingsFrame;
    if (!frame) return null;
    if (this.balancerSettingsCache?.frame !== frame) this.balancerSettingsCache = { frame, value: parseJk04Settings(frame) };
    return this.balancerSettingsCache.value;
  }

  /** Balancer schema; the maximum balance current is the rating of the model when it is known. */
  getSettingsSchema() {
    const frame = this.deviceFrame;
    if (this.ratingFrame !== frame) {
      this.ratingFrame = frame;
      this.rating = balancerRating(frame ? parseDeviceInfo(frame).model : undefined);
    }
    const key = String(this.rating ?? '');
    if (this.balancerSchema?.key !== key) this.balancerSchema = { key, schema: buildJk04BalancerSchema({ maxCurrent: this.rating }) };
    return this.balancerSchema.schema;
  }

  /**
   * Read only probe (spec 11.1): device info request 0x97, then the settings request 0x96 that
   * starts the cell info stream; accepted only when the first cell info frame (or, without one,
   * the settings frame) is JK04. A JK BMS is rejected after the device info frame: software 11 or
   * later, or a BMS model string with the data of a JK02_24S frame.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    // JK04 balancers answered 0x97 within 0.12 s in the captures (spec 4.1); a shorter attempt
    // than `jk-ble` keeps the extra wait small for devices that do not answer at all.
    const attempt = Math.max(500, Math.min(1000, Math.floor(timeout / 2)));
    await sleep(BLE_SETTLE_MS);
    const infoRequest = deviceInfoRequest();
    const di = describe(infoRequest);
    /** @type {Uint8Array} */
    let frame;
    try {
      frame = await this.channel.request(infoRequest, { match: isDataFrameOfType(FRAME_TYPE.DEVICE_INFO), timeout: attempt, retries: 1, name: di?.name, decode: di?.decode });
    } catch {
      return null;
    }
    if (!looksLikeJk04BalancerInfo(frame)) return null;
    const d = parseDeviceInfo(frame);
    this.deviceFrame = frame;
    this.firmwareMajor = softwareMajor(d.softwareVersion);

    const request = settingsRequest();
    const ds = describe(request);
    this.lastSettingsRequestAt = Date.now();
    this.lastTriggerAt = this.lastSettingsRequestAt;
    this.streamSince = this.lastSettingsRequestAt;
    /** @type {Uint8Array[]} */
    let frames;
    try {
      frames = await this.channel.requestMany(request, {
        match: (f) => f.length === DATA_FRAME_LENGTH && (f[4] === FRAME_TYPE.SETTINGS || f[4] === FRAME_TYPE.CELL_INFO),
        until: (fs) => fs.some((f) => f[4] === FRAME_TYPE.CELL_INFO),
        timeout: Math.max(2000, timeout),
        partialOnTimeout: true,
        name: ds?.name,
        decode: ds?.decode,
      });
    } catch {
      return null;
    }
    const cell = frames.find((f) => f[4] === FRAME_TYPE.CELL_INFO);
    const settings = frames.find((f) => f[4] === FRAME_TYPE.SETTINGS);
    const jk04 = cell ? looksLikeJk04CellInfo(cell) : !!settings && looksLikeJk04Settings(settings);
    if (!jk04) {
      this.log?.event(`JK ${d.model || 'device'}: no JK04 balancer data, left to the JK BMS driver`);
      return null;
    }
    this.variantConfirmed = true;
    this.setVariant(VARIANT.JK04);
    const info = deviceInfoModel(d, VARIANT.JK04);
    this.publishInfo(info);
    this.log?.event(`JK balancer ${d.model || '?'}, hardware ${d.hardwareVersion || '?'}, software ${d.softwareVersion || '?'}: JK04`);
    return { variant: VARIANT.JK04, confidence: 1, info };
  }

  /**
   * JkBleDriver publishes the JK04 snapshot of the cell info frame in `this.cell`; the balancer
   * fields are added here.
   * @param {Omit<BmsSnapshot, 'timestamp'> & { timestamp?: number }} s
   */
  publish(s) {
    if (this.variant !== VARIANT.JK04 || !this.cell) return super.publish(s);
    const add = jk04BalancerFields(this.cell, this.balancerSettings(), s.cells ?? []);
    return super.publish({ ...s, balancing: add.balancing, extra: { ...s.extra, ...add.extra } });
  }
}

// ---------------------------------------------------------------------------------------------
// RS485 driver: JK-DZ11-B2A24S
// ---------------------------------------------------------------------------------------------

/** The balancer answers within 1 s; send nothing else before the answer or the timeout (spec 2.2). */
const RS485_TIMEOUT_MS = 1000;
/** Pause between commands (not documented; one byte time at 9600 baud is about 1 ms). */
const RS485_GAP_MS = 50;

export class JkBalancerRs485Driver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    const a = Number(ctx.options?.address ?? BAL_DEFAULT_ADDRESS);
    /** Balancer address 1..15 (spec 2.2); other values fall back to 1. */
    this.address = Number.isInteger(a) && a >= 1 && a <= BAL_MAX_ADDRESS ? a : BAL_DEFAULT_ADDRESS;
    this.channel = new FrameChannel(ctx.link, { createAssembler: createBalancerAssembler, describe: describeBalancer, log: ctx.log }).start();
    this.schema = buildJkBalancerRs485Schema();
    this.fields = fieldMap(this.schema);
    /** @type {Record<string, any> | null} */
    this.status = null;
    this.lastIoAt = 0;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // [SY] polls every 5 s; one answer takes about 0.1 s at 9600 baud (spec 4.2 step 1).
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * One command and its 74 byte answer (same address and command code, spec 3.4 step 2). Only
   * call inside `channel.exclusive`.
   * @param {number} command
   * @param {number} value raw u16
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #command(command, value, { timeout = RS485_TIMEOUT_MS, retries = 0 } = {}) {
    await waitUntil(this.lastIoAt + RS485_GAP_MS);
    const bytes = encodeBalancerRequest(this.address, command, value);
    const d = describeBalancer(bytes);
    try {
      return await this.channel.requestUnqueued(bytes, { match: (f) => f[2] === this.address && f[3] === command, timeout, retries, name: d?.name, decode: d?.decode });
    } finally {
      this.lastIoAt = Date.now();
    }
  }

  /**
   * Status request and plausibility checks (spec 11.2). Only call inside `channel.exclusive`.
   * @param {{ strict?: boolean, timeout?: number, retries?: number }} [opts]
   */
  async #readStatus({ strict = false, timeout = RS485_TIMEOUT_MS, retries = 1 } = {}) {
    const st = parseBalancerStatus(await this.#command(BAL_CMD.STATUS, 0, { timeout, retries }));
    const problem = balancerStatusProblem(st, { strict });
    if (problem) {
      // The detail goes to the protocol log; the error text reaches the user and is translated.
      this.log?.warn(`JK balancer status ignored, implausible ${problem}`);
      const err = new Error(IMPLAUSIBLE);
      /** @type {any} */ (err).code = 'IMPLAUSIBLE';
      throw err;
    }
    this.status = st;
    return st;
  }

  /**
   * Read only probe (spec 11.2): one status request, at most one retry, at least 1 s per attempt.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const attempt = Math.max(RS485_TIMEOUT_MS, Math.min(1500, Math.floor(timeout / 2)));
    /** @type {Record<string, any>} */
    let st;
    try {
      st = await this.channel.exclusive(() => this.#readStatus({ strict: true, timeout: attempt, retries: 1 }));
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code !== 'TIMEOUT' && code !== 'IMPLAUSIBLE') this.log?.warn(errorText(err));
      return null;
    }
    this.setVariant(BAL_VARIANT.RS485);
    const info = balancerRs485Info(st);
    this.publishInfo(info);
    this.log?.event(`JK balancer at RS485 address ${this.address}: ${st.cellCount} cells configured, ${st.cellCountDetected} detected`);
    return { variant: BAL_VARIANT.RS485, confidence: 1, info };
  }

  async poll() {
    const st = await this.channel.exclusive(() => this.#readStatus());
    this.publish(balancerRs485Snapshot(st));
  }

  async readInfo() {
    return this.status ? this.publishInfo(balancerRs485Info(this.status)) : this.lastInfo;
  }

  async readSettings() {
    const st = await this.channel.exclusive(() => this.#readStatus());
    return decodeJkSettings(this.schema, { status: st });
  }

  /**
   * Write one value and compare the echo (spec 4.2 step 2, 6.6): the answer carries the value in
   * effect, which is the old one when the balancer refused the new value. Without an answer the
   * read-back of the session decides.
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    const w = f.meta?.write;
    if (f.readOnly || !w || w.link !== 'rs485') throw new Error(msg('This value is read only'));
    const raw = f.type === 'boolean' ? (value ? 1 : 0) : Math.round(Number(value) / f.meta.scale);
    if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) throw new Error(msg('Invalid value'));
    await this.channel.exclusive(async () => {
      /** @type {Uint8Array} */
      let answer;
      try {
        answer = await this.#command(w.command, raw);
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
        this.log?.warn('JK balancer: no answer to the write; the read-back shows whether it was applied');
        return;
      }
      const echo = parseBalancerWriteAnswer(answer).value;
      if (echo !== raw) {
        this.log?.warn(`JK balancer: wrote ${raw}, the balancer answered ${echo}`);
        throw new Error(NOT_APPLIED);
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
 * GATT profile of the JK04 balancers (spec 2.1): one FFE1 characteristic for writes and
 * notifications, write without response as the app does, 20 byte writes (the JK-B2A16S does not
 * negotiate the MTU).
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
export const jkBalancerBleDefinition = {
  id: 'jk-balancer-ble',
  family: 'jk',
  vendor: JK_VENDOR,
  protocol: msg('JK04 balancer (Bluetooth)'),
  deviceType: 'balancer',
  description: msg(
    'JK active balancers with the JK04 Bluetooth protocol (JK-B2A16S, JK-B2A24S, JK-B5A24S): cell voltages, lead resistances, balance current and settings. If the balancer is not listed, show all devices.',
  ),
  links: {
    ble: {
      profiles: [BLE_PROFILE],
      // Advertised names are user defined: "BMS" on a JK-B2A16S, the model on a JK-B5A24S,
      // "Power Wall 1" on a JK-B2A24S (spec 2.1). Every name that ranks `jk-ble` ("JK-", "JK_")
      // ranks this driver equally, so the registration order runs the balancer probe first for
      // any JK name; otherwise `jk-ble` takes a balancer named "JK-..." as a JK04 BMS. A JK BMS
      // pays one 0x97 request (spec 11.1 step 5).
      namePrefixes: ['JK-', 'JK_'],
      namePatterns: [/^JK[-_]/i],
      // Unverified: no advertisement of a balancer is known (spec 2.1), so the FFE0 service and
      // the name prefixes are assumed chooser filters. A balancer that advertises neither (for
      // example the JK-B2A16S named "BMS") may be listed only with "show all devices".
      advertisedServices: [0xffe0],
    },
  },
  create: (ctx) => new JkBalancerBleDriver(jkBalancerBleDefinition, ctx),
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const jkBalancerRs485Definition = {
  id: 'jk-balancer-rs485',
  family: 'jk',
  vendor: JK_VENDOR,
  protocol: msg('JK balancer RS485'),
  deviceType: 'balancer',
  description: msg('JK active balancer with the RS485 option (JK-DZ11-B2A24S): cell voltages, balancing state and temperature; balancer switch, trigger voltage, maximum balance current and cell count.'),
  links: {
    serial: {
      profiles: [{ id: 'jk-balancer-rs485-9600', label: 'RS485 9600 8N1', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' }],
      note: msg('3 pin RS485 port of the balancer: pin 1 A, pin 2 B, pin 3 GND; some units answer only with A and B swapped. Address 1 is used unless configured.'),
    },
  },
  create: (ctx) => new JkBalancerRs485Driver(jkBalancerRs485Definition, ctx),
  demo: { name: 'JK-DZ11-B2A24S balancer (demo)', chunkSize: 32, create: (link) => createJkBalancerRs485Simulator(link) },
};
