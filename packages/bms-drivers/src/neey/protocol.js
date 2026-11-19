import { FrameAssembler, ascii, asciiBytes, setU16le, setU32le, startsWith, sum8, u16le, u32le, xor8 } from '@ubms/transport';

/**
 * NEEY / Heltec / EnerKey active balancers ("AA 55 11" protocol), pure functions without I/O.
 * Specification: docs/protocols/neey.md ("spec" below).
 *
 * - Requests (host to balancer) are always 20 bytes: `AA 55 11 <function> <command> <register>
 *   14 00 <value u32 / f32 LE> 00 x6 <sum8> FF` (spec 3.1); the old NEEY app used xor8 instead
 *   of sum8, the only form seen reaching GW SW-1.1.0 (spec 3.3, 3.4).
 * - Answers start with `55 AA 11` and carry their total length as u16 LE at offset 6 (20, 100,
 *   150 or 300 bytes), then sum8 of everything before it and the end marker 0xFF (spec 3.2).
 * - Numbers are little-endian; most values are IEEE 754 float32 (spec 0).
 *
 * Parsers return plain objects whose field names match the test vectors
 * (packages/bms-drivers/test/vectors/neey.json). Values are the raw protocol units (V, A, Ah,
 * degrees C, s, and ohm for the lead resistances) and floats are not rounded, so the encoders
 * reproduce captured frames byte for byte. The driver rounds and converts for the unified model.
 */

/** Protocol variants (spec 1.2): the settings frame length tells them apart (spec 1.3). */
export const VARIANT = Object.freeze({ V1: 'NEEY_V1', V2: 'NEEY_V2' });

export const REQUEST_START = Object.freeze([0xaa, 0x55]);
export const ANSWER_START = Object.freeze([0x55, 0xaa]);
/** Fixed device address at byte 2 of every frame (spec 3.1). */
export const ADDRESS = 0x11;
export const END_MARKER = 0xff;
/** `55 AA 11`: the answer preamble the assembler searches for (spec 3.5). */
export const ANSWER_SYNC = Object.freeze([0x55, 0xaa, ADDRESS]);
/** `AA 55 11`: the request preamble (device side assembler of the simulator). */
export const REQUEST_SYNC = Object.freeze([0xaa, 0x55, ADDRESS]);

export const REQUEST_LENGTH = 20;
/** [SY] MIN_RESPONSE_SIZE and MAX_RESPONSE_SIZE (spec 3.5). */
export const MIN_ANSWER_LENGTH = 20;
export const MAX_ANSWER_LENGTH = 300;

/** Byte 3 (spec 3.1). */
export const FUNCTION = Object.freeze({ WRITE: 0x00, READ: 0x01 });

/** Byte 4 (spec 3.1, 5). */
export const COMMAND = Object.freeze({ DEVICE_INFO: 0x01, CELL_INFO: 0x02, FACTORY: 0x03, SETTINGS: 0x04, WRITE: 0x05, WRITE_V2: 0x06 });

/** Answer lengths (spec 3.2). */
export const FRAME_LENGTH = Object.freeze({ SHORT: 20, DEVICE_INFO: 100, FACTORY: 100, SETTINGS_V1: 100, SETTINGS_V2: 150, CELL_INFO: 300 });

/**
 * Registers of write command 0x05 (spec 5.2, 7.1).
 * - BALANCER_SWITCH: captured write followed by a settings frame with the new value (GW SW-1.1.0,
 *   EK ZH-1.2.9, EK-B24S8E200A), the only register with a captured read-back.
 * - TRIGGER_DELTA, MAX_CURRENT, SLEEP_VOLTAGE, START_VOLTAGE, NOMINAL_CAPACITY: the encoding is
 *   captured only as xor8 requests of the old NEEY app to GW SW-1.1.0 and ZH-1.2.3, without a
 *   settings frame after them in the capture (MAX_CURRENT: the balance current of the following
 *   cell frames follows the written value). The sum8 form ubms sends is computed. On EK firmware
 *   the registers rest on their use by [SY] and [BSC], the maintainer's note for ZH-2.1.1 and one
 *   user report for MAX_CURRENT on an EK-24S20EB.
 * - CELL_COUNT, BUZZER_MODE, BATTERY_TYPE, STOP_DELTA, DEVICE_NAME: from the command table of the
 *   vendor app or one open source project only, without a capture (unverified, never written by
 *   ubms).
 */
export const REGISTER = Object.freeze({
  CELL_COUNT: 0x01,
  TRIGGER_DELTA: 0x02,
  MAX_CURRENT: 0x03,
  SLEEP_VOLTAGE: 0x04,
  BALANCER_SWITCH: 0x0d,
  DEVICE_NAME: 0x13,
  BUZZER_MODE: 0x14,
  BATTERY_TYPE: 0x15,
  NOMINAL_CAPACITY: 0x16,
  START_VOLTAGE: 0x17,
  STOP_DELTA: 0x1a,
});

/**
 * Factory and calibration registers 0x05..0x12 of command 0x05 (spec 5.2, "dev mode" panel of the
 * app, meanings unverified). ubms never writes them.
 */
export const FACTORY_REGISTERS = Object.freeze([0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0e, 0x0f, 0x10, 0x11, 0x12]);

/** Command 0x05 registers whose value is a float32 (spec 5.2). */
const FLOAT_REGISTERS = new Set([REGISTER.TRIGGER_DELTA, REGISTER.MAX_CURRENT, REGISTER.SLEEP_VOLTAGE, REGISTER.START_VOLTAGE, REGISTER.STOP_DELTA]);

/**
 * Registers of the V2 write command 0x06 by settings key (spec 5.3, [SY] V2_NUMBERS). No capture
 * of any 0x06 write exists: unverified, ubms keeps all of them read only. Register 0x0D means the
 * short circuit delay here and the balancer switch with command 0x05 (spec 12 item 10).
 */
