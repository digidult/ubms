import { setU16be, setU32be, u16be, u32be } from '@ubms/transport';
import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import {
  CMD,
  D2_REG,
  HOST,
  MODBUS,
  P81_REG,
  WRITE_OFFSET,
  WRITABLE_GROUPS,
  boardHostAddress,
  createClassicAssembler,
  createModbusRequestAssembler,
  encodeClassic,
  encodeModbusReadResponse,
  encodeModbusWriteResponse,
  isClassicHostAddress,
  modbusRequestAddress,
  modbusResponseAddress,
  rtcBytes,
} from './protocol.js';

/**
 * Device side of the Daly protocols for the demo mode and tests, on top of the protocol
 * independent SimBattery.
 *
 * The classic simulator answers every read 0x90..0x98 and 0x50..0x63 (multi-frame cells,
 * temperatures, battery code and versions), stores configuration writes and acknowledges them
 * with data 0 = 1, sets the SOC and clock (0x21) and switches the MOSFETs (0xDA / 0xD9). Like the
 * real firmware it leaves undefined reply bytes at the values of the previous reply (spec 3.1),
 * and with host address 0x80 it sends all 16 cell frames (spec 4.2).
 *
 * The Modbus simulator serves a register image in either map (D2 or 0x81), refreshed from the
 * battery model before every read, and handles the writes the driver uses.
 *
 * Simplifications (not device facts): the classic reset (0x00) is not answered and only resets
 * the uptime; temperatures are whole degrees.
 */

/** @typedef {import('@ubms/transport').Link} Link */

/**
 * @param {Link} device
 * @param {Uint8Array} bytes
 */
function send(device, bytes) {
  device.write(bytes).catch(() => {});
}

/**
 * Battery state shared by both simulators.
 * @param {SimBattery} battery
 */
function batteryView(battery) {
  const cells = battery.cellVoltages();
  const mv = cells.map((v) => Math.round(v * 1000));
  let maxI = 0;
  let minI = 0;
  mv.forEach((v, i) => {
    if (v > mv[maxI]) maxI = i;
    if (v < mv[minI]) minI = i;
  });
  const voltage = mv.reduce((a, b) => a + b, 0) / 1000;
  const temps = battery.temps.map((t) => Math.round(t));
  let tMax = 0;
  let tMin = 0;
  temps.forEach((t, i) => {
    if (t > temps[tMax]) tMax = i;
    if (t < temps[tMin]) tMin = i;
  });
  const current = battery.current;
  return {
    mv,
    maxI,
    minI,
    voltage,
    temps,
    tMax,
    tMin,
    current,
    state: current > 0.15 ? 1 : current < -0.15 ? 2 : 0,
    avg: Math.round(mv.reduce((a, b) => a + b, 0) / mv.length),
  };
}

// ---------------------------------------------------------------------------------------------
// Classic simulator
// ---------------------------------------------------------------------------------------------

/**
 * Default configuration groups of a 16S LiFePO4 pack (8 data bytes each; bytes a group does not
 * define hold stale values as on real devices).
 * @param {SimBattery} battery
 */
