import { FrameAssembler, hex, i16be, u16be } from '@ubms/transport';
import { alarm, msg } from '@ubms/bms-core';

/**
 * Seplos BMS 1.0 / 2.0 ("V2") protocols, docs/protocols/seplos.md:
 *
 * - V2 ASCII, the wired protocol (RS485 / RS232): `~ VER ADR CID1 CID2 LENGTH INFO CHKSUM CR`,
 *   every field as upper case ASCII hex (spec 3.1, 5.1, 6.1).
 * - V2 BLE, the binary protocol of the V2 Bluetooth module: `7E VER ADR 46 CID LENGTH DATA CRC 0D`
 *   with CRC-16/XMODEM (spec 3.2, 5.2, 6.2).
 *
 * Both share the 169 byte parameter block (0x47 read, 0xA1 write; spec 6.1.3, 7.1, 7.2) and the
 * alarm event bits (spec 9.2). Pure functions only: no browser APIs, no state.
 */

export const SOI = 0x7e;
export const EOI = 0x0d;
/** V2 ASCII protocol version 2.0 ([V2PDF] 3.1). */
export const ASCII_VER = 0x20;
/** VER of V2 BLE requests ([BLEPDF] tables 1 to 4); answers carry 0x14 (capture) or 0x10. */
export const BLE_VER = 0x10;
/** CID1: lithium iron phosphate battery BMS; the REQ byte of V2 BLE requests. */
export const CID1 = 0x46;

/** V2 ASCII commands (spec 5.1). 0x45, 0x49, 0x4B, 0x4D, 0x4E, 0xA0, 0xA2 are never sent. */
export const ASCII_CMD = Object.freeze({
  TELEMETRY: 0x42,
  ALARMS: 0x44,
  PARAMS: 0x47,
  TIME: 0x4d,
  VERSION: 0x4f,
  INFO: 0x51,
  WRITE_PARAMS: 0xa1,
});

/** V2 BLE commands (spec 5.2). 0x63, 0x64, 0x65 and 0xAA are never sent by the driver. */
export const BLE_CMD = Object.freeze({
  PARAMS: 0x47,
  INFO: 0x51,
  SINGLE: 0x61,
  PARALLEL: 0x62,
  CAN_PROTOCOL: 0x63,
  RS485_PROTOCOL: 0x64,
  GROUP: 0x65,
  WRITE_PARAMS: 0xa1,
  SWITCH: 0xaa,
});

/** Return codes of both V2 protocols ([V2PDF] table 5, [BLEPDF] table 4). */
export const RTN = Object.freeze({ OK: 0x00, DATA_INVALID: 0x06, FAILED: 0xe2 });

/** English names of the return codes, for the protocol log. */
export const RTN_NAMES = Object.freeze({
  0x00: 'normal',
  0x01: 'VER error',
  0x02: 'checksum error',
  0x03: 'length checksum or data length error',
  0x04: 'command invalid',
  0x05: 'command format error',
  0x06: 'invalid data',
  0x07: 'no data',
  0xe1: 'CID1 / REQ invalid',
  0xe2: 'command execution failed',
  0xe3: 'device fault',
  0xe4: 'invalid permissions',
});

const RTN_CODES = new Set(Object.keys(RTN_NAMES).map(Number));

/** Kelvin offset of the 0.1 K temperatures ([V2PDF] table 9, [BLEPDF] table 5: 2731). */
export const KELVIN = 2731;

/** @param {number} raw 0.1 K */
export const tempFromRaw = (raw) => Math.round(raw - KELVIN) / 10;
/** @param {number} c degrees C */
export const tempToRaw = (c) => Math.round(c * 10) + KELVIN;

/** @param {number} v @param {number} d */
const rnd = (v, d) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** Latin-1 text of a byte range, untrimmed (padding kept, NUL removed). @param {ArrayLike<number>} b @param {number} o @param {number} n */
export function rawText(b, o, n) {
  let s = '';
  for (let i = o; i < o + n && i < b.length; i++) if (b[i] !== 0) s += String.fromCharCode(b[i]);
  return s;
}

/** @param {ArrayLike<number>} b @param {number} o @param {number} n */
export function isPrintable(b, o, n) {
  for (let i = o; i < o + n; i++) {
    if (i >= b.length) return false;
    const c = b[i];
    if (c !== 0 && (c < 0x20 || c > 0x7e)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// V2 ASCII framing (spec 3.1)
// ---------------------------------------------------------------------------------------------

const HEX_DIGITS = '0123456789ABCDEF';

/** @param {number} v */
const hex2 = (v) => HEX_DIGITS[(v >> 4) & 15] + HEX_DIGITS[v & 15];

/** @param {string} s */
const textBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** LCHKSUM of a LENID: the three nibbles summed, mod 16, inverted plus one ([V2PDF] 3.2). @param {number} lenid */
export function lchksum(lenid) {
  return -((lenid & 15) + ((lenid >> 4) & 15) + ((lenid >> 8) & 15)) & 15;
}

/**
 * CHKSUM: sum of the ASCII codes, mod 65536, inverted plus one ([V2PDF] 3.3).
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function asciiChecksum(bytes, start = 0, end = bytes.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += bytes[i];
  return (~s + 1) & 0xffff;
}

/**
 * Build a V2 ASCII frame.
 * @param {{ ver?: number, adr: number, cid1?: number, cid2: number, info?: ArrayLike<number> }} f
 */
export function encodeAscii({ ver = ASCII_VER, adr, cid1 = CID1, cid2, info = [] }) {
  const lenid = info.length * 2;
  if (lenid > 0xfff) throw new RangeError('INFO too long');
  const length = (lchksum(lenid) << 12) | lenid;
  let body = hex2(ver) + hex2(adr) + hex2(cid1) + hex2(cid2) + hex2(length >> 8) + hex2(length & 0xff);
  for (let i = 0; i < info.length; i++) body += hex2(info[i]);
  const chk = asciiChecksum(textBytes(body));
  return textBytes(`~${body}${hex2(chk >> 8)}${hex2(chk & 0xff)}\r`);
}

/**
 * @typedef {Object} AsciiFrame
 * @property {number} ver
 * @property {number} adr
 * @property {number} cid1
 * @property {number} cid2 command in a request, RTN in an answer
 * @property {number} length raw LENGTH field
 * @property {number} lenid
 * @property {Uint8Array} info decoded INFO bytes
 * @property {number} chksum
 * @property {string} text the frame without CR
 */

/** @param {number} c */
const hexValue = (c) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1);

/** @param {Uint8Array} f @param {number} o */
function byteAt(f, o) {
  const hi = hexValue(f[o]);
  const lo = hexValue(f[o + 1]);
  return hi < 0 || lo < 0 ? -1 : (hi << 4) | lo;
}

/**
 * Parse and check a complete V2 ASCII frame (`~` to CR): hex digits, CHKSUM, LCHKSUM and LENID
 * against the INFO length (spec 3.1). Returns null when anything does not check.
 * @param {Uint8Array} frame
 * @returns {AsciiFrame | null}
 */
export function parseAscii(frame) {
  if (!frame || frame.length < 18 || frame[0] !== SOI || frame[frame.length - 1] !== EOI) return null;
  const n = frame.length - 2; // characters between SOI and EOI
  if (n % 2 !== 0) return null;
  /** @type {number[]} */
  const bytes = [];
  for (let o = 1; o < frame.length - 1; o += 2) {
    const v = byteAt(frame, o);
    if (v < 0) return null;
    bytes.push(v);
  }
  const chksum = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (asciiChecksum(frame, 1, frame.length - 5) !== chksum) return null;
  const length = (bytes[4] << 8) | bytes[5];
  const lenid = length & 0xfff;
  if (lchksum(lenid) !== length >> 12) return null;
  if (lenid !== frame.length - 18) return null;
  return {
    ver: bytes[0],
    adr: bytes[1],
    cid1: bytes[2],
    cid2: bytes[3],
    length,
    lenid,
    info: Uint8Array.from(bytes.slice(6, bytes.length - 2)),
    chksum,
    text: String.fromCharCode(...frame.subarray(0, frame.length - 1)),
  };
}

/** Longest V2 ASCII frame accepted: 0x47 / 0xA1 carry 338 INFO characters (356 in all). */
const MAX_ASCII_FRAME = 600;

/**
 * Assembler for V2 ASCII frames: from `~` to CR; a new `~` before the CR restarts the frame
 * ([SY] `parse_seplos_modbus_byte_`), frames that do not check are dropped (spec 3.1).
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void }} handlers
 */
export function createAsciiAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [[SOI]],
    length: (buf) => {
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] === EOI) return i + 1;
        if (buf[i] === SOI || i >= MAX_ASCII_FRAME) return -1;
      }
      return 0;
    },
    validate: (f) => parseAscii(f) !== null,
    onFrame,
    onDiscard,
    maxLength: MAX_ASCII_FRAME,
    staleMs: 2000,
  });
}

