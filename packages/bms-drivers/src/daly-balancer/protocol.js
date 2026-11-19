import { FrameAssembler, crc16Modbus, hex, setU16le, u16be, u16le } from '@ubms/transport';
import { SEVERITY_ORDER, alarm, msg } from '@ubms/bms-core';
import { r, ymd } from '../common/util.js';

/**
 * Daly active balancer protocol, pure functions without I/O. Specification:
 * docs/protocols/daly-balancer.md ("spec" below).
 *
 * The balancer speaks the Modbus style "D2" frames of the newer Daly BMS boards (spec 1.2, 3):
 * address 0xD2, functions 0x03 (read), 0x06 (write one register) and 0x10 (write several, without
 * the byte count of standard Modbus), CRC-16/MODBUS low byte first. Read replies carry no start
 * register, so a reply is matched to the one request in flight by its byte count (spec 3.1).
 *
 * The code is deliberately independent of `../daly/` (the Daly BMS drivers): the framing is the
 * same, but the balancer fills many BMS registers with fixed values (spec 1.4), has its own
 * detection signature (spec 11.3) and writes only four registers (spec 7).
 *
 * Parsers return plain objects whose field names match the test vectors
 * (packages/bms-drivers/test/vectors/dalybal.json): engineering units (V, degrees C, s) unless a
 * key ends in `Raw` (register value as read) or `Register` (a scaled statistic register that the
 * driver does not use, spec 12 item 3).
 *
 * @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState
 */

// ---------------------------------------------------------------------------------------------
// Constants (spec 0, 5, 6)
// ---------------------------------------------------------------------------------------------

/** Protocol variant reported through `setVariant()`. */
export const VARIANT = 'DALY_BALANCER_D2';

/** Request and reply address of the D2 frames (spec 3.1). */
export const D2_ADDRESS = 0xd2;

/** Function codes (spec 3.1 to 3.3). */
export const FN = Object.freeze({ READ: 0x03, WRITE: 0x06, WRITE_MULTI: 0x10 });

/** Largest frame: address, function, byte count, 255 data bytes, CRC. */
export const MAX_FRAME = 5 + 255;

/** Highest register count of one read (Modbus limit; the balancer is read with at most 80). */
const MAX_READ_COUNT = 125;

/** Register blocks the driver reads (spec 5.1). */
export const BLOCK = Object.freeze({
  /** Status, 62 registers from 0x0000: the read of the official app over BLE (spec 6.1). */
  STATUS: Object.freeze({ start: 0x0000, count: 62 }),
  /** Status, 80 registers: confirmed on the UART by cepr; the poll on serial links (spec 4.2, 5.1). */
  STATUS_80: Object.freeze({ start: 0x0000, count: 80 }),
  /** Balance block 0x003E..0x0046 (spec 6.2). */
  BALANCE: Object.freeze({ start: 0x003e, count: 9 }),
  /** Settings block 0x0080..0x00A8 (spec 6.3). */
  SETTINGS: Object.freeze({ start: 0x0080, count: 41 }),
  /** Version block 0x00A9..0x00C8 (spec 6.4). */
  VERSION: Object.freeze({ start: 0x00a9, count: 32 }),
  /** Parameter password 0x00C9..0x00CB (spec 6.4). */
  PASSWORD: Object.freeze({ start: 0x00c9, count: 3 }),
  /** Production date, 0x00CE, balancer switch 0x00CF, 0x00D0 (spec 6.5). */
  SWITCH: Object.freeze({ start: 0x00cc, count: 5 }),
});

/** Register addresses (spec 6.1 to 6.5). */
export const REG = Object.freeze({
  CELLS: 0x0000,
  TEMPERATURES: 0x0020,
  TOTAL_VOLTAGE: 0x0028,
  CURRENT: 0x0029,
  SOC: 0x002a,
  CELL_MAX: 0x002b,
  CELL_MIN: 0x002c,
  TEMP_MAX: 0x002d,
  TEMP_MIN: 0x002e,
  CHARGE_STATE: 0x002f,
  REMAINING: 0x0030,
  CELL_COUNT: 0x0031,
  TEMP_COUNT: 0x0032,
  CYCLES: 0x0033,
  BALANCING_STATE: 0x0034,
  CHARGE_MOS: 0x0035,
  DISCHARGE_MOS: 0x0036,
  CELL_AVG: 0x0037,
  CELL_DELTA: 0x0038,
  POWER: 0x0039,
  FAULTS: 0x003a,
  BALANCE_BITS: 0x003e,
  BALANCE_CURRENT: 0x0040,
  MOS_TEMP: 0x0042,
  BOARD_TEMP: 0x0043,
  RATED_CAPACITY: 0x0080,
  CELL_REFERENCE: 0x0081,
  BOARD_COUNT: 0x0082,
  BOARD_CELLS: 0x0083,
  BOARD_TEMPS: 0x0086,
  BATTERY_TYPE: 0x0089,
  SLEEP: 0x008a,
  CELL_LIMITS: 0x008b,
  PACK_LIMITS: 0x008f,
  CURRENT_LIMITS: 0x0093,
  TEMP_LIMITS: 0x0097,
  DIFF_LIMITS: 0x009f,
  START_VOLTAGE: 0x00a3,
  TRIGGER_DELTA: 0x00a4,
  CHARGE_MOS_SWITCH: 0x00a5,
  DISCHARGE_MOS_SWITCH: 0x00a6,
  SOC_SETTING: 0x00a7,
  REG_00A8: 0x00a8,
  SOFTWARE_VERSION: 0x00a9,
  PASSWORD: 0x00c9,
  PRODUCTION_DATE: 0x00cc,
  REG_00CE: 0x00ce,
  SWITCH: 0x00cf,
  REG_00D0: 0x00d0,
});

