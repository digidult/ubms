import { FrameAssembler, crc16Modbus, hex, u16be } from '@ubms/transport';
import { alarm, msg } from '@ubms/bms-core';
import { KELVIN, mergeAlarms, rawText, tempFromRaw } from './protocol-v2.js';

/**
 * Seplos BMS 3.0 ("V3", XZH) Modbus RTU, docs/protocols/seplos.md sections 3.3, 5.3, 6.3, 7.3,
 * 7.4, 8.3, 9.8 to 9.10. The same frames run on RS485 and through the Bluetooth module (a UART
 * bridge into the same Modbus server). Pure functions only.
 */

export const FN = Object.freeze({ READ_COILS: 0x01, READ_INPUT: 0x04, WRITE_COILS: 0x0f, WRITE_REGISTERS: 0x10 });

/** Addresses (spec 2.2): the connected or master pack answers 0x00, the PC / display port 0xE0. */
export const ADDRESS = Object.freeze({ MASTER: 0x00, PC: 0xe0 });

/** Data blocks and the request sizes the firmware accepts (spec 5.3). */
export const BLOCK = Object.freeze({
  PIA: { name: 'PIA', fn: FN.READ_INPUT, start: 0x1000, count: 18 },
  PIB: { name: 'PIB', fn: FN.READ_INPUT, start: 0x1100, count: 26 },
  PIC: { name: 'PIC', fn: FN.READ_COILS, start: 0x1200, count: 144 },
  SPA: { name: 'SPA', fn: FN.READ_INPUT, start: 0x1300, count: 106 },
  SFA: { name: 'SFA', fn: FN.READ_COILS, start: 0x1400, count: 80 },
  CALENDAR: { name: 'SCA calendar', fn: FN.READ_INPUT, start: 0x1500, count: 4 },
  VIA_NAME: { name: 'VIA manufacturer', fn: FN.READ_INPUT, start: 0x1700, count: 10 },
  VIA: { name: 'VIA', fn: FN.READ_INPUT, start: 0x1700, count: 51 },
  PCT: { name: 'PCT', fn: FN.READ_INPUT, start: 0x1800, count: 36 },
  EIA: { name: 'EIA', fn: FN.READ_INPUT, start: 0x2000, count: 26 },
  EIB: { name: 'EIB', fn: FN.READ_INPUT, start: 0x2100, count: 22 },
  EIC: { name: 'EIC', fn: FN.READ_COILS, start: 0x2200, count: 80 },
});

/** System control registers (spec 8.3). 0x1519, 0x151A, 0x151C and 0x151D are never written. */
export const SCA = Object.freeze({ CALENDAR: 0x1500, DISCHARGE: 0x1510, CHARGE_OFF: 0x1511, CHARGE_ON: 0x1515, RESTART: 0x1518 });
/** Fixed command patterns of SCA: 0x55AA sets (switches off, restarts), 0xAA55 cancels or switches on. */
export const SCA_VALUE = Object.freeze({ SET: 0x55aa, CANCEL: 0xaa55 });

/** Modbus exception codes (spec 3.3). */
export const EXCEPTION = Object.freeze({ ILLEGAL_FUNCTION: 0x01, ILLEGAL_ADDRESS: 0x02, ILLEGAL_VALUE: 0x03, FAILURE: 0x04, BUSY: 0x06 });

/** Signed value of a u16 register. @param {number} v */
const s16 = (v) => (v << 16) >> 16;

/** @param {number} v @param {number} d */
const rnd = (v, d) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

// ---------------------------------------------------------------------------------------------
// Framing (spec 3.3)
// ---------------------------------------------------------------------------------------------

/** Append the Modbus CRC, low byte first. @param {ArrayLike<number>} body */
export function withCrc(body) {
  const out = new Uint8Array(body.length + 2);
  out.set(body, 0);
  const crc = crc16Modbus(out, 0, body.length);
  out[body.length] = crc & 0xff;
  out[body.length + 1] = crc >> 8;
  return out;
}

/** @param {Uint8Array} f */
export const crcOk = (f) => f.length >= 4 && crc16Modbus(f, 0, f.length - 2) === (f[f.length - 2] | (f[f.length - 1] << 8));

/** Read request (function 0x04 registers or 0x01 coils). @param {number} address @param {number} fn @param {number} start @param {number} count */
export const encodeRead = (address, fn, start, count) => withCrc([address, fn, start >> 8, start & 0xff, count >> 8, count & 0xff]);

/** @param {number} address @param {{ fn: number, start: number, count: number }} block */
export const encodeBlockRead = (address, block) => encodeRead(address, block.fn, block.start, block.count);

/**
 * Function 0x10 write of consecutive registers.
 * @param {number} address
 * @param {number} start
 * @param {number[]} values u16 each
 */
export function encodeWriteRegisters(address, start, values) {
  const body = [address, FN.WRITE_REGISTERS, start >> 8, start & 0xff, values.length >> 8, values.length & 0xff, values.length * 2];
  for (const v of values) body.push((v >> 8) & 0xff, v & 0xff);
  return withCrc(body);
}

/**
 * Function 0x0F write of coils (bit 0 of the first byte is the coil at `start`).
 * @param {number} address
 * @param {number} start
 * @param {number} count
 * @param {number[]} bytes
 */
export function encodeWriteCoils(address, start, count, bytes) {
  return withCrc([address, FN.WRITE_COILS, start >> 8, start & 0xff, count >> 8, count & 0xff, bytes.length, ...bytes]);
}

/**
 * @typedef {Object} ModbusFrame
 * @property {number} address
 * @property {number} function
 * @property {number} [exception]
 * @property {number} [byteCount]
 * @property {Uint8Array} [data]
 * @property {number} [start] write echo
 * @property {number} [count] write echo
 * @property {number} crc low byte first, as the number Modbus documents
 * @property {boolean} crcValid
 */

/**
 * Split an answer frame (read data, write echo or exception).
 * @param {Uint8Array} f
 * @returns {ModbusFrame | null}
 */
