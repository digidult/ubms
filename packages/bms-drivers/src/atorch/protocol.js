import { FrameAssembler, hexByte, setU16be, setU32be, sum8, u16be, u32be } from '@ubms/transport';
import { round } from '@ubms/bms-core';

/**
 * Atorch "FF 55" protocol (docs/protocols/atorch.md): 36 byte reports that Atorch meters and
 * electronic loads push about once per second, 10 byte commands (key presses, counter resets,
 * backlight and price), 8 byte replies, and the PX100 frames of the DL24 family
 * (`B1 B2 cmd d1 d2 B6`, answered by `6F` or `CA CB d1 d2 d3 CE CF`) on the same byte stream.
 *
 * Pure functions only: parsers, encoders, the frame assemblers, the checksum policy and the
 * passive detection helper. Values are engineering units (V, A, W, Ah, Wh, degC, s).
 */

/** Frame header of every FF 55 frame (spec 3.1). */
export const HEADER = Object.freeze([0xff, 0x55]);

/** Message types, byte 2 (spec 9.1). */
export const MSG = Object.freeze({ REPORT: 0x01, REPLY: 0x02, COMMAND: 0x11 });

export const REPORT_LENGTH = 36;
export const REPLY_LENGTH = 8;
export const COMMAND_LENGTH = 10;

/** The message type defines the length; there is no length byte (spec 3.1). */
export const FRAME_LENGTH = Object.freeze({ [MSG.REPORT]: REPORT_LENGTH, [MSG.REPLY]: REPLY_LENGTH, [MSG.COMMAND]: COMMAND_LENGTH });

/** Device types, byte 3 of reports and commands (spec 1.1, 9.2). */
export const DEVICE = Object.freeze({ AC: 0x01, DC: 0x02, USB: 0x03 });

/** `variant` of each device type (spec 11.3). */
export const VARIANTS = Object.freeze({ [DEVICE.AC]: 'AC_METER', [DEVICE.DC]: 'DC_METER', [DEVICE.USB]: 'USB_METER' });

/** FF 55 opcodes, byte 4 of a command (spec 5.1). */
export const OP = Object.freeze({
  RESET_ENERGY: 0x01,
  RESET_CAPACITY: 0x02,
  RESET_RUNTIME: 0x03,
  RESET_ALL: 0x05,
  PLUS: 0x11,
  MINUS: 0x12,
  SET_BACKLIGHT: 0x21,
  SET_PRICE: 0x22,
  SETUP: 0x31,
  ENTER: 0x32,
  PLUS_USB: 0x33,
  MINUS_USB: 0x34,
});

/** Opcode names (the `name` of the command vectors). */
export const OP_NAMES = Object.freeze({
  [OP.RESET_ENERGY]: 'resetEnergy',
  [OP.RESET_CAPACITY]: 'resetCapacity',
  [OP.RESET_RUNTIME]: 'resetRuntime',
  [OP.RESET_ALL]: 'resetAll',
  [OP.PLUS]: 'plus',
  [OP.MINUS]: 'minus',
  [OP.SET_BACKLIGHT]: 'setBacklight',
  [OP.SET_PRICE]: 'setPrice',
  [OP.SETUP]: 'setup',
  [OP.ENTER]: 'enter',
  [OP.PLUS_USB]: 'plusUsb',
  [OP.MINUS_USB]: 'minusUsb',
});

/**
 * Reply status, byte 4 of a reply (spec 6.4, 9.3). 0x02 means "failed" in [SY] and "wrong device
 * type" in [LP]; 0x05 and 0x06 come from [LP] only (unverified).
 */
export const STATUS = Object.freeze({ OK: 0x01, FAILED: 0x02, UNSUPPORTED: 0x03, WRONG_CLASS: 0x05, MALFORMED: 0x06 });

/** English meaning of each reply status (the `meaning` of the reply vectors). */
export const STATUS_MEANINGS = Object.freeze({
  [STATUS.OK]: 'ok',
  [STATUS.FAILED]: 'failed or wrong device type',
  [STATUS.UNSUPPORTED]: 'unsupported',
  [STATUS.WRONG_CLASS]: 'wrong message class',
  [STATUS.MALFORMED]: 'malformed frame',
});

/** Backlight byte: 0 keeps the backlight off, 60 keeps it on, 1..59 is a timeout in s (spec 9.4). */
export const BACKLIGHT = Object.freeze({ OFF: 0, ON: 60, MAX: 60 });

/** Price raw range: 0.01 units per kWh, 1..999999 (spec 5.1, 7.1). */
export const PRICE_RAW = Object.freeze({ MIN: 1, MAX: 999999 });

/**
 * PX100 commands and queries of the DL24 family (spec 3.5, 5.3, 9.5). Documented over USB serial
 * and Bluetooth SPP ([TS], [RT]); over BLE only [WH] uses them, so they are unverified on BLE.
 */
