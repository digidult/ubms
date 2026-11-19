import { SEVERITY_ORDER, alarm, msg } from '@ubms/bms-core';
import { SlcanDecoder, formatSlcanFrame, hex, i16le, parseSlcanLine, u16le, u32le } from '@ubms/transport';
import { batteryTypeText } from './protocol.js';

/**
 * Deye PCS CAN bus V3.3 (docs/protocols/deye.md, "spec" below, sections 3.3, 4.3, 6.2, 6.3,
 * 9.1 to 9.4, 12): the frames a Deye low voltage battery broadcasts on its PCS port, read through
 * an SLCAN (Lawicel) USB-CAN adapter. Pure decoding plus the state of one bank; the driver never
 * transmits a CAN frame.
 *
 * Standard 11-bit identifiers, DLC 8, little-endian data. Bank frames come once from the master
 * pack, per-pack frames at base + pack - 1 for up to 32 packs per base.
 *
 * @typedef {import('@ubms/transport/slcan').CanFrame} CanFrame
 * @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 */

/** Bit rate of the PCS bus (spec 2.1). */
export const PCS_BITRATE = 500000;

/** Bank frames (spec 6.2, 6.3). */
export const BANK_ID = Object.freeze({
  LIMITS: 0x351,
  SOC: 0x355,
  MEASURE: 0x356,
  USB_BOARD: 0x358,
  FAULTS: 0x359,
  VICTRON_ALARMS: 0x35a,
  FLAGS: 0x35c,
  IDENTITY: 0x35e,
  VICTRON_INFO: 0x35f,
  EXTREMES: 0x361,
  VERSIONS: 0x363,
  COUNTS: 0x364,
  GRID_LIMITS: 0x371,
});

/** Per-pack frame bases: identifier = base + pack - 1 (spec 3.3.1). */
export const PACK_BASE = Object.freeze({
  FAULTS: 0x110,
  SUMMARY: 0x150,
  EXTREMES: 0x200,
  LIMITS: 0x250,
  STATUS: 0x400,
  SOFTWARE: 0x500,
  ENERGY: 0x550,
  SERIAL_1: 0x600,
  SERIAL_2: 0x650,
  COUNTS_1: 0x700,
  COUNTS_2: 0x750,
});

/** Frames other nodes send on the same bus (spec 5.2); ubms sends none of them. */
export const INVERTER_ID = Object.freeze({ HEARTBEAT: 0x305, USB_CONTROL: 0x306, IDENTITY: 0x307 });

/** Packs per identifier base covered by the sources (spec 3.3.1). */
export const MAX_PACKS = 32;

const BANK_NAMES = /** @type {Record<number, string>} */ ({
  0x351: 'limits',
  0x355: 'soc',
  0x356: 'measure',
  0x358: 'usbBoard',
  0x359: 'faults',
  0x35a: 'victronAlarms',
  0x35c: 'flags',
  0x35e: 'identity',
  0x35f: 'victronInfo',
  0x361: 'extremes',
  0x363: 'versions',
  0x364: 'counts',
  0x371: 'gridLimits',
});

const PACK_NAMES = /** @type {Record<number, string>} */ ({
  0x110: 'faults',
  0x150: 'summary',
  0x200: 'extremes',
  0x250: 'limits',
  0x400: 'status',
  0x500: 'software',
  0x550: 'energy',
  0x600: 'serial1',
  0x650: 'serial2',
  0x700: 'counts1',
  0x750: 'counts2',
});

/**
 * Base and pack number of a per-pack identifier, or null.
 * @param {number} id
 */
export function packOf(id) {
  for (const base of Object.values(PACK_BASE)) {
    if (id >= base && id < base + MAX_PACKS) return { base, pack: id - base + 1 };
  }
  return null;
}

/** @param {number} v @param {number} d */
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * ASCII text of bytes, NUL and trailing spaces removed; null when a byte is not printable.
 * @param {Uint8Array} b
 */
