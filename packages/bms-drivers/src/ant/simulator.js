import { u16le, setU16le, setU32le } from '@ubms/transport';
import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import {
  ABSENT_TEMPERATURE,
  ADDR,
  CONTROL,
  DEFAULT_PASSWORD_L1,
  DEFAULT_PASSWORD_L5,
  EXTRA,
  FN,
  OLD_CAPTURED_PASSWORD,
  OLD_CONTROL,
  OLD_HEADER,
  OLD_POWER_PLACEHOLDER,
  OLD_REJECTED,
  RSP,
  createRequestAssembler,
  encodeNewResponse,
  encodeOldCommand,
  encodeOldStatus,
  encodeStatus,
  parseOldCommand,
} from './protocol.js';

/**
 * Device side of the ANT protocols for the demo mode and tests, on top of the protocol
 * independent SimBattery. The ANT_NEW simulator answers status, parameter block reads (with the
 * `FF 0B 00 00` extra section of 2021 firmware), device info, chip id, system info, passwords,
 * writes (stored and echoed) and control actions, and like most 2021 boards it also answers the
 * old status request read only (power field 9999). The ANT_OLD simulator answers the 140 byte
 * status, parameter reads and the password protected control commands.
 *
 * Like the ANT-BLE20PHUB of a field log (2026-11-20), parameter pages read as 0xFF bytes until a
 * password granted level 1 or higher (opts.readNeedsAuth).
 *
 * Simplifications (not device facts): control actions only take effect after the level 5 password
 * was accepted (models batmon-ha's observation that switching without it reverts, spec 4.3);
 * parameter writes are stored immediately (bchiu saw writes accepted without authentication);
 * the u32 capacity registers use micro Ah like the status frame (2024 app map, spec 7.3).
 */

/** @typedef {import('@ubms/transport').Link} Link */

/** Per cell protection thresholds in V for the chemistry default sets. */
const CHEMISTRY = {
  lfp: { ovp: 3.65, ovpr: 3.55, ovp2: 3.8, ovpr2: 3.7, uvp: 2.6, uvpr: 2.9, uvp2: 2.5, uvpr2: 2.8, ovw: 3.6, ovwr: 3.5, uvw: 2.9, uvwr: 3.0, off: 2.5, bal: 3.4, limit: 3.6, type: 0xfaf2 },
  nmc: { ovp: 4.2, ovpr: 4.1, ovp2: 4.3, ovpr2: 4.2, uvp: 3.0, uvpr: 3.2, uvp2: 2.8, uvpr2: 3.0, ovw: 4.15, ovwr: 4.05, uvw: 3.2, uvwr: 3.3, off: 2.8, bal: 4.0, limit: 4.2, type: 0xfaf1 },
  lto: { ovp: 2.8, ovpr: 2.7, ovp2: 2.9, ovpr2: 2.85, uvp: 1.8, uvpr: 2.0, uvp2: 1.7, uvpr2: 1.9, ovw: 2.75, ovwr: 2.65, uvw: 2.0, uvwr: 2.1, off: 1.6, bal: 2.5, limit: 2.75, type: 0xfaf3 },
};

/** LiFePO4 open circuit voltage table for 100 %, 90 %, ..., 0 % (registers 174..194). */
const LFP_OCV_TABLE = [3450, 3345, 3335, 3325, 3310, 3300, 3290, 3270, 3250, 3200, 2800];

/** Chip id answer (12 bytes, as captured on a 16ZMUB). */
const CHIP_ID = [0x40, 0x70, 0x3b, 0x18, 0xdc, 0x8f, 0x9e, 0x11, 0x37, 0x42, 0x84, 0x01];

/** System info answer (40 bytes, ten u32 values as captured on a 24BHUB; meaning unknown). */
const SYSTEM_INFO = (() => {
  const b = new Uint8Array(40);
  [10, 10, 10, 0, 0, 0, 0, 10, 7, 2].forEach((v, i) => setU32le(b, 4 * i, v));
  return b;
})();