/**
 * The only registers ubms writes (spec 7): the balancer switch (captured), the start voltage and
 * the start difference (vendor list, read on two balancers, no captured write) and the sleep time
 * (write echoed on hardware). Every other write is refused by the driver (spec 5.3).
 */
export const WRITABLE_REGISTERS = Object.freeze([REG.SWITCH, REG.START_VOLTAGE, REG.TRIGGER_DELTA, REG.SLEEP]);

/** Raw value of the current registers that means 0 A (30000 offset, spec 6.1, 6.3). */
export const CURRENT_ZERO = 30000;

/** Sleep time that disables sleep (spec 7.3, [BAL1A]). */
export const SLEEP_NEVER = 65535;

/** Battery types of register 0x0089 (spec 9.3, vendor list). */
export const BATTERY_TYPES = Object.freeze({
  0: msg('LiFePO4'),
  1: msg('Ternary lithium (NMC)'),
  2: msg('Lithium titanate (LTO)'),
});

/** Highest counted cell and temperature slots (spec 6.1). */
export const MAX_CELLS = 32;
export const MAX_TEMPS = 8;

// ---------------------------------------------------------------------------------------------
// CRC and encoders (spec 3)
// ---------------------------------------------------------------------------------------------

/**
 * Append the CRC-16/MODBUS, low byte first (spec 3.4).
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
export const crcOk = (frame) => frame.length >= 4 && crc16Modbus(frame, 0, frame.length - 2) === u16le(frame, frame.length - 2);

/**
 * Read holding registers (0x03): `D2 03 <start> <count> <CRC>` (spec 3.1).
 * @param {number} start
 * @param {number} count
 */
export const encodeRead = (start, count) => withCrc([D2_ADDRESS, FN.READ, start >> 8, start & 0xff, count >> 8, count & 0xff]);

/**
 * Write one register (0x06): `D2 06 <register> <value> <CRC>`; the balancer echoes the 8 bytes
 * (spec 3.2). The driver sends it only for WRITABLE_REGISTERS.
 * @param {number} register
 * @param {number} value u16
 */
export const encodeWrite = (register, value) =>
  withCrc([D2_ADDRESS, FN.WRITE, register >> 8, register & 0xff, (value >> 8) & 0xff, value & 0xff]);

/**
 * Write several registers (0x10) the Daly way, without a byte count (spec 3.3). Only for the
 * protocol log and the test vectors (the app's clock write and 0x81 probe): ubms never sends it.
 * @param {number} start
 * @param {number[]} values u16 each
 * @param {number} [address] 0xD2, or 0x81 for the app's probe of the 0x81 map
 */
export function encodeWriteMulti(start, values, address = D2_ADDRESS) {
  const bytes = [address, FN.WRITE_MULTI, start >> 8, start & 0xff, values.length >> 8, values.length & 0xff];
  for (const v of values) bytes.push((v >> 8) & 0xff, v & 0xff);
  return withCrc(bytes);
}

/**
 * Whether ubms may send this frame (spec 5.2, 5.3): reads always; writes only as one register
 * write to WRITABLE_REGISTERS. Clock writes, the app probes, battery type writes and every BMS
 * command register are refused.
 * @param {Uint8Array} frame
 */
export function isAllowedRequest(frame) {
  if (frame.length !== 8 || frame[0] !== D2_ADDRESS || !crcOk(frame)) return false;
  if (frame[1] === FN.READ) return true;
  return frame[1] === FN.WRITE && WRITABLE_REGISTERS.includes(u16be(frame, 2));
}

/**
 * Read reply (device side: simulator and tests).
 * @param {ArrayLike<number>} registers u16 values
 */
export function encodeReadResponse(registers) {
  const bytes = [D2_ADDRESS, FN.READ, (2 * registers.length) & 0xff];
  for (let i = 0; i < registers.length; i++) bytes.push((registers[i] >> 8) & 0xff, registers[i] & 0xff);
  return withCrc(bytes);
}

// ---------------------------------------------------------------------------------------------
// Framing (spec 3.5)
// ---------------------------------------------------------------------------------------------

