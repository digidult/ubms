import { ALARMS, BaseDriver, alarm, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import { JBD_VENDOR } from './driver.js';
import { VARIANT } from './protocol.js';
import { UP_DEFAULT_ADDRESS, UP_MAX_ADDRESS, createUpAssembler, describeUp, encodeUpStatusRequest, parseUpFrame, upStatusProblem } from './up.js';
import { createJbdUpSimulator } from './simulator.js';

/**
 * JBD UP series rack BMS over RS485 (docs/protocols/jbd.md sections 2.3, 3.7, 6.10, 9.9, 11.5;
 * "spec" below). Experimental and read only: it polls the pack status block 0x1000 .. 0x10A0 of
 * one address. Settings blocks and every write (function 0x79) are unverified and not offered.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState
 */

/** An answer takes 0.3 to 0.6 s ([DSB], spec 2.3). */
const UP_TIMEOUT_MS = 1000;
/** Pause between requests on the shared bus (not documented). */
const UP_GAP_MS = 50;

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/** Labels of the temperature probes (literal for the translation checker). */
const TEMP_LABELS = [msg('Temperature 1'), msg('Temperature 2'), msg('Temperature 3'), msg('Temperature 4'), msg('Temperature 5'), msg('Temperature 6'), msg('Temperature 7'), msg('Temperature 8')];

/**
 * Protection bits of status offset 24 per [SY] (spec 9.9, unverified: zero in every capture).
 * Index = bit; null = no catalog alarm, shown with its own label.
 */
const UP_PROTECTION = [
  'cell_overvoltage',
  'cell_undervoltage',
  'pack_overvoltage',
  'pack_undervoltage',
  'charge_overcurrent',
  'charge_overcurrent',
  'discharge_overcurrent',
  'discharge_overcurrent',
  'charge_overtemperature',
  'charge_undertemperature',
  'discharge_overtemperature',
  'discharge_undertemperature',
  'mos_overtemperature',
  'ambient_overtemperature',
  'ambient_undertemperature',
  'cell_voltage_difference',
  'temperature_difference',
  'soc_low',
  'short_circuit',
  'cell_wire_open',
  'temperature_sensor_fault',
  'charge_mos_fault',
  'discharge_mos_fault',
  'jbd.up_current_limit_fault',
  'jbd.up_aerosol_fault',
  'jbd.up_full_charge',
  'afe_fault',
  // Bit 27 per [DSB] parse_protection_and_alarms only ("reverse protection"), unverified.
  'jbd.up_reverse_protection',
];

/** Alarm bits of status offset 28 per [SY] (spec 9.9, unverified); bit 18 per [DSB] only. */
const UP_ALARMS = [
  'cell_overvoltage',
  'cell_undervoltage',
  'pack_overvoltage',
  'pack_undervoltage',
  'charge_overcurrent',
  'discharge_overcurrent',
  'charge_overtemperature',
  'charge_undertemperature',
  'discharge_overtemperature',
  'discharge_undertemperature',
  'mos_overtemperature',
  'ambient_overtemperature',
  'ambient_undertemperature',
  'cell_voltage_difference',
  'temperature_difference',
  'soc_low',
  'eeprom_fault',
  'rtc_fault',
  // [DSB]: "full charge protection 2", always in the same state as protection bit 25.
  'jbd.up_full_charge',
];

/** @type {Record<string, string>} */
const UP_LABELS = {
  'jbd.up_current_limit_fault': msg('Current limiting fault'),
  'jbd.up_aerosol_fault': msg('Aerosol (fire suppression) fault'),
  'jbd.up_full_charge': msg('Full charge protection'),
  'jbd.up_reverse_protection': msg('Reverse protection'),
};

/**
 * Severity of a protection bit: the bits are fault flags ([SY] PROTECT, [DSB] fault_flags), so
 * every bit is at least a protection, whatever the catalog default (a warning for ambient
 * temperature, differences and SOC low); faults stay faults.
 * @param {string} id
 * @returns {'protection'|'fault'}
 */
const protectionSeverity = (id) => (id.endsWith('_fault') || ALARMS[id]?.severity === 'fault' ? 'fault' : 'protection');

const OPERATION = [msg('Idle'), msg('Charging'), msg('Discharging')];

/**
 * Alarms of the UP status (spec 9.9). Bit lists are unverified, which the source tag says.
 * @param {Record<string, any>} st parsed status (parseUpStatus)
 * @returns {AlarmState[]}
 */
export function upAlarms(st) {
  /** @type {AlarmState[]} */
  const out = [];
  UP_PROTECTION.forEach((id, bit) => {
    if (Math.floor(st.protectionBits / 2 ** bit) % 2 !== 1 || out.some((a) => a.id === id)) return;
    out.push(alarm(id, { label: UP_LABELS[id], severity: protectionSeverity(id), source: `protection bit ${bit} (unverified)` }));
  });
  UP_ALARMS.forEach((id, bit) => {
    if (Math.floor(st.alarmBits / 2 ** bit) % 2 !== 1 || out.some((a) => a.id === id)) return;
    out.push(alarm(id, { label: UP_LABELS[id], severity: id.endsWith('_fault') ? 'fault' : 'warning', source: `alarm bit ${bit} (unverified)` }));
  });
  return out;
}

/**
 * Unified snapshot of a UP status block (spec 6.10). The current is reported as decoded; its
 * sign while charging is unverified (0 A in both captures).
 * @param {Record<string, any>} st
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function upSnapshot(st) {
  const cells = /** @type {number[]} */ (st.cellVoltages);
  const balance = st.balanceBits ?? 0;
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {
    voltage: st.totalVoltage,
    current: st.current,
    soc: st.soc,
    soh: st.soh,
    capacityRemaining: st.remainingCapacity,
    capacityFull: st.fullCapacity,
    capacityNominal: st.ratedCapacity,
    cycles: st.cycles,
    cells,
    balancing: cells.map((_, i) => i < 16 && ((balance >> i) & 1) === 1),
    balancingActive: balance !== 0,
    temperatures: [
      { id: 'mos', label: msg('MOSFET'), value: st.mosTemperature, kind: /** @type {const} */ ('mos') },
      { id: 'ambient', label: msg('Ambient'), value: st.ambientTemperature, kind: /** @type {const} */ ('ambient') },
      ...st.temperatures.map((/** @type {number} */ value, /** @type {number} */ i) => ({ id: `t${i + 1}`, label: TEMP_LABELS[i] ?? `T${i + 1}`, value, kind: /** @type {const} */ ('cell') })),
    ],
    switches: {
      discharge: (st.mosStatus & 1) !== 0,
      charge: (st.mosStatus & 2) !== 0,
      precharge: (st.mosStatus & 4) !== 0,
      heater: (st.mosStatus & 8) !== 0,
    },
    alarms: upAlarms(st),
    extra: {
      operation: { label: msg('Operation state'), value: OPERATION[st.operationStatus] ?? String(st.operationStatus) },
      chargeVoltageLimit: { label: msg('Charge voltage limit'), value: st.chargeVoltageLimit, unit: 'V', decimals: 1 },
      chargeCurrentLimit: { label: msg('Charge current limit'), value: st.chargeCurrentLimit, unit: 'A', decimals: 1 },
      dischargeVoltageLimit: { label: msg('Discharge voltage limit'), value: st.dischargeVoltageLimit, unit: 'V', decimals: 1 },
      dischargeCurrentLimit: { label: msg('Discharge current limit'), value: st.dischargeCurrentLimit, unit: 'A', decimals: 1 },
    },
  };
  if (st.soh === 0) delete s.soh;
  return s;
}