function printable(b) {
  let s = '';
  for (const c of b) {
    if (c === 0) continue;
    if (c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return s.replace(/\s+$/, '');
}

/** @param {number} t */
const plausibleTemp = (t) => t >= -50 && t <= 150;
/** @param {number} v */
const plausibleCell = (v) => v >= 1 && v <= 5;
/** Bank (0x356) and pack (0x150) voltage of a 16 cell LiFePO4 pack ([VP] decoder: 35..65 V). @param {number} v */
const plausibleVoltage = (v) => v >= 35 && v <= 65;

/**
 * @typedef {Object} DecodedCan
 * @property {number} id the documented identifier (after undoing the shift of spec 12)
 * @property {'bank'|'pack'|'inverter'} scope
 * @property {string} name
 * @property {number} [pack] 1 based
 * @property {number} [shiftedFrom] identifier on the bus when the shifted layout was undone
 * @property {string} [problem] set when the values fail the range checks or collide with a shifted
 *   per-pack frame (spec 12): the frame is then ignored
 * @property {Record<string, any>} fields
 */

/**
 * Decodes one battery frame. Returns null for identifiers this protocol does not use, extended
 * or remote frames and frames that are not 8 bytes long.
 * @param {{ id: number, extended?: boolean, remote?: boolean, data: Uint8Array }} frame
 * @param {{ profile?: 'deye'|'victron' }} [opts] profile decides the sign of 0x356 (spec 6.3)
 * @returns {DecodedCan | null}
 */
export function decodeCanFrame(frame, { profile = 'deye' } = {}) {
  if (frame.extended || frame.remote || frame.data.length !== 8) return null;
  const { id, data: d } = frame;
  if (BANK_NAMES[id]) {
    const fields = decodeBank(id, d, profile);
    return { id, scope: 'bank', name: BANK_NAMES[id], fields, ...(fields.problem ? { problem: fields.problem } : {}) };
  }
  if (id === INVERTER_ID.HEARTBEAT) return { id, scope: 'inverter', name: 'heartbeat', fields: { sender: 'inverter', heartbeat: hex(d) } };
  if (id === INVERTER_ID.USB_CONTROL) return { id, scope: 'inverter', name: 'usbControl', fields: { sender: 'inverter', usbSwitch: d[0], disableSeconds: u16le(d, 1) } };
  if (id === INVERTER_ID.IDENTITY) return { id, scope: 'inverter', name: 'identity', fields: { sender: 'inverter', identity: hex(d), text: printable(d.subarray(4)) ?? '' } };
  const p = packOf(id);
  if (!p) return null;
  const fields = decodePack(p.base, d);
  return { id, scope: 'pack', name: PACK_NAMES[p.base], pack: p.pack, fields: { pack: p.pack, ...fields }, ...(fields.problem ? { problem: fields.problem } : {}) };
}

/**
 * @param {number} id
 * @param {Uint8Array} d
 * @param {'deye'|'victron'} profile
 * @returns {Record<string, any>}
 */
function decodeBank(id, d, profile) {
  switch (id) {
    case BANK_ID.LIMITS: {
      const f = {
        chargeVoltageLimit: round(u16le(d, 0) * 0.1, 1),
        chargeCurrentLimit: round(i16le(d, 2) * 0.1, 1),
        dischargeCurrentLimit: round(i16le(d, 4) * 0.1, 1),
        dischargeVoltageLimit: round(u16le(d, 6) * 0.1, 1),
      };
      // Spec 12: an all zero 0x351 is the shifted 0x750 of pack 2 on one firmware.
      if (f.chargeVoltageLimit < 40 || f.chargeVoltageLimit > 65 || f.dischargeVoltageLimit < 35 || f.dischargeVoltageLimit > 60) return { ...f, problem: 'voltage limits out of range' };
      return f;
    }
    case BANK_ID.SOC: {
      const f = { soc: u16le(d, 0), soh: u16le(d, 2) };
      // SOH 0 is no battery state; a shifted counter frame with zero counts has it (spec 12).
      return f.soc > 100 || f.soh > 100 || f.soh === 0 ? { ...f, problem: 'SOC or SOH out of range' } : f;
    }
    case BANK_ID.MEASURE: {
      const currentWire = round(i16le(d, 2) * 0.1, 1);
      const f = {
        voltage: round(i16le(d, 0) * 0.01, 2),
        currentWire,
        current: currentFromWire(currentWire, profile),
        temperature: round(i16le(d, 4) * 0.1, 1),
      };
      if (!plausibleVoltage(f.voltage) || !plausibleTemp(f.temperature)) return { ...f, problem: 'voltage or temperature out of range' };
      return f;
    }
    case BANK_ID.USB_BOARD:
      return { usbPower: round(u16le(d, 0) * 0.1, 1), usbEnergy: round(u32le(d, 2) * 0.1, 1), usbSwitch: d[6] };
    case BANK_ID.FAULTS:
      return { tables: Array.from(d.subarray(0, 7)), reserved: d[7] };
    case BANK_ID.VICTRON_ALARMS:
      return { victronAlarmBytes: hex(d) };
    case BANK_ID.FLAGS: {
      const b = d[0];
      return {
        flags: b,
        chargeEnable: (b & 0x80) !== 0,
        dischargeEnable: (b & 0x40) !== 0,
        forceCharge1: (b & 0x20) !== 0,
        forceCharge2: (b & 0x10) !== 0,
        fullChargeRequest: (b & 0x08) !== 0,
        heatRequest: (b & 0x01) !== 0,
      };
    }
    case BANK_ID.IDENTITY: {
      if (d[0] === 0x44 && d[1] === 0x59) {
        return { manufacturer: 'DY', packNumber: printable(d.subarray(2, 5)) ?? '', batteryType: d[5], capacity: round(u16le(d, 6) * 0.1, 1) };
      }
      if (printable(d.subarray(0, 5)) === 'PYLON') return { manufacturer: 'PYLON', batteryType: d[5], capacity: round(u16le(d, 6) * 0.1, 1) };
      return { manufacturer: printable(d) ?? hex(d), foreign: true };
    }
    case BANK_ID.VICTRON_INFO: {
      const capacityRaw = u16le(d, 4);
      return { batteryType: d[1], firmwareMarker: hex(d.subarray(2, 4)), capacityRaw, capacity: round(capacityRaw * 0.1, 1), suffix: printable(d.subarray(6, 8)) ?? '' };
    }
    case BANK_ID.EXTREMES: {
      const f = { maxCell: u16le(d, 0) / 1000, minCell: u16le(d, 2) / 1000, maxTemp: round(i16le(d, 4) * 0.1, 1), minTemp: round(i16le(d, 6) * 0.1, 1) };
      if (!plausibleCell(f.maxCell) || !plausibleCell(f.minCell) || !plausibleTemp(f.maxTemp) || !plausibleTemp(f.minTemp)) return { ...f, problem: 'extremes out of range' };
      return f;
    }
    case BANK_ID.VERSIONS:
      return { softwareMarker: hex(d.subarray(0, 2)), hardwareMarker: hex(d.subarray(2, 4)) };
    case BANK_ID.COUNTS:
      return { packsNormal: d[0], packsChargeDisabled: d[1], packsDischargeDisabled: d[2], packsCommLost: d[3], packsParallel: d[4] };
    case BANK_ID.GRID_LIMITS:
      return { gridChargeCurrentLimit: round(i16le(d, 0) * 0.1, 1), gridDischargeCurrentLimit: round(i16le(d, 2) * 0.1, 1) };
    default:
      return {};
  }
}

/**
 * @param {number} base
 * @param {Uint8Array} d
 * @returns {Record<string, any>}
 */
function decodePack(base, d) {
  switch (base) {
    case PACK_BASE.FAULTS: {
      const m = d[7];
      return {
        tables: Array.from(d.subarray(0, 7)),
        mosFlags: m,
        parallelDone: (m & 0x01) !== 0,
        chargeMos: (m & 0x10) !== 0,
        dischargeMos: (m & 0x20) !== 0,
        prechargeMos: (m & 0x40) !== 0,
        heaterMos: (m & 0x80) !== 0,
      };
    }
    case PACK_BASE.SUMMARY: {
      const currentWire = round(i16le(d, 2) * 0.1, 1);
      const f = { voltage: round(u16le(d, 0) * 0.1, 1), currentWire, current: currentFromWire(currentWire, 'deye'), soc: round(u16le(d, 4) * 0.1, 1), soh: round(u16le(d, 6) * 0.1, 1) };
      if (!plausibleVoltage(f.voltage) || f.soc > 100 || f.soh > 100 || f.soh === 0) return { ...f, problem: 'pack values out of range' };
      return f;
    }
    case PACK_BASE.EXTREMES: {
      const f = { maxCell: u16le(d, 0) / 1000, minCell: u16le(d, 2) / 1000, maxTemp: round(i16le(d, 4) * 0.1, 1), minTemp: round(i16le(d, 6) * 0.1, 1) };
      if (!plausibleCell(f.maxCell) || !plausibleCell(f.minCell) || !plausibleTemp(f.maxTemp) || !plausibleTemp(f.minTemp)) return { ...f, problem: 'extremes out of range' };
      return f;
    }
    case PACK_BASE.LIMITS: {
      const f = { mosTemp: round(i16le(d, 0) * 0.1, 1), heaterTemp: round(i16le(d, 2) * 0.1, 1), maxChargeCurrent: u16le(d, 4), maxDischargeCurrent: u16le(d, 6) };
      if (!plausibleTemp(f.mosTemp) || !plausibleTemp(f.heaterTemp) || f.maxChargeCurrent > 2000 || f.maxDischargeCurrent > 2000) return { ...f, problem: 'pack limits out of range' };
      return f;
    }
    case PACK_BASE.STATUS: {
      const f = { mode: d[0], faultLevel: d[1], cycles: u16le(d, 2), balancing: u16le(d, 4), subState: u16le(d, 6) };
      return f.mode > 2 || f.faultLevel > 2 ? { ...f, problem: 'mode or fault level out of range' } : f;
    }
    case PACK_BASE.SOFTWARE: {
      const bootVersion = printable(d.subarray(3));
      const f = { firmwareMarker: hex(d.subarray(0, 2)), marker: d[2], bootVersion: bootVersion ?? '' };
      return bootVersion === null ? { ...f, problem: 'boot version not printable' } : f;
    }
    case PACK_BASE.ENERGY:
      return { chargedEnergy: round(u32le(d, 0) * 0.001, 3), dischargedEnergy: round(u32le(d, 4) * 0.001, 3) };
    case PACK_BASE.SERIAL_1:
    case PACK_BASE.SERIAL_2: {
      const text = printable(d);
      return text === null ? { serialPart: '', problem: 'serial number not printable' } : { serialPart: text };
    }
    case PACK_BASE.COUNTS_1:
      return { overchargeCount: u16le(d, 0), overdischargeCount: u16le(d, 2), shortCircuitCount: u16le(d, 4), mosOverTempCount: u16le(d, 6) };
    case PACK_BASE.COUNTS_2:
      return { chargeOvercurrentCount: u16le(d, 0), dischargeOvercurrentCount: u16le(d, 2), chargeOverTempCount: u16le(d, 4), dischargeOverTempCount: u16le(d, 6) };
    default:
      return {};
  }
}

/**
 * Model current (positive while charging) of a wire current: the Deye native 0x356 and every
 * 0x150 send discharge positive, the victronCAN 0x356 charge positive (spec 0, 6.3).
 * @param {number} wire
 * @param {'deye'|'victron'} profile
 */
export function currentFromWire(wire, profile) {
  const v = profile === 'victron' ? wire : -wire;
  return v === 0 ? 0 : round(v, 1);
}

// ---------------------------------------------------------------------------------------------
// Fault tables (spec 9.1)
// ---------------------------------------------------------------------------------------------

/** Driver specific alarm ids and their English labels. */
export const DEYE_ALARM_LABELS = Object.freeze({
  'deye.heater_overtemperature': msg('Heating film overtemperature'),
  'deye.mosfet_short': msg('MOSFET short circuit'),
  'deye.pcs_communication': msg('Inverter (PCS) communication failure'),
  'deye.duplicate_address': msg('Duplicate master address'),
  'deye.connector_overtemperature': msg('Connector overtemperature'),
  'deye.reverse_charge': msg('Reverse charging'),
  'deye.terminal_overtemperature': msg('Terminal overtemperature'),
  'deye.fuse_blown': msg('Fuse blown'),
  'deye.charge_voltage_low': msg('Charging voltage too low'),
  'deye.alarm_raw': msg('BMS alarm bits set (not decoded)'),
});

/**
 * @typedef {{ id: string, severity: 'info'|'warning'|'protection'|'fault', note?: string }} FaultBit
 */

/** @type {(FaultBit | null)[]} table 1 (byte 0) */
const T1 = [
  { id: 'cell_overvoltage', severity: 'protection' },
  { id: 'cell_undervoltage', severity: 'protection' },
  { id: 'pack_overvoltage', severity: 'protection' },
  { id: 'pack_undervoltage', severity: 'protection' },
  { id: 'charge_overcurrent', severity: 'protection' },
  { id: 'discharge_overcurrent', severity: 'protection' },
  { id: 'charge_overtemperature', severity: 'protection' },
  { id: 'charge_undertemperature', severity: 'protection' },
];
/** @type {(FaultBit | null)[]} table 2 (byte 1) */
const T2 = [
  { id: 'discharge_overtemperature', severity: 'protection' },
  { id: 'discharge_undertemperature', severity: 'protection' },
  { id: 'cell_voltage_difference', severity: 'protection' },
  { id: 'temperature_difference', severity: 'protection' },
  { id: 'mos_overtemperature', severity: 'protection' },
  { id: 'deye.heater_overtemperature', severity: 'protection' },
  { id: 'discharge_overcurrent', severity: 'protection', note: 'AFE-OCD1' },
  { id: 'discharge_overcurrent', severity: 'protection', note: 'AFE-OCD2' },
];
/** @type {FaultBit[][]} the seven tables, bit 0 first */
export const FAULT_TABLES = [
  T1,
  T2,
  // Table 3 (byte 2): analog front end protections.
  [
    { id: 'cell_undervoltage', severity: 'protection', note: 'AFE-UV' },
    { id: 'cell_overvoltage', severity: 'protection', note: 'AFE-OV' },
    { id: 'discharge_overcurrent', severity: 'protection', note: 'AFE-OCDL' },
    { id: 'charge_overcurrent', severity: 'protection', note: 'AFE-OCC' },
    { id: 'short_circuit', severity: 'protection', note: 'AFE-SCD' },
    { id: 'afe_fault', severity: 'fault', note: 'AFE-UT' },
    { id: 'afe_fault', severity: 'fault', note: 'AFE-OT' },
    { id: 'short_circuit', severity: 'protection', note: 'AFE-SCDL' },
  ],
  // Table 4 (byte 3): failures. Bit 7 is the duplicate master address per [V33]; [PS] reads bit 3.
  [
    { id: 'afe_fault', severity: 'fault', note: 'AFE communication' },
    { id: 'voltage_sensor_fault', severity: 'fault' },
    { id: 'temperature_sensor_fault', severity: 'fault' },
    { id: 'deye.mosfet_short', severity: 'fault' },
    { id: 'eeprom_fault', severity: 'fault' },
    { id: 'communication_fault', severity: 'fault' },
    { id: 'deye.pcs_communication', severity: 'warning' },
    { id: 'deye.duplicate_address', severity: 'fault' },
  ],
  // Table 5 (byte 4): warnings of table 1.
  T1.map((b) => /** @type {FaultBit} */ ({ ...b, severity: 'warning' })),
  // Table 6 (byte 5): warnings of table 2 bits 0..5, then heater faults.
  [
    ...T2.slice(0, 6).map((b) => /** @type {FaultBit} */ ({ ...b, severity: 'warning' })),
    { id: 'heater_fault', severity: 'fault', note: 'heating MOSFET adhesion' },
    { id: 'heater_fault', severity: 'fault', note: 'heating abnormal' },
  ],
  // Table 7 (byte 6): system errors.
  [
    { id: 'deye.connector_overtemperature', severity: 'protection' },
    { id: 'precharge_fault', severity: 'fault' },
    { id: 'deye.reverse_charge', severity: 'fault' },
    { id: 'deye.terminal_overtemperature', severity: 'protection' },
    { id: 'deye.fuse_blown', severity: 'fault' },
    { id: 'cell_wire_open', severity: 'fault' },
    { id: 'temperature_sensor_fault', severity: 'fault', note: 'sensor wire open' },
    { id: 'deye.charge_voltage_low', severity: 'warning' },
  ],
].map((t) => /** @type {FaultBit[]} */ (t));

/**
 * Alarm states of fault tables from several origins (bank 0x359, per-pack 0x110). One state per
 * id, the most severe wins; the source names the first origin and bit that set it.
 * @param {Array<{ origin: string, tables: number[] }>} list
 * @returns {AlarmState[]}
 */
export function faultAlarms(list) {
  /** @type {Map<string, AlarmState>} */
  const out = new Map();
  for (const { origin, tables } of list) {
    tables.forEach((byte, t) => {
      for (let bit = 0; bit < 8; bit++) {
        if (!((byte >> bit) & 1)) continue;
        const def = FAULT_TABLES[t]?.[bit];
        if (!def) continue;
        const source = `${origin} table ${t + 1} bit ${bit}${def.note ? ` (${def.note})` : ''}`;
        const next = alarm(def.id, { severity: def.severity, label: DEYE_ALARM_LABELS[/** @type {keyof typeof DEYE_ALARM_LABELS} */ (def.id)], source });
        const prev = out.get(def.id);
        if (!prev || SEVERITY_ORDER[/** @type {keyof typeof SEVERITY_ORDER} */ (next.severity ?? 'warning')] < SEVERITY_ORDER[/** @type {keyof typeof SEVERITY_ORDER} */ (prev.severity ?? 'warning')]) out.set(def.id, next);
      }
    });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------------------------
// Firmware with shifted per-pack identifiers (spec 12)
// ---------------------------------------------------------------------------------------------

/** Bit 10, which the shifting firmware clears in every per-pack identifier from 0x400 on. */
const SHIFT = 0x400;
/** Frames whose payload only a shifted frame carries, needed before anything is remapped ([VP]). */
export const SHIFT_EVIDENCE = 2;
/** Fastest plausible growth of the energy counters of one pack ([VP]: 30 kW), in Wh per ms. */
const ENERGY_WH_PER_MS = 30000 / 3600 / 1000;
/** Allowance for the rounding of the energy counters, Wh ([VP]). */
const ENERGY_ALLOWANCE_WH = 10;
/**
 * Bank frames and the inverter heartbeat repeat about every second, the shifted counter frames of a
 * pack every 5.3 s (spec 4.3): a frame that follows the previous one on its identifier within this
 * time comes from a once per second sender.
 */
export const REPEAT_MS = 2500;
/** Bank SOC (0x355) agrees with the mean SOC of the packs (0x150) within this many percent. */
const SOC_AGREEMENT = 5;
/** Bank voltage (0x356) agrees with the mean pack voltage (0x150) within this many volts. */
const VOLTAGE_AGREEMENT = 2;
/** Bank cell extremes (0x361) agree with the extremes of the packs (0x200) within this many volts. */
const CELL_AGREEMENT = 0.05;
/** Per-pack bases at and above 0x400; a battery frame there proves the documented layout. */
const HIGH_BASES = Object.values(PACK_BASE).filter((b) => b >= SHIFT);

/** @param {number} id @param {number} base @param {number} [count] */
const inFamily = (id, base, count = MAX_PACKS) => id >= base && id < base + count;
/** @param {Uint8Array} d */
const allPrintable = (d) => d.every((c) => c >= 0x20 && c <= 0x7e);
/**
 * Shape of a 0x500 frame: firmware marker, separator 0xAA, five printable characters of the boot
 * version (spec 6.2). No 0x110 fault frame has it in practice.
 * @param {Uint8Array} d
 */
const versionShape = (d) => d[2] === 0xaa && allPrintable(d.subarray(3));

/**
 * Shape of a 0x600 / 0x650 serial number half: eight printable characters, or printable text with
 * a character other than a space, padded with NUL or spaces only. A 0x200 frame never has it (the
 * high byte of a cell voltage is 0x03..0x13), nor a plausible 0x250 frame.
 * @param {Uint8Array} d
 */
function textShape(d) {
  if (allPrintable(d)) return true;
  let ended = false;
  let visible = false;
  for (const c of d) {
    if (c === 0) {
      ended = true;
      continue;
    }
    if (c < 0x20 || c > 0x7e || (ended && c !== 0x20)) return false;
    if (c !== 0x20) visible = true;
  }
  return visible;
}

/**
 * Undoes the identifier shift of the Deye firmware that clears bit 10 of every per-pack identifier
 * from 0x400 on (spec 12; a port of [VP] `id_layout.py`): 0x400 + n arrives as 0x000 + n, 0x500 as
 * 0x100, 0x550 as 0x150, 0x600 as 0x200, 0x650 as 0x250, 0x700 as 0x300 and 0x750 as 0x350.
 *
 * Nothing is remapped until two frames prove the shift: a 0x500 shaped frame on 0x100..0x10F, or
 * eight printable characters on 0x200..0x21F or 0x250..0x26F (payloads the documented frames on
 * those identifiers never carry). A battery frame on a documented identifier at or above 0x400
 * proves the documented layout, and then nothing is ever remapped. While the shift is active:
 *
 * - 0x000..0x01F and 0x300..0x31F map back always, except 0x305..0x307 (inverter identifiers):
 *   these map back only when the pack exists and the previous frame on the identifier is older
 *   than REPEAT_MS (the inverter sends every second, the counter frames come every 5.3 s);
 * - 0x100..0x11F only with the 0x500 shape (from pack 17 on, 0x510 + n lands on the 0x110 fault
 *   frames of packs 1..16), 0x200..0x21F and 0x250..0x26F only as serial number text;
 * - 0x150..0x16F when the frame is no plausible summary or continues the energy counters of the
 *   identifier ([VP] continuity check);
 * - 0x350..0x36F when no bank frame uses the identifier. Bank identifiers that collide with the
 *   0x750 frame of an existing pack are checked by `DeyeCanState` instead.
 */
export class ShiftedIdLayout {
  constructor() {
    this.active = false;
    this.documented = false;
    this.evidence = 0;
    this.remapped = 0;
    /** @type {Map<number, { charged: number, discharged: number, at: number }>} */
    this.energy = new Map();
    /** @type {Map<number, number>} last arrival on 0x305..0x307 */
    this.ambiguousAt = new Map();
  }

  /**
   * The documented identifier of a standard frame with 8 data bytes.
   * @param {number} id
   * @param {Uint8Array} d
   * @param {number} now
   * @param {(pack: number) => boolean} hasPack
   */
  normalise(id, d, now, hasPack) {
    if (!this.documented && HIGH_BASES.some((b) => inFamily(id, b))) {
      this.documented = true;
      this.active = false;
    }
    if (this.documented) return id;
    if (!this.active) {
      this.#observe(id, d);
      if (!this.active) return id;
    }
    const target = this.#target(id, d, now, hasPack);
    if (target !== id) this.remapped++;
    return target;
  }

  /** @param {number} id @param {Uint8Array} d */
  #observe(id, d) {
    if ((inFamily(id, 0x100, 16) && versionShape(d)) || ((inFamily(id, 0x200) || inFamily(id, 0x250)) && allPrintable(d))) {
      if (++this.evidence >= SHIFT_EVIDENCE) this.active = true;
    }
  }

  /**
   * @param {number} id
   * @param {Uint8Array} d
   * @param {number} now
   * @param {(pack: number) => boolean} hasPack
   */
  #target(id, d, now, hasPack) {
    if (inFamily(id, 0x000)) return id + SHIFT;
    if (inFamily(id, 0x100)) return versionShape(d) ? id + SHIFT : id;
    if (inFamily(id, 0x150)) return this.#energyFrame(id, d, now) ? id + SHIFT : id;
    if (inFamily(id, 0x200) || inFamily(id, 0x250)) return textShape(d) ? id + SHIFT : id;
    if (inFamily(id, 0x300)) {
      if (id < INVERTER_ID.HEARTBEAT || id > INVERTER_ID.IDENTITY) return id + SHIFT;
      const prev = this.ambiguousAt.get(id);
      this.ambiguousAt.set(id, now);
      if (!hasPack(id - 0x300 + 1) || (prev !== undefined && now - prev <= REPEAT_MS)) return id;
      return id + SHIFT;
    }
    if (inFamily(id, 0x350) && !BANK_NAMES[id]) return id + SHIFT;
    return id;
  }

  /**
   * Tells a shifted 0x550 energy frame from the 0x150 summary on the same identifier ([VP]): a
   * summary has a voltage of 35..65 V, SOC up to 100 % and SOH 0.1..100 %; counters almost never
   * do, and when they happen to, they still continue the previous counters of the identifier.
   * @param {number} id
   * @param {Uint8Array} d
   * @param {number} now
   */
  #energyFrame(id, d, now) {
    const charged = u32le(d, 0);
    const discharged = u32le(d, 4);
    const v = u16le(d, 0);
    const soh = u16le(d, 6);
    const summary = v >= 350 && v <= 650 && u16le(d, 4) <= 1000 && soh > 0 && soh <= 1000;
    const prev = this.energy.get(id);
    let continues = false;
    if (prev) {
      const allowance = ENERGY_ALLOWANCE_WH + ENERGY_WH_PER_MS * Math.max(0, now - prev.at);
      const dc = charged - prev.charged;
      const dd = discharged - prev.discharged;
      continues = dc >= 0 && dc <= allowance && dd >= 0 && dd <= allowance;
    }
    if (summary && !continues) return false;
    this.energy.set(id, { charged, discharged, at: now });
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Bank state
// ---------------------------------------------------------------------------------------------

/** Values older than this are not shown (the slowest frames repeat every 5.3 s, spec 4.3). */
export const STALE_MS = 15000;

/**
 * @typedef {{ fields: Record<string, any>, at: number }} Stamped
 */

/** @param {number[]} a */
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * State of one PCS bus: the latest valid value of every frame, the profile and counters for
 * detection. Frames failing the range checks, and bank frames that collide with a shifted
 * per-pack frame without agreeing with the packs (spec 12), are counted and ignored.
 */
export class DeyeCanState {
  constructor() {
    /** @type {Record<string, Stamped>} */
    this.bank = {};
    /** @type {Map<number, Record<string, Stamped>>} */
    this.packs = new Map();
    /** @type {'deye'|'victron'|undefined} */
    this.profile = undefined;
    /** The latest 0x35E carried the Pylontech identity (victronCAN only together with 0x35F "DY"). */
    this.pylonIdentity = false;
    this.frames = 0;
    this.batteryFrames = 0;
    this.extendedFrames = 0;
    this.rejected = 0;
    this.lastBatteryAt = 0;
    this.inverterAt = 0;
    this.inverterText = '';
    this.layout = new ShiftedIdLayout();
    /** @type {Map<number, { text: string, at: number }>} last payload of colliding bank identifiers */
    this.lastPayload = new Map();
  }

  /**
   * @param {CanFrame} frame
   * @param {number} [now]
   * @returns {DecodedCan | null}
   */
  ingest(frame, now = Date.now()) {
    this.frames++;
    if (frame.extended) {
      this.extendedFrames++;
      return null;
    }
    let f = frame;
    if (!frame.remote && frame.data.length === 8) {
      const id = this.layout.normalise(frame.id, frame.data, now, (p) => this.packs.has(p));
      if (id !== frame.id) f = { ...frame, id };
    }
    const decoded = decodeCanFrame(f, { profile: this.profile ?? 'deye' });
    if (!decoded) return null;
    const d = f === frame ? decoded : { ...decoded, shiftedFrom: frame.id };
    if (d.scope === 'inverter') {
      this.inverterAt = now;
      if (d.name === 'identity' && d.fields.text) this.inverterText = d.fields.text;
      return d;
    }
    const problem = d.problem ?? (d.scope === 'bank' ? this.#bankProblem(d, f.data, now) : null);
    if (problem) {
      this.rejected++;
      return d.problem ? d : { ...d, problem };
    }
    this.batteryFrames++;
    this.lastBatteryAt = now;
    if (d.scope === 'bank') {
      // A Pylontech identity alone is another battery; the Deye victronCAN profile also sends
      // 0x35F ending in "DY" (spec 1.4, 11.2), which switches the profile.
      if (d.name === 'identity') {
        this.pylonIdentity = d.fields.manufacturer === 'PYLON';
        if (d.fields.manufacturer === 'DY') this.profile = 'deye';
      }
      if (d.name === 'victronInfo' && d.fields.suffix === 'DY') this.profile = 'victron';
      this.bank[d.name] = { fields: d.fields, at: now };
    } else {
      const pack = /** @type {number} */ (d.pack);
      let p = this.packs.get(pack);
      if (!p) this.packs.set(pack, (p = {}));
      p[d.name] = { fields: d.fields, at: now };
    }
    return d;
  }

  /**
   * Why a bank frame that passed the range checks is ignored, or null.
   * @param {DecodedCan} d
   * @param {Uint8Array} data
   * @param {number} now
   */
  #bankProblem(d, data, now) {
    // A foreign identity (another battery, or a shifted counter frame) does not replace the
    // identity of a battery seen in the last seconds.
    if (d.name === 'identity' && d.fields.foreign) {
      const prev = this.bank.identity;
      if (prev && !prev.fields.foreign && now - prev.at <= STALE_MS) return 'foreign identity after a battery identity';
    }
    if (!this.layout.active) return null;
    const pack = d.id - 0x350 + 1;
    if (pack < 2 || pack > MAX_PACKS || !this.packs.has(pack)) return null;
    return this.#collisionProblem(d, data, now, pack);
  }

  /**
   * Bank identifier 0x350 + n - 1 of an existing pack n under the shifted layout: the pack's 0x750
   * counter frame arrives there too (spec 12). The bank frame is accepted only when it agrees with
   * the per-pack frames; where no per-pack value compares, it must repeat within REPEAT_MS (the
   * bank sends every second, the counter frame comes every 5.3 s).
   * @param {DecodedCan} d
   * @param {Uint8Array} data
   * @param {number} now
   * @param {number} pack
   */
  #collisionProblem(d, data, now, pack) {
    const why = `0x${d.id.toString(16)} shares its identifier with the shifted 0x${(d.id + SHIFT).toString(16)} of pack ${pack}`;
    const fresh = this.freshPacks(now);
    /** @param {string} frame @param {string} key */
    const values = (frame, key) => fresh.map((p) => p.values[frame]?.[key]).filter((v) => typeof v === 'number');
    switch (d.name) {
      case 'limits':
        // The range checks of 0x351 (charge voltage 40..65 V) already reject counter values.
        return null;
      case 'soc': {
        const socs = values('summary', 'soc');
        return socs.length && Math.abs(d.fields.soc - mean(socs)) <= SOC_AGREEMENT ? null : `${why}: SOC ${d.fields.soc} % disagrees with the packs`;
      }
      case 'measure': {
        const volts = values('summary', 'voltage');
        return volts.length && Math.abs(d.fields.voltage - mean(volts)) <= VOLTAGE_AGREEMENT ? null : `${why}: voltage ${d.fields.voltage} V disagrees with the packs`;
      }
      case 'faults': {
        const tables = fresh.map((p) => p.values.faults?.tables).filter(Boolean);
        const union = Array.from({ length: 7 }, (_, i) => tables.reduce((m, t) => m | t[i], 0));
        return tables.length && union.every((b, i) => b === d.fields.tables[i]) ? null : `${why}: fault bits differ from the packs`;
      }
      case 'extremes': {
        const max = values('extremes', 'maxCell');
        const min = values('extremes', 'minCell');
        const agree = max.length && min.length && Math.abs(d.fields.maxCell - Math.max(...max)) <= CELL_AGREEMENT && Math.abs(d.fields.minCell - Math.min(...min)) <= CELL_AGREEMENT;
        return agree ? null : `${why}: cell extremes disagree with the packs`;
      }
      case 'identity':
        return d.fields.foreign ? `${why}: no battery identity` : null;
      case 'victronInfo':
        return d.fields.suffix === 'DY' ? null : `${why}: no DY suffix`;
      default:
        return this.#repeated(d.id, data, now) ? null : `${why}: not repeated within one bank cycle`;
    }
  }

  /**
   * True when the same payload arrived on the identifier at most REPEAT_MS earlier.
   * @param {number} id
   * @param {Uint8Array} data
   * @param {number} now
   */
  #repeated(id, data, now) {
    const text = hex(data);
    const prev = this.lastPayload.get(id);
    this.lastPayload.set(id, { text, at: now });
    return !!prev && prev.text === text && now - prev.at <= REPEAT_MS;
  }

  /**
   * Fresh bank value.
   * @param {string} name
   * @param {number} now
   */
  bankValue(name, now) {
    const v = this.bank[name];
    return v && now - v.at <= STALE_MS ? v.fields : undefined;
  }

  /**
   * Packs with a fresh frame, ascending, with their fresh values.
   * @param {number} now
   * @returns {Array<{ pack: number, values: Record<string, Record<string, any>> }>}
   */
  freshPacks(now) {
    /** @type {Array<{ pack: number, values: Record<string, Record<string, any>> }>} */
    const out = [];
    for (const [pack, entries] of [...this.packs.entries()].sort((a, b) => a[0] - b[0])) {
      /** @type {Record<string, Record<string, any>>} */
      const values = {};
      for (const [name, v] of Object.entries(entries)) if (now - v.at <= STALE_MS) values[name] = v.fields;
      if (Object.keys(values).length) out.push({ pack, values });
    }
    return out;
  }

  /**
   * Serial number of a pack once both halves arrived (spec 10).
   * @param {number} pack
   */
  serialNumber(pack) {
    const p = this.packs.get(pack);
    const a = p?.serial1?.fields.serialPart;
    const b = p?.serial2?.fields.serialPart;
    return a && b !== undefined ? `${a}${b}`.trim() : undefined;
  }

  /**
   * Detection result (spec 11.2): 0.95 with the Deye identity and a plausible bank frame, 0.6
   * with plausible 0x351, 0x355 and 0x356 plus the Deye per-pack frames 0x110 or 0x150 while no
   * identity frame arrived. A Pylontech or other identity without 0x35F "DY" is another battery.
   * @returns {{ confidence: number, profile: 'deye'|'victron'|undefined } | null}
   */
  detection() {
    const id = this.bank.identity?.fields;
    const vi = this.bank.victronInfo?.fields;
    const deyeIdentity = id?.manufacturer === 'DY' || vi?.suffix === 'DY';
    const limits = !!this.bank.limits;
    const soc = !!this.bank.soc;
    const measure = !!this.bank.measure;
    if (deyeIdentity && (limits || soc || measure)) return { confidence: 0.95, profile: this.profile };
    if (id && !deyeIdentity) return null;
    const perPack = [...this.packs.values()].some((p) => p.faults || p.summary);
    if (limits && soc && measure && perPack) return { confidence: 0.6, profile: this.profile };
    return null;
  }

  /** Why detection failed, for the log. */
  detectionProblem() {
    if (!this.frames) return 'no CAN frames (wrong bit rate or pins, battery off)';
    // InterCAN (250 kbit/s) is invisible at S6; 29-bit frames at 500 kbit/s come from a high
    // voltage control box (spec 6.5) or another bus.
    if (this.extendedFrames === this.frames) return 'only 29-bit frames (a high voltage system or another bus?)';
    const id = this.bank.identity?.fields;
    if (id && id.manufacturer !== 'DY' && this.bank.victronInfo?.fields.suffix !== 'DY') return `identity frame of another battery: ${id.manufacturer}`;
    return 'no Deye frames';
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshot and device information
// ---------------------------------------------------------------------------------------------

/** Labels of per-pack extras in a bank (literal for the translation checker). */
export const PACK_LABELS = [
  msg('Pack 1'), msg('Pack 2'), msg('Pack 3'), msg('Pack 4'), msg('Pack 5'), msg('Pack 6'), msg('Pack 7'), msg('Pack 8'),
  msg('Pack 9'), msg('Pack 10'), msg('Pack 11'), msg('Pack 12'), msg('Pack 13'), msg('Pack 14'), msg('Pack 15'), msg('Pack 16'),
  msg('Pack 17'), msg('Pack 18'), msg('Pack 19'), msg('Pack 20'), msg('Pack 21'), msg('Pack 22'), msg('Pack 23'), msg('Pack 24'),
  msg('Pack 25'), msg('Pack 26'), msg('Pack 27'), msg('Pack 28'), msg('Pack 29'), msg('Pack 30'), msg('Pack 31'), msg('Pack 32'),
];

/** Operation mode of 0x400 byte 0 (spec 9.4). */
export const MODES = [msg('Idle'), msg('Charging'), msg('Discharging')];
/** Fault level of 0x400 byte 1 (spec 9.4). */
export const FAULT_LEVELS = [msg('None'), msg('Minor'), msg('Major')];

/**
 * Numbers of the balancing cells (bit 0 = cell 1).
 * @param {number} mask
 */
function balancingCells(mask) {
  const out = [];
  for (let i = 0; i < 16; i++) if ((mask >> i) & 1) out.push(i + 1);
  return out;
}

/**
 * Unified snapshot of the bank (spec 6.2). Bank frames give the bank values; for a single pack
 * the finer per-pack values (SOC in 0.1 %) are preferred (spec 12). No individual cell voltages
 * are broadcast.
 * @param {DeyeCanState} st
 * @param {number} [now]
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function canSnapshot(st, now = Date.now()) {
  const packs = st.freshPacks(now);
  const single = packs.length === 1 ? packs[0].values : undefined;
  const profile = st.profile ?? 'deye';
  const limits = st.bankValue('limits', now);
  const socFrame = st.bankValue('soc', now);
  const measure = st.bankValue('measure', now);
  const flags = st.bankValue('flags', now);
  const identity = st.bankValue('identity', now);
  const victronInfo = st.bankValue('victronInfo', now);
  const extremes = st.bankValue('extremes', now);
  const counts = st.bankValue('counts', now);
  const grid = st.bankValue('gridLimits', now);
  const faults = st.bankValue('faults', now);

  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {};
  /** @type {Record<string, ExtraValue>} */
  const extra = {};

  // Without a fresh bank frame (not sent, or dropped as a collision under the shifted layout,
  // spec 12) the bank values derive from the per-pack frames.
  const summaries = packs.map((p) => p.values.summary).filter(Boolean);
  if (measure) {
    s.voltage = measure.voltage;
    s.current = currentFromWire(measure.currentWire, profile);
  } else if (packs.length && summaries.length === packs.length) {
    s.voltage = round(mean(summaries.map((v) => v.voltage)), 1);
    s.current = round(summaries.reduce((sum, v) => sum + v.current, 0), 1);
  }
  const soc = single?.summary?.soc ?? socFrame?.soc ?? (summaries.length ? round(mean(summaries.map((v) => v.soc)), 1) : undefined);
  if (soc !== undefined) s.soc = soc;
  const soh = single?.summary?.soh ?? socFrame?.soh ?? (summaries.length ? round(mean(summaries.map((v) => v.soh)), 1) : undefined);
  if (soh !== undefined) s.soh = soh;
  const capacity = identity?.capacity ?? victronInfo?.capacity;
  if (capacity) s.capacityNominal = capacity;
  if (single?.status) s.cycles = single.status.cycles;

  /** @type {TemperatureReading[]} */
  const temperatures = [];
  if (measure) temperatures.push({ id: 'average', label: msg('Average cell temperature'), value: measure.temperature, kind: 'cell' });
  const ext = extremes ?? single?.extremes ?? packExtremes(packs);
  if (ext) {
    temperatures.push({ id: 'max', label: msg('Highest cell temperature'), value: ext.maxTemp, kind: 'cell' });
    temperatures.push({ id: 'min', label: msg('Lowest cell temperature'), value: ext.minTemp, kind: 'cell' });
    extra.maxCell = { label: msg('Highest cell'), value: ext.maxCell, unit: 'V', decimals: 3 };
    extra.minCell = { label: msg('Lowest cell'), value: ext.minCell, unit: 'V', decimals: 3 };
    extra.cellDelta = { label: msg('Cell voltage difference'), value: round(ext.maxCell - ext.minCell, 3), unit: 'V', decimals: 3 };
  }
  if (single?.limits) {
    temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: single.limits.mosTemp, kind: 'mos' });
    // -40.0 degC means no heating film sensor (spec 6.2, 12).
    if (single.limits.heaterTemp > -40) temperatures.push({ id: 'heater', label: msg('Heater temperature'), value: single.limits.heaterTemp, kind: 'heater' });
  }
  if (temperatures.length) s.temperatures = temperatures;

  if (single?.faults) {
    const f = single.faults;
    s.switches = { charge: f.chargeMos, discharge: f.dischargeMos, precharge: f.prechargeMos, heater: f.heaterMos };
  }
  if (single?.status) {
    const cells = balancingCells(single.status.balancing);
    s.balancingActive = cells.length > 0;
    if (cells.length) extra.balancingCells = { label: msg('Balancing cells'), value: cells.join(', ') };
    extra.mode = { label: msg('Operation state'), value: MODES[single.status.mode] ?? String(single.status.mode) };
    extra.faultLevel = { label: msg('Fault level'), value: FAULT_LEVELS[single.status.faultLevel] ?? String(single.status.faultLevel) };
  }

  /** @type {Array<{ origin: string, tables: number[] }>} */
  const tables = [];
  if (faults) tables.push({ origin: 'bank', tables: faults.tables });
  for (const p of packs) if (p.values.faults) tables.push({ origin: `pack ${p.pack}`, tables: p.values.faults.tables });
  s.alarms = faultAlarms(tables);

  if (limits) {
    extra.chargeVoltageLimit = { label: msg('Charge voltage limit'), value: limits.chargeVoltageLimit, unit: 'V', decimals: 1 };
    extra.chargeCurrentLimit = { label: msg('Charge current limit'), value: limits.chargeCurrentLimit, unit: 'A', decimals: 1 };
    extra.dischargeCurrentLimit = { label: msg('Discharge current limit'), value: limits.dischargeCurrentLimit, unit: 'A', decimals: 1 };
    extra.dischargeVoltageLimit = { label: msg('Discharge voltage limit'), value: limits.dischargeVoltageLimit, unit: 'V', decimals: 1 };
  }
  if (grid) {
    extra.gridChargeCurrentLimit = { label: msg('Charge current limit (grid)'), value: grid.gridChargeCurrentLimit, unit: 'A', decimals: 1 };
    extra.gridDischargeCurrentLimit = { label: msg('Discharge current limit (grid)'), value: grid.gridDischargeCurrentLimit, unit: 'A', decimals: 1 };
  }
  if (single?.limits) {
    extra.allowedCharge = { label: msg('Allowed charge current'), value: single.limits.maxChargeCurrent, unit: 'A', decimals: 0 };
    extra.allowedDischarge = { label: msg('Allowed discharge current'), value: single.limits.maxDischargeCurrent, unit: 'A', decimals: 0 };
  }
  if (flags) {
    extra.chargeEnable = { label: msg('Charging allowed'), value: flags.chargeEnable };
    extra.dischargeEnable = { label: msg('Discharging allowed'), value: flags.dischargeEnable };
    if (flags.forceCharge1) extra.forceCharge1 = { label: msg('Force charge request I'), value: true };
    if (flags.forceCharge2) extra.forceCharge2 = { label: msg('Force charge request II'), value: true };
    if (flags.fullChargeRequest) extra.fullChargeRequest = { label: msg('Full charge request'), value: true };
    if (flags.heatRequest) extra.heatRequest = { label: msg('Heating request'), value: true };
  }
  if (packs.length > 1 || (counts && counts.packsParallel > 1)) {
    extra.packCount = { label: msg('Packs in the bank'), value: Math.max(packs.length, counts?.packsParallel ?? 0), decimals: 0 };
  }
  if (counts && (counts.packsChargeDisabled || counts.packsDischargeDisabled || counts.packsCommLost)) {
    extra.packsChargeDisabled = { label: msg('Packs with charging disabled'), value: counts.packsChargeDisabled, decimals: 0 };
    extra.packsDischargeDisabled = { label: msg('Packs with discharging disabled'), value: counts.packsDischargeDisabled, decimals: 0 };
    extra.packsCommLost = { label: msg('Packs without communication'), value: counts.packsCommLost, decimals: 0 };
  }
  if (single?.energy) {
    extra.chargedEnergy = { label: msg('Total charged energy'), value: single.energy.chargedEnergy, unit: 'kWh', decimals: 3 };
    extra.dischargedEnergy = { label: msg('Total discharged energy'), value: single.energy.dischargedEnergy, unit: 'kWh', decimals: 3 };
  }
  if (packs.length > 1) {
    for (const p of packs) extra[`pack${p.pack}`] = { label: PACK_LABELS[p.pack - 1], value: packSummaryText(p.values) };
  }
  if (now - st.inverterAt <= STALE_MS) extra.inverter = { label: msg('Inverter on the bus'), value: st.inverterText || true };
  s.extra = extra;
  return s;
}

