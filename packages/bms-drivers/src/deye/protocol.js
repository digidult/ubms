import { FrameAssembler, concat, crc16Modbus, hex, u16be } from '@ubms/transport';
import { aes128CbcDecrypt, aes128CbcEncrypt, latin1, sha256Hex } from '../common/crypto.js';

/**
 * Deye "AA 55" protocol of the low voltage ESS batteries (LVESS BMS), on the RS485 pins of the
 * PCS port and inside the encrypted Bluetooth session (docs/protocols/deye.md, "spec" below,
 * sections 3.1, 3.2, 5.1, 6.1). Pure functions: frame codec, assemblers, parsers, the Bluetooth
 * handshake and its AES layer, log descriptions.
 *
 * Frame: AA 55, address, command, length n, n data bytes (big-endian fields), CRC-16/MODBUS over
 * command, length and data sent low byte first, 0D 0A. Header and address are not covered by the
 * CRC (spec 3.1).
 */

export const HEADER = Object.freeze([0xaa, 0x55]);
export const TRAILER = Object.freeze([0x0d, 0x0a]);
/** Address of every captured pack (spec 2.1); another address in a bank is unverified. */
export const DEFAULT_ADDRESS = 0x01;

/** Read commands (spec 5.1). */
export const CMD = Object.freeze({ MAIN: 0x01, ALARMS: 0x02, TEMPERATURES: 0x03, CELLS: 0x04, EXTENDED: 0x05 });

/**
 * The only commands ubms ever sends (spec 5.1, 11.2). 0x05 is harmless in the captures but
 * unexplained; other codes include write, shutdown, erase and firmware commands of the vendor tool.
 */
export const READ_COMMANDS = Object.freeze([CMD.MAIN, CMD.ALARMS, CMD.TEMPERATURES, CMD.CELLS]);

/**
 * Data lengths of the answers as captured (spec 6.1): 61 or 65 (SE-F16-C app configuration) for
 * 0x01, 12, 21, 72 and 64 for the others. `isAnswer()` also accepts the shorter 0x03 and 0x04
 * forms of the app configuration (13 and 40 bytes, [SX]).
 */
export const ANSWER_LENGTHS = Object.freeze({ 1: [61, 65], 2: [12], 3: [21], 4: [72], 5: [64] });
/** Fewest data bytes of a 0x03 answer: the fields up to the last temperature slot (spec 6.1.3). */
export const MIN_TEMPERATURES_LENGTH = 13;
/** Fewest data bytes of a 0x04 answer: header and 16 cell slots (spec 6.1.4, [SX] app config). */
export const MIN_CELLS_LENGTH = 40;

export const COMMAND_NAMES = Object.freeze({ 1: 'Main information', 2: 'Alarm block', 3: 'Temperatures', 4: 'Cell voltages', 5: 'Extended block' });

/** Number of cell slots in the 0x04 answer (spec 6.1.4). */
export const CELL_SLOTS = 32;
/** Number of temperature slots in the 0x03 answer (spec 6.1.3). */
export const TEMP_SLOTS = 8;

/** Battery (cell) type codes (spec 9.6); 27 and 28 are not in any list. */
export const BATTERY_TYPES = Object.freeze({
  0: 'undefined',
  1: 'GOTION 96 Ah',
  2: 'CATL 100 Ah',
  3: 'EVE 100 Ah',
  4: 'PH 100 Ah',
  5: 'EVE 120 Ah',
  6: 'PH 100 Ah (214R)',
  7: 'ZENERGY 104 Ah',
});

/**
 * Nominal capacity (Ah) implied by a battery type code: the code names the cell, and every Deye
 * low voltage pack is 16 cells in series, one in parallel (spec 1.1, 9.6). Inferred, not
 * transmitted; codes outside the list give nothing.
 */
export const TYPE_CAPACITY = Object.freeze({ 1: 96, 2: 100, 3: 100, 4: 100, 5: 120, 6: 100, 7: 104 });

/**
 * Text of a battery type code: the cell name of the vendor tool list, or the raw code.
 * @param {number} code
 */
export function batteryTypeText(code) {
  const name = BATTERY_TYPES[/** @type {keyof typeof BATTERY_TYPES} */ (code)];
  return name ? `${code} (${name})` : String(code);
}

/**
 * Builds an AA 55 frame (also used by the simulators for answers).
 * @param {number} address
 * @param {number} command
 * @param {ArrayLike<number>} [data]
 */