export const PX100 = Object.freeze({
  LOAD: 0x01,
  SET_CURRENT: 0x02,
  SET_CUTOFF: 0x03,
  SET_TIMER: 0x04,
  RESET: 0x05,
  Q_LOAD: 0x10,
  Q_VOLTAGE: 0x11,
  Q_CURRENT: 0x12,
  Q_TIME: 0x13,
  Q_CAPACITY: 0x14,
  Q_ENERGY: 0x15,
  Q_TEMPERATURE: 0x16,
  Q_CURRENT_SETTING: 0x17,
  Q_CUTOFF_SETTING: 0x18,
  Q_TIMER_SETTING: 0x19,
});

/** PX100 command names for the log. */
export const PX100_NAMES = Object.freeze({
  [PX100.LOAD]: 'load on/off',
  [PX100.SET_CURRENT]: 'set current',
  [PX100.SET_CUTOFF]: 'set cutoff voltage',
  [PX100.SET_TIMER]: 'set timer',
  [PX100.RESET]: 'reset counters',
  [PX100.Q_LOAD]: 'query load state',
  [PX100.Q_VOLTAGE]: 'query voltage',
  [PX100.Q_CURRENT]: 'query current',
  [PX100.Q_TIME]: 'query elapsed time',
  [PX100.Q_CAPACITY]: 'query capacity',
  [PX100.Q_ENERGY]: 'query energy',
  [PX100.Q_TEMPERATURE]: 'query temperature',
  [PX100.Q_CURRENT_SETTING]: 'query current setting',
  [PX100.Q_CUTOFF_SETTING]: 'query cutoff setting',
  [PX100.Q_TIMER_SETTING]: 'query timer setting',
});

export const PX100_ACK = 0x6f;
export const PX100_REQUEST_PREFIX = Object.freeze([0xb1, 0xb2]);
export const PX100_REQUEST_SUFFIX = 0xb6;
export const PX100_REPLY_PREFIX = Object.freeze([0xca, 0xcb]);
export const PX100_REPLY_SUFFIX = Object.freeze([0xce, 0xcf]);
export const PX100_REQUEST_LENGTH = 6;
export const PX100_REPLY_LENGTH = 7;

/** Reports in a row with a matching checksum before the checksum becomes mandatory ([KO] `CHECKSUM_PROOF`, spec 11.2 step 6). */
export const CHECKSUM_PROOF = 5;

/** Passive detection window (spec 11.2): about three reports. */
export const LISTEN_MS = 3000;
/** Two checksum-less reports must arrive this far apart to be accepted (spec 11.2 step 4). */
export const PAIR_MIN_MS = 500;
export const PAIR_MAX_MS = 2000;

// ---------------------------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------------------------

/**
 * Atorch checksum (spec 3.2): sum of the covered bytes modulo 256, XOR 0x44. The standard range
 * starts at the message type byte (2) and ends before the checksum byte.
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end] exclusive
 */
export function atorchChecksum(bytes, start = 2, end = bytes.length - 1) {
  return sum8(bytes, start, end) ^ 0x44;
}

/** Standard rule of spec 3.2. @param {Uint8Array} frame */
export function checksumValid(frame) {
  return frame.length >= 4 && frame[frame.length - 1] === atorchChecksum(frame, 2, frame.length - 1);
}

/** [DW] variant (sum from byte 3) seen on one J7-C (spec 3.2, unverified). @param {Uint8Array} frame */
export function checksumFrom3Valid(frame) {
  return frame.length >= 5 && frame[frame.length - 1] === atorchChecksum(frame, 3, frame.length - 1);
}

// ---------------------------------------------------------------------------------------------
// Frame classification
// ---------------------------------------------------------------------------------------------

/** @param {Uint8Array} f */
const isFf55 = (f) => f.length >= 3 && f[0] === HEADER[0] && f[1] === HEADER[1];

/** 36 byte report of device type 0x01..0x03 (checksum not checked). @param {Uint8Array} f */
export const isReportFrame = (f) => f.length === REPORT_LENGTH && isFf55(f) && f[2] === MSG.REPORT && f[3] >= DEVICE.AC && f[3] <= DEVICE.USB;

/** @param {Uint8Array} f */
export const isReplyFrame = (f) => f.length === REPLY_LENGTH && isFf55(f) && f[2] === MSG.REPLY;

/** @param {Uint8Array} f */
export const isCommandFrame = (f) => f.length === COMMAND_LENGTH && isFf55(f) && f[2] === MSG.COMMAND;

/** @param {Uint8Array} f */
export const isPx100Request = (f) => f.length === PX100_REQUEST_LENGTH && f[0] === 0xb1 && f[1] === 0xb2 && f[5] === PX100_REQUEST_SUFFIX;

/** @param {Uint8Array} f */
export const isPx100Ack = (f) => f.length === 1 && f[0] === PX100_ACK;