export function parseResponse(f) {
  if (!f || f.length < 5) return null;
  /** @type {ModbusFrame} */
  const out = { address: f[0], function: f[1], crc: f[f.length - 2] | (f[f.length - 1] << 8), crcValid: crcOk(f) };
  if (f[1] & 0x80) out.exception = f[2];
  else if (f[1] === FN.WRITE_REGISTERS || f[1] === FN.WRITE_COILS) {
    out.start = u16be(f, 2);
    out.count = u16be(f, 4);
  } else {
    out.byteCount = f[2];
    out.data = f.slice(3, f.length - 2);
  }
  return out;
}

/**
 * Split a request frame (simulator, tests, log).
 * @param {Uint8Array} f
 */
export function parseRequest(f) {
  if (!f || f.length < 8) return null;
  /** @type {{ address: number, function: number, start: number, count: number, byteCount?: number, values?: Uint8Array, crc: number, crcValid: boolean }} */
  const out = { address: f[0], function: f[1], start: u16be(f, 2), count: u16be(f, 4), crc: f[f.length - 2] | (f[f.length - 1] << 8), crcValid: crcOk(f) };
  if (f[1] === FN.WRITE_REGISTERS || f[1] === FN.WRITE_COILS) {
    out.byteCount = f[6];
    out.values = f.slice(7, f.length - 2);
  }
  return out;
}

/** Length of a request frame in a buffer, 0 when more bytes are needed. @param {Uint8Array} buf */
export function requestLength(buf) {
  if (buf.length < 2) return 0;
  if (buf[1] === FN.READ_INPUT || buf[1] === FN.READ_COILS) return 8;
  if (buf[1] === FN.WRITE_REGISTERS || buf[1] === FN.WRITE_COILS) return buf.length < 7 ? 0 : 9 + buf[6];
  return -1;
}

/** Register values of a read answer. @param {Uint8Array} data */
export function registers(data) {
  const out = [];
  for (let o = 0; o + 1 < data.length; o += 2) out.push(u16be(data, o));
  return out;
}

const RESPONSE_FUNCTIONS = [FN.READ_COILS, FN.READ_INPUT, FN.WRITE_COILS, FN.WRITE_REGISTERS];

/**
 * Assembler for answers. Modbus has no start marker, so the address and function bytes of the
 * expected answers are the sync patterns; the byte count of the outstanding read rejects echoed
 * requests and false starts (spec 3.3).
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void, addresses: number[], expectedByteCount?: () => number | undefined }} opts
 */
export function createModbusAssembler({ onFrame, onDiscard, addresses, expectedByteCount = () => undefined }) {
  /** @type {number[][]} */
  const sync = [];
  for (const a of new Set(addresses)) for (const fn of RESPONSE_FUNCTIONS) sync.push([a, fn], [a, fn | 0x80]);
  return new FrameAssembler({
    sync,
    length: (buf) => {
      if (buf.length < 3) return 0;
      const fn = buf[1];
      if (fn & 0x80) return 5;
      if (fn === FN.WRITE_REGISTERS || fn === FN.WRITE_COILS) return 8;
      const expected = expectedByteCount();
      if (expected !== undefined && buf[2] !== expected) return -1;
      return 5 + buf[2];
    },
    validate: crcOk,
    onFrame,
    onDiscard,
    maxLength: 260,
    staleMs: 1500,
  });
}

// ---------------------------------------------------------------------------------------------
// Blocks (spec 6.3)
// ---------------------------------------------------------------------------------------------

/**
 * PIA current unit (spec 6.3.1, 12): 0.01 A on boards rated up to 200 A, 0.1 A on 300 A and
 * 400 A boards. The rating comes from the VIA device name (`SG16S200A-...`); other names keep
 * 0.01 A (unverified).
 * @param {string | undefined} deviceName
 */
export function currentScaleFromName(deviceName) {
  const m = /\d{1,2}S(\d{3})A/i.exec(deviceName ?? '');
  const rating = m ? Number(m[1]) : undefined;
  return { rating, scale: rating !== undefined && rating >= 300 ? 0.1 : 0.01 };
}

/**
 * PIA, pack information A (spec 6.3.1).
 * @param {number[]} r registers from 0x1000
 * @param {{ currentScale?: number }} [opts]
 */
export function parsePia(r, { currentScale = 0.01 } = {}) {
  if (r.length < 17) throw new Error(`PIA: ${r.length} registers`);
  /** @type {Record<string, number>} */
  const out = {
    voltage: r[0] / 100,
    current: rnd(s16(r[1]) * currentScale, 2),
    remainingAh: r[2] / 100,
    totalAh: r[3] / 100,
    dischargedAh: r[4] * 10,
    soc: r[5] / 10,
    soh: r[6] / 10,
    cycles: r[7],
    avgCellVoltage: r[8] / 1000,
    avgCellTemp: tempFromRaw(r[9]),
    maxCellVoltage: r[10] / 1000,
    minCellVoltage: r[11] / 1000,
    maxCellTemp: tempFromRaw(r[12]),
    minCellTemp: tempFromRaw(r[13]),
    reg100E: r[14],
    maxDischargeCurrent: r[15],
    maxChargeCurrent: r[16],
  };
  if (r.length > 17) out.reg1011 = r[17];
  return out;
}

/**
 * PIB, cell voltages and temperatures (spec 6.3.2). Always 16 cell slots and 4 cell sensors.
 * @param {number[]} r registers from 0x1100
 */
export function parsePib(r) {
  if (r.length < 26) throw new Error(`PIB: ${r.length} registers`);
  return {
    cellVoltages: r.slice(0, 16).map((v) => v / 1000),
    cellTemps: r.slice(16, 20).map(tempFromRaw),
    reservedTemps: r.slice(20, 24),
    ambientTemp: tempFromRaw(r[24]),
    powerTemp: tempFromRaw(r[25]),
  };
}

/** @param {number} b @param {number} offset @param {number} n */
const bitList = (b, offset, n = 8) => Array.from({ length: n }, (_, i) => ((b >> i) & 1) === 1).map((on, i) => (on ? offset + i : -1)).filter((i) => i >= 0);

/**
 * PIC, per cell flags and the state and event bytes of the pack (spec 6.3.3), 18 bytes.
 * @param {Uint8Array | number[]} b
 */