/**
 * Write the voltage group (block 0) and the other chemistry dependent registers.
 * @param {Uint8Array} regs
 * @param {'lfp'|'nmc'|'lto'} chemistry
 * @param {number} cells
 */
function loadChemistryDefaults(regs, chemistry, cells) {
  const c = CHEMISTRY[chemistry];
  const mv = (/** @type {number} */ addr, /** @type {number} */ v) => setU16le(regs, addr, Math.round(v * 1000));
  const pack = (/** @type {number} */ addr, /** @type {number} */ v) => setU16le(regs, addr, Math.round(v * cells * 10));
  mv(0, c.ovp);
  mv(2, c.ovpr);
  mv(4, c.ovp2);
  mv(6, c.ovpr2);
  pack(8, c.ovp);
  pack(10, c.ovpr);
  mv(12, c.uvp);
  mv(14, c.uvpr);
  mv(16, c.uvp2);
  mv(18, c.uvpr2);
  pack(20, c.uvp);
  pack(22, c.uvpr);
  mv(24, 0.3);
  mv(26, 0.2);
  mv(32, c.ovw);
  mv(34, c.ovwr);
  pack(36, c.ovw);
  pack(38, c.ovwr);
  mv(40, c.uvw);
  mv(42, c.uvwr);
  pack(44, c.uvw);
  pack(46, c.uvwr);
  mv(48, 0.2);
  mv(50, 0.15);
  mv(140, c.limit);
  mv(142, c.bal);
  setU16le(regs, 152, c.type);
  mv(158, c.off);
}

/**
 * Parameter image of a configured pack (1024 bytes, 0xFF = not configured).
 * @param {{ chemistry: 'lfp'|'nmc'|'lto', cells: number, hardwareVersion: string, softwareVersion: string, packId: string }} o
 */
function defaultRegisters({ chemistry, cells, hardwareVersion, softwareVersion, packId }) {
  const regs = new Uint8Array(1024).fill(0xff);
  const u16 = (/** @type {number} */ addr, /** @type {number} */ v) => setU16le(regs, addr, v & 0xffff);
  loadChemistryDefaults(regs, chemistry, cells);
  // Temperature group (degrees C; 68..94 signed).
  [55, 50, 65, 60, 90, 80, 0, 3, -20, -15, 50, 45, 60, 55, 80, 75, 2, 5, -15, -10].forEach((v, i) => u16(56 + 2 * i, v));
  // Current group: 150 A / 5 s, 200 A / 5 s, level 2 300 A / 300 ms, short circuit 800 A / 300 us.
  [1500, 5, 2000, 5, 3000, 300, 800, 300].forEach((v, i) => u16(104 + 2 * i, v));
  [1400, 1300, 1900, 1800, 15, 5].forEach((v, i) => u16(124 + 2 * i, v));
  // Balance: start difference 10 mV, stop difference 5 mV, 1000 mA, 2.0 A.
  u16(144, 10);
  u16(146, 5);
  u16(148, 1000);
  u16(150, 20);
  // Battery group.
  u16(154, cells);
  u16(156, 10);
  u16(160, 1000);
  LFP_OCV_TABLE.forEach((v, i) => u16(174 + 2 * i, v));
  // Pack ID.
  for (let i = 0; i < 32; i++) regs[ADDR.PACK_ID + i] = i < packId.length ? packId.charCodeAt(i) & 0x7f : 0;
  // Other group: wheel circumference, pulses, slave modules.
  u16(378, 0);
  u16(380, 0);
  u16(382, 0);
  // Device info block: hardware version (16) + software version (16).
  for (let i = 0; i < 16; i++) {
    regs[ADDR.DEVICE_INFO + i] = i < hardwareVersion.length ? hardwareVersion.charCodeAt(i) : 0;
    regs[ADDR.DEVICE_INFO + 16 + i] = i < softwareVersion.length ? softwareVersion.charCodeAt(i) : 0;
  }
  return regs;
}

