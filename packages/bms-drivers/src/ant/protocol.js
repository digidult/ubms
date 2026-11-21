import {
  FrameAssembler,
  crc16Modbus,
  sum8,
  sum16,
  hex,
  u16le,
  i16le,
  u32le,
  i32le,
  u16be,
  i16be,
  u32be,
  i32be,
  setU16le,
  setU32le,
  setU16be,
  setU32be,
} from '@ubms/transport';
import { msg } from '@ubms/bms-core';

/**
 * ANT BMS protocol, pure functions without I/O. Specification: docs/protocols/ant.md.
 *
 * Two generations share the brand:
 * - ANT_NEW ("2021 protocol"): `7E A1 <func> <addr lo> <addr hi> <len> <data> <crc lo> <crc hi>
 *   [extra section] AA 55`, little endian, CRC-16/MODBUS sent low byte first (spec 3.1 to 3.5).
 * - ANT_OLD ("legacy"): 6 byte commands `HH HH <addr> <value u16be> <sum8>` and a 140 byte status
 *   answer `AA 55 AA FF ... <sum16 u16be>`, big endian (spec 3.6 and 6.8).
 *
 * Parsers return plain objects whose field names match the test vectors
 * (packages/bms-drivers/test/vectors/ant.json). Values are engineering units in the device's own
 * sign convention: ANT reports current and power POSITIVE WHILE DISCHARGING (spec 12.1); the
 * driver negates them for the unified model.
 */

// ---------------------------------------------------------------------------------------------
// ANT_NEW constants
// ---------------------------------------------------------------------------------------------

export const NEW_HEADER = Object.freeze([0x7e, 0xa1]);
export const NEW_TAIL = Object.freeze([0xaa, 0x55]);
/** Largest legal ANT_NEW frame: 6 + 255 data + 2 CRC + 4 extra header + 255 extra + 2 CRC + 2 tail. */
export const NEW_MAX_FRAME = 526;

/** ANT_NEW request function codes (spec 5.1). */
export const FN = Object.freeze({
  STATUS: 0x01,
  READ: 0x02,
  LOG: 0x03,
  CHIP_ID: 0x04,
  SYSTEM_INFO: 0x05,
  GPRS: 0x06,
  WRITE: 0x22,
  AUTH: 0x23,
  CONTROL: 0x51,
  /** Factory reset of the 2024 app, computed and unverified (spec 5.5). Never sent by the driver. */
  FACTORY_RESET_2024: 0x53,
});

/** ANT_NEW response function codes (spec 5.1). */
export const RSP = Object.freeze({
  STATUS: 0x11,
  READ: 0x12,
  LOG: 0x13,
  CHIP_ID: 0x14,
  SYSTEM_INFO: 0x15,
  GPRS: 0x16,
  WRITE: 0x42,
  AUTH: 0x43,
  CONTROL: 0x61,
});

/**
 * ANT_NEW control actions, function 0x51 with the action code as address (spec 5.5).
 * The firmware upgrade start (0x0A) is deliberately absent: never send it.
 */
export const CONTROL = Object.freeze({
  DISCHARGE_OFF: 0x01,
  DISCHARGE_ON: 0x03,
  CHARGE_OFF: 0x04,
  CHARGE_ON: 0x06,
  SAVE: 0x07,
  CURRENT_ZERO: 0x08,
  RESTART: 0x09,
  SHUTDOWN: 0x0b,
  FACTORY_RESET: 0x0c,
  BALANCE_ON: 0x0d,
  BALANCE_OFF: 0x0e,
  CLEAR_LOG: 0x0f,
  BLUETOOTH_INIT: 0x10,
  BLUETOOTH_OFF: 0x1c,
  BLUETOOTH_ON: 0x1d,
  BUZZER_ON: 0x1e,
  BUZZER_OFF: 0x1f,
  CLEAR_DISCHARGE_AH: 0x20,
  CLEAR_CHARGE_AH: 0x21,
  CLEAR_DISCHARGE_TIME: 0x22,
  CLEAR_CHARGE_TIME: 0x23,
  CLEAR_RUNTIME: 0x24,
  CLEAR_PROTECT_TIME: 0x25,
  DEFAULTS_LTO: 0x26,
  DEFAULTS_NMC: 0x27,
  DEFAULTS_LFP: 0x28,
  RESET_HARDWARE: 0x2a,
  SAVE_CUSTOMER_DATA: 0x2c,
  USER_PARAMETERS: 0x2d,
});

/** English names of the control actions for the protocol log. */
export const CONTROL_NAMES = Object.freeze({
  [CONTROL.DISCHARGE_OFF]: 'Discharge MOSFET off',
  [CONTROL.DISCHARGE_ON]: 'Discharge MOSFET on',
  [CONTROL.CHARGE_OFF]: 'Charge MOSFET off',
  [CONTROL.CHARGE_ON]: 'Charge MOSFET on',
  [CONTROL.SAVE]: 'Save parameters',
  [CONTROL.CURRENT_ZERO]: 'Current zero calibration',
  [CONTROL.RESTART]: 'Restart',
  [CONTROL.SHUTDOWN]: 'Shutdown',
  [CONTROL.FACTORY_RESET]: 'Factory reset',
  [CONTROL.BALANCE_ON]: 'Manual balance on',
  [CONTROL.BALANCE_OFF]: 'Manual balance off',
  [CONTROL.CLEAR_LOG]: 'Clear system log',
  [CONTROL.BLUETOOTH_INIT]: 'Bluetooth initialization',
  [CONTROL.BLUETOOTH_OFF]: 'Bluetooth off',
  [CONTROL.BLUETOOTH_ON]: 'Bluetooth on',
  [CONTROL.BUZZER_ON]: 'Buzzer on',
  [CONTROL.BUZZER_OFF]: 'Buzzer off',
  [CONTROL.CLEAR_DISCHARGE_AH]: 'Clear discharge cycle Ah',
  [CONTROL.CLEAR_CHARGE_AH]: 'Clear charge cycle Ah',
  [CONTROL.CLEAR_DISCHARGE_TIME]: 'Clear discharge time',
  [CONTROL.CLEAR_CHARGE_TIME]: 'Clear charge time',
  [CONTROL.CLEAR_RUNTIME]: 'Clear running time',
  [CONTROL.CLEAR_PROTECT_TIME]: 'Clear protect time',
  [CONTROL.DEFAULTS_LTO]: 'Load LTO defaults',
  [CONTROL.DEFAULTS_NMC]: 'Load ternary (NMC) defaults',
  [CONTROL.DEFAULTS_LFP]: 'Load LiFePO4 defaults',
  [CONTROL.RESET_HARDWARE]: 'Reset hardware',
  [CONTROL.SAVE_CUSTOMER_DATA]: 'Save customer data',
  [CONTROL.USER_PARAMETERS]: 'User parameters',
});

/** Well known ANT_NEW parameter addresses (byte addresses, spec 7.1). */
export const ADDR = Object.freeze({
  /** 32 bytes: hardware version (16) and software version (16). */
  DEVICE_INFO: 0x026c,
  /** 32 ASCII bytes, NUL padded. */
  PACK_ID: 0x0106,
  /** Level 1 password, 8 ASCII bytes. */
  PASSWORD_L1: 0x014a,
  /** Level 2, 3 and 4 passwords, 8 ASCII bytes each (yosle "Passwords"; unverified on hardware). */
  PASSWORD_L2: 0x0152,
  PASSWORD_L3: 0x015a,
  PASSWORD_L4: 0x0162,
  /** Level 5 password, 12 ASCII bytes. */
  PASSWORD_L5: 0x016a,
});

/** Factory passwords (spec 4.3). */
export const DEFAULT_PASSWORD_L1 = '12345678';
export const DEFAULT_PASSWORD_L5 = '123456789abc';

/** NTC reading that means "probe absent" (spec 6.1, 12.2 item 11). */
export const ABSENT_TEMPERATURE = -40;

// ---------------------------------------------------------------------------------------------
// ANT_NEW encoders
// ---------------------------------------------------------------------------------------------

/**
 * Build an ANT_NEW request frame (spec 3.1). The CRC covers `A1` through the last payload byte.
 * @param {number} func function code
 * @param {number} address u16, meaning depends on the function
 * @param {number} length for reads the requested byte count (no payload); for writes the payload length
 * @param {ArrayLike<number>} [payload]
 * @returns {Uint8Array}
 */
