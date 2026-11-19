import { FrameAssembler, crc16Modbus, hex } from '@ubms/transport';
import { r } from '../common/util.js';

/**
 * JBD UP series rack BMS (UP16S020, UP16S015) over RS485, pure functions without I/O
 * (docs/protocols/jbd.md, "spec" below, sections 2.3, 3.7, 4.6, 5.4, 6.10, 9.9, 11.5). This is
 * not the DD protocol: frames are `addr fn start(2) end(2) len(2) data crc16`, big endian except
 * the CRC-16/MODBUS, which is sent low byte first.
 *
 * Only the pack status block 0x1000 .. 0x10A0 is decoded; it has two independent sources and a
 * capture of two packs. Other blocks and every write (function 0x79) are unverified and not used.
 */

export const UP_FN = Object.freeze({ READ: 0x78, WRITE: 0x79, PACK_STATUS: 0x45 });

/** Pack status block (spec 5.4, 6.10). */
export const UP_STATUS_START = 0x1000;
export const UP_STATUS_END = 0x10a0;
/** Smallest status block that still carries the cell count at data offset 66 (spec 11.5). */
export const UP_MIN_STATUS_LENGTH = 70;
/** Largest data field accepted by the assembler (the status answer has 150 to 158 bytes). */
const UP_MAX_DATA = 512;

export const UP_DEFAULT_ADDRESS = 1;
export const UP_MAX_ADDRESS = 247;

/** Temperatures: degrees C = (raw - 500) / 10 (spec 6.10). @param {number} raw */
export const upTemp = (raw) => r((raw - 500) / 10, 1);

/** @param {ArrayLike<number>} b @param {number} i */
const u16 = (b, i) => ((b[i] << 8) | b[i + 1]) >>> 0;
/** @param {ArrayLike<number>} b @param {number} i */
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

/**
 * Build a UP frame (spec 3.7).
 * @param {number} address 1..247
 * @param {number} fn function code
 * @param {number} start
 * @param {number} end
 * @param {ArrayLike<number>} [data]
 */
export function encodeUp(address, fn, start, end, data = []) {
  const n = data.length;
  const out = new Uint8Array(10 + n);
  out[0] = address & 0xff;
  out[1] = fn & 0xff;
  out[2] = start >> 8;
  out[3] = start & 0xff;
  out[4] = end >> 8;
  out[5] = end & 0xff;
  out[6] = n >> 8;
  out[7] = n & 0xff;
  out.set(Array.from(data, (v) => v & 0xff), 8);
  const crc = crc16Modbus(out, 0, 8 + n);
  out[8 + n] = crc & 0xff;
  out[9 + n] = crc >> 8;
  return out;
}

/** Status block request `addr 78 10 00 10 A0 00 00 crc` (spec 4.6, 11.5). @param {number} address */
export const encodeUpStatusRequest = (address) => encodeUp(address, UP_FN.READ, UP_STATUS_START, UP_STATUS_END);

/** @param {Uint8Array} f */
export function upCrcOk(f) {
  if (f.length < 10) return false;
  const n = f.length - 2;
  return crc16Modbus(f, 0, n) === (f[n] | (f[n + 1] << 8));
}

/**
 * Assembler of UP frames for one address (both directions: requests have a zero length field).
 * @param {{ address: number, onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} opts
 */
export function createUpAssembler({ address, onFrame, onDiscard }) {
  const a = address & 0xff;
  return new FrameAssembler({
    sync: [
      [a, UP_FN.READ],
      [a, UP_FN.WRITE],
      [a, UP_FN.PACK_STATUS],
    ],
    length: (buf) => {
      if (buf.length < 8) return 0;
      const n = u16(buf, 6);
      return n > UP_MAX_DATA ? -1 : 10 + n;
    },
    validate: upCrcOk,
    onFrame,
    onDiscard,
    maxLength: 10 + UP_MAX_DATA,
    staleMs: 1000,
  });
}

/**
 * Decode the pack status data (spec 6.10). The current sign while charging, the protection and
 * alarm bit lists and the meaning of the trailing 30 byte string are unverified (spec 6.10, 9.9).
 * @param {Uint8Array} d data bytes
 */