/**
 * Status fields of the ANT_NEW frame from the battery model (device sign convention: current
 * and power positive while discharging).
 * @param {SimBattery} battery
 * @param {{ permission: number, manualBalance: boolean, chemistry: 'lfp'|'nmc'|'lto', totals: { chargeAh: number, dischargeAh: number, chargeS: number, dischargeS: number } }} state
 */
function statusFields(battery, state) {
  const cells = battery.cellVoltages();
  const n = cells.length;
  let max = -Infinity;
  let min = Infinity;
  let maxCell = 0;
  let minCell = 0;
  let sum = 0;
  cells.forEach((v, i) => {
    sum += v;
    if (v > max) {
      max = v;
      maxCell = i;
    }
    if (v < min) {
      min = v;
      minCell = i;
    }
  });
  const current = Math.round(-battery.current * 10) / 10;
  const charging = battery.current > 0.15;
  const discharging = battery.current < -0.15;
  const balancingMask = battery.balancing.reduce((m, on, i) => (on && i < 32 ? m | (1 << i) : m), 0) >>> 0;
  let protection = 0;
  if (!battery.switches.discharge) protection |= 1 << 17;
  if (!battery.switches.charge) protection |= 1 << 21;
  let warning = 0;
  if (charging) warning |= 1 << 18;
  if (discharging) warning |= 1 << 19;
  if (battery.switches.charge) warning |= 1 << 23;
  if (battery.switches.discharge) warning |= 1 << 24;
  if (balancingMask) warning |= 1 << 25;
  if (battery.soc <= 15) warning |= 1 << 12;
  if (battery.soc <= 5) warning |= 1 << 13;
  const remainingAh = battery.remainingAh;
  return {
    permission: state.permission,
    systemState: charging ? 2 : discharging ? 4 : 1,
    protectionMask0: protection >>> 0,
    warningMask0: warning >>> 0,
    cellVoltages: cells,
    // The last probe slot reports -40: probe absent (spec 6.1).
    temperatures: [...battery.temps.map((t) => Math.round(t)), ABSENT_TEMPERATURE],
    mosTemperature: Math.round(battery.mosTemp),
    balancerTemperature: Math.round(battery.mosTemp - 1.5),
    packVoltage: sum,
    current,
    soc: Math.round(battery.soc),
    soh: 98,
    dischargeMosState: battery.switches.discharge ? 1 : 15,
    chargeMosState: battery.switches.charge ? 1 : 15,
    balanceState: state.manualBalance || balancingMask ? 4 : 0,
    capacityAh: battery.capacityAh,
    remainingAh,
    cycleAh: battery.cycleAh,
    power: Math.round(sum * current),
    uptimeS: Math.floor(battery.uptime),
    balancingCellMask: balancingMask,
    cellVoltageMax: max,
    cellVoltageMaxCell: maxCell + 1,
    cellVoltageMin: min,
    cellVoltageMinCell: minCell + 1,
    cellVoltageDelta: max - min,
    cellVoltageAverage: sum / n,
    dischargeMosVoltage: 0,
    dischargeMosGateVoltage: 12.1,
    chargeMosGateVoltage: 11.8,
    comparatorRaw: 600,
    batteryType: CHEMISTRY[state.chemistry].type,
    totalDischargeAh: state.totals.dischargeAh,
    totalChargeAh: state.totals.chargeAh,
    totalDischargeTimeS: Math.floor(state.totals.dischargeS),
    totalChargeTimeS: Math.floor(state.totals.chargeS),
    optionalBlockBytes: 12,
    chargeDurationS: 0,
    chargeIntervalS: 0,
    chargeTimeRemainingMin: charging ? Math.min(65535, Math.round(((battery.capacityAh - remainingAh) / battery.current) * 60)) : 0,
    dischargeTimeRemainingMin: discharging ? Math.min(65535, Math.round((remainingAh / -battery.current) * 60)) : 0,
  };
}

