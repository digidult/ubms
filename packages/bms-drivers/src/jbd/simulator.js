import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import {
  APP_KEY,
  APP_KEY_RESULT,
  CONTROL,
  FACTORY,
  FFAA,
  OP_READ,
  OP_WRITE,
  REG,
  REGISTERS,
  ROOT_PASSWORD,
  STATUS,
  createJbdAssembler,
  encodeDd,
  encodeFfaa,
  isFfaaFrame,
  isRequestFrame,
  parseMac,
  passwordCipher,
  tempToRaw,
} from './protocol.js';
import { UP_FN, UP_STATUS_END, UP_STATUS_START, createUpAssembler, encodeUp } from './up.js';

/**
 * Device side of the JBD protocols for the demo mode and tests, on top of the protocol
 * independent SimBattery (docs/protocols/jbd.md, "spec").
 *
 * The DD simulator answers 0x03 (with the V11 tail when `extendedTail`), 0x04, 0x05 and 0xAA,
 * serves the EEPROM registers of spec 7.2 inside factory mode (status 0x81 outside, 0x80 for
 * registers it does not know, for 0x42..0x47 when `socTable` is false and for string writes),
 * acknowledges writes with `DD r 00 00 00 00 77`, switches the MOSFETs with 0xE1 (also outside
 * factory mode, like the official app) and answers the 0x0A codes 0x0100 and 0x0400. With
 * `module` it also plays the Bluetooth module: 'open' answers the app key with 0x02, 'locked'
 * runs the FF AA login of spec 4.2 and ignores DD frames until it succeeds, 'pairing' echoes the
 * app key and never answers.
 *
 * Simplifications (not device facts): writes take effect at once, exit `00 00` keeps them in RAM
 * until the simulator is created again, the protection bits show the software switch lock plus
 * the `protectionBits` option.
 *
 * Fault injection for tests (spec 3.5: lost and late BLE answers): `dropAnswers` performs the
 * request but sends no answer, `lateAnswers` sends the answer after a delay (both keyed by
 * register, the state copies can be changed while running), `dropModuleAnswers` drops FF AA
 * answers by command, `setMosCommand` plays another app or a power cycle that changes 0xE1 behind
 * the driver's back.
 */

/** @typedef {import('@ubms/transport').Link} Link */

/**
 * @param {Link} device
 * @param {Uint8Array} bytes
 */
function send(device, bytes) {
  device.write(bytes).catch(() => {});
}

/** Production date 2024-05-17 as the u16 of spec 9.5. */
const DEMO_DATE = ((2024 - 2000) << 9) | (5 << 5) | 17;

/**
 * Default EEPROM of a 16S LFP pack, modelled on the SP04S034 read of [SN] (spec 7.2).
 * @param {{ cells: number, capacityAh: number }} o
 * @returns {Map<number, number>}
 */
function defaultEeprom({ cells, capacityAh }) {
  const t = tempToRaw;
  /** @type {Array<[number, number]>} */
  const values = [
    [0x10, Math.round(capacityAh * 100)],
    [0x11, Math.round(capacityAh * 80)],
    [0x12, 3500],
    [0x13, 2800],
    [0x14, 2],
    [0x15, DEMO_DATE],
    [0x16, 1234],
    [0x17, 37],
    [0x18, t(65)],
    [0x19, t(55)],
    [0x1a, t(-10)],
    [0x1b, t(0)],
    [0x1c, t(70)],
    [0x1d, t(60)],
    [0x1e, t(-20)],
    [0x1f, t(-10)],
    [0x20, 365 * cells],
    [0x21, 355 * cells],
    [0x22, 250 * cells],
    [0x23, 270 * cells],
    [0x24, 3650],
    [0x25, 3550],
    [0x26, 2500],
    [0x27, 2700],
    [0x28, 10000],
    [0x29, 0x10000 - 15000],
    [0x2a, 3400],
    [0x2b, 30],
    [0x2c, 1],
    [0x2d, 0x0006],
    [0x2e, 0x0007],
    [0x2f, cells],
    [0x30, 30],
    [0x31, 10],
    [0x32, 3400],
    [0x33, 3350],
    [0x34, 3300],
    [0x35, 3200],
    [0x36, 3900],
    [0x37, 2000],
    [0x38, 0x8d5c],
    [0x39, 0xf064],
    [0x3a, 0x0202],
    [0x3b, 0x0202],
    [0x3c, 0x0202],
    [0x3d, 0x0202],
    [0x3e, 0x0a1e],
    [0x3f, 0x0a1e],
    [0x42, 3375],
    [0x43, 3325],
    [0x44, 3310],
    [0x45, 3280],
    [0x46, 3150],
    [0x47, 3500],
  ];
  return new Map(values.map(([k, v]) => [k, v & 0xffff]));
}