/** @param {Uint8Array} f */
export const isPx100Reply = (f) => f.length === PX100_REPLY_LENGTH && f[0] === 0xca && f[1] === 0xcb && f[5] === 0xce && f[6] === 0xcf;

// ---------------------------------------------------------------------------------------------
// Reports (spec 6.1 to 6.3)
// ---------------------------------------------------------------------------------------------

/**
 * Offsets that differ between the layouts: runtime (u16 hours, u8 minutes, u8 seconds), the
 * backlight byte and the ranges that were zero in every frame of the research (spec 11.2 step 4).
 * The bytes 28..34 of USB reports are not checked: the J7 family fills them (spec 12 item 20).
 */
const LAYOUT = Object.freeze({
  [DEVICE.AC]: { runtime: 26, backlight: 30, zero: [[31, 35]] },
  [DEVICE.DC]: {
    runtime: 26,
    backlight: 30,
    zero: [
      [20, 24],
      [31, 35],
    ],
  },
  [DEVICE.USB]: { runtime: 23, backlight: 27, zero: [] },
});

/** @param {Uint8Array} b @param {number} o */
export const u24be = (b, o) => ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;

/** @param {Uint8Array} b @param {number} o @param {number} v */
export function setU24be(b, o, v) {
  b[o] = (v >>> 16) & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = v & 0xff;
}

/**
 * Plausibility checks for reports without a valid checksum (spec 11.2 step 4). Returns null when
 * the report passes, otherwise a short English reason for the log.
 * @param {Uint8Array} frame
 * @returns {string | null}
 */
export function reportProblem(frame) {
  if (!isReportFrame(frame)) return 'not a report of device type 1 to 3';
  const l = LAYOUT[/** @type {1|2|3} */ (frame[3])];
  if (frame[l.runtime + 2] > 59) return 'runtime minutes above 59';
  if (frame[l.runtime + 3] > 59) return 'runtime seconds above 59';
  if (frame[l.backlight] > BACKLIGHT.MAX) return 'backlight above 60';
  for (const [from, to] of l.zero) {
    for (let i = from; i < to; i++) if (frame[i] !== 0) return `byte ${i} is not zero`;
  }
  return null;
}

/** @param {Uint8Array} frame */
export const isReportPlausible = (frame) => reportProblem(frame) === null;

/**
 * @typedef {Object} AtorchReport
 * @property {1} messageType
 * @property {number} deviceType 1 AC, 2 DC, 3 USB
 * @property {string} variant
 * @property {number} voltage V
 * @property {number} current A, unsigned magnitude (no device sends a sign, spec 12 item 6)
 * @property {number} power W: transmitted by AC meters, V x I for DC and USB reports
 * @property {number} energy Wh (AC and DC in 10 Wh steps, USB in 0.01 Wh)
 * @property {number} [capacity] Ah (DC 0.01 Ah, USB 0.001 Ah)
 * @property {number} [price] per kWh (AC, DC)
 * @property {number} [frequency] Hz (AC)
 * @property {number} [powerFactor] (AC)
 * @property {number} [dataMinus] V, USB D- at offset 17 (order unverified, spec 6.3)
 * @property {number} [dataPlus] V, USB D+ at offset 19 (order unverified, spec 6.3)
 * @property {number} temperature degC, integer
 * @property {number} runtimeHours
 * @property {number} runtimeMinutes
 * @property {number} runtimeSeconds
 * @property {number} runtime s
 * @property {number} backlight s (0 always off, 60 always on)
 * @property {number} checksum last byte
 * @property {boolean} checksumValid standard rule of spec 3.2
 * @property {boolean} checksumFrom3Valid [DW] variant
 */

/**
 * Decode a report with the layout of its device type byte (spec 6.1 to 6.3).
 * @param {Uint8Array} frame
 * @returns {AtorchReport}
 */