/**
 * Length of a reply at the start of `buf` (spec 3.5 step 1): 0x03 -> 5 + byte count, 0x06 and
 * 0x10 -> 8, exception (bit 7 set) -> 5, anything else -> -1 (invalid header, drop one byte). A
 * read header with a zero or odd byte count is invalid. With `expectedByteCount` a read header with
 * another byte count is invalid too, so the start of a stale or damaged reply is never taken for
 * the reply in flight (spec 3.5 step 4).
 * @param {Uint8Array} buf
 * @param {number} [expectedByteCount]
 */
export function responseLength(buf, expectedByteCount) {
  if (buf.length < 2) return 0;
  const fn = buf[1];
  if (fn === FN.READ) {
    if (buf.length < 3) return 0;
    const n = buf[2];
    if (n === 0 || n & 1) return -1;
    if (expectedByteCount !== undefined && n !== expectedByteCount) return -1;
    return 5 + n;
  }
  if (fn === FN.WRITE || fn === FN.WRITE_MULTI) return 8;
  if (fn & 0x80) return 5;
  return -1;
}

/**
 * Length of a request at the start of `buf` (device side): 0x03 and 0x06 are 8 bytes, 0x10
 * carries 2 x count data bytes without a byte count (spec 3.3).
 * @param {Uint8Array} buf
 */
export function requestLength(buf) {
  if (buf.length < 2) return 0;
  const fn = buf[1];
  if (fn === FN.READ || fn === FN.WRITE) return 8;
  if (fn === FN.WRITE_MULTI) {
    if (buf.length < 6) return 0;
    const count = u16be(buf, 4);
    return count >= 1 && count <= 123 ? 8 + 2 * count : -1;
  }
  return -1;
}

/**
 * Host side frame assembler (spec 3.5): syncs on 0xD2 only, so AT text of the Bluetooth module and
 * the 0x51 reply of the app's 0x81 probe are skipped; several replies in one notification are
 * split; a bad CRC drops one byte and resynchronises.
 * @param {{
 *   onFrame: (frame: Uint8Array) => void,
 *   onDiscard?: (bytes: Uint8Array, reason: string) => void,
 *   expectedByteCount?: () => number | undefined,
 * }} opts
 */
export function createAssembler({ onFrame, onDiscard, expectedByteCount }) {
  return new FrameAssembler({
    sync: [[D2_ADDRESS]],
    length: (buf) => responseLength(buf, expectedByteCount?.()),
    validate: crcOk,
    onFrame,
    onDiscard,
    maxLength: MAX_FRAME,
    staleMs: 1000,
  });
}

/**
 * Device side assembler for the simulator: requests addressed to 0xD2.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} opts
 */
export function createRequestAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [[D2_ADDRESS]],
    length: requestLength,
    validate: crcOk,
    onFrame,
    onDiscard,
    maxLength: 8 + 2 * 123,
    staleMs: 1000,
  });
}

// ---------------------------------------------------------------------------------------------
// Generic parsers
// ---------------------------------------------------------------------------------------------

/** @param {Uint8Array} frame CRC of the frame as transmitted, hex, high byte first (vector form). */
const crcHex = (frame) => hex(Uint8Array.of(frame[frame.length - 2], frame[frame.length - 1])).toUpperCase();

/**
 * Parse a request (host to device): reads, single writes and the 0x10 writes of the app.
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export function parseRequest(frame) {
  const fn = frame[1];
  /** @type {Record<string, any>} */
  const out = { address: frame[0], function: fn, crc: crcHex(frame), crcValid: crcOk(frame) };
  if (fn === FN.READ) {
    out.start = u16be(frame, 2);
    out.count = u16be(frame, 4);
    out.replyLength = 5 + 2 * out.count;
  } else if (fn === FN.WRITE) {
    out.register = u16be(frame, 2);
    out.value = u16be(frame, 4);
  } else if (fn === FN.WRITE_MULTI) {
    out.register = u16be(frame, 2);
    out.count = u16be(frame, 4);
    const values = [];
    for (let i = 0; i < out.count && 6 + 2 * i + 1 < frame.length - 2; i++) values.push(u16be(frame, 6 + 2 * i));
    out.values = values;
    // The app writes its clock to 0x00D4 as YY MM DD hh mm ss (spec 3.3, 4.1 step 3).
    if (out.register === 0x00d4 && out.count === 3 && values.length === 3) {
      const b = frame.subarray(6, 12);
      const p2 = (/** @type {number} */ v) => String(v).padStart(2, '0');
      out.clock = `${ymd(2000 + b[0], b[1], b[2])} ${p2(b[3])}:${p2(b[4])}:${p2(b[5])}`;
    }
  }
  out.writable = isAllowedRequest(frame);
  return out;
}

/**
 * Parse a reply (device to host) without knowing the request: address, function, CRC check and
 * for reads the register values (a read reply carries no start register, spec 3.1).
 * @param {Uint8Array} frame
 * @returns {Record<string, any>}
 */