export function parsePic(b) {
  if (b.length < 18) throw new Error(`PIC: ${b.length} bytes`);
  return {
    bytes: [...b].slice(0, 18),
    cellLow: [...bitList(b[0], 0), ...bitList(b[1], 8)],
    cellHigh: [...bitList(b[2], 0), ...bitList(b[3], 8)],
    tempLow: bitList(b[4], 0),
    tempHigh: bitList(b[5], 0),
    balancing: [...bitList(b[6], 0), ...bitList(b[7], 8)],
    state: eventBytes(b, 8),
  };
}

/**
 * EIC, the state and event bytes of the bank (spec 6.3.8), 10 bytes.
 * @param {Uint8Array | number[]} b
 */
export function parseEic(b) {
  if (b.length < 10) throw new Error(`EIC: ${b.length} bytes`);
  return { bytes: [...b].slice(0, 10), state: eventBytes(b, 0) };
}

/**
 * The ten state and event bytes shared by PIC (from byte 8) and EIC (from byte 0), table 9.9.
 * @param {ArrayLike<number>} b
 * @param {number} o
 */
function eventBytes(b, o) {
  return {
    system: b[o],
    voltage: b[o + 1],
    cellTemp: b[o + 2],
    otherTemp: b[o + 3],
    current1: b[o + 4],
    current2: b[o + 5],
    capacity: b[o + 6],
    fet: b[o + 7],
    balance: b[o + 8],
    hardware: b[o + 9],
  };
}

/** @typedef {ReturnType<typeof eventBytes>} EventState */

/**
 * VIA, version information (spec 6.3.4): strings in natural byte order, NUL padded.
 * @param {Uint8Array} data 102 bytes (or 20 for the manufacturer read of the probe)
 */
export function parseVia(data) {
  const t = (/** @type {number} */ o, /** @type {number} */ n) => rawText(data, o, n).trim();
  /** @type {Record<string, string>} */
  const out = { manufacturer: t(0, 20) };
  if (data.length >= 40) out.deviceName = t(20, 20);
  if (data.length >= 42) out.firmware = t(40, 2);
  if (data.length >= 72) out.bmsSerial = t(42, 30);
  if (data.length >= 102) out.packSerial = t(72, 30);
  return out;
}

/**
 * Inverter protocol word of PCT 0x1800. Firmware V1.43l sends it low byte first (05 00 = 5) while
 * Seplos writes it high byte first (00 01); a value below 256 is the non zero byte (spec 6.3.5, 12).
 * @param {number} hi first byte
 * @param {number} lo second byte
 */
export const protocolNumber = (hi, lo) => (hi === 0 ? lo : lo === 0 ? hi : (hi << 8) | lo);

/**
 * PCT, inverter information (spec 6.3.5).
 * @param {Uint8Array} data 72 bytes
 */
export function parsePct(data) {
  if (data.length < 72) throw new Error(`PCT: ${data.length} bytes`);
  return {
    protocol: protocolNumber(data[0], data[1]),
    baud: u16be(data, 2),
    inverterName: rawText(data, 4, 32).trim(),
    protocolName: rawText(data, 36, 32).trim(),
    protocolVersion: rawText(data, 68, 2).trim(),
    prefetch: u16be(data, 70),
  };
}

/** u32 sent low word first (spec 6.3.6). @param {number[]} r @param {number} i */
const u32lw = (r, i) => ((r[i + 1] << 16) | r[i]) >>> 0;

/**
 * EIA, bank summary (spec 6.3.6): 32-bit values low word first, current in 0.1 A.
 * @param {number[]} r registers from 0x2000
 */
export function parseEia(r) {
  if (r.length < 26) throw new Error(`EIA: ${r.length} registers`);
  return {
    voltage: u32lw(r, 0) / 100,
    current: rnd((u32lw(r, 2) | 0) / 10, 1),
    remainingAh: u32lw(r, 4) / 100,
    totalAh: u32lw(r, 6) / 100,
    dischargedAh: u32lw(r, 8) * 10,
    ratedAh: u32lw(r, 10) / 100,
    onlineMask: u32lw(r, 12),
    protectMask: u32lw(r, 14),
    maxDischargeCurrent: u32lw(r, 16) / 10,
    maxChargeCurrent: u32lw(r, 18) / 10,
    suggestOv: r[20] / 10,
    suggestUv: r[21] / 10,
    packCount: r[22],
    cycles: r[23],
    soc: r[24] / 10,
    soh: r[25] / 10,
  };
}

/**
 * EIB, bank extremes (spec 6.3.7): temperatures in 0.1 degrees C (not Kelvin). The position pairs
 * may be swapped between the document and the firmware (unverified).
 * @param {number[]} r registers from 0x2100
 */
export function parseEib(r) {
  if (r.length < 22) throw new Error(`EIB: ${r.length} registers`);
  const c = (/** @type {number} */ v) => s16(v) / 10;
  return {
    maxCellVoltage: r[0] / 1000,
    minCellVoltage: r[1] / 1000,
    maxCellPos: r[2],
    minCellPos: r[3],
    maxPackVoltage: r[4] / 100,
    minPackVoltage: r[5] / 100,
    maxPackPos: r[6],
    minPackPos: r[7],
    maxCellTemp: c(r[8]),
    minCellTemp: c(r[9]),
    avgCellTemp: c(r[10]),
    maxTempPos: r[11],
    minTempPos: r[12],
    maxSoc: r[13] / 10,
    minSoc: r[14] / 10,
    maxCycles: r[15],
    maxSoh: r[16] / 10,
    maxPowerTemp: c(r[17]),
    minPowerTemp: c(r[18]),
    avgPowerTemp: c(r[19]),
    maxPowerTempPos: r[20],
    minPowerTempPos: r[21],
  };
}

/**
 * SCA calendar (spec 8.3, [XZH] table 4.21): year low byte, year high byte, month, day, hour,
 * minute, second, reserved, in this byte order on the wire.
 * @param {Uint8Array} data 8 bytes
 */