export function parseReport(frame) {
  if (!isReportFrame(frame)) throw new Error('Not an Atorch report frame');
  const deviceType = frame[3];
  const l = LAYOUT[/** @type {1|2|3} */ (deviceType)];
  // Zero on the DT3010, AT3010 and DL24M firmware 2.0; fixed at 10:00:00 on a DL24 sold in 2025
  // (one source, unverified, spec 12 item 7).
  const runtimeHours = u16be(frame, l.runtime);
  const runtimeMinutes = frame[l.runtime + 2];
  const runtimeSeconds = frame[l.runtime + 3];
  const base = {
    messageType: /** @type {1} */ (MSG.REPORT),
    deviceType,
    variant: VARIANTS[/** @type {1|2|3} */ (deviceType)],
    runtimeHours,
    runtimeMinutes,
    runtimeSeconds,
    runtime: runtimeHours * 3600 + runtimeMinutes * 60 + runtimeSeconds,
    backlight: frame[l.backlight],
    checksum: frame[35],
    checksumValid: checksumValid(frame),
    checksumFrom3Valid: checksumFrom3Valid(frame),
  };
  if (deviceType === DEVICE.AC) {
    return {
      ...base,
      voltage: u24be(frame, 4) / 10,
      current: u24be(frame, 7) / 1000,
      // Active power in 0.1 W; syssi decodes these bytes as capacity, which is wrong (spec 6.1).
      power: u24be(frame, 10) / 10,
      // 0.01 kWh per raw unit (spec 6.1, 12 item 3).
      energy: u32be(frame, 13) * 10,
      price: u24be(frame, 17) / 100,
      frequency: u16be(frame, 20) / 10,
      powerFactor: u16be(frame, 22) / 1000,
      temperature: u16be(frame, 24),
    };
  }
  if (deviceType === DEVICE.DC) {
    const voltage = u24be(frame, 4) / 10;
    const current = u24be(frame, 7) / 1000;
    return {
      ...base,
      voltage,
      current,
      // Not transmitted for type 0x02 (spec 6.2).
      power: round(voltage * current, 6),
      // Device defined: on the DT24TW-300A it falls while discharging (one source, unverified, spec 12 item 19).
      capacity: u24be(frame, 10) / 100,
      energy: u32be(frame, 13) * 10,
      price: u24be(frame, 17) / 100,
      temperature: u16be(frame, 24),
    };
  }
  const voltage = u24be(frame, 4) / 100;
  const current = u24be(frame, 7) / 100;
  return {
    ...base,
    voltage,
    current,
    power: round(voltage * current, 6),
    capacity: u24be(frame, 10) / 1000,
    energy: u32be(frame, 13) / 100,
    // D- at 17 and D+ at 19 per [MS], [NL], [SY], [LP]; [DV] and [DW] say the reverse (unverified).
    dataMinus: u16be(frame, 17) / 100,
    dataPlus: u16be(frame, 19) / 100,
    temperature: u16be(frame, 21),
  };
}

/** @param {number | undefined} v @param {number} unit @param {number} max */
const rawRound = (v, unit, max) => Math.max(0, Math.min(max, Math.round((v ?? 0) / unit)));
/** Counters keep whole units (truncate). @param {number | undefined} v @param {number} unit @param {number} max */
const rawFloor = (v, unit, max) => Math.max(0, Math.min(max, Math.floor((v ?? 0) / unit + 1e-6)));

const U16 = 0xffff;
const U24 = 0xffffff;
const U32 = 0xffffffff;

/**
 * @typedef {Object} ReportFields engineering values to encode (device side, simulator and tests)
 * @property {number} deviceType
 * @property {number} [voltage]
 * @property {number} [current]
 * @property {number} [power] AC only (DC and USB reports carry no power)
 * @property {number} [energy] Wh
 * @property {number} [capacity] Ah (DC, USB)
 * @property {number} [price] (AC, DC)
 * @property {number} [frequency] (AC)
 * @property {number} [powerFactor] (AC)
 * @property {number} [dataMinus] (USB)
 * @property {number} [dataPlus] (USB)
 * @property {number} [temperature]
 * @property {number} [runtime] s
 * @property {number} [backlight]
 */

/**
 * Build a report frame (device side). `checksum` selects the last byte: 'valid' (spec 3.2),
 * 'from3' ([DW] variant), 'invalid' (fails both rules) or a fixed byte value (DT24TW-300A sends
 * 0x23 in every frame).
 * @param {ReportFields} r
 * @param {{ checksum?: 'valid'|'from3'|'invalid'|number }} [opts]
 */
export function encodeReport(r, { checksum = 'valid' } = {}) {
  const l = LAYOUT[/** @type {1|2|3} */ (r.deviceType)];
  if (!l) throw new RangeError(`Unknown Atorch device type ${r.deviceType}`);
  const f = new Uint8Array(REPORT_LENGTH);
  f[0] = HEADER[0];
  f[1] = HEADER[1];
  f[2] = MSG.REPORT;
  f[3] = r.deviceType;
  const runtime = Math.max(0, Math.floor(r.runtime ?? 0));
  setU16be(f, l.runtime, Math.min(U16, Math.floor(runtime / 3600)));
  f[l.runtime + 2] = Math.floor(runtime / 60) % 60;
  f[l.runtime + 3] = runtime % 60;
  f[l.backlight] = rawRound(r.backlight ?? BACKLIGHT.ON, 1, 0xff);
  if (r.deviceType === DEVICE.USB) {
    setU24be(f, 4, rawRound(r.voltage, 0.01, U24));
    setU24be(f, 7, rawRound(r.current, 0.01, U24));
    setU24be(f, 10, rawFloor(r.capacity, 0.001, U24));
    setU32be(f, 13, rawFloor(r.energy, 0.01, U32));
    setU16be(f, 17, rawRound(r.dataMinus, 0.01, U16));
    setU16be(f, 19, rawRound(r.dataPlus, 0.01, U16));
    setU16be(f, 21, rawRound(r.temperature, 1, U16));
  } else {
    setU24be(f, 4, rawRound(r.voltage, 0.1, U24));
    setU24be(f, 7, rawRound(r.current, 0.001, U24));
    if (r.deviceType === DEVICE.AC) {
      setU24be(f, 10, rawRound(r.power, 0.1, U24));
      setU16be(f, 20, rawRound(r.frequency, 0.1, U16));
      setU16be(f, 22, rawRound(r.powerFactor, 0.001, U16));
    } else {
      setU24be(f, 10, rawFloor(r.capacity, 0.01, U24));
    }
    setU32be(f, 13, rawFloor(r.energy, 10, U32));
    setU24be(f, 17, rawRound(r.price, 0.01, U24));
    setU16be(f, 24, rawRound(r.temperature, 1, U16));
  }
  const standard = atorchChecksum(f, 2, REPORT_LENGTH - 1);
  f[35] =
    checksum === 'valid'
      ? standard
      : checksum === 'from3'
        ? atorchChecksum(f, 3, REPORT_LENGTH - 1)
        : checksum === 'invalid'
          ? standard ^ 0x80 // never equals the standard nor the byte 3 rule
          : checksum & 0xff;
  return f;
}

