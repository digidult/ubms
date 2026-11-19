import { FrameAssembler, sum8, u16be, i16be, setU16be } from '@ubms/transport';
import { r } from '../common/util.js';
import { DATA_FRAME_LENGTH, FRAME_TYPE, cellStatistics, parseDeviceInfo, softwareMajor } from './protocol.js';

/**
 * JK (Jikong) active balancers without MOSFETs and current shunt, pure functions without I/O.
 * Specification: docs/protocols/jk-balancer.md ("spec" below).
 *
 * - JK04 over Bluetooth (JK-B2A16S, JK-B2A24S, JK-B5A24S): frames, parsers and encoders are the
 *   ones of protocol.js (spec 3.1, 6.1 to 6.4). This file only adds what tells a balancer apart
 *   (spec 11.1) and the current rating of a model (spec 7.5).
 * - The RS485 port of the JK-DZ11-B2A24S (spec 2.2, 3.2 to 3.4, 6.5, 6.6): 7 byte requests
 *   `55 AA <address> <command> <value u16> <sum8>` and 74 byte answers
 *   `EB 90 <address> <command> <69 data bytes> <sum8>`, all big endian. It is not Modbus.
 *
 * The JK-BD models are BMSes with MOSFETs that speak JK02 (spec 1.2); they are handled by the
 * `jk-ble` and `jk-uart` drivers, not here.
 *
 * Parsers return plain objects whose field names match the test vectors
 * (packages/bms-drivers/test/vectors/jk-balancer.json). Values are engineering units (V, A,
 * degrees C).
 */

/** Protocol variants (labels of the test vectors). */
export const BAL_VARIANT = Object.freeze({ JK04: 'JK04', RS485: 'JK_BALANCER_RS485' });

/** Request header (host to balancer), spec 3.2. */
export const BAL_REQUEST_HEADER = Object.freeze([0x55, 0xaa]);
/** Answer header (balancer to host), spec 3.3. */
export const BAL_ANSWER_HEADER = Object.freeze([0xeb, 0x90]);
export const BAL_REQUEST_LENGTH = 7;
/** Every answer has 74 bytes, there is no length field (spec 3.3). */
export const BAL_ANSWER_LENGTH = 74;

/** Commands (spec 3.2, 5.3). */
export const BAL_CMD = Object.freeze({ STATUS: 0xff, CELL_COUNT: 0xf0, TRIGGER: 0xf2, MAX_CURRENT: 0xf4, SWITCH: 0xf6 });

/** Address 1 is the factory default (spec 2.2); 1 to 15 settable in the JK app (unverified). */
export const BAL_DEFAULT_ADDRESS = 1;
export const BAL_MAX_ADDRESS = 15;

/** Voltage slots of the status answer (spec 6.5). */
export const BAL_MAX_CELLS = 24;

/**
 * A partial answer is dropped after this silence. [SY] uses 100 ms; a browser delivers serial
 * chunks less regularly, and the balancer answers within 1 s (spec 2.2, 3.4 step 1).
 */
const STALE_MS = 300;

/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

/** @param {number} v */
const z = (v) => (v === 0 ? 0 : v);

// ---------------------------------------------------------------------------------------------
// RS485 requests
// ---------------------------------------------------------------------------------------------

/**
 * Request frame (spec 3.2): 55 AA, address, command, value u16 BE, sum8 of bytes 0..5.
 * @param {number} address 0..255
 * @param {number} command BAL_CMD value
 * @param {number} [value] raw u16 (mV, mA, cell count, 0/1); 0 for the status request
 */
export function encodeBalancerRequest(address, command, value = 0) {
  if (!Number.isInteger(address) || address < 0 || address > 0xff) throw new RangeError(`Invalid balancer address ${address}`);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`Value ${value} does not fit into 2 bytes`);
  const f = new Uint8Array(BAL_REQUEST_LENGTH);
  f.set(BAL_REQUEST_HEADER, 0);
  f[2] = address;
  f[3] = command;
  setU16be(f, 4, value);
  f[6] = sum8(f, 0, 6);
  return f;
}

/** Status request (spec 5.3); it only reads. @param {number} [address] */
export const balancerStatusRequest = (address = BAL_DEFAULT_ADDRESS) => encodeBalancerRequest(address, BAL_CMD.STATUS, 0);

