import { FrameAssembler, hex } from '@ubms/transport';
import { r } from '../common/util.js';

/**
 * JBD (Jiabaida) smart BMS "DD A5" protocol and the "FF AA" commands of the newer Bluetooth
 * modules, pure functions without I/O. Specification: docs/protocols/jbd.md ("spec" below).
 *
 * - Requests `DD A5|5A reg len data sum16 77`, answers `DD reg status len data sum16 77`, all
 *   multi-byte values big endian (spec 3.1 to 3.4). The checksum covers bytes 2 .. 3 + n of both
 *   directions, so one validator serves the host and the simulator.
 * - Bluetooth module frames `FF AA cmd len data sum8` (spec 3.6, 4.2), handled by the module.
 *
 * Parsers return plain objects whose keys match the test vectors
 * (packages/bms-drivers/test/vectors/jbd.json). Values are engineering units (V, A, Ah, degrees C).
 * The UP series protocol is in up.js.
 */

/** Protocol variants (labels of the test vectors, spec 11.6). */
export const VARIANT = Object.freeze({ JBD: 'JBD', DAREN: 'DAREN', UP: 'JBD_UP' });

export const START = 0xdd;
export const END = 0x77;
export const OP_READ = 0xa5;
export const OP_WRITE = 0x5a;

/** Registers (command codes) used by ubms and named in the log (spec 5.1). */
export const REG = Object.freeze({
  FACTORY_ENTER: 0x00,
  FACTORY_EXIT: 0x01,
  BASIC: 0x03,
  CELLS: 0x04,
  VERSION: 0x05,
  PASSWORD: 0x06,
  PASSWORD_CHANGE: 0x07,
  PASSWORD_CLEAR: 0x09,
  CONTROL: 0x0a,
  ERROR_COUNTS: 0xaa,
  MOS: 0xe1,
  FA: 0xfa,
  FB: 0xfb,
});

/** Answer status codes (spec 3.4). 0x82 and 0x83 were never observed (unverified). */
export const STATUS = Object.freeze({ OK: 0x00, ERROR: 0x80, INVALID: 0x81, CHECKSUM: 0x82, PASSWORD: 0x83 });

/** Data of the factory mode writes (spec 4.4). */
export const FACTORY = Object.freeze({ ENTER: 0x5678, EXIT: 0x0000, EXIT_SAVE: 0x2828 });

/** Function codes of the V11 control command 0x0A (spec 8.3). */
export const CONTROL = Object.freeze({
  RESET_CAPACITY: 0x0100,
  CLEAR_HISTORY: 0x0200,
  RESTART: 0x0300,
  CLEAR_PROTECTION: 0x0400,
  SLEEP: 0x0500,
  POWER_DOWN: 0x0600,
  AUTO_BALANCE: 0x0700,
  STORAGE_MODE: 0x0800,
  SOC20_SWITCH: 0x0900,
  FORCE_ON_BELOW_20: 0x0a00,
  FORCE_START: 0x0b00,
  FORCE_HEATING: 0x0c00,
});

const CONTROL_NAMES = Object.freeze({
  [CONTROL.RESET_CAPACITY]: 'resetCapacity',
  [CONTROL.CLEAR_HISTORY]: 'clearHistory',
  [CONTROL.RESTART]: 'restart',
  [CONTROL.CLEAR_PROTECTION]: 'clearProtection',
  [CONTROL.SLEEP]: 'sleep',
  [CONTROL.POWER_DOWN]: 'powerDown',
  [CONTROL.AUTO_BALANCE]: 'autoBalance',
  [CONTROL.STORAGE_MODE]: 'storageMode',
  [CONTROL.SOC20_SWITCH]: 'soc20Switch',
  [CONTROL.FORCE_ON_BELOW_20]: 'forceOnBelow20',
  [CONTROL.FORCE_START]: 'forceStart',
  [CONTROL.FORCE_HEATING]: 'forceHeating',
});

/** Bluetooth module commands (spec 5.3). */
export const FFAA = Object.freeze({ RENAME: 0x07, APP_KEY: 0x15, CHANGE_PASSWORD: 0x16, RANDOM: 0x17, PASSWORD: 0x18, ROOT: 0x1d });

/** Fixed app key of the official app (spec 4.2 step 1). */
export const APP_KEY = '000000';
/** Root password of the module login (spec 4.2 step 5, [SY] send_root_password_). */
export const ROOT_PASSWORD = 'JBDbtpwd!@#2023';

/** Result bytes of the app key answer (spec 9.8). */
export const APP_KEY_RESULT = Object.freeze({ PASSWORD_REQUIRED: 0x00, REJECTED: 0x01, NO_PASSWORD: 0x02 });

/** Longest DD frame: 7 bytes of framing plus a 255 byte data field (spec 3.5). */
export const MAX_FRAME = 262;

/** Offset of degrees C in the 0.1 K temperature encoding (spec 0, 9.7). */
export const KELVIN_OFFSET = 2731;

/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;
/** @param {ArrayLike<number>} b @param {number} i */
const u16 = (b, i) => ((b[i] << 8) | b[i + 1]) >>> 0;
/** @param {ArrayLike<number>} b @param {number} i */
const s16 = (b, i) => {
  const v = u16(b, i);
  return v & 0x8000 ? v - 0x10000 : v;
};
/** @param {number} v */
const z = (v) => (v === 0 ? 0 : v);
/** @param {ArrayLike<number>} bytes */
const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
};

// ---------------------------------------------------------------------------------------------
// Checksums and encoders
// ---------------------------------------------------------------------------------------------

/**
 * 16-bit checksum of DD frames: (0x10000 - sum of bytes from .. to - 1) AND 0xFFFF (spec 3.3).
 * Acknowledgements (status 0, length 0) therefore carry 0x0000.
 * @param {ArrayLike<number>} bytes
 * @param {number} from
 * @param {number} to exclusive
 */