/**
 * Request of a read command. 0x42, 0x44 and 0x47 carry one INFO byte; for 0x42 and 0x44 it is the
 * command group, which is the pack address on RS485 ([V2PDF] 4.1.1, 4.2.1, spec 4.1 step 6); 0x4F
 * and 0x51 carry none. 0x47 carries 0x00 as the vendor tool sends it, captured only at address 0
 * ([IC] record 352): whether a pack at another DIP address accepts group 0 for 0x47 (and the 0xA1
 * block with group byte 0) is **unverified**.
 * @param {number} cid2
 * @param {number} adr
 * @param {number} [group] INFO byte (defaults to the address for 0x42 and 0x44, 0 for 0x47)
 */
export function encodeAsciiRequest(cid2, adr, group) {
  if (cid2 === ASCII_CMD.TELEMETRY || cid2 === ASCII_CMD.ALARMS) return encodeAscii({ adr, cid2, info: [group ?? adr] });
  if (cid2 === ASCII_CMD.PARAMS) return encodeAscii({ adr, cid2, info: [group ?? 0] });
  return encodeAscii({ adr, cid2 });
}

/** True for a frame whose CID2 position holds a return code (an answer, not an echoed request). @param {AsciiFrame} f */
export const isAsciiAnswer = (f) => RTN_CODES.has(f.cid2);

// ---------------------------------------------------------------------------------------------
// V2 ASCII answers (spec 6.1)
// ---------------------------------------------------------------------------------------------

/**
 * Read the custom field block shared by 0x42 (P = 10), BLE 0x61 (K = 6) and, with another scale,
 * BLE 0x62 (K = 7).
 * @param {Uint8Array} b
 * @param {number} o offset of the first custom field
 * @param {number} count number of u16 fields announced
 */
function customFields(b, o, count) {
  /** @type {number[]} */
  const out = [];
  for (let k = 0; k < count && o + 2 * k + 2 <= b.length; k++) out.push(u16be(b, o + 2 * k));
  return out;
}

/** @param {Uint8Array} b @param {number} need @param {string} what */
function need(b, need, what) {
  if (b.length < need) throw new Error(`${what}: ${b.length} bytes, at least ${need} expected`);
}

/**
 * 0x42 telemetry INFO (spec 6.1.1).
 * @param {Uint8Array} info
 */
export function parseTelemetry(info) {
  need(info, 3, 'Telemetry');
  const cellCount = info[2];
  let o = 3;
  need(info, o + 2 * cellCount + 1, 'Telemetry');
  const cellVoltages = [];
  for (let i = 0; i < cellCount; i++, o += 2) cellVoltages.push(u16be(info, o) / 1000);
  const tempCount = info[o++];
  need(info, o + 2 * tempCount + 7, 'Telemetry');
  const temperatures = [];
  for (let j = 0; j < tempCount; j++, o += 2) temperatures.push(tempFromRaw(u16be(info, o)));
  const current = i16be(info, o) / 100;
  const voltage = u16be(info, o + 2) / 100;
  const remainingAh = u16be(info, o + 4) / 100;
  const customCount = info[o + 6];
  const c = customFields(info, o + 7, customCount);
  /** @type {Record<string, any>} */
  const out = { dataFlag: info[0], commandGroup: info[1], cellCount, cellVoltages, tempCount, temperatures, current, voltage, remainingAh, customCount };
  if (c.length > 0) out.capacityAh = c[0] / 100;
  if (c.length > 1) out.soc = c[1] / 10;
  if (c.length > 2) out.ratedAh = c[2] / 100;
  if (c.length > 3) out.cycles = c[3];
  if (c.length > 4) out.soh = c[4] / 10;
  if (c.length > 5) out.portVoltage = c[5] / 100;
  if (c.length > 6) out.reserved = c.slice(6);
  out.layoutLength = o + 7 + 2 * customCount;
  return out;
}

/** Names of the bit alarm bytes of 0x44, in order (spec 6.1.2). */
const ALARM_BYTE_NAMES = ['event1', 'event2', 'event3', 'event4', 'event5', 'event6', 'switchState', 'balance1', 'balance2', 'systemState', 'disconnect1', 'disconnect2', 'event7', 'event8'];

/**
 * 0x44 telecommand INFO: byte alarms, bit alarm events, switch, balancing and system state
 * (spec 6.1.2).
 * @param {Uint8Array} info
 */