/**
 * Old protocol status fields from the battery model.
 * @param {SimBattery} battery
 * @param {number} power W, or the 9999 placeholder of 2021 boards
 * @param {number} [balanceState]
 */
function oldStatusFields(battery, power, balanceState = 0) {
  const s = statusFields(battery, { permission: 0, manualBalance: false, chemistry: 'lfp', totals: { chargeAh: 0, dischargeAh: 0, chargeS: 0, dischargeS: 0 } });
  const ntc = battery.temps.map((t) => Math.round(t));
  while (ntc.length < 4) ntc.push(ABSENT_TEMPERATURE);
  return {
    packVoltage: s.packVoltage,
    cellVoltages: s.cellVoltages,
    cellCount: s.cellVoltages.length,
    current: s.current,
    soc: s.soc,
    capacityAh: s.capacityAh,
    remainingAh: s.remainingAh,
    cycleAh: s.cycleAh,
    uptimeS: s.uptimeS,
    mosTemperature: s.mosTemperature,
    balancerTemperature: s.balancerTemperature,
    temperatures: ntc.slice(0, 4),
    chargeMosState: s.chargeMosState,
    dischargeMosState: s.dischargeMosState,
    balanceState,
    power: power === OLD_POWER_PLACEHOLDER ? power : Math.round(s.packVoltage * s.current),
    cellVoltageMaxCell: s.cellVoltageMaxCell,
    cellVoltageMax: s.cellVoltageMax,
    cellVoltageMinCell: s.cellVoltageMinCell,
    cellVoltageMin: s.cellVoltageMin,
    cellVoltageAverage: s.cellVoltageAverage,
    balancingCellMask: s.balancingCellMask,
  };
}

/**
 * @param {Link} device
 * @param {Uint8Array} bytes
 */
function send(device, bytes) {
  device.write(bytes).catch(() => {});
}

/**
 * Simulated ANT_NEW BMS on the device side of a link.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {SimBattery} [opts.battery] battery model (default: 16S LiFePO4 280 Ah)
 * @param {number} [opts.tickMs] battery model step period, 0 disables the timer (tests)
 * @param {boolean} [opts.answerOldStatus] answer DBDB00000000 / 5A5A00000101 like 2021 boards
 * @param {string} [opts.password] level 5 password
 * @param {string | null} [opts.level1Password] level 1 password (default '12345678'; null: none accepted)
 * @param {boolean} [opts.readNeedsAuth] answer parameter reads with 0xFF bytes until a password
 *   granted level 1 or higher, like the ANT-BLE20PHUB of a field log (2026-11-20); default true
 * @param {number} [opts.paramReadLevel] level the parameter pages need (default 1). The same board
 *   at level 1 served the pack id and the versions and kept the parameter pages at 0xFF.
 * @param {Record<number, string>} [opts.lowLevelPasswords] passwords of levels 2, 3 and 4
 * @param {string} [opts.hardwareVersion]
 * @param {string} [opts.softwareVersion]
 * @param {string} [opts.packId]
 */