export function encodeNewRequest(func, address, length, payload = []) {
  const p = payload.length;
  const frame = new Uint8Array(10 + p);
  frame[0] = 0x7e;
  frame[1] = 0xa1;
  frame[2] = func & 0xff;
  setU16le(frame, 3, address & 0xffff);
  frame[5] = length & 0xff;
  frame.set(payload, 6);
  setU16le(frame, 6 + p, crc16Modbus(frame, 1, 6 + p));
  frame[8 + p] = 0xaa;
  frame[9 + p] = 0x55;
  return frame;
}

/** Status (real time) request `7EA1010000BE1855AA55`. */
export const newStatusRequest = () => encodeNewRequest(FN.STATUS, 0, 0xbe);

/**
 * Read `length` parameter bytes starting at a byte address (function 0x02).
 * @param {number} address
 * @param {number} length at most 255; keep block reads at 64 bytes or less (spec 4.3)
 */
export const newReadRequest = (address, length) => encodeNewRequest(FN.READ, address, length);

/** Device info request: 32 bytes at 0x026C (`7EA1026C022058C4AA55`). */
export const newDeviceInfoRequest = () => newReadRequest(ADDR.DEVICE_INFO, 32);

/** Chip id request (`7EA10400000C98ECAA55`). */
export const newChipIdRequest = () => encodeNewRequest(FN.CHIP_ID, 0, 12);

/** System info request (`7EA105000028990BAA55`), answer meaning unknown (spec 6.5). */
export const newSystemInfoRequest = () => encodeNewRequest(FN.SYSTEM_INFO, 0, 40);

/** GPRS / GPS request (`7EA10600006C997CAA55`), answer layout unknown (spec 6.7). */
export const newGprsRequest = () => encodeNewRequest(FN.GPRS, 0, 108);

/**
 * System log entry request (function 0x03, index 1..10). The answer layout is unknown (spec 6.7).
 * @param {number} index
 */
export const newLogRequest = (index) => encodeNewRequest(FN.LOG, index, 0);

/**
 * Password frame (function 0x23): the ASCII password at the address of its level.
 * Level 1 is 8 bytes at 0x014A, level 5 is 12 bytes at 0x016A (spec 4.3, 5.3). The frame carries
 * the password bytes as they are, without padding (the captured default passwords fill the field).
 * @param {string} password
 * @param {number} [address] defaults to the level 5 address
 */
export function newAuthRequest(password, address = ADDR.PASSWORD_L5) {
  const bytes = Array.from(password, (c) => c.charCodeAt(0) & 0xff);
  return encodeNewRequest(FN.AUTH, address, bytes.length, bytes);
}

/**
 * Parameter write (function 0x22), value little endian (spec 5.4).
 * @param {number} address byte address
 * @param {number} raw raw register value (two's complement for signed values)
 * @param {2|4} [size] 2 for u16/i16 registers, 4 for u32 registers
 */
export function newWriteRequest(address, raw, size = 2) {
  const payload = new Uint8Array(size);
  if (size === 4) setU32le(payload, 0, raw >>> 0);
  else setU16le(payload, 0, raw & 0xffff);
  return encodeNewRequest(FN.WRITE, address, size, payload);
}

/**
 * Parameter write with raw bytes (strings and blocks).
 * @param {number} address
 * @param {ArrayLike<number>} bytes
 */
export const newWriteBytesRequest = (address, bytes) => encodeNewRequest(FN.WRITE, address, bytes.length, bytes);

/**
 * Control action (function 0x51, length 0), see CONTROL.
 * @param {number} action
 */
export const newControlRequest = (action) => encodeNewRequest(FN.CONTROL, action, 0);

/** Save / apply parameters after writes (`7EA15107000038E4AA55`). */
export const newSaveRequest = () => newControlRequest(CONTROL.SAVE);

/**
 * Build an ANT_NEW response frame (device side, used by the simulator and tests).
 * @param {number} func response function code
 * @param {number} address
 * @param {ArrayLike<number>} data
 * @param {{ status: number, data?: ArrayLike<number> }} [extra] optional extra section (spec 3.2 case C)
 * @returns {Uint8Array}
 */
export function encodeNewResponse(func, address, data, extra) {
  const r = data.length;
  const h = extra?.data?.length ?? 0;
  const frame = new Uint8Array(10 + r + (extra ? 6 + h : 0));
  frame[0] = 0x7e;
  frame[1] = 0xa1;
  frame[2] = func & 0xff;
  setU16le(frame, 3, address & 0xffff);
  frame[5] = r;
  frame.set(data, 6);
  setU16le(frame, 6 + r, crc16Modbus(frame, 1, 6 + r));
  let end = 8 + r;
  if (extra) {
    frame[end] = 0xff;
    frame[end + 1] = extra.status & 0xff;
    frame[end + 2] = 0x00;
    frame[end + 3] = h;
    if (h) frame.set(/** @type {ArrayLike<number>} */ (extra.data), end + 4);
    setU16le(frame, end + 4 + h, crc16Modbus(frame, end, end + 4 + h));
    end += 6 + h;
  }
  frame[end] = 0xaa;
  frame[end + 1] = 0x55;
  return frame;
}

/** Extra section status codes seen in captures (spec 3.4). */
export const EXTRA = Object.freeze({ READ: 0x0b, WRITE: 0x0a, AUTH: 0x05 });

// ---------------------------------------------------------------------------------------------
// ANT_NEW framing
// ---------------------------------------------------------------------------------------------

/**
 * Total length of the ANT_NEW frame at the start of `buf` (spec 3.5): 0 when more bytes are
 * needed, -1 when the primary CRC or the tail is invalid. The primary CRC is checked before the
 * tail is interpreted, so a stray `7E A1` inside data cannot make the assembler wait for a
 * bogus extra section. A trailing 0x55 alone never ends a frame.
 * @param {Uint8Array} buf starts with 7E A1
 */
export function newFrameLength(buf) {
  if (buf.length < 6) return 0;
  const r = buf[5];
  if (buf.length < 8 + r) return 0;
  if (crc16Modbus(buf, 1, 6 + r) !== u16le(buf, 6 + r)) return -1;
  if (buf.length < 10 + r) return 0;
  if (buf[8 + r] === 0xaa && buf[9 + r] === 0x55) return 10 + r;
  if (buf[8 + r] !== 0xff) return -1;
  if (buf.length < 12 + r) return 0;
  return 16 + r + buf[11 + r];
}

/**
 * Full validation of a complete ANT_NEW frame: header, primary CRC, optional extra section with
 * its own CRC, `AA 55` tail.
 * @param {Uint8Array} frame
 */
export function validateNewFrame(frame) {
  if (frame.length < 10 || frame[0] !== 0x7e || frame[1] !== 0xa1) return false;
  const r = frame[5];
  if (frame.length < 10 + r) return false;
  if (crc16Modbus(frame, 1, 6 + r) !== u16le(frame, 6 + r)) return false;
  if (frame[frame.length - 2] !== 0xaa || frame[frame.length - 1] !== 0x55) return false;
  if (frame.length === 10 + r) return true;
  if (frame[8 + r] !== 0xff || frame.length < 16 + r) return false;
  const h = frame[11 + r];
  if (frame.length !== 16 + r + h) return false;
  return crc16Modbus(frame, 8 + r, 12 + r + h) === u16le(frame, 12 + r + h);
}

/**
 * Frame assembler for ANT_NEW responses (host side).
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createNewAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({ sync: [NEW_HEADER], length: newFrameLength, validate: validateNewFrame, onFrame, onDiscard, maxLength: NEW_MAX_FRAME });
}

/**
 * Length of an ANT_NEW request frame (device side): reads and controls carry no payload, writes
 * and passwords carry `len` payload bytes (spec 3.1).
 * @param {Uint8Array} buf starts with 7E A1
 */
export function newRequestLength(buf) {
  if (buf.length < 6) return 0;
  const func = buf[2];
  return 10 + (func === FN.WRITE || func === FN.AUTH ? buf[5] : 0);
}

/**
 * Validate an ANT_NEW request frame (device side).
 * @param {Uint8Array} frame
 */