/** @param {Uint8Array} f */
export const isBalancerRequest = (f) => f.length === BAL_REQUEST_LENGTH && f[0] === 0x55 && f[1] === 0xaa && sum8(f, 0, 6) === f[6];

/**
 * Parse a request frame (simulator, protocol log, tests).
 * @param {Uint8Array} frame 7 bytes
 */
export function parseBalancerRequest(frame) {
  return { address: frame[2], function: frame[3], value: u16be(frame, 4), checksum: frame[6], checksumValid: sum8(frame, 0, 6) === frame[6] };
}

// ---------------------------------------------------------------------------------------------
// RS485 answers
// ---------------------------------------------------------------------------------------------

/** 74 bytes, EB 90 and sum8 of bytes 0..72 (spec 3.3). @param {Uint8Array} f */
export const isBalancerAnswer = (f) => f.length === BAL_ANSWER_LENGTH && f[0] === 0xeb && f[1] === 0x90 && sum8(f, 0, 73) === f[73];

/**
 * Status answer to 0xFF (spec 6.5). Cell voltages: the configured count (byte 22, at most 24) as
 * [SY] does. Temperature: 0.1 degrees C as the captured unit sends it (the vendor documents say
 * 1 degree C, spec 12 item 4); a value outside -40..100 degrees C is reported as null.
 * Statistics (`cellVoltageMin` ... `cellVoltageDeltaDerived`) come from the cells, because the
 * index and delta bytes do not always match them (spec 12 item 2).
 * @param {Uint8Array} frame validated 74 byte answer
 * @returns {Record<string, any>}
 */
export function parseBalancerStatus(frame) {
  const cellCount = frame[22];
  const cellVoltages = Array.from({ length: Math.min(cellCount, BAL_MAX_CELLS) }, (_, i) => r(u16be(frame, 23 + 2 * i) * 0.001, 3));
  const temperatureRaw = i16be(frame, 71);
  const t = r(temperatureRaw * 0.1, 1);
  return {
    address: frame[2],
    function: frame[3],
    totalVoltage: r(u16be(frame, 4) * 0.01, 2),
    cellVoltageAverage: r(u16be(frame, 6) * 0.001, 3),
    cellCountDetected: frame[8],
    cellVoltageMaxIndex: frame[9],
    cellVoltageMinIndex: frame[10],
    balanceStatus: frame[11],
    alarmBitmask: frame[12],
    cellVoltageDelta: r(u16be(frame, 13) * 0.001, 3),
    balanceCurrent: r(u16be(frame, 15) * 0.001, 3),
    balanceTriggerVoltage: r(u16be(frame, 17) * 0.001, 3),
    maxBalanceCurrent: r(u16be(frame, 19) * 0.001, 3),
    balancerSwitch: frame[21] !== 0,
    cellCount,
    cellVoltages,
    temperatureRaw,
    temperature: t >= -40 && t <= 100 ? z(t) : null,
    ...cellStatistics(cellVoltages),
    checksumValid: sum8(frame, 0, 73) === frame[73],
  };
}

/**
 * Answer to a write (spec 6.6): the value in effect, which equals the request when the balancer
 * accepted it and is the old value otherwise.
 * @param {Uint8Array} frame validated 74 byte answer
 */
export function parseBalancerWriteAnswer(frame) {
  return { address: frame[2], function: frame[3], value: u16be(frame, 4), checksumValid: sum8(frame, 0, 73) === frame[73] };
}

/**
 * Why a status answer cannot be used, or null (spec 11.2 step 2, 3.4 step 3: sum8 is weak).
 * Always: the configured cell count 2..24, at most 24 detected cells, no cell above 5 V (the
 * acquisition range is 1 to 5 V). `strict` (the probe) also requires the total within 0.1 V of
 * the cell sum and the average within 0.01 V of the mean. Polling does not, so a fault stays
 * visible instead of hiding all data. Neither rejects a cell below 1 V: a disconnected sense wire
 * or a configured cell count above the wired cells reads near 0 V, and the balancer must stay
 * reachable on a new connection to show that and to correct the cell count.
 * @param {Record<string, any>} st parsed status
 * @param {{ strict?: boolean }} [opts]
 * @returns {string | null}
 */
