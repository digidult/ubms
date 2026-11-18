import {
  FrameAssembler,
  sum8,
  sum16,
  crc16Modbus,
  hex,
  ascii,
  asciiBytes,
  indexOf,
  u16le,
  i16le,
  u32le,
  i32le,
  u16be,
  i16be,
  u32be,
  setU16le,
  setU32le,
  setU16be,
  setU32be,
} from '@ubms/transport';
import { msg } from '@ubms/bms-core';
import { r } from '../common/util.js';

/**
 * JK BMS (Jikong) protocols, pure functions without I/O. Specification: docs/protocols/jk.md.
 *
 * - JK02 and JK04 over BLE (spec 3.1 to 3.4): 20 byte commands `AA 55 90 EB <reg> <len> <value>
 *   <sum8>` and 300 byte data frames `55 AA EB 90 <type> <counter> <payload> <sum8>`, little
 *   endian. JK02 has two layouts (JK02_24S, JK02_32S); JK04 is the old balancer protocol with
 *   float32 values.
 * - JK-PB over RS485 (spec 3.6): Modbus RTU FC 0x10 "trigger" writes that the BMS answers with a
 *   300 byte JK02_32S frame followed by the normal 8 byte FC 0x10 answer; settings writes are
 *   FC 0x10 at byte addresses, big endian.
 * - JK-B UART "4E 57" (spec 3.5, 6.6): big endian TLV frames.
 *
 * Parsers return plain objects whose field names match the test vectors
 * (packages/bms-drivers/test/vectors/jk.json). Values are engineering units (V, A, Ah, degrees C,
 * s, ohm). JK reports current POSITIVE WHILE CHARGING (spec 6.1, 12 item 10), like the unified
 * model.
 */

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Data frame header (BMS to host), spec 3.2. */
export const DATA_HEADER = Object.freeze([0x55, 0xaa, 0xeb, 0x90]);
/** Command frame header (host to BMS, also the ACK frame), spec 3.1. */
export const COMMAND_HEADER = Object.freeze([0xaa, 0x55, 0x90, 0xeb]);
export const DATA_FRAME_LENGTH = 300;
export const COMMAND_FRAME_LENGTH = 20;

/** Data frame types (byte 4), spec 3.2. */
export const FRAME_TYPE = Object.freeze({ SETTINGS: 0x01, CELL_INFO: 0x02, DEVICE_INFO: 0x03, EVENT_LOG: 0x05 });
const DATA_FRAME_TYPES = Object.freeze([0x01, 0x02, 0x03, 0x05]);

/** BLE requests and buttons (spec 5.1, 8.2). Buttons other than the requests are JK02_32S only. */
export const CMD = Object.freeze({
  SETTINGS: 0x96,
  DEVICE_INFO: 0x97,
  EVENT_LOG: 0xa1,
  SHUTDOWN: 0x65,
  RESTART: 0x66,
  FACTORY_RESET: 0x9d,
  PRESET_LIION: 0x68,
  PRESET_LFP: 0x69,
  PRESET_LTO: 0x6a,
  EMERGENCY: 0x6b,
  SOC_CALIBRATION: 0x6e,
  ACK: 0xc8,
});

/** Protocol variants. */
export const VARIANT = Object.freeze({
  JK02_24S: 'JK02_24S',
  JK02_32S: 'JK02_32S',
  JK04: 'JK04',
  UART: 'JK_UART_4E57',
});

/** Raw temperature that marks an absent sensor (spec 9.4). */
export const ABSENT_TEMPERATURE_RAW = -2000;

// ---------------------------------------------------------------------------------------------
// Small byte helpers
// ---------------------------------------------------------------------------------------------

const F32 = new DataView(new ArrayBuffer(4));

/**
 * IEEE 754 float32, little endian.
 * @param {Uint8Array} b
 * @param {number} o
 */
export function f32le(b, o) {
  for (let i = 0; i < 4; i++) F32.setUint8(i, b[o + i]);
  return F32.getFloat32(0, true);
}

/**
 * Bytes of a float32, little endian.
 * @param {number} v
 * @returns {number[]}
 */
export function f32leBytes(v) {
  F32.setFloat32(0, v, true);
  return [F32.getUint8(0), F32.getUint8(1), F32.getUint8(2), F32.getUint8(3)];
}

/**
 * Two's complement little endian integer of 1, 2 or 4 bytes.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} length
 */
export function readIntLe(b, o, length) {
  if (length === 1) return (b[o] << 24) >> 24;
  if (length === 2) return i16le(b, o);
  if (length === 4) return i32le(b, o);
  throw new RangeError(`Unsupported integer length ${length}`);
}

/**
 * Two's complement little endian bytes of an integer (lengths 1, 2, 4).
 * @param {number} raw
 * @param {number} length
 */
export function intLeBytes(raw, length) {
  const span = 2 ** (8 * length);
  if (!Number.isInteger(raw) || raw < -span / 2 || raw >= span) throw new RangeError(`Value ${raw} does not fit into ${length} byte(s)`);
  let x = raw < 0 ? raw + span : raw;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return out;
}

/** @param {number} v */
function popcount(v) {
  let n = 0;
  for (let x = v >>> 0; x; x >>>= 1) n += x & 1;
  return n;
}

/** Decimals that represent a scale exactly (0.001 -> 3). @param {number} scale */
const decimalsOf = (scale) => (scale >= 1 ? 0 : Math.round(-Math.log10(scale)));

/** Avoid -0 in results. @param {number} v */
const z = (v) => (v === 0 ? 0 : v);

/**
 * @typedef {'u8'|'i8'|'u16'|'i16'|'u32'|'i32'|'f32'|'bool8'|'bool32'|'temp'} FieldType
 * @typedef {{ name: string, offset: number, type: FieldType, scale?: number }} FieldSpec
 */

/**
 * Read one little endian field of a 300 byte frame in engineering units.
 * @param {Uint8Array} frame
 * @param {FieldSpec} spec
 * @returns {any}
 */
function readField(frame, { offset: o, type, scale = 1 }) {
  /** @type {number} */
  let raw;
  switch (type) {
    case 'bool8':
      return frame[o] !== 0;
    case 'bool32':
      return u32le(frame, o) !== 0;
    case 'f32':
      return z(r(f32le(frame, o), 6));
    case 'temp': {
      const t = i16le(frame, o);
      return t === ABSENT_TEMPERATURE_RAW ? null : z(r(t * 0.1, 1));
    }
    case 'u8':
      raw = frame[o];
      break;
    case 'i8':
      raw = (frame[o] << 24) >> 24;
      break;
    case 'u16':
      raw = u16le(frame, o);
      break;
    case 'i16':
      raw = i16le(frame, o);
      break;
    case 'u32':
      raw = u32le(frame, o);
      break;
    default:
      raw = i32le(frame, o);
  }
  return scale === 1 ? raw : z(r(raw * scale, decimalsOf(scale)));
}

/**
 * Write one little endian field (encoders for the simulator and tests).
 * @param {Uint8Array} frame
 * @param {FieldSpec} spec
 * @param {any} value engineering units; undefined leaves the bytes untouched
 */
function writeField(frame, { offset: o, type, scale = 1 }, value) {
  if (value === undefined) return;
  switch (type) {
    case 'bool8':
      frame[o] = value ? 1 : 0;
      return;
    case 'bool32':
      setU32le(frame, o, value ? 1 : 0);
      return;
    case 'f32':
      frame.set(f32leBytes(value), o);
      return;
    case 'temp':
      setU16le(frame, o, (value === null ? ABSENT_TEMPERATURE_RAW : Math.round(value * 10)) & 0xffff);
      return;
    default:
  }
  const raw = Math.round(value / scale);
  if (type === 'u8' || type === 'i8') frame[o] = raw & 0xff;
  else if (type === 'u16' || type === 'i16') setU16le(frame, o, raw & 0xffff);
  else setU32le(frame, o, raw >>> 0);
}

/**
 * @param {Array<[string, number, FieldType, number?]>} rows name, offset, type, scale
 * @returns {FieldSpec[]}
 */
const specs = (rows) => rows.map(([name, offset, type, scale]) => ({ name, offset, type, ...(scale ? { scale } : {}) }));

// ---------------------------------------------------------------------------------------------
// BLE command frames (spec 3.1, 5.1, 5.2)
// ---------------------------------------------------------------------------------------------

/**
 * 20 byte command frame: header, register, value length, value, zero filler, sum8.
 * @param {number} register
 * @param {ArrayLike<number>} [value]
 * @param {number} [length] value length byte (defaults to the value size)
 */
export function encodeCommand(register, value = [], length = value.length) {
  if (value.length > 13) throw new RangeError('A JK command carries at most 13 value bytes');
  const f = new Uint8Array(COMMAND_FRAME_LENGTH);
  f.set(COMMAND_HEADER, 0);
  f[4] = register & 0xff;
  f[5] = length & 0xff;
  f.set(value, 6);
  f[19] = sum8(f, 0, 19);
  return f;
}

/**
 * JK02 write: raw integer (value / scale), two's complement, little endian (spec 3.1).
 * @param {number} register
 * @param {1|2|4} length
 * @param {number} raw
 */
export const encodeWrite = (register, length, raw) => encodeCommand(register, intLeBytes(raw, length), length);

/**
 * JK04 write: float32 for length 4 (the value itself, no scale), integers for lengths 1 and 2
 * (spec 3.1, [SY] encode_jk04_payload).
 * @param {number} register
 * @param {1|2|4} length
 * @param {number} value
 */
export function encodeJk04Write(register, length, value) {
  if (length === 4) return encodeCommand(register, f32leBytes(value), 4);
  return encodeCommand(register, intLeBytes(Math.round(value), length), length);
}

/**
 * ASCII value of up to 13 bytes (user private data on JK02_24S, spec 5.2).
 * @param {number} register
 * @param {string} text
 */