function defaultClassicGroups(battery) {
  const n = battery.cellCount;
  /** @type {Map<number, Uint8Array>} */
  const g = new Map();
  const group = (/** @type {number} */ cmd, /** @type {(d: Uint8Array) => void} */ fill) => {
    const d = new Uint8Array(8);
    fill(d);
    g.set(cmd, d);
  };
  group(CMD.RATED, (d) => {
    setU32be(d, 0, Math.round(battery.capacityAh * 1000));
    setU16be(d, 6, 3200);
  });
  group(CMD.BOARDS, (d) => {
    d[0] = 1;
    d[1] = n;
    d[4] = battery.tempSensorCount;
  });
  group(CMD.CUMULATIVE, (d) => {
    setU32be(d, 0, 6020);
    setU32be(d, 4, 5874);
  });
  group(CMD.BATTERY_INFO, (d) => {
    d.set([0x01, 0x01, 24, 3, 15], 0);
    setU16be(d, 5, 3600);
    d[7] = 2;
  });
  group(CMD.FIRMWARE_INDEX, (d) => d.set(Array.from('20240315', (c) => c.charCodeAt(0))));
  group(CMD.CELL_LIMITS, (d) => [3600, 3650, 2800, 2500].forEach((v, i) => setU16be(d, 2 * i, v)));
  group(CMD.PACK_LIMITS, (d) => [576, 584, 448, 400].forEach((v, i) => setU16be(d, 2 * i, v)));
  group(CMD.CURRENT_LIMITS, (d) => [29000, 28500, 31500, 32000].forEach((v, i) => setU16be(d, 2 * i, v)));
  group(CMD.TEMP_LIMITS, (d) => d.set([50, 55, 5, 0, 55, 60, -10, -20].map((t) => t + 40)));
  group(CMD.SOC_LIMITS, (d) => [1000, 1020, 200, 100].forEach((v, i) => setU16be(d, 2 * i, v)));
  group(CMD.DIFF_LIMITS, (d) => {
    setU16be(d, 0, 200);
    setU16be(d, 2, 400);
    d.set([10, 15, 0x78, 0x1e], 4);
  });
  group(CMD.BALANCE_LIMITS, (d) => {
    setU16be(d, 0, 3400);
    setU16be(d, 2, 30);
    d.set([0x00, 0x00, 0x0e, 0x74], 4);
  });
  group(CMD.SHORT_CIRCUIT, (d) => {
    setU16be(d, 0, 1500);
    setU16be(d, 2, 100);
  });
  return g;
}

/**
 * Failure bits (classic order) from the battery state and the configured thresholds.
 * @param {ReturnType<typeof batteryView>} v
 * @param {SimBattery} battery
 * @param {Map<number, Uint8Array>} groups
 */
function classicFailures(v, battery, groups) {
  const b = new Uint8Array(8);
  const cl = /** @type {Uint8Array} */ (groups.get(CMD.CELL_LIMITS));
  const max = v.mv[v.maxI];
  const min = v.mv[v.minI];
  if (max >= u16be(cl, 0)) b[0] |= 0x01;
  if (max >= u16be(cl, 2)) b[0] |= 0x02;
  if (min <= u16be(cl, 4)) b[0] |= 0x04;
  if (min <= u16be(cl, 6)) b[0] |= 0x08;
  const sl = /** @type {Uint8Array} */ (groups.get(CMD.SOC_LIMITS));
  const soc10 = Math.round(battery.soc * 10);
  if (soc10 <= u16be(sl, 4)) b[2] |= 0x40;
  if (soc10 <= u16be(sl, 6)) b[2] |= 0x80;
  const dl = /** @type {Uint8Array} */ (groups.get(CMD.DIFF_LIMITS));
  if (max - min >= u16be(dl, 0)) b[3] |= 0x01;
  return b;
}

/**
 * Simulated classic Daly BMS on the device side of a link.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {SimBattery} [opts.battery] battery model (default: 16S LiFePO4 150 Ah, 2 sensors)
 * @param {number} [opts.board] board number used as reply address (default 1)
 * @param {number[]} [opts.hosts] host addresses answered (default 0x80 and the board address)
 * @param {number} [opts.dropFirst] number of first requests to ignore (sleeping module)
 * @param {number} [opts.tickMs] battery model step period, 0 disables the timer (tests)
 * @param {string} [opts.batteryCode]
 * @param {string} [opts.softwareVersion] 14 characters
 * @param {string} [opts.hardwareVersion] 14 characters
 */