export function createAntSimulator(device, opts = {}) {
  const battery = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 280, chemistry: 'lfp', soc: 72, tempSensors: 3, seed: 11, maxCurrent: 60 });
  const chemistry = battery.chemistry === 'nmc' ? 'nmc' : 'lfp';
  const password = opts.password ?? DEFAULT_PASSWORD_L5;
  const level1Password = opts.level1Password === undefined ? DEFAULT_PASSWORD_L1 : opts.level1Password;
  const readNeedsAuth = opts.readNeedsAuth ?? true;
  const paramReadLevel = opts.paramReadLevel ?? 1;
  const lowLevelPasswords = opts.lowLevelPasswords ?? {};
  const settings = {
    chemistry: /** @type {'lfp'|'nmc'|'lto'} */ (chemistry),
    cells: battery.cellCount,
    hardwareVersion: opts.hardwareVersion ?? '16ZMB0TB120A',
    softwareVersion: opts.softwareVersion ?? '16ZMUB00-220501A',
    packId: opts.packId ?? 'ubms demo',
  };
  const regs = defaultRegisters(settings);
  const state = {
    permission: 0,
    manualBalance: false,
    buzzer: false,
    bluetooth: true,
    chemistry: settings.chemistry,
    sleepUntil: 0,
    saves: 0,
    totals: { chargeAh: 5822.651, dischargeAh: 5402.649, chargeS: 4830952, dischargeS: 4402650 },
  };
  /** Every request frame received, for tests. @type {Uint8Array[]} */
  const received = [];

  /** Registers that follow the battery model (micro Ah, see the module comment). */
  const refreshDynamicRegisters = () => {
    setU32le(regs, 162, Math.round(battery.capacityAh * 1e6) >>> 0);
    setU32le(regs, 166, Math.round(battery.remainingAh * 1e6) >>> 0);
  };

  /** @param {number} action @returns {number} acknowledgement result */
  const control = (action) => {
    // Level 5 (batmon-ha: a 20PHUB reverted a charge off sent without the level 5 password);
    // level 1 only unlocks reading.
    const allowed = state.permission >= 5;
    switch (action) {
      case CONTROL.CHARGE_ON:
      case CONTROL.CHARGE_OFF:
        if (allowed) battery.switches.charge = action === CONTROL.CHARGE_ON;
        return 1;
      case CONTROL.DISCHARGE_ON:
      case CONTROL.DISCHARGE_OFF:
        if (allowed) battery.switches.discharge = action === CONTROL.DISCHARGE_ON;
        return 1;
      case CONTROL.BALANCE_ON:
      case CONTROL.BALANCE_OFF:
        if (allowed) state.manualBalance = action === CONTROL.BALANCE_ON;
        return 1;
      case CONTROL.BUZZER_ON:
      case CONTROL.BUZZER_OFF:
        if (allowed) state.buzzer = action === CONTROL.BUZZER_ON;
        return 1;
      case CONTROL.BLUETOOTH_ON:
      case CONTROL.BLUETOOTH_OFF:
        if (allowed) state.bluetooth = action === CONTROL.BLUETOOTH_ON;
        return 1;
      case CONTROL.SAVE:
        state.saves++;
        return 1;
      case CONTROL.CLEAR_LOG:
        return 3; // as captured; meaning of 3 unknown
      case CONTROL.CLEAR_DISCHARGE_AH:
        if (allowed) state.totals.dischargeAh = 0;
        return 1;
      case CONTROL.CLEAR_CHARGE_AH:
        if (allowed) state.totals.chargeAh = 0;
        return 1;
      case CONTROL.CLEAR_DISCHARGE_TIME:
        if (allowed) state.totals.dischargeS = 0;
        return 1;
      case CONTROL.CLEAR_CHARGE_TIME:
        if (allowed) state.totals.chargeS = 0;
        return 1;
      case CONTROL.CLEAR_RUNTIME:
        if (allowed) battery.uptime = 0;
        return 1;
      case CONTROL.RESTART:
        if (allowed) {
          state.permission = 0;
          state.manualBalance = false;
          battery.uptime = 0;
          state.sleepUntil = Date.now() + 1000;
        }
        return 1;
      case CONTROL.SHUTDOWN:
        if (allowed) state.sleepUntil = Date.now() + 3000;
        return 1;
      case CONTROL.FACTORY_RESET:
        if (allowed) regs.set(defaultRegisters(settings));
        return 1;
      case CONTROL.DEFAULTS_LFP:
      case CONTROL.DEFAULTS_NMC:
      case CONTROL.DEFAULTS_LTO:
        if (allowed) {
          state.chemistry = action === CONTROL.DEFAULTS_LFP ? 'lfp' : action === CONTROL.DEFAULTS_NMC ? 'nmc' : 'lto';
          loadChemistryDefaults(regs, state.chemistry, settings.cells);
        }
        return 1;
      default:
        return 1;
    }
  };

  /** @param {Uint8Array} frame */
  const handleOld = (frame) => {
    if (opts.answerOldStatus === false) return;
    const { header, address } = parseOldCommand(frame);
    // Only the read only status request is answered; old writes are not accepted by 2021 boards.
    if (header === OLD_HEADER.STATUS_BT || (header === OLD_HEADER.READ && address === 0)) {
      send(device, encodeOldStatus(oldStatusFields(battery, OLD_POWER_PLACEHOLDER, state.manualBalance ? 4 : 0)));
    }
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    if (Date.now() < state.sleepUntil) return;
    if (frame[0] !== 0x7e) {
      handleOld(frame);
      return;
    }
    const func = frame[2];
    const address = u16le(frame, 3);
    const len = frame[5];
    switch (func) {
      case FN.STATUS:
        send(device, encodeStatus(statusFields(battery, state)));
        break;
      case FN.READ: {
        refreshDynamicRegisters();
        const end = Math.min(regs.length, address + len);
        const data = regs.slice(Math.min(address, end), end);
        // Without read access the board sends the page as 0xFF bytes (field log, see opts).
        const identity = address === ADDR.PACK_ID || address === ADDR.DEVICE_INFO;
        if (readNeedsAuth && state.permission < (identity ? 1 : paramReadLevel)) data.fill(0xff);
        send(device, encodeNewResponse(RSP.READ, address, data, { status: EXTRA.READ }));
        break;
      }
      case FN.CHIP_ID:
        send(device, encodeNewResponse(RSP.CHIP_ID, address, CHIP_ID));
        break;
      case FN.SYSTEM_INFO:
        send(device, encodeNewResponse(RSP.SYSTEM_INFO, address, SYSTEM_INFO));
        break;
      case FN.AUTH: {
        const text = String.fromCharCode(...frame.subarray(6, 6 + len));
        const low = [ADDR.PASSWORD_L2, ADDR.PASSWORD_L3, ADDR.PASSWORD_L4].indexOf(address) + 2;
        const level =
          address === ADDR.PASSWORD_L5 && text === password
            ? 5
            : address === ADDR.PASSWORD_L1 && level1Password !== null && text === level1Password
              ? 1
              : low >= 2 && lowLevelPasswords[low] === text
                ? low
                : 0;
        if (level) state.permission = Math.max(state.permission, level);
        const data = new Uint8Array(2);
        setU16le(data, 0, level);
        send(device, encodeNewResponse(RSP.AUTH, address, data, { status: EXTRA.AUTH }));
        break;
      }
      case FN.WRITE: {
        const payload = frame.slice(6, 6 + len);
        if (address + len <= regs.length) regs.set(payload, address);
        send(device, encodeNewResponse(RSP.WRITE, address, payload, { status: EXTRA.WRITE }));
        break;
      }
      case FN.CONTROL: {
        const result = control(address);
        const data = new Uint8Array(2);
        setU16le(data, 0, result);
        send(device, encodeNewResponse(RSP.CONTROL, address, data));
        break;
      }
      default:
        // 0x03 log and 0x06 GPRS answers are unknown (spec 6.7); other codes are not answered.
        break;
    }
  };

  const assembler = createRequestAssembler({ onFrame: handle });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const tickMs = opts.tickMs ?? 1000;
  const stopTimer =
    tickMs > 0
      ? every(() => {
          const dt = tickMs / 1000;
          battery.step(dt);
          const i = battery.current;
          if (i > 0) {
            state.totals.chargeAh += (i * dt) / 3600;
            state.totals.chargeS += dt;
          } else if (i < 0) {
            state.totals.dischargeAh += (-i * dt) / 3600;
            state.totals.dischargeS += dt;
          }
        }, tickMs)
      : () => {};

  return {
    battery,
    registers: regs,
    state,
    received,
    stop() {
      stopTimer();
      off();
    },
  };
}