export function encodeTextWrite(register, text) {
  const bytes = asciiBytes(text, Math.min(13, text.length));
  return encodeCommand(register, bytes, bytes.length);
}

export const deviceInfoRequest = () => encodeCommand(CMD.DEVICE_INFO);
export const settingsRequest = () => encodeCommand(CMD.SETTINGS);
export const eventLogRequest = () => encodeCommand(CMD.EVENT_LOG);
/** The ACK / ready frame the BMS sends after writes (spec 3.3). */
export const ackFrame = () => encodeCommand(CMD.ACK, [1], 1);

/**
 * Decode a 20 byte command or ACK frame.
 * @param {Uint8Array} frame
 */
export function parseCommandFrame(frame) {
  const register = frame[4];
  const length = frame[5];
  const valueBytes = frame.subarray(6, 6 + Math.min(13, length));
  /** @type {{ register: number, length: number, rawValue?: number, ascii?: string, valueHex: string, checksum: number, checksumValid: boolean }} */
  const out = { register, length, valueHex: hex(valueBytes), checksum: frame[19], checksumValid: sum8(frame, 0, 19) === frame[19] };
  if (length === 1 || length === 2 || length === 4) out.rawValue = readIntLe(frame, 6, length);
  else if (length > 4) out.ascii = String.fromCharCode(...valueBytes);
  return out;
}

/** @param {Uint8Array} frame */
export const isCommandFrame = (frame) =>
  frame.length === COMMAND_FRAME_LENGTH && COMMAND_HEADER.every((b, i) => frame[i] === b) && sum8(frame, 0, 19) === frame[19];

/** @param {Uint8Array} frame */
export const isAckFrame = (frame) => isCommandFrame(frame) && frame[4] === CMD.ACK;

// ---------------------------------------------------------------------------------------------
// Data frames and reassembly (spec 3.2, 3.4)
// ---------------------------------------------------------------------------------------------

/**
 * Full check of a 300 byte data frame (spec 3.4 step 4): header, sum8 at byte 299, known type,
 * and no second header inside the window (a lost notification splices two frames).
 * @param {Uint8Array} frame
 */
export function isDataFrame(frame) {
  if (frame.length !== DATA_FRAME_LENGTH) return false;
  for (let i = 0; i < 4; i++) if (frame[i] !== DATA_HEADER[i]) return false;
  if (!DATA_FRAME_TYPES.includes(frame[4])) return false;
  if (sum8(frame, 0, 299) !== frame[299]) return false;
  return indexOf(frame, DATA_HEADER, 1) < 0;
}

/**
 * @param {number} type
 * @returns {(frame: Uint8Array) => boolean}
 */
export const isDataFrameOfType = (type) => (frame) => frame.length === DATA_FRAME_LENGTH && frame[4] === type && isDataFrame(frame);

/** Header fields and checksum state of a data frame. @param {Uint8Array} frame */
export function parseDataFrameHeader(frame) {
  return { frameType: frame[4], frameCounter: frame[5], checksumValid: frame.length === DATA_FRAME_LENGTH && sum8(frame, 0, 299) === frame[299] };
}

/**
 * Frame length for the BLE assembler: 300 byte data frames and 20 byte command/ACK frames.
 * @param {Uint8Array} buf starts with one of the two headers
 */
export const bleFrameLength = (buf) => (buf[0] === DATA_HEADER[0] ? DATA_FRAME_LENGTH : COMMAND_FRAME_LENGTH);

/** @param {Uint8Array} frame */
export const validateBleFrame = (frame) => (frame.length === DATA_FRAME_LENGTH ? isDataFrame(frame) : isCommandFrame(frame));

/**
 * Host side assembler for BLE notifications (spec 3.4): 300 byte data frames, 20 byte ACK
 * frames; `AT\r\n` text from the BLE module and other junk is discarded. A frame that fails the
 * checks drops one byte only, so a frame starting inside a truncated one is still found.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createBleAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [DATA_HEADER, COMMAND_HEADER],
    length: bleFrameLength,
    validate: validateBleFrame,
    onFrame,
    onDiscard,
    maxLength: DATA_FRAME_LENGTH,
  });
}

/**
 * Device side assembler (simulator): 20 byte command frames.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createCommandAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({ sync: [COMMAND_HEADER], length: () => COMMAND_FRAME_LENGTH, validate: isCommandFrame, onFrame, onDiscard, maxLength: COMMAND_FRAME_LENGTH });
}

/**
 * 300 byte data frame with header, type, counter and sum8; `fill` writes the payload.
 * @param {number} type
 * @param {(frame: Uint8Array) => void} fill
 * @param {number} [counter]
 */
export function encodeDataFrame(type, fill, counter = 0) {
  const f = new Uint8Array(DATA_FRAME_LENGTH);
  f.set(DATA_HEADER, 0);
  f[4] = type;
  f[5] = counter & 0xff;
  fill(f);
  f[299] = sum8(f, 0, 299);
  return f;
}

// ---------------------------------------------------------------------------------------------
// Cell info frame (type 0x02), JK02_24S and JK02_32S (spec 6.1)
// ---------------------------------------------------------------------------------------------

/**
 * Fields of the cell info frame: name, offset in JK02_24S, offset in JK02_32S (null when the
 * layout lacks the field), type, scale. Cell voltages (6 + 2n) and lead resistances (64 / 80 +
 * 2n) are handled separately. Fields the spec marks unverified (PWM duty cycles, 32S bytes
 * 230..233, 250..253) are not decoded.
 * @type {Array<[string, number|null, number|null, FieldType, number?]>}
 */
const CELL_INFO_TABLE = [
  ['enabledCellsMask', 54, 70, 'u32'],
  ['cellVoltageAverage', 58, 74, 'u16', 0.001],
  ['cellVoltageDelta', 60, 76, 'u16', 0.001],
  ['cellVoltageMaxIndex', 62, 78, 'u8'],
  ['cellVoltageMinIndex', 63, 79, 'u8'],
  ['temperatureMos', 134, 144, 'temp'],
  ['wireResistanceWarningMask', 114, 146, 'u32'],
  ['totalVoltage', 118, 150, 'u32', 0.001],
  ['powerRaw', 122, 154, 'u32', 0.001],
  ['current', 126, 158, 'i32', 0.001],
  ['temperature1', 130, 162, 'temp'],
  ['temperature2', 132, 164, 'temp'],
  ['errorsBitmask', 136, null, 'u16'],
  ['errorsBitmask', null, 166, 'u32'],
  ['balanceCurrent', 138, 170, 'i16', 0.001],
  ['balancingAction', 140, 172, 'u8'],
  ['soc', 141, 173, 'u8'],
  ['capacityRemaining', 142, 174, 'i32', 0.001],
  ['fullChargeCapacity', 146, 178, 'u32', 0.001],
  ['cycleCount', 150, 182, 'u32'],
  ['totalCycleCapacity', 154, 186, 'u32', 0.001],
  ['soh', 158, 190, 'u8'],
  ['precharging', 159, 191, 'u8'],
  ['userAlarm', 160, 192, 'u16'],
  ['totalRuntime', 162, 194, 'u32'],
  ['chargingMos', 166, 198, 'bool8'],
  ['dischargingMos', 167, 199, 'bool8'],
  // [JKMB] lists a u16 "UserAlarm2" at 200..201 instead (spec 6.1, unverified); kept for the log.
  ['prechargingMos', 168, 200, 'bool8'],
  ['balancerWorking', 169, 201, 'bool8'],
  ['timerDischargeOcpRelease', 170, 202, 'u16'],
  ['timerDischargeScpRelease', 172, 204, 'u16'],
  ['timerChargeOcpRelease', 174, 206, 'u16'],
  ['timerChargeScpRelease', 176, 208, 'u16'],
  ['timerUvRelease', 178, 210, 'u16'],
  ['timerOvRelease', 180, 212, 'u16'],
  ['temperatureSensorMask', 182, 214, 'u8'],
  ['heating', 183, 215, 'bool8'],
  ['emergencyTimeCountdown', 186, 218, 'u16'],
  ['dischargeCurrentCorrection', 188, 220, 'u16'],
  ['chargeCurrentSensorVoltage', 190, 222, 'u16', 0.001],
  ['dischargeCurrentSensorVoltage', 192, 224, 'u16', 0.001],
  ['batteryVoltageCorrection', 194, 226, 'f32'],
  // On JK02_24S this slot is not the pack voltage (spec 6.1), so it is not decoded there.
  ['totalVoltage2', null, 234, 'u16', 0.01],
  ['heatingCurrent', 204, 236, 'i16', 0.001],
  ['chargerPlugged', null, 245, 'bool8'],
  ['sysRunTicks', null, 246, 'u32'],
  ['temperature3', null, 254, 'temp'],
  ['temperature4', null, 256, 'temp'],
  ['temperature5', null, 258, 'temp'],
  ['rtcTicks', null, 262, 'u32'],
  ['detailLogCount', null, 266, 'u32'],
  ['timeEnterSleep', null, 270, 'u32'],
  ['pclModuleState', null, 274, 'u8'],
  ['batteryType', null, 275, 'u8'],
  ['chargeStatusTime', null, 278, 'u16'],
  ['chargeStatus', null, 280, 'u8'],
  ['dryContactMask', null, 281, 'u8'],
];

/** @param {1|2} column */
const cellInfoLayout = (column) =>
  CELL_INFO_TABLE.filter((row) => row[column] !== null).map((row) => ({
    name: row[0],
    offset: /** @type {number} */ (row[column]),
    type: row[3],
    ...(row[4] ? { scale: row[4] } : {}),
  }));

const CELL_INFO_24S = cellInfoLayout(1);
const CELL_INFO_32S = cellInfoLayout(2);

