import { FrameAssembler } from '@ubms/transport';
import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import {
  ASCII_VER,
  CID1,
  PARAM_BLOCK_SIZE,
  PARAM_BYTE_COUNT,
  PARAM_INT_COUNT,
  PARAM_SWITCH_COUNT,
  createAsciiAssembler,
  createBleAssembler,
  encodeAscii,
  encodeBleAnswer,
  isAsciiAnswer,
  parseAscii,
  parseBleFrame,
  parseParamBlock,
  setBlockParam,
  tempToRaw,
} from './protocol-v2.js';
import { FN, parseRequest, requestLength, withCrc } from './protocol-v3.js';

/**
 * Device side of the three Seplos protocols for the demo mode and the tests. Each simulator
 * answers like the device (docs/protocols/seplos.md): the V2 ASCII pack on RS485, the V2 Bluetooth
 * module and the BMS 3.0 Modbus server with its firmware rules (block limits, exceptions, two
 * register writes saved, MOSFET commands, calendar only with history recording).
 */

/** Threshold defaults of the V2 parameter block (values as captured from a 1101-SP76, spec 6.1.3). */
const V2_DEFAULTS = {
  cellHighAlarm: 3.64,
  cellHighAlarmRecovery: 3.5,
  cellLowAlarm: 2.6,
  cellLowAlarmRecovery: 2.7,
  cellOvp: 3.65,
  cellOvpRecovery: 3.59,
  cellUvp: 2.5,
  cellUvpRecovery: 2.65,
  balanceStartVoltage: 3.4,
  lowVoltageChargeForbid: 1.5,
  packHighAlarm: 57,
  packHighAlarmRecovery: 54.5,
  packLowAlarm: 42,
  packLowAlarmRecovery: 44,
  packOvp: 58.4,
  packOvpRecovery: 55,
  packUvp: 40.1,
  packUvpRecovery: 41,
  chargeOvp: 60,
  chargeOvpRecovery: 59,
  chargeHighTempAlarm: 50,
  chargeHighTempAlarmRecovery: 47,
  chargeLowTempAlarm: 2,
  chargeLowTempAlarmRecovery: 5,
  chargeOtp: 55,
  chargeOtpRecovery: 50,
  chargeUtp: -10,
  chargeUtpRecovery: 0,
  dischargeHighTempAlarm: 52,
  dischargeHighTempAlarmRecovery: 47,
  dischargeLowTempAlarm: -10,
  dischargeLowTempAlarmRecovery: 3,
  dischargeOtp: 55,
  dischargeOtpRecovery: 50,
  dischargeUtp: -15,
  dischargeUtpRecovery: 0,
  heatingStart: 0,
  heatingStop: 10,
  ambientHighAlarm: 50,
  ambientHighAlarmRecovery: 47,
  ambientLowAlarm: 0,
  ambientLowAlarmRecovery: 3,
  ambientOtp: 60,
  ambientOtpRecovery: 55,
  ambientUtp: -10,
  ambientUtpRecovery: 0,
  powerHighAlarm: 90,
  powerHighAlarmRecovery: 85,
  powerOtp: 100,
  powerOtpRecovery: 85,
  chargeOcAlarm: 200,
  chargeOcAlarmRecovery: 195,
  dischargeOcAlarm: -205,
  dischargeOcAlarmRecovery: -203,
  chargeOcp: 210,
  dischargeOcp: -210,
  transientOcp: -300,
  softStartDelayMs: 2000,
  ratedCapacityAh: 302,
  remainingCapacityAh: 200,
  cellFailureDiff: 0.5,
  cellFailureDiffRecovery: 0.3,
  balanceStartDiff: 0.011,
  balanceStopDiff: 0.01,
  staticBalanceHours: 10,
  cellCount: 16,
  chargeOcDelayS: 10,
  dischargeOcDelayS: 10,
  transientOcDelayMs: 30,
  ocRecoveryDelayS: 60,
  ocRecoveryTimes: 5,
  chargeCurrentLimitDelayMin: 5,
  chargeActivationDelayMin: 1,
  chargeActivationIntervalH: 10,
  chargeActivationTimes: 10,
  workRecordIntervalMin: 30,
  standbyRecordIntervalMin: 240,
  standbyShutdownDelayH: 48,
  socAlarmPercent: 15,
  socProtectPercent: 5,
  intermittentChargeSocPercent: 96,
  cycleCapacityPercent: 80,
  connectionFaultMilliohm: 10,
  comp1Cell: 9,
  comp1Milliohm: 0,
  comp2Cell: 13,
  comp2Milliohm: 0,
};