export function parseAlarmInfo(info) {
  need(info, 3, 'Alarms');
  const cellCount = info[2];
  need(info, 3 + cellCount + 1, 'Alarms');
  const cellAlarms = [...info.subarray(3, 3 + cellCount)];
  const tempCount = info[3 + cellCount];
  const t = 4 + cellCount;
  need(info, t + tempCount + 3, 'Alarms');
  const tempAlarms = [...info.subarray(t, t + tempCount)];
  const b = t + tempCount + 2;
  const bitAlarmCount = info[b];
  need(info, b + 1 + bitAlarmCount, 'Alarms');
  /** @type {Record<string, any>} */
  const out = {
    dataFlag: info[0],
    commandGroup: info[1],
    cellCount,
    cellAlarms,
    tempCount,
    tempAlarms,
    currentAlarm: info[t + tempCount],
    voltageAlarm: info[t + tempCount + 1],
    bitAlarmCount,
  };
  const bits = info.subarray(b + 1, b + 1 + bitAlarmCount);
  ALARM_BYTE_NAMES.forEach((name, k) => {
    if (k < bits.length) out[name] = bits[k];
  });
  if (bits.length > ALARM_BYTE_NAMES.length) out.reservedBytes = [...bits.subarray(ALARM_BYTE_NAMES.length)];
  out.events = [1, 2, 3, 4, 5, 6, 7, 8].map((e) => out[`event${e}`] ?? 0);
  out.balance = [out.balance1 ?? 0, out.balance2 ?? 0];
  out.disconnect = [out.disconnect1 ?? 0, out.disconnect2 ?? 0];
  return out;
}

/**
 * 0x51 device information INFO, V2 ASCII order: device name, software version, manufacturer
 * (spec 6.1.4). Strings are returned as sent (padding kept).
 * @param {Uint8Array} info
 */
export function parseAsciiInfo(info) {
  need(info, 32, 'Device information');
  return { model: rawText(info, 0, 10), softwareVersion: `${info[10]}.${info[11]}`, manufacturer: rawText(info, 12, 20) };
}

/** The 0x51 answer looks like device information: 32 bytes, printable name and manufacturer (spec 11.2). @param {Uint8Array} info */
export const plausibleAsciiInfo = (info) => info.length === 32 && isPrintable(info, 0, 10) && isPrintable(info, 12, 20) && info[0] !== 0;

// ---------------------------------------------------------------------------------------------
// Parameter block (spec 6.1.3, 7.1, 7.2)
// ---------------------------------------------------------------------------------------------

export const PARAM_BLOCK_SIZE = 169;
export const PARAM_INT_COUNT = 60;
export const PARAM_BYTE_COUNT = 27;
export const PARAM_SWITCH_COUNT = 8;

/**
 * @typedef {'mv'|'cv'|'temp'|'amp'|'ms'|'ah'} IntKind
 * mv 0.001 V, cv 0.01 V, temp 0.1 K, amp s16 0.01 A, ms 1 ms, ah 0.01 Ah
 */

/** Two byte parameters i = 0..59 at INFO offset 2 + 2i ([BLEPDF] table 21, [BSX] `int_para`). @type {Array<[string, IntKind]>} */
export const INT_PARAMS = [
  ['cellHighAlarm', 'mv'],
  ['cellHighAlarmRecovery', 'mv'],
  ['cellLowAlarm', 'mv'],
  ['cellLowAlarmRecovery', 'mv'],
  ['cellOvp', 'mv'],
  ['cellOvpRecovery', 'mv'],
  ['cellUvp', 'mv'],
  ['cellUvpRecovery', 'mv'],
  ['balanceStartVoltage', 'mv'],
  ['lowVoltageChargeForbid', 'mv'],
  ['packHighAlarm', 'cv'],
  ['packHighAlarmRecovery', 'cv'],
  ['packLowAlarm', 'cv'],
  ['packLowAlarmRecovery', 'cv'],
  ['packOvp', 'cv'],
  ['packOvpRecovery', 'cv'],
  ['packUvp', 'cv'],
  ['packUvpRecovery', 'cv'],
  ['chargeOvp', 'cv'],
  ['chargeOvpRecovery', 'cv'],
  ['chargeHighTempAlarm', 'temp'],
  ['chargeHighTempAlarmRecovery', 'temp'],
  ['chargeLowTempAlarm', 'temp'],
  ['chargeLowTempAlarmRecovery', 'temp'],
  ['chargeOtp', 'temp'],
  ['chargeOtpRecovery', 'temp'],
  ['chargeUtp', 'temp'],
  ['chargeUtpRecovery', 'temp'],
  ['dischargeHighTempAlarm', 'temp'],
  ['dischargeHighTempAlarmRecovery', 'temp'],
  ['dischargeLowTempAlarm', 'temp'],
  ['dischargeLowTempAlarmRecovery', 'temp'],
  ['dischargeOtp', 'temp'],
  ['dischargeOtpRecovery', 'temp'],
  ['dischargeUtp', 'temp'],
  ['dischargeUtpRecovery', 'temp'],
  ['heatingStart', 'temp'],
  ['heatingStop', 'temp'],
  ['ambientHighAlarm', 'temp'],
  ['ambientHighAlarmRecovery', 'temp'],
  ['ambientLowAlarm', 'temp'],
  ['ambientLowAlarmRecovery', 'temp'],
  ['ambientOtp', 'temp'],
  ['ambientOtpRecovery', 'temp'],
  ['ambientUtp', 'temp'],
  ['ambientUtpRecovery', 'temp'],
  ['powerHighAlarm', 'temp'],
  ['powerHighAlarmRecovery', 'temp'],
  ['powerOtp', 'temp'],
  ['powerOtpRecovery', 'temp'],
  ['chargeOcAlarm', 'amp'],
  ['chargeOcAlarmRecovery', 'amp'],
  ['dischargeOcAlarm', 'amp'],
  ['dischargeOcAlarmRecovery', 'amp'],
  ['chargeOcp', 'amp'],
  ['dischargeOcp', 'amp'],
  ['transientOcp', 'amp'],
  ['softStartDelayMs', 'ms'],
  ['ratedCapacityAh', 'ah'],
  ['remainingCapacityAh', 'ah'],
];

/** One byte parameters j = 0..26 at INFO offset 123 + j, with their scale ([BLEPDF], [BSX] units). @type {Array<[string, number]>} */
export const BYTE_PARAMS = [
  ['cellFailureDiff', 0.01],
  ['cellFailureDiffRecovery', 0.01],
  ['balanceStartDiff', 0.001],
  ['balanceStopDiff', 0.001],
  ['staticBalanceHours', 1],
  ['cellCount', 1],
  ['chargeOcDelayS', 1],
  ['dischargeOcDelayS', 1],
  ['transientOcDelayMs', 1],
  ['ocRecoveryDelayS', 1],
  ['ocRecoveryTimes', 1],
  ['chargeCurrentLimitDelayMin', 1],
  ['chargeActivationDelayMin', 1],
  ['chargeActivationIntervalH', 1],
  ['chargeActivationTimes', 1],
  ['workRecordIntervalMin', 1],
  ['standbyRecordIntervalMin', 1],
  ['standbyShutdownDelayH', 1],
  ['socAlarmPercent', 1],
  ['socProtectPercent', 1],
  ['intermittentChargeSocPercent', 1],
  ['cycleCapacityPercent', 1],
  ['connectionFaultMilliohm', 0.1],
  ['comp1Cell', 1],
  ['comp1Milliohm', 0.1],
  ['comp2Cell', 1],
  ['comp2Milliohm', 0.1],
];