/** @param {string} [variant] */
const is24 = (variant) => variant === VARIANT.JK02_24S;

/**
 * Cell statistics over the cells with a non-zero voltage, first occurrence wins
 * (`cellVoltageMinNumber` and `cellVoltageMaxNumber` are 1-based, spec 6.1).
 * @param {number[]} cells
 */
export function cellStatistics(cells) {
  let min = Infinity;
  let max = -Infinity;
  let minIndex = -1;
  let maxIndex = -1;
  let sum = 0;
  let n = 0;
  cells.forEach((v, i) => {
    if (!(v > 0)) return;
    n++;
    sum += v;
    if (v < min) {
      min = v;
      minIndex = i;
    }
    if (v > max) {
      max = v;
      maxIndex = i;
    }
  });
  if (!n) return {};
  return {
    cellVoltageMin: min,
    cellVoltageMinNumber: minIndex + 1,
    cellVoltageMax: max,
    cellVoltageMaxNumber: maxIndex + 1,
    cellVoltageDeltaDerived: r(max - min, 4),
    cellVoltageAverageDerived: r(sum / n, 3),
  };
}

/**
 * Number of connected cells: set bits of the enabled cell mask; when the mask is empty or larger
 * than the layout, the leading slots with a voltage.
 * @param {number} mask
 * @param {number[]} slots voltages of all slots
 */
function cellCountOf(mask, slots) {
  const n = popcount(mask);
  if (n > 0 && n <= slots.length) return n;
  let k = 0;
  while (k < slots.length && slots[k] > 0) k++;
  return k;
}

/**
 * Parse a JK02 cell info frame (type 0x02).
 * @param {Uint8Array} frame validated 300 byte frame
 * @param {string} [variant] JK02_24S or JK02_32S (default)
 * @returns {Record<string, any>}
 */
export function parseCellInfo(frame, variant = VARIANT.JK02_32S) {
  const small = is24(variant);
  const slots = small ? 24 : 32;
  /** @type {Record<string, any>} */
  const out = { frameType: frame[4], frameCounter: frame[5] };
  for (const f of small ? CELL_INFO_24S : CELL_INFO_32S) out[f.name] = readField(frame, f);
  const all = Array.from({ length: slots }, (_, i) => r(u16le(frame, 6 + 2 * i) * 0.001, 3));
  const count = cellCountOf(out.enabledCellsMask, all);
  const resistanceBase = small ? 64 : 80;
  out.cellCount = count;
  out.cellVoltages = all.slice(0, count);
  out.cellResistances = Array.from({ length: count }, (_, i) => r(u16le(frame, resistanceBase + 2 * i) * 0.001, 3));
  Object.assign(out, cellStatistics(out.cellVoltages));
  // powerRaw has no sign (spec 6.1): signed power is voltage x current.
  out.power = z(r(out.totalVoltage * out.current, 3));
  out.balancing = out.balancingAction !== 0;
  out.checksumValid = sum8(frame, 0, 299) === frame[299];
  return out;
}

/**
 * Encode a JK02 cell info frame (simulator, tests). `c` uses the parser's field names.
 * @param {Record<string, any>} c
 * @param {string} [variant]
 * @param {number} [counter]
 */
export function encodeCellInfo(c, variant = VARIANT.JK02_32S, counter = 0) {
  const small = is24(variant);
  return encodeDataFrame(
    FRAME_TYPE.CELL_INFO,
    (f) => {
      const cells = c.cellVoltages ?? [];
      const mask = c.enabledCellsMask ?? (cells.length >= 32 ? 0xffffffff : 2 ** cells.length - 1);
      for (const s of small ? CELL_INFO_24S : CELL_INFO_32S) writeField(f, s, s.name === 'enabledCellsMask' ? mask : c[s.name]);
      cells.forEach((v, i) => setU16le(f, 6 + 2 * i, Math.round(v * 1000)));
      (c.cellResistances ?? []).forEach((/** @type {number} */ v, /** @type {number} */ i) => setU16le(f, (small ? 64 : 80) + 2 * i, Math.round(v * 1000)));
    },
    counter,
  );
}

/**
 * Plausibility check of a decoded cell info frame (spec 3.4 step 7): sum8 lets 1 of 256
 * corrupted frames through. Returns an English reason or null.
 * @param {Record<string, any>} c parsed JK02 or JK04 cell info
 * @param {string} [variant]
 */