export function validateNewRequest(frame) {
  if (frame.length < 10 || frame[0] !== 0x7e || frame[1] !== 0xa1) return false;
  const p = frame.length - 10;
  return crc16Modbus(frame, 1, 6 + p) === u16le(frame, 6 + p) && frame[8 + p] === 0xaa && frame[9 + p] === 0x55;
}

// ---------------------------------------------------------------------------------------------
// ANT_NEW parsers
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} NewFrame
 * @property {number} func
 * @property {number} address
 * @property {number} length data length r
 * @property {Uint8Array} data
 * @property {number} [extraStatus] status byte of the extra section
 * @property {number} [extraLength] number of extra data bytes h
 * @property {Uint8Array} [extraData]
 */

/**
 * Split an ANT_NEW response frame into its parts.
 * @param {Uint8Array} frame validated frame
 * @returns {NewFrame}
 */
export function parseNewFrame(frame) {
  const r = frame[5];
  /** @type {NewFrame} */
  const out = { func: frame[2], address: u16le(frame, 3), length: r, data: frame.subarray(6, 6 + r) };
  if (frame.length > 10 + r && frame[8 + r] === 0xff) {
    const h = frame[11 + r];
    out.extraStatus = frame[9 + r];
    out.extraLength = h;
    out.extraData = frame.subarray(12 + r, 12 + r + h);
  }
  return out;
}

/**
 * Extra section fields shared by several parsers. With h = 4 the 2024 firmware reports the last
 * served address, page and firmware group; this decoding is unverified (spec 3.4), metadata only.
 * @param {NewFrame} f
 */
function extraFields(f) {
  if (f.extraStatus === undefined) return {};
  /** @type {Record<string, number>} */
  const out = { extraStatus: f.extraStatus, extraLength: /** @type {number} */ (f.extraLength) };
  const d = f.extraData;
  if (d && d.length === 4) {
    out.extraPage = d[1];
    out.extraLastAddress = ((d[1] >> 3) << 8) | d[0];
    out.extraGroup = d[2];
  }
  return out;
}

/**
 * ASCII text of a NUL padded field. Stops at NUL or 0xFF (unconfigured), drops other control
 * characters and trims.
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
 * Layout of a 0x11 status frame or null when the frame is not a consistent status frame
 * (spec 6.1 validation): `1 <= n <= 32`, `m <= 8` and `r = 106 + 2n + 2m` (+12 or +14).
 * The spec probe uses `m <= 6`; batmon-ha caps at 8 because one unit reported a bogus count. The
 * length formula is the decisive check, so counts up to 8 are accepted when the length matches.
 * @param {Uint8Array} frame
 * @returns {{ n: number, m: number, r: number, o: number, optional: number } | null}
 */
export function statusLayout(frame) {
  if (frame.length < 10 || frame[0] !== 0x7e || frame[1] !== 0xa1 || frame[2] !== RSP.STATUS) return null;
  const r = frame[5];
  if (frame.length < 10 + r) return null;
  const m = frame[8];
  const n = frame[9];
  if (n < 1 || n > 32 || m > 8) return null;
  const optional = r - (106 + 2 * n + 2 * m);
  if (optional !== 0 && optional !== 12 && optional !== 14) return null;
  return { n, m, r, o: 34 + 2 * n + 2 * m, optional };
}

/**
 * True for a complete, consistent ANT_NEW status frame (CRC is checked by the assembler).
 * @param {Uint8Array} frame
 */
export const isStatusFrame = (frame) => statusLayout(frame) !== null;

/**
 * @typedef {Object} AntStatus ANT_NEW 0x11 status, device units and sign convention
 * @property {number} permission permission level byte (1 or 5 seen)
 * @property {number} systemState table 9.1
 * @property {number} tempSensorCount m, NTC probes
 * @property {number} cellCount n
 * @property {number} protectionMask0 protection bits 0..31
 * @property {number} protectionMask1 protection bits 32..63
 * @property {number} warningMask0 warning / status bits 0..31
 * @property {number} warningMask1 warning / status bits 32..63
 * @property {string} [reservedHex] bytes 26..33, meaning unknown
 * @property {number[]} cellVoltages V
 * @property {number[]} temperatures NTC probes, degrees C, -40 = absent
 * @property {number} mosTemperature
 * @property {number} balancerTemperature
 * @property {number} packVoltage V
 * @property {number} current A, positive while discharging
 * @property {number} soc %
 * @property {number} soh %
 * @property {number} dischargeMosState table 9.2
 * @property {number} chargeMosState table 9.3
 * @property {number} balanceState table 9.4
 * @property {number} capacityAh full (physical) capacity
 * @property {number} remainingAh
 * @property {number} cycleAh lifetime Ah counter
 * @property {number} power W, positive while discharging
 * @property {number} uptimeS
 * @property {number} balancingCellMask bit 0 = cell 1
 * @property {number} cellVoltageMax
 * @property {number} cellVoltageMaxCell 1 based
 * @property {number} cellVoltageMin
 * @property {number} cellVoltageMinCell 1 based
 * @property {number} cellVoltageDelta
 * @property {number} cellVoltageAverage
 * @property {number} [dischargeMosVoltage] V, scale unverified
 * @property {number} [dischargeMosGateVoltage] V, scale unverified
 * @property {number} [chargeMosGateVoltage] V, scale unverified
 * @property {number} [comparatorRaw] raw, meaning unverified
 * @property {number} batteryType table 9.7
 * @property {number} totalDischargeAh
 * @property {number} totalChargeAh
 * @property {number} totalDischargeTimeS
 * @property {number} totalChargeTimeS
 * @property {number} optionalBlockBytes 0, 12 or 14
 * @property {number} [chargeDurationS]
 * @property {number} [chargeIntervalS]
 * @property {number} [chargeTimeRemainingMin]
 * @property {number} [dischargeTimeRemainingMin]
 * @property {number} [optionalUnknown] trailing u16 of the 14 byte block
 */

/**
 * Parse a 0x11 status frame (spec 6.1). Every offset after byte 33 depends on n and m.
 * @param {Uint8Array} frame
 * @returns {AntStatus}
 */
export function parseStatus(frame) {
  const layout = statusLayout(frame);
  if (!layout) throw new Error('Not a valid ANT status frame');
  const { n, m, o, optional } = layout;
  const cellVoltages = [];
  for (let i = 0; i < n; i++) cellVoltages.push(u16le(frame, 34 + 2 * i) / 1000);
  const temperatures = [];
  for (let j = 0; j < m; j++) temperatures.push(i16le(frame, 34 + 2 * n + 2 * j));
  /** @type {AntStatus} */
  const s = {
    permission: frame[6],
    systemState: frame[7],
    tempSensorCount: m,
    cellCount: n,
    protectionMask0: u32le(frame, 10),
    protectionMask1: u32le(frame, 14),
    warningMask0: u32le(frame, 18),
    warningMask1: u32le(frame, 22),
    reservedHex: hex(frame.subarray(26, 34)),
    cellVoltages,
    temperatures,
    mosTemperature: i16le(frame, o),
    balancerTemperature: i16le(frame, o + 2),
    packVoltage: u16le(frame, o + 4) / 100,
    current: i16le(frame, o + 6) / 10,
    soc: u16le(frame, o + 8),
    soh: u16le(frame, o + 10),
    dischargeMosState: frame[o + 12],
    chargeMosState: frame[o + 13],
    balanceState: u16le(frame, o + 14),
    capacityAh: u32le(frame, o + 16) / 1e6,
    remainingAh: u32le(frame, o + 20) / 1e6,
    cycleAh: u32le(frame, o + 24) / 1000,
    power: i32le(frame, o + 28),
    uptimeS: u32le(frame, o + 32),
    balancingCellMask: u32le(frame, o + 36),
    cellVoltageMax: u16le(frame, o + 40) / 1000,
    cellVoltageMaxCell: u16le(frame, o + 42),
    cellVoltageMin: u16le(frame, o + 44) / 1000,
    cellVoltageMinCell: u16le(frame, o + 46),
    cellVoltageDelta: u16le(frame, o + 48) / 1000,
    cellVoltageAverage: u16le(frame, o + 50) / 1000,
    // Scales of the next four fields are unverified (spec 6.1); decoded for the log only.
    dischargeMosVoltage: u16le(frame, o + 52) / 10,
    dischargeMosGateVoltage: u16le(frame, o + 54) / 10,
    chargeMosGateVoltage: u16le(frame, o + 56) / 10,
    comparatorRaw: u16le(frame, o + 58),
    batteryType: u16le(frame, o + 60),
    totalDischargeAh: u32le(frame, o + 62) / 1000,
    totalChargeAh: u32le(frame, o + 66) / 1000,
    totalDischargeTimeS: u32le(frame, o + 70),
    totalChargeTimeS: u32le(frame, o + 74),
    optionalBlockBytes: optional,
  };
  if (optional >= 12) {
    s.chargeDurationS = u32le(frame, o + 78);
    s.chargeIntervalS = u32le(frame, o + 82);
    s.chargeTimeRemainingMin = u16le(frame, o + 86);
    s.dischargeTimeRemainingMin = u16le(frame, o + 88);
  }
  if (optional === 14) s.optionalUnknown = u16le(frame, o + 90);
  return s;
}