export function encodeFrame(address, command, data = []) {
  const n = data.length;
  if (n > 255) throw new Error('AA 55 data longer than 255 bytes');
  const out = new Uint8Array(n + 9);
  out[0] = 0xaa;
  out[1] = 0x55;
  out[2] = address & 0xff;
  out[3] = command & 0xff;
  out[4] = n;
  out.set(Uint8Array.from(data), 5);
  const crc = crc16Modbus(out, 3, 5 + n);
  out[5 + n] = crc & 0xff;
  out[6 + n] = crc >> 8;
  out[7 + n] = 0x0d;
  out[8 + n] = 0x0a;
  return out;
}

/**
 * Read request. Refuses every command except 0x01..0x04 (spec 5.1).
 * @param {number} command
 * @param {number} [address]
 */
export function encodeRequest(command, address = DEFAULT_ADDRESS) {
  if (!READ_COMMANDS.includes(command)) throw new Error(`Deye AA 55 command 0x${command.toString(16)} is not a known read and is never sent`);
  return encodeFrame(address, command);
}

/**
 * Total length of a buffer that starts with AA 55: 0 when more bytes are needed.
 * @param {Uint8Array} buf
 */
export function frameLength(buf) {
  if (buf.length < 5) return 0;
  return buf[4] + 9;
}

/**
 * Header, CRC and CR LF of a complete frame.
 * @param {Uint8Array} f
 */
export function isValidFrame(f) {
  if (f.length < 9 || f[0] !== 0xaa || f[1] !== 0x55) return false;
  const n = f[4];
  if (f.length !== n + 9) return false;
  if (f[7 + n] !== 0x0d || f[8 + n] !== 0x0a) return false;
  const crc = crc16Modbus(f, 3, 5 + n);
  return f[5 + n] === (crc & 0xff) && f[6 + n] === crc >> 8;
}

/**
 * @typedef {Object} Aa55Frame
 * @property {number} address
 * @property {number} command
 * @property {number} length number of data bytes
 * @property {Uint8Array} data
 * @property {number} crc as transmitted, low byte first, read as a number
 * @property {boolean} crcValid
 */

/**
 * Splits a frame (no plausibility checks beyond the length).
 * @param {Uint8Array} f
 * @returns {Aa55Frame | null}
 */
export function parseFrame(f) {
  if (f.length < 9 || f[0] !== 0xaa || f[1] !== 0x55 || f.length !== f[4] + 9) return null;
  const n = f[4];
  return { address: f[2], command: f[3], length: n, data: f.slice(5, 5 + n), crc: f[5 + n] | (f[6 + n] << 8), crcValid: isValidFrame(f) };
}

/**
 * An answer: data present and of a plausible length for its command (requests carry n = 0).
 * 0x01, 0x02 and 0x05 must have a captured length. 0x03 and 0x04 were captured with 21 and 72
 * bytes (RS485, and 0x04 over Bluetooth), but the SE-F16-C app configuration defines 13 and 40
 * ([SX]) and no Bluetooth 0x03 answer was captured (spec 6.1.3), so any length from those minimums
 * on is accepted (0x04: header plus whole cell slots).
 * @param {Uint8Array} f
 */
export function isAnswer(f) {
  if (f.length < 9) return false;
  const n = f[4];
  switch (f[3]) {
    case CMD.TEMPERATURES:
      return n >= MIN_TEMPERATURES_LENGTH;
    case CMD.CELLS:
      return n >= MIN_CELLS_LENGTH && (n - 8) % 2 === 0;
    default: {
      const lengths = ANSWER_LENGTHS[/** @type {keyof typeof ANSWER_LENGTHS} */ (f[3])];
      return n > 0 && !!lengths && lengths.includes(n);
    }
  }
}

/**
 * Frame assembler for a byte stream (RS485). Frames are found by header, length, CRC and CR LF,
 * never by searching for CR LF (cell voltages such as 0x0D0A occur in the data, spec 3.1). A bad
 * frame drops one byte, so a frame starting inside a broken one is still found.
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void }} handlers
 */
export function createAa55Assembler({ onFrame, onDiscard }) {
  return new FrameAssembler({ sync: [HEADER], length: frameLength, validate: isValidFrame, onFrame, onDiscard, maxLength: 264, staleMs: 1000 });
}

/** @param {number} raw */
const temp40 = (raw) => raw - 40;
/** @param {number} v @param {number} [d] */
const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Text of a fixed field: up to the first NUL, trailing spaces removed.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} len
 */