export function cellInfoProblem(c, variant) {
  if (!(c.cellCount >= 1 && c.cellCount <= 32)) return `cell count ${c.cellCount}`;
  const bad = c.cellVoltages.find((/** @type {number} */ v) => v !== 0 && (v < 0.5 || v > 5));
  if (bad !== undefined) return `cell voltage ${bad} V`;
  if (variant === VARIANT.JK04) return null;
  const sum = c.cellVoltages.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0);
  if (Math.abs(c.totalVoltage - sum) > Math.max(2, sum * 0.1)) return `pack voltage ${c.totalVoltage} V against cell sum ${r(sum, 3)} V`;
  if (Math.abs(c.current) >= 2000) return `current ${c.current} A`;
  if (c.soc > 100) return `SOC ${c.soc} %`;
  for (const k of ['temperatureMos', 'temperature1', 'temperature2', 'temperature3', 'temperature4', 'temperature5']) {
    const t = c[k];
    if (t !== null && t !== undefined && (t < -50 || t > 150)) return `${k} ${t} degrees C`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Settings frame (type 0x01), JK02 (spec 6.2, 7, 8.1)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {FieldSpec & { reg32?: number, reg24?: number, length?: 1|2|4, only32?: boolean }} SettingSpec
 * `reg32` / `reg24`: BLE write register per layout, `length`: BLE value length (spec 7).
 */

/**
 * JK02 settings frame fields. The JK-PB Modbus register of a field in the 0x1000 block is
 * 0x1000 + offset - 6 (spec 3.6.1).
 * @type {SettingSpec[]}
 */
export const JK02_SETTINGS_LAYOUT = [
  { name: 'smartSleepVoltage', offset: 6, type: 'u32', scale: 0.001, reg32: 0x01, reg24: 0x01, length: 4 },
  { name: 'cellUvp', offset: 10, type: 'u32', scale: 0.001, reg32: 0x02, reg24: 0x02, length: 4 },
  { name: 'cellUvpr', offset: 14, type: 'u32', scale: 0.001, reg32: 0x03, reg24: 0x03, length: 4 },
  { name: 'cellOvp', offset: 18, type: 'u32', scale: 0.001, reg32: 0x04, reg24: 0x04, length: 4 },
  { name: 'cellOvpr', offset: 22, type: 'u32', scale: 0.001, reg32: 0x05, reg24: 0x05, length: 4 },
  { name: 'balanceTriggerVoltage', offset: 26, type: 'u32', scale: 0.001, reg32: 0x06, reg24: 0x06, length: 4 },
  { name: 'cellSoc100Voltage', offset: 30, type: 'u32', scale: 0.001, reg32: 0x07, reg24: 0x07, length: 4 },
  { name: 'cellSoc0Voltage', offset: 34, type: 'u32', scale: 0.001, reg32: 0x08, reg24: 0x08, length: 4 },
  { name: 'cellRcv', offset: 38, type: 'u32', scale: 0.001, reg32: 0x09, reg24: 0x09, length: 4 },
  { name: 'cellRfv', offset: 42, type: 'u32', scale: 0.001, reg32: 0x0a, reg24: 0x0a, length: 4 },
  { name: 'powerOffVoltage', offset: 46, type: 'u32', scale: 0.001, reg32: 0x0b, reg24: 0x0b, length: 4 },
  { name: 'maxChargeCurrent', offset: 50, type: 'u32', scale: 0.001, reg32: 0x0c, reg24: 0x0c, length: 4 },
  { name: 'chargeOcpDelay', offset: 54, type: 'u32', reg32: 0x0d, reg24: 0x0d, length: 4 },
  { name: 'chargeOcpRecoveryTime', offset: 58, type: 'u32', reg32: 0x0e, reg24: 0x0e, length: 4 },
  { name: 'maxDischargeCurrent', offset: 62, type: 'u32', scale: 0.001, reg32: 0x0f, reg24: 0x0f, length: 4 },
  { name: 'dischargeOcpDelay', offset: 66, type: 'u32', reg32: 0x10, reg24: 0x10, length: 4 },
  { name: 'dischargeOcpRecoveryTime', offset: 70, type: 'u32', reg32: 0x11, reg24: 0x11, length: 4 },
  { name: 'scpRecoveryTime', offset: 74, type: 'u32', reg32: 0x12, reg24: 0x12, length: 4 },
  { name: 'maxBalanceCurrent', offset: 78, type: 'u32', scale: 0.001, reg32: 0x13, reg24: 0x13, length: 4 },
  { name: 'chargeOtp', offset: 82, type: 'i32', scale: 0.1, reg32: 0x14, reg24: 0x14, length: 4 },
  { name: 'chargeOtpr', offset: 86, type: 'i32', scale: 0.1, reg32: 0x15, reg24: 0x15, length: 4 },
  { name: 'dischargeOtp', offset: 90, type: 'i32', scale: 0.1, reg32: 0x16, reg24: 0x16, length: 4 },
  { name: 'dischargeOtpr', offset: 94, type: 'i32', scale: 0.1, reg32: 0x17, reg24: 0x17, length: 4 },
  { name: 'chargeUtp', offset: 98, type: 'i32', scale: 0.1, reg32: 0x18, reg24: 0x18, length: 4 },
  { name: 'chargeUtpr', offset: 102, type: 'i32', scale: 0.1, reg32: 0x19, reg24: 0x19, length: 4 },
  { name: 'mosOtp', offset: 106, type: 'i32', scale: 0.1, reg32: 0x1a, reg24: 0x1a, length: 4 },
  { name: 'mosOtpr', offset: 110, type: 'i32', scale: 0.1, reg32: 0x1b, reg24: 0x1b, length: 4 },
  { name: 'cellCount', offset: 114, type: 'u32', reg32: 0x1c, reg24: 0x1c, length: 4 },
  { name: 'chargeSwitch', offset: 118, type: 'bool32', reg32: 0x1d, reg24: 0x1d, length: 4 },
  { name: 'dischargeSwitch', offset: 122, type: 'bool32', reg32: 0x1e, reg24: 0x1e, length: 4 },
  { name: 'balancerSwitch', offset: 126, type: 'bool32', reg32: 0x1f, reg24: 0x1f, length: 4 },
  { name: 'nominalCapacity', offset: 130, type: 'u32', scale: 0.001, reg32: 0x20, reg24: 0x20, length: 4 },
  // Unit on firmware >= 15.26 unverified (spec 6.2, 12 item 24).
  { name: 'scpDelay', offset: 134, type: 'u32', reg32: 0x21, reg24: 0x25, length: 4 },
  { name: 'balanceStartVoltage', offset: 138, type: 'u32', scale: 0.001, reg32: 0x22, reg24: 0x26, length: 4 },
  // JK02_32S only (the 24S frame has wire resistances and unused bytes there).
  { name: 'deviceAddress', offset: 270, type: 'u8', only32: true },
  { name: 'prechargeTime', offset: 274, type: 'u32', reg32: 0x25, length: 4, only32: true },
  { name: 'controlsBitmask', offset: 282, type: 'u16', only32: true },
  { name: 'heatingStartTemperature', offset: 284, type: 'i8', reg32: 0x37, length: 1, only32: true },
  { name: 'heatingStopTemperature', offset: 285, type: 'i8', reg32: 0x38, length: 1, only32: true },
  { name: 'smartSleepDelay', offset: 286, type: 'u8', reg32: 0x39, length: 1, only32: true },
  { name: 'dataFieldEnable0', offset: 287, type: 'u8', only32: true },
  // Write of 0x3A / 0x3B unverified (spec 6.2, 7.3).
  { name: 'dischargeUtp', offset: 296, type: 'i8', reg32: 0x3a, length: 1, only32: true },
  { name: 'dischargeUtpr', offset: 297, type: 'i8', reg32: 0x3b, length: 1, only32: true },
];

/** Settings layout field by name. @type {Record<string, SettingSpec>} */
export const JK02_SETTINGS = Object.freeze(Object.fromEntries(JK02_SETTINGS_LAYOUT.map((s) => [s.name, s])));

/**
 * Bits of the controls bitmask S282 (spec 9.5); the BLE switch register is 0x27 + bit (spec 8.1).
 * `inferred`: the BLE register follows the pattern but was never seen (spec 8.1, unverified).
 */
export const CONTROL_BITS = Object.freeze([
  { bit: 0, name: 'heatingEnabled' },
  { bit: 1, name: 'disableTemperatureSensors' },
  { bit: 2, name: 'gpsHeartbeat', inferred: true },
  { bit: 3, name: 'portSwitchRs485' },
  { bit: 4, name: 'displayAlwaysOn' },
  { bit: 5, name: 'specialCharger', inferred: true },
  { bit: 6, name: 'smartSleep' },
  { bit: 7, name: 'disablePclModule' },
  { bit: 8, name: 'timedStoredData' },
  { bit: 9, name: 'chargingFloatMode' },
  { bit: 10, name: 'emergencyButtonTrigger' },
  { bit: 11, name: 'dryContactAlarmIntermittent' },
  { bit: 12, name: 'dischargeOcp2' },
  { bit: 13, name: 'dischargeOcp3' },
  { bit: 14, name: 'gpsLockedCharging' },
  { bit: 15, name: 'gpsLockedDischarging' },
]);

/** BLE switch register of a controls bit (spec 8.1). @param {number} bit */
export const controlBitRegister = (bit) => 0x27 + bit;

/** JK-PB Modbus register of a settings frame offset in the 0x1000 block (spec 3.6.1). @param {number} offset */
export const pbSettingsRegister = (offset) => 0x1000 + offset - 6;

/** JK-PB register of the controls word (spec 8.1). */
export const PB_CONTROLS_REGISTER = 0x1114;

/**
 * Parse a settings frame (type 0x01).
 * @param {Uint8Array} frame
 * @param {string} [variant] JK02_24S, JK02_32S (default) or JK04
 * @returns {Record<string, any>}
 */
export function parseSettings(frame, variant = VARIANT.JK02_32S) {
  if (variant === VARIANT.JK04) return parseJk04Settings(frame);
  const small = is24(variant);
  /** @type {Record<string, any>} */
  const out = { frameType: frame[4], frameCounter: frame[5] };
  for (const s of JK02_SETTINGS_LAYOUT) if (!small || !s.only32) out[s.name] = readField(frame, s);
  // Connection wire resistance per cell, unit unverified (0.001 ohm in [SY], spec 6.2).
  const base = small ? 158 : 142;
  out.wireResistances = Array.from({ length: small ? 24 : 32 }, (_, i) => r(u32le(frame, base + 4 * i) * 0.001, 3));
  if (!small) for (const b of CONTROL_BITS) out[b.name] = ((out.controlsBitmask >>> b.bit) & 1) === 1;
  out.checksumValid = sum8(frame, 0, 299) === frame[299];
  return out;
}

/**
 * Encode a JK02 settings frame (simulator, tests). `s` uses the parser's field names; the
 * controls bitmask is built from the individual bits when they are present.
 * @param {Record<string, any>} s
 * @param {string} [variant]
 * @param {number} [counter]
 */
export function encodeSettings(s, variant = VARIANT.JK02_32S, counter = 0) {
  const small = is24(variant);
  return encodeDataFrame(
    FRAME_TYPE.SETTINGS,
    (f) => {
      let controls = s.controlsBitmask ?? 0;
      for (const b of CONTROL_BITS) if (s[b.name] !== undefined) controls = s[b.name] ? controls | (1 << b.bit) : controls & ~(1 << b.bit);
      for (const spec of JK02_SETTINGS_LAYOUT) {
        if (small && spec.only32) continue;
        writeField(f, spec, spec.name === 'controlsBitmask' ? controls & 0xffff : s[spec.name]);
      }
      (s.wireResistances ?? []).forEach((/** @type {number} */ v, /** @type {number} */ i) => setU32le(f, (small ? 158 : 142) + 4 * i, Math.round(v * 1000)));
      if (!small) f[287] = s.dataFieldEnable0 ?? 0xfe;
    },
    counter,
  );
}

// ---------------------------------------------------------------------------------------------
// Device info frame (type 0x03), spec 6.3 and 10
// ---------------------------------------------------------------------------------------------

/** ASCII fields: name, offset, length. Passcodes are decoded for the log only. */
const DEVICE_STRINGS = /** @type {Array<[string, number, number]>} */ ([
  ['model', 6, 16],
  ['hardwareVersion', 22, 8],
  ['softwareVersion', 30, 8],
  ['deviceName', 46, 16],
  ['devicePasscode', 62, 16],
  ['manufacturingDate', 78, 8],
  // 10 characters + NUL on older firmware, up to 15 characters on firmware 19 (spec 6.3).
  ['serialNumber', 86, 16],
  ['userData', 102, 16],
  ['setupPasscode', 118, 16],
  ['userData2', 134, 16],
]);

/** Numeric device info fields; everything from byte 134 on is JK02_32S only. */
const DEVICE_NUMBERS = specs([
  ['uptime', 38, 'u32'],
  ['powerOnCount', 42, 'u32'],
  ['uart1Protocol', 184, 'u8'],
  ['canProtocol', 185, 'u8'],
  ['uart1ProtocolEnableLo32', 186, 'u32'],
  ['canProtocolEnable', 202, 'u32'],
  ['uart2Protocol', 218, 'u8'],
  ['uart2ProtocolEnable', 219, 'u32'],
  ['lcdBuzzerTrigger', 234, 'u8'],
  ['dry1Trigger', 235, 'u8'],
  ['dry2Trigger', 236, 'u8'],
  ['uartProtocolLibVersion', 237, 'u8'],
  ['lcdBuzzerTriggerValue', 238, 'i32'],
  ['lcdBuzzerReleaseValue', 242, 'i32'],
  ['dry1TriggerValue', 246, 'i32'],
  ['dry1ReleaseValue', 250, 'i32'],
  ['dry2TriggerValue', 254, 'i32'],
  ['dry2ReleaseValue', 258, 'i32'],
  ['dataStoredPeriod', 262, 'u32'],
  ['rcvTime', 266, 'u8', 0.1],
  ['rfvTime', 267, 'u8', 0.1],
  ['canProtocolLibVersion', 268, 'u8'],
  ['emergencyDuration', 269, 'u8'],
  ['uart3Protocol', 270, 'u8'],
  ['uart3ProtocolEnableLo32', 271, 'u32'],
  ['reBulkSoc', 278, 'u8'],
]);

/**
 * Settings located in the device info frame (JK02_32S, spec 7.1, 7.7) with their BLE write
 * register and value length.
 * @type {Array<{ name: string, register: number, length: 1|2|4, scale?: number }>}
 */
export const JK02_DEVICE_SETTINGS = [
  { name: 'uart1Protocol', register: 0xa5, length: 2 },
  { name: 'canProtocol', register: 0xa6, length: 2 },
  { name: 'uart2Protocol', register: 0xa8, length: 2 },
  { name: 'lcdBuzzerTrigger', register: 0xa9, length: 2 },
  { name: 'dry1Trigger', register: 0xaa, length: 2 },
  { name: 'dry2Trigger', register: 0xab, length: 2 },
  { name: 'rcvTime', register: 0xb3, length: 1, scale: 0.1 },
  { name: 'rfvTime', register: 0xb4, length: 1, scale: 0.1 },
  { name: 'emergencyDuration', register: 0xb5, length: 1 },
  { name: 'uart3Protocol', register: 0xb6, length: 2 },
  { name: 'reBulkSoc', register: 0xb7, length: 1 },
];

/**
 * Parse a device info frame (type 0x03). JK02_24S and JK04 frames carry only the fields up to
 * byte 133; the rest reads zero there.
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export function parseDeviceInfo(frame) {
  /** @type {Record<string, any>} */
  const out = { frameType: frame[4], frameCounter: frame[5] };
  for (const [name, o, len] of DEVICE_STRINGS) out[name] = ascii(frame, o, len);
  for (const s of DEVICE_NUMBERS) out[s.name] = readField(frame, s);
  out.checksumValid = sum8(frame, 0, 299) === frame[299];
  return out;
}