/**
 * A standard 169 byte parameter block (60 / 27 / 8) with the default thresholds.
 * @param {string} model 10 characters
 */
export function defaultParamBlock(model = '1101-SP76 ') {
  let b = new Uint8Array(PARAM_BLOCK_SIZE);
  b[0] = 0x00;
  b[1] = PARAM_INT_COUNT;
  b[2 + 2 * PARAM_INT_COUNT] = PARAM_BYTE_COUNT;
  b[123 + PARAM_BYTE_COUNT] = PARAM_SWITCH_COUNT;
  b.set([0xff, 0xff, 0xff, 0x3f, 0xbf, 0x9f, 0xaf, 0x1e], 151);
  for (let i = 0; i < 10; i++) b[159 + i] = (model.charCodeAt(i) || 0x20) & 0xff;
  for (const [key, value] of Object.entries(V2_DEFAULTS)) b = setBlockParam(b, key, value);
  return b;
}

/** @param {number} v */
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
/** @param {number} v */
const s16 = (v) => u16(Math.round(v) & 0xffff);
/** @param {string} s @param {number} n padding with spaces */
const text = (s, n, pad = 0x20) => Array.from({ length: n }, (_, i) => (i < s.length ? s.charCodeAt(i) & 0xff : pad));

/**
 * Live values shared by the V2 answers.
 * @param {SimBattery} bat
 */
function v2Live(bat) {
  const cells = bat.cellVoltages();
  const temps = [...bat.temps, bat.ambient, bat.mosTemp];
  const voltage = cells.reduce((a, b) => a + b, 0);
  const balance = [0, 0];
  bat.balancing.forEach((on, i) => {
    if (on && i < 16) balance[i >> 3] |= 1 << (i & 7);
  });
  const sw = (bat.switches.discharge ? 1 : 0) | (bat.switches.charge ? 2 : 0) | (bat.switches.heater ? 8 : 0);
  const system = bat.current > 0.15 ? 0x02 : bat.current < -0.15 ? 0x01 : 0x10;
  return { cells, temps, voltage, balance, sw, system };
}

/** @param {SimBattery} bat */
function v2Events(bat) {
  const events = [0, 0, 0, 0, 0, 0, 0, 0];
  const cells = bat.cellVoltages();
  if (Math.max(...cells) > 3.64) events[1] |= 0x01;
  if (Math.min(...cells) < 2.6) events[1] |= 0x04;
  if (bat.soc < 15) events[5] |= 0x04;
  return events;
}

/** @param {import('@ubms/transport').Link} link @param {SimBattery} bat @param {number} tickMs */
function attachBattery(link, bat, tickMs) {
  return tickMs > 0 ? every(() => bat.step(tickMs / 1000), tickMs) : () => {};
}

// ---------------------------------------------------------------------------------------------
// V2 ASCII pack on RS485
// ---------------------------------------------------------------------------------------------

/**
 * @param {import('@ubms/transport').Link} link device side of a link pair
 * @param {Object} [opts]
 * @param {number} [opts.address] DIP address of the pack
 * @param {number} [opts.ver] VER of the answers (0x26 imitates a Boqiang pack)
 * @param {number} [opts.tickMs] simulation step, 0 for none (tests)
 * @param {SimBattery} [opts.battery]
 * @param {string} [opts.model]
 * @param {number} [opts.customCount] P of the 0x42 answer (10; Pylontech sends 2 or 4)
 * @param {boolean} [opts.checkGroup] refuse 0x42 and 0x44 whose COMMAND_GROUP is not the address
 *   ([V2PDF] 4.1.1 and 4.2.1 for RS485); false imitates firmware that does not check it
 */