export function ddChecksum(bytes, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += bytes[i];
  return (0x10000 - s) & 0xffff;
}

/**
 * 8-bit sum of FF AA frames over command, length and data (spec 3.6).
 * @param {ArrayLike<number>} bytes
 * @param {number} from
 * @param {number} to exclusive
 */
export function ffaaChecksum(bytes, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += bytes[i];
  return s & 0xff;
}

/**
 * Build a DD frame. Requests have the operation (0xA5 read, 0x5A write) in byte 1; the simulator
 * builds answers with the register in byte 1 and the status in byte 2.
 * @param {number} b1 operation (request) or register (answer)
 * @param {number} b2 register (request) or status (answer)
 * @param {ArrayLike<number>} [data]
 */
export function encodeDd(b1, b2, data = []) {
  const n = data.length;
  if (n > 255) throw new RangeError('JBD frames carry at most 255 data bytes');
  const out = new Uint8Array(7 + n);
  out[0] = START;
  out[1] = b1 & 0xff;
  out[2] = b2 & 0xff;
  out[3] = n;
  out.set(Array.from(data, (v) => v & 0xff), 4);
  const cs = ddChecksum(out, 2, 4 + n);
  out[4 + n] = cs >> 8;
  out[5 + n] = cs & 0xff;
  out[6 + n] = END;
  return out;
}

/** Read request without data (`DD A5 reg 00 cs 77`, spec 5.2). @param {number} register */
export const encodeRead = (register) => encodeDd(OP_READ, register);

/**
 * Write request.
 * @param {number} register
 * @param {ArrayLike<number>} data
 */
export const encodeWrite = (register, data) => encodeDd(OP_WRITE, register, data);

/**
 * Write a 16-bit register value (big endian, spec 6.6).
 * @param {number} register
 * @param {number} value raw u16 (negative values are written in two's complement)
 */
export function encodeWriteU16(register, value) {
  const v = value & 0xffff;
  return encodeWrite(register, [v >> 8, v & 0xff]);
}

/** Enter factory mode `DD 5A 00 02 56 78 FF 30 77` (spec 4.4). */
export const encodeEnterFactory = () => encodeWriteU16(REG.FACTORY_ENTER, FACTORY.ENTER);

/**
 * Leave factory mode: `00 00` keeps the values in RAM, `28 28` saves them to the EEPROM (spec 4.4).
 * @param {boolean} save
 */
export const encodeExitFactory = (save) => encodeWriteU16(REG.FACTORY_EXIT, save ? FACTORY.EXIT_SAVE : FACTORY.EXIT);

/**
 * MOSFET software switches 0xE1 (spec 8.1): bit 0 = 1 switches the charge MOSFET off, bit 1 = 1
 * the discharge MOSFET off, 0 releases the switch.
 * @param {{ chargeOff: boolean, dischargeOff: boolean }} cmd
 */
export const encodeMos = ({ chargeOff, dischargeOff }) => encodeWriteU16(REG.MOS, (chargeOff ? 1 : 0) | (dischargeOff ? 2 : 0));

/** Control command 0x0A with a function code (spec 8.3). @param {number} code */
export const encodeControl = (code) => encodeWriteU16(REG.CONTROL, code);

/**
 * BMS password 0x06 "use password": length byte 6 and six characters (spec 8.4). [BT] sends ASCII,
 * [V11] the digits as binary values 0..9; which one a board expects is unverified.
 * @param {string} password six characters
 * @param {'ascii'|'digits'} [encoding]
 */
export function encodeBmsPassword(password, encoding = 'ascii') {
  const text = String(password);
  if (text.length !== 6) throw new RangeError('The BMS password has six characters');
  const bytes = [...text].map((c) => (encoding === 'digits' ? Number(c) & 0xff : c.charCodeAt(0) & 0xff));
  if (encoding === 'digits' && ![...text].every((c) => /[0-9]/.test(c))) throw new RangeError('Binary password digits must be 0..9');
  return encodeWrite(REG.PASSWORD, [6, ...bytes]);
}

/**
 * FF AA frame (spec 3.6).
 * @param {number} command
 * @param {ArrayLike<number>} [data]
 */
export function encodeFfaa(command, data = []) {
  const n = data.length;
  const out = new Uint8Array(5 + n);
  out[0] = 0xff;
  out[1] = 0xaa;
  out[2] = command & 0xff;
  out[3] = n;
  out.set(Array.from(data, (v) => v & 0xff), 4);
  out[4 + n] = ffaaChecksum(out, 2, 4 + n);
  return out;
}

/** @param {string} text */
const asciiCodes = (text) => [...text].map((c) => c.charCodeAt(0) & 0xff);

/** App key `FF AA 15 06 "000000" 3B` (spec 4.2 step 1, 11.2 step 4). */
export const encodeAppKey = () => encodeFfaa(FFAA.APP_KEY, asciiCodes(APP_KEY));

/** Random byte request `FF AA 17 00 17` (spec 4.2 steps 2 and 4). */
export const encodeRandomRequest = () => encodeFfaa(FFAA.RANDOM);

/**
 * Password cipher of the module login: byte i = ((MAC[i] XOR text[i]) + random) AND 0xFF, with
 * MAC[i] = 0 beyond the six address bytes (spec 4.2, not modulo 255).
 * @param {ArrayLike<number>} mac six bytes in display order
 * @param {string} text
 * @param {number} random
 */
export function passwordCipher(mac, text, random) {
  return asciiCodes(text).map((c, i) => (((i < 6 ? mac[i] : 0) ^ c) + random) & 0xff);
}