/**
 * Encode a device info frame (simulator, tests).
 * @param {Record<string, any>} d
 * @param {number} [counter]
 */
export function encodeDeviceInfo(d, counter = 0) {
  return encodeDataFrame(
    FRAME_TYPE.DEVICE_INFO,
    (f) => {
      for (const [name, o, len] of DEVICE_STRINGS) if (d[name]) f.set(asciiBytes(String(d[name]), len), o);
      for (const s of DEVICE_NUMBERS) writeField(f, s, d[s.name]);
    },
    counter,
  );
}

/**
 * Major number of a software version: digits before the first dot ("19.27" -> 19,
 * "10.07D30" -> 10, "8.0.3M" -> 8). NaN when there are none.
 * @param {string} [version]
 */
export function softwareMajor(version) {
  const head = String(version ?? '').split('.')[0];
  const m = /(\d+)\s*$/.exec(head) ?? /(\d+)/.exec(head);
  return m ? Number(m[1]) : NaN;
}

/**
 * JK02 layout from the software version (spec 1.2): major >= 11 is JK02_32S, below JK02_24S
 * unless the data shows a JK04 balancer (spec 11.3). Undefined when the version is unreadable.
 * @param {string} [version]
 */
export function variantFromSoftware(version) {
  const major = softwareMajor(version);
  if (!Number.isFinite(major)) return undefined;
  return major >= 11 ? VARIANT.JK02_32S : VARIANT.JK02_24S;
}

// ---------------------------------------------------------------------------------------------
// JK04 frames (spec 6.4, 11.3)
// ---------------------------------------------------------------------------------------------

/**
 * JK04 test on a cell info frame ([BM] looks_like_jk04_status, spec 11.3): every non-zero 4 byte
 * slot at 6 + 4i must be a float32 between 0.5 and 5.0 V with high byte 0x3F or 0x40, and at
 * least two cells must pass. JK02 frames fail because those bytes are millivolt high bytes.
 * @param {Uint8Array} frame
 */
export function looksLikeJk04CellInfo(frame) {
  if (frame.length !== DATA_FRAME_LENGTH || frame[4] !== FRAME_TYPE.CELL_INFO) return false;
  let cells = 0;
  for (let i = 0; i < 24; i++) {
    const o = 6 + 4 * i;
    if (frame[o] === 0 && frame[o + 1] === 0 && frame[o + 2] === 0 && frame[o + 3] === 0) continue;
    if (frame[o + 3] !== 0x3f && frame[o + 3] !== 0x40) return false;
    const v = f32le(frame, o);
    if (!(v >= 0.5 && v <= 5)) return false;
    cells++;
  }
  return cells >= 2;
}

/**
 * Fallback JK04 test on a settings frame ([BM] _cells_from_settings_checked): S114 = 0 and a
 * cell count of 1 to 24 at S34. Ambiguous when the JK04 balancer is on (spec 11.3).
 * @param {Uint8Array} frame
 */
export function looksLikeJk04Settings(frame) {
  return frame.length === DATA_FRAME_LENGTH && frame[4] === FRAME_TYPE.SETTINGS && u32le(frame, 114) === 0 && frame[34] >= 1 && frame[34] <= 24;
}

/**
 * Parse a JK04 cell info frame (float32 values, spec 6.4).
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export function parseJk04CellInfo(frame) {
  const all = Array.from({ length: 24 }, (_, i) => z(r(f32le(frame, 6 + 4 * i), 6)));
  const mask = u32le(frame, 214);
  const count = cellCountOf(mask, all);
  const cellVoltages = all.slice(0, count);
  const sum = cellVoltages.reduce((a, b) => a + b, 0);
  /** @type {Record<string, any>} */
  const out = {
    frameType: frame[4],
    frameCounter: frame[5],
    cellCount: count,
    cellVoltages,
    cellResistances: Array.from({ length: count }, (_, i) => z(r(f32le(frame, 102 + 4 * i), 6))),
    // JK04 has no pack voltage field: the sum of the cells (spec 6.1, derived values).
    totalVoltage: r(sum, 3),
    totalVoltageSum: r(sum, 3),
    cellVoltageAverage: z(r(f32le(frame, 202), 6)),
    cellVoltageDelta: z(r(f32le(frame, 206), 6)),
    cellMask214: mask,
    cellVoltageMaxIndex: frame[218],
    cellVoltageMinIndex: frame[219],
    balancingAction: frame[220],
    balanceCurrent: z(r(f32le(frame, 222), 6)),
    totalRuntime: u32le(frame, 286),
  };
  Object.assign(out, cellStatistics(cellVoltages));
  out.balancing = out.balancingAction !== 0;
  out.checksumValid = sum8(frame, 0, 299) === frame[299];
  return out;
}

/**
 * JK04 settings fields with their write register and value length (spec 6.4, 5.2).
 * @type {Array<FieldSpec & { register: number, length: 1|2|4 }>}
 */
export const JK04_SETTINGS_LAYOUT = [
  { name: 'cellCount', offset: 34, type: 'u8', register: 0x1c, length: 2 },
  { name: 'powerOffVoltage', offset: 38, type: 'f32', register: 0x20, length: 4 },
  { name: 'voltageCalibration', offset: 74, type: 'f32', register: 0x44, length: 4 },
  { name: 'balanceStartVoltage', offset: 98, type: 'f32', register: 0x58, length: 4 },
  { name: 'balanceTriggerVoltage', offset: 106, type: 'f32', register: 0x64, length: 4 },
  { name: 'maxBalanceCurrent', offset: 110, type: 'f32', register: 0x68, length: 4 },
  { name: 'balancerSwitch', offset: 114, type: 'bool8', register: 0x6c, length: 1 },
];

/**
 * Parse a JK04 settings frame.
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export function parseJk04Settings(frame) {
  /** @type {Record<string, any>} */
  const out = { frameType: frame[4], frameCounter: frame[5] };
  for (const s of JK04_SETTINGS_LAYOUT) out[s.name] = readField(frame, s);
  out.checksumValid = sum8(frame, 0, 299) === frame[299];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Event log (type 0x05), spec 6.5 and 9.7
// ---------------------------------------------------------------------------------------------

/**
 * Parse an event log frame: up to 50 entries of seconds (u32) and event code (u8).
 * @param {Uint8Array} frame
 */
export function parseEventLog(frame) {
  const logCount = u32le(frame, 6);
  const entries = [];
  for (let i = 0; i < Math.min(logCount, 50); i++) entries.push({ seconds: u32le(frame, 11 + 5 * i), code: frame[15 + 5 * i] });
  return { frameType: frame[4], logCount, entries, checksumValid: sum8(frame, 0, 299) === frame[299] };
}

/**
 * Encode an event log frame (simulator).
 * @param {Array<{ seconds: number, code: number }>} entries
 * @param {number} [counter]
 */
export function encodeEventLog(entries, counter = 0) {
  return encodeDataFrame(
    FRAME_TYPE.EVENT_LOG,
    (f) => {
      setU32le(f, 6, entries.length);
      f[10] = 0x03;
      entries.slice(0, 50).forEach((e, i) => {
        setU32le(f, 11 + 5 * i, e.seconds);
        f[15 + 5 * i] = e.code;
      });
    },
    counter,
  );
}

// ---------------------------------------------------------------------------------------------
// Alarm bits (spec 9.1)
// ---------------------------------------------------------------------------------------------

/**
 * JK02 error bitmask (C136 u16 on 24S, C166 u32 on 32S, PB 0x12A0) to canonical alarm ids.
 * @type {import('../common/util.js').AlarmBit[]}
 */
export const JK_ALARM_BITS = [
  { bit: 0, id: 'wire_resistance' },
  { bit: 1, id: 'mos_overtemperature' },
  { bit: 2, id: 'cell_count_mismatch' },
  { bit: 3, id: 'current_sensor_fault' },
  { bit: 4, id: 'cell_overvoltage' },
  { bit: 5, id: 'pack_overvoltage' },
  { bit: 6, id: 'charge_overcurrent' },
  { bit: 7, id: 'jk.charge_short_circuit', severity: 'protection', label: msg('Charge short circuit') },
  { bit: 8, id: 'charge_overtemperature' },
  { bit: 9, id: 'charge_undertemperature' },
  { bit: 10, id: 'communication_fault' },
  { bit: 11, id: 'cell_undervoltage' },
  { bit: 12, id: 'pack_undervoltage' },
  { bit: 13, id: 'discharge_overcurrent' },
  { bit: 14, id: 'short_circuit' },
  { bit: 15, id: 'discharge_overtemperature' },
  { bit: 16, id: 'charge_mos_fault' },
  { bit: 17, id: 'discharge_mos_fault' },
  { bit: 18, id: 'jk.gps_disconnected', severity: 'warning', label: msg('GPS module disconnected') },
  { bit: 19, id: 'jk.change_password', severity: 'info', label: msg('Change the default password') },
  { bit: 20, id: 'jk.discharge_on_failed', severity: 'fault', label: msg('Discharge switch-on failed') },
  { bit: 21, id: 'jk.battery_overtemperature', severity: 'warning', label: msg('Battery overtemperature') },
  { bit: 22, id: 'temperature_sensor_fault' },
  { bit: 23, id: 'jk.pcl_module_fault', severity: 'fault', label: msg('PCL module fault') },
  { bit: 24, id: 'jk.scp_release_failed', severity: 'fault', label: msg('Short circuit release failed') },
  { bit: 25, id: 'jk.discharge_ocp2', severity: 'protection', label: msg('Discharge overcurrent, level 2') },
  { bit: 26, id: 'jk.discharge_ocp3', severity: 'protection', label: msg('Discharge overcurrent, level 3') },
  { bit: 27, id: 'discharge_undertemperature' },
  { bit: 28, id: 'jk.gps_locked', severity: 'protection', label: msg('Locked by the GPS module') },
];