/** @type {Record<IntKind, { scale: number, decimals: number, signed: boolean }>} */
const INT_KIND = {
  mv: { scale: 0.001, decimals: 3, signed: false },
  cv: { scale: 0.01, decimals: 2, signed: false },
  temp: { scale: 0.1, decimals: 1, signed: false },
  amp: { scale: 0.01, decimals: 2, signed: true },
  ms: { scale: 1, decimals: 0, signed: false },
  ah: { scale: 0.01, decimals: 2, signed: false },
};

/** @type {Map<string, { offset: number, size: 1|2, kind?: IntKind, scale: number, decimals: number, signed: boolean }>} */
const PARAM_LAYOUT = new Map();
INT_PARAMS.forEach(([key, kind], i) => PARAM_LAYOUT.set(key, { offset: 2 + 2 * i, size: 2, kind, ...INT_KIND[kind] }));
BYTE_PARAMS.forEach(([key, scale], j) =>
  PARAM_LAYOUT.set(key, { offset: 123 + j, size: 1, scale, decimals: scale === 1 ? 0 : -Math.round(Math.log10(scale)), signed: false }),
);

/** Offset of the function switch bytes and of the model in a standard block (60 / 27 / 8 counts). */
export const SWITCH_OFFSET = 151;
export const MODEL_OFFSET = 159;

/**
 * @typedef {Object} ParamBlock
 * @property {number} group
 * @property {number} intCount
 * @property {number} byteCount
 * @property {number} switchCount
 * @property {Record<string, number>} params engineering units (V, A, degrees C, Ah, s, ms, min, h, %, mOhm)
 * @property {number[]} functionSwitches
 * @property {string} model as sent (padding kept)
 * @property {boolean} standard the counts are 60 / 27 / 8, so the table offsets hold and a write is possible
 * @property {Uint8Array} raw copy of the block
 */

/**
 * Decode the parameter block of 0x47 (INFO on V2 ASCII, DATA on V2 BLE), spec 6.1.3 and 7.1.
 * @param {Uint8Array} data
 * @returns {ParamBlock}
 */
export function parseParamBlock(data) {
  need(data, 2, 'Parameter block');
  const intCount = data[1];
  const nOff = 2 + 2 * intCount;
  need(data, nOff + 1, 'Parameter block');
  const byteCount = data[nOff];
  const pOff = nOff + 1 + byteCount;
  need(data, pOff + 1, 'Parameter block');
  const switchCount = data[pOff];
  need(data, pOff + 1 + switchCount, 'Parameter block');
  /** @type {Record<string, number>} */
  const params = {};
  INT_PARAMS.forEach(([key, kind], i) => {
    if (i >= intCount) return;
    const k = INT_KIND[kind];
    const raw = k.signed ? i16be(data, 2 + 2 * i) : u16be(data, 2 + 2 * i);
    params[key] = kind === 'temp' ? tempFromRaw(raw) : rnd(raw * k.scale, k.decimals);
  });
  BYTE_PARAMS.forEach(([key, scale], j) => {
    if (j >= byteCount) return;
    params[key] = rnd(data[nOff + 1 + j] * scale, 3);
  });
  const functionSwitches = [...data.subarray(pOff + 1, pOff + 1 + switchCount)];
  const mOff = pOff + 1 + switchCount;
  return {
    group: data[0],
    intCount,
    byteCount,
    switchCount,
    params,
    functionSwitches,
    model: rawText(data, mOff, Math.min(10, data.length - mOff)),
    standard: intCount === PARAM_INT_COUNT && byteCount === PARAM_BYTE_COUNT && switchCount === PARAM_SWITCH_COUNT && data.length === PARAM_BLOCK_SIZE,
    raw: Uint8Array.from(data),
  };
}

/**
 * Raw value of one parameter for the block (spec 7.1 encoding rules): temperatures as 0.1 K with
 * 2731, discharge currents negative as read (the caller passes the signed value).
 * @param {string} key
 * @param {number} value engineering units, signed as stored
 */
export function paramRaw(key, value) {
  const p = PARAM_LAYOUT.get(key);
  if (!p) throw new Error(`Unknown parameter ${key}`);
  const raw = p.kind === 'temp' ? tempToRaw(value) : Math.round(value / p.scale);
  const [lo, hi] = p.size === 1 ? [0, 255] : p.signed ? [-32768, 32767] : [0, 65535];
  if (!Number.isFinite(raw) || raw < lo || raw > hi) throw new RangeError(`${key}: ${value} is out of range`);
  return raw;
}

/**
 * Copy of a standard parameter block with one parameter changed (spec 7.5: everything else as
 * read, counts and model included).
 * @param {Uint8Array} block
 * @param {string} key
 * @param {number} value engineering units, signed as stored
 */
export function setBlockParam(block, key, value) {
  const p = PARAM_LAYOUT.get(key);
  if (!p) throw new Error(`Unknown parameter ${key}`);
  const out = Uint8Array.from(block);
  const raw = paramRaw(key, value);
  if (p.size === 1) out[p.offset] = raw;
  else {
    out[p.offset] = (raw >> 8) & 0xff;
    out[p.offset + 1] = raw & 0xff;
  }
  return out;
}

/**
 * Copy of a standard parameter block with one function switch bit changed (spec 7.2).
 * @param {Uint8Array} block
 * @param {number} byte 1..8
 * @param {number} bit 0..7
 * @param {boolean} on
 */
export function setBlockSwitch(block, byte, bit, on) {
  if (byte < 1 || byte > PARAM_SWITCH_COUNT || bit < 0 || bit > 7) throw new RangeError('Invalid function switch');
  const out = Uint8Array.from(block);
  const o = SWITCH_OFFSET + byte - 1;
  out[o] = on ? out[o] | (1 << bit) : out[o] & ~(1 << bit);
  return out;
}

// ---------------------------------------------------------------------------------------------
// V2 BLE framing (spec 3.2)
// ---------------------------------------------------------------------------------------------

/**
 * CRC-16/XMODEM: polynomial 0x1021, initial value 0, no reflection, no final XOR ([BLEPDF] 3.2).
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function crcXmodem(bytes, start = 0, end = bytes.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * Build a V2 BLE request: 7E VER ADR 46 CID LENGTH DATA CRC 0D, the CRC over VER .. DATA, high
 * byte first.
 * @param {{ ver?: number, adr?: number, cid: number, data?: ArrayLike<number>, req?: number }} f
 */
export function encodeBle({ ver = BLE_VER, adr = 0, cid, data = [], req = CID1 }) {
  const n = data.length;
  const out = new Uint8Array(10 + n);
  out.set([SOI, ver, adr, req, cid, (n >> 8) & 0xff, n & 0xff], 0);
  out.set(data, 7);
  const crc = crcXmodem(out, 1, 7 + n);
  out[7 + n] = crc >> 8;
  out[8 + n] = crc & 0xff;
  out[9 + n] = EOI;
  return out;
}

/**
 * Build a V2 BLE answer (simulator and tests): byte 3 is the CID, byte 4 the RTN.
 * @param {{ ver?: number, adr?: number, cid: number, rtn?: number, data?: ArrayLike<number> }} f
 */