export function balancerStatusProblem(st, { strict = false } = {}) {
  if (st.function !== BAL_CMD.STATUS) return `command ${h2(st.function)}`;
  if (!(st.cellCount >= 2 && st.cellCount <= BAL_MAX_CELLS)) return `cell count ${st.cellCount}`;
  if (!(st.cellCountDetected <= BAL_MAX_CELLS)) return `detected cell count ${st.cellCountDetected}`;
  const cells = /** @type {number[]} */ (st.cellVoltages);
  if (cells.some((v) => v > 5)) return 'cell voltage above 5 V';
  if (!strict) return null;
  const sum = cells.reduce((a, b) => a + b, 0);
  if (Math.abs(st.totalVoltage - sum) > 0.1 + 1e-9) return `total voltage ${st.totalVoltage} V, cell sum ${r(sum, 3)} V`;
  if (Math.abs(st.cellVoltageAverage - sum / cells.length) > 0.01 + 1e-9) return `average ${st.cellVoltageAverage} V`;
  return null;
}

/**
 * Host side assembler: 74 byte answers that start with EB 90; an adapter echo of the request and
 * other bytes are discarded. A frame that fails the checksum drops one byte only.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createBalancerAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [BAL_ANSWER_HEADER],
    length: () => BAL_ANSWER_LENGTH,
    validate: isBalancerAnswer,
    onFrame,
    onDiscard,
    maxLength: BAL_ANSWER_LENGTH,
    staleMs: STALE_MS,
  });
}

/**
 * Device side assembler (simulator): 7 byte requests.
 * @param {{ onFrame: (frame: Uint8Array) => void, onDiscard?: (bytes: Uint8Array, reason: string) => void }} handlers
 */
export function createBalancerRequestAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({ sync: [BAL_REQUEST_HEADER], length: () => BAL_REQUEST_LENGTH, validate: isBalancerRequest, onFrame, onDiscard, maxLength: BAL_REQUEST_LENGTH });
}

// ---------------------------------------------------------------------------------------------
// RS485 encoders (simulator, tests)
// ---------------------------------------------------------------------------------------------

/** @param {number} v */
const u16 = (v) => Math.max(0, Math.min(0xffff, Math.round(v)));

/**
 * 74 byte answer with the header, address, command and sum8; `fill` writes bytes 4..72.
 * @param {number} address
 * @param {number} command
 * @param {(f: Uint8Array) => void} fill
 */
function encodeAnswer(address, command, fill) {
  const f = new Uint8Array(BAL_ANSWER_LENGTH);
  f.set(BAL_ANSWER_HEADER, 0);
  f[2] = address;
  f[3] = command;
  fill(f);
  f[73] = sum8(f, 0, 73);
  return f;
}

/**
 * Encode a status answer from parser field names (engineering units).
 * @param {Record<string, any>} st
 */
export function encodeBalancerStatus(st) {
  return encodeAnswer(st.address ?? BAL_DEFAULT_ADDRESS, BAL_CMD.STATUS, (f) => {
    const cells = /** @type {number[]} */ (st.cellVoltages ?? []);
    setU16be(f, 4, u16((st.totalVoltage ?? 0) * 100));
    setU16be(f, 6, u16((st.cellVoltageAverage ?? 0) * 1000));
    f[8] = st.cellCountDetected ?? cells.length;
    f[9] = st.cellVoltageMaxIndex ?? 0;
    f[10] = st.cellVoltageMinIndex ?? 0;
    f[11] = st.balanceStatus ?? 0;
    f[12] = st.alarmBitmask ?? 0;
    setU16be(f, 13, u16((st.cellVoltageDelta ?? 0) * 1000));
    setU16be(f, 15, u16((st.balanceCurrent ?? 0) * 1000));
    setU16be(f, 17, u16((st.balanceTriggerVoltage ?? 0) * 1000));
    setU16be(f, 19, u16((st.maxBalanceCurrent ?? 0) * 1000));
    f[21] = st.balancerSwitch ? 1 : 0;
    f[22] = st.cellCount ?? cells.length;
    for (let i = 0; i < Math.min(cells.length, BAL_MAX_CELLS); i++) setU16be(f, 23 + 2 * i, u16(cells[i] * 1000));
    setU16be(f, 71, Math.max(-32768, Math.min(32767, Math.round(st.temperatureRaw ?? 0))) & 0xffff);
  });
}