// ---------------------------------------------------------------------------------------------
// JK-PB over RS485: Modbus RTU (spec 3.6)
// ---------------------------------------------------------------------------------------------

/** Trigger registers and the frame type they return (spec 3.6.3). */
export const PB_TRIGGER = Object.freeze({ DEVICE_INFO: 0x161c, SETTINGS: 0x161e, CELL_INFO: 0x1620 });
export const PB_TRIGGER_TYPE = Object.freeze({ [PB_TRIGGER.DEVICE_INFO]: FRAME_TYPE.DEVICE_INFO, [PB_TRIGGER.SETTINGS]: FRAME_TYPE.SETTINGS, [PB_TRIGGER.CELL_INFO]: FRAME_TYPE.CELL_INFO });
/** Default device address: 1 (address 0 is the parallel bus master, spec 2.3, 4.3, 12 item 15). */
export const PB_DEFAULT_ADDRESS = 1;

/**
 * @param {Uint8Array} f
 * @param {number} end exclusive end of the CRC range
 */
const putCrc = (f, end) => {
  const crc = crc16Modbus(f, 0, end);
  f[end] = crc & 0xff;
  f[end + 1] = crc >>> 8;
};

/** @param {Uint8Array} f */
export const modbusCrcValid = (f) => f.length >= 4 && crc16Modbus(f, 0, f.length - 2) === (f[f.length - 2] | (f[f.length - 1] << 8));

/**
 * FC 0x10 write of `data` (even length, big endian words) at a byte address register.
 * @param {number} address
 * @param {number} register
 * @param {ArrayLike<number>} data
 */
export function modbusWriteRequest(address, register, data) {
  if (data.length % 2) throw new RangeError('Modbus writes need an even number of bytes');
  const f = new Uint8Array(9 + data.length);
  f[0] = address;
  f[1] = 0x10;
  setU16be(f, 2, register);
  setU16be(f, 4, data.length / 2);
  f[6] = data.length;
  f.set(data, 7);
  putCrc(f, 7 + data.length);
  return f;
}

/**
 * FC 0x03 read (not used by the driver; spec 3.6.2 explains why).
 * @param {number} address
 * @param {number} register
 * @param {number} quantity
 */
export function modbusReadRequest(address, register, quantity) {
  const f = new Uint8Array(8);
  f[0] = address;
  f[1] = 0x03;
  setU16be(f, 2, register);
  setU16be(f, 4, quantity);
  putCrc(f, 6);
  return f;
}

/**
 * Trigger request: a write of 0 to one register; the BMS answers with a 300 byte frame plus the
 * FC 0x10 answer (spec 3.6.3).
 * @param {number} address
 * @param {number} register PB_TRIGGER value
 */
export const pbTriggerRequest = (address, register) => modbusWriteRequest(address, register, [0, 0]);

/**
 * 32 bit setting write: 2 registers, 4 bytes, big endian, two's complement (spec 3.6.2, 7).
 * @param {number} address
 * @param {number} register
 * @param {number} raw
 */
export function pbWriteU32(address, register, raw) {
  const data = new Uint8Array(4);
  setU32be(data, 0, raw >>> 0);
  return modbusWriteRequest(address, register, data);
}

/**
 * 16 bit write (the controls word at 0x1114).
 * @param {number} address
 * @param {number} register
 * @param {number} raw
 */
export function pbWriteU16(address, register, raw) {
  const data = new Uint8Array(2);
  setU16be(data, 0, raw & 0xffff);
  return modbusWriteRequest(address, register, data);
}

/**
 * Decode a Modbus request frame (FC 0x10 or 0x03).
 * @param {Uint8Array} f
 */
export function parseModbusRequest(f) {
  /** @type {Record<string, any>} */
  const out = { address: f[0], function: f[1], register: u16be(f, 2), quantity: u16be(f, 4), crcValid: modbusCrcValid(f) };
  if (f[1] === 0x10 && f.length >= 9) {
    const n = f[6];
    out.byteCount = n;
    const data = f.subarray(7, 7 + n);
    out.dataHex = hex(data);
    if (n === 2) out.value = u16be(data, 0);
    else if (n === 4) out.value = u32be(data, 0);
  }
  return out;
}

/**
 * Decode a Modbus answer: FC 0x10 acknowledgement or exception.
 * @param {Uint8Array} f
 */
export function parseModbusResponse(f) {
  if (f[1] & 0x80) return { address: f[0], function: f[1], exceptionCode: f[2], crcValid: modbusCrcValid(f) };
  return { address: f[0], function: f[1], register: u16be(f, 2), quantity: u16be(f, 4), crcValid: modbusCrcValid(f) };
}

/**
 * @param {Uint8Array} f
 * @param {number} address
 * @param {number} [register] when given, the acknowledged register must match
 */
export const isPbWriteAck = (f, address, register) =>
  f.length === 8 && f[0] === address && f[1] === 0x10 && modbusCrcValid(f) && (register === undefined || u16be(f, 2) === register);

/** @param {Uint8Array} f @param {number} address */
export const isModbusException = (f, address) => f.length === 5 && f[0] === address && (f[1] & 0x80) !== 0 && modbusCrcValid(f);

/**
 * Host side assembler for the RS485 link of one JK-PB address: 300 byte frames, 8 byte FC 0x10
 * answers and 5 byte exceptions of that address. Adapter echo, other addresses' answers and the
 * stray 0x00 bytes seen around answers (spec 3.6.3) are discarded.
 * @param {number} address
 */
export function createPbAssembler(address) {
  /** @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers */
  return ({ onFrame, onDiscard }) =>
    new FrameAssembler({
      sync: [DATA_HEADER, [address, 0x10], [address, 0x90]],
      length: (buf) => (buf[0] === DATA_HEADER[0] && buf[1] === DATA_HEADER[1] ? DATA_FRAME_LENGTH : buf[1] === 0x90 ? 5 : 8),
      validate: (f) => (f.length === DATA_FRAME_LENGTH ? isDataFrame(f) : modbusCrcValid(f)),
      onFrame,
      onDiscard,
      maxLength: DATA_FRAME_LENGTH,
    });
}

/**
 * Device side assembler for FC 0x10 requests of one address (test devices).
 * @param {number} address
 */
export function createModbusRequestAssembler(address) {
  /** @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers */
  return ({ onFrame, onDiscard }) =>
    new FrameAssembler({ sync: [[address, 0x10]], length: (buf) => (buf.length < 7 ? 0 : 9 + buf[6]), validate: modbusCrcValid, onFrame, onDiscard, maxLength: 9 + 254 });
}

/**
 * FC 0x10 answer for a request (test devices): echo of address, function, register, quantity.
 * @param {Uint8Array} request
 */
export function modbusWriteAck(request) {
  const f = new Uint8Array(8);
  f.set(request.subarray(0, 6), 0);
  putCrc(f, 6);
  return f;
}

/**
 * Exception answer (test devices).
 * @param {number} address
 * @param {number} fn function code of the request
 * @param {number} code exception code
 */
export function modbusException(address, fn, code) {
  const f = new Uint8Array(5);
  f[0] = address;
  f[1] = fn | 0x80;
  f[2] = code;
  putCrc(f, 3);
  return f;
}

// ---------------------------------------------------------------------------------------------
// JK-B UART / RS485 "4E 57" protocol (spec 3.5, 6.6)
// ---------------------------------------------------------------------------------------------

export const UART_HEADER = Object.freeze([0x4e, 0x57]);
export const UART_CMD = Object.freeze({ ACTIVATE: 0x01, WRITE: 0x02, READ: 0x03, PAIR: 0x05, READ_ALL: 0x06 });
export const UART_SOURCE = Object.freeze({ BMS: 0x00, BLUETOOTH: 0x01, GPS: 0x02, PC: 0x03 });
/** Data IDs of the writes the spec confirms (1 byte MOSFET and balancer switches, spec 6.6). */
export const UART_ID = Object.freeze({ CHARGE_SWITCH: 0xab, DISCHARGE_SWITCH: 0xac, BALANCER_SWITCH: 0x9d, CELLS: 0x79 });

/**
 * Encode a 4E57 frame (spec 3.5): length L counts everything after the start bytes, the checksum
 * is the 16 bit sum of all bytes before it.
 * @param {{ command: number, source?: number, transportType?: number, info?: ArrayLike<number> }} o
 */
export function encodeUartFrame({ command, source = UART_SOURCE.PC, transportType = 0, info = [0] }) {
  const n = info.length;
  const L = 18 + n;
  const f = new Uint8Array(L + 2);
  f.set(UART_HEADER, 0);
  setU16be(f, 2, L);
  f[8] = command;
  f[9] = source;
  f[10] = transportType;
  f.set(info, 11);
  f[L - 3] = 0x68;
  setU32be(f, L - 2, sum16(f, 0, L - 2));
  return f;
}