export function encodeBleAnswer({ ver = 0x14, adr = 0, cid, rtn = RTN.OK, data = [] }) {
  return encodeBle({ ver, adr, req: cid, cid: rtn, data });
}

/** Largest DATA length accepted; the biggest known answer is the 169 byte parameter block. */
const MAX_BLE_DATA = 400;

/**
 * @typedef {Object} BleFrame
 * @property {number} ver
 * @property {number} adr
 * @property {number} b3 0x46 in requests, the CID in answers
 * @property {number} b4 the CID in requests, RTN in answers
 * @property {number} length
 * @property {Uint8Array} data
 * @property {number} crc as transmitted
 * @property {boolean} crcValid
 * @property {boolean} eoiValid
 */

/**
 * Split a V2 BLE frame into its fields (no validity requirement; see `crcValid`, `eoiValid`).
 * @param {Uint8Array} f
 * @returns {BleFrame | null}
 */
export function parseBleFrame(f) {
  if (!f || f.length < 10 || f[0] !== SOI) return null;
  const length = u16be(f, 5);
  const end = 7 + length;
  if (f.length < end + 3) {
    return { ver: f[1], adr: f[2], b3: f[3], b4: f[4], length, data: f.slice(7), crc: -1, crcValid: false, eoiValid: false };
  }
  const crc = u16be(f, end);
  return {
    ver: f[1],
    adr: f[2],
    b3: f[3],
    b4: f[4],
    length,
    data: f.slice(7, end),
    crc,
    crcValid: crcXmodem(f, 1, end) === crc,
    eoiValid: f[end + 2] === EOI,
  };
}

/** Complete, valid V2 BLE frame: length, EOI and CRC. @param {Uint8Array} f */
export function validBleFrame(f) {
  const p = parseBleFrame(f);
  return !!p && f.length === p.length + 10 && p.crcValid && p.eoiValid;
}

/**
 * Assembler for V2 BLE answers split over several notifications (spec 3.2): start at 0x7E, wait
 * for 10 + LENGTH bytes, check EOI and CRC, resynchronise at the next 0x7E on failure.
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void }} handlers
 */
export function createBleAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [[SOI]],
    length: (buf) => {
      if (buf.length < 7) return 0;
      const n = u16be(buf, 5);
      return n > MAX_BLE_DATA ? -1 : n + 10;
    },
    validate: validBleFrame,
    onFrame,
    onDiscard,
    maxLength: MAX_BLE_DATA + 10,
    staleMs: 2000,
  });
}

/** @param {number} cid @param {number} [adr] */
export const encodeBleRead = (cid, adr = 0) =>
  encodeBle({ adr, cid, data: cid === BLE_CMD.SINGLE || cid === BLE_CMD.PARAMS ? [0x00] : [] });

// ---------------------------------------------------------------------------------------------
// V2 BLE answers (spec 6.2)
// ---------------------------------------------------------------------------------------------

/**
 * 0x51 manufacturer information, V2 BLE order (spec 6.2.1).
 * @param {Uint8Array} d
 */
export function parseBleInfo(d) {
  need(d, 36, 'Manufacturer information');
  return {
    manufacturer: rawText(d, 0, 20),
    model: rawText(d, 20, 10),
    softwareVersion: `${d[30]}.${d[31]}`,
    canProtocol: d[32],
    rs485Protocol: d[33],
    batteryType: d[34],
    slaves: d[35],
    extraBytes: d.length - 36,
  };
}

/**
 * 0x61 single machine data (spec 6.2.2): telemetry and alarms in one answer.
 * @param {Uint8Array} d
 */
export function parseBleSingle(d) {
  need(d, 3, 'Single machine data');
  const cellCount = d[2];
  let o = 3;
  need(d, o + 2 * cellCount + 1, 'Single machine data');
  const cellVoltages = [];
  for (let i = 0; i < cellCount; i++, o += 2) cellVoltages.push(u16be(d, o) / 1000);
  const tempCount = d[o++];
  need(d, o + 2 * tempCount + 7, 'Single machine data');
  const temperatures = [];
  for (let j = 0; j < tempCount; j++, o += 2) temperatures.push(tempFromRaw(u16be(d, o)));
  /** @type {Record<string, any>} */
  const out = {
    dataFlag: d[0],
    address: d[1],
    cellCount,
    cellVoltages,
    tempCount,
    temperatures,
    current: i16be(d, o) / 100,
    voltage: u16be(d, o + 2) / 100,
    remainingAh: u16be(d, o + 4) / 100,
    customCount: d[o + 6],
  };
  o += 7;
  need(d, o + 2 * out.customCount, 'Single machine data');
  const c = customFields(d, o, out.customCount);
  o += 2 * out.customCount;
  if (c.length > 0) out.capacityAh = c[0] / 100;
  if (c.length > 1) out.soc = c[1] / 10;
  if (c.length > 2) out.ratedAh = c[2] / 100;
  if (c.length > 3) out.cycles = c[3];
  if (c.length > 4) out.soh = c[4] / 10;
  if (c.length > 5) out.portVoltage = c[5] / 100;
  need(d, o + cellCount + tempCount + 5, 'Single machine data');
  out.cellAlarms = [...d.subarray(o, o + cellCount)];
  o += cellCount;
  out.tempAlarms = [...d.subarray(o, o + tempCount)];
  o += tempCount;
  out.currentAlarm = d[o++];
  out.voltageAlarm = d[o++];
  out.systemState = d[o++];
  out.switchState = d[o++];
  out.eventCount = d[o++];
  need(d, o + out.eventCount, 'Single machine data');
  out.events = [...d.subarray(o, o + out.eventCount)];
  o += out.eventCount;
  const x = Math.ceil(cellCount / 8);
  out.balance = [...d.subarray(o, Math.min(d.length, o + x))];
  o = Math.min(d.length, o + x);
  out.disconnect = [...d.subarray(o, Math.min(d.length, o + x))];
  o = Math.min(d.length, o + x);
  out.trailing = d.length - o;
  out.balancingCells = cellsFromBits(out.balance, cellCount).map((i) => i + 1);
  return out;
}

/**
 * 0x62 parallel data, the bank summary of a master pack (spec 6.2.3): current in 0.1 A and
 * capacities in 0.1 Ah.
 * @param {Uint8Array} d
 */