export function parseCalendar(data) {
  if (data.length < 8) throw new Error('Calendar: short');
  const year = data[0] | (data[1] << 8);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return { year, month: data[2], day: data[3], hour: data[4], minute: data[5], second: data[6], text: `${year}-${pad(data[2])}-${pad(data[3])} ${pad(data[4])}:${pad(data[5])}:${pad(data[6])}` };
}

/**
 * Register values of the calendar write: the bytes of table 4.21 as four big endian words.
 * @param {Date} d local time of this computer
 */
export function calendarRegisters(d) {
  const y = d.getFullYear();
  const b = [y & 0xff, (y >> 8) & 0xff, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), 0];
  return [0, 2, 4, 6].map((i) => (b[i] << 8) | b[i + 1]);
}

// ---------------------------------------------------------------------------------------------
// SPA parameters (spec 7.3) and SFA switches (spec 7.4)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} SpaRegister
 * @property {number} reg
 * @property {string} id ubms setting id
 * @property {'u16'|'s16'} type
 * @property {number} scale engineering units per raw step
 * @property {'temp'} [kind] 0.1 K with offset 2731
 * @property {boolean} [negate] discharge current stored negative, shown as a magnitude
 * @property {'yes'|'danger'|'no'} write
 * @property {string} [reason] why a register stays read only
 */

/** Read only reasons (English, shown as the field description). */
export const SPA_REASONS = Object.freeze({
  float: msg('The vendor document marks this register as not writable, so it is shown read only.'),
  compensation: msg('Sources disagree on the unit (0.1 or 1 milliohm), so it is shown read only.'),
  protocol: msg('Changes the inverter link and is described only by community sources, so it is shown read only.'),
  correction: msg('Meaning not confirmed by the vendor, so it is shown read only.'),
});

/** @type {SpaRegister[]} */
export const SPA_REGISTERS = [
  { reg: 0x1300, id: 'system.temp_sensor_count', type: 'u16', scale: 1, write: 'danger' },
  { reg: 0x1301, id: 'system.cell_count', type: 'u16', scale: 1, write: 'danger' },
  { reg: 0x1302, id: 'seplos.pack_ov_alarm_recovery', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1303, id: 'pack.ov_alarm', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1304, id: 'pack.ovpr', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1305, id: 'pack.ovp', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1306, id: 'seplos.pack_uv_alarm_recovery', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1307, id: 'pack.uv_alarm', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1308, id: 'pack.uvpr', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1309, id: 'pack.uvp', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x130a, id: 'seplos.cell_ov_alarm_recovery', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x130b, id: 'cell.ov_alarm', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x130c, id: 'cell.ovpr', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x130d, id: 'cell.ovp', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x130e, id: 'seplos.cell_uv_alarm_recovery', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x130f, id: 'cell.uv_alarm', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1310, id: 'cell.uvpr', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1311, id: 'cell.uvp', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1312, id: 'seplos.cell_uv_failure', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1313, id: 'cell.diff_protection', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1314, id: 'seplos.cell_diff_protection_recovery', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1315, id: 'seplos.charge_oc_recovery', type: 's16', scale: 1, write: 'yes' },
  { reg: 0x1316, id: 'charge.oc_alarm', type: 's16', scale: 1, write: 'yes' },
  { reg: 0x1317, id: 'charge.ocp', type: 's16', scale: 1, write: 'yes' },
  { reg: 0x1318, id: 'charge.ocp_delay', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1319, id: 'seplos.charge_ocp2', type: 's16', scale: 1, write: 'yes' },
  { reg: 0x131a, id: 'seplos.charge_ocp2_delay', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x131b, id: 'seplos.discharge_oc_recovery', type: 's16', scale: 1, negate: true, write: 'yes' },
  { reg: 0x131c, id: 'discharge.oc_alarm', type: 's16', scale: 1, negate: true, write: 'yes' },
  { reg: 0x131d, id: 'discharge.ocp', type: 's16', scale: 1, negate: true, write: 'yes' },
  { reg: 0x131e, id: 'discharge.ocp_delay', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x131f, id: 'discharge.ocp2', type: 's16', scale: 1, negate: true, write: 'yes' },
  { reg: 0x1320, id: 'discharge.ocp2_delay', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x1321, id: 'scp.current', type: 's16', scale: 1, negate: true, write: 'yes' },
  { reg: 0x1322, id: 'scp.delay', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x1323, id: 'seplos.oc_recovery_delay', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1324, id: 'seplos.oc_lockout_count', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x1325, id: 'seplos.charge_limit_duration', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1326, id: 'seplos.pulse_limit_current', type: 's16', scale: 1, write: 'yes' },
  { reg: 0x1327, id: 'seplos.pulse_limit_time', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1328, id: 'seplos.float_lock_voltage', type: 'u16', scale: 0.001, write: 'no', reason: SPA_REASONS.float },
  { reg: 0x1329, id: 'seplos.float_release_voltage', type: 'u16', scale: 0.001, write: 'no', reason: SPA_REASONS.float },
  { reg: 0x132a, id: 'seplos.float_lock_current', type: 's16', scale: 0.001, write: 'no', reason: SPA_REASONS.float },
  { reg: 0x132b, id: 'seplos.precharge_ratio_short', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x132c, id: 'seplos.precharge_ratio_normal', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x132d, id: 'seplos.precharge_ratio_abnormal', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x132e, id: 'seplos.precharge_timeout', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x132f, id: 'seplos.charge_ot_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1330, id: 'seplos.charge_ot_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1331, id: 'charge.otpr', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1332, id: 'charge.otp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1333, id: 'seplos.charge_ut_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1334, id: 'seplos.charge_ut_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1335, id: 'charge.utpr', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1336, id: 'charge.utp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1337, id: 'seplos.discharge_ot_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1338, id: 'seplos.discharge_ot_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1339, id: 'discharge.otpr', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x133a, id: 'discharge.otp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x133b, id: 'seplos.discharge_ut_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x133c, id: 'seplos.discharge_ut_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x133d, id: 'discharge.utpr', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x133e, id: 'discharge.utp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x133f, id: 'seplos.ambient_ot_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1340, id: 'seplos.ambient_ot_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1341, id: 'seplos.ambient_otp_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1342, id: 'seplos.ambient_otp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1343, id: 'seplos.ambient_ut_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1344, id: 'seplos.ambient_ut_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1345, id: 'seplos.ambient_utp_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1346, id: 'seplos.ambient_utp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1347, id: 'seplos.mos_ot_alarm_recovery', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1348, id: 'seplos.mos_ot_alarm', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x1349, id: 'mos.otpr', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x134a, id: 'mos.otp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x134b, id: 'seplos.heating_stop', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x134c, id: 'seplos.heating_start', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x134d, id: 'seplos.balance_max_temp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x134e, id: 'seplos.balance_min_temp', type: 'u16', scale: 0.1, kind: 'temp', write: 'yes' },
  { reg: 0x134f, id: 'seplos.static_balance_time', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x1350, id: 'balance.start_voltage', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1351, id: 'balance.trigger_delta', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1352, id: 'seplos.balance_stop_delta', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1353, id: 'seplos.top_up_soc', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1354, id: 'seplos.soc_low_alarm_recovery', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1355, id: 'soc.low_alarm', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1356, id: 'seplos.soc_low_protection_recovery', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1357, id: 'seplos.soc_low_protection', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x1358, id: 'capacity.nominal', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1359, id: 'seplos.full_capacity', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x135a, id: 'capacity.remaining', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x135b, id: 'system.sleep_delay', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x135c, id: 'seplos.forced_output_delay', type: 'u16', scale: 0.1, write: 'yes' },
  { reg: 0x135d, id: 'seplos.forced_output_interval', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x135e, id: 'seplos.forced_output_count', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x135f, id: 'seplos.comp1_cell', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x1360, id: 'seplos.comp1_resistance', type: 'u16', scale: 0.1, write: 'no', reason: SPA_REASONS.compensation },
  { reg: 0x1361, id: 'seplos.comp2_cell', type: 'u16', scale: 1, write: 'yes' },
  { reg: 0x1362, id: 'seplos.comp2_resistance', type: 'u16', scale: 0.1, write: 'no', reason: SPA_REASONS.compensation },
  { reg: 0x1363, id: 'cell.diff_alarm', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1364, id: 'seplos.cell_diff_alarm_recovery', type: 'u16', scale: 0.001, write: 'yes' },
  { reg: 0x1365, id: 'seplos.charge_request_voltage', type: 'u16', scale: 0.01, write: 'yes' },
  { reg: 0x1366, id: 'seplos.charge_request_current', type: 's16', scale: 1, write: 'yes' },
  { reg: 0x1367, id: 'seplos.discharge_request_current', type: 's16', scale: 1, negate: true, write: 'yes' },
  { reg: 0x1368, id: 'seplos.inverter_protocol', type: 'u16', scale: 1, write: 'no', reason: SPA_REASONS.protocol },
  { reg: 0x1369, id: 'seplos.current_correction', type: 'u16', scale: 1, write: 'no', reason: SPA_REASONS.correction },
];