/**
 * Encode a status frame (device side, simulator and round trip tests). Takes the same field
 * names as `parseStatus` returns; missing fields are zero.
 * @param {Partial<AntStatus> & { cellVoltages: number[], temperatures: number[] }} s
 * @returns {Uint8Array}
 */
export function encodeStatus(s) {
  const n = s.cellVoltages.length;
  const m = s.temperatures.length;
  const optional = s.optionalBlockBytes ?? 0;
  const data = new Uint8Array(106 + 2 * n + 2 * m + optional);
  // Offsets below are frame offsets (as in the spec); data starts at frame offset 6.
  const put8 = (/** @type {number} */ off, /** @type {number} */ v) => (data[off - 6] = v & 0xff);
  const put16 = (/** @type {number} */ off, /** @type {number} */ v) => setU16le(data, off - 6, Math.round(v) & 0xffff);
  const put32 = (/** @type {number} */ off, /** @type {number} */ v) => setU32le(data, off - 6, Math.round(v) >>> 0);
  const o = 34 + 2 * n + 2 * m;
  put8(6, s.permission ?? 1);
  put8(7, s.systemState ?? 1);
  put8(8, m);
  put8(9, n);
  put32(10, s.protectionMask0 ?? 0);
  put32(14, s.protectionMask1 ?? 0);
  put32(18, s.warningMask0 ?? 0);
  put32(22, s.warningMask1 ?? 0);
  s.cellVoltages.forEach((v, i) => put16(34 + 2 * i, v * 1000));
  s.temperatures.forEach((t, j) => put16(34 + 2 * n + 2 * j, t));
  put16(o, s.mosTemperature ?? 0);
  put16(o + 2, s.balancerTemperature ?? 0);
  put16(o + 4, (s.packVoltage ?? 0) * 100);
  put16(o + 6, (s.current ?? 0) * 10);
  put16(o + 8, s.soc ?? 0);
  put16(o + 10, s.soh ?? 100);
  put8(o + 12, s.dischargeMosState ?? 1);
  put8(o + 13, s.chargeMosState ?? 1);
  put16(o + 14, s.balanceState ?? 0);
  put32(o + 16, (s.capacityAh ?? 0) * 1e6);
  put32(o + 20, (s.remainingAh ?? 0) * 1e6);
  put32(o + 24, (s.cycleAh ?? 0) * 1000);
  put32(o + 28, s.power ?? 0);
  put32(o + 32, s.uptimeS ?? 0);
  put32(o + 36, s.balancingCellMask ?? 0);
  put16(o + 40, (s.cellVoltageMax ?? 0) * 1000);
  put16(o + 42, s.cellVoltageMaxCell ?? 0);
  put16(o + 44, (s.cellVoltageMin ?? 0) * 1000);
  put16(o + 46, s.cellVoltageMinCell ?? 0);
  put16(o + 48, (s.cellVoltageDelta ?? 0) * 1000);
  put16(o + 50, (s.cellVoltageAverage ?? 0) * 1000);
  put16(o + 52, (s.dischargeMosVoltage ?? 0) * 10);
  put16(o + 54, (s.dischargeMosGateVoltage ?? 0) * 10);
  put16(o + 56, (s.chargeMosGateVoltage ?? 0) * 10);
  put16(o + 58, s.comparatorRaw ?? 0);
  put16(o + 60, s.batteryType ?? 0);
  put32(o + 62, (s.totalDischargeAh ?? 0) * 1000);
  put32(o + 66, (s.totalChargeAh ?? 0) * 1000);
  put32(o + 70, s.totalDischargeTimeS ?? 0);
  put32(o + 74, s.totalChargeTimeS ?? 0);
  if (optional >= 12) {
    put32(o + 78, s.chargeDurationS ?? 0);
    put32(o + 82, s.chargeIntervalS ?? 0);
    put16(o + 86, s.chargeTimeRemainingMin ?? 0);
    put16(o + 88, s.dischargeTimeRemainingMin ?? 0);
  }
  if (optional === 14) put16(o + 90, s.optionalUnknown ?? 0);
  return encodeNewResponse(RSP.STATUS, 0, data);
}

/**
 * Parameter read answer (0x12, spec 6.2). `rawValue` is set for 2 and 4 byte answers
 * (u16le / u32le); the register at address A is at `data[A - address]`.
 * @param {Uint8Array} frame
 */
export function parseReadResponse(frame) {
  const f = parseNewFrame(frame);
  if (f.func !== RSP.READ) throw new Error('Not a read response');
  /** @type {{ address: number, length: number, data: Uint8Array, rawValue?: number } & Record<string, any>} */
  const out = { address: f.address, length: f.length, data: f.data, ...extraFields(f) };
  if (f.length === 2) out.rawValue = u16le(f.data, 0);
  if (f.length === 4) out.rawValue = u32le(f.data, 0);
  return out;
}

/**
 * Device info: 0x12 answer to the read of 32 bytes at 0x026C (spec 6.2).
 * @param {Uint8Array} frame
 */
export function parseDeviceInfo(frame) {
  const f = parseNewFrame(frame);
  if (f.func !== RSP.READ || f.address !== ADDR.DEVICE_INFO || f.length < 32) throw new Error('Not a device info frame');
  return { hardwareVersion: asciiField(f.data, 0, 16), softwareVersion: asciiField(f.data, 16, 16), ...extraFields(f) };
}

/**
 * Pack ID (32 ASCII bytes at 262).
 * @param {Uint8Array} frame
 */
export function parsePackId(frame) {
  const f = parseNewFrame(frame);
  if (f.func !== RSP.READ || f.address !== ADDR.PACK_ID) throw new Error('Not a pack ID frame');
  return { address: f.address, length: f.length, packId: asciiField(f.data), ...extraFields(f) };
}

/**
 * Write echo (0x42, spec 6.3): address, length and the written bytes.
 * @param {Uint8Array} frame
 */
export function parseWriteResponse(frame) {
  const f = parseNewFrame(frame);
  if (f.func !== RSP.WRITE) throw new Error('Not a write response');
  /** @type {{ address: number, length: number, data: Uint8Array, rawValue?: number } & Record<string, any>} */
  const out = { address: f.address, length: f.length, data: f.data, ...extraFields(f) };
  if (f.length === 2) out.rawValue = u16le(f.data, 0);
  if (f.length === 4) out.rawValue = u32le(f.data, 0);
  return out;
}

/**
 * Password answer (0x43, spec 6.4): granted level u16le. Boards report this inconsistently
 * (spec 4.3), so the driver does not rely on it.
 * @param {Uint8Array} frame
 */
export function parseAuthResponse(frame) {
  const f = parseNewFrame(frame);
  if (f.func !== RSP.AUTH) throw new Error('Not a password response');
  return { address: f.address, length: f.length, permissionLevel: f.length >= 2 ? u16le(f.data, 0) : undefined, ...extraFields(f) };
}

/**
 * Control acknowledgement (0x61, spec 6.6): result 1 for every captured action, 3 for clear log.
 * @param {Uint8Array} frame
 */
export function parseControlResponse(frame) {
  const f = parseNewFrame(frame);
  if (f.func !== RSP.CONTROL) throw new Error('Not a control response');
  return { address: f.address, length: f.length, action: CONTROL_NAMES[f.address] ?? null, result: f.length >= 2 ? u16le(f.data, 0) : undefined };
}

/**
 * Answers with unknown meaning (0x13 log, 0x14 chip id, 0x15 system info, 0x16 GPRS): raw data.
 * @param {Uint8Array} frame
 */