// ---------------------------------------------------------------------------------------------
// Commands and replies (spec 3.4, 5.2, 6.4)
// ---------------------------------------------------------------------------------------------

/**
 * Command frame: `FF 55 11 <device type> <opcode> <value u32 BE> <checksum>` (spec 3.4). The
 * device type must equal the type byte of the reports (spec 12 item 15). The checksum is always
 * the correct one: whether the DL24 firmware checks it is unverified (spec 5.2).
 * @param {number} deviceType
 * @param {number} opcode
 * @param {number} [value]
 */
export function encodeCommand(deviceType, opcode, value = 0) {
  if (!Number.isInteger(value) || value < 0 || value > U32) throw new RangeError(`Command value out of range: ${value}`);
  const f = new Uint8Array(COMMAND_LENGTH);
  f[0] = HEADER[0];
  f[1] = HEADER[1];
  f[2] = MSG.COMMAND;
  f[3] = deviceType & 0xff;
  f[4] = opcode & 0xff;
  setU32be(f, 5, value);
  f[9] = atorchChecksum(f, 2, COMMAND_LENGTH - 1);
  return f;
}

/**
 * Backlight time command (opcode 0x21): 0 always off, 1..59 s, 60 always on.
 * @param {number} deviceType
 * @param {number} seconds
 */
export function backlightCommand(deviceType, seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > BACKLIGHT.MAX) throw new RangeError(`Backlight out of range: ${seconds}`);
  return encodeCommand(deviceType, OP.SET_BACKLIGHT, seconds);
}

/**
 * Price per kWh command (opcode 0x22): raw = price x 100, 1..999999 ([NL] UI).
 * @param {number} deviceType
 * @param {number} price
 */
export function priceCommand(deviceType, price) {
  const raw = Math.round(price * 100);
  if (!Number.isFinite(raw) || raw < PRICE_RAW.MIN || raw > PRICE_RAW.MAX) throw new RangeError(`Price out of range: ${price}`);
  return encodeCommand(deviceType, OP.SET_PRICE, raw);
}

/**
 * @param {Uint8Array} frame
 * @returns {{ messageType: number, deviceType: number, command: number, name: string, value: number, checksum: number, checksumValid: boolean, backlight?: number, price?: number }}
 */
export function parseCommand(frame) {
  if (!isCommandFrame(frame)) throw new Error('Not an Atorch command frame');
  const command = frame[4];
  const value = u32be(frame, 5);
  return {
    messageType: frame[2],
    deviceType: frame[3],
    command,
    name: OP_NAMES[/** @type {keyof typeof OP_NAMES} */ (command)] ?? 'unknown',
    value,
    checksum: frame[9],
    checksumValid: checksumValid(frame),
    ...(command === OP.SET_BACKLIGHT ? { backlight: value } : {}),
    ...(command === OP.SET_PRICE ? { price: value / 100 } : {}),
  };
}

/**
 * Reply frame (device side): `FF 55 02 <reply type> <status> 00 00 <checksum>` (spec 6.4).
 * @param {number} status
 * @param {number} [replyType] 0x01 in every observed reply
 */
export function encodeReply(status, replyType = 0x01) {
  const f = Uint8Array.from([HEADER[0], HEADER[1], MSG.REPLY, replyType & 0xff, status & 0xff, 0, 0, 0]);
  f[7] = atorchChecksum(f, 2, REPLY_LENGTH - 1);
  return f;
}

/**
 * @param {Uint8Array} frame
 * @returns {{ messageType: number, replyType: number, status: number, checksumValid: boolean, meaning: string }}
 */
