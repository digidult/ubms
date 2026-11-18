import { SimBattery } from '../common/sim-battery.js';
import { every, r } from '../common/util.js';
import {
  CMD,
  CONTROL_BITS,
  JK02_DEVICE_SETTINGS,
  JK02_SETTINGS_LAYOUT,
  VARIANT,
  ackFrame,
  controlBitRegister,
  createCommandAssembler,
  encodeCellInfo,
  encodeDeviceInfo,
  encodeEventLog,
  encodeSettings,
  readIntLe,
} from './protocol.js';

/**
 * Device side of the JK02 BLE protocol for the demo mode and tests, on top of the protocol
 * independent SimBattery. It answers the device info request (with the trailing ACK of firmware
 * 19), the settings request (settings frame, then the device info frame like JK-PB firmware, then
 * the cell info stream), the event log request, writes (stored, acknowledged with the ACK frame)
 * and the JK02_32S buttons. Like real modules it sometimes sends the "AT\r\n" text of the BLE
 * module between frames.
 *
 * Simplifications (not device facts): the chemistry presets and the factory reset load the value
 * sets below; a write that arrives shortly after a settings request is acknowledged but dropped
 * (models batmon-ha's observation, spec 4.2); calibration writes are acknowledged and ignored.
 */

/** @typedef {import('@ubms/transport').Link} Link */

const AT_TEXT = Uint8Array.from([0x41, 0x54, 0x0d, 0x0a]);

/** Seconds from 1970-01-01 to 2020-01-01, the inferred time base of the RTC ticks (spec 6.1). */
const RTC_EPOCH_S = 1577836800;

/**
 * Per cell voltages of the chemistry value sets (simulator choices, not JK defaults).
 * @type {Record<'lfp'|'nmc'|'lto', Record<string, number>>}
 */
const CHEMISTRY = {
  lfp: { cellUvp: 2.6, cellUvpr: 3.05, cellOvp: 3.65, cellOvpr: 3.448, powerOffVoltage: 2.5, cellSoc100Voltage: 3.45, cellSoc0Voltage: 3.0, cellRcv: 3.46, cellRfv: 3.35, balanceStartVoltage: 3.45, smartSleepVoltage: 3.5 },
  nmc: { cellUvp: 3.0, cellUvpr: 3.2, cellOvp: 4.2, cellOvpr: 4.1, powerOffVoltage: 2.8, cellSoc100Voltage: 4.1, cellSoc0Voltage: 3.2, cellRcv: 4.15, cellRfv: 4.05, balanceStartVoltage: 3.9, smartSleepVoltage: 3.6 },
  lto: { cellUvp: 1.8, cellUvpr: 2.0, cellOvp: 2.8, cellOvpr: 2.7, powerOffVoltage: 1.6, cellSoc100Voltage: 2.7, cellSoc0Voltage: 2.0, cellRcv: 2.75, cellRfv: 2.65, balanceStartVoltage: 2.5, smartSleepVoltage: 2.4 },
};

/**
 * Settings of a configured pack (parser field names).
 * @param {SimBattery} battery
 * @param {boolean} is32
 */
function defaultSettings(battery, is32) {
  const chem = battery.chemistry === 'nmc' ? 'nmc' : 'lfp';
  /** @type {Record<string, any>} */
  const s = {
    ...CHEMISTRY[chem],
    balanceTriggerVoltage: 0.005,
    maxChargeCurrent: 100,
    chargeOcpDelay: 3,
    chargeOcpRecoveryTime: 60,
    maxDischargeCurrent: 150,
    dischargeOcpDelay: 300,
    dischargeOcpRecoveryTime: 60,
    scpRecoveryTime: 30,
    maxBalanceCurrent: 2,
    chargeOtp: 70,
    chargeOtpr: 60,
    dischargeOtp: 70,
    dischargeOtpr: 60,
    chargeUtp: 2,
    chargeUtpr: 5,
    mosOtp: 80,
    mosOtpr: 70,
    cellCount: battery.cellCount,
    chargeSwitch: battery.switches.charge,
    dischargeSwitch: battery.switches.discharge,
    balancerSwitch: battery.switches.balance,
    nominalCapacity: battery.capacityAh,
    wireResistances: Array.from({ length: is32 ? 32 : 24 }, () => 0),
  };
  if (is32) {
    Object.assign(s, {
      scpDelay: 5,
      deviceAddress: 1,
      prechargeTime: 5,
      heatingStartTemperature: 3,
      heatingStopTemperature: 7,
      smartSleepDelay: 24,
      dischargeUtp: -10,
      dischargeUtpr: -5,
    });
    for (const b of CONTROL_BITS) s[b.name] = false;
    s.heatingEnabled = true;
    s.portSwitchRs485 = true;
    s.smartSleep = true;
    s.chargingFloatMode = true;
    s.dischargeOcp2 = true;
  } else {
    // Old firmware: no request / float voltages, SOC voltages and an unexplained 600 at S6 (spec 6.2).
    Object.assign(s, { scpDelay: 1000, smartSleepVoltage: 0.6, cellSoc100Voltage: 0, cellSoc0Voltage: 0, cellRcv: 0, cellRfv: 0 });
  }
  return s;
}