export function parseBleParallel(d) {
  need(d, 23, 'Parallel data');
  /** @type {Record<string, any>} */
  const out = {
    dataFlag: d[0],
    address: d[1],
    cellCount: d[2],
    maxCellVoltage: u16be(d, 3) / 1000,
    minCellVoltage: u16be(d, 5) / 1000,
    tempCount: d[7],
    maxCellTemp: tempFromRaw(u16be(d, 8)),
    minCellTemp: tempFromRaw(u16be(d, 10)),
    ambientTemp: tempFromRaw(u16be(d, 12)),
    powerTemp: tempFromRaw(u16be(d, 14)),
    current: i16be(d, 16) / 10,
    voltage: u16be(d, 18) / 100,
    remainingAh: u16be(d, 20) / 10,
    customCount: d[22],
  };
  let o = 23;
  need(d, o + 2 * out.customCount, 'Parallel data');
  const c = customFields(d, o, out.customCount);
  if (c.length > 0) out.capacityAh = c[0] / 10;
  if (c.length > 1) out.soc = c[1] / 10;
  if (c.length > 2) out.ratedAh = c[2] / 10;
  if (c.length > 3) out.cycles = c[3];
  if (c.length > 4) out.soh = c[4] / 10;
  if (c.length > 5) out.portVoltage = c[5] / 100;
  if (c.length > 6) out.parallelStatus = [d[o + 12], d[o + 13]];
  o += 2 * out.customCount;
  need(d, o + 3, 'Parallel data');
  out.systemState = d[o++];
  out.switchState = d[o++];
  out.eventCount = d[o++];
  need(d, o + out.eventCount, 'Parallel data');
  out.events = [...d.subarray(o, o + out.eventCount)];
  o += out.eventCount;
  out.trailing = d.length - o;
  return out;
}

/** The 0x61 answer has the single machine layout, not the 169 byte parameter block (spec 12). @param {Uint8Array} d */
export function isParamBlockShape(d) {
  return d.length === PARAM_BLOCK_SIZE && d[1] === PARAM_INT_COUNT && d[2 + 2 * PARAM_INT_COUNT] === PARAM_BYTE_COUNT;
}

/**
 * A parameter block of any layout (spec 6.1.3): the counts M, N and P in the data add up to its
 * length, 2 + 2M + 1 + N + 1 + P + 10 model bytes. Accepts blocks with other counts than
 * 60 / 27 / 8, which the settings then show read only (spec 7.7). In a 0x61 answer the bytes read
 * as N and P are cell voltage bytes, so it matches only by coincidence.
 * @param {Uint8Array} d
 */
export function isParamBlockLayout(d) {
  if (d.length < 2) return false;
  const nOff = 2 + 2 * d[1];
  if (d[1] < 1 || d.length <= nOff) return false;
  const pOff = nOff + 1 + d[nOff];
  if (d.length <= pOff) return false;
  return d.length === pOff + 1 + d[pOff] + 10;
}

// ---------------------------------------------------------------------------------------------
// Bits (spec 9)
// ---------------------------------------------------------------------------------------------

/**
 * Zero based cell indexes whose bit is set (bit 0 of the first byte = cell 1).
 * @param {ArrayLike<number>} bytes
 * @param {number} cellCount
 */
export function cellsFromBits(bytes, cellCount) {
  const out = [];
  for (let i = 0; i < cellCount; i++) if (((bytes[i >> 3] ?? 0) >> (i & 7)) & 1) out.push(i);
  return out;
}

/**
 * @typedef {Object} EventBit
 * @property {number} event 1..8
 * @property {number} bit
 * @property {string} name English name of the condition (also the label of its function switch)
 * @property {string} id alarm id
 * @property {'info'|'warning'|'protection'|'fault'} severity
 * @property {string} [label] English label when the alarm id needs one
 * @property {'cellHigh'|'cellLow'|'tempHigh'|'tempLow'} [cells] byte alarm codes that name the affected cells or sensors
 */

/**
 * V2 alarm event bits (spec 9.2), shared by 0x44 events 1..8 and BLE 0x61 / 0x62 events 1..8.
 * Bits not listed (event 6 bit 7, event 7 bits 0..3, 6, 7, event 8 bits 6, 7) are internal.
 * @type {EventBit[]}
 */