export function parseReply(frame) {
  if (!isReplyFrame(frame)) throw new Error('Not an Atorch reply frame');
  const status = frame[4];
  return {
    messageType: frame[2],
    replyType: frame[3],
    status,
    checksumValid: checksumValid(frame),
    meaning: STATUS_MEANINGS[/** @type {keyof typeof STATUS_MEANINGS} */ (status)] ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------------------------
// PX100 frames (spec 3.5, 5.3, 6.5)
// ---------------------------------------------------------------------------------------------

/**
 * PX100 request `B1 B2 cmd d1 d2 B6` (no checksum).
 * @param {number} cmd
 * @param {number} [d1]
 * @param {number} [d2]
 */
export function px100Request(cmd, d1 = 0, d2 = 0) {
  return Uint8Array.from([0xb1, 0xb2, cmd & 0xff, d1 & 0xff, d2 & 0xff, PX100_REQUEST_SUFFIX]);
}

/** Explicit load on / off (command 0x01, not a toggle). @param {boolean} on */
export const px100Load = (on) => px100Request(PX100.LOAD, on ? 1 : 0, 0);

/**
 * Whole units and hundredths, as d1 and d2 (1.50 A = `01 32`). @param {number} value
 * @returns {[number, number]}
 */
export function px100Split(value) {
  const hundredths = Math.round(value * 100);
  if (!Number.isFinite(hundredths) || hundredths < 0 || hundredths > 255 * 100 + 99) throw new RangeError(`PX100 value out of range: ${value}`);
  return [Math.floor(hundredths / 100), hundredths % 100];
}

/** Load current in A (command 0x02). @param {number} amps */
export const px100SetCurrent = (amps) => px100Request(PX100.SET_CURRENT, ...px100Split(amps));

/** Cutoff voltage in V (command 0x03). @param {number} volts */
export const px100SetCutoff = (volts) => px100Request(PX100.SET_CUTOFF, ...px100Split(volts));

/** Timer in s, u16 BE (command 0x04); the device keeps whole minutes ([WH], unverified). @param {number} seconds */
export function px100SetTimer(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > U16) throw new RangeError(`PX100 timer out of range: ${seconds}`);
  return px100Request(PX100.SET_TIMER, seconds >>> 8, seconds & 0xff);
}

/** Query (0x10..0x19). @param {number} query */
export const px100Query = (query) => px100Request(query, 0, 0);

/**
 * @param {Uint8Array} frame
 * @returns {{ frame: 'px100', command: number, d1: number, d2: number, name: string, loadOn?: boolean, current?: number, cutoffVoltage?: number, timer?: number }}
 */
export function parsePx100Request(frame) {
  if (!isPx100Request(frame)) throw new Error('Not a PX100 request');
  const [command, d1, d2] = [frame[2], frame[3], frame[4]];
  /** @type {ReturnType<typeof parsePx100Request>} */
  const out = { frame: 'px100', command, d1, d2, name: PX100_NAMES[/** @type {keyof typeof PX100_NAMES} */ (command)] ?? 'unknown' };
  if (command === PX100.LOAD) out.loadOn = d1 === 1;
  if (command === PX100.SET_CURRENT) out.current = d1 + d2 / 100;
  if (command === PX100.SET_CUTOFF) out.cutoffVoltage = d1 + d2 / 100;
  if (command === PX100.SET_TIMER) out.timer = (d1 << 8) | d2;
  return out;
}

/**
 * PX100 query answer (device side): `CA CB d1 d2 d3 CE CF`, value u24 BE.
 * @param {number} value
 */
export function encodePx100Reply(value) {
  const v = Math.max(0, Math.min(U24, Math.round(value)));
  return Uint8Array.from([0xca, 0xcb, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, 0xce, 0xcf]);
}

/** h, min, s packed into d1 d2 d3 (queries 0x13 and 0x19). @param {number} seconds */
export function px100TimeValue(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return (Math.min(255, Math.floor(s / 3600)) << 16) | ((Math.floor(s / 60) % 60) << 8) | s % 60;
}

/**
 * Decode a query answer. With `query`, the value is converted to engineering units
 * (spec 5.3): `loadOn`, `voltage`, `current`, `elapsed`, `capacity`, `energy`, `temperature`,
 * `cutoffVoltage` or `timer`.
 * @param {Uint8Array} frame
 * @param {number} [query]
 */
export function parsePx100Reply(frame, query) {
  if (!isPx100Reply(frame)) throw new Error('Not a PX100 answer');
  const [d1, d2, d3] = [frame[2], frame[3], frame[4]];
  const value = (d1 << 16) | (d2 << 8) | d3;
  /** @type {{ frame: 'px100-reply', value: number, d1: number, d2: number, d3: number, loadOn?: boolean, voltage?: number, current?: number, elapsed?: number, capacity?: number, energy?: number, temperature?: number, cutoffVoltage?: number, timer?: number }} */
  const out = { frame: 'px100-reply', value, d1, d2, d3 };
  switch (query) {
    case PX100.Q_LOAD:
      out.loadOn = value !== 0;
      break;
    case PX100.Q_VOLTAGE:
      out.voltage = value / 1000;
      break;
    case PX100.Q_CURRENT:
      out.current = value / 1000;
      break;
    case PX100.Q_TIME:
      out.elapsed = d1 * 3600 + d2 * 60 + d3;
      break;
    case PX100.Q_CAPACITY:
      out.capacity = value / 1000;
      break;
    case PX100.Q_ENERGY:
      out.energy = value / 1000;
      break;
    case PX100.Q_TEMPERATURE:
      out.temperature = value;
      break;
    case PX100.Q_CURRENT_SETTING:
      out.current = value / 100;
      break;
    case PX100.Q_CUTOFF_SETTING:
      out.cutoffVoltage = value / 100;
      break;
    case PX100.Q_TIMER_SETTING:
      out.timer = d1 * 3600 + d2 * 60 + d3;
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checksum policy and passive detection (spec 11.2)
// ---------------------------------------------------------------------------------------------

/**
 * Learns from the stream whether the device computes the checksum (spec 11.2 step 6, after [KO]
 * `ReportStream`): until a rule is learned, a report passes with a valid checksum or with the
 * plausibility checks; once `proof` reports in a row matched the standard rule (or the [DW]
 * byte 3 variant), reports that fail that rule are rejected.
 */
export class ChecksumPolicy {
  /** @param {{ proof?: number }} [opts] */
  constructor({ proof = CHECKSUM_PROOF } = {}) {
    this.proof = proof;
    /** @type {'standard'|'from3'|null} learned rule */
    this.rule = null;
    this.streak = { standard: 0, from3: 0 };
  }

  /** Whether a report frame is accepted under the current state. @param {Uint8Array} frame */
  accepts(frame) {
    if (!isReportFrame(frame)) return false;
    if (this.rule === 'standard') return checksumValid(frame);
    if (this.rule === 'from3') return checksumFrom3Valid(frame);
    return checksumValid(frame) || isReportPlausible(frame);
  }

  /**
   * Learn from an accepted report. Returns the rule learned by this report, or null.
   * @param {Uint8Array} frame
   * @returns {'standard'|'from3'|null}
   */
  observe(frame) {
    if (this.rule) return null;
    const standard = checksumValid(frame);
    // Both rules differ by the message type byte (0x01), so they never match the same frame.
    const from3 = !standard && checksumFrom3Valid(frame);
    this.streak.standard = standard ? this.streak.standard + 1 : 0;
    this.streak.from3 = from3 ? this.streak.from3 + 1 : 0;
    if (this.streak.standard >= this.proof) this.rule = 'standard';
    else if (this.streak.from3 >= this.proof) this.rule = 'from3';
    return this.rule;
  }

  /** The report passed the learned rule (the standard rule while none is learned). @param {Uint8Array} frame */
  valid(frame) {
    return this.rule === 'from3' ? checksumFrom3Valid(frame) : checksumValid(frame);
  }
}

/**
 * @typedef {Object} DetectionResult
 * @property {number} deviceType
 * @property {string} variant
 * @property {number} confidence
 * @property {boolean} checksum the accepted report carried a valid checksum
 */

/**
 * Passive detection (spec 11.2 steps 3 and 4): a report with a valid checksum is accepted with
 * high confidence; otherwise two plausible reports of the same device type that arrive
 * 0.5 to 2 s apart are accepted with lower confidence (higher when the name looks like Atorch).
 */
export class ReportDetector {
  /** @param {{ nameMatch?: boolean }} [opts] */
  constructor({ nameMatch = false } = {}) {
    this.nameMatch = nameMatch;
    /** @type {{ deviceType: number, at: number }[]} */
    this.recent = [];
    /** @type {DetectionResult | null} */
    this.result = null;
  }

  /**
   * @param {Uint8Array} frame
   * @param {number} at arrival time, ms
   * @returns {DetectionResult | null}
   */
  push(frame, at) {
    if (this.result) return this.result;
    if (!isReportFrame(frame)) return null;
    const deviceType = frame[3];
    const variant = VARIANTS[/** @type {1|2|3} */ (deviceType)];
    if (checksumValid(frame)) {
      this.result = { deviceType, variant, confidence: 0.9, checksum: true };
      return this.result;
    }
    if (!isReportPlausible(frame)) return null;
    const pair = this.recent.some((r) => r.deviceType === deviceType && at - r.at >= PAIR_MIN_MS && at - r.at <= PAIR_MAX_MS);
    this.recent = [...this.recent.filter((r) => at - r.at <= PAIR_MAX_MS), { deviceType, at }].slice(-8);
    if (!pair) return null;
    this.result = { deviceType, variant, confidence: this.nameMatch ? 0.7 : 0.6, checksum: false };
    return this.result;
  }
}

// ---------------------------------------------------------------------------------------------
// Frame assemblers (spec 3.3)
// ---------------------------------------------------------------------------------------------

/**
 * Host side assembler: FF 55 reports, replies and command echoes (the latter are noise, spec 3.3),
 * plus PX100 answers. `6F` and `CA CB .. CE CF` are recognised only while a PX100 request of the
 * matching kind is in flight (`px100()` returns 'set' or 'query'), and never inside an FF 55
 * frame. Reports are validated by the checksum policy, which learns from every accepted report.
 * On a failed validation only the first byte is dropped, so `FF 55` inside data is resynced.
 * @param {Object} opts
 * @param {(frame: Uint8Array) => void} opts.onFrame
 * @param {(bytes: Uint8Array, reason: string) => void} [opts.onDiscard]
 * @param {ChecksumPolicy} [opts.policy]
 * @param {() => ('set'|'query'|null|undefined)} [opts.px100] kind of the PX100 request in flight
 * @param {(rule: 'standard'|'from3') => void} [opts.onRule] called once when a checksum rule is learned
 */
export function createHostAssembler({ onFrame, onDiscard, policy = new ChecksumPolicy(), px100 = () => null, onRule }) {
  return new FrameAssembler({
    sync: [HEADER, PX100_REPLY_PREFIX, [PX100_ACK]],
    length: (buf) => {
      if (buf[0] === HEADER[0]) {
        if (buf.length < 3) return 0;
        return FRAME_LENGTH[/** @type {keyof typeof FRAME_LENGTH} */ (buf[2])] ?? -1;
      }
      const pending = px100();
      if (buf[0] === PX100_ACK) return pending === 'set' ? 1 : -1;
      return pending === 'query' ? PX100_REPLY_LENGTH : -1;
    },
    validate: (frame) => {
      if (frame[0] === HEADER[0]) {
        if (frame[2] === MSG.REPORT) return policy.accepts(frame);
        if (frame[2] === MSG.REPLY) {
          if (checksumValid(frame)) return true;
          // Replies carried a valid checksum in every source; a device whose reports never had
          // one is given the benefit of the doubt when the reply is well formed.
          return policy.rule !== 'standard' && frame[3] <= 0x01 && frame[4] <= STATUS.MALFORMED && frame[5] === 0 && frame[6] === 0;
        }
        return checksumValid(frame);
      }
      if (frame[0] === PX100_ACK) return true;
      return frame[5] === PX100_REPLY_SUFFIX[0] && frame[6] === PX100_REPLY_SUFFIX[1];
    },
    onFrame: (frame) => {
      if (frame[0] === HEADER[0] && frame[2] === MSG.REPORT) {
        const learned = policy.observe(frame);
        if (learned) onRule?.(learned);
      }
      onFrame(frame);
    },
    onDiscard,
    maxLength: REPORT_LENGTH,
  });
}

/**
 * Device side assembler (simulator): 10 byte FF 55 commands and 6 byte PX100 requests.
 * @param {Object} opts
 * @param {(frame: Uint8Array) => void} opts.onFrame
 * @param {(bytes: Uint8Array, reason: string) => void} [opts.onDiscard]
 */
export function createDeviceAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [HEADER, PX100_REQUEST_PREFIX],
    length: (buf) => (buf[0] === HEADER[0] ? COMMAND_LENGTH : PX100_REQUEST_LENGTH),
    validate: (frame) => frame[0] === HEADER[0] || frame[5] === PX100_REQUEST_SUFFIX,
    onFrame,
    onDiscard,
    maxLength: COMMAND_LENGTH,
  });
}