export function createSeplosV2Simulator(link, { address = 0, ver = ASCII_VER, tickMs = 1000, battery, model = '1101-SP76 ', customCount = 10, checkGroup = true } = {}) {
  const bat = battery ?? new SimBattery({ cells: 16, capacityAh: 302, tempSensors: 4, soc: 72, seed: 11, maxCurrent: 60 });
  let block = defaultParamBlock(model);
  const state = { /** @type {Array<{ adr: number, cid2: number, info: Uint8Array }>} */ received: [], writes: 0 };
  /** Alarm bytes forced by a test or the demo: 8 event bytes and the per cell codes. */
  const overrides = { /** @type {number[] | null} */ events: null, /** @type {number[] | null} */ cellAlarms: null };

  /** @param {number} group */
  const telemetry = (group) => {
    const l = v2Live(bat);
    const out = [0x00, group, l.cells.length];
    for (const v of l.cells) out.push(...u16(Math.round(v * 1000)));
    out.push(l.temps.length);
    for (const t of l.temps) out.push(...u16(tempToRaw(Math.round(t * 10) / 10)));
    out.push(...s16(bat.current * 100), ...u16(Math.round(l.voltage * 100)), ...u16(Math.round(bat.remainingAh * 100)));
    const custom = [Math.round(bat.capacityAh * 100), Math.round(bat.soc * 10), Math.round(bat.capacityAh * 100), bat.cycles, 1000, Math.round(l.voltage * 100), 0, 0, 0, 0];
    out.push(customCount);
    for (const c of custom.slice(0, customCount)) out.push(...u16(c));
    return out;
  };

  /** @param {number} group */
  const alarms = (group) => {
    const l = v2Live(bat);
    const ev = overrides.events ?? v2Events(bat);
    return [0x00, group, l.cells.length, ...l.cells.map((_, i) => overrides.cellAlarms?.[i] ?? 0), l.temps.length, ...l.temps.map(() => 0), 0, 0, 20, ev[0], ev[1], ev[2], ev[3], ev[4], ev[5], l.sw, l.balance[0], l.balance[1], l.system, 0, 0, ev[6], ev[7], 0, 0, 0, 0, 0, 0];
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    const f = parseAscii(frame);
    if (!f || isAsciiAnswer(f)) return;
    state.received.push({ adr: f.adr, cid2: f.cid2, info: f.info });
    if (f.adr !== address) return; // another pack on the bus
    /** @param {number} rtn @param {ArrayLike<number>} [info] */
    const reply = (rtn, info = []) => void link.write(encodeAscii({ ver, adr: address, cid2: rtn, info })).catch(() => {});
    if (f.ver !== ASCII_VER) return reply(0x01);
    if (f.cid1 !== CID1) return reply(0xe1);
    // On RS485 the pack checks that COMMAND_GROUP matches its DIP address ([V2PDF] 4.1.1, 4.2.1).
    // The document does not say how it refuses a mismatch; RTN 0x05 (command format error) is
    // this simulator's choice (**unverified**).
    if (checkGroup && (f.cid2 === 0x42 || f.cid2 === 0x44) && f.info[0] !== address) return reply(0x05);
    switch (f.cid2) {
      case 0x4f:
        return reply(0x00);
      case 0x51:
        return reply(0x00, [...text(model, 10), 16, 4, ...text('CAN:Victron', 20)]);
      case 0x42:
        return reply(0x00, telemetry(f.info[0] ?? address));
      case 0x44:
        return reply(0x00, alarms(f.info[0] ?? address));
      case 0x47:
        block = setBlockParam(block, 'remainingCapacityAh', Math.round(bat.remainingAh * 100) / 100);
        return reply(0x00, block);
      case 0xa1: {
        const p = parseParamBlock(f.info);
        if (!p.standard) return reply(0x06);
        applyV2Block(bat, block, f.info);
        block = Uint8Array.from(f.info);
        state.writes++;
        return reply(0x00);
      }
      default:
        return reply(0x04);
    }
  };

  const asm = createAsciiAssembler({ onFrame: handle });
  const off = link.on('data', (/** @type {Uint8Array} */ c) => asm.push(c));
  const stopTick = attachBattery(link, bat, tickMs);
  return {
    battery: bat,
    state,
    overrides,
    get block() {
      return block;
    },
    stop() {
      off();
      stopTick();
    },
  };
}

/**
 * Effects of a written parameter block on the simulated pack: the balancer switch and a changed
 * remaining capacity.
 * @param {SimBattery} bat
 * @param {Uint8Array} before
 * @param {Uint8Array} after
 */
function applyV2Block(bat, before, after) {
  const a = parseParamBlock(before);
  const b = parseParamBlock(after);
  bat.switches.balance = (b.functionSwitches[6] & 1) === 1;
  if (Math.abs(b.params.remainingCapacityAh - a.params.remainingCapacityAh) > 0.005 && bat.capacityAh > 0) {
    bat.soc = Math.max(0, Math.min(100, (b.params.remainingCapacityAh / bat.capacityAh) * 100));
  }
}