/**
 * Encode a write answer: the value in effect in bytes 4..5, 67 reserved zero bytes (spec 6.6).
 * @param {number} address
 * @param {number} command
 * @param {number} value raw u16
 */
export const encodeBalancerWriteAnswer = (address, command, value) => encodeAnswer(address, command, (f) => setU16be(f, 4, u16(value)));

// ---------------------------------------------------------------------------------------------
// Protocol log
// ---------------------------------------------------------------------------------------------

const COMMAND_NAMES = /** @type {Record<number, string>} */ ({
  [BAL_CMD.CELL_COUNT]: 'cell count',
  [BAL_CMD.TRIGGER]: 'balance trigger voltage',
  [BAL_CMD.MAX_CURRENT]: 'maximum balance current',
  [BAL_CMD.SWITCH]: 'balancer switch',
});

/**
 * Name and lazy decoder of a balancer RS485 frame for the protocol log.
 * @param {Uint8Array} frame
 * @returns {{ name: string, decode?: () => any } | null}
 */
export function describeBalancer(frame) {
  if (!frame) return null;
  const what = COMMAND_NAMES[frame[3]] ?? h2(frame[3]);
  if (frame.length === BAL_REQUEST_LENGTH && frame[0] === 0x55 && frame[1] === 0xaa) {
    const name = frame[3] === BAL_CMD.STATUS ? `Balancer status request (${h2(frame[3])})` : `Balancer write ${what} (${h2(frame[3])})`;
    return { name, decode: () => parseBalancerRequest(frame) };
  }
  if (frame.length === BAL_ANSWER_LENGTH && frame[0] === 0xeb && frame[1] === 0x90) {
    if (frame[3] === BAL_CMD.STATUS) return { name: `Balancer status (${h2(frame[3])})`, decode: () => parseBalancerStatus(frame) };
    return { name: `Balancer write answer ${what} (${h2(frame[3])})`, decode: () => parseBalancerWriteAnswer(frame) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// JK04 balancers over Bluetooth (spec 6.3, 7.5, 10, 11.1)
// ---------------------------------------------------------------------------------------------

/**
 * Model string of a JK04 balancer: without the current suffix that every JK BMS model has
 * ("JK-B2A24S" against "JK-B2A24S15P", spec 11.1 step 3, [BM] jk04.py).
 */
export const JK04_BALANCER_MODEL = /^JK[-_]B\d+A\d+S$/i;

/**
 * True when bytes 66..298 of a device info frame are all 0: JK04 balancers fill only bytes 6..65
 * (spec 6.3), JK02_24S BMSes also carry date, serial number and passcodes there.
 * @param {Uint8Array} frame 300 byte device info frame
 */
export function deviceInfoTailEmpty(frame) {
  for (let i = 66; i < DATA_FRAME_LENGTH - 1; i++) if (frame[i] !== 0) return false;
  return true;
}

/**
 * Device info of a JK04 balancer candidate (spec 11.1): software major below 11 (JK02_32S BMSes,
 * and possibly the 2024 balancers, report 11 and later) with a balancer model string or the empty
 * tail of bytes 66..298. The cell info frame confirms it (`looksLikeJk04CellInfo`, spec 11.1 step 4).
 * @param {Uint8Array} frame
 */
export function looksLikeJk04BalancerInfo(frame) {
  if (frame.length !== DATA_FRAME_LENGTH || frame[4] !== FRAME_TYPE.DEVICE_INFO) return false;
  const d = parseDeviceInfo(frame);
  if (softwareMajor(d.softwareVersion) >= 11) return false;
  return JK04_BALANCER_MODEL.test(String(d.model ?? '').trim()) || deviceInfoTailEmpty(frame);
}

/**
 * Balance current rating in A: the number after "B" in the model name (JK-B1A24S 1 A, JK-B2A24S
 * 2 A per the manual V4.1; JK-B5A24S 5 A by its name, unverified; spec 7.5). Undefined when the
 * model does not tell.
 * @param {string} [model]
 */
export function balancerRating(model) {
  const m = /^JK[-_]B(\d+)A\d+S/i.exec(String(model ?? '').trim());
  const a = m ? Number(m[1]) : NaN;
  return a >= 1 && a <= 10 ? a : undefined;
}