// ---------------------------------------------------------------------------------------------
// Log descriptions
// ---------------------------------------------------------------------------------------------

/**
 * Name and lazy decoder of a frame for the protocol log (both directions).
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode: () => any } | null}
 */
export function describe(frame) {
  if (isReportFrame(frame)) return { name: `Report (${VARIANTS[/** @type {1|2|3} */ (frame[3])]})`, decode: () => parseReport(frame) };
  if (isReplyFrame(frame)) return { name: `Reply: ${parseReply(frame).meaning}`, decode: () => parseReply(frame) };
  if (isCommandFrame(frame)) {
    const name = OP_NAMES[/** @type {keyof typeof OP_NAMES} */ (frame[4])] ?? `opcode ${hexByte(frame[4])}`;
    return { name: `Command ${name}`, decode: () => parseCommand(frame) };
  }
  if (isPx100Request(frame)) {
    const name = PX100_NAMES[/** @type {keyof typeof PX100_NAMES} */ (frame[2])] ?? `command ${hexByte(frame[2])}`;
    return { name: `PX100 ${name}`, decode: () => parsePx100Request(frame) };
  }
  if (isPx100Ack(frame)) return { name: 'PX100 acknowledgement', decode: () => ({ frame: 'px100-ack' }) };
  if (isPx100Reply(frame)) return { name: 'PX100 answer', decode: () => parsePx100Reply(frame) };
  return null;
}
