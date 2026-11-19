import { FrameAssembler, crc16Modbus, sum8, hex, u16be, u16le, u32be, setU16be, setU16le } from '@ubms/transport';
import { msg, alarm, SEVERITY_ORDER } from '@ubms/bms-core';
import { alarmsFromBits, r, ymd } from '../common/util.js';

/**
 * Daly BMS protocols, pure functions without I/O. Specification: docs/protocols/daly.md.
 *
 * - DALY_CLASSIC ("A5 protocol", spec 3.1): fixed 13 byte frames `A5 <addr> <cmd> 08 <8 data> <sum8>`,
 *   big endian. Requests carry a host address (0x40 PC / RS485 board 1, 0x80 Bluetooth), replies
 *   the board number (0x01..).
 * - DALY_MODBUS (spec 3.2): Modbus RTU style frames with CRC-16/MODBUS, two register maps:
 *   address `D2` (32 cells, settings at 0x0080) and `0x80 + board` requests answered from
 *   `0x50 + board` (48 cells, settings at 0x0100 and above). Replies do not contain the start
 *   register, and function 0x10 has no byte count.
 *
 * Parsers return plain objects whose field names match the test vectors
 * (packages/bms-drivers/test/vectors/daly.json). Values are engineering units in the device's own
 * sign convention: `current` is the raw decode `(raw - 30000) x 0.1` without any sign policy
 * (spec 12.1 item 1); the driver applies the sign.
 */

/** @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState */

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** @param {number} v */
const pad2 = (v) => String(v).padStart(2, '0');

/**
 * `YYYY-MM-DD hh:mm:ss` from six bytes `YY MM DD hh mm ss` (year - 2000).
 * @param {ArrayLike<number>} b
 * @param {number} [o]
 */
export function rtcText(b, o = 0) {
  return `${ymd(2000 + b[o], b[o + 1], b[o + 2])} ${pad2(b[o + 3])}:${pad2(b[o + 4])}:${pad2(b[o + 5])}`;
}

/**
 * Six clock bytes `YY MM DD hh mm ss` from a local date.
 * @param {Date} date
 */
export function rtcBytes(date) {
  return [date.getFullYear() - 2000, date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].map((v) => v & 0xff);
}

/**
 * Printable ASCII of a field, stopping at NUL or 0xFF, trimmed (Modbus text registers).
 * @param {ArrayLike<number>} bytes
 * @param {number} [offset]
 * @param {number} [length]
 */
export function asciiField(bytes, offset = 0, length = bytes.length - offset) {
  let s = '';
  for (let i = offset; i < offset + length && i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00 || b === 0xff) break;
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
  }
  return s.trim();
}

/**
 * Raw characters of a classic text frame, kept as they are (spaces included); bytes outside
 * printable ASCII are dropped.
 * @param {ArrayLike<number>} bytes
 */
function rawText(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x20 && bytes[i] < 0x7f) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * Keep one alarm per id, the most severe one (a level 2 bit and its level 1 bit often fire
 * together).
 * @param {AlarmState[]} alarms
 * @returns {AlarmState[]}
 */