export function parseUpStatus(d) {
  /** @type {Record<string, any>} */
  const st = {
    totalVoltage: r(u16(d, 0) * 0.01, 2),
    current: r((u32(d, 4) - 300000) * 0.01, 2),
    soc: r(u16(d, 8) * 0.01, 2),
    remainingCapacity: r(u16(d, 10) * 0.01, 2),
    fullCapacity: r(u16(d, 12) * 0.01, 2),
    ratedCapacity: r(u16(d, 14) * 0.01, 2),
    mosTemperature: upTemp(u16(d, 16)),
    ambientTemperature: upTemp(u16(d, 18)),
    operationStatus: u16(d, 20),
    soh: u16(d, 22),
    protectionBits: u32(d, 24),
    alarmBits: u32(d, 28),
    mosStatus: u16(d, 32),
    cycles: u16(d, 36),
    maxCellIndex: u16(d, 38),
    maxCellVoltage: r(u16(d, 40) * 0.001, 3),
    minCellIndex: u16(d, 42),
    minCellVoltage: r(u16(d, 44) * 0.001, 3),
    avgCellVoltage: r(u16(d, 46) * 0.001, 3),
    chargeVoltageLimit: r(u16(d, 58) * 0.1, 1),
    chargeCurrentLimit: r(u16(d, 60) * 0.1, 1),
    dischargeVoltageLimit: r(u16(d, 62) * 0.1, 1),
    dischargeCurrentLimit: r(u16(d, 64) * 0.1, 1),
    cellCount: u16(d, 66),
  };
  if (st.current === 0) st.current = 0;
  let o = 68;
  st.cellVoltages = [];
  for (let i = 0; i < st.cellCount && o + 2 * i + 1 < d.length; i++) st.cellVoltages.push(r(u16(d, o + 2 * i) * 0.001, 3));
  o += 2 * st.cellCount;
  st.temperatures = [];
  if (o + 1 < d.length) {
    const count = u16(d, o);
    o += 2;
    for (let i = 0; i < count && o + 2 * i + 1 < d.length; i++) st.temperatures.push(upTemp(u16(d, o + 2 * i)));
    o += 2 * count;
  }
  if (d.length >= o + 6 + 30) {
    st.balanceBits = u16(d, o + 2);
    st.firmwareVersion = `${d[o + 4]}.${d[o + 5]}`;
    const m = d.subarray(o + 6, o + 36);
    const zero = m.indexOf(0);
    st.model = String.fromCharCode(...(zero >= 0 ? m.subarray(0, zero) : m)).trim();
  }
  return st;
}

/**
 * Parse a UP frame (spec 3.7). Keys match the `JBD_UP` vectors.
 * @param {Uint8Array} f
 */
export function parseUpFrame(f) {
  const n = u16(f, 6);
  /** @type {Record<string, any>} */
  const out = { address: f[0], function: f[1], startAddress: u16(f, 2), endAddress: u16(f, 4), dataLength: n, crcValid: f.length === n + 10 && upCrcOk(f) };
  const d = f.subarray(8, 8 + n);
  if (f[1] === UP_FN.READ && out.startAddress === UP_STATUS_START && n >= UP_MIN_STATUS_LENGTH) out.status = parseUpStatus(d);
  else if (f[1] === UP_FN.WRITE && n === 6) out.write = { marker: hex(d.subarray(0, 4)), value: u16(d, 4) };
  return out;
}

/**
 * Detection rule of spec 11.5 for a status answer: function 0x78, start 0x1000, data length at
 * least 70, cell count 1..32. Returns an English reason or null.
 * @param {Uint8Array} f
 * @param {number} address
 */
export function upStatusProblem(f, address) {
  if (f[0] !== address) return `address ${f[0]}`;
  if (f[1] !== UP_FN.READ) return `function 0x${f[1].toString(16)}`;
  if (u16(f, 2) !== UP_STATUS_START) return `start 0x${u16(f, 2).toString(16)}`;
  const n = u16(f, 6);
  if (n < UP_MIN_STATUS_LENGTH) return `data length ${n}`;
  const cells = u16(f, 8 + 66);
  if (cells < 1 || cells > 32) return `cell count ${cells}`;
  if (8 + 68 + 2 * cells > f.length - 2) return `cell count ${cells} does not fit ${n} data bytes`;
  return null;
}

/**
 * Log description of a UP frame.
 * @param {Uint8Array} f
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describeUp(f) {
  if (!f || f.length < 10) return null;
  const n = u16(f, 6);
  const start = u16(f, 2);
  const block = start === UP_STATUS_START ? 'pack status' : `block 0x${start.toString(16).toUpperCase().padStart(4, '0')}`;
  const what = f[1] === UP_FN.READ ? (n === 0 ? `Read ${block} request` : `Read ${block}`) : f[1] === UP_FN.WRITE ? `Write ${block}` : `Function 0x${f[1].toString(16)}`;
  return { name: `UP ${what}, address ${f[0]}`, decode: () => parseUpFrame(f) };
}