/**
 * Cell extremes of a bank from the per-pack 0x200 frames, or undefined.
 * @param {Array<{ pack: number, values: Record<string, Record<string, any>> }>} packs
 */
function packExtremes(packs) {
  const list = packs.map((p) => p.values.extremes).filter(Boolean);
  if (!list.length) return undefined;
  return {
    maxCell: Math.max(...list.map((e) => e.maxCell)),
    minCell: Math.min(...list.map((e) => e.minCell)),
    maxTemp: Math.max(...list.map((e) => e.maxTemp)),
    minTemp: Math.min(...list.map((e) => e.minTemp)),
  };
}

/**
 * One line per pack of a bank, numbers and units only so the text needs no translation: voltage,
 * current, SOC, cell voltage range, cell temperature range.
 * @param {Record<string, Record<string, any>>} v
 */
function packSummaryText(v) {
  const parts = [];
  if (v.summary) parts.push(`${v.summary.voltage.toFixed(1)} V`, `${v.summary.current.toFixed(1)} A`, `${v.summary.soc.toFixed(1)} %`);
  if (v.extremes) {
    parts.push(`${v.extremes.minCell.toFixed(3)}..${v.extremes.maxCell.toFixed(3)} V`);
    parts.push(`${v.extremes.minTemp.toFixed(1)}..${v.extremes.maxTemp.toFixed(1)} °C`);
  }
  return parts.join(', ');
}