function fieldText(b, o, len) {
  let s = '';
  for (let i = o; i < o + len && i < b.length; i++) {
    if (b[i] === 0) break;
    s += String.fromCharCode(b[i]);
  }
  return s.replace(/\s+$/, '');
}

/**
 * Field made of printable ASCII, padded with NUL or spaces only.
 * @param {Uint8Array} b
 * @param {number} o
 * @param {number} len
 */
export function isPrintableField(b, o, len) {
  let ended = false;
  for (let i = o; i < o + len; i++) {
    const c = b[i];
    if (c === 0) {
      ended = true;
      continue;
    }
    if (ended && c !== 0x20) return false;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Raw value at or above which the 0x01 current uses the offset 30000 (spec 6.1.1). */
export const CURRENT_OFFSET_SWITCH = 15000;

/**
 * Pack current of the 0x01 answer (spec 6.1.1): offset 3000 below raw 15000 (proven on LVESS02),
 * 30000 from 15000 on (presumed for LVESS15, **unverified**). Positive while charging. Values
 * outside ±1000 A are rejected (undefined).
 * @param {number} raw
 */
export function decodeCurrent(raw) {
  const offset = raw < CURRENT_OFFSET_SWITCH ? 3000 : 30000;
  const current = round((raw - offset) * 0.1, 1);
  return { offset, current: Math.abs(current) <= 1000 ? current : undefined };
}

/**
 * @typedef {Object} MainInfo 0x01 answer (spec 6.1.1)
 * @property {number} heatingCurrent A
 * @property {number} socAh % (second SOC value, offset 2; which label it has is unverified)
 * @property {number} soh %
 * @property {number} mosTemp °C
 * @property {number} boardTemp °C (-40: no sensor)
 * @property {number} heaterTemp °C (-40: no sensor; offset unverified)
 * @property {number} cycles
 * @property {number} statusByte
 * @property {number} chargeCurrentLimit A
 * @property {number} dischargeCurrentLimit A
 * @property {number} heatRequest
 * @property {number} chargeRequest
 * @property {number} subState
 * @property {number} voltage V (system)
 * @property {number} currentRaw
 * @property {number | undefined} current A (system), positive while charging
 * @property {number} currentOffset 3000 or 30000
 * @property {number} soc %
 * @property {number} mosState
 * @property {number} batteryType
 * @property {number} life
 * @property {number} tempCount
 * @property {number} cellCount
 * @property {string} softwareVersion
 * @property {string} hardwareVersion
 * @property {number} systemStatus
 * @property {number} [boardNumber] 65 byte form only
 * @property {number} [pcsProtocol]
 * @property {number} [heatingStrategy]
 * @property {number} [buzzer]
 */

/**
 * @param {Uint8Array} d data bytes (61 or 65)
 * @returns {MainInfo}
 */
export function parseMain(d) {
  if (d.length < 61) throw new RangeError(`0x01 answer too short: ${d.length} bytes`);
  const currentRaw = u16be(d, 21);
  const { offset, current } = decodeCurrent(currentRaw);
  /** @type {MainInfo} */
  const m = {
    heatingCurrent: round(u16be(d, 0) * 0.1),
    socAh: round(u16be(d, 2) * 0.1),
    soh: round(u16be(d, 4) * 0.1),
    mosTemp: temp40(d[6]),
    boardTemp: temp40(d[7]),
    heaterTemp: temp40(d[8]),
    cycles: u16be(d, 9),
    statusByte: d[11],
    chargeCurrentLimit: round(u16be(d, 12) * 0.1),
    dischargeCurrentLimit: round(u16be(d, 14) * 0.1),
    heatRequest: d[16],
    chargeRequest: d[17],
    subState: d[18],
    voltage: round(u16be(d, 19) * 0.1),
    currentRaw,
    current,
    currentOffset: offset,
    soc: round(u16be(d, 23) * 0.1),
    mosState: d[25],
    batteryType: d[26],
    life: d[27],
    tempCount: d[28],
    cellCount: d[29],
    softwareVersion: fieldText(d, 30, 16),
    hardwareVersion: fieldText(d, 46, 14),
    systemStatus: d[60],
  };
  if (d.length >= 65) {
    m.boardNumber = d[61];
    m.pcsProtocol = d[62];
    m.heatingStrategy = d[63];
    m.buzzer = d[64];
  }
  return m;
}

/**
 * Detection checks of a 0x01 answer (spec 11.2). Returns null when plausible, else the reason.
 * @param {Uint8Array} d data bytes
 */
export function mainProblem(d) {
  if (d.length !== 61 && d.length !== 65) return `length ${d.length}`;
  const m = parseMain(d);
  if (m.cellCount < 1 || m.cellCount > CELL_SLOTS) return `cell count ${m.cellCount}`;
  if (m.tempCount > TEMP_SLOTS) return `sensor count ${m.tempCount}`;
  if (m.voltage < 5 || m.voltage > 70) return `voltage ${m.voltage} V`;
  if (m.soc > 100) return `SOC ${m.soc} %`;
  if (!isPrintableField(d, 30, 16) || !isPrintableField(d, 46, 14)) return 'version text not printable';
  if (!m.softwareVersion && !m.hardwareVersion) return 'no version text';
  return null;
}

/**
 * 0x03 answer (spec 6.1.3): 21 bytes as captured, at least 13.
 * @param {Uint8Array} d
 */
export function parseTemperatures(d) {
  if (d.length < MIN_TEMPERATURES_LENGTH) throw new RangeError(`0x03 answer too short: ${d.length} bytes`);
  const temperatures = [];
  for (let i = 0; i < TEMP_SLOTS; i++) temperatures.push(temp40(d[5 + i]));
  return {
    maxTemp: temp40(d[0]),
    maxTempNo: d[1],
    minTemp: temp40(d[2]),
    minTempNo: d[3],
    tempDiff: d[4],
    temperatures,
    padding: d.length - 13,
  };
}

/**
 * 0x04 answer (spec 6.1.4): header extremes (sampled separately from the array) and the cell slots
 * present, 32 as captured, at least 16 (the 40 byte form of the [SX] app configuration).
 * @param {Uint8Array} d
 */
export function parseCells(d) {
  if (d.length < MIN_CELLS_LENGTH) throw new RangeError(`0x04 answer too short: ${d.length} bytes`);
  const slots = Math.min(CELL_SLOTS, (d.length - 8) >> 1);
  const cellVoltages = [];
  for (let i = 0; i < slots; i++) cellVoltages.push(u16be(d, 8 + 2 * i) / 1000);
  return {
    maxCell: u16be(d, 0) / 1000,
    maxCellNo: d[2],
    minCell: u16be(d, 3) / 1000,
    minCellNo: d[5],
    cellDiff: u16be(d, 6) / 1000,
    cellSlots: slots,
    cellVoltages,
  };
}

/**
 * 0x02 answer (spec 6.1.2): twelve bytes whose bits are not mapped by any source.
 * @param {Uint8Array} d
 */
export function parseAlarmBlock(d) {
  return { alarmBytes: hex(d), active: d.some((b) => b !== 0) };
}

/**
 * Log description of an AA 55 frame (plaintext).
 * @param {Uint8Array} f
 * @returns {{ name: string, decode: () => any } | null}
 */
export function describeAa55(f) {
  const p = parseFrame(f);
  if (!p) return null;
  const what = COMMAND_NAMES[/** @type {keyof typeof COMMAND_NAMES} */ (p.command)] ?? `Command 0x${p.command.toString(16).toUpperCase().padStart(2, '0')}`;
  const answer = p.length > 0;
  return {
    name: `Deye ${what} ${answer ? 'answer' : 'request'}`,
    decode: () => {
      /** @type {Record<string, any>} */
      const out = { address: p.address, command: p.command, length: p.length, crcValid: p.crcValid };
      if (!answer || !p.crcValid) return out;
      try {
        if (p.command === CMD.MAIN) return { ...out, ...parseMain(p.data) };
        if (p.command === CMD.TEMPERATURES) return { ...out, ...parseTemperatures(p.data) };
        if (p.command === CMD.CELLS) return { ...out, ...parseCells(p.data) };
        if (p.command === CMD.ALARMS) return { ...out, ...parseAlarmBlock(p.data) };
      } catch (err) {
        return { ...out, error: err instanceof Error ? err.message : String(err) };
      }
      return { ...out, data: hex(p.data) };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Bluetooth session (spec 3.2)
// ---------------------------------------------------------------------------------------------

/** Every handshake message starts with 01 FF and a six letter ASCII tag. */
export const HANDSHAKE_PREFIX = Object.freeze([0x01, 0xff]);
export const HANDSHAKE_TAGS = Object.freeze(['random', 'cipher', 'result']);
/** IV of every message: sixteen ASCII "0" (0x30), not zero bytes (spec 3.2). */
export const SESSION_IV = Object.freeze(Array.from(latin1('0000000000000000')));

/**
 * Session key: the first 16 characters of the lower case hex SHA-256 of (advertised name +
 * randomStr), used as 16 ASCII bytes (spec 3.2).
 * @param {string} name
 * @param {string} randomStr
 * @returns {string} 16 characters
 */
export function sessionKey(name, randomStr) {
  return sha256Hex(latin1(`${name}${randomStr}`)).slice(0, 16);
}

/**
 * The cipher block the battery answers: AES-128-CBC of randomStr without padding.
 * @param {string} key
 * @param {string} randomStr 16 characters
 */
export function cipherBlock(key, randomStr) {
  return aes128CbcEncrypt(latin1(key), SESSION_IV, latin1(randomStr), { padding: false });
}

/**
 * Handshake message: 01 FF, tag, payload, CRC-16/MODBUS of all preceding bytes, low byte first.
 * @param {string} tag
 * @param {ArrayLike<number>} payload
 */
export function encodeHandshake(tag, payload) {
  const body = concat(HANDSHAKE_PREFIX, latin1(tag), Uint8Array.from(payload));
  const crc = crc16Modbus(body);
  return concat(body, [crc & 0xff, crc >> 8]);
}

/** @param {string} randomStr 16 ASCII hex characters */
export const encodeRandom = (randomStr) => encodeHandshake('random', latin1(randomStr));
/** @param {Uint8Array} block 16 bytes */
export const encodeCipher = (block) => encodeHandshake('cipher', block);
/** @param {number} [status] */
export const encodeResult = (status = 1) => encodeHandshake('result', [status]);

/** Length of a handshake message by tag. @param {string} tag */
const handshakeLength = (tag) => (tag === 'result' ? 11 : 26);

/**
 * @typedef {Object} HandshakeMessage
 * @property {'random'|'cipher'|'result'} tag
 * @property {Uint8Array} payload
 * @property {number} trailer CRC as transmitted, low byte first, read as a number
 * @property {boolean} trailerValid
 * @property {string} [randomStr] random
 * @property {string} [block] cipher, hex
 * @property {number} [status] result
 */

/**
 * Tag of a buffer that starts like a handshake message, or null.
 * @param {Uint8Array} b
 */
function handshakeTag(b) {
  if (b.length < 8 || b[0] !== 0x01 || b[1] !== 0xff) return null;
  const tag = String.fromCharCode(...b.subarray(2, 8));
  return HANDSHAKE_TAGS.includes(tag) ? /** @type {'random'|'cipher'|'result'} */ (tag) : null;
}

/**
 * Parses a complete handshake message.
 * @param {Uint8Array} b
 * @returns {HandshakeMessage | null}
 */
export function parseHandshake(b) {
  const tag = handshakeTag(b);
  if (!tag || b.length !== handshakeLength(tag)) return null;
  const n = b.length;
  const crc = crc16Modbus(b, 0, n - 2);
  const payload = b.slice(8, n - 2);
  /** @type {HandshakeMessage} */
  const m = { tag, payload, trailer: b[n - 2] | (b[n - 1] << 8), trailerValid: b[n - 2] === (crc & 0xff) && b[n - 1] === crc >> 8 };
  if (tag === 'random') m.randomStr = String.fromCharCode(...payload);
  if (tag === 'cipher') m.block = hex(payload);
  if (tag === 'result') m.status = payload[0];
  return m;
}

/**
 * A fresh random string: 16 upper case ASCII hex characters, as the app sends (spec 3.2). Not
 * secret (the key derives from public data), so Math.random is enough.
 * @param {() => number} [random]
 */
export function randomString(random = Math.random) {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(random() * 16).toString(16).toUpperCase();
  return s;
}

/**
 * Encrypted request: AES-128-CBC with PKCS#7 of the lower case ASCII hex text of the frame
 * (spec 3.2 "asymmetry").
 * @param {string} key
 * @param {Uint8Array} frame plaintext AA 55 frame
 */
export function encryptRequest(key, frame) {
  return aes128CbcEncrypt(latin1(key), SESSION_IV, latin1(hex(frame).toLowerCase()));
}

/**
 * Plaintext frame of an encrypted request (simulator side), or null.
 * @param {string} key
 * @param {Uint8Array} bytes
 */
export function decryptRequest(key, bytes) {
  const text = aes128CbcDecrypt(latin1(key), SESSION_IV, bytes);
  if (!text || text.length % 2) return null;
  const s = String.fromCharCode(...text);
  if (!/^[0-9a-f]+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Encrypted answer: AES-128-CBC with PKCS#7 of the frame bytes themselves.
 * @param {string} key
 * @param {Uint8Array} frame
 */
export function encryptAnswer(key, frame) {
  return aes128CbcEncrypt(latin1(key), SESSION_IV, frame);
}

/**
 * Plaintext of an encrypted answer when it is one complete, valid AA 55 frame, else null.
 * @param {string} key
 * @param {Uint8Array} bytes
 */
export function decryptAnswer(key, bytes) {
  const plain = aes128CbcDecrypt(latin1(key), SESSION_IV, bytes);
  return plain && isValidFrame(plain) ? plain : null;
}

/** Longest encrypted answer: a 65 byte 0x01 answer (74 bytes) or 0x05 (73) pads to 80, 0x04 (81) to 96. */
const MAX_CIPHERTEXT = 112;

/**
 * Assembler for the notifications of characteristic FFF2. Emits handshake messages as received
 * and data answers decrypted (the plaintext AA 55 frame), so the protocol log shows readable
 * frames. In the captures each message arrived in one notification; with a small MTU an answer
 * may be split, so notifications are collected until a prefix of a multiple of 16 bytes decrypts
 * with valid padding into a complete frame with a valid CRC (spec 3.2, **unverified** splitting).
 * @param {{ onFrame: (f: Uint8Array) => void, onDiscard?: (b: Uint8Array, reason: string) => void, getKey: () => string | null, staleMs?: number, now?: () => number }} opts
 */
export function createBleAssembler({ onFrame, onDiscard, getKey, staleMs = 1500, now = () => Date.now() }) {
  let buf = new Uint8Array(0);
  let lastPush = 0;
  /** @param {Uint8Array} b @param {string} reason */
  const discard = (b, reason) => {
    if (b.length) onDiscard?.(b, reason);
  };
  /**
   * @param {Uint8Array} b
   * @returns {{ frame: Uint8Array, used: number } | 'more' | 'invalid'}
   */
  const take = (b) => {
    const tag = handshakeTag(b);
    if (tag) {
      const len = handshakeLength(tag);
      if (b.length < len) return 'more';
      const m = b.slice(0, len);
      return parseHandshake(m)?.trailerValid ? { frame: m, used: len } : 'invalid';
    }
    if (b.length >= 2 && b[0] === 0x01 && b[1] === 0xff && b.length < 8) return 'more';
    const key = getKey();
    if (!key) return 'invalid';
    for (let n = 16; n <= b.length && n <= MAX_CIPHERTEXT; n += 16) {
      const plain = decryptAnswer(key, b.subarray(0, n));
      if (plain) return { frame: plain, used: n };
    }
    return b.length < MAX_CIPHERTEXT ? 'more' : 'invalid';
  };
  return {
    /** @param {Uint8Array} chunk */
    push(chunk) {
      const t = now();
      if (buf.length && t - lastPush > staleMs) {
        discard(buf, 'stale partial message');
        buf = new Uint8Array(0);
      }
      lastPush = t;
      buf = buf.length ? concat(buf, chunk) : Uint8Array.from(chunk);
      while (buf.length) {
        const r = take(buf);
        if (r !== 'more' && r !== 'invalid') {
          buf = buf.slice(r.used);
          onFrame(r.frame);
          continue;
        }
        // The newest notification may be a message of its own after a broken remainder: whole
        // (it wins over waiting for more), or the start of one when the remainder is invalid.
        if (chunk.length < buf.length) {
          const alone = take(chunk);
          if ((alone !== 'more' && alone !== 'invalid') || (r === 'invalid' && alone === 'more')) {
            discard(buf.subarray(0, buf.length - chunk.length), 'undecodable message');
            buf = Uint8Array.from(chunk);
            continue;
          }
        }
        if (r === 'more') return;
        discard(buf, getKey() ? 'undecodable message' : 'data before the session key');
        buf = new Uint8Array(0);
        return;
      }
    },
    reset() {
      discard(buf, 'reset');
      buf = new Uint8Array(0);
    },
  };
}

/**
 * Log description of a frame of the Bluetooth link (handshake message or decrypted AA 55 frame).
 * @param {Uint8Array} f
 */
export function describeBle(f) {
  const h = parseHandshake(f);
  if (h) {
    return {
      name: `Deye handshake ${h.tag}`,
      decode: () => ({ tag: h.tag, randomStr: h.randomStr, block: h.block, status: h.status, trailerValid: h.trailerValid }),
    };
  }
  return describeAa55(f);
}