export const SPA_FIRST = 0x1300;
export const SPA_LAST = 0x1369;

/** @type {Map<number, SpaRegister>} */
export const SPA_BY_REG = new Map(SPA_REGISTERS.map((r) => [r.reg, r]));

/** @param {SpaRegister} r */
const decimalsOf = (r) => (r.scale >= 1 ? 0 : Math.round(-Math.log10(r.scale)));

/**
 * Engineering value of one SPA register.
 * @param {SpaRegister} def
 * @param {number} raw u16 as read
 */
export function spaValue(def, raw) {
  const v = def.type === 's16' ? s16(raw) : raw;
  if (def.kind === 'temp') return tempFromRaw(v);
  const x = rnd(v * def.scale, decimalsOf(def));
  return def.negate ? -x : x;
}

/**
 * Raw u16 of an engineering value (temperatures 0.1 K, discharge currents negative).
 * @param {SpaRegister} def
 * @param {number} value
 */
export function spaRaw(def, value) {
  const signed = def.kind === 'temp' ? Math.round(value * 10) + KELVIN : Math.round((def.negate ? -value : value) / def.scale);
  const [lo, hi] = def.type === 's16' ? [-32768, 32767] : [0, 65535];
  if (!Number.isFinite(signed) || signed < lo || signed > hi) throw new RangeError(`${def.id}: ${value} is out of range`);
  return signed & 0xffff;
}

/** Registers kept out of a write as the neighbour where possible (spec 7.5: read only or moving). */
const NEIGHBOUR_AVOID = new Set([...SPA_REGISTERS.filter((r) => r.write === 'no').map((r) => r.reg), 0x135a]);

/**
 * Register pair of a two register SPA write (spec 7.5): the target and r + 1, or r - 1 when r + 1
 * is past the block, moves while the pack works (0x135A) or is read only.
 * @param {number} reg
 * @returns {number} the first register of the pair
 */
export function spaPairStart(reg) {
  if (reg + 1 <= SPA_LAST && !NEIGHBOUR_AVOID.has(reg + 1)) return reg;
  if (reg - 1 >= SPA_FIRST && !NEIGHBOUR_AVOID.has(reg - 1)) return reg - 1;
  return reg + 1 <= SPA_LAST ? reg : reg - 1;
}

/**
 * @typedef {Object} SfaBit
 * @property {number} byte 0..9 (coil 0x1400 + 8 * byte + bit)
 * @property {number} bit
 * @property {string} id
 * @property {string} label
 * @property {boolean} [readOnly]
 * @property {string} [reason]
 * @property {boolean} [advanced]
 * @property {boolean} [danger] the bit enables an alarm, protection, lockout or failure detection
 */

/** Reason of the Bluetooth module switch: switching it off over Bluetooth cuts the link. */
export const BLUETOOTH_SWITCH_REASON = msg('Switching the Bluetooth module off over Bluetooth would cut the connection, so it is shown read only.');