/**
 * Device information (spec 10): versions, serial number of pack 1 (both halves), capacity,
 * profile, battery type.
 * @param {DeyeCanState} st
 * @param {string} protocol
 * @returns {DeviceInfo}
 */
export function canInfo(st, protocol) {
  /** @type {DeviceInfo} */
  const info = { vendor: 'Deye', protocol };
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  const first = [...st.packs.keys()].sort((a, b) => a - b)[0];
  const p1 = first !== undefined ? st.packs.get(first) : undefined;
  const sw = p1?.software?.fields;
  const versions = st.bank.versions?.fields;
  const vi = st.bank.victronInfo?.fields;
  const fw = sw?.firmwareMarker ?? versions?.softwareMarker ?? vi?.firmwareMarker;
  if (fw) info.softwareVersion = fw;
  if (sw?.bootVersion) extra.bootVersion = { label: msg('Boot version'), value: sw.bootVersion };
  if (versions?.hardwareMarker) info.hardwareVersion = versions.hardwareMarker;
  const serial = first !== undefined ? st.serialNumber(first) : undefined;
  if (serial) info.serialNumber = serial;
  const id = st.bank.identity?.fields;
  const type = id?.batteryType ?? vi?.batteryType;
  if (type !== undefined) extra.batteryType = { label: msg('Battery type'), value: batteryTypeText(type) };
  const capacity = id?.capacity ?? vi?.capacity;
  if (capacity) extra.capacity = { label: msg('Nominal capacity'), value: capacity, unit: 'Ah', decimals: 1 };
  if (id?.packNumber) extra.packNumber = { label: msg('Pack number'), value: id.packNumber };
  if (st.profile) extra.profile = { label: msg('CAN profile'), value: st.profile === 'victron' ? msg('victronCAN (Pylontech identity)') : msg('Deye native') };
  if (st.packs.size > 1) extra.packCount = { label: msg('Packs in the bank'), value: st.packs.size, decimals: 0 };
  if (Object.keys(extra).length) info.extra = extra;
  return info;
}