/**
 * Simulated ANT_OLD BMS (tests): 140 byte status, parameter reads and password protected
 * commands with the apply frame. Unknown parameters are not answered.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {SimBattery} [opts.battery] default: 14S NMC 170 Ah
 * @param {number} [opts.tickMs] 0 disables the timer
 * @param {string} [opts.password]
 * @param {boolean} [opts.answerParams] answer parameter reads (default true)
 */
export function createAntLegacySimulator(device, opts = {}) {
  const battery = opts.battery ?? new SimBattery({ cells: 14, capacityAh: 170, chemistry: 'nmc', soc: 41, tempSensors: 2, seed: 5, maxCurrent: 40 });
  const password = opts.password ?? OLD_CAPTURED_PASSWORD;
  const capacityMicroAh = Math.round(battery.capacityAh * 1e6);
  /** Parameter number to raw u16 value (spec 7.4 scales). */
  const params = new Map([
    [1, 4150],
    [2, 3200],
    [3, 4200],
    [4, 3000],
    [5, 4100],
    [6, 3100],
    [7, 588],
    [8, 420],
    [9, 500],
    [10, 5],
    [11, 1000],
    [12, 5],
    [13, 4150],
    [14, 3900],
    [15, 10],
    [16, 10],
    [18, 2000],
    [19, 10],
    [21, 300],
    [22, 3600],
    [24, battery.cellCount],
    [25, 55],
    [26, 50],
    [27, 65],
    [28, 60],
    [29, 90],
    [30, 80],
    [31, capacityMicroAh & 0xffff],
    [32, (capacityMicroAh >>> 16) & 0xffff],
    [41, 0],
    [42, 0],
    [43, 2800],
    [44, 300],
    [45, 0],
    [162, 1500],
  ]);
  const state = { pw: ['', '', '', ''], authed: false, autoBalance: true, /** @type {{ address: number, value: number } | null} */ pending: null };
  /** @type {Uint8Array[]} */
  const received = [];

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    if (frame[0] === 0x7e) return; // old boards do not speak ANT_NEW
    const { header, address, value } = parseOldCommand(frame);
    if (header === OLD_HEADER.STATUS_BT || (header === OLD_HEADER.READ && address === 0)) {
      send(device, encodeOldStatus(oldStatusFields(battery, 0, state.autoBalance && battery.balancing.some(Boolean) ? 4 : 0)));
      return;
    }
    if (header === OLD_HEADER.READ) {
      const v = params.get(address);
      if (v !== undefined && opts.answerParams !== false) send(device, encodeOldCommand(OLD_HEADER.READ, address, v));
      return;
    }
    if (header !== OLD_HEADER.WRITE) return;
    if (address >= OLD_CONTROL.PASSWORD_1 && address <= OLD_CONTROL.PASSWORD_4) {
      state.pw[address - OLD_CONTROL.PASSWORD_1] = String.fromCharCode(value >> 8, value & 0xff);
      if (address === OLD_CONTROL.PASSWORD_4) state.authed = state.pw.join('') === password;
      send(device, frame);
      return;
    }
    if (!state.authed) {
      send(device, Uint8Array.from(OLD_REJECTED));
      return;
    }
    if (address === OLD_CONTROL.APPLY) {
      const p = state.pending;
      if (p?.address === OLD_CONTROL.CHARGE) battery.switches.charge = p.value === 1;
      if (p?.address === OLD_CONTROL.DISCHARGE) battery.switches.discharge = p.value === 1;
      if (p?.address === OLD_CONTROL.BALANCE_TOGGLE) state.autoBalance = !state.autoBalance;
      if (p?.address === OLD_CONTROL.REBOOT) battery.uptime = 0;
      state.pending = null;
      state.authed = false;
      send(device, frame);
      return;
    }
    state.pending = { address, value };
    send(device, frame);
  };

  const assembler = createRequestAssembler({ onFrame: handle });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const tickMs = opts.tickMs ?? 1000;
  const stopTimer = tickMs > 0 ? every(() => battery.step(tickMs / 1000), tickMs) : () => {};
  return {
    battery,
    params,
    state,
    received,
    stop() {
      stopTimer();
      off();
    },
  };
}