export function mostSevere(alarms) {
  /** @type {Map<string, AlarmState>} */
  const best = new Map();
  const rank = (/** @type {AlarmState} */ a) => /** @type {Record<string, number>} */ (SEVERITY_ORDER)[a.severity ?? 'warning'] ?? 9;
  for (const a of alarms) {
    const prev = best.get(a.id);
    if (!prev || rank(a) < rank(prev)) best.set(a.id, a);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------------------------
// DALY_CLASSIC constants
// ---------------------------------------------------------------------------------------------

export const CLASSIC_START = 0xa5;
export const CLASSIC_LENGTH = 13;

/** Request (host) addresses, spec 2.2. RS485 board n uses `0x3F + n`. */
export const HOST = Object.freeze({ PC: 0x40, BLUETOOTH: 0x80, GPRS: 0x20 });

/** Classic data ids (spec 5.1). */
export const CMD = Object.freeze({
  RESET: 0x00,
  SET_SOC: 0x21,
  RATED: 0x50,
  BOARDS: 0x51,
  CUMULATIVE: 0x52,
  BATTERY_INFO: 0x53,
  FIRMWARE_INDEX: 0x54,
  BATTERY_CODE: 0x57,
  CELL_LIMITS: 0x59,
  PACK_LIMITS: 0x5a,
  CURRENT_LIMITS: 0x5b,
  TEMP_LIMITS: 0x5c,
  SOC_LIMITS: 0x5d,
  DIFF_LIMITS: 0x5e,
  BALANCE_LIMITS: 0x5f,
  SHORT_CIRCUIT: 0x60,
  RTC: 0x61,
  SOFTWARE_VERSION: 0x62,
  HARDWARE_VERSION: 0x63,
  SOC: 0x90,
  CELL_RANGE: 0x91,
  TEMP_RANGE: 0x92,
  MOSFET: 0x93,
  STATUS: 0x94,
  CELLS: 0x95,
  TEMPERATURES: 0x96,
  BALANCE: 0x97,
  FAILURES: 0x98,
  D8: 0xd8,
  DISCHARGE_MOS: 0xd9,
  CHARGE_MOS: 0xda,
});

/** Write command = read command - 0x40 (spec 5.3). */
export const WRITE_OFFSET = 0x40;

/** Read commands whose group has a captured write command (spec 5.1, 5.3). */
export const WRITABLE_GROUPS = Object.freeze([0x50, 0x51, 0x52, 0x53, 0x54, 0x57, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60]);

/** Multi-frame replies: frames per command (0x95 and 0x96 depend on the counts, spec 6.1). */
export const TEXT_FRAMES = Object.freeze({ [CMD.BATTERY_CODE]: 5, [CMD.SOFTWARE_VERSION]: 2, [CMD.HARDWARE_VERSION]: 2 });

/** English command names for the protocol log. */
const CLASSIC_NAMES = Object.freeze({
  0x00: 'Reset',
  0x02: 'App probe',
  0x21: 'Set SOC and clock',
  0x50: 'Rated capacity and nominal cell voltage',
  0x51: 'Board configuration',
  0x52: 'Cumulative charge and discharge',
  0x53: 'Battery information',
  0x54: 'Firmware index',
  0x57: 'Battery code',
  0x59: 'Cell voltage thresholds',
  0x5a: 'Pack voltage thresholds',
  0x5b: 'Current thresholds',
  0x5c: 'Temperature thresholds',
  0x5d: 'SOC thresholds',
  0x5e: 'Difference thresholds',
  0x5f: 'Balancing thresholds',
  0x60: 'Short circuit and current sampling',
  0x61: 'Clock',
  0x62: 'Software version',
  0x63: 'Hardware version',
  0x90: 'Pack voltage, current and SOC',
  0x91: 'Highest and lowest cell voltage',
  0x92: 'Highest and lowest temperature',
  0x93: 'Charge state and MOSFETs',
  0x94: 'Status information',
  0x95: 'Cell voltages',
  0x96: 'Temperatures',
  0x97: 'Cell balancing',
  0x98: 'Failure status',
  0xd8: 'Command 0xD8',
  0xd9: 'Discharge MOSFET',
  0xda: 'Charge MOSFET',
});

/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
/** @param {number} v */
const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** RS485 board n (1..16) is addressed as `0x3F + n` (0x40 = board 1). @param {number} board */
export const boardHostAddress = (board) => 0x3f + board;

/** Request addresses: 0x20 GPRS, 0x40..0x4F PC and RS485 boards, 0x80 Bluetooth (spec 3.3). @param {number} a */
export const isClassicHostAddress = (a) => a === HOST.GPRS || a === HOST.BLUETOOTH || (a >= 0x40 && a <= 0x4f);

/** Replies carry the board number 0x01..0x10 (spec 3.3). @param {number} a */
export const isClassicBoardAddress = (a) => a >= 0x01 && a <= 0x10;

// ---------------------------------------------------------------------------------------------
// DALY_CLASSIC encoders
// ---------------------------------------------------------------------------------------------

/**
 * Build a 13 byte classic frame (spec 3.1).
 * @param {number} address host address (requests) or board number (device replies)
 * @param {number} command
 * @param {ArrayLike<number>} [data] up to 8 bytes, missing bytes are zero
 * @returns {Uint8Array}
 */
export function encodeClassic(address, command, data = []) {
  const f = new Uint8Array(CLASSIC_LENGTH);
  f[0] = CLASSIC_START;
  f[1] = address & 0xff;
  f[2] = command & 0xff;
  f[3] = 0x08;
  for (let i = 0; i < 8; i++) f[4 + i] = (data[i] ?? 0) & 0xff;
  f[12] = sum8(f, 0, 12);
  return f;
}

/**
 * Read request. The data bytes are don't care; zero fill is the default because some firmware
 * copies request byte 8 into the 0x94 DI/DO byte (spec 2.2, 12.2).
 * @param {number} address host address
 * @param {number} command
 * @param {number} [fill] 0x00 or 0xAA
 */
export const encodeClassicRead = (address, command, fill = 0) => encodeClassic(address, command, new Uint8Array(8).fill(fill));

/**
 * Configuration write: the whole 8 byte group of the read reply, sent with `read command - 0x40`
 * (spec 5.3).
 * @param {number} address
 * @param {number} readCommand 0x50..0x60
 * @param {ArrayLike<number>} data 8 bytes
 */
export const encodeClassicWrite = (address, readCommand, data) => encodeClassic(address, readCommand - WRITE_OFFSET, data);

/**
 * MOSFET switch command (0xDA charge, 0xD9 discharge), data 0 = 1 on, 0 off (spec 8).
 * @param {number} address
 * @param {'charge'|'discharge'} which
 * @param {boolean} on
 */
export const encodeMosfet = (address, which, on) => encodeClassic(address, which === 'charge' ? CMD.CHARGE_MOS : CMD.DISCHARGE_MOS, [on ? 1 : 0]);

/**
 * Set SOC (0x21): data 0..5 = clock `YY MM DD hh mm ss`, data 6..7 = SOC x 10 (dbus-serialbattery
 * layout, spec 12.1 item 16). Without a date the clock bytes are zero (python-daly-bms style).
 * @param {number} address
 * @param {number} soc percent
 * @param {Date | null} [date] local time to set
 */
export function encodeSetSoc(address, soc, date = null) {
  const d = new Uint8Array(8);
  if (date) d.set(rtcBytes(date), 0);
  setU16be(d, 6, Math.round(soc * 10));
  return encodeClassic(address, CMD.SET_SOC, d);
}

/** BMS reset (0x00), spec 5.1; the reply is unverified. @param {number} address */
export const encodeReset = (address) => encodeClassic(address, CMD.RESET);

/**
 * Battery code write (0x17): five frames, data 0 = frame number 1..5, data 1..7 = seven
 * characters, padded with spaces as the PC software does (spec 5.3).
 * @param {number} address
 * @param {string} text at most 35 characters
 * @returns {Uint8Array[]}
 */
export function encodeBatteryCodeWrite(address, text) {
  const padded = text.slice(0, 35).padEnd(35, ' ');
  const frames = [];
  for (let n = 1; n <= 5; n++) {
    const data = [n];
    for (let i = 0; i < 7; i++) data.push(padded.charCodeAt((n - 1) * 7 + i) & 0x7f);
    frames.push(encodeClassic(address, CMD.BATTERY_CODE - WRITE_OFFSET, data));
  }
  return frames;
}

// ---------------------------------------------------------------------------------------------
// DALY_CLASSIC framing
// ---------------------------------------------------------------------------------------------

/**
 * Length of the classic frame at the start of `buf` (spec 3.3 step 2): 13 when byte 3 is 0x08,
 * -1 otherwise, 0 while the header is incomplete.
 * @param {Uint8Array} buf starts with A5
 */
export function classicFrameLength(buf) {
  if (buf.length < 4) return 0;
  return buf[3] === 0x08 ? CLASSIC_LENGTH : -1;
}

/** @param {Uint8Array} f */
export const validateClassic = (f) => f.length === CLASSIC_LENGTH && f[0] === CLASSIC_START && f[3] === 0x08 && sum8(f, 0, 12) === f[12];

/**
 * Frame assembler for classic frames (both directions: the simulator uses it for requests).
 * A bad header or checksum drops one byte only, so a stray A5 inside data is survived.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createClassicAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({ sync: [[CLASSIC_START]], length: classicFrameLength, validate: validateClassic, onFrame, onDiscard, maxLength: CLASSIC_LENGTH, staleMs: 1000 });
}

// ---------------------------------------------------------------------------------------------
// DALY_CLASSIC parsers (spec 6.1, 6.2)
// ---------------------------------------------------------------------------------------------

/**
 * Decode one configuration group (read reply 0x50..0x63 and the matching write request, which has
 * the same layout). Field names follow the test vectors.
 * @param {number} readCommand
 * @param {Uint8Array} d 8 data bytes
 * @returns {Record<string, any>}
 */
export function decodeGroup(readCommand, d) {
  switch (readCommand) {
    case CMD.RATED:
      // Bytes 4..5 are reserved (0); the nominal voltage is u16 at 6..7 (spec 12.1 item 7).
      return { ratedCapacity: u32be(d, 0) / 1000, nominalCellVoltage: u16be(d, 6) / 1000 };
    case CMD.BOARDS:
      return { acquisitionBoards: d[0], cellsPerBoard: [d[1], d[2], d[3]], ntcPerBoard: [d[4], d[5], d[6]] };
    case CMD.CUMULATIVE:
      // Unit unverified (spec 6.2): raw counts only.
      return { cumulativeChargeRaw: u32be(d, 0), cumulativeDischargeRaw: u32be(d, 4) };
    case CMD.BATTERY_INFO:
      return {
        operationMode: d[0],
        batteryType: d[1],
        productionDate: ymd(2000 + d[2], d[3], d[4]),
        sleepTimeRaw: u16be(d, 5),
        currentWave: d[7] / 10,
      };
    case CMD.FIRMWARE_INDEX:
      return { text: rawText(d) };
    case CMD.BATTERY_CODE:
    case CMD.SOFTWARE_VERSION:
    case CMD.HARDWARE_VERSION:
      return { frameIndex: d[0], text: rawText(d.subarray(1)) };
    case CMD.CELL_LIMITS:
      return { cellHighL1: u16be(d, 0) / 1000, cellHighL2: u16be(d, 2) / 1000, cellLowL1: u16be(d, 4) / 1000, cellLowL2: u16be(d, 6) / 1000 };
    case CMD.PACK_LIMITS:
      return { packHighL1: u16be(d, 0) / 10, packHighL2: u16be(d, 2) / 10, packLowL1: u16be(d, 4) / 10, packLowL2: u16be(d, 6) / 10 };
    case CMD.CURRENT_LIMITS:
      // Signed decode as stored: charge limits sit below 30000 (spec 6.2 0x5B).
      return {
        chargeOcL1: (u16be(d, 0) - 30000) / 10,
        chargeOcL2: (u16be(d, 2) - 30000) / 10,
        dischargeOcL1: (u16be(d, 4) - 30000) / 10,
        dischargeOcL2: (u16be(d, 6) - 30000) / 10,
      };
    case CMD.TEMP_LIMITS:
      return {
        chargeHighL1: d[0] - 40,
        chargeHighL2: d[1] - 40,
        chargeLowL1: d[2] - 40,
        chargeLowL2: d[3] - 40,
        dischargeHighL1: d[4] - 40,
        dischargeHighL2: d[5] - 40,
        dischargeLowL1: d[6] - 40,
        dischargeLowL2: d[7] - 40,
      };
    case CMD.SOC_LIMITS:
      return { socHighL1: u16be(d, 0) / 10, socHighL2: u16be(d, 2) / 10, socLowL1: u16be(d, 4) / 10, socLowL2: u16be(d, 6) / 10 };
    case CMD.DIFF_LIMITS:
      // Temperature differences in plain degrees C (spec 12.1 item 6, unverified by a write test).
      return { cellDiffL1: u16be(d, 0) / 1000, cellDiffL2: u16be(d, 2) / 1000, tempDiffL1: d[4], tempDiffL2: d[5] };
    case CMD.BALANCE_LIMITS:
      return { balanceStartVoltage: u16be(d, 0) / 1000, balanceDiffVoltage: u16be(d, 2) / 1000 };
    case CMD.SHORT_CIRCUIT:
      return { shortCircuitCurrent: u16be(d, 0), samplingResistanceRaw: u16be(d, 2) };
    case CMD.RTC:
      return { rtc: rtcText(d, 0) };
    default:
      return {};
  }
}

/**
 * Decode the data of a live data reply (0x90..0x98).
 * @param {number} command
 * @param {Uint8Array} d
 * @returns {Record<string, any>}
 */
function decodeLive(command, d) {
  switch (command) {
    case CMD.SOC: {
      const currentRaw = u16be(d, 4);
      return { packVoltage: u16be(d, 0) / 10, acquisitionVoltage: u16be(d, 2) / 10, currentRaw, current: r((currentRaw - 30000) / 10, 1), soc: u16be(d, 6) / 10 };
    }
    case CMD.CELL_RANGE:
      return { maxCellVoltage: u16be(d, 0) / 1000, maxCellIndex: d[2], minCellVoltage: u16be(d, 3) / 1000, minCellIndex: d[5] };
    case CMD.TEMP_RANGE:
      return { maxTemperature: d[0] - 40, maxTemperatureProbe: d[1], minTemperature: d[2] - 40, minTemperatureProbe: d[3] };
    case CMD.MOSFET:
      return { state: d[0], chargeMos: d[1] !== 0, dischargeMos: d[2] !== 0, bmsLife: d[3], remainingCapacity: u32be(d, 4) / 1000 };
    case CMD.STATUS:
      return {
        cellCount: d[0],
        temperatureSensorCount: d[1],
        chargerConnected: d[2] !== 0,
        loadConnected: d[3] !== 0,
        dioBits: d[4],
        cycles: u16be(d, 5),
        byte7Raw: d[7],
      };
    case CMD.CELLS:
      return { frameIndex: d[0], cellVoltages: [u16be(d, 1) / 1000, u16be(d, 3) / 1000, u16be(d, 5) / 1000], byte7Raw: d[7] };
    case CMD.TEMPERATURES:
      return { frameIndex: d[0], temperatures: Array.from(d.subarray(1, 8), (v) => v - 40) };
    case CMD.BALANCE:
      return { balanceBytes: hex(d) };
    case CMD.FAILURES:
      return { alarmBytes: hex(d), faultCode: d[7] };
    default:
      return {};
  }
}

/**
 * @typedef {Record<string, any> & {
 *   address: number, command: number, checksum: number, payload: string,
 *   isBmsReply: boolean, board?: number, data: Uint8Array
 * }} ClassicFrame
 */

/**
 * Parse a classic frame of either direction. Requests carry a host address and are decoded with
 * the layout of the group they write; replies carry the board number (spec 3.3). Bytes a command
 * does not define are never decoded (they repeat old data, spec 3.1).
 * @param {Uint8Array} frame validated 13 byte frame
 * @returns {ClassicFrame}
 */
export function parseClassic(frame) {
  const address = frame[1];
  const command = frame[2];
  const data = frame.subarray(4, 12);
  const isBmsReply = isClassicBoardAddress(address);
  /** @type {ClassicFrame} */
  const out = { address, command, checksum: frame[12], payload: hex(data), isBmsReply, data };
  if (isBmsReply) {
    out.board = address;
    if (command >= 0x90 && command <= 0x98) Object.assign(out, decodeLive(command, data));
    else if (command >= 0x50 && command <= 0x63) Object.assign(out, decodeGroup(command, data));
    // Write acknowledgements, MOSFET replies and 0xD8: only data 0 is defined (spec 6.2).
    else out.data0 = data[0];
    return out;
  }
  if (address >= 0x40 && address <= 0x4f) out.board = address - 0x3f;
  if (command >= 0x10 && command <= 0x20) Object.assign(out, decodeGroup(command + WRITE_OFFSET, data));
  else if (command === CMD.SET_SOC) Object.assign(out, { rtc: rtcText(data, 0), soc: u16be(data, 6) / 10 });
  else if (command === CMD.CHARGE_MOS || command === CMD.DISCHARGE_MOS) out.data0 = data[0];
  return out;
}

/**
 * Cell voltages from the frames of one 0x95 answer. Frames are keyed by their number; frames
 * beyond the cell count are ignored. Returns null when a needed frame is missing or duplicated, so
 * the caller keeps the previous values (spec 12.2).
 * @param {Uint8Array[]} frames
 * @param {number} cellCount
 * @returns {number[] | null}
 */
export function assembleCells(frames, cellCount) {
  const needed = Math.ceil(cellCount / 3);
  const byIndex = framesByIndex(frames, needed);
  if (!byIndex) return null;
  const cells = [];
  for (let n = 1; n <= needed; n++) {
    const f = /** @type {Uint8Array} */ (byIndex.get(n));
    for (let k = 0; k < 3 && cells.length < cellCount; k++) cells.push(u16be(f, 5 + 2 * k) / 1000);
  }
  return cells;
}

/**
 * Temperatures from the frames of one 0x96 answer (7 per frame, +40 offset).
 * @param {Uint8Array[]} frames
 * @param {number} count
 * @returns {number[] | null}
 */
export function assembleTemperatures(frames, count) {
  const needed = Math.ceil(count / 7);
  const byIndex = framesByIndex(frames, needed);
  if (!byIndex) return null;
  const temps = [];
  for (let n = 1; n <= needed; n++) {
    const f = /** @type {Uint8Array} */ (byIndex.get(n));
    for (let k = 0; k < 7 && temps.length < count; k++) temps.push(f[5 + k] - 40);
  }
  return temps;
}

/**
 * Text of a multi-frame answer (0x57 battery code, 0x62 / 0x63 versions): 7 characters per
 * frame, trailing spaces and NUL padding removed.
 * @param {Uint8Array[]} frames
 * @param {number} count expected frames
 * @returns {string | null}
 */
export function assembleText(frames, count) {
  const byIndex = framesByIndex(frames, count);
  if (!byIndex) return null;
  const bytes = [];
  for (let n = 1; n <= count; n++) bytes.push(.../** @type {Uint8Array} */ (byIndex.get(n)).subarray(5, 12));
  const end = bytes.indexOf(0);
  return rawText(end >= 0 ? bytes.slice(0, end) : bytes).trim();
}

/**
 * Frames keyed by their number (data 0, 1 based). Null when one of 1..needed is missing or a
 * needed number appears twice.
 * @param {Uint8Array[]} frames
 * @param {number} needed
 */
function framesByIndex(frames, needed) {
  /** @type {Map<number, Uint8Array>} */
  const m = new Map();
  for (const f of frames) {
    const n = f[4];
    if (n < 1 || n > needed) continue;
    if (m.has(n)) return null;
    m.set(n, f);
  }
  for (let n = 1; n <= needed; n++) if (!m.has(n)) return null;
  return m;
}

/**
 * True when frames 1..needed are all present (the `until` condition of multi-frame requests).
 * @param {Uint8Array[]} frames
 * @param {number} needed
 */
export function framesComplete(frames, needed) {
  const seen = new Set();
  for (const f of frames) seen.add(f[4]);
  for (let n = 1; n <= needed; n++) if (!seen.has(n)) return false;
  return true;
}

/**
 * Balancing flags from the 0x97 data: cell k (1 based) = bit (k-1) % 8 of data byte (k-1) / 8
 * (maland16, matthewgream, CAN notes). The bit order is UNVERIFIED (spec 6.1, 12.1 item 4): no
 * capture with balancing active is known.
 * @param {ArrayLike<number>} data 8 data bytes
 * @param {number} cellCount at most 48
 */
export function balancingFlags(data, cellCount) {
  const n = Math.min(cellCount, 48);
  return Array.from({ length: n }, (_, i) => ((data[i >> 3] >> (i & 7)) & 1) === 1);
}

// ---------------------------------------------------------------------------------------------
// Failure codes (spec 9.1, classic 0x98; the same bits sit in the D2 fault registers, spec 9.2)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ byte: number, bit: number, id: string, severity?: 'info'|'warning'|'protection'|'fault', label?: string }} FailureBit
 */

const SOC_HIGH = msg('State of charge too high');

/**
 * Bit table in classic byte order. Level 1 is a warning, level 2 the protection that switches the
 * MOSFETs (spec conventions). Byte 7 is a numeric fault code, not flags.
 * @type {FailureBit[]}
 */
export const FAILURE_BITS = [
  { byte: 0, bit: 0, id: 'cell_overvoltage', severity: 'warning' },
  { byte: 0, bit: 1, id: 'cell_overvoltage', severity: 'protection' },
  { byte: 0, bit: 2, id: 'cell_undervoltage', severity: 'warning' },
  { byte: 0, bit: 3, id: 'cell_undervoltage', severity: 'protection' },
  { byte: 0, bit: 4, id: 'pack_overvoltage', severity: 'warning' },
  { byte: 0, bit: 5, id: 'pack_overvoltage', severity: 'protection' },
  { byte: 0, bit: 6, id: 'pack_undervoltage', severity: 'warning' },
  { byte: 0, bit: 7, id: 'pack_undervoltage', severity: 'protection' },
  { byte: 1, bit: 0, id: 'charge_overtemperature', severity: 'warning' },
  { byte: 1, bit: 1, id: 'charge_overtemperature', severity: 'protection' },
  { byte: 1, bit: 2, id: 'charge_undertemperature', severity: 'warning' },
  { byte: 1, bit: 3, id: 'charge_undertemperature', severity: 'protection' },
  { byte: 1, bit: 4, id: 'discharge_overtemperature', severity: 'warning' },
  { byte: 1, bit: 5, id: 'discharge_overtemperature', severity: 'protection' },
  { byte: 1, bit: 6, id: 'discharge_undertemperature', severity: 'warning' },
  { byte: 1, bit: 7, id: 'discharge_undertemperature', severity: 'protection' },
  { byte: 2, bit: 0, id: 'charge_overcurrent', severity: 'warning' },
  { byte: 2, bit: 1, id: 'charge_overcurrent', severity: 'protection' },
  { byte: 2, bit: 2, id: 'discharge_overcurrent', severity: 'warning' },
  { byte: 2, bit: 3, id: 'discharge_overcurrent', severity: 'protection' },
  { byte: 2, bit: 4, id: 'daly.soc_high', severity: 'warning', label: SOC_HIGH },
  { byte: 2, bit: 5, id: 'daly.soc_high', severity: 'protection', label: SOC_HIGH },
  { byte: 2, bit: 6, id: 'soc_low', severity: 'warning' },
  { byte: 2, bit: 7, id: 'soc_low', severity: 'protection' },
  { byte: 3, bit: 0, id: 'cell_voltage_difference', severity: 'warning' },
  { byte: 3, bit: 1, id: 'cell_voltage_difference', severity: 'protection' },
  { byte: 3, bit: 2, id: 'temperature_difference', severity: 'warning' },
  { byte: 3, bit: 3, id: 'temperature_difference', severity: 'protection' },
  { byte: 4, bit: 0, id: 'mos_overtemperature' },
  { byte: 4, bit: 1, id: 'mos_overtemperature' },
  { byte: 4, bit: 2, id: 'temperature_sensor_fault' },
  { byte: 4, bit: 3, id: 'temperature_sensor_fault' },
  { byte: 4, bit: 4, id: 'charge_mos_fault' },
  { byte: 4, bit: 5, id: 'discharge_mos_fault' },
  { byte: 4, bit: 6, id: 'charge_mos_fault' },
  { byte: 4, bit: 7, id: 'discharge_mos_fault' },
  { byte: 5, bit: 0, id: 'afe_fault' },
  { byte: 5, bit: 1, id: 'cell_wire_open' },
  { byte: 5, bit: 2, id: 'temperature_sensor_fault' },
  { byte: 5, bit: 3, id: 'eeprom_fault' },
  { byte: 5, bit: 4, id: 'rtc_fault' },
  { byte: 5, bit: 5, id: 'precharge_fault' },
  { byte: 5, bit: 6, id: 'daly.external_comm_fault', severity: 'fault', label: msg('Vehicle (external) communication fault') },
  { byte: 5, bit: 7, id: 'communication_fault' },
  { byte: 6, bit: 0, id: 'current_sensor_fault' },
  { byte: 6, bit: 1, id: 'voltage_sensor_fault' },
  { byte: 6, bit: 2, id: 'short_circuit' },
  { byte: 6, bit: 3, id: 'daly.low_voltage_no_charge', severity: 'protection', label: msg('Voltage too low, charging forbidden') },
  { byte: 6, bit: 4, id: 'daly.soft_switch_off', severity: 'info', label: msg('MOSFETs switched off by GPS or soft switch') },
  { byte: 6, bit: 5, id: 'daly.cabinet_offline', severity: 'warning', label: msg('Charging cabinet offline') },
];

/**
 * Active alarms from the 8 failure bytes in classic order (0x98 data, or the D2 fault registers
 * after `d2FaultBytes`). One alarm per id, the most severe.
 * @param {ArrayLike<number>} bytes
 * @returns {AlarmState[]}
 */
export function failureAlarms(bytes) {
  /** @type {AlarmState[]} */
  const out = [];
  for (let b = 0; b < 7; b++) {
    const table = FAILURE_BITS.filter((d) => d.byte === b);
    out.push(...alarmsFromBits(bytes[b] ?? 0, table, `byte ${b} bit`));
  }
  return mostSevere(out);
}

// ---------------------------------------------------------------------------------------------
// DALY_MODBUS constants and encoders (spec 3.2)
// ---------------------------------------------------------------------------------------------

export const MODBUS = Object.freeze({
  D2: 0xd2,
  REQUEST_OFFSET: 0x80,
  RESPONSE_OFFSET: 0x50,
  READ: 0x03,
  WRITE: 0x06,
  WRITE_MULTI: 0x10,
});

/** Largest Modbus frame: address, function, byte count, 255 data bytes, CRC. */
export const MODBUS_MAX_FRAME = 5 + 255;

/**
 * @typedef {'d2'|'p81'} ModbusFlavour
 */

/**
 * Request address: fixed D2, or `0x80 + board` for the 0x81 map (spec 2.2).
 * @param {ModbusFlavour} flavour
 * @param {number} [board]
 */
export const modbusRequestAddress = (flavour, board = 1) => (flavour === 'd2' ? MODBUS.D2 : MODBUS.REQUEST_OFFSET + board);

/**
 * Response address: D2, or `0x50 + board`.
 * @param {ModbusFlavour} flavour
 * @param {number} [board]
 */
export const modbusResponseAddress = (flavour, board = 1) => (flavour === 'd2' ? MODBUS.D2 : MODBUS.RESPONSE_OFFSET + board);

/**
 * Append the CRC-16/MODBUS, low byte first.
 * @param {ArrayLike<number>} bytes
 * @returns {Uint8Array}
 */
export function withCrc(bytes) {
  const f = new Uint8Array(bytes.length + 2);
  f.set(bytes);
  setU16le(f, bytes.length, crc16Modbus(f, 0, bytes.length));
  return f;
}

/** @param {Uint8Array} frame */
export const modbusCrcOk = (frame) => frame.length >= 4 && crc16Modbus(frame, 0, frame.length - 2) === u16le(frame, frame.length - 2);

/**
 * Read holding registers (0x03).
 * @param {number} address
 * @param {number} start
 * @param {number} count
 */
export const encodeModbusRead = (address, start, count) => withCrc([address, MODBUS.READ, start >> 8, start & 0xff, count >> 8, count & 0xff]);

/**
 * Write single register (0x06); the response repeats the request.
 * @param {number} address
 * @param {number} register
 * @param {number} value u16
 */
export const encodeModbusWrite = (address, register, value) =>
  withCrc([address, MODBUS.WRITE, register >> 8, register & 0xff, (value >> 8) & 0xff, value & 0xff]);

/**
 * Write multiple registers (0x10) the Daly way: NO byte count byte (spec 3.2).
 * @param {number} address
 * @param {number} start
 * @param {number[]} values u16 each
 */
export function encodeModbusWriteMulti(address, start, values) {
  const bytes = [address, MODBUS.WRITE_MULTI, start >> 8, start & 0xff, values.length >> 8, values.length & 0xff];
  for (const v of values) bytes.push((v >> 8) & 0xff, v & 0xff);
  return withCrc(bytes);
}

/**
 * Read response (device side, simulator and tests).
 * @param {number} address response address
 * @param {ArrayLike<number>} registers u16 values
 */
export function encodeModbusReadResponse(address, registers) {
  const bytes = [address, MODBUS.READ, (2 * registers.length) & 0xff];
  for (let i = 0; i < registers.length; i++) bytes.push((registers[i] >> 8) & 0xff, registers[i] & 0xff);
  return withCrc(bytes);
}

/**
 * Response to 0x06 (echo) or 0x10 (`addr 10 start count`), device side.
 * @param {number} address response address
 * @param {number} func 0x06 or 0x10
 * @param {number} register
 * @param {number} word value (0x06) or register count (0x10)
 */
export const encodeModbusWriteResponse = (address, func, register, word) =>
  withCrc([address, func, register >> 8, register & 0xff, (word >> 8) & 0xff, word & 0xff]);

// ---------------------------------------------------------------------------------------------
// DALY_MODBUS framing (spec 3.3)
// ---------------------------------------------------------------------------------------------

/**
 * Length of a Modbus response at the start of `buf`: 0x03 -> 5 + byte count, 0x06 and 0x10 -> 8,
 * exceptions -> 5, other functions -> -1. With `expectedByteCount` a 0x03 header with another
 * byte count is rejected, so the tail of a cut-off reply is never taken for a new header
 * (spec 3.3 step 4).
 * @param {Uint8Array} buf
 * @param {number} [expectedByteCount]
 */
export function modbusResponseLength(buf, expectedByteCount) {
  if (buf.length < 2) return 0;
  const fn = buf[1];
  if (fn === MODBUS.READ) {
    if (buf.length < 3) return 0;
    if (buf[2] === 0) return -1;
    if (expectedByteCount !== undefined && buf[2] !== expectedByteCount) return -1;
    return 5 + buf[2];
  }
  if (fn === MODBUS.WRITE || fn === MODBUS.WRITE_MULTI) return 8;
  if (fn & 0x80) return 5;
  return -1;
}

/**
 * Length of a Modbus request (device side): 0x03 and 0x06 are 8 bytes, 0x10 carries 2 x count
 * data bytes without a byte count.
 * @param {Uint8Array} buf
 */
export function modbusRequestLength(buf) {
  if (buf.length < 2) return 0;
  const fn = buf[1];
  if (fn === MODBUS.READ || fn === MODBUS.WRITE) return 8;
  if (fn === MODBUS.WRITE_MULTI) {
    if (buf.length < 6) return 0;
    const count = u16be(buf, 4);
    return count >= 1 && count <= 123 ? 8 + 2 * count : -1;
  }
  return -1;
}

/**
 * Frame assembler for Modbus responses (host side). `addresses` are the response addresses to
 * sync on (0xD2 and `0x50 + board`); anything else, including AT text of the BLE module, is
 * skipped. Several replies in one notification are split; a bad CRC drops one byte.
 * @param {{
 *   onFrame: (frame: Uint8Array) => void,
 *   onDiscard?: (bytes: Uint8Array, reason: string) => void,
 *   addresses: number[],
 *   expectedByteCount?: () => number | undefined,
 * }} opts
 */
export function createModbusAssembler({ onFrame, onDiscard, addresses, expectedByteCount }) {
  return new FrameAssembler({
    sync: addresses.map((a) => [a]),
    length: (buf) => modbusResponseLength(buf, expectedByteCount?.()),
    validate: modbusCrcOk,
    onFrame,
    onDiscard,
    maxLength: MODBUS_MAX_FRAME,
    staleMs: 1000,
  });
}

/**
 * Frame assembler for Modbus requests (device side of the simulator).
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void, addresses: number[] }} opts
 */
export function createModbusRequestAssembler({ onFrame, onDiscard, addresses }) {
  return new FrameAssembler({
    sync: addresses.map((a) => [a]),
    length: modbusRequestLength,
    validate: modbusCrcOk,
    onFrame,
    onDiscard,
    maxLength: 8 + 2 * 123,
    staleMs: 1000,
  });
}

// ---------------------------------------------------------------------------------------------
// DALY_MODBUS generic parsers
// ---------------------------------------------------------------------------------------------

/**
 * Parse a Modbus request (host to device).
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export function parseModbusRequest(frame) {
  const address = frame[0];
  const fn = frame[1];
  /** @type {Record<string, any>} */
  const out = { address, function: fn, crcValid: modbusCrcOk(frame) };
  if (address > MODBUS.REQUEST_OFFSET && address <= MODBUS.REQUEST_OFFSET + 0x0f) out.board = address - MODBUS.REQUEST_OFFSET;
  if (fn === MODBUS.READ) {
    out.start = u16be(frame, 2);
    out.count = u16be(frame, 4);
  } else if (fn === MODBUS.WRITE) {
    out.register = u16be(frame, 2);
    out.value = u16be(frame, 4);
  } else if (fn === MODBUS.WRITE_MULTI) {
    out.register = u16be(frame, 2);
    out.count = u16be(frame, 4);
    const values = [];
    for (let i = 0; i < out.count && 6 + 2 * i + 1 < frame.length - 2; i++) values.push(u16be(frame, 6 + 2 * i));
    out.values = values;
    // Clock write of the official app (snoop, unverified on BMS firmware, spec 5.4).
    if (out.register === 0x00d4 && out.count === 3) out.rtc = rtcText(frame, 6);
  }
  return out;
}

/**
 * @typedef {Record<string, any> & { address: number, function: number, crcValid: boolean, registers?: number[] }} ModbusResponse
 */

/**
 * Parse a Modbus response (device to host). Read responses do not carry the start register; use
 * the block parsers below with the start register of the request.
 * @param {Uint8Array} frame
 * @returns {ModbusResponse}
 */
export function parseModbusResponse(frame) {
  const address = frame[0];
  const fn = frame[1];
  /** @type {ModbusResponse} */
  const out = { address, function: fn, crcValid: modbusCrcOk(frame) };
  if (address > MODBUS.RESPONSE_OFFSET && address <= MODBUS.RESPONSE_OFFSET + 0x0f) out.board = address - MODBUS.RESPONSE_OFFSET;
  if (fn === MODBUS.READ) {
    const n = frame[2];
    out.byteCount = n;
    out.registerCount = n >> 1;
    const end = Math.min(3 + n, frame.length - 2);
    const regs = [];
    for (let o = 3; o + 1 < end; o += 2) regs.push(u16be(frame, o));
    out.registers = regs;
    if (regs.length === 1) out.value = regs[0];
  } else if (fn === MODBUS.WRITE) {
    out.register = u16be(frame, 2);
    out.value = u16be(frame, 4);
  } else if (fn === MODBUS.WRITE_MULTI) {
    out.register = u16be(frame, 2);
    out.count = u16be(frame, 4);
    // The 0x81 map answer to the app's probe carries 0xAAAA here (spec 4.3).
    out.word = out.count;
  } else if (fn & 0x80) {
    out.exceptionCode = frame[2];
  }
  return out;
}

/**
 * Register values of a 0x03 response.
 * @param {Uint8Array} frame
 * @returns {number[]}
 */
export function modbusRegisters(frame) {
  const n = frame[2];
  const regs = [];
  for (let i = 0; i + 1 < n; i += 2) regs.push(u16be(frame, 3 + i));
  return regs;
}

/**
 * Data bytes of a 0x03 response.
 * @param {Uint8Array} frame
 */
export const modbusData = (frame) => frame.subarray(3, 3 + frame[2]);

// ---------------------------------------------------------------------------------------------
// Modbus D2 register map (spec 6.3)
// ---------------------------------------------------------------------------------------------

/** D2 register blocks read by the driver (spec 4.3, 5.4). */
export const D2 = Object.freeze({
  STATUS: { start: 0x0000, count: 62 },
  STATUS_80: { start: 0x0000, count: 80 },
  MOS_INFO: { start: 0x003e, count: 9 },
  SETTINGS: { start: 0x0080, count: 41 },
  VERSION: { start: 0x00a9, count: 32 },
  PASSWORD: { start: 0x00c9, count: 3 },
  PRODUCTION_DATE: { start: 0x00cc, count: 2 },
  BALANCER: { start: 0x00cf, count: 1 },
});

/** D2 command registers (spec 5.4, 8). */
export const D2_REG = Object.freeze({
  CHARGE_MOS: 0x00a5,
  DISCHARGE_MOS: 0x00a6,
  SOC: 0x00a7,
  BALANCER: 0x00cf,
  RESTART: 0x00f0,
  SHUTDOWN: 0x00f1,
  CURRENT_ZERO: 0x00f2,
  RESET: 0x00f3,
});

/** D2 battery types (register 0x0089, vendor list). */
export const D2_BATTERY_TYPES = Object.freeze({
  0: msg('LiFePO4'),
  1: msg('Ternary lithium (NMC)'),
  2: msg('Lithium titanate (LTO)'),
});

/** MOSFET temperature registers report 0x0000 or 0xFFFF when not available (spec 12.1 item 14). @param {number} raw */
const d2OptionalTemp = (raw) => (raw === 0 || raw === 0xffff ? null : raw - 40);

/**
 * D2 fault registers 0x003A..0x003D (8 wire bytes) in classic byte order: the wire carries classic
 * bytes `1 0 3 2 5 4 7 6` (spec 9.2), so classic byte 6 (current and voltage module, short circuit,
 * low voltage no charge, soft switch, cabinet) is the low byte of 0x003D, the last wire byte.
 * Classic byte 7 (high byte of 0x003D) has no documented meaning on D2; `failureAlarms` ignores it.
 * @param {ArrayLike<number>} wire
 */
export function d2FaultBytes(wire) {
  return [wire[1], wire[0], wire[3], wire[2], wire[5], wire[4], wire[7], wire[6]];
}

/**
 * D2 status block (read from 0x0000, 62 or 80 registers), spec 6.3.
 * @param {Uint8Array} frame
 */
export function parseD2Status(frame) {
  const regs = modbusRegisters(frame);
  if (regs.length < 62) throw new Error('Not a D2 status frame');
  const cellCount = Math.min(regs[0x31], 32);
  const temperatureSensorCount = Math.min(regs[0x32], 8);
  const alarmBytes = frame.subarray(3 + 2 * 0x3a, 3 + 2 * 0x3e);
  /** @type {Record<string, any>} */
  const out = {
    registerCount: regs.length,
    cellVoltages: regs.slice(0, cellCount).map((v) => v / 1000),
    temperatures: regs.slice(0x20, 0x20 + temperatureSensorCount).map((v) => v - 40),
    totalVoltage: regs[0x28] / 10,
    current: r((regs[0x29] - 30000) / 10, 1),
    soc: regs[0x2a] / 10,
    maxCellVoltage: regs[0x2b] / 1000,
    minCellVoltage: regs[0x2c] / 1000,
    maxTemperature: regs[0x2d] - 40,
    minTemperature: regs[0x2e] - 40,
    chargeDischargeState: regs[0x2f],
    remainingCapacity: regs[0x30] / 10,
    cellCount,
    temperatureSensorCount,
    cycles: regs[0x33],
    balancerState: regs[0x34],
    chargeMos: regs[0x35] !== 0,
    dischargeMos: regs[0x36] !== 0,
    averageCellVoltage: regs[0x37] / 1000,
    deltaCellVoltage: regs[0x38] / 1000,
    power: regs[0x39],
    alarmRegisters: hex(alarmBytes),
    faultBytes: d2FaultBytes(alarmBytes),
  };
  if (regs.length >= 0x44) {
    // Newer firmware (80 register read): balance current and MOSFET temperature (spec 6.3, 12.1
    // item 14). 0x003E/0x003F (mileage or balancing bits) and 0x0043 (board temperature) are
    // unverified and not decoded.
    out.balanceCurrent = r((regs[0x40] - 30000) / 1000, 3);
    out.mosTemperature = d2OptionalTemp(regs[0x42]);
  }
  return out;
}

/**
 * D2 MOSFET temperature block (9 registers from 0x003E, aiobmsble `MOS_INFO`).
 * @param {Uint8Array} frame
 */
export function parseD2MosInfo(frame) {
  const regs = modbusRegisters(frame);
  if (regs.length < 5) throw new Error('Not a D2 MOSFET block');
  return { balanceCurrent: r((regs[2] - 30000) / 1000, 3), mosTemperature: d2OptionalTemp(regs[4]) };
}

/**
 * D2 settings block (41 registers from 0x0080). Values in the register units of the vendor list
 * (mV registers stay mV), field names as in the test vectors.
 * @param {Uint8Array} frame
 */
export function parseD2Settings(frame) {
  const g = modbusRegisters(frame);
  if (g.length < 41) throw new Error('Not a D2 settings frame');
  const amps = (/** @type {number} */ raw) => (raw - 30000) / 10;
  return {
    ratedCapacity: g[0] / 10,
    cellReferenceVoltage: g[1],
    acquisitionBoards: g[2],
    board1Cells: g[3],
    board2Cells: g[4],
    board3Cells: g[5],
    board1Ntc: g[6],
    board2Ntc: g[7],
    board3Ntc: g[8],
    batteryType: g[9],
    sleepWaitTime: g[10],
    cellOvL1: g[11],
    cellOvL2: g[12],
    cellUvL1: g[13],
    cellUvL2: g[14],
    packOvL1: g[15] / 10,
    packOvL2: g[16] / 10,
    packUvL1: g[17] / 10,
    packUvL2: g[18] / 10,
    chargeOcL1: amps(g[19]),
    chargeOcL2: amps(g[20]),
    dischargeOcL1: amps(g[21]),
    dischargeOcL2: amps(g[22]),
    chargeOtL1: g[23] - 40,
    chargeOtL2: g[24] - 40,
    chargeUtL1: g[25] - 40,
    chargeUtL2: g[26] - 40,
    dischargeOtL1: g[27] - 40,
    dischargeOtL2: g[28] - 40,
    dischargeUtL1: g[29] - 40,
    dischargeUtL2: g[30] - 40,
    cellDiffL1: g[31],
    cellDiffL2: g[32],
    tempDiffL1: g[33],
    tempDiffL2: g[34],
    balanceStartVoltage: g[35],
    balanceDiffVoltage: g[36],
    chargeMosSwitch: g[37],
    dischargeMosSwitch: g[38],
    socSetting: g[39] / 10,
    mosOtAlarm: g[40] - 40,
  };
}

/**
 * D2 version block (32 registers from 0x00A9): 16 + 16 + 32 bytes (spec 10.2, 12.1 item 2).
 * @param {Uint8Array} frame
 */
export function parseD2Version(frame) {
  const d = modbusData(frame);
  return { softwareVersion: asciiField(d, 0, 16), hardwareVersion: asciiField(d, 16, 16), machineCode: asciiField(d, 32, 32) };
}

/**
 * D2 parameter password (3 registers from 0x00C9, 6 ASCII).
 * @param {Uint8Array} frame
 */
export const parseD2Password = (frame) => ({ password: asciiField(modbusData(frame), 0, 6) });

/**
 * D2 production date (2 registers from 0x00CC): `YY MM DD 00`.
 * @param {Uint8Array} frame
 */
export function parseD2ProductionDate(frame) {
  const d = modbusData(frame);
  return { productionDate: ymd(2000 + d[0], d[1], d[2]) };
}

/**
 * Balancer switch register 0x00CF (Daly active balancers: 0 off, 1 on). On BMS boards the vendor
 * list places the cloud server address here, so other values mean "no balancer switch".
 * @param {Uint8Array} frame
 */
export const parseD2BalancerSwitch = (frame) => ({ balancerSwitch: modbusRegisters(frame)[0] });

// ---------------------------------------------------------------------------------------------
// Modbus 0x81 register map (spec 6.4)
// ---------------------------------------------------------------------------------------------

/** 0x81 map register blocks (spec 4.4, 5.5). */
export const P81 = Object.freeze({
  REALTIME_1: { start: 0x0000, count: 64 },
  REALTIME_2: { start: 0x0041, count: 62 },
  LIMITS: { start: 0x00a4, count: 10 },
  BALANCER: { start: 0x00cf, count: 1 },
  SETTINGS_1: { start: 0x0100, count: 81 },
  SETTINGS_2: { start: 0x0151, count: 39 },
  VERSION: { start: 0x0178, count: 74 },
  SETTINGS_3: { start: 0x01c3, count: 80 },
});

/** 0x81 map command registers confirmed by patagonaa (spec 5.5). */
export const P81_REG = Object.freeze({
  SLEEP: 0x0115,
  SOC: 0x0116,
  CHARGE_MOS: 0x0121,
  DISCHARGE_MOS: 0x0122,
  FORCE_HEATER: 0x01f7,
  FORCE_FAN: 0x01f8,
});

/** 0x81 temperatures: 0x00FF means "not available" (spec 6.4). @param {number} raw */
const p81Temp = (raw) => (raw === 0x00ff || raw === 0xffff ? null : raw - 40);

/**
 * 0x81 realtime block 1 (64 or 65 registers from 0x0000).
 * @param {Uint8Array} frame
 */
export function parseP81Realtime1(frame) {
  const g = modbusRegisters(frame);
  if (g.length < 64) throw new Error('Not a 0x81 realtime block 1');
  const cellCount = Math.min(g[0x3c], 48);
  const temperatureSensorCount = Math.min(g[0x3d], 8);
  /** @type {Record<string, any>} */
  const out = {
    registerCount: g.length,
    cellVoltages: g.slice(0, cellCount).map((v) => v / 1000),
    temperatures: g.slice(0x30, 0x30 + temperatureSensorCount).map(p81Temp),
    totalVoltage: g[0x38] / 10,
    current: r((g[0x39] - 30000) / 10, 1),
    soc: g[0x3a] / 10,
    // 0x003B: SOH (patagonaa header) or heartbeat counter (syssi); treated as a counter (spec 12.1 item 10).
    heartbeat: g[0x3b],
    cellCount,
    temperatureSensorCount,
    maxCellVoltage: g[0x3e] / 1000,
    maxCellIndex: g[0x3f],
  };
  if (g.length > 0x40) out.minCellVoltage = g[0x40] / 1000;
  return out;
}

/**
 * 0x81 realtime block 2 (62 registers from 0x0041). Index i is register 0x41 + i.
 * @param {Uint8Array} frame
 */
export function parseP81Realtime2(frame) {
  const g = modbusRegisters(frame);
  if (g.length < 51) throw new Error('Not a 0x81 realtime block 2');
  const d = modbusData(frame);
  const at = (/** @type {number} */ reg) => 2 * (reg - 0x41);
  const balanceCurrentRaw = g[0x4e - 0x41];
  return {
    registerCount: g.length,
    minCellIndex: g[0],
    deltaCellVoltage: g[1] / 1000,
    maxTemperature: p81Temp(g[2]),
    maxTemperatureProbe: g[3],
    minTemperature: p81Temp(g[4]),
    minTemperatureProbe: g[5],
    temperatureDiff: g[6],
    chargeDischargeState: g[7],
    remainingCapacity: g[0x4b - 0x41] / 10,
    cycles: g[0x4c - 0x41],
    balanceState: g[0x4d - 0x41],
    balanceCurrentRaw,
    // Raw 0 is reported by packs without a balance current sensor (spec 6.4).
    balanceCurrent: balanceCurrentRaw === 0 ? null : r((balanceCurrentRaw - 30000) / 1000, 3),
    balanceBits: hex(d.subarray(at(0x4f), at(0x52))),
    balancing: p81BalancingFlags(g.slice(0x4f - 0x41, 0x52 - 0x41)),
    chargeMos: g[0x52 - 0x41] !== 0,
    dischargeMos: g[0x53 - 0x41] !== 0,
    prechargeMos: g[0x54 - 0x41] !== 0,
    heaterMos: g[0x55 - 0x41] !== 0,
    fanMos: g[0x56 - 0x41] !== 0,
    averageCellVoltage: g[0x57 - 0x41] / 1000,
    power: g[0x58 - 0x41],
    // Unit unverified (spec 6.4).
    energyRaw: g[0x59 - 0x41],
    mosTemperature: p81Temp(g[0x5a - 0x41]),
    boardTemperature: p81Temp(g[0x5b - 0x41]),
    heaterTemperature: p81Temp(g[0x5c - 0x41]),
    // Date and time, unverified (spec 6.4).
    rtc: rtcText(d, at(0x61)),
    type1Errors: hex(d.subarray(at(0x66), at(0x6a))),
    type2Errors: hex(d.subarray(at(0x6d), at(0x74))),
    type2Bytes: Array.from(d.subarray(at(0x6d), at(0x74))),
  };
}

/**
 * 0x81 balancing bits: registers 0x004F..0x0051, bit i of group g = cell 16 g + i + 1 (patagonaa).
 * @param {number[]} words
 */
function p81BalancingFlags(words) {
  const flags = [];
  for (const w of words) for (let i = 0; i < 16; i++) flags.push(((w >> i) & 1) === 1);
  return flags;
}

/**
 * 0x81 version block (74 registers from 0x0178): 14 byte ASCII fields read by position (spec
 * 10.3). Field names other than the battery code are unverified.
 * @param {Uint8Array} frame
 */
export function parseP81Version(frame) {
  const d = modbusData(frame);
  const field = (/** @type {number} */ k) => asciiField(d, 14 * k, 14);
  return {
    field0: field(0),
    field1: field(1),
    field2: field(2),
    field3: field(3),
    field4: field(4),
    field5: field(5),
    softwareVersion: field(0),
    hardwareVersion: field(1),
    model: field(2),
    serialNumber: field(3),
    batteryCode: asciiField(d, 70, 32),
  };
}

/**
 * 0x81 register 0x00A4 block (10 registers): allowed charge and discharge current at 0x00A6 and
 * 0x00A7, 0.1 A (Sundaya); the other registers are unknown.
 * @param {Uint8Array} frame
 */
export function parseP81Limits(frame) {
  const g = modbusRegisters(frame);
  return { allowedChargeCurrent: g[2] / 10, allowedDischargeCurrent: g[3] / 10 };
}

/**
 * 0x81 settings block 1 (81 registers from 0x0100): the registers confirmed by patagonaa and the
 * ESS capture. Everything else is decoded through the settings schema.
 * @param {Uint8Array} frame
 */
export function parseP81Settings1(frame) {
  const g = modbusRegisters(frame);
  const d = modbusData(frame);
  return {
    boardNumber: g[0],
    sleepTimeRaw: g[0x15],
    socSetting: g[0x16] / 10,
    sohSetting: g[0x17] / 10,
    chargeMosControl: g[0x21],
    dischargeMosControl: g[0x22],
    password: asciiField(d, 2 * 0x26, 6),
  };
}

/**
 * 0x81 alarm codes 0..13 (registers 0x006D..0x0073, spec 9.3): code 2k is the LOW byte of register
 * 0x006D + k, code 2k + 1 the high byte. Level fields are 3 bit numbers (1 = level 1 warning,
 * 2 = level 2 protection).
 * @param {ArrayLike<number>} wire 14 bytes as received
 * @returns {AlarmState[]}
 */
export function p81Alarms(wire) {
  const code = (/** @type {number} */ c) => (c & 1 ? wire[c - 1] : wire[c + 1]) ?? 0;
  /** @type {AlarmState[]} */
  const out = [];
  /**
   * @param {number} c
   * @param {number} shift
   * @param {string} id
   * @param {string} [label]
   */
  const level = (c, shift, id, label) => {
    const v = (code(c) >> shift) & 7;
    if (v > 0) out.push(alarm(id, { severity: v >= 2 ? 'protection' : 'warning', label, source: `code ${c} bits ${shift}-${shift + 2} = ${v}` }));
  };
  /**
   * @param {number} c
   * @param {number} bit
   * @param {string} id
   * @param {Partial<AlarmState>} [extra]
   */
  const flag = (c, bit, id, extra = {}) => {
    if ((code(c) >> bit) & 1) out.push(alarm(id, { ...extra, source: `code ${c} bit ${bit}` }));
  };
  level(0, 0, 'cell_overvoltage');
  level(0, 3, 'cell_undervoltage');
  flag(0, 7, 'daly.smart_charger_error', { severity: 'warning', label: msg('Smart charger connection error') });
  level(1, 0, 'cell_voltage_difference');
  level(1, 3, 'charge_overtemperature');
  flag(1, 7, 'daly.smart_discharger_error', { severity: 'warning', label: msg('Smart discharger connection error') });
  level(2, 0, 'charge_undertemperature');
  level(2, 3, 'discharge_overtemperature');
  flag(2, 6, 'mos_overtemperature');
  flag(2, 7, 'temperature_sensor_fault');
  level(3, 0, 'discharge_undertemperature');
  level(3, 3, 'temperature_difference');
  flag(3, 6, 'mos_overtemperature');
  flag(3, 7, 'temperature_sensor_fault');
  level(4, 0, 'pack_overvoltage');
  level(4, 3, 'pack_undervoltage');
  flag(4, 6, 'short_circuit');
  level(5, 0, 'charge_overcurrent');
  level(5, 3, 'discharge_overcurrent');
  flag(5, 6, 'daly.charge_undervoltage_error', { severity: 'warning', label: msg('Charge undervoltage error') });
  flag(5, 7, 'daly.discharge_overvoltage_error', { severity: 'warning', label: msg('Discharge overvoltage error') });
  level(6, 0, 'soc_low');
  level(6, 3, 'daly.soh_low', msg('State of health too low'));
  // Code 6 bits 6..7 (parallel communication) are set on a single ESS pack; meaning unverified
  // (spec 9.3), so they are not reported.
  level(7, 0, 'mos_overtemperature');
  level(7, 3, 'daly.thermal_runaway', msg('Thermal runaway'));
  flag(11, 0, 'afe_fault');
  flag(11, 1, 'afe_fault');
  flag(11, 2, 'afe_fault');
  flag(11, 3, 'voltage_sensor_fault');
  flag(11, 4, 'cell_wire_open');
  flag(11, 5, 'voltage_sensor_fault');
  flag(11, 6, 'current_sensor_fault');
  flag(11, 7, 'temperature_sensor_fault');
  flag(12, 0, 'temperature_sensor_fault');
  flag(12, 1, 'eeprom_fault');
  flag(12, 2, 'daly.flash_fault', { severity: 'fault', label: msg('Flash memory fault') });
  flag(12, 3, 'rtc_fault');
  flag(12, 4, 'charge_mos_fault');
  flag(12, 5, 'discharge_mos_fault');
  flag(12, 6, 'precharge_fault');
  flag(12, 7, 'precharge_fault');
  flag(13, 0, 'daly.charge_off_bus', { severity: 'info', label: msg('Charge MOSFET switched off by the bus') });
  flag(13, 1, 'daly.discharge_off_bus', { severity: 'info', label: msg('Discharge MOSFET switched off by the bus') });
  flag(13, 2, 'daly.charge_off_switch', { severity: 'info', label: msg('Charge MOSFET switched off by the switch input') });
  flag(13, 3, 'daly.discharge_off_switch', { severity: 'info', label: msg('Discharge MOSFET switched off by the switch input') });
  flag(13, 6, 'daly.current_limit', { severity: 'info', label: msg('Current limit active') });
  flag(13, 7, 'heater_fault');
  return mostSevere(out);
}

// ---------------------------------------------------------------------------------------------
// Protocol log descriptions
// ---------------------------------------------------------------------------------------------

/** @type {Record<number, string>} */
const D2_BLOCK_NAMES = {
  0x0000: 'status',
  0x003e: 'MOSFET temperature block',
  0x0057: 'GPS block',
  0x0080: 'settings',
  0x00a9: 'version',
  0x00c9: 'password',
  0x00cc: 'production date',
  0x00cf: 'balancer switch',
};

/** @type {Record<number, string>} */
const P81_BLOCK_NAMES = {
  0x0000: 'realtime block 1',
  0x0041: 'realtime block 2',
  0x00a4: 'allowed currents block',
  0x00cf: 'balancer switch',
  0x00e0: 'cumulative energy',
  0x0100: 'settings block 1',
  0x0151: 'settings block 2',
  0x0178: 'version',
  0x019b: 'battery code',
  0x01c3: 'settings block 3',
  0x0220: 'settings block 4',
  0x024b: 'settings block 5',
};

/** @type {Record<number, string>} */
const REGISTER_NAMES = {
  0x00a5: 'charge MOSFET',
  0x00a6: 'discharge MOSFET',
  0x00a7: 'SOC',
  0x00cf: 'balancer switch',
  0x00f0: 'restart',
  0x00f1: 'shutdown',
  0x00f2: 'zero current',
  0x00f3: 'reset',
  0x0115: 'sleep time',
  0x0116: 'SOC',
  0x0121: 'charge MOSFET',
  0x0122: 'discharge MOSFET',
  0x01f7: 'force heater',
  0x01f8: 'force fan',
};

/**
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode?: () => any }}
 */
function describeClassic(frame) {
  const command = frame[2];
  const decode = () => {
    const { data: _data, ...rest } = parseClassic(frame);
    return rest;
  };
  const reply = isClassicBoardAddress(frame[1]);
  if (command >= 0x10 && command <= 0x20) {
    const base = CLASSIC_NAMES[/** @type {keyof typeof CLASSIC_NAMES} */ (command + WRITE_OFFSET)] ?? 'group';
    return { name: reply ? `Write acknowledgement (${h2(command)})` : `Write ${base.toLowerCase()} (${h2(command)})`, decode };
  }
  const base = CLASSIC_NAMES[/** @type {keyof typeof CLASSIC_NAMES} */ (command)] ?? 'Unknown command';
  return { name: `${base} (${h2(command)})${reply ? '' : ' request'}`, decode };
}

/**
 * @param {Uint8Array} frame
 * @param {{ direction?: 'tx'|'rx', start?: number }} ctx
 * @returns {{ name: string, decode?: () => any }}
 */
function describeModbus(frame, ctx) {
  const address = frame[0];
  const fn = frame[1];
  const d2 = address === MODBUS.D2;
  const names = d2 ? D2_BLOCK_NAMES : P81_BLOCK_NAMES;
  const map = d2 ? 'D2' : '0x81 map';
  if (ctx.direction === 'tx') {
    const req = parseModbusRequest(frame);
    if (fn === MODBUS.READ) return { name: `Modbus ${map} read ${names[req.start] ?? h4(req.start)} (${req.count} registers)`, decode: () => req };
    if (fn === MODBUS.WRITE) return { name: `Modbus ${map} write ${REGISTER_NAMES[req.register] ?? h4(req.register)} = ${req.value}`, decode: () => req };
    if (fn === MODBUS.WRITE_MULTI) return { name: `Modbus ${map} write ${req.count} registers from ${h4(req.register)}`, decode: () => req };
    return { name: `Modbus ${map} request (${h2(fn)})`, decode: () => req };
  }
  const start = ctx.start;
  if (fn === MODBUS.READ) {
    const label = start !== undefined ? (names[start] ?? h4(start)) : 'registers';
    return { name: `Modbus ${map} ${label} (${frame[2] >> 1} registers)`, decode: () => decodeModbusResponse(frame, start) };
  }
  if (fn === MODBUS.WRITE) return { name: `Modbus ${map} write echo`, decode: () => parseModbusResponse(frame) };
  if (fn === MODBUS.WRITE_MULTI) return { name: `Modbus ${map} write multiple answer`, decode: () => parseModbusResponse(frame) };
  if (fn & 0x80) return { name: `Modbus ${map} exception (${h2(fn)})`, decode: () => parseModbusResponse(frame) };
  return { name: `Modbus ${map} frame (${h2(fn)})`, decode: () => parseModbusResponse(frame) };
}

/**
 * Decode a read response with the start register of its request (the response does not carry it).
 * @param {Uint8Array} frame
 * @param {number} [start]
 */
export function decodeModbusResponse(frame, start) {
  const base = parseModbusResponse(frame);
  try {
    if (frame[0] === MODBUS.D2) {
      if (start === D2.STATUS.start && base.registerCount >= 62) return { ...base, ...omitBytes(parseD2Status(frame)) };
      if (start === D2.MOS_INFO.start) return { ...base, ...parseD2MosInfo(frame) };
      if (start === D2.SETTINGS.start) return { ...base, ...parseD2Settings(frame) };
      if (start === D2.VERSION.start) return { ...base, ...parseD2Version(frame) };
      if (start === D2.PASSWORD.start) return { ...base, ...parseD2Password(frame) };
      if (start === D2.PRODUCTION_DATE.start) return { ...base, ...parseD2ProductionDate(frame) };
      if (start === D2.BALANCER.start && base.registerCount === 1) return { ...base, ...parseD2BalancerSwitch(frame) };
    } else {
      if (start === P81.REALTIME_1.start && base.registerCount >= 64) return { ...base, ...parseP81Realtime1(frame) };
      if (start === P81.REALTIME_2.start) return { ...base, ...omitBytes(parseP81Realtime2(frame)) };
      if (start === P81.VERSION.start) return { ...base, ...parseP81Version(frame) };
      if (start === P81.LIMITS.start) return { ...base, ...parseP81Limits(frame) };
      if (start === P81.SETTINGS_1.start) return { ...base, ...parseP81Settings1(frame) };
    }
  } catch {
    /* fall back to the raw registers */
  }
  return base;
}

/** @param {Record<string, any>} o */
function omitBytes(o) {
  const { faultBytes: _f, type2Bytes: _t, ...rest } = o;
  return rest;
}

/**
 * Name and lazy decoder of a frame for the protocol log. Classic frames tell their direction by
 * the address byte; Modbus frames need `direction` (D2 requests and responses share the address)
 * and, for read responses, the start register of the request.
 * @param {Uint8Array} frame
 * @param {{ direction?: 'tx'|'rx', start?: number }} [ctx]
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describe(frame, ctx = {}) {
  if (!frame || frame.length < 2) return null;
  if (frame[0] === CLASSIC_START && frame.length === CLASSIC_LENGTH) return describeClassic(frame);
  if (frame.length >= 5) return describeModbus(frame, ctx);
  return null;
}