export function parseResponse(frame) {
  const fn = frame[1];
  /** @type {Record<string, any>} */
  const out = { address: frame[0], function: fn, crcValid: crcOk(frame) };
  if (fn === FN.READ) {
    out.byteCount = frame[2];
    out.registerCount = frame[2] >> 1;
    out.registers = registersOf(frame);
  } else if (fn === FN.WRITE) {
    out.register = u16be(frame, 2);
    out.value = u16be(frame, 4);
  } else if (fn === FN.WRITE_MULTI) {
    out.register = u16be(frame, 2);
    // The 0x81 map answers the app's probe with 0xAAAA here instead of a count (spec 6.7).
    out.word = u16be(frame, 4);
  } else if (fn & 0x80) {
    out.exceptionCode = frame[2];
  }
  return out;
}

/**
 * Register values of a read reply (as many as the byte count and the frame allow).
 * @param {Uint8Array} frame
 * @returns {number[]}
 */
export function registersOf(frame) {
  const end = Math.min(3 + frame[2], frame.length - 2);
  const regs = [];
  for (let o = 3; o + 1 < end; o += 2) regs.push(u16be(frame, o));
  return regs;
}

/**
 * Printable ASCII of a register text, stopping at NUL or 0xFF, trimmed (spec 6.4).
 * @param {number[]} regs
 * @param {number} first index of the first register
 * @param {number} count registers
 */
export function registerText(regs, first, count) {
  let s = '';
  for (let i = first; i < first + count && i < regs.length; i++) {
    for (const b of [regs[i] >> 8, regs[i] & 0xff]) {
      if (b === 0x00 || b === 0xff) return s.trim();
      if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    }
  }
  return s.trim();
}

/**
 * Text read backwards. The balancer probably stores its version strings in reverse order and the
 * Daly tools reverse them for display (`B002_111132_03` -> `30_231111_200B`, unverified, spec 6.4).
 * @param {string} s
 */
export const reverseText = (s) => [...s].reverse().join('');

// ---------------------------------------------------------------------------------------------
// Status block (spec 6.1, 6.2)
// ---------------------------------------------------------------------------------------------

/** @param {number} raw temperature register, +40 offset */
const celsius = (raw) => raw - 40;

/**
 * Balance block values from the nine registers 0x003E..0x0046 (spec 6.2). All of them read 0 or a
 * neutral value in every capture, so the meaning is unverified: the balance current uses the
 * scale of syssi ((raw - 30000) x 0.001 A); a raw 0 or 0xFFFF would decode to -30 A or +35 A,
 * which a 1 A balancer cannot carry, so it is reported as not available (ubms choice).
 * @param {number[]} regs nine registers from 0x003E
 */
export function balanceFromRegisters(regs) {
  const raw = regs[2];
  return {
    balanceBitsRaw: [regs[0], regs[1]],
    balanceCurrentRaw: raw,
    balanceCurrent: raw === 0 || raw === 0xffff ? null : r((raw - CURRENT_ZERO) * 0.001, 3),
    register0041: regs[3],
    mosTemperatureRaw: regs[4],
    mosTemperatureAvailable: regs[4] !== 0 && regs[4] !== 0xffff,
    boardTemperatureRaw: regs[5],
  };
}

/**
 * Balance block reply (read 9 registers from 0x003E, spec 6.2).
 * @param {Uint8Array} frame
 */
export function parseBalanceBlock(frame) {
  const regs = registersOf(frame);
  return { ...parseResponse(frame), ...balanceFromRegisters(regs) };
}

/**
 * Status block reply (62 or 80 registers from 0x0000, spec 6.1). Cells and temperatures are
 * decoded only for the counted slots (0x0031, 0x0032): temperature slots 7 and 8 carry the total
 * voltage and the average cell voltage on a balancer (spec 12 item 2). The statistic registers
 * 0x002B, 0x002C, 0x0037 and 0x0038 lag the cells (spec 12 item 3): `cellVoltageMin` and friends
 * are derived from the cells, the register values are kept as `...Register`.
 * @param {Uint8Array} frame
 */
