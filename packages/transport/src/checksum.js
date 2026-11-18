/**
 * Checksums used by device protocols. All functions take an optional [start, end) byte range.
 */

/**
 * 8-bit sum (modulo 256).
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function sum8(bytes, start = 0, end = bytes.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += bytes[i];
  return s & 0xff;
}

/**
 * 16-bit sum (modulo 65536).
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function sum16(bytes, start = 0, end = bytes.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += bytes[i];
  return s & 0xffff;
}

/**
 * XOR of all bytes.
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function xor8(bytes, start = 0, end = bytes.length) {
  let x = 0;
  for (let i = start; i < end; i++) x ^= bytes[i];
  return x & 0xff;
}

const CRC16_MODBUS_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/**
 * CRC-16/MODBUS (poly 0x8005 reflected = 0xA001, init 0xFFFF, no final xor).
 * On the wire Modbus sends the low byte first.
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function crc16Modbus(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC16_MODBUS_TABLE[(crc ^ bytes[i]) & 0xff];
  return crc & 0xffff;
}

/**
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF).
 * @param {ArrayLike<number>} bytes
 * @param {number} [start]
 * @param {number} [end]
 */
export function crc16CcittFalse(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