/** Bit names of the voltage, cell temperature and other temperature bytes (shared with the V2 event names). */
const SFA_NAMES = {
  v: [
    msg('Cell high voltage alarm'),
    msg('Cell overvoltage protection'),
    msg('Cell low voltage alarm'),
    msg('Cell undervoltage protection'),
    msg('Pack high voltage alarm'),
    msg('Pack overvoltage protection'),
    msg('Pack low voltage alarm'),
    msg('Pack undervoltage protection'),
  ],
  ct: [
    msg('Charge high temperature alarm'),
    msg('Charge overtemperature protection'),
    msg('Charge low temperature alarm'),
    msg('Charge undertemperature protection'),
    msg('Discharge high temperature alarm'),
    msg('Discharge overtemperature protection'),
    msg('Discharge low temperature alarm'),
    msg('Discharge undertemperature protection'),
  ],
  at: [
    msg('Ambient high temperature alarm'),
    msg('Ambient overtemperature protection'),
    msg('Ambient low temperature alarm'),
    msg('Ambient undertemperature protection'),
    msg('MOSFET high temperature alarm'),
    msg('MOSFET overtemperature protection'),
    msg('Cell low temperature heating'),
    msg('Cell voltage failure'),
  ],
  c1: [
    msg('Charge overcurrent alarm'),
    msg('Charge overcurrent protection'),
    msg('Charge overcurrent protection, level 2'),
    msg('Discharge overcurrent alarm'),
    msg('Discharge overcurrent protection'),
    msg('Discharge overcurrent protection, level 2'),
    msg('Output short circuit protection'),
  ],
  c2: [msg('Output short circuit lockout'), msg('Reverse connection protection'), msg('Charge level 2 lockout'), msg('Discharge level 2 lockout')],
  fd: [
    msg('NTC failure detection'),
    msg('AFE failure detection'),
    msg('Charge MOSFET failure detection'),
    msg('Discharge MOSFET failure detection'),
    msg('Cell failure detection'),
    msg('Open wire detection'),
    msg('Button failure detection'),
    msg('Aerosol alarm detection'),
  ],
};

/**
 * SFA function switch bits (spec 7.4, table 9.10). Reserved bits are not listed; 0x1418 bit 0
 * (Bluetooth module) stays read only. Bytes 0, 1, 2 (except bit 6, the heating), 4, 5 and 9 and
 * the low SOC alarm and protection bits of byte 6 enable alarms, protections, lockouts and failure
 * detections: they are marked danger.
 * @type {SfaBit[]}
 */
export const SFA_BITS = [
  ...SFA_NAMES.v.map((label, bit) => ({ byte: 0, bit, id: `seplos.fn_v${bit}`, label, advanced: true, danger: true })),
  ...SFA_NAMES.ct.map((label, bit) => ({ byte: 1, bit, id: `seplos.fn_ct${bit}`, label, advanced: true, danger: true })),
  ...SFA_NAMES.at.map((label, bit) => ({ byte: 2, bit, id: `seplos.fn_at${bit}`, label, advanced: true, ...(bit === 6 ? {} : { danger: true }) })),
  { byte: 3, bit: 0, id: 'seplos.fn_bluetooth', label: msg('Bluetooth module'), readOnly: true, reason: BLUETOOTH_SWITCH_REASON },
  { byte: 3, bit: 1, id: 'seplos.fn_fan', label: msg('Cooling fan') },
  { byte: 3, bit: 2, id: 'seplos.fn_leds', label: msg('Capacity LEDs always on') },
  { byte: 3, bit: 3, id: 'seplos.fn_snmp', label: msg('SNMP module'), advanced: true },
  { byte: 3, bit: 4, id: 'seplos.fn_wifi', label: msg('Wi-Fi module'), advanced: true },
  { byte: 3, bit: 5, id: 'seplos.fn_dhcp', label: msg('DHCP'), advanced: true },
  { byte: 3, bit: 6, id: 'seplos.fn_gyro', label: msg('Gyro module'), advanced: true },
  ...SFA_NAMES.c1.map((label, bit) => ({ byte: 4, bit, id: `seplos.fn_c1_${bit}`, label, advanced: true, danger: true })),
  ...SFA_NAMES.c2.map((label, bit) => ({ byte: 5, bit, id: `seplos.fn_c2_${bit}`, label, advanced: true, danger: true })),
  { byte: 6, bit: 0, id: 'seplos.fn_soc_alarm', label: msg('Low SOC alarm'), advanced: true, danger: true },
  { byte: 6, bit: 1, id: 'seplos.fn_top_up', label: msg('Top-up charge') },
  { byte: 6, bit: 2, id: 'seplos.fn_external_switch', label: msg('External switch control'), advanced: true },
  { byte: 6, bit: 3, id: 'seplos.fn_standby_sleep', label: msg('Standby sleep') },
  { byte: 6, bit: 4, id: 'seplos.fn_history', label: msg('History recording') },
  { byte: 6, bit: 5, id: 'seplos.fn_soc_protection', label: msg('Low SOC protection'), advanced: true, danger: true },
  { byte: 6, bit: 6, id: 'seplos.fn_active_current_limit', label: msg('Active current limiting') },
  { byte: 6, bit: 7, id: 'seplos.fn_passive_current_limit', label: msg('Passive current limiting') },
  { byte: 7, bit: 0, id: 'balance.enabled', label: msg('Balancer enabled') },
  { byte: 7, bit: 1, id: 'seplos.fn_static_balance', label: msg('Static balancing') },
  { byte: 7, bit: 2, id: 'seplos.fn_balance_timeout', label: msg('Static balancing timeout') },
  { byte: 7, bit: 3, id: 'seplos.fn_balance_overtemp', label: msg('Balancing temperature limit') },
  { byte: 8, bit: 0, id: 'switch.buzzer', label: msg('Buzzer and indicator lights') },
  { byte: 8, bit: 1, id: 'seplos.fn_lcd', label: msg('LCD display') },
  { byte: 8, bit: 2, id: 'seplos.fn_manual_forced_output', label: msg('Manual forced output'), advanced: true },
  { byte: 8, bit: 3, id: 'seplos.fn_auto_forced_output', label: msg('Automatic forced output'), advanced: true },
  { byte: 8, bit: 4, id: 'seplos.fn_uv_recovery', label: msg('Undervoltage recovery'), advanced: true },
  { byte: 8, bit: 5, id: 'seplos.fn_aerosol_test', label: msg('Aerosol test'), advanced: true },
  { byte: 8, bit: 6, id: 'seplos.fn_aerosol_disconnect', label: msg('Aerosol disconnect mode'), advanced: true },
  { byte: 8, bit: 7, id: 'seplos.fn_current_temp_comp', label: msg('Current sensor temperature compensation'), advanced: true },
  ...SFA_NAMES.fd.map((label, bit) => ({ byte: 9, bit, id: `seplos.fn_fd${bit}`, label, advanced: true, danger: true })),
];