export function parseStatus(frame) {
  const regs = registersOf(frame);
  const at = (/** @type {number} */ reg) => regs[reg] ?? 0;
  const cellCount = at(REG.CELL_COUNT);
  const counted = Math.min(cellCount, MAX_CELLS);
  const cellVoltages = regs.slice(REG.CELLS, REG.CELLS + counted).map((v) => r(v * 0.001, 3));
  const tempCount = at(REG.TEMP_COUNT);
  const temperatureSlotsRaw = regs.slice(REG.TEMPERATURES, REG.TEMPERATURES + MAX_TEMPS);
  const sum = cellVoltages.reduce((a, b) => a + b, 0);
  const min = cellVoltages.length ? Math.min(...cellVoltages) : undefined;
  const max = cellVoltages.length ? Math.max(...cellVoltages) : undefined;
  const alarmRegisters = regs.slice(REG.FAULTS, REG.FAULTS + 4);
  /** @type {Record<string, any>} */
  const st = {
    ...parseResponse(frame),
    cellCount,
    cellVoltages,
    unusedCellSlotsZero: regs.slice(REG.CELLS + counted, REG.CELLS + MAX_CELLS).every((v) => v === 0),
    totalVoltage: r(at(REG.TOTAL_VOLTAGE) * 0.1, 1),
    cellVoltageSum: r(sum, 3),
    cellVoltageMin: min,
    cellVoltageMax: max,
    cellVoltageDelta: min === undefined || max === undefined ? undefined : r(max - min, 3),
    temperatureSensorCount: tempCount,
    temperatures: temperatureSlotsRaw.slice(0, Math.min(tempCount, MAX_TEMPS)).map(celsius),
    temperatureSlotsRaw,
    currentRaw: at(REG.CURRENT),
    socRaw: at(REG.SOC),
    cellVoltageMaxRegister: r(at(REG.CELL_MAX) * 0.001, 3),
    cellVoltageMinRegister: r(at(REG.CELL_MIN) * 0.001, 3),
    temperatureMaxRegister: celsius(at(REG.TEMP_MAX)),
    temperatureMinRegister: celsius(at(REG.TEMP_MIN)),
    chargeDischargeState: at(REG.CHARGE_STATE),
    remainingCapacityRaw: at(REG.REMAINING),
    cycles: at(REG.CYCLES),
    balancingState: at(REG.BALANCING_STATE),
    chargeMosRaw: at(REG.CHARGE_MOS),
    dischargeMosRaw: at(REG.DISCHARGE_MOS),
    cellVoltageAverageRegister: r(at(REG.CELL_AVG) * 0.001, 3),
    cellVoltageDeltaRegister: r(at(REG.CELL_DELTA) * 0.001, 3),
    powerRaw: at(REG.POWER),
    alarmRegisters,
    alarms: faultAlarms(alarmRegisters),
    // Classic byte 7 (high byte of 0x003D) is a numeric fault code, not flags (spec 9.2).
    faultCode: at(REG.FAULTS + 3) >> 8,
  };
  st.balancerSignature = statusSignature(st);
  // The 80 register read (UART, cepr) also covers the balance block (spec 6.2).
  if (regs.length >= REG.BALANCE_BITS + BLOCK.BALANCE.count) st.balance = balanceFromRegisters(regs.slice(REG.BALANCE_BITS, REG.BALANCE_BITS + BLOCK.BALANCE.count));
  return st;
}

/**
 * Status signature of a balancer (spec 11.3 step 3): no current (30000), SOC, remaining capacity,
 * cycles, charge state and MOSFET flags all 0. A Daly BMS fills these fields with measured values.
 * @param {Record<string, any>} st parsed status
 */
export function statusSignature(st) {
  return (
    st.currentRaw === CURRENT_ZERO &&
    st.socRaw === 0 &&
    st.remainingCapacityRaw === 0 &&
    st.cycles === 0 &&
    st.chargeMosRaw === 0 &&
    st.dischargeMosRaw === 0 &&
    st.chargeDischargeState === 0
  );
}

/**
 * Plausibility of a status (spec 11.3 step 2). Returns the reason (English, for the protocol log)
 * or null. A counted cell near 0 V is accepted on purpose: an open sense lead or a wrong cell count
 * reads 0 and must stay visible. `strict` (probe) also asks for one cell of at least 1 V and at
 * most 8 temperature slots.
 * @param {Record<string, any>} st parsed status
 * @param {{ strict?: boolean }} [opts]
 * @returns {string | null}
 */