/** @param {boolean} is32 */
function defaultDeviceInfo(is32) {
  if (!is32) {
    return { model: 'JK-B2A24S20P', hardwareVersion: '10.XG', softwareVersion: '10.07', uptime: 0, powerOnCount: 3, deviceName: 'JK-B2A24S20P', devicePasscode: '1234', manufacturingDate: '220511', serialNumber: '2041803028', userData: 'Input Userdata', setupPasscode: '123456' };
  }
  return {
    model: 'JK_PB2A16S20P',
    hardwareVersion: '19A',
    softwareVersion: '19.27',
    uptime: 0,
    powerOnCount: 16,
    deviceName: 'JK_PB2A16S20P',
    devicePasscode: '1234',
    manufacturingDate: '250315',
    serialNumber: '506177F49001234',
    userData: 'ubms demo',
    setupPasscode: '123456',
    userData2: 'JK-BMS',
    uart1Protocol: 1,
    canProtocol: 2,
    uart1ProtocolEnableLo32: 59131,
    canProtocolEnable: 4095,
    uart2Protocol: 1,
    uart2ProtocolEnable: 0,
    lcdBuzzerTrigger: 9,
    dry1Trigger: 0,
    dry2Trigger: 0,
    uartProtocolLibVersion: 1,
    lcdBuzzerTriggerValue: 100,
    lcdBuzzerReleaseValue: 95,
    dry1TriggerValue: 60,
    dry1ReleaseValue: 50,
    dry2TriggerValue: 0,
    dry2ReleaseValue: 0,
    dataStoredPeriod: 3600,
    rcvTime: 0.5,
    rfvTime: 5,
    canProtocolLibVersion: 1,
    emergencyDuration: 30,
    uart3Protocol: 15,
    uart3ProtocolEnableLo32: 41987,
    reBulkSoc: 5,
  };
}

/**
 * Engineering value of a raw write for a settings layout field.
 * @param {import('./protocol.js').SettingSpec} spec
 * @param {number} raw
 */
function fromRaw(spec, raw) {
  if (spec.type === 'bool32') return raw !== 0;
  const scale = spec.scale ?? 1;
  return scale === 1 ? raw : r(raw * scale, Math.round(-Math.log10(scale)));
}

/**
 * Simulated JK BMS on the device side of a link.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {'JK02_32S'|'JK02_24S'} [opts.variant] default JK02_32S (a JK-PB2A16S20P, firmware 19.27)
 * @param {SimBattery} [opts.battery] default: 16S LFP 280 Ah
 * @param {number} [opts.streamMs] cell info interval after a settings request (0: no timer)
 * @param {number} [opts.dropWritesMs] writes this soon after a settings request are dropped (ACK only)
 * @param {boolean} [opts.junk] send the "AT\r\n" module text now and then (default true)
 */