export const V2_REGISTER = Object.freeze({
  cellOvp: 0x01,
  cellOvpr: 0x02,
  cellUvpr: 0x03,
  cellUvp: 0x04,
  chargeOcp: 0x07,
  chargeOcpDelay: 0x08,
  chargeOcpRecovery: 0x09,
  dischargeOcp: 0x0a,
  dischargeOcpDelay: 0x0b,
  dischargeOcpRecovery: 0x0c,
  scpDelay: 0x0d,
  scpRecovery: 0x0e,
  chargeOtp: 0x0f,
  chargeOtpr: 0x10,
  dischargeOtp: 0x11,
  dischargeOtpr: 0x12,
  chargeUtp: 0x13,
  chargeUtpr: 0x14,
  cellDiffProtection: 0x1b,
  cellDiffRecovery: 0x1c,
  cellShutdownVoltage: 0x1d,
  dischargeOcp2: 0x1e,
  dischargeOcp2Delay: 0x1f,
  dischargeOcp2Recovery: 0x20,
  scpCurrent: 0x21,
  dischargeUtp: 0x22,
  dischargeUtpr: 0x23,
});

/** V2 registers with an integer payload (delays and recovery times, spec 5.3). */
const V2_INTEGER_REGISTERS = new Set([0x08, 0x09, 0x0b, 0x0c, 0x0d, 0x0e, 0x1f, 0x20]);

/** Operation status codes of cell info byte 216 (spec 9.1, [SY] OPERATION_STATUS). */
export const STATUS = Object.freeze({
  UNKNOWN: 0x00,
  WRONG_CELL_COUNT: 0x01,
  WIRE_TEST: 0x02,
  WIRE_RESISTANCE_HIGH: 0x03,
  SYSTEM_TEST_DONE: 0x04,
  BALANCING: 0x05,
  BALANCING_FINISHED: 0x06,
  LOW_VOLTAGE: 0x07,
  OVERTEMPERATURE: 0x08,
  HOST_FAILS: 0x09,
  BATTERY_LOW: 0x0a,
  TEMPERATURE_HIGH: 0x0b,
  SELF_TEST_DONE: 0x0c,
});

/** Voltage slots of the cell info frame (spec 6.4). */
export const MAX_CELLS = 24;

/**
 * A partial answer is dropped after this silence. Notifications of one frame follow each other
 * within milliseconds; the stream sends a frame about every 0.5 s (spec 4.2).
 */
const STALE_MS = 1000;

/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

// ---------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------

/** @param {Uint8Array} b @param {number} o */
export const f32 = (b, o) => new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(o, true);
/** @param {Uint8Array} b @param {number} o @param {number} v */
export const setF32 = (b, o, v) => new DataView(b.buffer, b.byteOffset, b.byteLength).setFloat32(o, v, true);
/** @param {Uint8Array} b @param {number} o */
export const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
/** @param {Uint8Array} b @param {number} o @param {number} v */
const setU24le = (b, o, v) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
};

/**
 * Text of an ASCII field when it is printable: the bytes up to the first 0x00, all in 0x20..0x7E.
 * Null when a non printable byte comes before the first 0x00.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} len
 * @returns {string | null}
 */
export function printableField(b, o, len) {
  let s = '';
  for (let i = o; i < o + len; i++) {
    const c = b[i];
    if (c === 0) break;
    if (c < 0x20 || c > 0x7e) return null;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/**
 * @typedef {'sum8'|'xor8'} Checksum request checksum form (spec 3.3)
 * @typedef {'u8'|'bool'|'u16'|'u32'|'f32'|'ascii'} FieldType
 * @typedef {readonly [key: string, offset: number, type: FieldType, length?: number]} LayoutEntry
 */

/**
 * @param {Uint8Array} f
 * @param {readonly LayoutEntry[]} layout
 * @returns {Record<string, any>}
 */
function readLayout(f, layout) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, o, type, len] of layout) {
    switch (type) {
      case 'u8':
        out[key] = f[o];
        break;
      case 'bool':
        out[key] = f[o] !== 0;
        break;
      case 'u16':
        out[key] = u16le(f, o);
        break;
      case 'u32':
        out[key] = u32le(f, o);
        break;
      case 'f32':
        out[key] = f32(f, o);
        break;
      default:
        out[key] = ascii(f, o, /** @type {number} */ (len));
    }
  }
  return out;
}

/**
 * @param {Uint8Array} f
 * @param {readonly LayoutEntry[]} layout
 * @param {Record<string, any>} values missing keys are written as 0
 */