export function statusProblem(st, { strict = false } = {}) {
  if (!Number.isInteger(st.cellCount) || st.cellCount < 1 || st.cellCount > MAX_CELLS) return `cell count ${st.cellCount}`;
  if (st.cellVoltages.length !== st.cellCount) return `${st.cellVoltages.length} of ${st.cellCount} cell voltages in the reply`;
  if (st.cellVoltages.some((/** @type {number} */ v) => v > 5)) return 'cell voltage above 5 V';
  if (!strict) return null;
  if (!st.cellVoltages.some((/** @type {number} */ v) => v >= 1)) return 'no cell at or above 1 V';
  if (st.temperatureSensorCount > MAX_TEMPS) return `temperature sensor count ${st.temperatureSensorCount}`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Settings block (spec 6.3)
// ---------------------------------------------------------------------------------------------

/**
 * Settings block reply (41 registers from 0x0080, spec 6.3). The configured cell count is the sum
 * over the first 0x0082 boards only (spec 12 item 4: 16, 6, 6 cells with one board).
 * @param {Uint8Array} frame
 */
export function parseSettings(frame) {
  const regs = registersOf(frame);
  const at = (/** @type {number} */ reg) => regs[reg - BLOCK.SETTINGS.start] ?? 0;
  const span = (/** @type {number} */ reg, /** @type {number} */ n) => regs.slice(reg - BLOCK.SETTINGS.start, reg - BLOCK.SETTINGS.start + n);
  const boardCount = at(REG.BOARD_COUNT);
  const cellsPerBoard = span(REG.BOARD_CELLS, 3);
  const batteryType = at(REG.BATTERY_TYPE);
  const sleepDelay = at(REG.SLEEP);
  const currentLimitsRaw = span(REG.CURRENT_LIMITS, 4);
  /** @type {Record<string, any>} */
  const s = {
    ...parseResponse(frame),
    ratedCapacity: r(at(REG.RATED_CAPACITY) * 0.1, 1),
    cellReferenceVoltage: r(at(REG.CELL_REFERENCE) * 0.001, 3),
    boardCount,
    cellsPerBoard,
    cellCountConfigured: cellsPerBoard.slice(0, Math.max(0, Math.min(boardCount, 3))).reduce((a, b) => a + b, 0),
    cellsAllBoardsSum: cellsPerBoard.reduce((a, b) => a + b, 0),
    temperatureSensorsPerBoard: span(REG.BOARD_TEMPS, 3),
    batteryType,
    batteryTypeLabel: /** @type {Record<number, string>} */ (BATTERY_TYPES)[batteryType],
    sleepDelay,
    sleepDisabled: sleepDelay === SLEEP_NEVER,
    cellVoltageLimitsRaw: span(REG.CELL_LIMITS, 4),
    packVoltageLimitsRaw: span(REG.PACK_LIMITS, 4),
    currentLimitsRaw,
    temperatureLimitsRaw: span(REG.TEMP_LIMITS, 8),
    differenceLimitsRaw: span(REG.DIFF_LIMITS, 4),
    balanceStartVoltage: r(at(REG.START_VOLTAGE) * 0.001, 3),
    balanceTriggerDelta: r(at(REG.TRIGGER_DELTA) * 0.001, 3),
    chargeMosSwitchRaw: at(REG.CHARGE_MOS_SWITCH),
    dischargeMosSwitchRaw: at(REG.DISCHARGE_MOS_SWITCH),
    socSettingRaw: at(REG.SOC_SETTING),
    register00A8Raw: at(REG.REG_00A8),
  };
  s.balancerSignature = settingsSignature(s);
  return s;
}

/**
 * Settings signature of a balancer (spec 11.3 step 4): all four current limits 0x0093..0x0096 at
 * 30000 (0 A). A Daly BMS has real current thresholds there.
 * @param {Record<string, any>} s parsed settings
 */
export function settingsSignature(s) {
  return s.currentLimitsRaw.length === 4 && s.currentLimitsRaw.every((/** @type {number} */ v) => v === CURRENT_ZERO);
}

// ---------------------------------------------------------------------------------------------
// Version, password and switch blocks (spec 6.4, 6.5)
// ---------------------------------------------------------------------------------------------

/**
 * Version block reply (32 registers from 0x00A9): software 16 bytes, hardware 16 bytes, machine
 * code 32 bytes (spec 6.4).
 * @param {Uint8Array} frame
 */
export function parseVersion(frame) {
  const regs = registersOf(frame);
  return {
    ...parseResponse(frame),
    softwareVersion: registerText(regs, 0, 8),
    hardwareVersion: registerText(regs, 8, 8),
    machineCode: registerText(regs, 16, 16),
  };
}

/**
 * Parameter password reply (3 registers from 0x00C9, six ASCII digits, spec 6.4).
 * @param {Uint8Array} frame
 */
export function parsePassword(frame) {
  return { ...parseResponse(frame), password: registerText(registersOf(frame), 0, 3) };
}

/**
 * Switch block reply (registers from 0x00CC, 2 or 5 of them, spec 6.5): production date
 * `YY MM DD 00` (`00 01 01 00` = not set), 0x00CE (equals the cell count, meaning unverified),
 * the balancer switch 0x00CF and 0x00D0 (10, meaning unverified).
 * @param {Uint8Array} frame
 */
export function parseSwitchBlock(frame) {
  const regs = registersOf(frame);
  /** @type {Record<string, any>} */
  const out = parseResponse(frame);
  if (regs.length >= 2) {
    const [y, m, d] = [regs[0] >> 8, regs[0] & 0xff, regs[1] >> 8];
    out.productionDateBytes = hex(Uint8Array.of(regs[0] >> 8, regs[0] & 0xff, regs[1] >> 8, regs[1] & 0xff)).toUpperCase();
    // The balancer reads 00 01 01 00: the year byte 0 marks the placeholder (spec 6.5, 10).
    out.productionDateSet = y >= 1 && y <= 99 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
    if (out.productionDateSet) out.productionDate = ymd(2000 + y, m, d);
  }
  if (regs.length >= 3) out.register00CE = regs[2];
  if (regs.length >= 4) Object.assign(out, switchValue(regs[3]));
  if (regs.length >= 5) out.register00D0 = regs[4];
  return out;
}

/**
 * Balancer switch register 0x00CF: 1 on, 0 off (spec 6.5, 7.2); other values (0xFFFF on an 0x81
 * pack, spec 12 item 19) leave the state unknown.
 * @param {number} raw
 */
export function switchValue(raw) {
  return { balancerSwitchRaw: raw, balancerSwitch: raw === 1 ? true : raw === 0 ? false : undefined };
}

/**
 * Decode a read reply when the start register of the request is known (log decoder, tests).
 * @param {Uint8Array} frame
 * @param {number} start
 * @returns {Record<string, any>}
 */
export function decodeReply(frame, start) {
  if (frame[1] !== FN.READ) return parseResponse(frame);
  const n = frame[2] >> 1;
  if (start === BLOCK.STATUS.start && n >= REG.FAULTS + 4) return parseStatus(frame);
  if (start === BLOCK.BALANCE.start && n >= BLOCK.BALANCE.count) return parseBalanceBlock(frame);
  if (start === BLOCK.SETTINGS.start && n >= BLOCK.SETTINGS.count) return parseSettings(frame);
  if (start === BLOCK.VERSION.start && n >= BLOCK.VERSION.count) return parseVersion(frame);
  if (start === BLOCK.PASSWORD.start && n >= BLOCK.PASSWORD.count) return parsePassword(frame);
  if (start === BLOCK.SWITCH.start) return parseSwitchBlock(frame);
  /** @type {Record<string, any>} */
  const out = parseResponse(frame);
  if (start === REG.SWITCH && n === 1) Object.assign(out, switchValue(out.registers[0]));
  const regs = /** @type {number[]} */ (out.registers);
  out.allFF = regs.length > 0 && regs.every((v) => v === 0xffff);
  out.allZero = regs.length > 0 && regs.every((v) => v === 0);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fault registers (spec 9.2)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ byte: number, bit: number, id: string, severity?: 'info'|'warning'|'protection'|'fault' }} FaultBit
 */