/** @param {number} v */
const be = (v) => [(v >> 8) & 0xff, v & 0xff];

/**
 * @param {Link} device
 * @param {Object} [opts]
 * @param {SimBattery} [opts.battery]
 * @param {number} [opts.cells]
 * @param {number} [opts.capacityAh]
 * @param {number} [opts.tempSensors]
 * @param {string} [opts.model] answer of 0x05 and 0xA1
 * @param {number} [opts.softwareVersion] byte d18 (0x24 = 2.4)
 * @param {boolean} [opts.extendedTail] send the V11 tail (spec 6.2)
 * @param {boolean} [opts.socTable] answer 0x42..0x47 (firmware 0x20 and later)
 * @param {boolean} [opts.unit100] set bit 12 of 0x2D and send 100 mA / 100 mAh units
 * @param {number} [opts.dropFirst] number of requests to ignore (sleeping BMS)
 * @param {string} [opts.bmsPassword] BMS password: factory mode needs 0x06 with it first
 * @param {'plain'|'open'|'locked'|'pairing'} [opts.module] Bluetooth module behaviour
 * @param {string} [opts.modulePassword] password of a locked module
 * @param {string} [opts.mac] device address of a locked module
 * @param {boolean|'extended'} [opts.daren] Daren clone: 0x05 refused with 0x80, 8 byte tail after
 *   the NTC words; 'extended' appends the extended fields of [AIO] daren_bms.py (16 byte tail)
 * @param {number} [opts.protectionBits] protection bits ORed into the 0x03 word (spec 9.1)
 * @param {Record<number, number>} [opts.dropAnswers] register -> number of answers to drop
 * @param {Record<number, number>} [opts.lateAnswers] register -> delay of its answers in ms
 * @param {Record<number, number>} [opts.dropModuleAnswers] FF AA command -> answers to drop
 * @param {number} [opts.tickMs] battery step interval, 0 = manual (`step`)
 */