export function parseRawResponse(frame) {
  const f = parseNewFrame(frame);
  return { function: f.func, address: f.address, length: f.length, dataHex: hex(f.data), ...extraFields(f) };
}

/**
 * Decode an ANT_NEW request (host to device) for the log and for tests.
 * The password of a 0x23 frame is masked for the log unless `revealPassword` is set.
 * @param {Uint8Array} frame
 * @param {{ revealPassword?: boolean }} [opts]
 */
export function parseNewRequest(frame, { revealPassword = false } = {}) {
  const func = frame[2];
  const address = u16le(frame, 3);
  const length = frame[5];
  /** @type {Record<string, any>} */
  const out = { function: func, address, length };
  const payload = frame.subarray(6, frame.length - 4);
  if (func === FN.AUTH) {
    const text = String.fromCharCode(...payload);
    out.password = revealPassword ? text : '*'.repeat(text.length);
  } else if (func === FN.WRITE) {
    out.dataHex = hex(payload);
    if (payload.length === 2) out.rawValue = u16le(payload, 0);
    if (payload.length === 4) out.rawValue = u32le(payload, 0);
  } else if (func === FN.CONTROL) {
    out.action = CONTROL_NAMES[address] ?? null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ANT_NEW code tables (spec 9). Labels are user visible (overview "More values").
// ---------------------------------------------------------------------------------------------

/** System state, status offset 7 (table 9.1, yosle numbering confirmed by captures). */
export const SYSTEM_STATES = Object.freeze({
  0: msg('Unknown'),
  1: msg('Idle'),
  2: msg('Charging'),
  3: msg('Standby'),
  4: msg('Discharging'),
  5: msg('Fault'),
});

/** Discharge MOSFET state, status `o+12` (table 9.2). */
export const DISCHARGE_MOS_STATES = Object.freeze({
  0: msg('Off'),
  1: msg('On'),
  2: msg('Cell undervoltage protection'),
  3: msg('Overcurrent protection'),
  4: msg('Overcurrent protection, level 2'),
  5: msg('Pack undervoltage protection'),
  6: msg('Battery overtemperature'),
  7: msg('MOSFET overtemperature'),
  8: msg('Abnormal current'),
  9: msg('Balance wire disconnected'),
  10: msg('Board overtemperature'),
  11: msg('Charge MOSFET on (charger connected)'),
  12: msg('Short circuit protection'),
  13: msg('Discharge MOSFET abnormal'),
  14: msg('Failed to switch on'),
  15: msg('Switched off manually'),
  16: msg('Undervoltage protection, level 2'),
  17: msg('Low temperature protection'),
  18: msg('Voltage difference too high'),
  19: msg('Self test error'),
});

/** Charge MOSFET state, status `o+13` (table 9.3, ESPHome numbering confirmed by captures). */
export const CHARGE_MOS_STATES = Object.freeze({
  0: msg('Off'),
  1: msg('On'),
  2: msg('Cell overvoltage protection'),
  3: msg('Overcurrent protection'),
  4: msg('Battery full'),
  5: msg('Pack overvoltage protection'),
  6: msg('Battery overtemperature'),
  7: msg('MOSFET overtemperature'),
  8: msg('Abnormal current'),
  9: msg('Balance wire disconnected'),
  10: msg('Board overtemperature'),
  12: msg('Failed to switch on'),
  13: msg('Discharge MOSFET abnormal'),
  14: msg('Waiting'),
  15: msg('Switched off manually'),
  16: msg('Overvoltage protection, level 2'),
  17: msg('Low temperature protection'),
  18: msg('Voltage difference too high'),
  20: msg('Self test error'),
});

/** Balance state, status `o+14` (table 9.4). */
export const BALANCE_STATES = Object.freeze({
  0: msg('Off'),
  1: msg('Limit exceeded, balancing'),
  2: msg('Balancing voltage difference while charging'),
  3: msg('Balancer overtemperature'),
  4: msg('Automatic balancing'),
  5: msg('Manual balancing'),
  10: msg('Board overtemperature'),
});

/** Balance states that mean "the balancer is working". */
export const BALANCING_STATES = Object.freeze([1, 2, 4, 5]);

/** Battery type, status `o+60` (table 9.7). 0 = not reported (early firmware). */
export const BATTERY_TYPES = Object.freeze({
  0xfaf1: msg('Ternary lithium (NMC)'),
  0xfaf2: msg('LiFePO4'),
  0xfaf3: msg('Lithium titanate (LTO)'),
  0xfaf4: msg('Custom'),
  0xfaf5: msg('None'),
  0xfaf6: msg('Sodium ion'),
});

/**
 * @typedef {{ bit: number, id: string, severity?: 'info'|'warning'|'protection'|'fault', label?: string }} AntAlarmBit
 */

/**
 * Protection bits (status offsets 10..17, table 9.5, absolute bit numbers 0..63). Bits 1, 17 and
 * 21 are verified by captures, the others come from the 2024 app. Status-like bits (31 starting,
 * 34 charger connected, 36 ignition prevention) and flags with unknown meaning (32, 33, 37) are
 * not reported as alarms.
 * @type {AntAlarmBit[]}
 */
export const PROTECTION_BITS = [
  { bit: 0, id: 'ant.cell_type', severity: 'fault', label: msg('Cell type setting error') },
  { bit: 1, id: 'cell_overvoltage' },
  { bit: 2, id: 'cell_overvoltage', label: msg('Cell overvoltage, level 2') },
  { bit: 3, id: 'pack_overvoltage' },
  { bit: 4, id: 'cell_undervoltage' },
  { bit: 5, id: 'cell_undervoltage', label: msg('Cell undervoltage, level 2') },
  { bit: 6, id: 'pack_undervoltage' },
  { bit: 7, id: 'cell_voltage_difference', severity: 'protection' },
  { bit: 8, id: 'charge_overtemperature' },
  { bit: 9, id: 'discharge_overtemperature' },
  { bit: 10, id: 'mos_overtemperature' },
  { bit: 11, id: 'charge_undertemperature' },
  { bit: 12, id: 'discharge_undertemperature' },
  { bit: 13, id: 'charge_overcurrent' },
  { bit: 14, id: 'discharge_overcurrent' },
  { bit: 15, id: 'discharge_overcurrent', label: msg('Discharge overcurrent, level 2') },
  { bit: 16, id: 'short_circuit' },
  { bit: 17, id: 'ant.discharge_manual_off', severity: 'warning', label: msg('Discharge MOSFET switched off manually') },
  { bit: 18, id: 'ant.discharge_manual_off_2', severity: 'warning', label: msg('Discharge MOSFET 2 switched off manually') },
  { bit: 19, id: 'ant.discharge_manual_off_3', severity: 'warning', label: msg('Discharge MOSFET 3 switched off manually') },
  { bit: 20, id: 'ant.discharge_manual_off_4', severity: 'warning', label: msg('Discharge MOSFET 4 switched off manually') },
  { bit: 21, id: 'ant.charge_manual_off', severity: 'warning', label: msg('Charge MOSFET switched off manually') },
  { bit: 22, id: 'ant.charge_manual_off_2', severity: 'warning', label: msg('Charge MOSFET 2 switched off manually') },
  { bit: 23, id: 'ant.charge_manual_off_3', severity: 'warning', label: msg('Charge MOSFET 3 switched off manually') },
  { bit: 24, id: 'ant.charge_manual_off_4', severity: 'warning', label: msg('Charge MOSFET 4 switched off manually') },
  { bit: 25, id: 'cell_wire_open', label: msg('Open line') },
  { bit: 26, id: 'current_sensor_fault' },
  { bit: 27, id: 'discharge_mos_fault' },
  { bit: 28, id: 'charge_mos_fault' },
  { bit: 29, id: 'communication_fault' },
  { bit: 30, id: 'precharge_fault' },
  { bit: 35, id: 'ant.dtu_lost', severity: 'warning', label: msg('Telemetry module (DTU) lost') },
  { bit: 38, id: 'ant.firmware_upgrade', severity: 'warning', label: msg('Firmware upgrade required') },
  { bit: 39, id: 'precharge_fault', label: msg('Relay precharge failure') },
  { bit: 40, id: 'ant.relay_stuck', severity: 'fault', label: msg('Relay stuck') },
  { bit: 41, id: 'ant.discharge_fuse', severity: 'fault', label: msg('Abnormal discharge fuse') },
  { bit: 42, id: 'ant.charge_fuse', severity: 'fault', label: msg('Abnormal charge fuse') },
  { bit: 43, id: 'ant.module_lost', severity: 'fault', label: msg('Module lost') },
  { bit: 44, id: 'ant.device_expired', severity: 'warning', label: msg('Device expired') },
];

/**
 * Warning bits (status offsets 18..25, table 9.6). Verified by captures: 7, 12, 13 (and the
 * status bits 19, 23, 24, 26, 29). Pure status bits (17..30 and 35..44 except the faults below)
 * are not alarms.
 * @type {AntAlarmBit[]}
 */
export const WARNING_BITS = [
  { bit: 0, id: 'cell_overvoltage', severity: 'warning' },
  { bit: 1, id: 'pack_overvoltage', severity: 'warning' },
  { bit: 2, id: 'cell_undervoltage', severity: 'warning' },
  { bit: 3, id: 'pack_undervoltage', severity: 'warning' },
  { bit: 4, id: 'cell_voltage_difference', severity: 'warning' },
  { bit: 5, id: 'charge_overtemperature', severity: 'warning' },
  { bit: 6, id: 'discharge_overtemperature', severity: 'warning' },
  { bit: 7, id: 'charge_undertemperature', severity: 'warning' },
  { bit: 8, id: 'discharge_undertemperature', severity: 'warning' },
  { bit: 9, id: 'mos_overtemperature', severity: 'warning' },
  { bit: 10, id: 'charge_overcurrent', severity: 'warning' },
  { bit: 11, id: 'discharge_overcurrent', severity: 'warning' },
  { bit: 12, id: 'soc_low', severity: 'warning' },
  { bit: 13, id: 'ant.soc_low_2', severity: 'warning', label: msg('Low state of charge, level 2') },
  { bit: 14, id: 'voltage_sensor_fault', label: msg('Wrong cell voltage') },
  { bit: 15, id: 'cell_count_mismatch' },
  { bit: 16, id: 'precharge_fault' },
  { bit: 33, id: 'ant.system_error', severity: 'fault', label: msg('System error') },
  { bit: 34, id: 'ant.dtu_lost', severity: 'warning', label: msg('Telemetry module (DTU) lost') },
  { bit: 43, id: 'ant.crystal_error', severity: 'fault', label: msg('Crystal oscillator error') },
];

/** Warning bit 38: Bluetooth module switched off (2024 app, unverified). */
export const WARNING_BIT_BLUETOOTH_OFF = 38;

// ---------------------------------------------------------------------------------------------
// ANT_OLD (legacy) protocol
// ---------------------------------------------------------------------------------------------

export const OLD_STATUS_HEADER = Object.freeze([0xaa, 0x55, 0xaa, 0xff]);
export const OLD_STATUS_LENGTH = 140;

/** Command headers (spec 3.6): A5 A5 write, 5A 5A read, DB DB status over Bluetooth. */
export const OLD_HEADER = Object.freeze({ WRITE: 0xa5, READ: 0x5a, STATUS_BT: 0xdb });

/** ANT_OLD control addresses (spec 8). 0xF6 (change MAC) is unverified and absent on purpose. */
export const OLD_CONTROL = Object.freeze({
  LTO_PARAMS: 0xf0,
  PASSWORD_1: 0xf1,
  PASSWORD_2: 0xf2,
  PASSWORD_3: 0xf3,
  PASSWORD_4: 0xf4,
  PASSWORD_CHECK: 0xf5,
  POWER_OFF: 0xf7,
  CURRENT_ZERO: 0xf8,
  DISCHARGE: 0xf9,
  CHARGE: 0xfa,
  LFP_PARAMS: 0xfb,
  BALANCE_TOGGLE: 0xfc,
  FACTORY_DEFAULTS: 0xfd,
  REBOOT: 0xfe,
  APPLY: 0xff,
});

const OLD_CONTROL_NAMES = Object.freeze({
  [OLD_CONTROL.LTO_PARAMS]: 'LTO parameter set',
  [OLD_CONTROL.PASSWORD_1]: 'Password 1/4',
  [OLD_CONTROL.PASSWORD_2]: 'Password 2/4',
  [OLD_CONTROL.PASSWORD_3]: 'Password 3/4',
  [OLD_CONTROL.PASSWORD_4]: 'Password 4/4',
  [OLD_CONTROL.PASSWORD_CHECK]: 'Password check',
  [OLD_CONTROL.POWER_OFF]: 'Power off',
  [OLD_CONTROL.CURRENT_ZERO]: 'Current zero',
  [OLD_CONTROL.DISCHARGE]: 'Discharge MOSFET',
  [OLD_CONTROL.CHARGE]: 'Charge MOSFET',
  [OLD_CONTROL.LFP_PARAMS]: 'LiFePO4 parameter set',
  [OLD_CONTROL.BALANCE_TOGGLE]: 'Balance toggle',
  [OLD_CONTROL.FACTORY_DEFAULTS]: 'Factory defaults',
  [OLD_CONTROL.REBOOT]: 'Reboot',
  [OLD_CONTROL.APPLY]: 'Apply',
});

/**
 * Build a 6 byte ANT_OLD command: `HH HH addr vh vl sum`, sum = (addr + vh + vl) & 0xFF.
 * @param {number} header 0xA5, 0x5A or 0xDB
 * @param {number} address
 * @param {number} value u16
 */
export function encodeOldCommand(header, address, value) {
  const f = new Uint8Array(6);
  f[0] = header & 0xff;
  f[1] = header & 0xff;
  f[2] = address & 0xff;
  setU16be(f, 3, value & 0xffff);
  f[5] = sum8(f, 2, 5);
  return f;
}

/** Status request over Bluetooth (BLE and SPP), also accepted on UART: `DBDB00000000`. */
export const oldStatusRequestBt = () => encodeOldCommand(OLD_HEADER.STATUS_BT, 0, 0);
/** Status request on UART: `5A5A00000101`. */
export const oldStatusRequestUart = () => encodeOldCommand(OLD_HEADER.READ, 0, 1);
/**
 * Read parameter N: `5A5A NN 0000 NN` (answer layout unverified beyond two sources, spec 3.6).
 * @param {number} param
 */
export const oldReadRequest = (param) => encodeOldCommand(OLD_HEADER.READ, param, 0);
/**
 * Write command `A5A5 NN VH VL sum` (control addresses or parameters).
 * @param {number} address
 * @param {number} value
 */
export const oldWriteCommand = (address, value) => encodeOldCommand(OLD_HEADER.WRITE, address, value);
/** Apply previous writes: `A5A5FF0000FF`. */
export const oldApplyCommand = () => oldWriteCommand(OLD_CONTROL.APPLY, 0);

/**
 * Password frames F1..F4, two characters per frame as u16be (spec 4.4, 7.4).
 * @param {string} password exactly 8 characters
 * @returns {Uint8Array[]}
 */
export function oldPasswordFrames(password) {
  if (password.length !== 8) throw new Error('The old protocol password has 8 characters');
  const c = (/** @type {number} */ i) => password.charCodeAt(i) & 0xff;
  return [0, 1, 2, 3].map((k) => oldWriteCommand(OLD_CONTROL.PASSWORD_1 + k, (c(2 * k) << 8) | c(2 * k + 1)));
}

/**
 * Password used in the captured ANT_OLD sessions (ESPHome issue #61). The factory default of old
 * boards is not documented; this is only the initial value of the password field.
 */
export const OLD_CAPTURED_PASSWORD = '12345678';

/** Answer seen when a write was not accepted (no or wrong password), meaning inferred (spec 3.6). */
export const OLD_REJECTED = Object.freeze([0xa5, 0xa5, OLD_CONTROL.PASSWORD_CHECK, 0x00, 0x01, 0xf6]);

/**
 * @param {Uint8Array} frame
 */
export const isOldRejection = (frame) => frame.length === 6 && OLD_REJECTED.every((b, i) => frame[i] === b);

/**
 * Validate a 6 byte command or answer.
 * @param {Uint8Array} frame
 */
export function validateOldCommand(frame) {
  return (
    frame.length === 6 &&
    frame[0] === frame[1] &&
    (frame[0] === OLD_HEADER.WRITE || frame[0] === OLD_HEADER.READ || frame[0] === OLD_HEADER.STATUS_BT) &&
    sum8(frame, 2, 5) === frame[5]
  );
}

/**
 * Validate a 140 byte status: header, 16 bit sum of bytes 4..137 (big endian at 138), cell count.
 * @param {Uint8Array} frame
 */
export function validateOldStatus(frame) {
  if (frame.length !== OLD_STATUS_LENGTH) return false;
  for (let i = 0; i < 4; i++) if (frame[i] !== OLD_STATUS_HEADER[i]) return false;
  return sum16(frame, 4, 138) === u16be(frame, 138);
}

/**
 * True for a valid 140 byte status whose cell count is plausible (spec 11.2 step 3).
 * @param {Uint8Array} frame
 */
export const isOldStatusFrame = (frame) => validateOldStatus(frame) && frame[123] >= 1 && frame[123] <= 32;

/**
 * Parse a 6 byte command or answer.
 * @param {Uint8Array} frame
 */
export function parseOldCommand(frame) {
  return { header: frame[0], address: frame[2], value: u16be(frame, 3) };
}

/**
 * @typedef {Object} AntOldStatus ANT_OLD 140 byte status, device units and sign convention
 * @property {number} packVoltage
 * @property {number} cellCount
 * @property {number[]} cellVoltages first `cellCount` of 32 slots
 * @property {number} current A, positive while discharging
 * @property {number} soc
 * @property {number} capacityAh 0 on some 2020 boards
 * @property {number} remainingAh
 * @property {number} cycleAh
 * @property {number} uptimeS
 * @property {number[]} temperatureRaw91to101 MOS, balancer, NTC 1..4
 * @property {number} mosTemperature
 * @property {number} balancerTemperature
 * @property {number[]} temperatures NTC 1..4
 * @property {number} chargeMosState table 9.8
 * @property {number} dischargeMosState table 9.9
 * @property {number} balanceState table 9.10
 * @property {number} tireLengthMm
 * @property {number} pulsesPerRevolution
 * @property {number} relay
 * @property {number} power W, positive while discharging; 9999 = placeholder on 2021 boards
 * @property {number} cellVoltageMaxCell
 * @property {number} cellVoltageMax
 * @property {number} cellVoltageMinCell
 * @property {number} cellVoltageMin
 * @property {number} cellVoltageAverage
 * @property {number} dischargeMosVoltage
 * @property {number} dischargeMosGateVoltage
 * @property {number} chargeMosGateVoltage
 * @property {number} comparatorRaw
 * @property {number} balancingCellMask
 * @property {number} systemLog
 */

/** Power value used as a placeholder by 2021 boards answering the old request (spec 12.2 item 16). */
export const OLD_POWER_PLACEHOLDER = 9999;

/**
 * Parse the 140 byte ANT_OLD status (spec 6.8). All values big endian.
 * @param {Uint8Array} frame
 * @returns {AntOldStatus}
 */
export function parseOldStatus(frame) {
  if (!validateOldStatus(frame)) throw new Error('Not a valid ANT old protocol status frame');
  const n = frame[123];
  if (n < 1 || n > 32) throw new Error('Implausible cell count in old status frame');
  const cellVoltages = [];
  for (let i = 0; i < n; i++) cellVoltages.push(u16be(frame, 6 + 2 * i) / 1000);
  const temperatureRaw91to101 = [];
  for (let k = 0; k < 6; k++) temperatureRaw91to101.push(i16be(frame, 91 + 2 * k));
  return {
    packVoltage: u16be(frame, 4) / 10,
    cellCount: n,
    cellVoltages,
    current: i32be(frame, 70) / 10,
    soc: frame[74],
    capacityAh: u32be(frame, 75) / 1e6,
    remainingAh: u32be(frame, 79) / 1e6,
    cycleAh: u32be(frame, 83) / 1000,
    uptimeS: u32be(frame, 87),
    temperatureRaw91to101,
    mosTemperature: temperatureRaw91to101[0],
    balancerTemperature: temperatureRaw91to101[1],
    temperatures: temperatureRaw91to101.slice(2),
    chargeMosState: frame[103],
    dischargeMosState: frame[104],
    balanceState: frame[105],
    tireLengthMm: u16be(frame, 106),
    pulsesPerRevolution: u16be(frame, 108),
    relay: frame[110],
    power: i32be(frame, 111),
    cellVoltageMaxCell: frame[115],
    cellVoltageMax: u16be(frame, 116) / 1000,
    cellVoltageMinCell: frame[118],
    cellVoltageMin: u16be(frame, 119) / 1000,
    cellVoltageAverage: u16be(frame, 121) / 1000,
    dischargeMosVoltage: u16be(frame, 124) / 10,
    dischargeMosGateVoltage: u16be(frame, 126) / 10,
    chargeMosGateVoltage: u16be(frame, 128) / 10,
    comparatorRaw: u16be(frame, 130),
    balancingCellMask: u32be(frame, 132),
    systemLog: u16be(frame, 136),
  };
}

/**
 * Encode the 140 byte status (simulators and round trip tests).
 * @param {Partial<AntOldStatus> & { cellVoltages: number[] }} s
 * @returns {Uint8Array}
 */
export function encodeOldStatus(s) {
  const f = new Uint8Array(OLD_STATUS_LENGTH);
  f.set(OLD_STATUS_HEADER, 0);
  const n = s.cellVoltages.length;
  setU16be(f, 4, Math.round((s.packVoltage ?? 0) * 10));
  for (let i = 0; i < n; i++) setU16be(f, 6 + 2 * i, Math.round(s.cellVoltages[i] * 1000));
  setU32be(f, 70, Math.round((s.current ?? 0) * 10) >>> 0);
  f[74] = s.soc ?? 0;
  setU32be(f, 75, Math.round((s.capacityAh ?? 0) * 1e6) >>> 0);
  setU32be(f, 79, Math.round((s.remainingAh ?? 0) * 1e6) >>> 0);
  setU32be(f, 83, Math.round((s.cycleAh ?? 0) * 1000) >>> 0);
  setU32be(f, 87, Math.round(s.uptimeS ?? 0) >>> 0);
  const temps = [s.mosTemperature ?? 0, s.balancerTemperature ?? 0, ...(s.temperatures ?? [])];
  for (let k = 0; k < 6; k++) setU16be(f, 91 + 2 * k, Math.round(temps[k] ?? ABSENT_TEMPERATURE) & 0xffff);
  f[103] = s.chargeMosState ?? 1;
  f[104] = s.dischargeMosState ?? 1;
  f[105] = s.balanceState ?? 0;
  setU16be(f, 106, s.tireLengthMm ?? 0);
  setU16be(f, 108, s.pulsesPerRevolution ?? 0);
  f[110] = s.relay ?? 0;
  setU32be(f, 111, Math.round(s.power ?? 0) >>> 0);
  f[115] = s.cellVoltageMaxCell ?? 0;
  setU16be(f, 116, Math.round((s.cellVoltageMax ?? 0) * 1000));
  f[118] = s.cellVoltageMinCell ?? 0;
  setU16be(f, 119, Math.round((s.cellVoltageMin ?? 0) * 1000));
  setU16be(f, 121, Math.round((s.cellVoltageAverage ?? 0) * 1000));
  f[123] = s.cellCount ?? n;
  setU16be(f, 124, Math.round((s.dischargeMosVoltage ?? 0) * 10));
  setU16be(f, 126, Math.round((s.dischargeMosGateVoltage ?? 0) * 10));
  setU16be(f, 128, Math.round((s.chargeMosGateVoltage ?? 0) * 10));
  setU16be(f, 130, s.comparatorRaw ?? 0);
  setU32be(f, 132, (s.balancingCellMask ?? 0) >>> 0);
  setU16be(f, 136, s.systemLog ?? 0);
  setU16be(f, 138, sum16(f, 4, 138));
  return f;
}

/** ANT_OLD charge MOSFET state, offset 103 (table 9.8). */
export const OLD_CHARGE_MOS_STATES = Object.freeze({
  0: msg('Off'),
  1: msg('On'),
  2: msg('Cell overvoltage protection'),
  3: msg('Overcurrent protection'),
  4: msg('Battery full'),
  5: msg('Pack overvoltage protection'),
  6: msg('Battery overtemperature'),
  7: msg('MOSFET overtemperature'),
  8: msg('Abnormal current'),
  9: msg('Balance wire disconnected'),
  10: msg('Board overtemperature'),
  13: msg('Discharge MOSFET abnormal'),
  15: msg('Switched off manually'),
});

/** ANT_OLD discharge MOSFET state, offset 104 (table 9.9). */
export const OLD_DISCHARGE_MOS_STATES = Object.freeze({
  0: msg('Off'),
  1: msg('On'),
  2: msg('Cell undervoltage protection'),
  3: msg('Overcurrent protection'),
  5: msg('Pack undervoltage protection'),
  6: msg('Battery overtemperature'),
  7: msg('MOSFET overtemperature'),
  8: msg('Abnormal current'),
  9: msg('Balance wire disconnected'),
  10: msg('Board overtemperature'),
  11: msg('Charge MOSFET on (charger connected)'),
  12: msg('Short circuit protection'),
  13: msg('Discharge MOSFET abnormal'),
  14: msg('Failed to switch on'),
  15: msg('Switched off manually'),
});

/** ANT_OLD balance state, offset 105 (table 9.10). */
export const OLD_BALANCE_STATES = Object.freeze({
  0: msg('Off'),
  1: msg('Limit exceeded, balancing'),
  2: msg('Balancing voltage difference while charging'),
  3: msg('Balancer overtemperature'),
  4: msg('Automatic balancing'),
  10: msg('Board overtemperature'),
});

/**
 * Length of the legacy frame at the start of `buf`: 140 for the status, 6 for commands and
 * their answers, the ANT_NEW rules for `7E A1` (used by the legacy probe to recognize boards
 * that also speak the 2021 protocol, spec 11.2 step 5).
 * @param {Uint8Array} buf
 */
export function legacyFrameLength(buf) {
  if (buf[0] === 0x7e) return newFrameLength(buf);
  if (buf[0] === 0xaa) return OLD_STATUS_LENGTH;
  return 6;
}

/** @param {Uint8Array} frame */
export function validateLegacyFrame(frame) {
  if (frame[0] === 0x7e) return validateNewFrame(frame);
  if (frame[0] === 0xaa) return validateOldStatus(frame);
  return validateOldCommand(frame);
}

/**
 * Frame assembler for the ANT_OLD driver (host side): 140 byte status, 6 byte answers and echoes,
 * and ANT_NEW frames. Adapter junk (for example appended 0xFF bytes) is skipped.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createLegacyAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [OLD_STATUS_HEADER, [OLD_HEADER.READ, OLD_HEADER.READ], [OLD_HEADER.WRITE, OLD_HEADER.WRITE], NEW_HEADER],
    length: legacyFrameLength,
    validate: validateLegacyFrame,
    onFrame,
    onDiscard,
    maxLength: NEW_MAX_FRAME,
  });
}

/**
 * Frame assembler for the device side of a simulator: ANT_NEW requests and 6 byte ANT_OLD
 * commands (including `DB DB` status requests).
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createRequestAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [NEW_HEADER, [OLD_HEADER.READ, OLD_HEADER.READ], [OLD_HEADER.WRITE, OLD_HEADER.WRITE], [OLD_HEADER.STATUS_BT, OLD_HEADER.STATUS_BT]],
    length: (buf) => (buf[0] === 0x7e ? newRequestLength(buf) : 6),
    validate: (frame) => (frame[0] === 0x7e ? validateNewRequest(frame) : validateOldCommand(frame)),
    onFrame,
    onDiscard,
    maxLength: 10 + 255,
  });
}

// ---------------------------------------------------------------------------------------------
// Protocol log descriptions
// ---------------------------------------------------------------------------------------------

/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode?: () => any }}
 */
function describeNew(frame) {
  const func = frame[2];
  const address = frame.length >= 5 ? u16le(frame, 3) : 0;
  const req = () => parseNewRequest(frame);
  switch (func) {
    case FN.STATUS:
      return { name: 'Status request (0x01)', decode: req };
    case FN.READ:
      return { name: address === ADDR.DEVICE_INFO ? 'Device info request (0x02)' : 'Read request (0x02)', decode: req };
    case FN.LOG:
      return { name: 'System log request (0x03)', decode: req };
    case FN.CHIP_ID:
      return { name: 'Chip ID request (0x04)', decode: req };
    case FN.SYSTEM_INFO:
      return { name: 'System info request (0x05)', decode: req };
    case FN.GPRS:
      return { name: 'GPRS request (0x06)', decode: req };
    case FN.WRITE:
      return { name: 'Write request (0x22)', decode: req };
    case FN.AUTH:
      return { name: 'Password (0x23)', decode: req };
    case FN.CONTROL:
      return { name: `Control request (0x51): ${CONTROL_NAMES[address] ?? `action ${h2(address)}`}`, decode: req };
    case FN.FACTORY_RESET_2024:
      return { name: 'Factory reset request (0x53)', decode: req };
    case RSP.STATUS:
      return { name: 'Status response (0x11)', decode: () => parseStatus(frame) };
    case RSP.READ:
      return address === ADDR.DEVICE_INFO
        ? { name: 'Device info response (0x12)', decode: () => parseDeviceInfo(frame) }
        : { name: 'Read response (0x12)', decode: () => readResponseForLog(frame) };
    case RSP.LOG:
      return { name: 'System log response (0x13)', decode: () => parseRawResponse(frame) };
    case RSP.CHIP_ID:
      return { name: 'Chip ID response (0x14)', decode: () => parseRawResponse(frame) };
    case RSP.SYSTEM_INFO:
      return { name: 'System info response (0x15)', decode: () => parseRawResponse(frame) };
    case RSP.GPRS:
      return { name: 'GPRS response (0x16)', decode: () => parseRawResponse(frame) };
    case RSP.WRITE:
      return { name: 'Write response (0x42)', decode: () => withHex(parseWriteResponse(frame)) };
    case RSP.AUTH:
      return { name: 'Password response (0x43)', decode: () => parseAuthResponse(frame) };
    case RSP.CONTROL:
      return { name: `Control response (0x61): ${CONTROL_NAMES[address] ?? `action ${h2(address)}`}`, decode: () => parseControlResponse(frame) };
    default:
      return { name: `Unknown frame (${h2(func)})`, decode: () => parseRawResponse(frame) };
  }
}

/** @param {{ data: Uint8Array } & Record<string, any>} o */
function withHex(o) {
  const { data, ...rest } = o;
  return { ...rest, dataHex: hex(data) };
}

/** @param {Uint8Array} frame */
function readResponseForLog(frame) {
  const r = parseReadResponse(frame);
  /** @type {Record<string, any>} */
  const out = withHex(r);
  if (r.data.length > 4 && r.data.length % 2 === 0) {
    const words = [];
    for (let i = 0; i < r.data.length; i += 2) words.push(u16le(r.data, i));
    out.words = words;
  }
  return out;
}

/**
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode?: () => any }}
 */
function describeOldCommand(frame) {
  const c = parseOldCommand(frame);
  const decode = () => c;
  if (c.header === OLD_HEADER.STATUS_BT) return { name: 'Old status request (DB DB)', decode };
  if (c.header === OLD_HEADER.READ) {
    return c.address === 0 ? { name: 'Old status request (5A 5A)', decode } : { name: `Old parameter read (5A 5A), #${c.address}`, decode };
  }
  if (isOldRejection(frame)) return { name: 'Old write rejected (A5 A5 F5)', decode };
  const control = /** @type {Record<number, string>} */ (OLD_CONTROL_NAMES)[c.address];
  return { name: control ? `Old control (A5 A5): ${control}` : `Old parameter write (A5 A5), #${c.address}`, decode };
}

/**
 * Name and lazy decoder of a frame of either generation for the protocol log.
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describe(frame) {
  if (!frame || frame.length < 2) return null;
  if (frame[0] === 0x7e && frame[1] === 0xa1 && frame.length >= 6) return describeNew(frame);
  if (frame.length === OLD_STATUS_LENGTH && frame[0] === 0xaa) return { name: 'Old protocol status (AA 55 AA FF)', decode: () => parseOldStatus(frame) };
  if (frame.length === 6 && frame[0] === frame[1]) return describeOldCommand(frame);
  return null;
}