/**
 * Device information of a UP status block: firmware and the 30 byte string, which [SY] calls the
 * model and [DSB] the pack serial number (unverified, spec 6.10).
 * @param {Record<string, any>} st
 * @param {number} address
 * @returns {DeviceInfo}
 */
export function upInfo(st, address) {
  /** @type {DeviceInfo} */
  const info = { vendor: JBD_VENDOR, protocol: VARIANT.UP, extra: { address: { label: msg('Device address'), value: address, decimals: 0 } } };
  if (st.model) info.model = st.model;
  if (st.firmwareVersion) info.softwareVersion = st.firmwareVersion;
  return info;
}

export class JbdUpDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    const a = Number(ctx.options?.address ?? UP_DEFAULT_ADDRESS);
    /** Pack address 1..247 (spec 2.3); other values fall back to 1. */
    this.address = Number.isInteger(a) && a >= 1 && a <= UP_MAX_ADDRESS ? a : UP_DEFAULT_ADDRESS;
    this.channel = new FrameChannel(ctx.link, { createAssembler: (h) => createUpAssembler({ address: this.address, ...h }), describe: describeUp, log: ctx.log }).start();
    /** @type {Record<string, any> | null} */
    this.status = null;
    this.lastIoAt = 0;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: false, writeSettings: false, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  /**
   * Status block request and checks (spec 11.5). Only call inside `channel.exclusive`.
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #readStatus({ timeout = UP_TIMEOUT_MS, retries = 1 } = {}) {
    const idle = Date.now() - this.lastIoAt;
    if (idle < UP_GAP_MS) await sleep(UP_GAP_MS - idle);
    const req = encodeUpStatusRequest(this.address);
    const d = describeUp(req);
    let f;
    try {
      f = await this.channel.requestUnqueued(req, { match: (fr) => fr[0] === this.address && fr[1] === req[1] && fr[6] * 256 + fr[7] > 0, timeout, retries, name: d?.name, decode: d?.decode });
    } finally {
      this.lastIoAt = Date.now();
    }
    const problem = upStatusProblem(f, this.address);
    if (problem) {
      this.log?.warn(`JBD UP status ignored: ${problem}`, { source: this.definition.id });
      const err = new Error(msg('The BMS sent implausible data'));
      /** @type {any} */ (err).code = 'IMPLAUSIBLE';
      throw err;
    }
    const st = /** @type {Record<string, any>} */ (parseUpFrame(f).status);
    this.status = st;
    return st;
  }

  /**
   * Read only probe (spec 11.5): one status request with one repeat.
   * @param {{ timeout?: number }} [_opts]
   */
  async probe(_opts) {
    /** @type {Record<string, any>} */
    let st;
    try {
      st = await this.channel.exclusive(() => this.#readStatus({ timeout: UP_TIMEOUT_MS, retries: 1 }));
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (code !== 'TIMEOUT' && code !== 'IMPLAUSIBLE') this.log?.warn(errorText(err), { source: this.definition.id });
      return null;
    }
    this.setVariant(VARIANT.UP);
    const info = upInfo(st, this.address);
    this.publishInfo(info);
    this.log?.event(`JBD UP pack at address ${this.address}: ${st.cellCount} cells`, { source: this.definition.id });
    return { variant: VARIANT.UP, confidence: 1, info };
  }

  async poll() {
    const st = await this.channel.exclusive(() => this.#readStatus());
    this.publish(upSnapshot(st));
  }

  async readInfo() {
    return this.status ? this.publishInfo(upInfo(this.status, this.address)) : this.lastInfo;
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const jbdUpRs485Definition = {
  id: 'jbd-up-rs485',
  family: 'jbd',
  vendor: JBD_VENDOR,
  protocol: msg('JBD UP series (RS485)'),
  deviceType: 'bms',
  experimental: true,
  description: msg('JBD UP series rack BMS (UP16S020, UP16S015, ECO-WORTHY 48 V racks) on RS485: read only live data of one pack address. Settings are not supported.'),
  links: {
    serial: {
      profiles: [{ id: 'jbd-up-9600', label: 'RS485 9600 8N1', baudRate: 9600, dataBits: /** @type {const} */ (8), stopBits: /** @type {const} */ (1), parity: /** @type {const} */ ('none') }],
      note: msg('RS485 port of the rack battery at 9600 baud. Address 1 is the master, which also reports the other packs; set the address of the pack to read.'),
    },
  },
  create: (ctx) => new JbdUpDriver(jbdUpRs485Definition, ctx),
  demo: { name: 'JBD-UP16S020 (demo)', chunkSize: 32, create: (link) => createJbdUpSimulator(link) },
};