/** "Read all" request, source PC ([SY] docs, [DSB], [VS]). @param {number} [source] */
export const uartReadAll = (source = UART_SOURCE.PC) => encodeUartFrame({ command: UART_CMD.READ_ALL, source, info: [0] });

/**
 * One byte switch write as captured by [JD] and [VS] (command 0x02, source PC, type 0x02).
 * @param {number} dataId
 * @param {number} value
 */
export const uartSwitchWrite = (dataId, value) =>
  encodeUartFrame({ command: UART_CMD.WRITE, source: UART_SOURCE.PC, transportType: 0x02, info: [dataId, value ? 1 : 0] });

/** @param {Uint8Array} buf starts with 4E 57 */
export function uartFrameLength(buf) {
  if (buf.length < 4) return 0;
  const L = u16be(buf, 2);
  return L < 19 || L > 1022 ? -1 : L + 2;
}

/** @param {Uint8Array} f */
export function validateUartFrame(f) {
  if (f.length < 21 || f[0] !== 0x4e || f[1] !== 0x57) return false;
  const L = u16be(f, 2);
  return f.length === L + 2 && f[L - 3] === 0x68 && sum16(f, 0, L) === u16be(f, L);
}

/**
 * Assembler for 4E57 frames (both directions).
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createUartAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({ sync: [UART_HEADER], length: uartFrameLength, validate: validateUartFrame, onFrame, onDiscard, maxLength: 1024 });
}

/** Width of every fixed size data ID (spec 6.6); 0x79 is variable. @type {Record<number, number>} */
export const UART_ID_WIDTH = Object.freeze({
  0x80: 2, 0x81: 2, 0x82: 2, 0x83: 2, 0x84: 2, 0x85: 1, 0x86: 1, 0x87: 2, 0x89: 4, 0x8a: 2, 0x8b: 2, 0x8c: 2,
  0x8e: 2, 0x8f: 2, 0x90: 2, 0x91: 2, 0x92: 2, 0x93: 2, 0x94: 2, 0x95: 2, 0x96: 2, 0x97: 2, 0x98: 2, 0x99: 2,
  0x9a: 2, 0x9b: 2, 0x9c: 2, 0x9d: 1, 0x9e: 2, 0x9f: 2, 0xa0: 2, 0xa1: 2, 0xa2: 2, 0xa3: 2, 0xa4: 2, 0xa5: 2,
  0xa6: 2, 0xa7: 2, 0xa8: 2, 0xa9: 1, 0xaa: 4, 0xab: 1, 0xac: 1, 0xad: 2, 0xae: 1, 0xaf: 1, 0xb0: 2, 0xb1: 1,
  0xb2: 10, 0xb3: 1, 0xb4: 8, 0xb5: 4, 0xb6: 4, 0xb7: 15, 0xb8: 1, 0xb9: 4, 0xba: 24, 0xbb: 1, 0xbc: 1, 0xbd: 1,
  0xbe: 2, 0xbf: 2, 0xc0: 1,
});

/**
 * Data ID to field name, type ('u' unsigned, 'i' signed, 'b' boolean, 'a' ASCII) and scale.
 * @type {Record<number, [string, 'u'|'i'|'b'|'a', number?]>}
 */
const UART_FIELDS = {
  0x80: ['temperatureMosRaw', 'u'],
  0x81: ['temperature1Raw', 'u'],
  0x82: ['temperature2Raw', 'u'],
  0x83: ['totalVoltage', 'u', 0.01],
  0x84: ['currentRaw', 'u'],
  0x85: ['soc', 'u'],
  0x86: ['temperatureSensorCount', 'u'],
  0x87: ['cycleCount', 'u'],
  0x89: ['totalCycleCapacity', 'u'],
  0x8a: ['cellCount', 'u'],
  0x8b: ['warnings', 'u'],
  0x8c: ['status', 'u'],
  0x8e: ['packOvp', 'u', 0.01],
  0x8f: ['packUvp', 'u', 0.01],
  0x90: ['cellOvp', 'u', 0.001],
  0x91: ['cellOvpr', 'u', 0.001],
  0x92: ['cellOvpDelay', 'u'],
  0x93: ['cellUvp', 'u', 0.001],
  0x94: ['cellUvpr', 'u', 0.001],
  0x95: ['cellUvpDelay', 'u'],
  0x96: ['cellDeltaProtection', 'u', 0.001],
  0x97: ['dischargeOcp', 'u'],
  0x98: ['dischargeOcpDelay', 'u'],
  0x99: ['chargeOcp', 'u'],
  0x9a: ['chargeOcpDelay', 'u'],
  0x9b: ['balanceStartVoltage', 'u', 0.001],
  0x9c: ['balanceTriggerVoltage', 'u', 0.001],
  0x9d: ['balancerSwitch', 'b'],
  0x9e: ['mosOtp', 'u'],
  0x9f: ['mosOtpr', 'u'],
  0xa0: ['boxOtp', 'u'],
  0xa1: ['boxOtpr', 'u'],
  0xa2: ['tempDiffProtection', 'u'],
  0xa3: ['chargeOtp', 'u'],
  0xa4: ['dischargeOtp', 'u'],
  0xa5: ['chargeUtp', 'i'],
  0xa6: ['chargeUtpr', 'i'],
  0xa7: ['dischargeUtp', 'i'],
  0xa8: ['dischargeUtpr', 'i'],
  0xa9: ['cellCountSetting', 'u'],
  0xaa: ['capacitySetting', 'u'],
  0xab: ['chargeSwitch', 'b'],
  0xac: ['dischargeSwitch', 'b'],
  0xad: ['currentCalibration', 'u', 0.001],
  0xae: ['boardAddress', 'u'],
  0xaf: ['batteryType', 'u'],
  0xb0: ['sleepWaitTime', 'u'],
  0xb1: ['lowCapacityAlarm', 'u'],
  0xb2: ['password', 'a'],
  0xb3: ['dedicatedCharger', 'b'],
  0xb4: ['deviceId', 'a'],
  0xb5: ['manufacturingDate', 'a'],
  0xb6: ['systemWorkingMinutes', 'u'],
  0xb7: ['softwareVersion', 'a'],
  0xb8: ['startCurrentCalibration', 'u'],
  0xb9: ['actualCapacity', 'u'],
  0xba: ['manufacturerId', 'a'],
  0xbb: ['restart', 'u'],
  0xbc: ['factoryReset', 'u'],
  0xbd: ['remoteUpgrade', 'u'],
  0xbe: ['gpsPowerOffVoltage', 'u', 0.001],
  0xbf: ['gpsPowerOnVoltage', 'u', 0.001],
  0xc0: ['protocolVersion', 'u'],
};

/**
 * Temperature code of IDs 0x80..0x82 (spec 6.6): 0..100 are degrees C, above 100 negative
 * (101 = -1 degrees C). Implementations disagree below 0 degrees C (unverified).
 * @param {number} raw
 */
export const uartTemperature = (raw) => (raw <= 100 ? raw : 100 - raw);

/**
 * Current of ID 0x84 (spec 6.6). Protocol version 1: bit 15 set = charging, magnitude in 10 mA;
 * otherwise (10000 - raw) x 0.01 A. Positive while charging.
 * @param {number} raw
 * @param {number} [protocolVersion]
 */
export function uartCurrent(raw, protocolVersion) {
  if (protocolVersion === 1) return z(r(((raw & 0x8000) !== 0 ? 1 : -1) * (raw & 0x7fff) * 0.01, 2));
  return z(r((10000 - raw) * 0.01, 2));
}

/**
 * Big endian unsigned integer of 1 to 4 bytes.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} n
 */
function uintBe(b, o, n) {
  let v = 0;
  for (let i = 0; i < n; i++) v = v * 256 + b[o + i];
  return v;
}

/**
 * Decode a 4E57 reply (BMS to host): header fields and the data ID / value list, parsed by ID
 * (spec 6.6). Unknown IDs stop the walk because their width is unknown; the rest is kept as hex.
 * @param {Uint8Array} frame validated frame
 * @returns {Record<string, any>}
 */
export function parseUartFrame(frame) {
  const L = u16be(frame, 2);
  const end = L - 7; // record number
  /** @type {Record<string, any>} */
  const out = {
    length: L,
    command: frame[8],
    source: frame[9],
    transportType: frame[10],
    recordNumber: u32be(frame, end),
    checksum: u16be(frame, L),
    checksumValid: sum16(frame, 0, L) === u16be(frame, L),
  };
  /** @type {number[]} */
  const ids = [];
  let o = 11;
  while (o < end) {
    const id = frame[o];
    if (id === UART_ID.CELLS) {
      // Byte count, then triplets of cell number (u8) and voltage (u16, mV).
      const n = frame[o + 1];
      if (o + 2 + n > end) {
        out.unparsedHex = hex(frame.subarray(o, end));
        break;
      }
      const cells = [];
      for (let k = 0; k + 3 <= n; k += 3) cells.push(r(u16be(frame, o + 3 + k) * 0.001, 3));
      out.cellVoltages = cells;
      out.cellBytes = n;
      ids.push(id);
      o += 2 + n;
      continue;
    }
    const w = UART_ID_WIDTH[id];
    const def = UART_FIELDS[id];
    if (!w || !def || o + 1 + w > end) {
      out.unparsedHex = hex(frame.subarray(o, end));
      break;
    }
    const [name, kind, scale] = def;
    const p = o + 1;
    if (kind === 'a') out[name] = ascii(frame, p, w);
    else if (kind === 'b') out[name] = frame[p] !== 0;
    else {
      let v = uintBe(frame, p, w);
      if (kind === 'i') v = w === 2 ? i16be(frame, p) : v;
      out[name] = scale ? z(r(v * scale, decimalsOf(scale))) : v;
    }
    ids.push(id);
    o += 1 + w;
  }
  out.ids = ids;
  if (out.temperatureMosRaw !== undefined) out.temperatureMos = uartTemperature(out.temperatureMosRaw);
  if (out.temperature1Raw !== undefined) out.temperature1 = uartTemperature(out.temperature1Raw);
  if (out.temperature2Raw !== undefined) out.temperature2 = uartTemperature(out.temperature2Raw);
  if (out.currentRaw !== undefined) out.current = uartCurrent(out.currentRaw, out.protocolVersion);
  return out;
}