// ---------------------------------------------------------------------------------------------
// State and event bits (spec 9.9)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} V3EventBit
 * @property {keyof EventState} byte
 * @property {number} bit
 * @property {string} id
 * @property {'info'|'warning'|'protection'|'fault'} severity
 * @property {string} [label]
 * @property {'cellHigh'|'cellLow'|'tempHigh'|'tempLow'} [cells]
 */

/** @type {V3EventBit[]} */
export const V3_EVENT_BITS = [
  { byte: 'voltage', bit: 0, id: 'cell_overvoltage', severity: 'warning', cells: 'cellHigh' },
  { byte: 'voltage', bit: 1, id: 'cell_overvoltage', severity: 'protection', cells: 'cellHigh' },
  { byte: 'voltage', bit: 2, id: 'cell_undervoltage', severity: 'warning', cells: 'cellLow' },
  { byte: 'voltage', bit: 3, id: 'cell_undervoltage', severity: 'protection', cells: 'cellLow' },
  { byte: 'voltage', bit: 4, id: 'pack_overvoltage', severity: 'warning' },
  { byte: 'voltage', bit: 5, id: 'pack_overvoltage', severity: 'protection' },
  { byte: 'voltage', bit: 6, id: 'pack_undervoltage', severity: 'warning' },
  { byte: 'voltage', bit: 7, id: 'pack_undervoltage', severity: 'protection' },
  { byte: 'cellTemp', bit: 0, id: 'charge_overtemperature', severity: 'warning', cells: 'tempHigh' },
  { byte: 'cellTemp', bit: 1, id: 'charge_overtemperature', severity: 'protection', cells: 'tempHigh' },
  { byte: 'cellTemp', bit: 2, id: 'charge_undertemperature', severity: 'warning', cells: 'tempLow' },
  { byte: 'cellTemp', bit: 3, id: 'charge_undertemperature', severity: 'protection', cells: 'tempLow' },
  { byte: 'cellTemp', bit: 4, id: 'discharge_overtemperature', severity: 'warning', cells: 'tempHigh' },
  { byte: 'cellTemp', bit: 5, id: 'discharge_overtemperature', severity: 'protection', cells: 'tempHigh' },
  { byte: 'cellTemp', bit: 6, id: 'discharge_undertemperature', severity: 'warning', cells: 'tempLow' },
  { byte: 'cellTemp', bit: 7, id: 'discharge_undertemperature', severity: 'protection', cells: 'tempLow' },
  { byte: 'otherTemp', bit: 0, id: 'ambient_overtemperature', severity: 'warning' },
  { byte: 'otherTemp', bit: 1, id: 'ambient_overtemperature', severity: 'protection' },
  { byte: 'otherTemp', bit: 2, id: 'ambient_undertemperature', severity: 'warning' },
  { byte: 'otherTemp', bit: 3, id: 'ambient_undertemperature', severity: 'protection' },
  // Alarm before protection on V3, the reverse of V2 event 4 ([XZH] 4.4).
  { byte: 'otherTemp', bit: 4, id: 'mos_overtemperature', severity: 'warning' },
  { byte: 'otherTemp', bit: 5, id: 'mos_overtemperature', severity: 'protection' },
  { byte: 'otherTemp', bit: 6, id: 'seplos.heating', severity: 'info', label: msg('Cell heating active') },
  { byte: 'current1', bit: 0, id: 'charge_overcurrent', severity: 'warning' },
  { byte: 'current1', bit: 1, id: 'charge_overcurrent', severity: 'protection' },
  { byte: 'current1', bit: 2, id: 'charge_overcurrent', severity: 'protection', label: msg('Charge overcurrent protection, level 2') },
  { byte: 'current1', bit: 3, id: 'discharge_overcurrent', severity: 'warning' },
  { byte: 'current1', bit: 4, id: 'discharge_overcurrent', severity: 'protection' },
  { byte: 'current1', bit: 5, id: 'discharge_overcurrent', severity: 'protection', label: msg('Discharge overcurrent protection, level 2') },
  { byte: 'current1', bit: 6, id: 'short_circuit', severity: 'protection' },
  { byte: 'current2', bit: 0, id: 'seplos.short_circuit_lockout', severity: 'protection', label: msg('Output short circuit lockout') },
  { byte: 'current2', bit: 1, id: 'seplos.reverse_polarity', severity: 'protection', label: msg('Reverse polarity protection') },
  { byte: 'current2', bit: 2, id: 'seplos.charge_ocp2_lockout', severity: 'protection', label: msg('Charge level 2 lockout') },
  { byte: 'current2', bit: 3, id: 'seplos.discharge_ocp2_lockout', severity: 'protection', label: msg('Discharge level 2 lockout') },
  { byte: 'capacity', bit: 2, id: 'soc_low', severity: 'warning' },
  { byte: 'capacity', bit: 3, id: 'soc_low', severity: 'protection' },
  { byte: 'capacity', bit: 4, id: 'cell_voltage_difference', severity: 'warning' },
  { byte: 'capacity', bit: 6, id: 'seplos.gyro_lockout', severity: 'protection', label: msg('Gyro lockout') },
  { byte: 'balance', bit: 3, id: 'seplos.balance_overtemp', severity: 'info', label: msg('Balancing stopped by temperature') },
  { byte: 'balance', bit: 4, id: 'seplos.cell_failure', severity: 'warning', label: msg('Cell failure') },
  { byte: 'hardware', bit: 0, id: 'temperature_sensor_fault', severity: 'fault' },
  { byte: 'hardware', bit: 1, id: 'afe_fault', severity: 'fault' },
  { byte: 'hardware', bit: 2, id: 'charge_mos_fault', severity: 'fault' },
  { byte: 'hardware', bit: 3, id: 'discharge_mos_fault', severity: 'fault' },
  { byte: 'hardware', bit: 4, id: 'seplos.cell_failure', severity: 'fault', label: msg('Cell failure') },
  { byte: 'hardware', bit: 5, id: 'cell_wire_open', severity: 'fault' },
  { byte: 'hardware', bit: 6, id: 'seplos.key_switch_fault', severity: 'fault', label: msg('Key switch failure') },
  { byte: 'hardware', bit: 7, id: 'seplos.aerosol_alarm', severity: 'fault', label: msg('Aerosol (fire suppression) alarm') },
];