// ---------------------------------------------------------------------------------------------
// V2 Bluetooth module
// ---------------------------------------------------------------------------------------------

/**
 * @param {import('@ubms/transport').Link} link
 * @param {Object} [opts]
 * @param {number} [opts.tickMs]
 * @param {SimBattery} [opts.battery]
 * @param {number} [opts.slaves] packs behind this master (0x51 byte 35, 0x62 answers)
 * @param {number} [opts.ver] VER of the answers (0x14 as captured)
 * @param {boolean} [opts.staleParams] answer the first 0x61 with the parameter block (spec 12)
 * @param {Uint8Array} [opts.paramBlock] the 0x47 block, for example one with another layout than
 *   60 / 27 / 8 (kept as given; only a standard block gets the live remaining capacity)
 */
export function createSeplosV2BleSimulator(link, { tickMs = 1000, battery, slaves = 0, ver = 0x14, staleParams = false, paramBlock } = {}) {
  const bat = battery ?? new SimBattery({ cells: 16, capacityAh: 302, tempSensors: 4, soc: 81, seed: 13, maxCurrent: 60 });
  let block = paramBlock ? Uint8Array.from(paramBlock) : defaultParamBlock('1101-SP76 ');
  let stale = staleParams;
  const state = { /** @type {number[]} */ received: [], writes: 0, /** @type {Uint8Array[]} */ writeData: [] };

  const single = () => {
    const l = v2Live(bat);
    const ev = v2Events(bat);
    const out = [0x00, 0x00, l.cells.length];
    for (const v of l.cells) out.push(...u16(Math.round(v * 1000)));
    out.push(l.temps.length);
    for (const t of l.temps) out.push(...u16(tempToRaw(Math.round(t * 10) / 10)));
    out.push(...s16(bat.current * 100), ...u16(Math.round(l.voltage * 100)), ...u16(Math.round(bat.remainingAh * 100)), 6);
    for (const c of [Math.round(bat.capacityAh * 100), Math.round(bat.soc * 10), Math.round(bat.capacityAh * 100), bat.cycles, 1000, Math.round(l.voltage * 100)]) out.push(...u16(c));
    out.push(...l.cells.map(() => 0), ...l.temps.map(() => 0), 0, 0, l.system, l.sw, 8, ...ev, l.balance[0], l.balance[1], 0, 0);
    return out;
  };

  const parallel = () => {
    const packs = slaves + 1;
    const l = v2Live(bat);
    if (slaves === 0) {
      // A pack without a bank answers zeros with P = 0 (`v2b-rx-62-extension`).
      return [0, 0, 16, 0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7, ...new Array(14).fill(0), 0, 0, 0];
    }
    const out = [0x00, 0x00, l.cells.length, ...u16(Math.round(Math.max(...l.cells) * 1000)), ...u16(Math.round(Math.min(...l.cells) * 1000)), l.temps.length];
    for (const t of [Math.max(...bat.temps), Math.min(...bat.temps), bat.ambient, bat.mosTemp]) out.push(...u16(tempToRaw(Math.round(t * 10) / 10)));
    out.push(...s16(bat.current * packs * 10), ...u16(Math.round(l.voltage * 100)), ...u16(Math.round(bat.remainingAh * packs * 10)), 7);
    for (const c of [Math.round(bat.capacityAh * packs * 10), Math.round(bat.soc * 10), Math.round(bat.capacityAh * packs * 10), bat.cycles, 1000, Math.round(l.voltage * 100)]) out.push(...u16(c));
    out.push((1 << packs) - 1, 0, l.system, l.sw, 8, ...v2Events(bat));
    return out;
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    const f = parseBleFrame(frame);
    if (!f || f.b3 !== CID1) return;
    state.received.push(f.b4);
    /** @param {number} cid @param {ArrayLike<number>} [data] @param {number} [rtn] */
    const reply = (cid, data = [], rtn = 0x00) => void link.write(encodeBleAnswer({ ver, cid, rtn, data })).catch(() => {});
    switch (f.b4) {
      case 0x51:
        return reply(0x51, [...text('CAN:Victron', 20), ...text('1101-SP76', 10), 16, 4, 3, 1, 0x46, slaves]);
      case 0x61:
        if (stale) {
          stale = false;
          return reply(0x61, block);
        }
        return reply(0x61, single());
      case 0x62:
        return reply(0x62, parallel());
      case 0x47:
        if (parseParamBlock(block).standard) block = setBlockParam(block, 'remainingCapacityAh', Math.round(bat.remainingAh * 100) / 100);
        return reply(0x47, block);
      case 0xa1: {
        state.writeData.push(f.data);
        const p = parseParamBlock(f.data);
        if (!p.standard) return reply(0xa1, [], 0xe2);
        applyV2Block(bat, block, f.data);
        block = Uint8Array.from(f.data);
        state.writes++;
        return reply(0xa1);
      }
      default:
        return reply(f.b4, [], 0x04);
    }
  };

  const asm = createBleAssembler({ onFrame: handle });
  const off = link.on('data', (/** @type {Uint8Array} */ c) => asm.push(c));
  const stopTick = attachBattery(link, bat, tickMs);
  return {
    battery: bat,
    state,
    get block() {
      return block;
    },
    stop() {
      off();
      stopTick();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// V3 Modbus server
// ---------------------------------------------------------------------------------------------

/** SPA defaults (registers 0x1300..0x1369 of a 16S pack, as captured from an SG16S200A board). */
const SPA_DEFAULTS = [
  4, 16, 5400, 5600, 5400, 5760, 4800, 4640, 4800, 4320, 3400, 3500, 3400, 3650, 3100, 2900, 3100, 2700, 2000, 1000, 500, 203, 205, 210, 100, 300, 300, 65333, 65331, 65326,
  100, 65186, 300, 65236, 106, 600, 5, 3000, 205, 10, 3500, 3400, 1500, 1000, 800, 200, 30, 3201, 3231, 3231, 3281, 2781, 2761, 2751, 2731, 3231, 3281, 3281, 3331, 2761,
  2731, 2741, 2701, 3201, 3231, 3281, 3331, 2761, 2731, 2731, 2631, 3581, 3681, 3581, 3831, 2831, 2731, 3231, 2731, 10, 3400, 50, 30, 960, 80, 50, 50, 30, 28000, 28000,
  13412, 48, 60, 240, 10, 7, 0, 13, 0, 500, 300, 5760, 180, 65356, 5, 8,
];

/** SFA defaults (80 coils, as captured from an SP05B board; history recording on). */
const SFA_DEFAULTS = [0xff, 0xff, 0x3f, 0x01, 0x7f, 0x2f, 0x9f, 0x0f, 0x63, 0x6f];

/** Register blocks of the simulated server: start, size. */
const REG_BLOCKS = { PIA: [0x1000, 18], PIB: [0x1100, 26], SPA: [0x1300, 106], CAL: [0x1500, 4], VIA: [0x1700, 51], PCT: [0x1800, 36], EIA: [0x2000, 26], EIB: [0x2100, 22] };
/** Coil blocks: start, coils. */
const COIL_BLOCKS = { PIC: [0x1200, 144], SFA: [0x1400, 80], EIC: [0x2200, 80] };

/** @param {string} s @param {number} words */
function textRegs(s, words) {
  const b = text(s, words * 2, 0);
  return Array.from({ length: words }, (_, i) => (b[2 * i] << 8) | b[2 * i + 1]);
}

/**
 * @param {import('@ubms/transport').Link} link
 * @param {Object} [opts]
 * @param {number} [opts.tickMs]
 * @param {SimBattery} [opts.battery]
 * @param {number[]} [opts.addresses] addresses served: 0, 1 and 0xE0 on the Bluetooth port; the
 *   link address on the pack link, 0xE0 on the PC port
 * @param {string} [opts.deviceName]
 * @param {string} [opts.manufacturer]
 * @param {string} [opts.bmsSerial]
 * @param {number} [opts.packs] packs in the bank (EIA)
 * @param {boolean} [opts.busyOnce] answer the next SPA write with exception 0x06 (busy, spec 7.3)
 */
export function createSeplosV3Simulator(
  link,
  {
    tickMs = 1000,
    battery,
    addresses = [0x00, 0x01, 0xe0],
    deviceName = 'BMS16S200A-SP05B',
    manufacturer = 'XZH-ElecTech Co.,Ltd',
    bmsSerial = 'SP05B2312190075',
    packs = 1,
    busyOnce = false,
  } = {},
) {
  const bat = battery ?? new SimBattery({ cells: 16, capacityAh: 280, tempSensors: 4, soc: 48, seed: 17, maxCurrent: 50 });
  const spa = Uint16Array.from(SPA_DEFAULTS);
  spa[0x58] = spa[0x59] = Math.round(bat.capacityAh * 100);
  const sfa = Uint8Array.from(SFA_DEFAULTS);
  const forced = { dischargeOff: false, chargeOff: false };
  const scale = /\d{1,2}S(\d{3})A/.exec(deviceName)?.[1] && Number(/\d{1,2}S(\d{3})A/.exec(deviceName)?.[1]) >= 300 ? 0.1 : 0.01;
  const state = {
    /** @type {Array<{ address: number, function: number, start: number, count: number, values?: Uint8Array }>} */
    received: [],
    restarts: 0,
    /** writes of two or more registers or coils, which firmware V1.43l saves to flash */
    saved: 0,
    unsaved: 0,
    /** @type {number[] | null} */
    clock: null,
    protocol: 5,
    /** requests refused for a bad CRC */
    badCrc: 0,
  };
  /**
   * Faults a test can set: SPA writes still to refuse with exception 0x06, EIA reads to drop, and
   * requests to treat as corrupted on the line (answered like a bad CRC).
   */
  const faults = { busyWrites: busyOnce ? 1 : 0, dropEia: 0, crcErrors: 0 };

  const syncSwitches = () => {
    bat.switches.discharge = !forced.dischargeOff;
    bat.switches.charge = !forced.chargeOff;
    bat.switches.balance = (sfa[7] & 1) === 1;
  };
  syncSwitches();

  /** @param {number} c */
  const k = (c) => tempToRaw(Math.round(c * 10) / 10);

  const pia = () => {
    const cells = bat.cellVoltages();
    const v = cells.reduce((a, b) => a + b, 0);
    spa[0x5a] = Math.min(spa[0x59], Math.round(bat.remainingAh * 100));
    return [
      Math.round(v * 100),
      Math.round(bat.current / scale) & 0xffff,
      spa[0x5a],
      spa[0x59],
      Math.round(bat.cycleAh / 10) & 0xffff,
      Math.round(bat.soc * 10),
      999,
      bat.cycles,
      Math.round((v / cells.length) * 1000),
      k(bat.temps.reduce((a, b) => a + b, 0) / bat.temps.length),
      Math.round(Math.max(...cells) * 1000),
      Math.round(Math.min(...cells) * 1000),
      k(Math.max(...bat.temps)),
      k(Math.min(...bat.temps)),
      0,
      180,
      180,
      1000,
    ];
  };

  const pib = () => {
    const cells = bat.cellVoltages().map((x) => Math.round(x * 1000));
    while (cells.length < 16) cells.push(0);
    const temps = bat.temps.map(k);
    while (temps.length < 4) temps.push(2731);
    return [...cells.slice(0, 16), ...temps.slice(0, 4), 2731, 2731, 2731, 2731, k(bat.ambient), k(bat.mosTemp)];
  };

  const eventBytes = () => {
    const system = bat.current > 0.15 ? 0x02 : bat.current < -0.15 ? 0x01 : 0x10;
    const fet = (bat.switches.discharge ? 1 : 0) | (bat.switches.charge ? 2 : 0) | (bat.switches.heater ? 8 : 0);
    const balance = bat.balancing.some(Boolean) ? 0x01 : 0x00;
    return [system, 0, 0, 0, 0, 0, bat.soc < 5 ? 0x04 : 0, fet, balance, 0];
  };

  const pic = () => {
    const bal = [0, 0];
    bat.balancing.forEach((on, i) => {
      if (on && i < 16) bal[i >> 3] |= 1 << (i & 7);
    });
    return [0, 0, 0, 0, 0, 0, bal[0], bal[1], ...eventBytes()];
  };

  /** @param {number} v */
  const u32 = (v) => [v & 0xffff, (v >>> 16) & 0xffff];

  const eia = () => {
    const p = pia();
    const cur = Math.round(bat.current * packs * 10) | 0;
    return [
      ...u32(p[0]),
      ...u32(cur >>> 0),
      ...u32(p[2] * packs),
      ...u32(p[3] * packs),
      ...u32(p[4]),
      ...u32(spa[0x58] * packs),
      ...u32((1 << packs) - 1),
      ...u32(0),
      ...u32(1800 * packs),
      ...u32(1800 * packs),
      576,
      464,
      packs,
      p[7],
      p[5],
      999,
    ];
  };

  const eib = () => {
    const cells = bat.cellVoltages();
    const c = (/** @type {number} */ t) => Math.round(t * 10) & 0xffff;
    const mx = Math.max(...bat.temps);
    const mn = Math.min(...bat.temps);
    const v = Math.round(cells.reduce((a, b) => a + b, 0) * 100);
    return [
      Math.round(Math.max(...cells) * 1000),
      Math.round(Math.min(...cells) * 1000),
      cells.indexOf(Math.max(...cells)),
      cells.indexOf(Math.min(...cells)),
      v,
      v,
      0,
      0,
      c(mx),
      c(mn),
      c((mx + mn) / 2),
      bat.temps.indexOf(mx),
      bat.temps.indexOf(mn),
      Math.round(bat.soc * 10),
      Math.round(bat.soc * 10),
      bat.cycles,
      999,
      c(bat.mosTemp),
      c(bat.mosTemp),
      c(bat.mosTemp),
      0,
      0,
    ];
  };

  const via = () => [...textRegs(manufacturer, 10), ...textRegs(deviceName, 10), ...textRegs('15', 1), ...textRegs(bmsSerial, 15), ...textRegs('', 15)];
  // Firmware V1.43l sends the protocol word low byte first (spec 6.3.5).
  const pct = () => [state.protocol << 8, 500, ...textRegs('MultiPlus-II 48/3000/35', 16), ...textRegs('Victron Can Protocol', 16), ...textRegs('10', 1), 0];

  const calendar = () => {
    const d = state.clock ?? (() => {
      const n = new Date();
      const y = n.getFullYear();
      return [y & 0xff, y >> 8, n.getMonth() + 1, n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds(), 0];
    })();
    return [0, 2, 4, 6].map((i) => (d[i] << 8) | d[i + 1]);
  };

  /** @type {Record<string, () => number[]>} */
  const regSource = { PIA: pia, PIB: pib, SPA: () => [...spa], CAL: calendar, VIA: via, PCT: pct, EIA: eia, EIB: eib };
  /** @type {Record<string, () => number[]>} */
  const coilSource = { PIC: pic, SFA: () => [...sfa], EIC: eventBytes };

  /** @param {number} address @param {number} fn @param {number} code */
  const exception = (address, fn, code) => withCrc([address, fn | 0x80, code]);

  /** SCA command registers this simulator acts on (spec 8.3); all take 0x55AA or 0xAA55. */
  const SCA_COMMANDS = new Set([0x1510, 0x1511, 0x1515, 0x1518]);

  /** @param {Uint8Array} frame */
  const answer = (frame) => {
    const r = parseRequest(frame);
    if (!r) return null;
    state.received.push({ address: r.address, function: r.function, start: r.start, count: r.count, values: r.values, crcValid: r.crcValid });
    const { address, start, count } = r;
    // Firmware V1.43l answers a request with a bad CRC with exception 0x03 ([SO]
    // `Rtu_SlaveRequestCheck`, spec 3.3, 12).
    const corrupted = faults.crcErrors > 0;
    if (corrupted) faults.crcErrors--;
    if (!r.crcValid || corrupted) {
      state.badCrc++;
      return exception(address, r.function, 0x03);
    }
    if (r.function === FN.READ_INPUT) {
      for (const [name, [s, n]] of Object.entries(REG_BLOCKS)) {
        if (start < s || start >= s + n) continue;
        if (count < 1 || start + count > s + n) return exception(address, r.function, 0x02);
        if (name === 'EIA' && faults.dropEia > 0) {
          faults.dropEia--;
          return null;
        }
        if (name === 'CAL' && !(sfa[6] & 0x10)) return exception(address, r.function, 0x01);
        const regs = regSource[name]().slice(start - s, start - s + count);
        const body = [address, FN.READ_INPUT, 2 * count];
        for (const v of regs) body.push(...u16(v));
        return withCrc(body);
      }
      return exception(address, r.function, 0x02);
    }
    if (r.function === FN.READ_COILS) {
      for (const [name, [s, n]] of Object.entries(COIL_BLOCKS)) {
        if (start < s || start >= s + n) continue;
        if ((start - s) % 8 !== 0 || count < 1 || start + count > s + n) return exception(address, r.function, 0x02);
        const bytes = coilSource[name]().slice((start - s) / 8, (start - s) / 8 + Math.ceil(count / 8));
        return withCrc([address, FN.READ_COILS, bytes.length, ...bytes]);
      }
      return exception(address, r.function, 0x02);
    }
    const values = /** @type {Uint8Array} */ (r.values);
    if (r.function === FN.WRITE_REGISTERS) {
      const words = Array.from({ length: count }, (_, i) => (values[2 * i] << 8) | values[2 * i + 1]);
      if (start >= 0x1300 && start + count <= 0x136a) {
        // Refused while the BMS processes its parameters ([SO] `Reg_WriteWords`, spec 7.3).
        if (faults.busyWrites > 0) {
          faults.busyWrites--;
          return exception(address, r.function, 0x06);
        }
        words.forEach((w, i) => (spa[start - 0x1300 + i] = w));
        spa[0x5a] = Math.min(spa[0x5a], spa[0x59]);
        if (start <= 0x135a && start + count > 0x135a && bat.capacityAh > 0) bat.soc = Math.min(100, (spa[0x5a] / 100 / bat.capacityAh) * 100);
        if (count > 1) state.saved++;
        else state.unsaved++;
      } else if (start === 0x1500 && count === 4) {
        if (!(sfa[6] & 0x10)) return exception(address, r.function, 0x01);
        state.clock = words.flatMap((w) => [w >> 8, w & 0xff]);
      } else if (SCA_COMMANDS.has(start)) {
        // [SO] `Reg_WriteWords`: one register only (else 0x02), 0x55AA or 0xAA55 (else 0x03).
        const w = words[0];
        if (count !== 1) return exception(address, r.function, 0x02);
        if (w !== 0x55aa && w !== 0xaa55) return exception(address, r.function, 0x03);
        if (start === 0x1510) forced.dischargeOff = w === 0x55aa;
        // 0x1511: 0x55AA sets the charge off bit, 0xAA55 clears it (and bit 7).
        else if (start === 0x1511) forced.chargeOff = w === 0x55aa;
        // 0x1515: 0xAA55 sets command bit 7 and clears the charge off bit, 0x55AA clears both; the
        // effect of bit 7 is not modelled (**unverified**, spec 8.3).
        else if (start === 0x1515) forced.chargeOff = false;
        else if (w === 0x55aa) state.restarts++;
        else return exception(address, r.function, 0x03);
      } else if (count === 1 && start === 0x1800) {
        state.protocol = words[0];
      } else {
        return exception(address, r.function, 0x02);
      }
      syncSwitches();
      return withCrc([address, FN.WRITE_REGISTERS, ...u16(start), ...u16(count)]);
    }
    if (r.function === FN.WRITE_COILS) {
      // Only the SFA block is writable; a multi-coil write keeps coil 0x142D (spec 7.4).
      if (start < 0x1400 || start + count > 0x1450 || (start - 0x1400) % 8 !== 0) return exception(address, r.function, 0x02);
      const keep = sfa[5] & 0x20;
      for (let i = 0; i < Math.ceil(count / 8); i++) sfa[(start - 0x1400) / 8 + i] = values[i];
      if (count > 1) {
        sfa[5] = (sfa[5] & ~0x20) | keep;
        state.saved++;
      } else state.unsaved++;
      syncSwitches();
      return withCrc([address, FN.WRITE_COILS, ...u16(start), ...u16(count)]);
    }
    return null;
  };

  /** @type {number[][]} */
  const sync = [];
  for (const a of addresses) for (const fn of [FN.READ_COILS, FN.READ_INPUT, FN.WRITE_COILS, FN.WRITE_REGISTERS]) sync.push([a, fn]);
  // No CRC check here: like the firmware, answer() refuses a bad CRC with exception 0x03.
  const asm = new FrameAssembler({
    sync,
    length: requestLength,
    onFrame: (frame) => {
      const out = answer(frame);
      if (out) void link.write(out).catch(() => {});
    },
    maxLength: 260,
  });
  const off = link.on('data', (/** @type {Uint8Array} */ c) => asm.push(c));
  const stopTick = attachBattery(link, bat, tickMs);
  return {
    battery: bat,
    state,
    spa,
    sfa,
    forced,
    faults,
    stop() {
      off();
      stopTick();
    },
  };
}