/**
 * Decode a 4E57 request (host to BMS): data ID and value of reads and writes.
 * @param {Uint8Array} frame
 */
export function parseUartRequest(frame) {
  const L = u16be(frame, 2);
  const info = frame.subarray(11, L - 7);
  return {
    length: L,
    command: frame[8],
    source: frame[9],
    transportType: frame[10],
    dataId: info[0],
    ...(info.length > 1 ? { value: uintBe(info, 1, Math.min(4, info.length - 1)) } : {}),
    checksum: u16be(frame, L),
  };
}

/**
 * Probe check of a "read all" reply (spec 11.5): repeats the command (0x06, or 0x03 on some
 * units), source BMS, transport type reply, and a cell block whose byte count divides by 3.
 * @param {Uint8Array} frame
 */
export function isUartReadReply(frame) {
  if (!validateUartFrame(frame)) return false;
  if ((frame[8] !== UART_CMD.READ_ALL && frame[8] !== UART_CMD.READ) || frame[9] !== UART_SOURCE.BMS || frame[10] !== 0x01) return false;
  return frame[11] === UART_ID.CELLS && frame[12] % 3 === 0;
}

/**
 * 4E57 warning bits, ID 0x8B (spec 9.2).
 * @type {import('../common/util.js').AlarmBit[]}
 */
export const UART_WARNING_BITS = [
  { bit: 0, id: 'soc_low' },
  { bit: 1, id: 'mos_overtemperature' },
  { bit: 2, id: 'pack_overvoltage' },
  { bit: 3, id: 'pack_undervoltage' },
  { bit: 4, id: 'jk.battery_overtemperature', severity: 'protection', label: msg('Battery overtemperature') },
  { bit: 5, id: 'charge_overcurrent' },
  { bit: 6, id: 'discharge_overcurrent' },
  { bit: 7, id: 'cell_voltage_difference' },
  { bit: 8, id: 'jk.box_overtemperature', severity: 'protection', label: msg('Battery box overtemperature') },
  { bit: 9, id: 'jk.battery_undertemperature', severity: 'protection', label: msg('Battery low temperature') },
  { bit: 10, id: 'cell_overvoltage' },
  { bit: 11, id: 'cell_undervoltage' },
  { bit: 12, id: 'jk.protection_309a', severity: 'protection', label: msg('309_A protection') },
  { bit: 13, id: 'jk.protection_309b', severity: 'protection', label: msg('309_B protection') },
];

/**
 * Split the 0xB7 version string ("11.XW_S11.261__", "H6.X__S6.1.3S__") into hardware and
 * software parts (spec 10).
 * @param {string} [text]
 */
export function splitUartVersion(text) {
  const s = String(text ?? '');
  const i = s.indexOf('_S');
  const clean = (/** @type {string} */ t) => t.replace(/[_\s]+$/g, '').replace(/^[_\s]+/g, '');
  if (i < 0) return { hardwareVersion: undefined, softwareVersion: clean(s) || undefined };
  return { hardwareVersion: clean(s.slice(0, i)) || undefined, softwareVersion: clean(s.slice(i + 2)) || undefined };
}

// ---------------------------------------------------------------------------------------------
// Protocol log descriptions
// ---------------------------------------------------------------------------------------------

/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
/** @param {number} v */
const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** Names of requests and buttons (length 0) for the log. */
const COMMAND_NAMES = /** @type {Record<number, string>} */ ({
  [CMD.SETTINGS]: 'Settings request (0x96)',
  [CMD.DEVICE_INFO]: 'Device info request (0x97)',
  [CMD.EVENT_LOG]: 'Event log request (0xA1)',
  [CMD.SHUTDOWN]: 'Shutdown (0x65)',
  [CMD.RESTART]: 'Restart (0x66)',
  [CMD.FACTORY_RESET]: 'Factory reset (0x9D)',
  [CMD.PRESET_LIION]: 'Load Li-ion preset (0x68)',
  [CMD.PRESET_LFP]: 'Load LiFePO4 preset (0x69)',
  [CMD.PRESET_LTO]: 'Load LTO preset (0x6A)',
});

/**
 * Name of the setting written by a JK02/JK04 register for the log.
 * @param {number} register
 * @param {string} [variant]
 */
function registerName(register, variant) {
  if (variant === VARIANT.JK04) return JK04_SETTINGS_LAYOUT.find((s) => s.register === register)?.name;
  const small = is24(variant);
  const s = JK02_SETTINGS_LAYOUT.find((x) => (small ? x.reg24 : x.reg32) === register && (!small || !x.only32));
  if (s) return s.name;
  if (small) return undefined;
  const bit = CONTROL_BITS.find((b) => controlBitRegister(b.bit) === register);
  if (bit) return bit.name;
  const dev = JK02_DEVICE_SETTINGS.find((d) => d.register === register);
  if (dev) return dev.name;
  return { [CMD.EMERGENCY]: 'emergency', [CMD.SOC_CALIBRATION]: 'socCalibration', 0x64: 'voltageCalibration', 0x67: 'currentCalibration', 0x6c: 'timeCalibration' }[register];
}

/**
 * @param {Uint8Array} frame 20 byte command frame
 * @param {string} [variant]
 */
function describeCommand(frame, variant) {
  const c = parseCommandFrame(frame);
  const decode = () => c;
  if (c.register === CMD.ACK) return { name: 'ACK (0xC8)', decode };
  if (c.length === 0) return { name: COMMAND_NAMES[c.register] ?? `Command ${h2(c.register)}`, decode };
  const name = registerName(c.register, variant);
  return { name: `Write ${name ? `${name} ` : ''}(${h2(c.register)})`, decode };
}

/**
 * @param {Uint8Array} frame 300 byte data frame
 * @param {string} [variant]
 */
function describeDataFrame(frame, variant) {
  switch (frame[4]) {
    case FRAME_TYPE.SETTINGS:
      return { name: 'Settings frame (0x01)', decode: () => parseSettings(frame, variant ?? VARIANT.JK02_32S) };
    case FRAME_TYPE.CELL_INFO:
      return {
        name: 'Cell info frame (0x02)',
        decode: () => (variant === VARIANT.JK04 || (!variant && looksLikeJk04CellInfo(frame)) ? parseJk04CellInfo(frame) : parseCellInfo(frame, variant ?? VARIANT.JK02_32S)),
      };
    case FRAME_TYPE.DEVICE_INFO:
      return { name: 'Device info frame (0x03)', decode: () => parseDeviceInfo(frame) };
    case FRAME_TYPE.EVENT_LOG:
      return { name: 'Event log frame (0x05)', decode: () => parseEventLog(frame) };
    default:
      return { name: `Data frame (${h2(frame[4])})`, decode: () => parseDataFrameHeader(frame) };
  }
}

const PB_TRIGGER_NAMES = /** @type {Record<number, string>} */ ({
  [PB_TRIGGER.DEVICE_INFO]: 'device info',
  [PB_TRIGGER.SETTINGS]: 'settings',
  [PB_TRIGGER.CELL_INFO]: 'cell info',
});

/** @param {Uint8Array} frame */
function describeModbus(frame) {
  const fn = frame[1];
  if (fn & 0x80) return { name: `Modbus exception (${h2(fn)})`, decode: () => parseModbusResponse(frame) };
  if (fn === 0x10 && frame.length === 8) return { name: `Modbus write answer (${h4(u16be(frame, 2))})`, decode: () => parseModbusResponse(frame) };
  if (fn === 0x10 && frame.length >= 9) {
    const reg = u16be(frame, 2);
    const trigger = PB_TRIGGER_NAMES[reg];
    return { name: trigger ? `Trigger ${trigger} (${h4(reg)})` : `Modbus write (${h4(reg)})`, decode: () => parseModbusRequest(frame) };
  }
  if (fn === 0x03 && frame.length === 8) return { name: `Modbus read (${h4(u16be(frame, 2))})`, decode: () => parseModbusRequest(frame) };
  return null;
}

/** @param {Uint8Array} frame */
function describeUart(frame) {
  const command = frame[8];
  const fromBms = frame[9] === UART_SOURCE.BMS;
  const names = /** @type {Record<number, string>} */ ({ 1: 'activate', 2: 'write', 3: 'read', 5: 'pair code', 6: 'read all' });
  const what = names[command] ?? h2(command);
  if (fromBms) return { name: `4E57 reply: ${what} (${h2(command)})`, decode: () => parseUartFrame(frame) };
  return { name: `4E57 request: ${what} (${h2(command)})`, decode: () => parseUartRequest(frame) };
}

/**
 * Name and lazy decoder of any JK frame for the protocol log.
 * @param {Uint8Array} frame
 * @param {string} [variant] protocol variant of the connection, used for the data layouts
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describe(frame, variant) {
  if (!frame || frame.length < 4) return null;
  if (frame.length === DATA_FRAME_LENGTH && frame[0] === DATA_HEADER[0] && frame[1] === DATA_HEADER[1]) return describeDataFrame(frame, variant);
  if (frame.length === COMMAND_FRAME_LENGTH && frame[0] === COMMAND_HEADER[0] && frame[1] === COMMAND_HEADER[1]) return describeCommand(frame, variant);
  if (frame[0] === UART_HEADER[0] && frame[1] === UART_HEADER[1] && frame.length >= 21) return describeUart(frame);
  if (frame[0] <= 0x0f && frame.length >= 5) return describeModbus(frame);
  return null;
}