export function createJkSimulator(device, opts = {}) {
  const variant = opts.variant === VARIANT.JK02_24S ? VARIANT.JK02_24S : VARIANT.JK02_32S;
  const is32 = variant === VARIANT.JK02_32S;
  const battery = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 280, chemistry: 'lfp', soc: 72, tempSensors: 2, seed: 5, maxCurrent: 60 });
  const settings = defaultSettings(battery, is32);
  const info = defaultDeviceInfo(is32);
  const streamMs = opts.streamMs ?? 1000;
  const dropWritesMs = opts.dropWritesMs ?? 300;
  const junk = opts.junk ?? true;
  const state = {
    counter: 0,
    streaming: false,
    framesSent: 0,
    lastSettingsRequestAt: 0,
    emergencyUntil: 0,
    droppedWrites: 0,
    /** @type {Array<{ seconds: number, code: number }>} */
    events: [
      { seconds: 0, code: 0x01 },
      { seconds: 238, code: 0x44 },
      { seconds: 86400, code: 0x38 },
    ],
  };
  /** Every command frame received, for tests. @type {Uint8Array[]} */
  const received = [];

  /** @param {Uint8Array} bytes */
  const send = (bytes) => {
    if (device.isOpen) device.write(bytes).catch(() => {});
  };
  const counter = () => (state.counter = (state.counter + 1) & 0xff);
  /** Restore the battery side effects of the switches after loading a value set. */
  const applySwitches = () => {
    battery.switches.charge = !!settings.chargeSwitch;
    battery.switches.discharge = !!settings.dischargeSwitch;
    battery.switches.balance = !!settings.balancerSwitch;
  };

  const cellInfo = () => {
    const cells = battery.cellVoltages();
    const voltage = r(cells.reduce((a, b) => a + b, 0), 3);
    const current = battery.current;
    const min = Math.min(...cells);
    const max = Math.max(...cells);
    const balancing = battery.balancing.some(Boolean);
    const countdown = Math.max(0, Math.round((state.emergencyUntil - Date.now()) / 1000));
    const temps = battery.temps;
    const heating = !!settings.heatingEnabled && Math.min(...temps) < (settings.heatingStartTemperature ?? -100);
    return {
      cellVoltages: cells,
      cellResistances: battery.wireResistance.map((w) => r(0.05 + w * 0.03, 3)),
      cellVoltageAverage: r(voltage / cells.length, 3),
      cellVoltageDelta: r(max - min, 3),
      cellVoltageMaxIndex: cells.indexOf(max),
      cellVoltageMinIndex: cells.indexOf(min),
      temperatureMos: r(battery.mosTemp, 1),
      temperature1: r(temps[0] ?? 20, 1),
      temperature2: temps.length > 1 ? r(temps[1], 1) : null,
      temperature3: null,
      temperature4: null,
      temperature5: null,
      temperatureSensorMask: temps.length > 1 ? 0x07 : 0x03,
      wireResistanceWarningMask: 0,
      totalVoltage: voltage,
      powerRaw: r(Math.abs(voltage * current), 3),
      current,
      errorsBitmask: max > settings.cellOvp ? 1 << 4 : 0,
      balanceCurrent: balancing ? r(battery.balanceCurrent, 3) : 0,
      balancingAction: balancing ? 1 : 0,
      soc: Math.round(battery.soc),
      capacityRemaining: r(battery.remainingAh, 3),
      fullChargeCapacity: battery.capacityAh,
      cycleCount: battery.cycles,
      totalCycleCapacity: r(battery.cycleAh, 3),
      soh: 100,
      precharging: 0,
      userAlarm: 0,
      totalRuntime: Math.floor(battery.uptime),
      chargingMos: battery.switches.charge,
      dischargingMos: battery.switches.discharge || countdown > 0,
      prechargingMos: false,
      balancerWorking: balancing,
      heating,
      emergencyTimeCountdown: countdown,
      dischargeCurrentCorrection: 0,
      chargeCurrentSensorVoltage: 0,
      dischargeCurrentSensorVoltage: 0,
      batteryVoltageCorrection: 3.0,
      totalVoltage2: r(voltage, 2),
      heatingCurrent: heating ? 1.5 : 0,
      chargerPlugged: current > 0,
      sysRunTicks: Math.floor(battery.uptime * 10),
      rtcTicks: Math.floor(Date.now() / 1000) - RTC_EPOCH_S,
      detailLogCount: state.events.length,
      timeEnterSleep: 86400,
      pclModuleState: 0,
      batteryType: battery.chemistry === 'nmc' ? 1 : 0,
      chargeStatusTime: 600,
      chargeStatus: battery.soc > 98 ? 2 : 0,
      dryContactMask: 0,
    };
  };

  const sendCellInfo = () => {
    send(encodeCellInfo(cellInfo(), variant, counter()));
    state.framesSent++;
    if (junk && state.framesSent % 8 === 0) send(AT_TEXT);
  };
  const sendDeviceInfo = () => send(encodeDeviceInfo({ ...info, uptime: Math.floor(battery.uptime) }, counter()));

  /**
   * Apply a value write; returns false when the register is unknown.
   * @param {number} register
   * @param {number} raw
   */
  const applyWrite = (register, raw) => {
    const spec = JK02_SETTINGS_LAYOUT.find((s) => (is32 ? s.reg32 : !s.only32 && s.reg24) === register);
    if (spec) {
      settings[spec.name] = fromRaw(spec, raw);
      if (spec.name === 'chargeSwitch' || spec.name === 'dischargeSwitch' || spec.name === 'balancerSwitch') applySwitches();
      return true;
    }
    if (!is32) return false;
    const bit = CONTROL_BITS.find((b) => controlBitRegister(b.bit) === register);
    if (bit) {
      settings[bit.name] = raw !== 0;
      return true;
    }
    const dev = JK02_DEVICE_SETTINGS.find((d) => d.register === register);
    if (dev) {
      /** @type {Record<string, any>} */ (info)[dev.name] = dev.scale ? r(raw * dev.scale, 1) : raw;
      return true;
    }
    switch (register) {
      case CMD.EMERGENCY:
        state.emergencyUntil = raw ? Date.now() + (/** @type {any} */ (info).emergencyDuration ?? 30) * 60000 : 0;
        return true;
      case CMD.SOC_CALIBRATION:
        battery.soc = Math.max(0, Math.min(100, raw));
        return true;
      case 0x64: // voltage calibration
      case 0x67: // current calibration
      case 0x6c: // time calibration
        return true;
      default:
        return false;
    }
  };

  /** @param {'lfp'|'nmc'|'lto'} chem */
  const loadPreset = (chem) => {
    Object.assign(settings, CHEMISTRY[chem]);
    state.events.push({ seconds: Math.floor(battery.uptime), code: chem === 'nmc' ? 0x43 : chem === 'lfp' ? 0x44 : 0x45 });
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    const register = frame[4];
    const length = frame[5];
    if (length === 0) {
      switch (register) {
        case CMD.DEVICE_INFO:
          sendDeviceInfo();
          if (is32) send(ackFrame()); // firmware 19 appends the ACK (spec 3.3)
          return;
        case CMD.SETTINGS:
          state.lastSettingsRequestAt = Date.now();
          send(encodeSettings(settings, variant, counter()));
          if (is32) sendDeviceInfo(); // JK-PB firmware repeats the device info (spec 4.1 step 5)
          state.streaming = true;
          return;
        default:
      }
      if (!is32) return; // the buttons are JK02_32S commands
      switch (register) {
        case CMD.EVENT_LOG:
          send(encodeEventLog(state.events, counter()));
          return;
        case CMD.RESTART:
          send(ackFrame());
          battery.uptime = 0;
          state.events.push({ seconds: 0, code: 0x01 });
          return;
        case CMD.SHUTDOWN:
          send(ackFrame());
          state.streaming = false;
          return;
        case CMD.FACTORY_RESET:
          send(ackFrame());
          Object.assign(settings, defaultSettings(battery, is32));
          return;
        case CMD.PRESET_LFP:
        case CMD.PRESET_LIION:
        case CMD.PRESET_LTO:
          send(ackFrame());
          loadPreset(register === CMD.PRESET_LFP ? 'lfp' : register === CMD.PRESET_LIION ? 'nmc' : 'lto');
          return;
        default:
          return;
      }
    }
    if (length !== 1 && length !== 2 && length !== 4) {
      send(ackFrame());
      return;
    }
    const raw = readIntLe(frame, 6, length);
    send(ackFrame());
    if (Date.now() - state.lastSettingsRequestAt < dropWritesMs) {
      state.droppedWrites++;
      return;
    }
    applyWrite(register, raw);
  };

  const assembler = createCommandAssembler({ onFrame: handle });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const stopTimer =
    streamMs > 0
      ? every(() => {
          battery.step(streamMs / 1000);
          if (state.streaming) sendCellInfo();
        }, streamMs)
      : () => {};

  return {
    battery,
    settings,
    deviceInfo: info,
    state,
    received,
    /** Send one cell info frame now (tests without the timer). */
    sendCellInfo,
    stop() {
      stopTimer();
      off();
    },
  };
}