export const EVENT_BITS = [
  { event: 1, bit: 0, name: msg('Voltage sensing failure'), id: 'voltage_sensor_fault', severity: 'fault' },
  { event: 1, bit: 1, name: msg('Temperature sensing failure'), id: 'temperature_sensor_fault', severity: 'fault' },
  { event: 1, bit: 2, name: msg('Current sensing failure'), id: 'current_sensor_fault', severity: 'fault' },
  { event: 1, bit: 3, name: msg('Key switch failure'), id: 'seplos.key_switch_fault', severity: 'fault', label: msg('Key switch failure') },
  { event: 1, bit: 4, name: msg('Cell voltage difference failure'), id: 'cell_voltage_difference', severity: 'fault' },
  { event: 1, bit: 5, name: msg('Charge switch failure'), id: 'charge_mos_fault', severity: 'fault' },
  { event: 1, bit: 6, name: msg('Discharge switch failure'), id: 'discharge_mos_fault', severity: 'fault' },
  { event: 1, bit: 7, name: msg('Current limit switch failure'), id: 'seplos.current_limit_switch_fault', severity: 'fault', label: msg('Current limit switch failure') },
  { event: 2, bit: 0, name: msg('Cell high voltage alarm'), id: 'cell_overvoltage', severity: 'warning', cells: 'cellHigh' },
  { event: 2, bit: 1, name: msg('Cell overvoltage protection'), id: 'cell_overvoltage', severity: 'protection', cells: 'cellHigh' },
  { event: 2, bit: 2, name: msg('Cell low voltage alarm'), id: 'cell_undervoltage', severity: 'warning', cells: 'cellLow' },
  { event: 2, bit: 3, name: msg('Cell undervoltage protection'), id: 'cell_undervoltage', severity: 'protection', cells: 'cellLow' },
  { event: 2, bit: 4, name: msg('Pack high voltage alarm'), id: 'pack_overvoltage', severity: 'warning' },
  { event: 2, bit: 5, name: msg('Pack overvoltage protection'), id: 'pack_overvoltage', severity: 'protection' },
  { event: 2, bit: 6, name: msg('Pack low voltage alarm'), id: 'pack_undervoltage', severity: 'warning' },
  { event: 2, bit: 7, name: msg('Pack undervoltage protection'), id: 'pack_undervoltage', severity: 'protection' },
  { event: 3, bit: 0, name: msg('Charge high temperature alarm'), id: 'charge_overtemperature', severity: 'warning', cells: 'tempHigh' },
  { event: 3, bit: 1, name: msg('Charge overtemperature protection'), id: 'charge_overtemperature', severity: 'protection', cells: 'tempHigh' },
  { event: 3, bit: 2, name: msg('Charge low temperature alarm'), id: 'charge_undertemperature', severity: 'warning', cells: 'tempLow' },
  { event: 3, bit: 3, name: msg('Charge undertemperature protection'), id: 'charge_undertemperature', severity: 'protection', cells: 'tempLow' },
  { event: 3, bit: 4, name: msg('Discharge high temperature alarm'), id: 'discharge_overtemperature', severity: 'warning', cells: 'tempHigh' },
  { event: 3, bit: 5, name: msg('Discharge overtemperature protection'), id: 'discharge_overtemperature', severity: 'protection', cells: 'tempHigh' },
  { event: 3, bit: 6, name: msg('Discharge low temperature alarm'), id: 'discharge_undertemperature', severity: 'warning', cells: 'tempLow' },
  { event: 3, bit: 7, name: msg('Discharge undertemperature protection'), id: 'discharge_undertemperature', severity: 'protection', cells: 'tempLow' },
  { event: 4, bit: 0, name: msg('Ambient high temperature alarm'), id: 'ambient_overtemperature', severity: 'warning' },
  { event: 4, bit: 1, name: msg('Ambient overtemperature protection'), id: 'ambient_overtemperature', severity: 'protection' },
  { event: 4, bit: 2, name: msg('Ambient low temperature alarm'), id: 'ambient_undertemperature', severity: 'warning' },
  { event: 4, bit: 3, name: msg('Ambient undertemperature protection'), id: 'ambient_undertemperature', severity: 'protection' },
  // V2 sends protection before alarm here; V3 the reverse (spec 9.9).
  { event: 4, bit: 4, name: msg('MOSFET overtemperature protection'), id: 'mos_overtemperature', severity: 'protection' },
  { event: 4, bit: 5, name: msg('MOSFET high temperature alarm'), id: 'mos_overtemperature', severity: 'warning' },
  { event: 4, bit: 6, name: msg('Cell low temperature heating'), id: 'seplos.heating', severity: 'info', label: msg('Cell heating active') },
  // [BSX] and [BLEPDF]; the garbled V2.0 table may mark this bit reserved (unverified).
  { event: 4, bit: 7, name: msg('Secondary trip protection'), id: 'seplos.secondary_trip', severity: 'protection', label: msg('Secondary trip protection') },
  { event: 5, bit: 0, name: msg('Charge overcurrent alarm'), id: 'charge_overcurrent', severity: 'warning' },
  { event: 5, bit: 1, name: msg('Charge overcurrent protection'), id: 'charge_overcurrent', severity: 'protection' },
  { event: 5, bit: 2, name: msg('Discharge overcurrent alarm'), id: 'discharge_overcurrent', severity: 'warning' },
  { event: 5, bit: 3, name: msg('Discharge overcurrent protection'), id: 'discharge_overcurrent', severity: 'protection' },
  { event: 5, bit: 4, name: msg('Transient overcurrent protection'), id: 'discharge_overcurrent', severity: 'protection', label: msg('Transient overcurrent protection') },
  { event: 5, bit: 5, name: msg('Output short circuit protection'), id: 'short_circuit', severity: 'protection' },
  { event: 5, bit: 6, name: msg('Transient overcurrent lockout'), id: 'seplos.transient_oc_lockout', severity: 'protection', label: msg('Transient overcurrent lockout') },
  { event: 5, bit: 7, name: msg('Output short circuit lockout'), id: 'seplos.short_circuit_lockout', severity: 'protection', label: msg('Output short circuit lockout') },
  { event: 6, bit: 0, name: msg('Charging high voltage protection'), id: 'seplos.charge_overvoltage', severity: 'protection', label: msg('Charging high voltage protection') },
  { event: 6, bit: 1, name: msg('Waiting for top-up charge'), id: 'seplos.top_up_waiting', severity: 'info', label: msg('Waiting for top-up charge') },
  { event: 6, bit: 2, name: msg('Remaining capacity alarm'), id: 'soc_low', severity: 'warning' },
  { event: 6, bit: 3, name: msg('Remaining capacity protection'), id: 'soc_low', severity: 'protection' },
  { event: 6, bit: 4, name: msg('Cell low voltage, charging prohibited'), id: 'seplos.low_voltage_charge_forbidden', severity: 'protection', label: msg('Cell low voltage, charging prohibited') },
  { event: 6, bit: 5, name: msg('Output reverse polarity protection'), id: 'seplos.reverse_polarity', severity: 'protection', label: msg('Reverse polarity protection') },
  { event: 6, bit: 6, name: msg('Output connection failure'), id: 'seplos.output_connection_fault', severity: 'fault', label: msg('Output connection failure') },
  { event: 7, bit: 4, name: msg('Automatic charging waiting'), id: 'seplos.auto_charge_waiting', severity: 'info', label: msg('Automatic charging waiting') },
  { event: 7, bit: 5, name: msg('Manual charging waiting'), id: 'seplos.manual_charge_waiting', severity: 'info', label: msg('Manual charging waiting') },
  { event: 8, bit: 0, name: msg('EEPROM storage failure'), id: 'eeprom_fault', severity: 'fault' },
  { event: 8, bit: 1, name: msg('RTC clock failure'), id: 'rtc_fault', severity: 'fault' },
  { event: 8, bit: 2, name: msg('Voltage calibration not done'), id: 'seplos.voltage_not_calibrated', severity: 'warning', label: msg('Voltage calibration not done') },
  { event: 8, bit: 3, name: msg('Current calibration not done'), id: 'seplos.current_not_calibrated', severity: 'warning', label: msg('Current calibration not done') },
  { event: 8, bit: 4, name: msg('Zero point calibration not done'), id: 'seplos.zero_not_calibrated', severity: 'warning', label: msg('Zero point calibration not done') },
  // [BSX] and [SY]; not in the V2.0 document.
  { event: 8, bit: 5, name: msg('Calendar not synchronised'), id: 'seplos.calendar_not_synced', severity: 'info', label: msg('Calendar not synchronised') },
];

const SEVERITY_RANK = { fault: 0, protection: 1, warning: 2, info: 3 };

/**
 * Keep one alarm per id and label, the most severe (a protection bit and its alarm bit are often
 * set together).
 * @param {import('@ubms/bms-core/model').AlarmState[]} list
 */
export function mergeAlarms(list) {
  /** @type {Map<string, import('@ubms/bms-core/model').AlarmState>} */
  const m = new Map();
  for (const a of list) {
    const k = `${a.id}|${a.label ?? ''}`;
    const prev = m.get(k);
    if (!prev || SEVERITY_RANK[a.severity ?? 'warning'] < SEVERITY_RANK[prev.severity ?? 'warning']) m.set(k, a);
  }
  return [...m.values()];
}

/** @param {number[]} idx zero based */
const listText = (idx) => idx.map((i) => i + 1).join(', ');

/**
 * Alarms of a V2 answer (spec 9.1, 9.2, 9.5): the event bits decide, the byte alarm codes only
 * name the cells or sensors, the disconnection bytes report open sense wires.
 * @param {{ events: number[], cellAlarms?: number[], tempAlarms?: number[], disconnect?: number[], cellCount?: number, tempCount?: number }} a
 */