/** @param {number[]} idx */
const listText = (idx) => idx.map((i) => i + 1).join(', ');

/**
 * Alarms of the state and event bytes, with the PIC per cell and per sensor flags naming the
 * affected cells (spec 9.9).
 * @param {EventState} state
 * @param {{ cellHigh?: number[], cellLow?: number[], tempHigh?: number[], tempLow?: number[] }} [named]
 * @param {string} [prefix] source prefix, 'PIC' or 'EIC'
 */
export function v3Alarms(state, named = {}, prefix = 'PIC') {
  const out = [];
  for (const def of V3_EVENT_BITS) {
    if (!(((state[def.byte] ?? 0) >> def.bit) & 1)) continue;
    let source = `${prefix} ${def.byte} bit ${def.bit}`;
    const which = def.cells ? (named[def.cells] ?? []) : [];
    if (which.length) source += def.cells?.startsWith('cell') ? `, cells ${listText(which)}` : `, sensors ${listText(which)}`;
    out.push(alarm(def.id, { severity: def.severity, label: def.label, source }));
  }
  return mergeAlarms(out);
}

/** System state bits (table 9.9 4.1), same meaning as V2. */
export const V3_SYSTEM_BITS = [
  { bit: 0, name: msg('Discharging') },
  { bit: 1, name: msg('Charging') },
  { bit: 2, name: msg('Float charge') },
  { bit: 3, name: msg('Fully charged') },
  { bit: 4, name: msg('Standby') },
  { bit: 5, name: msg('Shut down') },
];

/** Inverter protocol numbers of firmware V1.43l (spec 9.8); the PCT protocol name is preferred. */
export const INVERTER_PROTOCOLS = Object.freeze([
  'Pylon CAN',
  'Growatt CAN',
  'Goodwe LV CAN',
  'SOFAR CAN',
  'SMA CAN',
  'Victron CAN',
  'Studer CAN',
  'Ginlong / Solis CAN',
  'Voltronic 485',
  'PACK BMS Modbus',
  'SPF Modbus RS485 (Growatt)',
  'Pylon low voltage 485',
  'Pylon low voltage 485 (Deye)',
  'XZH-Modbus',
  'Modbus RTU (Hengrui)',
  'Modbus RTU (NPP)',
  'MUST CAN',
  'Modbus RTU (YNG)',
  'Pylon low voltage 485 (M5000H)',
  'TBB CAN',
  'Afore CAN',
]);

// ---------------------------------------------------------------------------------------------
// Protocol log
// ---------------------------------------------------------------------------------------------

/** @param {number} start */
function blockName(start) {
  for (const b of Object.values(BLOCK)) if (b.start === start) return b.name;
  if (start >= 0x1300 && start <= 0x1369) return 'SPA';
  if (start >= 0x1400 && start < 0x1450) return 'SFA';
  if (start >= 0x1500 && start < 0x1520) return 'SCA';
  return `0x${start.toString(16).toUpperCase()}`;
}

/**
 * Protocol log description of a V3 frame. Answers carry no start register; `start` names the
 * outstanding request.
 * @param {Uint8Array} frame
 * @param {{ direction?: 'tx'|'rx', start?: number }} [ctx]
 */
export function describeModbus(frame, ctx = {}) {
  if (!frame || frame.length < 5) return null;
  if (ctx.direction === 'tx') {
    const r = parseRequest(frame);
    if (!r) return null;
    const what = r.function === FN.WRITE_REGISTERS || r.function === FN.WRITE_COILS ? 'write' : 'read';
    return { name: `Seplos V3 ${blockName(r.start)} ${what} (address ${r.address})`, decode: () => ({ ...r, values: r.values ? hex(r.values, ' ') : undefined }) };
  }
  const p = parseResponse(frame);
  if (!p) return null;
  if (p.exception !== undefined) return { name: `Seplos V3 exception ${p.exception} (function 0x${(p.function & 0x7f).toString(16)})`, decode: () => p };
  if (p.start !== undefined) return { name: `Seplos V3 write acknowledged (${blockName(p.start)})`, decode: () => p };
  const start = ctx.start;
  return {
    name: `Seplos V3 ${start !== undefined ? blockName(start) : 'read'} answer (address ${p.address})`,
    decode: () => {
      /** @type {Record<string, any>} */
      const out = { address: p.address, function: p.function, byteCount: p.byteCount };
      const data = /** @type {Uint8Array} */ (p.data);
      try {
        if (start === BLOCK.PIA.start) Object.assign(out, parsePia(registers(data)));
        else if (start === BLOCK.PIB.start) Object.assign(out, parsePib(registers(data)));
        else if (start === BLOCK.PIC.start) Object.assign(out, parsePic(data));
        else if (start === BLOCK.EIA.start) Object.assign(out, parseEia(registers(data)));
        else if (start === BLOCK.EIB.start) Object.assign(out, parseEib(registers(data)));
        else if (start === BLOCK.EIC.start) Object.assign(out, parseEic(data));
        else if (start === BLOCK.VIA.start) Object.assign(out, parseVia(data));
        else if (start === BLOCK.PCT.start) Object.assign(out, parsePct(data));
        else if (p.function === FN.READ_INPUT) out.registers = registers(data);
        else out.bytes = hex(data, ' ');
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      }
      return out;
    },
  };
}