/**
 * User password `FF AA 18 06 e0..e5 cs` (spec 4.2 step 3).
 * @param {ArrayLike<number>} mac
 * @param {string} password six characters
 * @param {number} random
 */
export const encodeUserPassword = (mac, password, random) => encodeFfaa(FFAA.PASSWORD, passwordCipher(mac, password, random));

/**
 * Root password `FF AA 1D 0F e0..e14 cs` (spec 4.2 step 5).
 * @param {ArrayLike<number>} mac
 * @param {number} random
 */
export const encodeRootPassword = (mac, random) => encodeFfaa(FFAA.ROOT, passwordCipher(mac, ROOT_PASSWORD, random));

/**
 * Parse a Bluetooth device address typed by the user ("A4:C1:37:04:2D:BE", "a4c137042dbe",
 * dashes or spaces allowed) into six bytes in display order.
 * @param {unknown} text
 * @returns {Uint8Array | null}
 */
export function parseMac(text) {
  if (typeof text !== 'string') return null;
  const clean = text.trim().replace(/[\s:-]/g, '');
  if (!/^[0-9a-fA-F]{12}$/.test(clean)) return null;
  return Uint8Array.from(clean.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/** Format six address bytes as "A4:C1:37:04:2D:BE". @param {ArrayLike<number>} mac */
export const formatMac = (mac) => hex(mac, ':');

/** Module password rule of [SY] validate_password: six letters or digits (spec 4.2). @param {unknown} v */
export const isModulePassword = (v) => typeof v === 'string' && /^[0-9A-Za-z]{6}$/.test(v);

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

/**
 * Total length of a DD frame that starts the buffer: 7 + data length (spec 3.5).
 * @param {Uint8Array} buf
 */
export const ddLength = (buf) => (buf.length < 4 ? 0 : 7 + buf[3]);

/**
 * Framing and checksum of a complete DD frame (request or answer).
 * @param {Uint8Array} f
 */
export function isValidDd(f) {
  if (f.length < 7 || f[0] !== START || f.length !== 7 + f[3] || f[f.length - 1] !== END) return false;
  const n = f[3];
  return u16(f, 4 + n) === ddChecksum(f, 2, 4 + n);
}

/** @param {Uint8Array} f */
export function isValidFfaa(f) {
  if (f.length < 5 || f[0] !== 0xff || f[1] !== 0xaa || f.length !== 5 + f[3]) return false;
  return f[4 + f[3]] === ffaaChecksum(f, 2, 4 + f[3]);
}

/** @param {Uint8Array} f */
export const isFfaaFrame = (f) => f.length >= 5 && f[0] === 0xff && f[1] === 0xaa;
/** @param {Uint8Array} f */
export const isDdFrame = (f) => f.length >= 7 && f[0] === START;
/** A request echoed by an RS485 adapter or a module: byte 1 is the operation. @param {Uint8Array} f */
export const isRequestFrame = (f) => isDdFrame(f) && (f[1] === OP_READ || f[1] === OP_WRITE);

/**
 * Frame assembler for both directions. DD frames are framed by the length byte, never by the
 * first 0x77 (spec 3.5, 12 item 2). FF AA module frames are taken only at the start of a chunk
 * while no DD frame is pending (spec 3.5: they always fit into one notification); everything else
 * goes through the DD assembler, which drops bytes before 0xDD.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void, staleMs?: number }} handlers
 */
export function createJbdAssembler({ onFrame, onDiscard, staleMs = 1500 }) {
  const dd = new FrameAssembler({ sync: [[START]], length: ddLength, validate: isValidDd, onFrame, onDiscard, maxLength: MAX_FRAME, staleMs });
  const idle = () => dd.buf.length === 0 || Date.now() - dd.lastPush > dd.staleMs;
  return {
    /** @param {Uint8Array} chunk */
    push(chunk) {
      if (chunk.length >= 5 && chunk[0] === 0xff && chunk[1] === 0xaa && idle()) {
        const n = 5 + chunk[3];
        if (chunk.length >= n && isValidFfaa(chunk.subarray(0, n))) {
          if (dd.buf.length) dd.reset();
          onFrame(chunk.slice(0, n));
          if (chunk.length > n) dd.push(chunk.subarray(n));
          return;
        }
      }
      dd.push(chunk);
    },
    reset() {
      dd.reset();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------------------------

/** 0.1 K to degrees C (spec 9.7). @param {number} raw */
export const tempFromRaw = (raw) => r((raw - KELVIN_OFFSET) / 10, 1);
/** Degrees C to 0.1 K (spec 7.6). @param {number} c */
export const tempToRaw = (c) => Math.round(c * 10) + KELVIN_OFFSET;

/**
 * Production date u16 (spec 9.5): day bits 4..0, month bits 8..5, year 2000 + bits 15..9.
 * @param {number} raw
 * @returns {string | null} ISO date, null when the month or day is invalid (raw 0 on Daren clones)
 */
export function dateFromRaw(raw) {
  const y = 2000 + (raw >> 9);
  const m = (raw >> 5) & 0x0f;
  const d = raw & 0x1f;
  if (m < 1 || m > 12 || d < 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Software version byte: high nibble major, low nibble minor (spec 9.6). @param {number} raw */
export const versionFromRaw = (raw) => `${raw >> 4}.${raw & 0x0f}`;

/**
 * Indexes of the set bits.
 * @param {number} v
 * @param {number} n
 */
const bitIndexes = (v, n) => {
  const out = [];
  for (let i = 0; i < n; i++) if (Math.floor(v / 2 ** i) % 2 === 1) out.push(i);
  return out;
};

// ---------------------------------------------------------------------------------------------
// Answers: basic information, cells, version, counters
// ---------------------------------------------------------------------------------------------

/**
 * Alarm ids of the protection bits 0..15 of 0x03 d16 (spec 9.1). Bit 13 and 14 follow [V11]
 * (MOSFET breakdown); [SY] and [AIO] call bit 13 a charge timeout (unverified, conflict).
 */
export const PROTECTION_ALARMS = Object.freeze([
  'cell_overvoltage',
  'cell_undervoltage',
  'pack_overvoltage',
  'pack_undervoltage',
  'charge_overtemperature',
  'charge_undertemperature',
  'discharge_overtemperature',
  'discharge_undertemperature',
  'charge_overcurrent',
  'discharge_overcurrent',
  'short_circuit',
  'afe_fault',
  'jbd.mos_software_lock',
  'charge_mos_fault',
  'discharge_mos_fault',
  'jbd.protection_bit15',
]);

/**
 * Alarm ids of the V11 alarm bits in the 0x03 tail (spec 9.2, unverified: zero in every capture).
 * Index = bit.
 */
export const TAIL_ALARMS = Object.freeze([
  'cell_overvoltage',
  'cell_undervoltage',
  'pack_overvoltage',
  'pack_undervoltage',
  'charge_overtemperature',
  'charge_undertemperature',
  'discharge_overtemperature',
  'discharge_undertemperature',
  'charge_overcurrent',
  'discharge_overcurrent',
  'cell_voltage_difference',
  'soc_low',
]);

/** Minimum data length of a 0x03 answer without NTC words (spec 6.1). */
export const BASIC_MIN_LENGTH = 23;
/** Length of the V11 extension tail (spec 6.2). */
export const TAIL_LENGTH = 9;
/** Plausible NTC range of the detection rule, degrees C (spec 11.2 step 3). */
export const TEMP_MIN = -50;
export const TEMP_MAX = 150;

/**
 * Bytes after the NTC words that form a V11 tail (spec 6.2): at least 9 bytes whose word at +5
 * repeats the remaining capacity d4, as in every capture. Daren clones put other fields there
 * ([AIO] daren_bms.py), so their tail is never decoded.
 * @param {Uint8Array} d data bytes
 * @param {string} [variant]
 * @returns {Uint8Array | null}
 */
function v11Tail(d, variant) {
  const start = BASIC_MIN_LENGTH + 2 * d[22];
  if (variant === VARIANT.DAREN || d.length < start + TAIL_LENGTH) return null;
  const ext = d.subarray(start);
  return u16(ext, 5) === u16(d, 4) ? ext : null;
}

/**
 * Decode the data of a 0x03 answer (spec 6.1, 6.2). The 100 mA / 100 mAh unit applies when bit 7
 * of the FET byte is set ([V11]), when a V11 tail is present with bit 7 of its first byte set
 * ([AIO], Fogstar capture), or when the caller knows that bit 12 of register 0x2D is set ([V11]
 * "current capacity unit"); all three are unverified (spec 6.2, 7.6). Bytes after the NTC words
 * that do not form a V11 tail (spec 6.2, consistency rule) are returned as `extraBytes`.
 * @param {Uint8Array} d data bytes
 * @param {{ variant?: string, unit100?: boolean }} [opts] variant of the driver, unit bit of 0x2D
 */
export function parseBasic(d, { variant, unit100: unitSetting = false } = {}) {
  /** @type {Record<string, any>} */
  const out = {};
  const fet = d[20];
  const cells = d[21];
  const ntc = d[22];
  const tail = BASIC_MIN_LENGTH + 2 * ntc;
  const ext = v11Tail(d, variant);
  const unit100 = unitSetting || (fet & 0x80) !== 0 || (!!ext && (ext[0] & 0x80) !== 0);
  const cs = unit100 ? 0.1 : 0.01;
  out.totalVoltage = r(u16(d, 0) * 0.01, 2);
  out.currentRaw = s16(d, 2);
  out.current = z(r(s16(d, 2) * cs, 2));
  out.remainingCapacity = r(u16(d, 4) * cs, 2);
  out.nominalCapacity = r(u16(d, 6) * cs, 2);
  out.cycleCount = u16(d, 8);
  out.productionDateRaw = u16(d, 10);
  out.productionDate = dateFromRaw(out.productionDateRaw);
  const balance = u16(d, 14) * 0x10000 + u16(d, 12);
  out.balanceBits = balance;
  out.balancingCells = bitIndexes(balance, Math.min(cells, 32));
  const prot = u16(d, 16);
  out.protectionBits = prot;
  out.alarms = bitIndexes(prot, 16).map((i) => PROTECTION_ALARMS[i]);
  out.softwareVersionRaw = d[18];
  out.softwareVersion = versionFromRaw(d[18]);
  out.soc = d[19];
  out.fetStatus = fet;
  out.chargeMos = (fet & 0x01) !== 0;
  out.dischargeMos = (fet & 0x02) !== 0;
  // Heating per [V11] bit 3; unreliable (spec 9.3), shown only as a raw FET byte by the driver.
  out.heating = (fet & 0x08) !== 0;
  out.cellCount = cells;
  out.ntcCount = ntc;
  out.temperatures = [];
  for (let i = 0; i < ntc && BASIC_MIN_LENGTH + 2 * i + 1 < d.length; i++) out.temperatures.push(tempFromRaw(u16(d, BASIC_MIN_LENGTH + 2 * i)));
  out.unit100mA = unit100;
  if (ext) {
    out.extension = {
      byte0: ext[0],
      alarmBits: u16(ext, 1),
      fullChargeCapacity: r(u16(ext, 3) * cs, 2),
      remainingCapacity: r(u16(ext, 5) * cs, 2),
      balanceCurrentRaw: u16(ext, 7),
    };
    if (ext.length > TAIL_LENGTH) out.extension.extraBytes = hex(ext.subarray(TAIL_LENGTH));
  } else if (d.length > tail) {
    out.extraBytes = hex(d.subarray(tail));
  }
  return out;
}

/**
 * Plausibility of a 0x03 answer (spec 11.2 step 3). Returns a reason in English for the log, or
 * null. The driver passes `strict: false` for detection and polling alike and checks the structure
 * only (length, cell count, NTC count, SOC), so one open or shorted NTC does not stop the
 * connection or the monitoring (the snapshot reports it as a sensor fault instead). `strict` adds
 * the temperature range of every NTC.
 * @param {Uint8Array} d data bytes
 * @param {{ strict?: boolean }} [opts]
 */
export function basicProblem(d, { strict = true } = {}) {
  if (d.length < BASIC_MIN_LENGTH) return `data length ${d.length} below ${BASIC_MIN_LENGTH}`;
  const cells = d[21];
  const ntc = d[22];
  if (cells < 1 || cells > 32) return `cell count ${cells}`;
  if (ntc > 16) return `NTC count ${ntc}`;
  if (BASIC_MIN_LENGTH + 2 * ntc > d.length) return `NTC count ${ntc} does not fit ${d.length} data bytes`;
  if (d[19] > 100) return `SOC ${d[19]} %`;
  if (!strict) return null;
  for (let i = 0; i < ntc; i++) {
    const t = tempFromRaw(u16(d, BASIC_MIN_LENGTH + 2 * i));
    if (t < TEMP_MIN || t > TEMP_MAX) return `temperature ${t} °C`;
  }
  return null;
}

/**
 * Cell voltages of a 0x04 answer (spec 6.3): u16 mV per cell, cell 1 first. A 0 mV slot is a
 * real reading.
 * @param {Uint8Array} d
 */
export function parseCells(d) {
  const cellVoltages = [];
  for (let i = 0; i + 1 < d.length; i += 2) cellVoltages.push(r(u16(d, i) * 0.001, 3));
  return { cellCount: d.length >> 1, cellVoltages };
}

/** Hardware version string of 0x05, cut at the first NUL (spec 6.4). @param {Uint8Array} d */
export function parseHardwareVersion(d) {
  const zero = d.indexOf(0);
  return latin1(zero >= 0 ? d.subarray(0, zero) : d).trim();
}

/** Keys of the protection counters 0xAA in data order (spec 6.5). */
export const ERROR_COUNT_KEYS = Object.freeze([
  'shortCircuit',
  'chargeOvercurrent',
  'dischargeOvercurrent',
  'cellOvervoltage',
  'cellUndervoltage',
  'chargeOvertemperature',
  'chargeUndertemperature',
  'dischargeOvertemperature',
  'dischargeUndertemperature',
  'packOvervoltage',
  'packUndervoltage',
]);

/**
 * Protection counters 0xAA (spec 6.5): eleven u16 counters, plus the restart count when the data
 * length is 24. The restart count (d22) has [V11] as its only source; [SY] ignores the word
 * (unverified).
 * @param {Uint8Array} d
 */
export function parseErrorCounts(d) {
  /** @type {Record<string, number>} */
  const errorCounts = {};
  ERROR_COUNT_KEYS.forEach((k, i) => {
    if (2 * i + 1 < d.length) errorCounts[k] = u16(d, 2 * i);
  });
  /** @type {{ errorCounts: Record<string, number>, restartCount?: number }} */
  const out = { errorCounts };
  if (d.length >= 24) out.restartCount = u16(d, 22);
  return out;
}

// ---------------------------------------------------------------------------------------------
// EEPROM registers (spec 7.2)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {'u16'|'s16neg'|'temp'|'date'|'shunt'|'bits'|'ntc'|'pair'|'afe38'|'afe39'|'string'} RegisterKind
 * @typedef {{ id: string, kind: RegisterKind, scale?: number, unit?: string, decimals?: number, names?: string[], unitScaled?: boolean }} RegisterDef
 */

/**
 * Register map of the classic EEPROM parameters (spec 7.2). `id` is the ubms field id of a single
 * value register, or the register key of a byte pair or bit field register. `unitScaled` registers
 * use ten times the unit when bit 12 of 0x2D is set (spec 7.6, unverified).
 * @type {Readonly<Record<number, RegisterDef>>}
 */
export const REGISTERS = Object.freeze({
  0x10: { id: 'capacity.nominal', kind: 'u16', scale: 0.01, unit: 'Ah', decimals: 2, unitScaled: true },
  0x11: { id: 'capacity.cycle', kind: 'u16', scale: 0.01, unit: 'Ah', decimals: 2, unitScaled: true },
  0x12: { id: 'charge.soc100_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x13: { id: 'charge.soc0_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x14: { id: 'jbd.self_discharge_rate', kind: 'u16', scale: 0.1, unit: '%', decimals: 1 },
  0x15: { id: 'jbd.production_date', kind: 'date' },
  0x16: { id: 'jbd.serial_number', kind: 'u16', scale: 1, decimals: 0 },
  0x17: { id: 'jbd.cycle_count', kind: 'u16', scale: 1, decimals: 0 },
  0x18: { id: 'charge.otp', kind: 'temp' },
  0x19: { id: 'charge.otpr', kind: 'temp' },
  0x1a: { id: 'charge.utp', kind: 'temp' },
  0x1b: { id: 'charge.utpr', kind: 'temp' },
  0x1c: { id: 'discharge.otp', kind: 'temp' },
  0x1d: { id: 'discharge.otpr', kind: 'temp' },
  0x1e: { id: 'discharge.utp', kind: 'temp' },
  0x1f: { id: 'discharge.utpr', kind: 'temp' },
  0x20: { id: 'pack.ovp', kind: 'u16', scale: 0.01, unit: 'V', decimals: 2 },
  0x21: { id: 'pack.ovpr', kind: 'u16', scale: 0.01, unit: 'V', decimals: 2 },
  0x22: { id: 'pack.uvp', kind: 'u16', scale: 0.01, unit: 'V', decimals: 2 },
  0x23: { id: 'pack.uvpr', kind: 'u16', scale: 0.01, unit: 'V', decimals: 2 },
  0x24: { id: 'cell.ovp', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x25: { id: 'cell.ovpr', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x26: { id: 'cell.uvp', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x27: { id: 'cell.uvpr', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x28: { id: 'charge.ocp', kind: 'u16', scale: 0.01, unit: 'A', decimals: 2, unitScaled: true },
  0x29: { id: 'discharge.ocp', kind: 's16neg', scale: 0.01, unit: 'A', decimals: 2, unitScaled: true },
  0x2a: { id: 'balance.start_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x2b: { id: 'balance.trigger_delta', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x2c: { id: 'jbd.shunt_resistance', kind: 'shunt' },
  0x2d: {
    id: 'jbd.function_config',
    kind: 'bits',
    names: ['switchInput', 'loadDetect', 'balanceEnable', 'balanceChargeOnly', 'ledEnable', 'ledCapacity', 'bit6', 'bit7', 'bit8', 'bit9', 'bit10', 'bit11', 'unit100mA'],
  },
  0x2e: { id: 'jbd.ntc_config', kind: 'ntc' },
  0x2f: { id: 'system.cell_count', kind: 'u16', scale: 1, decimals: 0 },
  0x30: { id: 'jbd.switch_time', kind: 'u16', scale: 1, unit: 's', decimals: 0 },
  0x31: { id: 'jbd.led_time', kind: 'u16', scale: 1, unit: 's', decimals: 0 },
  0x32: { id: 'jbd.soc80_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x33: { id: 'jbd.soc60_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x34: { id: 'jbd.soc40_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x35: { id: 'jbd.soc20_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x36: { id: 'jbd.cell_ovp_hw', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x37: { id: 'jbd.cell_uvp_hw', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x38: { id: 'jbd.afe_sc_ocd2', kind: 'afe38' },
  0x39: { id: 'jbd.afe_hw_delays', kind: 'afe39' },
  // 0x3A..0x3D: [RM] calls them "release delay", while [V11] (parameters 44..51) and the [RM]
  // field names (chgut_delay ...) describe protection delays; byte order and meaning unverified,
  // so the fields are read only (spec 7.2).
  0x3a: { id: 'jbd.charge_temp_delays', kind: 'pair', names: ['jbd.charge_utp_delay', 'jbd.charge_otp_delay'] },
  0x3b: { id: 'jbd.discharge_temp_delays', kind: 'pair', names: ['jbd.discharge_utp_delay', 'jbd.discharge_otp_delay'] },
  0x3c: { id: 'jbd.pack_voltage_delays', kind: 'pair', names: ['jbd.pack_uvp_delay', 'jbd.pack_ovp_delay'] },
  0x3d: { id: 'jbd.cell_voltage_delays', kind: 'pair', names: ['cell.uvp_delay', 'cell.ovp_delay'] },
  0x3e: { id: 'jbd.charge_oc_delays', kind: 'pair', names: ['charge.ocp_delay', 'charge.ocp_recovery'] },
  0x3f: { id: 'jbd.discharge_oc_delays', kind: 'pair', names: ['discharge.ocp_delay', 'discharge.ocp_recovery'] },
  0x42: { id: 'jbd.soc90_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x43: { id: 'jbd.soc70_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x44: { id: 'jbd.soc50_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x45: { id: 'jbd.soc30_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x46: { id: 'jbd.soc10_voltage', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0x47: { id: 'jbd.soc100_voltage_table', kind: 'u16', scale: 0.001, unit: 'V', decimals: 3 },
  0xa0: { id: 'jbd.manufacturer', kind: 'string' },
  0xa1: { id: 'jbd.model', kind: 'string' },
  0xa2: { id: 'jbd.barcode', kind: 'string' },
});

/** Bit 12 of the function configuration 0x2D: 100 mA / 100 mAh units (spec 7.3, 7.6). */
export const FUNC_UNIT_BIT = 12;

/** AFE tables of the TI family (spec 7.5, [RM], [BT]; RSNS tables from [TI], unverified). */
export const AFE = Object.freeze({
  SC_DELAY_US: [70, 100, 200, 400],
  SC_MV: [22, 33, 44, 56, 67, 78, 89, 100],
  SC_MV_RSNS: [44, 67, 89, 111, 133, 155, 178, 200],
  OCD2_MS: [8, 20, 40, 80, 160, 320, 640, 1280],
  OCD2_MV: [8, 11, 14, 17, 19, 22, 25, 28, 31, 33, 36, 39, 42, 44, 47, 50],
  OCD2_MV_RSNS: [17, 22, 28, 33, 39, 44, 50, 56, 61, 67, 72, 78, 83, 89, 94, 100],
  UV_HW_DELAY_S: [1, 4, 8, 16],
  OV_HW_DELAY_S: [1, 2, 4, 8],
});

/**
 * Value of a raw u16 in engineering units for a scaled register.
 * @param {RegisterDef} def
 * @param {number} raw u16
 * @param {{ unit100?: boolean }} [opts]
 */
export function scaledValue(def, raw, { unit100 = false } = {}) {
  const k = def.unitScaled && unit100 ? 10 : 1;
  const scale = /** @type {number} */ (def.scale) * k;
  const decimals = Math.max(0, /** @type {number} */ (def.decimals) - (k === 10 ? 1 : 0));
  if (def.kind === 's16neg') {
    const s = raw & 0x8000 ? raw - 0x10000 : raw;
    return r(Math.abs(s) * scale, decimals);
  }
  return r(raw * scale, decimals);
}

/**
 * Shunt resistance 0x2C in milliohm: 0.1 mOhm per step, 0.01 mOhm when bit 15 is set ([V11]) or
 * the unit bit 12 of 0x2D is set ([V11], [RM]); both unverified by a capture (spec 7.2, 7.6).
 * @param {number} raw
 * @param {{ unit100?: boolean }} [opts]
 */
export function shuntFromRaw(raw, { unit100 = false } = {}) {
  if (raw & 0x8000) return r((raw & 0x7fff) * 0.01, 2);
  return unit100 ? r(raw * 0.01, 2) : r(raw * 0.1, 1);
}

/**
 * Decode the data of a register read (or of a register write) per the register map (spec 7.2,
 * 6.6). Keys match the vectors: `setting`, `raw`, `rawSigned`, `value`, `unit`, `bits`,
 * `enabledSensors`, `values`, `ti`, `scpRecoveryS`, `text`, `textLength`.
 * @param {number} register
 * @param {Uint8Array} data
 * @param {{ unit100?: boolean }} [opts]
 */
export function decodeRegister(register, data, opts = {}) {
  const def = REGISTERS[register];
  if (!def) return { raw: hex(data) };
  /** @type {Record<string, any>} */
  const out = { setting: def.id };
  if (def.kind === 'string') {
    const n = data[0] ?? 0;
    out.textLength = n;
    out.text = latin1(data.subarray(1, 1 + n));
    return out;
  }
  if (data.length !== 2) {
    out.raw = hex(data);
    return out;
  }
  const raw = u16(data, 0);
  out.raw = raw;
  switch (def.kind) {
    case 'u16':
      out.value = scaledValue(def, raw, opts);
      if (def.unit) out.unit = def.unit;
      break;
    case 's16neg':
      out.rawSigned = s16(data, 0);
      out.value = scaledValue(def, raw, opts);
      out.unit = def.unit;
      break;
    case 'temp':
      out.value = tempFromRaw(raw);
      out.unit = '°C';
      break;
    case 'date':
      out.value = dateFromRaw(raw);
      break;
    case 'shunt':
      out.value = shuntFromRaw(raw, opts);
      out.unit = 'mΩ';
      break;
    case 'bits': {
      /** @type {Record<string, boolean>} */
      const bits = {};
      (def.names ?? []).forEach((n, i) => {
        bits[n] = ((raw >> i) & 1) === 1;
      });
      out.bits = bits;
      break;
    }
    case 'ntc':
      out.enabledSensors = bitIndexes(raw, 16);
      break;
    case 'pair': {
      const [a, b] = def.names ?? [];
      out.values = { [a]: data[0], [b]: data[1] };
      out.unit = 's';
      break;
    }
    case 'afe38': {
      const b0 = data[0];
      const b1 = data[1];
      const rsns = (b0 & 0x80) !== 0;
      out.ti = {
        rsns,
        scdDelayUs: AFE.SC_DELAY_US[(b0 >> 3) & 3],
        scdThresholdCode: b0 & 7,
        scdThresholdMv: (rsns ? AFE.SC_MV_RSNS : AFE.SC_MV)[b0 & 7],
        ocdDelayMs: AFE.OCD2_MS[(b1 >> 4) & 7],
        ocdThresholdCode: b1 & 0x0f,
        ocdThresholdMv: (rsns ? AFE.OCD2_MV_RSNS : AFE.OCD2_MV)[b1 & 0x0f],
      };
      break;
    }
    case 'afe39':
      out.ti = { uvDelayS: AFE.UV_HW_DELAY_S[(data[0] >> 6) & 3], ovDelayS: AFE.OV_HW_DELAY_S[(data[0] >> 4) & 3] };
      out.scpRecoveryS = data[1];
      break;
    default:
      break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Frame parsers
// ---------------------------------------------------------------------------------------------

/**
 * Parse a DD answer (`DD reg status len data cs 77`, spec 3.2). Error answers and
 * acknowledgements carry no data.
 * @param {Uint8Array} f
 * @param {{ unit100?: boolean }} [opts] unit bit of 0x2D for register reads
 */
export function parseAnswer(f, opts = {}) {
  const register = f[1];
  const status = f[2];
  const n = f[3];
  const data = f.subarray(4, 4 + n);
  /** @type {Record<string, any>} */
  const out = { register, status, dataLength: n, checksumValid: isValidDd(f) };
  if (status !== STATUS.OK || n === 0) return out;
  if (register === REG.BASIC) Object.assign(out, parseBasic(data));
  else if (register === REG.CELLS) Object.assign(out, parseCells(data));
  else if (register === REG.VERSION) out.hardwareVersion = parseHardwareVersion(data);
  else if (register === REG.ERROR_COUNTS) Object.assign(out, parseErrorCounts(data));
  else if (register === REG.FA) {
    const words = [];
    for (let i = 3; i + 1 < n; i += 2) words.push(u16(data, i));
    out.fa = { paramStart: u16(data, 0), paramCount: data[2], words };
  } else Object.assign(out, decodeRegister(register, data, opts));
  return out;
}

/** @param {number} n @returns {string} n asterisks standing for a password of n characters */
const mask = (n) => '*'.repeat(n);

/**
 * Meaning of the data of a write request (spec 5.1, 8).
 * @param {number} register
 * @param {Uint8Array} data
 */
function describeWriteData(register, data) {
  const v = data.length === 2 ? u16(data, 0) : null;
  if (register === REG.FACTORY_ENTER && v === FACTORY.ENTER) return { factory: 'enter' };
  if (register === REG.FACTORY_EXIT && v === FACTORY.EXIT) return { factory: 'exit' };
  if (register === REG.FACTORY_EXIT && v === FACTORY.EXIT_SAVE) return { factory: 'exitSave' };
  if (register === REG.MOS && v !== null) return { mos: { chargeOff: (v & 1) !== 0, dischargeOff: (v & 2) !== 0 } };
  if (register === REG.FB && data.length === 2) return { mosV11: { type: data[0], off: data[1] } };
  if (register === REG.CONTROL && v !== null) return { control: CONTROL_NAMES[/** @type {keyof typeof CONTROL_NAMES} */ (v)] ?? `0x${v.toString(16)}` };
  // Passwords are masked for the log: only their length is shown (as ant/protocol.js does).
  if (register === REG.PASSWORD && data.length >= 1) return { password: { length: data[0], text: mask(data.length - 1) } };
  if (register === REG.PASSWORD_CHANGE && data.length >= 13) return { passwordChange: { length: data[0], old: mask(6), new: mask(6) } };
  if (register === REG.PASSWORD_CLEAR && data.length >= 1) return { clearPassword: mask(data.subarray(1, 1 + data[0]).length) };
  if (register === REG.FA && data.length >= 3) return { fa: { paramStart: u16(data, 0), paramCount: data[2] } };
  if (REGISTERS[register]) return decodeRegister(register, data);
  return {};
}

/**
 * Parse a DD request (`DD A5|5A reg len data cs 77`, spec 3.1), as the simulator and the log see
 * it. Keys match the `tx` vectors.
 * @param {Uint8Array} f
 */
export function parseRequest(f) {
  const op = f[1];
  const register = f[2];
  const n = f[3];
  const data = f.subarray(4, 4 + n);
  /** @type {Record<string, any>} */
  const out = {
    operation: op === OP_READ ? 'read' : op === OP_WRITE ? 'write' : h2(op),
    register,
    dataLength: n,
    data: hex(data),
    checksum: f.length >= 6 + n ? u16(f, 4 + n) : undefined,
    checksumValid: isValidDd(f),
  };
  if (op === OP_WRITE) Object.assign(out, describeWriteData(register, data));
  if (op === OP_READ && register === REG.FA && n === 3) out.fa = { paramStart: u16(data, 0), paramCount: data[2] };
  return out;
}

/**
 * Parse a FF AA module frame (spec 3.6, 6.9). One byte answers carry `result`.
 * @param {Uint8Array} f
 */
export function parseFfaa(f) {
  const n = f[3];
  /** @type {Record<string, any>} */
  const out = { command: f[2], dataLength: n, data: hex(f.subarray(4, 4 + n)), checksum: f[4 + n], checksumValid: isValidFfaa(f) };
  if (n === 1) out.result = f[4];
  return out;
}

// ---------------------------------------------------------------------------------------------
// Log descriptions
// ---------------------------------------------------------------------------------------------

/** @type {Record<number, string>} */
const REGISTER_NAMES = {
  [REG.FACTORY_ENTER]: 'Factory mode',
  [REG.FACTORY_EXIT]: 'Exit factory mode',
  [REG.BASIC]: 'Basic information',
  [REG.CELLS]: 'Cell voltages',
  [REG.VERSION]: 'Hardware version',
  [REG.PASSWORD]: 'BMS password',
  [REG.PASSWORD_CHANGE]: 'Change BMS password',
  [REG.PASSWORD_CLEAR]: 'Clear BMS password',
  [REG.CONTROL]: 'Control command',
  [REG.ERROR_COUNTS]: 'Protection counters',
  [REG.MOS]: 'MOSFET control',
  [REG.FA]: 'Parameter block',
  [REG.FB]: 'MOSFET control (V11)',
  0xe0: 'Remaining capacity',
  0xe2: 'Balancer test',
  0xe3: 'Reset',
  0xf6: 'Internal resistance',
  0xfc: 'Heater',
};

/** @type {Record<number, string>} */
const FFAA_NAMES = {
  [FFAA.RENAME]: 'Module name',
  [FFAA.APP_KEY]: 'Module app key',
  [FFAA.CHANGE_PASSWORD]: 'Module password change',
  [FFAA.RANDOM]: 'Module random byte',
  [FFAA.PASSWORD]: 'Module password',
  [FFAA.ROOT]: 'Module root password',
};

/** @param {number} register */
function registerName(register) {
  const known = REGISTER_NAMES[register];
  if (known) return `${known} (${h2(register)})`;
  const def = REGISTERS[register];
  return def ? `Register ${h2(register)} ${def.id}` : `Register ${h2(register)}`;
}

/**
 * Name and lazy decoder of a frame for the protocol log.
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describe(frame) {
  if (!frame || frame.length < 5) return null;
  if (isFfaaFrame(frame)) {
    const name = FFAA_NAMES[frame[2]] ?? `Module command ${h2(frame[2])}`;
    return { name: frame[3] === 1 ? `${name} answer` : name, decode: () => parseFfaa(frame) };
  }
  if (!isDdFrame(frame)) return null;
  if (isRequestFrame(frame)) {
    const op = frame[1] === OP_READ ? 'read' : 'write';
    let name = `${registerName(frame[2])} ${op}`;
    if (frame[1] === OP_WRITE && frame[2] === REG.FACTORY_ENTER) name = 'Enter factory mode (0x00)';
    if (frame[1] === OP_WRITE && frame[2] === REG.FACTORY_EXIT) name = frame[4] === 0x28 ? 'Exit factory mode and save (0x01)' : 'Exit factory mode (0x01)';
    return { name, decode: () => parseRequest(frame) };
  }
  const status = frame[2];
  const base = registerName(frame[1]);
  const name = status === STATUS.OK ? (frame[3] === 0 ? `${base} acknowledged` : base) : `${base} refused, status ${h2(status)}`;
  return { name, decode: () => parseAnswer(frame) };
}