function writeLayout(f, layout, values) {
  for (const [key, o, type, len] of layout) {
    const v = values[key];
    switch (type) {
      case 'u8':
        f[o] = Number(v ?? 0) & 0xff;
        break;
      case 'bool':
        f[o] = v ? 1 : 0;
        break;
      case 'u16':
        setU16le(f, o, Math.max(0, Math.min(0xffff, Math.round(Number(v ?? 0)))));
        break;
      case 'u32':
        setU32le(f, o, Math.max(0, Math.min(0xffffffff, Math.round(Number(v ?? 0)))));
        break;
      case 'f32':
        setF32(f, o, Number(v ?? 0));
        break;
      default:
        f.set(asciiBytes(String(v ?? ''), /** @type {number} */ (len)), o);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Requests (spec 3.1, 5)
// ---------------------------------------------------------------------------------------------

/**
 * Payload type of a write register.
 * @param {number} command COMMAND.WRITE or COMMAND.WRITE_V2
 * @param {number} register
 * @returns {'u32'|'f32'|'ascii'}
 */
export function registerType(command, register) {
  if (command === COMMAND.WRITE_V2) return V2_INTEGER_REGISTERS.has(register) ? 'u32' : 'f32';
  if (register === REGISTER.DEVICE_NAME) return 'ascii';
  return FLOAT_REGISTERS.has(register) ? 'f32' : 'u32';
}

/**
 * Encode a 20-byte request.
 * @param {Object} q
 * @param {number} q.function FUNCTION value
 * @param {number} q.command COMMAND value
 * @param {number} [q.register] 0 for reads
 * @param {number | string} [q.value] u32, f32 or ASCII (at most 10 characters in bytes 8..17)
 * @param {'u32'|'f32'|'ascii'} [q.valueType] default: registerType() for writes, u32 for reads
 * @param {Checksum} [q.checksum] sum8 (current apps, the only form EK firmware answers) or
 *   xor8 (old NEEY Android app, spec 3.3), which the driver falls back to for GW SW-1.1.0 units
 *   that answer only that form (spec 3.4, 11.2)
 * @param {boolean} [q.swappedLength] length bytes `00 14` as the old app sends in the cell info
 *   request (spec 3.4); the xor8 fallback sends that captured form
 */
export function encodeRequest({ function: fn, command, register = 0, value = 0, valueType, checksum = 'sum8', swappedLength = false }) {
  const f = new Uint8Array(REQUEST_LENGTH);
  f.set(REQUEST_START, 0);
  f[2] = ADDRESS;
  f[3] = fn;
  f[4] = command;
  f[5] = register;
  if (swappedLength) {
    f[6] = 0x00;
    f[7] = REQUEST_LENGTH;
  } else setU16le(f, 6, REQUEST_LENGTH);
  const type = valueType ?? (fn === FUNCTION.WRITE ? registerType(command, register) : 'u32');
  if (type === 'ascii') {
    const text = String(value);
    if (text.length > 10) throw new RangeError('At most 10 characters fit into a request');
    f.set(asciiBytes(text, 10), 8);
  } else if (type === 'f32') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new RangeError(`Invalid value ${value}`);
    setF32(f, 8, n);
  } else {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`Value ${value} does not fit into 4 bytes`);
    setU32le(f, 8, n);
  }
  f[18] = checksum === 'xor8' ? xor8(f, 0, 18) : sum8(f, 0, 18);
  f[19] = END_MARKER;
  return f;
}

/**
 * Read request (function 0x01).
 * @param {number} command
 * @param {Checksum} [checksum] sum8 (default) or the xor8 form of the old app
 */
const readRequest = (command, checksum = 'sum8') => encodeRequest({ function: FUNCTION.READ, command, checksum });

/**
 * `AA 55 11 01 01 00 14 00 .. 26 FF` (spec 5.1), the probe request; xor8 form `.. FA FF` as
 * captured from the old app (vector tx-device-info-xor-app).
 * @param {Checksum} [checksum]
 */
export const deviceInfoRequest = (checksum = 'sum8') => readRequest(COMMAND.DEVICE_INFO, checksum);
/**
 * `AA 55 11 01 02 00 14 00 .. 27 FF` (spec 5.1). Documented answer: a cell info frame, the stream
 * continues. That it restarts a stopped stream is not documented (spec 4.2); the settings request
 * is the documented stream starter. The xor8 form is the captured one of the old app, with the
 * length bytes swapped (`00 14 .. F9 FF`, vector tx-cell-info-xor-app-swapped-length).
 * @param {Checksum} [checksum]
 */
export const cellInfoRequest = (checksum = 'sum8') => encodeRequest({ function: FUNCTION.READ, command: COMMAND.CELL_INFO, checksum, swappedLength: checksum === 'xor8' });
/**
 * `AA 55 11 01 03 00 14 00 .. 28 FF`: factory data (spec 6.6), sum8 form computed. One source
 * names command 0x03 "Factory reset" (spec 5.1, unverified effect): tests only, the driver never
 * sends it.
 */
export const factoryRequest = () => readRequest(COMMAND.FACTORY);
/**
 * `AA 55 11 01 04 00 14 00 .. 29 FF`; starts the cell info stream (spec 4.1). xor8 form
 * `.. FF FF` as captured from the old app (vector tx-settings-xor-app).
 * @param {Checksum} [checksum]
 */
export const settingsRequest = (checksum = 'sum8') => readRequest(COMMAND.SETTINGS, checksum);

/**
 * Write request of command 0x05 (spec 5.2): u32 or float32 payload by register.
 * @param {number} register REGISTER value
 * @param {number | string} value
 * @param {Checksum} [checksum] xor8 only for units that answer the old app's form (spec 3.4)
 */
export const writeRequest = (register, value, checksum = 'sum8') => encodeRequest({ function: FUNCTION.WRITE, command: COMMAND.WRITE, register, value, checksum });

/** Balancer switch (register 0x0D, u32 1 on / 0 off), verified on both variants. @param {boolean} on */
export const balancerSwitchRequest = (on) => writeRequest(REGISTER.BALANCER_SWITCH, on ? 1 : 0);

/**
 * Write request of the V2 command 0x06 (spec 5.3). Unverified: tests only, the driver never sends it.
 * @param {number} register V2_REGISTER value
 * @param {number} value
 */
export const writeV2Request = (register, value) => encodeRequest({ function: FUNCTION.WRITE, command: COMMAND.WRITE_V2, register, value });

/**
 * Request envelope: 20 bytes, `AA 55 11`, end marker; the checksum is reported, not required.
 * @param {Uint8Array} f
 */
export const isRequestFrame = (f) => f.length === REQUEST_LENGTH && f[0] === 0xaa && f[1] === 0x55 && f[2] === ADDRESS && f[19] === END_MARKER;

/**
 * Decode a request (simulator, protocol log, tests).
 * @param {Uint8Array} frame 20 bytes
 */
export function parseRequest(frame) {
  const sum = sum8(frame, 0, 18);
  const xor = xor8(frame, 0, 18);
  const checksum = frame[18];
  /** @type {Record<string, any>} */
  const out = {
    function: frame[3],
    command: frame[4],
    register: frame[5],
    lengthField: u16le(frame, 6),
    checksumAlgorithm: checksum === sum ? 'sum8' : checksum === xor ? 'xor8' : 'invalid',
    checksum,
    endMarker: frame[19] === END_MARKER,
  };
  if (frame[3] === FUNCTION.WRITE) {
    const type = registerType(frame[4], frame[5]);
    out.value = type === 'ascii' ? ascii(frame, 8, 10) : type === 'f32' ? f32(frame, 8) : u32le(frame, 8);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Answers: envelope and assembler (spec 3.2, 3.5)
// ---------------------------------------------------------------------------------------------

/**
 * Frame length from the header of a buffer that starts with `55 AA 11` (FrameAssembler `length`).
 * Never ends a frame at a 0xFF byte: 0xFF occurs inside data (spec 3.5, 12 item 5).
 * @param {Uint8Array} buf
 */
export function answerLength(buf) {
  if (buf.length < 8) return 0;
  const len = u16le(buf, 6);
  return len >= MIN_ANSWER_LENGTH && len <= MAX_ANSWER_LENGTH ? len : -1;
}

/**
 * Complete answer envelope: `55 AA 11`, the length field equals the frame length, end marker and
 * sum8 (spec 3.2, 11.4). Foreign frames (JK `55 AA EB 90`, ANT `7E A1` and `AA 55 AA FF`, Atorch
 * `FF 55`) fail it.
 * @param {Uint8Array} f
 */
export function isAnswerFrame(f) {
  const n = f.length;
  return (
    n >= MIN_ANSWER_LENGTH &&
    n <= MAX_ANSWER_LENGTH &&
    f[0] === 0x55 &&
    f[1] === 0xaa &&
    f[2] === ADDRESS &&
    u16le(f, 6) === n &&
    f[n - 1] === END_MARKER &&
    sum8(f, 0, n - 2) === f[n - 2]
  );
}

/**
 * Host side assembler. On top of FrameAssembler (sync `55 AA 11`, length field, envelope check,
 * one byte dropped on a failure): a notification that starts with `55 AA 11` starts a new frame
 * even when an older one is incomplete, so a lost notification does not corrupt the next frame
 * ([SY] "Flush buffer on every preamble", [AIO]; spec 3.5).
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createAnswerAssembler({ onFrame, onDiscard }) {
  const inner = new FrameAssembler({
    sync: [ANSWER_SYNC],
    length: answerLength,
    validate: isAnswerFrame,
    onFrame,
    onDiscard,
    maxLength: MAX_ANSWER_LENGTH,
    staleMs: STALE_MS,
  });
  return {
    /** @param {Uint8Array} chunk */
    push(chunk) {
      if (inner.buf.length && startsWith(chunk, ANSWER_SYNC)) {
        const dropped = inner.buf;
        inner.buf = new Uint8Array(0);
        onDiscard?.(dropped, 'incomplete frame before a new frame start');
      }
      inner.push(chunk);
    },
    reset() {
      inner.reset();
    },
  };
}

/**
 * Device side assembler (simulator): 20-byte requests that start with `AA 55 11` and end with
 * 0xFF; the simulator checks the checksum itself, as firmware versions differ (spec 3.4).
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createRequestAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [REQUEST_SYNC],
    length: () => REQUEST_LENGTH,
    validate: (f) => f[19] === END_MARKER,
    onFrame,
    onDiscard,
    maxLength: REQUEST_LENGTH,
  });
}

/** @param {number} command @param {number} length */
const isDataFrame = (command, length) => (/** @param {Uint8Array} f */ f) => f.length === length && f[3] === FUNCTION.READ && f[4] === command && f[5] === 0;

/** 100-byte device info frame: `55 AA 11 01 01 00 64 00` (spec 6.1, 11.2 step 4). */
export const isDeviceInfoFrame = isDataFrame(COMMAND.DEVICE_INFO, FRAME_LENGTH.DEVICE_INFO);
/** 300-byte cell info frame: `55 AA 11 01 02 00 2C 01` (spec 6.4, 6.5). */
export const isCellInfoFrame = isDataFrame(COMMAND.CELL_INFO, FRAME_LENGTH.CELL_INFO);
/** 100-byte factory data frame (spec 6.6). */
export const isFactoryFrame = isDataFrame(COMMAND.FACTORY, FRAME_LENGTH.FACTORY);
/** 20-byte first answer to the factory request (spec 6.6). */
export const isFactoryEcho = isDataFrame(COMMAND.FACTORY, FRAME_LENGTH.SHORT);
/** Settings frame of either variant: 100 bytes NEEY_V1, 150 bytes NEEY_V2 (spec 1.3). @param {Uint8Array} f */
export const isSettingsFrame = (f) =>
  (f.length === FRAME_LENGTH.SETTINGS_V1 || f.length === FRAME_LENGTH.SETTINGS_V2) && f[3] === FUNCTION.READ && f[4] === COMMAND.SETTINGS && f[5] === 0;

/** Variant of a settings frame by its length (spec 1.3). @param {Uint8Array} f */
export const settingsVariant = (f) => (f.length === FRAME_LENGTH.SETTINGS_V2 ? VARIANT.V2 : VARIANT.V1);

/**
 * Write acknowledgement for one register (spec 6.7): 20 bytes, function 0x00.
 * @param {number} command COMMAND.WRITE or COMMAND.WRITE_V2
 * @param {number} register
 * @returns {(f: Uint8Array) => boolean}
 */
export const isAckFor = (command, register) => (f) => f.length === FRAME_LENGTH.SHORT && f[3] === FUNCTION.WRITE && f[4] === command && f[5] === register;

// ---------------------------------------------------------------------------------------------
// Answer layouts and parsers (spec 6)
// ---------------------------------------------------------------------------------------------

/** @type {readonly LayoutEntry[]} */
const DEVICE_INFO_LAYOUT = [
  ['model', 8, 'ascii', 16],
  ['hardwareVersion', 24, 'ascii', 8],
  ['softwareVersion', 32, 'ascii', 8],
  ['protocolVersion', 40, 'ascii', 8],
  ['manufacturingDate', 48, 'ascii', 8],
  ['powerOnCount', 56, 'u32'],
  ['totalRuntime', 60, 'u32'],
  // 12 hex digits of the BLE address (reversed on 4th generation modules) plus "123456" whose
  // meaning is unknown (unverified); all zero on older firmware (spec 6.1).
  ['identifier', 64, 'ascii', 18],
  // Equal to the advertised name on the EK-B24S8E200A, zero on every NEEY_V1 frame; unverified
  // as the user defined name (spec 6.1).
  ['modelAlias', 82, 'ascii', 16],
];

/** NEEY_V1 settings, 100 bytes (spec 6.2). */
/** @type {readonly LayoutEntry[]} */
export const SETTINGS_V1_LAYOUT = [
  ['cellCount', 8, 'u8'],
  ['balanceTriggerVoltage', 9, 'f32'],
  ['maxBalanceCurrent', 13, 'f32'],
  ['balanceStopVoltage', 17, 'f32'],
  ['balancerSwitch', 21, 'bool'],
  ['buzzerMode', 22, 'u8'],
  ['batteryType', 23, 'u8'],
  ['nominalCapacity', 24, 'u32'],
  ['balanceStartVoltage', 28, 'f32'],
  // Unknown: 1 on ZH-2.1.1 and ZL-2.0.2; [SY] "device address" (unverified).
  ['byte32', 32, 'u8'],
  ['balanceStopDiffVoltage', 33, 'f32'],
  // Unknown float: [SY] "line resistance reference" (unverified).
  ['float37', 37, 'f32'],
];

/**
 * NEEY_V2 settings, 150 bytes (spec 6.3). float22 and float26 are the sleep and start voltage
 * per [SY] (unverified): in every captured frame float22 is above float26, the opposite of the
 * sleep / start order of every V1 frame, so the labels may be swapped (spec 12 item 9). Bytes 8,
 * 126, 127, 129 and float 18 are unknown; the balancer switch is byte 128 as the capture shows
 * ([SY] decodes 126, spec 12 item 9).
 * @type {readonly LayoutEntry[]}
 */
export const SETTINGS_V2_LAYOUT = [
  ['byte8', 8, 'u8'],
  ['cellCount', 9, 'u8'],
  ['nominalCapacity', 10, 'f32'],
  ['balanceTriggerVoltage', 14, 'f32'],
  ['float18', 18, 'f32'],
  ['float22', 22, 'f32'],
  ['float26', 26, 'f32'],
  ['maxBalanceCurrent', 30, 'f32'],
  ['cellOvp', 34, 'f32'],
  ['cellOvpr', 38, 'f32'],
  ['cellUvp', 42, 'f32'],
  ['cellUvpr', 46, 'f32'],
  ['cellDiffProtection', 50, 'f32'],
  ['cellDiffRecovery', 54, 'f32'],
  ['cellShutdownVoltage', 58, 'f32'],
  ['chargeOcp', 62, 'f32'],
  ['chargeOcpDelay', 66, 'u16'],
  ['chargeOcpRecovery', 68, 'u16'],
  ['dischargeOcp', 70, 'f32'],
  ['dischargeOcpDelay', 74, 'u16'],
  ['dischargeOcpRecovery', 76, 'u16'],
  ['dischargeOcp2', 78, 'f32'],
  ['dischargeOcp2Delay', 82, 'u16'],
  ['dischargeOcp2Recovery', 84, 'u16'],
  ['scpCurrent', 86, 'f32'],
  ['scpDelay', 90, 'u16'],
  ['scpRecovery', 92, 'u16'],
  ['chargeOtp', 94, 'f32'],
  ['chargeOtpr', 98, 'f32'],
  ['chargeUtp', 102, 'f32'],
  ['chargeUtpr', 106, 'f32'],
  ['dischargeOtp', 110, 'f32'],
  ['dischargeOtpr', 114, 'f32'],
  ['dischargeUtp', 118, 'f32'],
  ['dischargeUtpr', 122, 'f32'],
  ['byte126', 126, 'u8'],
  ['byte127', 127, 'u8'],
  ['balancerSwitch', 128, 'bool'],
  ['byte129', 129, 'u8'],
];

/** Factory data, 100 bytes (spec 6.6; names from the app's developer panel, meanings unverified). */
/** @type {readonly LayoutEntry[]} */
const FACTORY_LAYOUT = [
  ['standardVoltage1', 8, 'f32'],
  ['standardVoltage2', 12, 'f32'],
  ['batteryVoltage1', 16, 'f32'],
  ['batteryVoltage2', 20, 'f32'],
  ['standardCurrent1', 24, 'f32'],
  ['standardCurrent2', 28, 'f32'],
  ['superBat1', 32, 'f32'],
  ['superBat2', 36, 'f32'],
  ['resistor1', 40, 'f32'],
  ['batteryStatus', 44, 'f32'],
  ['maxVoltage', 48, 'f32'],
  ['minVoltage', 52, 'f32'],
  ['maxTemperature', 56, 'f32'],
  ['minTemperature', 60, 'f32'],
  ['powerOnCount', 64, 'u32'],
  ['totalRuntime', 68, 'u32'],
  ['productionDate', 72, 'ascii', 8],
];

/** Cell info offsets 8..216, shared by both variants (spec 6.4). */
/** @type {readonly LayoutEntry[]} */
const CELL_SHARED_LAYOUT = [
  ['frameCounter', 8, 'u8'],
  ['totalVoltage', 201, 'f32'],
  ['cellVoltageAverage', 205, 'f32'],
  ['cellVoltageDelta', 209, 'f32'],
  // 0-based; on ties the last cell with that voltage (spec 6.4, 12 item 14).
  ['cellVoltageMaxIndex', 213, 'u8'],
  ['cellVoltageMinIndex', 214, 'u8'],
  // Always 0x0F, also with 15 or 16 cells: not a cell count (spec 12 item 15).
  ['byte215', 215, 'u8'],
  ['operationStatus', 216, 'u8'],
];

/** NEEY_V1 cell info after offset 216 (spec 6.4). */
/** @type {readonly LayoutEntry[]} */
const CELL_V1_LAYOUT = [
  ['balanceCurrent', 217, 'f32'],
  ['temperature1', 221, 'f32'],
  ['temperature2', 225, 'f32'],
  ['uptime', 254, 'u32'],
];

/**
 * NEEY_V2 cell info after offset 216 (spec 6.5). Bytes 217 and 284 and the floats at 254 (equal
 * to the capacity), 258 and 262 are unknown (unverified).
 * @type {readonly LayoutEntry[]}
 */
const CELL_V2_LAYOUT = [
  ['byte217', 217, 'u8'],
  ['balanceCurrent', 218, 'f32'],
  ['current', 222, 'f32'],
  ['temperature1', 226, 'f32'],
  ['temperature2', 230, 'f32'],
  ['temperatureMos', 234, 'f32'],
  ['temperatureBalancer', 238, 'f32'],
  ['nominalCapacity', 242, 'f32'],
  ['capacityRemaining', 246, 'f32'],
  ['soc', 250, 'f32'],
  ['float254', 254, 'f32'],
  ['float258', 258, 'f32'],
  ['float262', 262, 'f32'],
  ['uptime', 291, 'u32'],
];

/** Start of the bitmask block (spec 6.4 offsets 229..247, shifted by 37 in V2, spec 6.5). */
const MASK_OFFSET = Object.freeze({ [VARIANT.V1]: 229, [VARIANT.V2]: 266 });
/** Key of the unknown byte after the fault bytes (V1 247, V2 284). */
const MASK_TAIL_KEY = Object.freeze({ [VARIANT.V1]: 'byte247', [VARIANT.V2]: 'byte284' });

/**
 * Device info frame (spec 6.1).
 * @param {Uint8Array} frame validated 100-byte frame
 */
export function parseDeviceInfo(frame) {
  return { frameType: frame[4], frameLength: frame.length, ...readLayout(frame, DEVICE_INFO_LAYOUT) };
}

/** Model names of the known units: "GW-..." and "EK-..." (spec 1.1, 11.1). */
const MODEL_PREFIX = /^(GW|EK)-/i;

/**
 * Why a device info frame cannot identify a NEEY balancer, or null (spec 11.2 step 4): the model
 * at 8..23 must be printable and non-empty and the hardware version at 24 printable; then either
 * the hardware version starts with "HW-" (every captured frame) or the model starts with "GW-" or
 * "EK-". "HW-" is an observed pattern only, no device info frame of the EK-16S2EB or the
 * EK-24S15EB is known (unverified for them), so a known model name is enough.
 * @param {Uint8Array} frame device info frame (header already checked)
 * @returns {string | null}
 */
export function deviceInfoProblem(frame) {
  if (!isDeviceInfoFrame(frame) || !isAnswerFrame(frame)) return 'not a device info frame';
  const model = printableField(frame, 8, 16);
  if (!model) return 'model not printable or empty';
  const hw = printableField(frame, 24, 8);
  if (hw === null) return 'hardware version not printable';
  if (!hw.startsWith('HW-') && !MODEL_PREFIX.test(model)) return `model ${JSON.stringify(model)} with hardware version ${JSON.stringify(hw)}`;
  return null;
}

/**
 * NEEY_V1 settings (100 bytes, spec 6.2).
 * @param {Uint8Array} frame
 */
export function parseSettingsV1(frame) {
  return { frameType: frame[4], frameLength: frame.length, variant: VARIANT.V1, ...readLayout(frame, SETTINGS_V1_LAYOUT) };
}

/**
 * NEEY_V2 settings (150 bytes, spec 6.3).
 * @param {Uint8Array} frame
 */
export function parseSettingsV2(frame) {
  return { frameType: frame[4], frameLength: frame.length, variant: VARIANT.V2, ...readLayout(frame, SETTINGS_V2_LAYOUT) };
}

/**
 * Settings frame of either variant, chosen by the length (spec 1.3).
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export const parseSettings = (frame) => (frame.length === FRAME_LENGTH.SETTINGS_V2 ? parseSettingsV2(frame) : parseSettingsV1(frame));

/**
 * Factory data frame (spec 6.6).
 * @param {Uint8Array} frame
 */
export function parseFactory(frame) {
  return { frameType: frame[4], frameLength: frame.length, ...readLayout(frame, FACTORY_LAYOUT) };
}

/**
 * 20-byte answer: write acknowledgement (function 0x00) or the factory echo (spec 6.6, 6.7).
 * `rawValue` is the u32 at offset 8: the written value on EK firmware, zero on GW SW-1.1.0.
 * @param {Uint8Array} frame
 */
export function parseShortAnswer(frame) {
  return { frameLength: frame.length, function: frame[3], command: frame[4], register: frame[5], rawValue: u32le(frame, 8) };
}

/**
 * Minimum, maximum (first on ties), delta and mean of the cells, 1-based numbers.
 * @param {number[]} cells
 */
export function cellStatistics(cells) {
  if (!cells.length) return {};
  let min = 0;
  let max = 0;
  let sum = 0;
  cells.forEach((v, i) => {
    sum += v;
    if (v < cells[min]) min = i;
    if (v > cells[max]) max = i;
  });
  return {
    cellVoltageMin: cells[min],
    cellVoltageMinNumber: min + 1,
    cellVoltageMax: cells[max],
    cellVoltageMaxNumber: max + 1,
    cellVoltageDeltaDerived: cells[max] - cells[min],
    cellVoltageAverageDerived: sum / cells.length,
  };
}

/**
 * Bitmask block (spec 6.4 offsets 229..247, V2 266..284): five u24 cell masks (bit i = cell
 * i + 1), the overheating bits, the charging and discharging fault bytes and one unknown byte.
 * @param {Uint8Array} f
 * @param {number} o
 */
function parseMasks(f, o) {
  return {
    cellDetectionFailedMask: u24le(f, o),
    cellOvervoltageMask: u24le(f, o + 3),
    cellUndervoltageMask: u24le(f, o + 6),
    cellPolarityErrorMask: u24le(f, o + 9),
    cellWireResistanceMask: u24le(f, o + 12),
    temperatureWarningMask: f[o + 15],
    chargingFault: f[o + 16] !== 0,
    dischargingFault: f[o + 17] !== 0,
  };
}

/**
 * Cell info frame (spec 6.4, 6.5). The layout after offset 216 depends on the variant, which the
 * frame does not tell (spec 1.3): without `variant` only the shared part (offsets 8..216) is
 * decoded. `cellVoltages` and `cellResistances` hold the slots up to the last non-zero voltage
 * (`cellCount` of them); `cellSlots` and `resistanceSlots` hold all 24.
 * @param {Uint8Array} frame validated 300-byte frame
 * @param {string} [variant] VARIANT value
 * @returns {Record<string, any>}
 */
export function parseCellInfo(frame, variant) {
  const cellSlots = Array.from({ length: MAX_CELLS }, (_, i) => f32(frame, 9 + 4 * i));
  const resistanceSlots = Array.from({ length: MAX_CELLS }, (_, i) => f32(frame, 105 + 4 * i));
  let count = 0;
  cellSlots.forEach((v, i) => {
    if (v !== 0) count = i + 1;
  });
  const cellVoltages = cellSlots.slice(0, count);
  /** @type {Record<string, any>} */
  const out = {
    frameType: frame[4],
    frameLength: frame.length,
    variant,
    cellCount: count,
    cellSlots,
    resistanceSlots,
    cellVoltages,
    cellResistances: resistanceSlots.slice(0, count),
    ...readLayout(frame, CELL_SHARED_LAYOUT),
    ...cellStatistics(cellVoltages),
  };
  out.balancing = out.operationStatus === STATUS.BALANCING;
  if (variant === VARIANT.V1 || variant === VARIANT.V2) {
    const m = MASK_OFFSET[variant];
    Object.assign(out, readLayout(frame, variant === VARIANT.V2 ? CELL_V2_LAYOUT : CELL_V1_LAYOUT), parseMasks(frame, m));
    out[MASK_TAIL_KEY[variant]] = frame[m + 18];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Answer encoders (simulator, tests)
// ---------------------------------------------------------------------------------------------

/**
 * Answer frame with header, length field, sum8 and end marker; `fill` writes the payload.
 * @param {number} fn
 * @param {number} command
 * @param {number} register
 * @param {number} length
 * @param {(f: Uint8Array) => void} [fill]
 */
export function encodeAnswer(fn, command, register, length, fill) {
  const f = new Uint8Array(length);
  f.set(ANSWER_START, 0);
  f[2] = ADDRESS;
  f[3] = fn;
  f[4] = command;
  f[5] = register;
  setU16le(f, 6, length);
  fill?.(f);
  f[length - 2] = sum8(f, 0, length - 2);
  f[length - 1] = END_MARKER;
  return f;
}

/** @param {Record<string, any>} d parser field names */
export const encodeDeviceInfo = (d) => encodeAnswer(FUNCTION.READ, COMMAND.DEVICE_INFO, 0, FRAME_LENGTH.DEVICE_INFO, (f) => writeLayout(f, DEVICE_INFO_LAYOUT, d));
/** @param {Record<string, any>} s parser field names */
export const encodeSettingsV1 = (s) => encodeAnswer(FUNCTION.READ, COMMAND.SETTINGS, 0, FRAME_LENGTH.SETTINGS_V1, (f) => writeLayout(f, SETTINGS_V1_LAYOUT, s));
/** @param {Record<string, any>} s parser field names */
export const encodeSettingsV2 = (s) => encodeAnswer(FUNCTION.READ, COMMAND.SETTINGS, 0, FRAME_LENGTH.SETTINGS_V2, (f) => writeLayout(f, SETTINGS_V2_LAYOUT, s));
/** @param {Record<string, any>} d parser field names */
export const encodeFactory = (d) => encodeAnswer(FUNCTION.READ, COMMAND.FACTORY, 0, FRAME_LENGTH.FACTORY, (f) => writeLayout(f, FACTORY_LAYOUT, d));
/** 20-byte factory echo `55 AA 11 01 03 00 14 00 .. 28 FF` (spec 6.6). */
export const encodeFactoryEcho = () => encodeAnswer(FUNCTION.READ, COMMAND.FACTORY, 0, FRAME_LENGTH.SHORT);

/**
 * Write acknowledgement (spec 6.7). `valueBytes`: request bytes 8..17 on EK firmware (an echo),
 * omitted (zero) on GW SW-1.1.0.
 * @param {number} command
 * @param {number} register
 * @param {Uint8Array} [valueBytes]
 */
export const encodeAck = (command, register, valueBytes) =>
  encodeAnswer(FUNCTION.WRITE, command, register, FRAME_LENGTH.SHORT, (f) => {
    if (valueBytes) f.set(valueBytes.subarray(0, 10), 8);
  });

/**
 * Cell info frame from parser field names (spec 6.4, 6.5). Voltages and resistances come from
 * `cellSlots` / `resistanceSlots` when present, otherwise from `cellVoltages` /
 * `cellResistances`; empty slots read 0.
 * @param {Record<string, any>} c
 * @param {string} variant VARIANT value
 */
export function encodeCellInfo(c, variant) {
  return encodeAnswer(FUNCTION.READ, COMMAND.CELL_INFO, 0, FRAME_LENGTH.CELL_INFO, (f) => {
    const cells = /** @type {number[]} */ (c.cellSlots ?? c.cellVoltages ?? []);
    const res = /** @type {number[]} */ (c.resistanceSlots ?? c.cellResistances ?? []);
    for (let i = 0; i < MAX_CELLS; i++) {
      setF32(f, 9 + 4 * i, cells[i] ?? 0);
      setF32(f, 105 + 4 * i, res[i] ?? 0);
    }
    writeLayout(f, CELL_SHARED_LAYOUT, { byte215: 0x0f, ...c });
    writeLayout(f, variant === VARIANT.V2 ? CELL_V2_LAYOUT : CELL_V1_LAYOUT, variant === VARIANT.V2 ? { byte217: 0x02, ...c } : c);
    const m = MASK_OFFSET[variant === VARIANT.V2 ? VARIANT.V2 : VARIANT.V1];
    setU24le(f, m, c.cellDetectionFailedMask ?? 0);
    setU24le(f, m + 3, c.cellOvervoltageMask ?? 0);
    setU24le(f, m + 6, c.cellUndervoltageMask ?? 0);
    setU24le(f, m + 9, c.cellPolarityErrorMask ?? 0);
    setU24le(f, m + 12, c.cellWireResistanceMask ?? 0);
    f[m + 15] = c.temperatureWarningMask ?? 0;
    f[m + 16] = c.chargingFault ? 1 : 0;
    f[m + 17] = c.dischargingFault ? 1 : 0;
    f[m + 18] = c[variant === VARIANT.V2 ? 'byte284' : 'byte247'] ?? 0;
  });
}

// ---------------------------------------------------------------------------------------------
// Protocol log
// ---------------------------------------------------------------------------------------------

const COMMAND_NAMES = /** @type {Record<number, string>} */ ({
  [COMMAND.DEVICE_INFO]: 'device info',
  [COMMAND.CELL_INFO]: 'cell info',
  [COMMAND.FACTORY]: 'factory data',
  [COMMAND.SETTINGS]: 'settings',
});

const REGISTER_NAMES = /** @type {Record<number, string>} */ ({
  [REGISTER.CELL_COUNT]: 'cell count',
  [REGISTER.TRIGGER_DELTA]: 'balance trigger voltage difference',
  [REGISTER.MAX_CURRENT]: 'maximum balance current',
  [REGISTER.SLEEP_VOLTAGE]: 'sleep voltage',
  [REGISTER.BALANCER_SWITCH]: 'balancer switch',
  [REGISTER.DEVICE_NAME]: 'device name',
  [REGISTER.BUZZER_MODE]: 'buzzer mode',
  [REGISTER.BATTERY_TYPE]: 'battery type',
  [REGISTER.NOMINAL_CAPACITY]: 'nominal capacity',
  [REGISTER.START_VOLTAGE]: 'balance start voltage',
  [REGISTER.STOP_DELTA]: 'balance stop voltage difference',
});

/** @param {number} command @param {number} register */
const writeName = (command, register) =>
  command === COMMAND.WRITE_V2 ? `V2 register ${h2(register)}` : `${REGISTER_NAMES[register] ?? 'register'} (${h2(register)})`;

/**
 * Name and lazy decoder of a frame for the protocol log (requests and answers).
 * @param {Uint8Array} frame
 * @param {string} [variant] decides the cell info layout after offset 216
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describe(frame, variant) {
  if (!frame || frame.length < 8) return null;
  if (isRequestFrame(frame)) {
    const q = () => parseRequest(frame);
    if (frame[3] === FUNCTION.READ) return { name: `NEEY ${COMMAND_NAMES[frame[4]] ?? `command ${h2(frame[4])}`} request`, decode: q };
    return { name: `NEEY write ${writeName(frame[4], frame[5])}`, decode: q };
  }
  if (frame[0] !== 0x55 || frame[1] !== 0xaa || frame[2] !== ADDRESS) return null;
  if (frame.length === FRAME_LENGTH.SHORT) {
    const what = frame[3] === FUNCTION.WRITE ? `acknowledgement ${writeName(frame[4], frame[5])}` : `${COMMAND_NAMES[frame[4]] ?? h2(frame[4])} echo`;
    return { name: `NEEY ${what}`, decode: () => parseShortAnswer(frame) };
  }
  if (isDeviceInfoFrame(frame)) return { name: 'NEEY device info', decode: () => parseDeviceInfo(frame) };
  if (isSettingsFrame(frame)) return { name: `NEEY settings (${frame.length} bytes, ${settingsVariant(frame)})`, decode: () => parseSettings(frame) };
  if (isCellInfoFrame(frame)) return { name: 'NEEY cell info', decode: () => parseCellInfo(frame, variant) };
  if (isFactoryFrame(frame)) return { name: 'NEEY factory data', decode: () => parseFactory(frame) };
  return { name: `NEEY frame ${h2(frame[4])} (${frame.length} bytes)` };
}

// ---------------------------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------------------------

/**
 * Maximum balance current of a model in A (spec 7.3): the number after "S" in `<cells>S<amps>E`
 * (GW-24S4EB 4 A, EK-16S2EB 2 A, EK-24S10EB 10 A, EK-B24S8E200A 8 A); 4 A when the model does
 * not match.
 * @param {string} [model]
 */
export function balancerRating(model) {
  const m = /(\d+)S(\d+)E/i.exec(String(model ?? ''));
  const a = m ? Number(m[2]) : NaN;
  return a >= 1 && a <= 50 ? a : 4;
}

/**
 * Provisional variant from the model before a settings frame is known: [AIO] treats "EK-B..." as
 * v2 (spec 1.3); only a hint.
 * @param {string} [model]
 */
export const variantFromModel = (model) => (/^EK-B/i.test(String(model ?? '').trim()) ? VARIANT.V2 : VARIANT.V1);

/**
 * Production date YYYYMMDD as YYYY-MM-DD, or undefined.
 * @param {string} [date]
 */
export function formatDate(date) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(date ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