/**
 * Bits mapped to catalog alarms, in classic byte order (spec 9.2): only the bits that make sense
 * without current measurement and MOSFETs. Level 1 bits are warnings. Which bits a balancer really
 * sets is undocumented (every captured value is 0).
 * @type {FaultBit[]}
 */
export const FAULT_BITS = [
  { byte: 0, bit: 0, id: 'cell_overvoltage', severity: 'warning' },
  { byte: 0, bit: 1, id: 'cell_overvoltage' },
  { byte: 0, bit: 2, id: 'cell_undervoltage', severity: 'warning' },
  { byte: 0, bit: 3, id: 'cell_undervoltage' },
  { byte: 0, bit: 4, id: 'pack_overvoltage', severity: 'warning' },
  { byte: 0, bit: 5, id: 'pack_overvoltage' },
  { byte: 0, bit: 6, id: 'pack_undervoltage', severity: 'warning' },
  { byte: 0, bit: 7, id: 'pack_undervoltage' },
  { byte: 1, bit: 0, id: 'charge_overtemperature', severity: 'warning' },
  { byte: 1, bit: 1, id: 'charge_overtemperature' },
  { byte: 1, bit: 2, id: 'charge_undertemperature', severity: 'warning' },
  { byte: 1, bit: 3, id: 'charge_undertemperature' },
  { byte: 1, bit: 4, id: 'discharge_overtemperature', severity: 'warning' },
  { byte: 1, bit: 5, id: 'discharge_overtemperature' },
  { byte: 1, bit: 6, id: 'discharge_undertemperature', severity: 'warning' },
  { byte: 1, bit: 7, id: 'discharge_undertemperature' },
  { byte: 3, bit: 0, id: 'cell_voltage_difference', severity: 'warning' },
  { byte: 3, bit: 1, id: 'cell_voltage_difference', severity: 'protection' },
  { byte: 3, bit: 2, id: 'temperature_difference', severity: 'warning' },
  { byte: 3, bit: 3, id: 'temperature_difference', severity: 'protection' },
  { byte: 5, bit: 0, id: 'afe_fault' },
  { byte: 5, bit: 1, id: 'cell_wire_open' },
  { byte: 5, bit: 2, id: 'temperature_sensor_fault' },
  { byte: 5, bit: 3, id: 'eeprom_fault' },
  { byte: 5, bit: 7, id: 'communication_fault' },
];

const UNKNOWN_FAULT = msg('Undocumented fault bit');

/**
 * Register and bit of a classic byte / bit on the wire. Each fault register holds two classic
 * bytes, high byte first, so the wire carries classic bytes 1 0 3 2 5 4 7 6 (spec 9.2).
 * @param {number} byte classic byte 0..7
 * @param {number} bit 0..7
 */
export function faultSource(byte, bit) {
  const wire = byte ^ 1;
  const register = REG.FAULTS + (wire >> 1);
  const registerBit = bit + (wire % 2 === 0 ? 8 : 0);
  return { register, bit: registerBit, text: `bit ${registerBit} of 0x${register.toString(16).toUpperCase().padStart(4, '0')}` };
}