export function createDalySimulator(device, opts = {}) {
  const battery = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 150, chemistry: 'lfp', soc: 64, tempSensors: 2, seed: 21, maxCurrent: 50 });
  const board = opts.board ?? 1;
  const hosts = opts.hosts ?? [HOST.BLUETOOTH, boardHostAddress(board)];
  const groups = defaultClassicGroups(battery);
  const texts = {
    [CMD.BATTERY_CODE]: (opts.batteryCode ?? 'UBMS DEMO 16S 150AH').padEnd(35, ' ').slice(0, 35),
    [CMD.SOFTWARE_VERSION]: (opts.softwareVersion ?? '20230815-1.12T').padEnd(14, ' ').slice(0, 14),
    [CMD.HARDWARE_VERSION]: (opts.hardwareVersion ?? 'DL-BMS-R16-02E').padEnd(14, ' ').slice(0, 14),
  };
  const state = { drop: opts.dropFirst ?? 0, rtcOffsetMs: 0, life: 0, writes: 0, resets: 0 };
  /** Battery code frames received so far (0x17). @type {string[]} */
  const codeFrames = [];
  /** Every request frame received, for tests. @type {Uint8Array[]} */
  const received = [];
  /** Data bytes of the previous reply (undefined bytes repeat them, spec 3.1). */
  let stale = new Uint8Array(8);

  /**
   * @param {number} cmd
   * @param {(d: Uint8Array) => void} [fill]
   */
  const reply = (cmd, fill) => {
    const d = Uint8Array.from(stale);
    fill?.(d);
    stale = d;
    send(device, encodeClassic(board, cmd, d));
  };

  /**
   * Multi-frame text answer, 7 characters per frame.
   * @param {number} cmd
   */
  const replyText = (cmd) => {
    const text = /** @type {Record<number, string>} */ (texts)[cmd];
    for (let n = 1; n <= text.length / 7; n++) {
      reply(cmd, (d) => {
        d[0] = n;
        for (let i = 0; i < 7; i++) d[1 + i] = text.charCodeAt((n - 1) * 7 + i);
      });
    }
  };

  /**
   * @param {number} host
   * @param {number} cmd
   * @param {Uint8Array} data request data bytes
   */
  const handleRead = (host, cmd, data) => {
    const v = batteryView(battery);
    switch (cmd) {
      case CMD.SOC:
        return reply(cmd, (d) => {
          setU16be(d, 0, Math.round(v.voltage * 10));
          setU16be(d, 2, 0);
          // Classic convention of most firmware: charging is stored below 30000 (spec 6.1).
          setU16be(d, 4, 30000 - Math.round(v.current * 10));
          setU16be(d, 6, Math.round(battery.soc * 10));
        });
      case CMD.CELL_RANGE:
        return reply(cmd, (d) => {
          setU16be(d, 0, v.mv[v.maxI]);
          d[2] = v.maxI + 1;
          setU16be(d, 3, v.mv[v.minI]);
          d[5] = v.minI + 1;
        });
      case CMD.TEMP_RANGE:
        return reply(cmd, (d) => d.set([v.temps[v.tMax] + 40, v.tMax + 1, v.temps[v.tMin] + 40, v.tMin + 1], 0));
      case CMD.MOSFET:
        return reply(cmd, (d) => {
          d[0] = v.state;
          d[1] = battery.switches.charge ? 1 : 0;
          d[2] = battery.switches.discharge ? 1 : 0;
          d[3] = state.life = (state.life + 1) & 0xff;
          setU32be(d, 4, Math.round(battery.remainingAh * 1000));
        });
      case CMD.STATUS:
        return reply(cmd, (d) => {
          d[0] = battery.cellCount;
          d[1] = battery.tempSensorCount;
          d[2] = v.state === 1 ? 1 : 0;
          d[3] = v.state === 2 ? 1 : 0;
          d[4] = 0;
          setU16be(d, 5, battery.cycles);
          d[7] = 0;
        });
      case CMD.CELLS: {
        // The Bluetooth module sends all 16 frames, the PC address only the needed ones (spec 4.2).
        const frames = host === HOST.BLUETOOTH ? 16 : Math.ceil(battery.cellCount / 3);
        for (let n = 1; n <= frames; n++) {
          reply(cmd, (d) => {
            d[0] = n;
            for (let k = 0; k < 3; k++) setU16be(d, 1 + 2 * k, v.mv[3 * (n - 1) + k] ?? 0);
          });
        }
        return;
      }
      case CMD.TEMPERATURES: {
        const frames = host === HOST.BLUETOOTH ? 3 : Math.ceil(battery.tempSensorCount / 7);
        for (let n = 1; n <= frames; n++) {
          reply(cmd, (d) => {
            d[0] = n;
            for (let k = 0; k < 7; k++) {
              const t = v.temps[7 * (n - 1) + k];
              d[1 + k] = t === undefined ? 0 : t + 40;
            }
          });
        }
        return;
      }
      case CMD.BALANCE:
        return reply(cmd, (d) => {
          d.fill(0);
          battery.balancing.forEach((on, i) => {
            if (on && i < 48) d[i >> 3] |= 1 << (i & 7);
          });
        });
      case CMD.FAILURES:
        return reply(cmd, (d) => d.set(classicFailures(v, battery, groups)));
      case CMD.D8:
        return reply(cmd, (d) => d.fill(0));
      case CMD.BATTERY_CODE:
      case CMD.SOFTWARE_VERSION:
      case CMD.HARDWARE_VERSION:
        return replyText(cmd);
      case CMD.RTC:
        return reply(cmd, (d) => {
          d.set(rtcBytes(new Date(Date.now() + state.rtcOffsetMs)), 0);
          d[6] = 0;
          d[7] = 0;
        });
      default: {
        const g = groups.get(cmd);
        if (g) reply(cmd, (d) => d.set(g));
        void data;
      }
    }
  };

  /**
   * @param {number} cmd write command
   * @param {Uint8Array} data
   */
  const handleWrite = (cmd, data) => {
    const readCmd = cmd + WRITE_OFFSET;
    if (readCmd === CMD.BATTERY_CODE) {
      const n = data[0];
      if (n >= 1 && n <= 5) codeFrames[n - 1] = String.fromCharCode(...data.subarray(1, 8));
      // One acknowledgement after the last of the five frames (spec 5.3).
      if (n === 5 && codeFrames.filter(Boolean).length === 5) {
        texts[CMD.BATTERY_CODE] = codeFrames.join('');
        codeFrames.length = 0;
        state.writes++;
        reply(cmd, (d) => (d[0] = 1));
      }
      return;
    }
    if (!WRITABLE_GROUPS.includes(readCmd)) return;
    groups.set(readCmd, Uint8Array.from(data));
    if (readCmd === CMD.RATED) battery.capacityAh = u32be(data, 0) / 1000;
    state.writes++;
    reply(cmd, (d) => (d[0] = 1));
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    const host = frame[1];
    if (!isClassicHostAddress(host)) return; // replies and foreign frames
    received.push(frame);
    if (!hosts.includes(host)) return;
    if (state.drop > 0) {
      state.drop--;
      return;
    }
    const cmd = frame[2];
    const data = frame.subarray(4, 12);
    if (cmd >= 0x90 || (cmd >= 0x50 && cmd <= 0x63)) {
      if (cmd === CMD.DISCHARGE_MOS || cmd === CMD.CHARGE_MOS) {
        const on = data[0] === 1;
        if (cmd === CMD.CHARGE_MOS) battery.switches.charge = on;
        else battery.switches.discharge = on;
        // Only data 0 is new in the answer (spec 6.2).
        reply(cmd, (d) => (d[0] = on ? 1 : 0));
        return;
      }
      handleRead(host, cmd, data);
      return;
    }
    if (cmd === CMD.SET_SOC) {
      battery.soc = Math.min(100, u16be(data, 6) / 10);
      if (data.subarray(0, 6).some((b) => b !== 0)) {
        const t = new Date(2000 + data[0], data[1] - 1, data[2], data[3], data[4], data[5]);
        state.rtcOffsetMs = t.getTime() - Date.now();
      }
      reply(cmd, (d) => (d[0] = 1));
      return;
    }
    if (cmd >= 0x10 && cmd <= 0x20) {
      handleWrite(cmd, data);
      return;
    }
    if (cmd === CMD.RESET) {
      state.resets++;
      battery.uptime = 0;
    }
  };

  const assembler = createClassicAssembler({ onFrame: handle });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const tickMs = opts.tickMs ?? 1000;
  const stopTimer = tickMs > 0 ? every(() => battery.step(tickMs / 1000), tickMs) : () => {};
  return {
    battery,
    groups,
    texts,
    state,
    received,
    stop() {
      stopTimer();
      off();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Modbus simulator (D2 and 0x81 maps)
// ---------------------------------------------------------------------------------------------

/**
 * ASCII text into registers (two characters per register, NUL padded).
 * @param {Uint16Array} regs
 * @param {number} start
 * @param {number} bytes field length in bytes
 * @param {string} text
 */
function putText(regs, start, bytes, text) {
  for (let i = 0; i < bytes; i += 2) {
    const a = i < text.length ? text.charCodeAt(i) & 0xff : 0;
    const b = i + 1 < text.length ? text.charCodeAt(i + 1) & 0xff : 0;
    regs[start + i / 2] = (a << 8) | b;
  }
}

/** Settings registers 0x0100..0x0177 as captured on an ESS-DL-BMS (0x81 map, syssi). */
const P81_SETTINGS_ESS = [
  1, 16, 1, 16, 0, 0, 4, 0, 0, 4, 51856, 4, 51856, 32, 54156, 34, 582, 40, 45, 0, 3200, 65535, 834, 1000, 3, 1, 3400, 20, 20, 50, 50, 20, 85, 1, 1, 6662,
  534, 3844, 12594, 13108, 13622, 6659, 6656, 1, 10, 2, 65535, 0, 3450, 3550, 3400, 5000, 2800, 2700, 2900, 5000, 552, 562, 542, 1000, 456, 440, 450, 1000,
  28400, 28000, 1000, 27000, 1000, 31600, 32000, 1000, 33000, 1000, 90, 95, 90, 1000, 45, 40, 45, 1000, 90, 95, 90, 1000, 25, 40, 25, 1000, 450, 500, 450,
  1000, 10, 15, 12, 1000, 0, 0, 20, 1000, 135, 140, 105, 1000, 105, 110, 105, 1000, 2000, 300, 1, 1, 0, 65535, 65535, 65535, 1, 1,
];

/**
 * Simulated Daly BMS speaking the Modbus style protocol.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {'d2'|'p81'} [opts.flavour] register map (default D2)
 * @param {number} [opts.board] board number of the 0x81 map (default 1)
 * @param {boolean} [opts.balancer] D2: behave like a Daly active balancer (register 0x00CF switch)
 * @param {SimBattery} [opts.battery]
 * @param {number} [opts.tickMs] battery model step period, 0 disables the timer (tests)
 */
export function createDalyModbusSimulator(device, opts = {}) {
  const flavour = opts.flavour ?? 'd2';
  const board = opts.board ?? 1;
  const battery =
    opts.battery ??
    (flavour === 'd2'
      ? new SimBattery({ cells: 16, capacityAh: 100, chemistry: 'lfp', soc: 58, tempSensors: 4, seed: 13, maxCurrent: 40 })
      : new SimBattery({ cells: 16, capacityAh: 314, chemistry: 'lfp', soc: 86, tempSensors: 4, seed: 17, maxCurrent: 60 }));
  const requestAddress = modbusRequestAddress(flavour, board);
  const responseAddress = modbusResponseAddress(flavour, board);
  const regs = new Uint16Array(0x300);
  const state = { heartbeat: 0, sleepUntil: 0, restarts: 0, currentZeroed: 0, balancer: !!opts.balancer };
  /** @type {Uint8Array[]} */
  const received = [];

  if (flavour === 'd2') {
    regs.set(
      [
        Math.round(battery.capacityAh * 10), 3200, 1, battery.cellCount, 0, 0, battery.tempSensorCount, 0, 0, 0, 3600,
        3600, 3650, 2800, 2500, 576, 584, 448, 400, 29000, 28500, 31500, 32000,
        90, 95, 45, 40, 95, 100, 30, 20, 200, 400, 10, 15, 3400, 30, 1, 1, Math.round(battery.soc * 10), 125,
      ],
      0x80,
    );
    putText(regs, 0xa9, 16, 'T00K_240315_12');
    putText(regs, 0xb1, 16, 'H2.0_103R_309F9F');
    putText(regs, 0xb9, 32, '20240315');
    putText(regs, 0xc9, 6, '123456');
    regs[0xcc] = (24 << 8) | 3;
    regs[0xcd] = 15 << 8;
    // BMS boards keep the cloud server address from 0x00CE on (vendor list); balancers have their
    // switch at 0x00CF.
    putText(regs, 0xce, 16, '0.0.0.0:0');
    if (state.balancer) regs[0xcf] = 1;
  } else {
    regs.set(P81_SETTINGS_ESS, 0x100);
    regs[0x103] = battery.cellCount;
    regs[0x106] = battery.tempSensorCount;
    regs[0xa6] = 1500;
    regs[0xa7] = 1500;
    putText(regs, 0x178, 14, '12_260120_K00T');
    putText(regs, 0x17f, 14, 'H2.1_103E_30XF');
    putText(regs, 0x186, 14, 'DL_HKMS_3.2.E');
    putText(regs, 0x18d, 14, '221LD011111111');
    putText(regs, 0x19b, 14, '20260530');
  }

  /** Live registers from the battery model. */
  const refresh = () => {
    const v = batteryView(battery);
    const n = battery.cellCount;
    if (flavour === 'd2') {
      for (let i = 0; i < 32; i++) regs[i] = v.mv[i] ?? 0;
      for (let i = 0; i < 8; i++) regs[0x20 + i] = (v.temps[i] ?? 0) + 40;
      regs[0x28] = Math.round(v.voltage * 10);
      // Modbus captures: positive while charging (spec 12.1 item 1).
      regs[0x29] = 30000 + Math.round(v.current * 10);
      regs[0x2a] = Math.round(battery.soc * 10);
      regs[0x2b] = v.mv[v.maxI];
      regs[0x2c] = v.mv[v.minI];
      regs[0x2d] = v.temps[v.tMax] + 40;
      regs[0x2e] = v.temps[v.tMin] + 40;
      regs[0x2f] = v.state;
      regs[0x30] = Math.round(battery.remainingAh * 10);
      regs[0x31] = n;
      regs[0x32] = battery.tempSensorCount;
      regs[0x33] = battery.cycles;
      regs[0x34] = battery.balancing.some(Boolean) ? 1 : 0;
      regs[0x35] = battery.switches.charge ? 1 : 0;
      regs[0x36] = battery.switches.discharge ? 1 : 0;
      regs[0x37] = v.avg;
      regs[0x38] = v.mv[v.maxI] - v.mv[v.minI];
      regs[0x39] = Math.round(Math.abs(v.voltage * v.current));
      // Fault registers: classic byte 2 bit 6 (SOC low, level 1) sits in the low byte of 0x003B.
      regs[0x3a] = 0;
      regs[0x3b] = battery.soc <= 20 ? 0x0040 : 0;
      regs[0x3c] = 0;
      regs[0x3d] = 0;
      regs[0x40] = 30000 + Math.round(battery.balanceCurrent * 1000);
      regs[0x42] = Math.round(battery.mosTemp) + 40;
      regs[0xa5] = battery.switches.charge ? 1 : 0;
      regs[0xa6] = battery.switches.discharge ? 1 : 0;
      regs[0xa7] = Math.round(battery.soc * 10);
      if (state.balancer) regs[0xcf] = battery.switches.balance ? 1 : 0;
    } else {
      for (let i = 0; i < 48; i++) regs[i] = v.mv[i] ?? 0;
      for (let i = 0; i < 8; i++) regs[0x30 + i] = i < v.temps.length ? v.temps[i] + 40 : 0x00ff;
      regs[0x38] = Math.round(v.voltage * 10);
      regs[0x39] = 30000 + Math.round(v.current * 10);
      regs[0x3a] = Math.round(battery.soc * 10);
      regs[0x3b] = state.heartbeat = (state.heartbeat + 1) & 0xffff;
      regs[0x3c] = n;
      regs[0x3d] = battery.tempSensorCount;
      regs[0x3e] = v.mv[v.maxI];
      regs[0x3f] = v.maxI + 1;
      regs[0x40] = v.mv[v.minI];
      regs[0x41] = v.minI + 1;
      regs[0x42] = v.mv[v.maxI] - v.mv[v.minI];
      regs[0x43] = v.temps[v.tMax] + 40;
      regs[0x44] = v.tMax + 1;
      regs[0x45] = v.temps[v.tMin] + 40;
      regs[0x46] = v.tMin + 1;
      regs[0x47] = v.temps[v.tMax] - v.temps[v.tMin];
      regs[0x48] = v.state;
      regs[0x4b] = Math.round(battery.remainingAh * 10);
      regs[0x4c] = battery.cycles;
      regs[0x4d] = battery.balancing.some(Boolean) ? 1 : 0;
      regs[0x4e] = battery.balancing.some(Boolean) ? 30000 + Math.round(battery.balanceCurrent * 1000) : 0;
      for (let gIdx = 0; gIdx < 3; gIdx++) {
        let w = 0;
        for (let i = 0; i < 16; i++) if (battery.balancing[16 * gIdx + i]) w |= 1 << i;
        regs[0x4f + gIdx] = w;
      }
      regs[0x52] = battery.switches.charge ? 1 : 0;
      regs[0x53] = battery.switches.discharge ? 1 : 0;
      regs[0x54] = 0;
      regs[0x55] = regs[P81_REG.FORCE_HEATER] ? 1 : 0;
      regs[0x56] = regs[P81_REG.FORCE_FAN] ? 1 : 0;
      regs[0x57] = v.avg;
      regs[0x58] = Math.round(Math.abs(v.voltage * v.current));
      regs[0x5a] = Math.round(battery.mosTemp) + 40;
      regs[0x5b] = Math.round(battery.mosTemp - 4) + 40;
      regs[0x5c] = 0;
      const clock = rtcBytes(new Date());
      regs[0x61] = (clock[0] << 8) | clock[1];
      regs[0x62] = (clock[2] << 8) | clock[3];
      regs[0x63] = (clock[4] << 8) | clock[5];
      // Alarm code 6 (low byte of 0x0070): SOC low level.
      regs[0x70] = battery.soc <= 10 ? 2 : battery.soc <= 20 ? 1 : 0;
      regs[P81_REG.SOC] = Math.round(battery.soc * 10);
      regs[0x121] = battery.switches.charge ? 1 : 0;
      regs[0x122] = battery.switches.discharge ? 1 : 0;
    }
  };

  /**
   * Side effects of a register write.
   * @param {number} register
   * @param {number} value
   */
  const onWrite = (register, value) => {
    if (flavour === 'd2') {
      if (register === D2_REG.CHARGE_MOS) battery.switches.charge = value === 1;
      if (register === D2_REG.DISCHARGE_MOS) battery.switches.discharge = value === 1;
      if (register === D2_REG.SOC) battery.soc = Math.min(100, value / 10);
      if (register === D2_REG.BALANCER && state.balancer) battery.switches.balance = value === 1;
      if (register === D2_REG.RESTART) {
        state.restarts++;
        battery.uptime = 0;
      }
      if (register === D2_REG.SHUTDOWN) state.sleepUntil = Date.now() + 3000;
      if (register === D2_REG.CURRENT_ZERO) state.currentZeroed++;
    } else {
      if (register === P81_REG.CHARGE_MOS) battery.switches.charge = value === 1;
      if (register === P81_REG.DISCHARGE_MOS) battery.switches.discharge = value === 1;
      if (register === P81_REG.SOC) battery.soc = Math.min(100, value / 10);
      if (register === P81_REG.FORCE_HEATER) battery.switches.heater = value === 1;
    }
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    if (Date.now() < state.sleepUntil) return;
    const fn = frame[1];
    const register = u16be(frame, 2);
    const word = u16be(frame, 4);
    if (fn === MODBUS.READ) {
      if (register + word > regs.length || word < 1 || word > 125) return;
      refresh();
      send(device, encodeModbusReadResponse(responseAddress, regs.subarray(register, register + word)));
    } else if (fn === MODBUS.WRITE) {
      if (register >= regs.length) return;
      regs[register] = word;
      onWrite(register, word);
      send(device, encodeModbusWriteResponse(responseAddress, MODBUS.WRITE, register, word));
    } else if (fn === MODBUS.WRITE_MULTI) {
      for (let i = 0; i < word && register + i < regs.length; i++) regs[register + i] = u16be(frame, 6 + 2 * i);
      send(device, encodeModbusWriteResponse(responseAddress, MODBUS.WRITE_MULTI, register, word));
    }
  };

  const assembler = createModbusRequestAssembler({ onFrame: handle, addresses: [requestAddress] });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const tickMs = opts.tickMs ?? 1000;
  const stopTimer = tickMs > 0 ? every(() => battery.step(tickMs / 1000), tickMs) : () => {};
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