export function v2Alarms({ events, cellAlarms = [], tempAlarms = [], disconnect = [], cellCount = 0, tempCount = 0 }) {
  const cellHigh = cellAlarms.flatMap((c, i) => (c === 0x02 ? [i] : []));
  const cellLow = cellAlarms.flatMap((c, i) => (c === 0x01 ? [i] : []));
  const cellSensors = Math.max(0, tempCount - 2);
  const tempHigh = tempAlarms.slice(0, cellSensors).flatMap((c, i) => (c === 0x02 ? [i] : []));
  const tempLow = tempAlarms.slice(0, cellSensors).flatMap((c, i) => (c === 0x01 ? [i] : []));
  const named = { cellHigh, cellLow, tempHigh, tempLow };
  const out = [];
  for (const def of EVENT_BITS) {
    if (!(((events[def.event - 1] ?? 0) >> def.bit) & 1)) continue;
    let source = `event ${def.event} bit ${def.bit}`;
    const which = def.cells ? named[def.cells] : [];
    if (which.length) source += def.cells?.startsWith('cell') ? `, cells ${listText(which)}` : `, sensors ${listText(which)}`;
    out.push(alarm(def.id, { severity: def.severity, label: def.label, source }));
  }
  const open = cellsFromBits(disconnect, cellCount);
  if (open.length) out.push(alarm('cell_wire_open', { source: `cells ${listText(open)}` }));
  return mergeAlarms(out);
}

/** System state bits (spec 9.4). */
export const SYSTEM_STATE_BITS = [
  { bit: 0, name: msg('Discharging') },
  { bit: 1, name: msg('Charging') },
  { bit: 2, name: msg('Float charge') },
  // [BSX] mode 0x08 only; reserved in the V2.0 and Bluetooth documents.
  { bit: 3, name: msg('Fully charged') },
  { bit: 4, name: msg('Standby') },
  { bit: 5, name: msg('Shut down') },
];

/**
 * Text of a system state byte, for example "Charging" or "Standby".
 * @param {number} state
 */
export function systemStateText(state) {
  const names = SYSTEM_STATE_BITS.filter((b) => (state >> b.bit) & 1).map((b) => b.name);
  return names.length ? names.join(', ') : msg('None');
}

/** Switch (on-off) state byte (spec 9.3). @param {number} s */
export const switchStates = (s) => ({ discharge: !!(s & 1), charge: !!(s & 2), currentLimit: !!(s & 4), heater: !!(s & 8) });

/** CAN protocol codes of 0x51 byte 32 (spec 9.6). */
export const CAN_PROTOCOLS = Object.freeze({ 0: msg('None'), 1: 'Pylontech', 2: 'Growatt', 3: 'Victron', 4: 'SMA / Sofar', 5: 'Ginlong', 6: 'Studer' });
/** RS485 protocol codes of 0x51 byte 33 (spec 9.6). */
export const RS485_PROTOCOLS = Object.freeze({ 0: msg('None'), 1: 'Pylontech', 2: 'Growatt', 3: 'Voltronic', 4: 'Sofar', 5: 'Luxpower', 6: 'Studer' });
/** Battery type codes of 0x51 byte 34 (spec 9.7); 0x48 to 0x4A conflict between sources (unverified). */
export const BATTERY_TYPES = Object.freeze({ 0x46: msg('Lithium iron phosphate (LFP)'), 0x47: msg('Ternary lithium (NCM)') });

// ---------------------------------------------------------------------------------------------
// Protocol log
// ---------------------------------------------------------------------------------------------

const ASCII_NAMES = /** @type {Record<number, string>} */ ({
  0x42: 'telemetry',
  0x44: 'alarms and states',
  0x45: 'telecontrol',
  0x47: 'parameters',
  0x4d: 'time',
  0x4e: 'set time',
  0x4f: 'protocol version',
  0x51: 'device information',
  0xa1: 'parameter write',
});

const BLE_NAMES = /** @type {Record<number, string>} */ ({
  0x47: 'parameters',
  0x51: 'manufacturer information',
  0x61: 'single machine data',
  0x62: 'parallel data',
  0x63: 'CAN protocol',
  0x64: 'RS485 protocol',
  0x65: 'group number',
  0xa1: 'parameter write',
  0xaa: 'switch',
});

/**
 * Protocol log description of a V2 ASCII frame. Answers carry no command, so `command` (the
 * outstanding request) names them.
 * @param {Uint8Array} frame
 * @param {{ command?: number }} [ctx]
 */
export function describeAscii(frame, ctx = {}) {
  const f = parseAscii(frame);
  if (!f) return null;
  if (!isAsciiAnswer(f)) {
    return { name: `Seplos V2 ${ASCII_NAMES[f.cid2] ?? `0x${hex([f.cid2])}`} request (address ${f.adr})`, decode: () => ({ ...f, info: hex(f.info, ' ') }) };
  }
  const cmd = ctx.command;
  const what = cmd !== undefined ? (ASCII_NAMES[cmd] ?? `0x${hex([cmd])}`) : 'answer';
  return {
    name: `Seplos V2 ${what} answer (address ${f.adr}, ${RTN_NAMES[/** @type {keyof typeof RTN_NAMES} */ (f.cid2)] ?? f.cid2})`,
    decode: () => {
      /** @type {Record<string, any>} */
      const out = { ver: f.ver, adr: f.adr, rtn: f.cid2, lenid: f.lenid };
      try {
        if (cmd === ASCII_CMD.TELEMETRY) Object.assign(out, parseTelemetry(f.info));
        else if (cmd === ASCII_CMD.ALARMS) Object.assign(out, parseAlarmInfo(f.info));
        else if (cmd === ASCII_CMD.INFO) Object.assign(out, parseAsciiInfo(f.info));
        else if (cmd === ASCII_CMD.PARAMS) {
          const p = parseParamBlock(f.info);
          Object.assign(out, { ...p, raw: undefined });
        } else out.info = hex(f.info, ' ');
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      }
      return out;
    },
  };
}

/**
 * Protocol log description of a V2 BLE frame.
 * @param {Uint8Array} frame
 */
export function describeBle(frame) {
  const f = parseBleFrame(frame);
  if (!f) return null;
  if (f.b3 === CID1) {
    return { name: `Seplos V2 BLE ${BLE_NAMES[f.b4] ?? `0x${hex([f.b4])}`} request`, decode: () => ({ ...f, data: hex(f.data, ' ') }) };
  }
  return {
    name: `Seplos V2 BLE ${BLE_NAMES[f.b3] ?? `0x${hex([f.b3])}`} answer (${RTN_NAMES[/** @type {keyof typeof RTN_NAMES} */ (f.b4)] ?? f.b4})`,
    decode: () => {
      /** @type {Record<string, any>} */
      const out = { ver: f.ver, adr: f.adr, cid: f.b3, rtn: f.b4, length: f.length };
      try {
        if (isParamBlockShape(f.data)) Object.assign(out, { ...parseParamBlock(f.data), raw: undefined });
        else if (f.b3 === BLE_CMD.SINGLE) Object.assign(out, parseBleSingle(f.data));
        else if (f.b3 === BLE_CMD.PARALLEL) Object.assign(out, parseBleParallel(f.data));
        else if (f.b3 === BLE_CMD.INFO) Object.assign(out, parseBleInfo(f.data));
        else out.data = hex(f.data, ' ');
      } catch (err) {
        out.error = err instanceof Error ? err.message : String(err);
      }
      return out;
    },
  };
}