/**
 * Active alarms from the fault registers 0x003A..0x003D. Mapped bits become catalog alarms (one
 * per id, the most severe); every other set bit is reported with its raw source only (spec 9.2).
 * Classic byte 7 (high byte of 0x003D) is skipped: it holds a numeric fault code, not flags
 * (classic CAN notes in daly.md 9.1; undescribed on D2), reported as `faultCode` by parseStatus.
 * @param {number[]} registers four registers from 0x003A
 * @returns {AlarmState[]}
 */
export function faultAlarms(registers) {
  /** @type {Map<string, AlarmState>} */
  const best = new Map();
  const rank = (/** @type {AlarmState} */ a) => /** @type {Record<string, number>} */ (SEVERITY_ORDER)[a.severity ?? 'warning'] ?? 9;
  /** @type {AlarmState[]} */
  const unknown = [];
  for (let byte = 0; byte < 7; byte++) {
    const wire = byte ^ 1;
    const reg = registers[wire >> 1] ?? 0;
    const value = wire % 2 === 0 ? reg >> 8 : reg & 0xff;
    for (let bit = 0; bit < 8; bit++) {
      if (((value >> bit) & 1) === 0) continue;
      const src = faultSource(byte, bit);
      const def = FAULT_BITS.find((d) => d.byte === byte && d.bit === bit);
      if (!def) {
        const id = `daly.fault_${src.register.toString(16).toUpperCase().padStart(4, '0')}_bit${src.bit}`;
        unknown.push(alarm(id, { label: UNKNOWN_FAULT, severity: 'warning', source: src.text }));
        continue;
      }
      const a = alarm(def.id, { severity: def.severity, source: src.text });
      const prev = best.get(def.id);
      if (!prev || rank(a) < rank(prev)) best.set(def.id, a);
    }
  }
  return [...best.values(), ...unknown];
}

// ---------------------------------------------------------------------------------------------
// Protocol log
// ---------------------------------------------------------------------------------------------

/** Names of the read blocks for the protocol log (English, not translated). */
const BLOCK_NAMES = new Map([
  [BLOCK.STATUS.start, 'status'],
  [BLOCK.BALANCE.start, 'balance block'],
  [BLOCK.SETTINGS.start, 'settings'],
  [BLOCK.VERSION.start, 'version'],
  [BLOCK.PASSWORD.start, 'password'],
  [BLOCK.SWITCH.start, 'switch block'],
  [REG.SWITCH, 'balancer switch'],
]);

/** Names of the written registers. */
const REGISTER_NAMES = new Map([
  [REG.SWITCH, 'balancer switch'],
  [REG.START_VOLTAGE, 'balance start voltage'],
  [REG.TRIGGER_DELTA, 'balance start difference'],
  [REG.SLEEP, 'sleep time'],
  [REG.BATTERY_TYPE, 'battery type'],
  [0x00d4, 'clock'],
]);

/** @param {number} v */
const h4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * Name and lazy decoder of a frame for the protocol log. Read replies are decoded with the start
 * register of the request in flight when the reply arrived (captured here, not at decode time).
 * @param {Uint8Array} frame
 * @param {{ direction?: 'tx'|'rx', start?: number }} [ctx]
 * @returns {{ name: string, decode: () => any } | null}
 */
export function describe(frame, { direction = 'rx', start } = {}) {
  if (frame.length < 5 || frame[0] !== D2_ADDRESS) return null;
  const fn = frame[1];
  if (direction === 'tx') {
    if (fn === FN.READ) {
      const s = u16be(frame, 2);
      return { name: `Read ${BLOCK_NAMES.get(s) ?? `registers from ${h4(s)}`} (${u16be(frame, 4)})`, decode: () => parseRequest(frame) };
    }
    if (fn === FN.WRITE || fn === FN.WRITE_MULTI) {
      const reg = u16be(frame, 2);
      return { name: `Write ${REGISTER_NAMES.get(reg) ?? h4(reg)}`, decode: () => parseRequest(frame) };
    }
    return { name: 'Request', decode: () => parseRequest(frame) };
  }
  if (fn === FN.READ) {
    const known = start === undefined ? undefined : BLOCK_NAMES.get(start) ?? `registers from ${h4(start)}`;
    return { name: known ? `Reply: ${known}` : 'Read reply', decode: () => (start === undefined ? parseResponse(frame) : decodeReply(frame, start)) };
  }
  if (fn === FN.WRITE) return { name: `Write echo: ${REGISTER_NAMES.get(u16be(frame, 2)) ?? h4(u16be(frame, 2))}`, decode: () => parseResponse(frame) };
  if (fn & 0x80) return { name: 'Exception reply', decode: () => parseResponse(frame) };
  return { name: 'Reply', decode: () => parseResponse(frame) };
}