export function createJbdSimulator(device, opts = {}) {
  const cells = opts.cells ?? 16;
  const capacityAh = opts.capacityAh ?? 100;
  const battery = opts.battery ?? new SimBattery({ cells, capacityAh, chemistry: 'lfp', soc: 71, tempSensors: opts.tempSensors ?? 3, seed: 31, maxCurrent: 40 });
  const model = opts.model ?? 'JBD-SP25S003-L16S-100A-100A-B';
  const eeprom = defaultEeprom({ cells: battery.cellCount, capacityAh: battery.capacityAh });
  if (opts.unit100) {
    eeprom.set(0x2d, eeprom.get(0x2d) | 0x1000);
    eeprom.set(0x10, Math.round(battery.capacityAh * 10));
    eeprom.set(0x11, Math.round(battery.capacityAh * 8));
    eeprom.set(0x28, 1000);
    eeprom.set(0x29, 0x10000 - 1500);
  }
  /** @type {Map<number, string>} */
  const strings = new Map([
    [0xa0, 'DGJBD'],
    [0xa1, model],
    [0xa2, ''],
  ]);
  const moduleMode = opts.module ?? 'plain';
  const mac = parseMac(opts.mac ?? 'A4:C1:37:04:2D:BE') ?? new Uint8Array(6);
  const state = {
    factory: false,
    drop: opts.dropFirst ?? 0,
    /** Values saved with exit 28 28. */
    saves: 0,
    /** Every exit in order: 'exit' or 'exitSave'. @type {string[]} */
    exits: /** @type {string[]} */ ([]),
    mosCommand: { chargeOff: false, dischargeOff: false },
    passwordOk: !opts.bmsPassword,
    loggedIn: moduleMode !== 'locked' && moduleMode !== 'pairing',
    passwordStep: false,
    random: 0x24,
    controls: /** @type {number[]} */ ([]),
    counters: [3, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 5],
    protectionBits: opts.protectionBits ?? 0,
    dropAnswers: /** @type {Record<number, number>} */ ({ ...(opts.dropAnswers ?? {}) }),
    lateAnswers: /** @type {Record<number, number>} */ ({ ...(opts.lateAnswers ?? {}) }),
    dropModuleAnswers: /** @type {Record<number, number>} */ ({ ...(opts.dropModuleAnswers ?? {}) }),
  };
  /** Timers of late answers, cleared by stop(). @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();
  /** Every DD request and FF AA frame received, for tests. @type {Uint8Array[]} */
  const received = [];
  /** Saved copy of the EEPROM (exit 28 28). */
  let saved = new Map(eeprom);

  const applySwitches = () => {
    battery.switches.charge = !state.mosCommand.chargeOff;
    battery.switches.discharge = !state.mosCommand.dischargeOff;
    battery.switches.balance = ((eeprom.get(0x2d) ?? 0) & 0x04) !== 0;
  };
  applySwitches();

  /**
   * @param {number} register
   * @param {number} status
   * @param {ArrayLike<number>} [data]
   */
  const answer = (register, status, data = []) => {
    const drop = state.dropAnswers[register] ?? 0;
    if (drop > 0) {
      state.dropAnswers[register] = drop - 1;
      return;
    }
    const bytes = encodeDd(register, status, data);
    const late = state.lateAnswers[register] ?? 0;
    if (late <= 0) return send(device, bytes);
    const timer = setTimeout(() => {
      timers.delete(timer);
      send(device, bytes);
    }, late);
    timers.add(timer);
  };

  const unit100 = () => ((eeprom.get(0x2d) ?? 0) & 0x1000) !== 0;

  /** Data of the 0x03 answer (spec 6.1, 6.2). */
  const basicData = () => {
    const mv = battery.cellVoltages().map((v) => Math.round(v * 1000));
    const k = unit100() ? 10 : 100;
    const voltage = Math.round(mv.reduce((a, b) => a + b, 0) / 10);
    const current = Math.round(battery.current * k) & 0xffff;
    const remaining = Math.round(battery.remainingAh * k);
    const nominal = Math.round(battery.capacityAh * k);
    let balance = 0;
    battery.balancing.forEach((b, i) => {
      if (b && i < 32) balance += 2 ** i;
    });
    const softLock = state.mosCommand.chargeOff || state.mosCommand.dischargeOff;
    const protection = ((softLock ? 0x1000 : 0) | state.protectionBits) & 0xffff;
    const fet = (battery.switches.charge ? 1 : 0) | (battery.switches.discharge ? 2 : 0);
    const temps = battery.temps.map((t) => tempToRaw(t));
    const d = [
      ...be(voltage),
      ...be(current),
      ...be(remaining),
      ...be(nominal),
      ...be(battery.cycles),
      ...be(eeprom.get(0x15) ?? 0),
      ...be(balance & 0xffff),
      ...be(Math.floor(balance / 0x10000) & 0xffff),
      ...be(protection),
      opts.softwareVersion ?? 0x24,
      Math.round(battery.soc),
      fet,
      battery.cellCount,
      temps.length,
      ...temps.flatMap(be),
    ];
    if (opts.daren) {
      // Daren tail (spec 6.2, vector daren-ble-rx-basic-16s): MOSFET and ambient temperature,
      // state of health 100 % and three zero bytes; no production date or software version.
      d.splice(10, 2, 0, 0);
      d[18] = 0;
      d.push(...be(tempToRaw(battery.mosTemp)), ...be(tempToRaw(battery.ambient)), 0x64, 0, 0, 0);
      if (opts.daren === 'extended') {
        // Extended fields of [AIO] daren_bms.py (frame offsets 43, 45 and 49 with 4 NTCs, that is
        // tail +8, +10 and +14): remaining and design capacity in 0.1 Ah, two unknown bytes,
        // current in 0.1 A (constructed, no capture).
        d.push(...be(Math.round(battery.remainingAh * 10)), ...be(Math.round(battery.capacityAh * 10)), 0, 0, ...be(Math.round(battery.current * 10) & 0xffff));
      }
    } else if (opts.extendedTail ?? true) {
      // Tail of spec 6.2: unit flag in bit 7 of the first byte (Fogstar), alarm bits, full charge
      // capacity, remaining capacity, balance current.
      d.push(unit100() ? 0x80 : 0x00, 0, 0, ...be(nominal), ...be(remaining), 0, 0);
    }
    return d;
  };

  /** @param {number} register */
  const readRegister = (register) => {
    if (strings.has(register)) {
      const text = /** @type {string} */ (strings.get(register));
      return answer(register, STATUS.OK, [text.length, ...[...text].map((c) => c.charCodeAt(0) & 0xff)]);
    }
    if (!eeprom.has(register) || (opts.socTable === false && register >= 0x42 && register <= 0x47)) return answer(register, STATUS.ERROR);
    answer(register, STATUS.OK, be(/** @type {number} */ (eeprom.get(register))));
  };

  /**
   * @param {number} register
   * @param {Uint8Array} data
   */
  const write = (register, data) => {
    const v = data.length === 2 ? (data[0] << 8) | data[1] : -1;
    if (register === REG.FACTORY_ENTER) {
      if (v !== FACTORY.ENTER) return answer(register, STATUS.ERROR);
      if (!state.passwordOk) return answer(register, STATUS.INVALID);
      state.factory = true;
      return answer(register, STATUS.OK);
    }
    if (register === REG.FACTORY_EXIT) {
      if (v === FACTORY.EXIT_SAVE) {
        saved = new Map(eeprom);
        state.saves++;
        state.exits.push('exitSave');
      } else state.exits.push('exit');
      state.factory = false;
      return answer(register, STATUS.OK);
    }
    if (register === REG.PASSWORD) {
      const pw = opts.bmsPassword;
      if (pw && data.length === 7 && data[0] === 6) {
        const ascii = String.fromCharCode(...data.subarray(1));
        const digits = Array.from(data.subarray(1), (b) => String(b)).join('');
        if (ascii === pw || digits === pw) state.passwordOk = true;
      }
      return answer(register, STATUS.OK);
    }
    if (register === REG.MOS) {
      if (v < 0) return answer(register, STATUS.ERROR);
      state.mosCommand = { chargeOff: (v & 1) !== 0, dischargeOff: (v & 2) !== 0 };
      applySwitches();
      return answer(register, STATUS.OK);
    }
    if (register === REG.CONTROL) {
      state.controls.push(v);
      if (v === CONTROL.RESET_CAPACITY) {
        battery.soc = Math.round(battery.soc);
        return answer(register, STATUS.OK);
      }
      if (v === CONTROL.CLEAR_PROTECTION) return answer(register, STATUS.OK);
      return answer(register, STATUS.ERROR);
    }
    if (!REGISTERS[register] || strings.has(register) || data.length !== 2) return answer(register, STATUS.ERROR);
    if (!state.factory) return answer(register, STATUS.INVALID);
    if (opts.socTable === false && register >= 0x42 && register <= 0x47) return answer(register, STATUS.ERROR);
    eeprom.set(register, v);
    if (register === 0x10) battery.capacityAh = v / (unit100() ? 10 : 100);
    applySwitches();
    answer(register, STATUS.OK);
  };

  /** @param {Uint8Array} frame */
  const handleDd = (frame) => {
    if (!isRequestFrame(frame)) return;
    const op = frame[1];
    const register = frame[2];
    const data = frame.subarray(4, 4 + frame[3]);
    if (op === OP_WRITE) return write(register, data);
    if (op !== OP_READ) return;
    switch (register) {
      case REG.BASIC:
        return answer(register, STATUS.OK, basicData());
      case REG.CELLS:
        return answer(
          register,
          STATUS.OK,
          battery.cellVoltages().flatMap((v) => be(Math.round(v * 1000))),
        );
      case REG.VERSION:
        if (opts.daren) return answer(register, STATUS.ERROR);
        return answer(register, STATUS.OK, [...model].map((c) => c.charCodeAt(0) & 0xff));
      case REG.ERROR_COUNTS:
        return answer(register, STATUS.OK, state.counters.flatMap(be));
      default:
        if (!state.factory) return answer(register, STATUS.INVALID);
        return readRegister(register);
    }
  };

  /** @param {Uint8Array} frame */
  const handleFfaa = (frame) => {
    if (moduleMode === 'plain') return;
    const cmd = frame[2];
    const data = frame.subarray(4, 4 + frame[3]);
    const result = (/** @type {number} */ r) => {
      const drop = state.dropModuleAnswers[cmd] ?? 0;
      if (drop > 0) {
        state.dropModuleAnswers[cmd] = drop - 1;
        return;
      }
      send(device, encodeFfaa(cmd, [r]));
    };
    if (moduleMode === 'pairing') {
      send(device, Uint8Array.from(frame));
      return;
    }
    if (cmd === FFAA.APP_KEY) {
      if (moduleMode === 'open') return result(APP_KEY_RESULT.NO_PASSWORD);
      const key = String.fromCharCode(...data);
      return result(key === APP_KEY ? APP_KEY_RESULT.PASSWORD_REQUIRED : APP_KEY_RESULT.REJECTED);
    }
    if (cmd === FFAA.RANDOM) {
      state.random = (state.random * 13 + 0x3b) & 0xff;
      return result(state.random);
    }
    if (cmd === FFAA.PASSWORD) {
      const expected = passwordCipher(mac, opts.modulePassword ?? '123456', state.random);
      state.passwordStep = expected.every((b, i) => b === data[i]) && data.length === 6;
      return result(state.passwordStep ? 0 : 1);
    }
    if (cmd === FFAA.ROOT) {
      const expected = passwordCipher(mac, ROOT_PASSWORD, state.random);
      const ok = state.passwordStep && data.length === expected.length && expected.every((b, i) => b === data[i]);
      if (ok) state.loggedIn = true;
      return result(ok ? 0 : 1);
    }
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    if (state.drop > 0) {
      state.drop--;
      return;
    }
    if (isFfaaFrame(frame)) return handleFfaa(frame);
    if (!state.loggedIn) return; // a locked module ignores DD frames silently (spec 1.4)
    handleDd(frame);
  };

  const assembler = createJbdAssembler({ onFrame: handle });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const tickMs = opts.tickMs ?? 1000;
  const stopTimer = tickMs > 0 ? every(() => battery.step(tickMs / 1000), tickMs) : () => {};
  return {
    battery,
    eeprom,
    strings,
    state,
    received,
    /** EEPROM as saved by the last exit with 28 28. */
    saved: () => saved,
    /**
     * Change the 0xE1 state behind the driver's back (another app, a BMS restart).
     * @param {{ chargeOff: boolean, dischargeOff: boolean }} cmd
     */
    setMosCommand(cmd) {
      state.mosCommand = { chargeOff: !!cmd.chargeOff, dischargeOff: !!cmd.dischargeOff };
      applySwitches();
    },
    /** @param {number} [dt] seconds */
    step(dt = 1) {
      battery.step(dt);
    },
    stop() {
      stopTimer();
      off();
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// UP series (RS485)
// ---------------------------------------------------------------------------------------------

/**
 * UP series pack on RS485 (spec 6.10): answers the status block request for its address with the
 * layout of the captured JBD-UP16S020, filled from a SimBattery. Every other request is ignored.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {number} [opts.address]
 * @param {SimBattery} [opts.battery]
 * @param {string} [opts.model]
 * @param {number} [opts.tickMs]
 */
export function createJbdUpSimulator(device, opts = {}) {
  const address = opts.address ?? 1;
  const battery = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 100, chemistry: 'lfp', soc: 61, tempSensors: 4, seed: 47, maxCurrent: 30 });
  const model = opts.model ?? 'JBD48100000';
  /** @type {Uint8Array[]} */
  const received = [];
  const t = (/** @type {number} */ c) => Math.round(c * 10) + 500;

  const statusData = () => {
    const mv = battery.cellVoltages().map((v) => Math.round(v * 1000));
    const max = Math.max(...mv);
    const min = Math.min(...mv);
    const temps = battery.temps.map(t);
    const current = Math.round(battery.current * 100) + 300000;
    let balance = 0;
    battery.balancing.forEach((b, i) => {
      if (b && i < 16) balance |= 1 << i;
    });
    const op = battery.current > 0.15 ? 1 : battery.current < -0.15 ? 2 : 0;
    const mos = (battery.switches.discharge ? 1 : 0) | (battery.switches.charge ? 2 : 0);
    const d = [
      ...be(Math.round(mv.reduce((a, b) => a + b, 0) / 10)),
      0,
      0,
      (current >>> 24) & 0xff,
      (current >>> 16) & 0xff,
      (current >>> 8) & 0xff,
      current & 0xff,
      ...be(Math.round(battery.soc * 100)),
      ...be(Math.round(battery.remainingAh * 100)),
      ...be(Math.round(battery.capacityAh * 100)),
      ...be(Math.round(battery.capacityAh * 100)),
      ...be(t(battery.mosTemp)),
      ...be(t(battery.ambient)),
      ...be(op),
      ...be(100),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...be(mos),
      0,
      0,
      ...be(battery.cycles),
      ...be(mv.indexOf(max) + 1),
      ...be(max),
      ...be(mv.indexOf(min) + 1),
      ...be(min),
      ...be(Math.round(mv.reduce((a, b) => a + b, 0) / mv.length)),
      0,
      1,
      ...be(Math.max(...temps)),
      0,
      2,
      ...be(Math.min(...temps)),
      ...be(Math.round(temps.reduce((a, b) => a + b, 0) / temps.length)),
      ...be(584),
      ...be(2000),
      ...be(448),
      ...be(2000),
      ...be(mv.length),
      ...mv.flatMap(be),
      ...be(temps.length),
      ...temps.flatMap(be),
      0,
      0,
      ...be(balance),
      0,
      4,
      ...[...model.padEnd(30, '\0')].map((c) => c.charCodeAt(0) & 0xff),
    ];
    return d;
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    if (frame[1] !== UP_FN.READ || frame[6] !== 0 || frame[7] !== 0) return;
    const start = (frame[2] << 8) | frame[3];
    if (start !== UP_STATUS_START) return;
    send(device, encodeUp(address, UP_FN.READ, UP_STATUS_START, UP_STATUS_END, statusData()));
  };

  const assembler = createUpAssembler({ address, onFrame: handle });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const tickMs = opts.tickMs ?? 1000;
  const stopTimer = tickMs > 0 ? every(() => battery.step(tickMs / 1000), tickMs) : () => {};
  return {
    battery,
    received,
    /** @param {number} [dt] seconds */
    step(dt = 1) {
      battery.step(dt);
    },
    stop() {
      stopTimer();
      off();
    },
  };
}