// ---------------------------------------------------------------------------------------------
// SLCAN on the frame channel
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * Line bytes the channel sees for a parsed SLCAN message: the frame line or reply plus its
 * terminator. Unknown lines are dropped (the decoder reports them).
 * @param {import('@ubms/transport/slcan').SlcanMessage} m
 * @returns {Uint8Array | null}
 */
function messageBytes(m) {
  switch (m.type) {
    case 'frame':
      return encoder.encode(`${formatSlcanFrame(m.frame)}\r`);
    case 'ok':
      return Uint8Array.of(0x0d);
    case 'error':
      return Uint8Array.of(0x07);
    case 'sent':
      return encoder.encode(m.extended ? 'Z\r' : 'z\r');
    case 'version':
      return encoder.encode(`V${m.value}\r`);
    case 'serial':
      return encoder.encode(`N${m.value}\r`);
    case 'status':
      return encoder.encode(`F${m.value}\r`);
    default:
      return null;
  }
}

/**
 * Assembler for FrameChannel: one "frame" per SLCAN line (CAN frame line, CR acknowledgement or
 * BEL refusal), built on the generic SlcanDecoder.
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void }} handlers
 */
export function createSlcanAssembler({ onFrame, onDiscard }) {
  const decoder = new SlcanDecoder({
    onMessage: (m) => {
      const bytes = messageBytes(m);
      if (bytes) onFrame(bytes);
    },
    onDiscard,
  });
  return { push: (/** @type {Uint8Array} */ c) => decoder.push(c), reset: () => decoder.reset() };
}

/**
 * The SLCAN message of a channel frame.
 * @param {Uint8Array} f
 */
export function slcanMessage(f) {
  if (f.length === 1 && f[0] === 0x07) return /** @type {const} */ ({ type: 'error' });
  const text = String.fromCharCode(...f).replace(/\r$/, '');
  return parseSlcanLine(text);
}

/**
 * Log description of a channel frame.
 * @param {Uint8Array} f
 */
export function describeSlcan(f) {
  const m = slcanMessage(f);
  if (m.type === 'ok') return { name: 'SLCAN OK', decode: () => ({}) };
  if (m.type === 'error') return { name: 'SLCAN refused (BEL)', decode: () => ({}) };
  if (m.type !== 'frame') return { name: `SLCAN ${m.type}`, decode: () => m };
  const fr = m.frame;
  const d = decodeCanFrame(fr);
  const idText = `0x${fr.id.toString(16).toUpperCase().padStart(fr.extended ? 8 : 3, '0')}`;
  if (!d) return { name: `CAN ${idText}${fr.extended ? ' (29-bit)' : ''}`, decode: () => ({ id: fr.id, extended: fr.extended, data: hex(fr.data) }) };
  const what = d.pack ? `${d.name}, pack ${d.pack}` : d.name;
  return { name: `Deye CAN ${idText} ${what}${d.problem ? ' (ignored)' : ''}`, decode: () => ({ id: fr.id, data: hex(fr.data), ...d.fields, ...(d.problem ? { problem: d.problem } : {}) }) };
}
