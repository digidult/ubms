import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import {
  DEVICE,
  OP,
  PX100,
  PX100_ACK,
  STATUS,
  createDeviceAssembler,
  encodePx100Reply,
  encodeReply,
  encodeReport,
  isCommandFrame,
  isPx100Request,
  parseCommand,
  parsePx100Request,
  px100TimeValue,
} from './protocol.js';

/**
 * Device side of the Atorch protocol (docs/protocols/atorch.md) for the demo mode and tests: a
 * meter that pushes a 36 byte report every `intervalMs`, answers FF 55 commands with 8 byte
 * replies and, as a DL24 electronic load, also answers PX100 frames (`6F` and
 * `CA CB d1 d2 d3 CE CF`). The DL24 discharges a simulated 4S LiFePO4 battery at its set current
 * until the cutoff voltage or the timer stops it; the DC meter watches a battery line built on
 * SimBattery (and like the real ones it sends the current without a sign).
 *
 * @typedef {import('@ubms/transport').Link} Link
 */

const TYPES = Object.freeze({ AC_METER: DEVICE.AC, DC_METER: DEVICE.DC, USB_METER: DEVICE.USB });

/** LiFePO4 open circuit voltage per cell over SOC (%), for the DL24 source. */
const LFP_OCV = [
  [0, 2.6],
  [5, 3.0],
  [10, 3.18],
  [20, 3.24],
  [40, 3.28],
  [60, 3.3],
  [80, 3.33],
  [95, 3.36],
  [100, 3.45],
];

/** @param {number} soc */
function lfpCell(soc) {
  const s = Math.max(0, Math.min(100, soc));
  for (let i = 1; i < LFP_OCV.length; i++) {
    const [s1, v1] = LFP_OCV[i];
    const [s0, v0] = LFP_OCV[i - 1];
    if (s <= s1) return v0 + ((v1 - v0) * (s - s0)) / (s1 - s0);
  }
  return LFP_OCV[LFP_OCV.length - 1][1];
}

/** Small deterministic PRNG (mulberry32). @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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
 * Simulated Atorch meter or DL24 load on the device side of a link.
 * @param {Link} device
 * @param {Object} [opts]
 * @param {'AC_METER'|'DC_METER'|'USB_METER'} [opts.type] device class (default DC_METER; `load` implies DC_METER)
 * @param {boolean} [opts.load] DL24 electronic load
 * @param {boolean} [opts.loadOn] load running at start (default true)
 * @param {number} [opts.loadCurrent] A (default 1.5)
 * @param {number} [opts.cutoffVoltage] V (default 10.5)
 * @param {number} [opts.timer] s (default 0)
 * @param {number} [opts.intervalMs] report period (default 1000); 0 disables the timer, tests call `push()`
 * @param {'valid'|'from3'|'invalid'|number} [opts.checksum] last byte of the reports (default 'valid')
 * @param {boolean} [opts.replies] answer FF 55 commands (default true)
 * @param {number[]} [opts.unsupported] opcodes answered with status 03 (USB default: 0x11, 0x12, 0x21, 0x22 like a UD18)
 * @param {boolean} [opts.applySettings] take backlight and price writes (default true)
 * @param {boolean} [opts.px100] answer PX100 frames (default: when `load`)
 * @param {boolean} [opts.px100Ack] acknowledge PX100 set commands with 6F (default true)
 * @param {number} [opts.backlight] s (default 60)
 * @param {number} [opts.price] per kWh (default 1)
 * @param {number} [opts.temperature] fixed USB meter temperature (default 0, a UD18 has no sensor)
 * @param {number} [opts.seed]
 */
export function createAtorchSimulator(device, opts = {}) {
  const load = !!opts.load;
  const deviceType = load ? DEVICE.DC : TYPES[opts.type ?? 'DC_METER'] ?? DEVICE.DC;
  const usb = deviceType === DEVICE.USB;
  const ac = deviceType === DEVICE.AC;
  const random = rng(opts.seed ?? 24);
  const intervalMs = opts.intervalMs ?? 1000;
  const replies = opts.replies ?? true;
  const applySettings = opts.applySettings ?? true;
  let px100 = opts.px100 ?? load;
  const px100Ack = opts.px100Ack ?? true;
  const unsupported = new Set(opts.unsupported ?? (usb ? [OP.PLUS, OP.MINUS, OP.SET_BACKLIGHT, OP.SET_PRICE] : []));

  const state = {
    deviceType,
    backlight: opts.backlight ?? 60,
    /** @type {number | undefined} */
    price: usb ? undefined : (opts.price ?? 1),
    energy: ac ? 125400 : usb ? 3.67 : 820,
    /** @type {number | undefined} */
    capacity: ac ? undefined : usb ? 0.776 : 12.4,
    runtime: 0,
    temperature: usb ? (opts.temperature ?? 0) : 24,
    voltage: 0,
    current: 0,
    power: 0,
    frequency: 50,
    powerFactor: 0.95,
    dataMinus: 0.6,
    dataPlus: 3.3,
    /** S1-B relay, toggled by opcode 0x02 on AC meters per [BK] (unverified). */
    relayOn: true,
    load: { on: load && (opts.loadOn ?? true), current: opts.loadCurrent ?? 1.5, cutoff: opts.cutoffVoltage ?? 10.5, timer: opts.timer ?? 0 },
  };
  /** Battery under test of the DL24: 4S LiFePO4, 20 Ah, 60 milliohm. */
  const source = { soc: 85, capacityAh: 20, resistance: 0.06 };
  const line = deviceType === DEVICE.DC && !load ? new SimBattery({ cells: 4, capacityAh: 100, chemistry: 'lfp', soc: 64, tempSensors: 1, seed: 5, maxCurrent: 18 }) : null;
  let t = 0;
  /** Frames received from the host, parsed. @type {any[]} */
  const received = [];

  /** @param {number} target @param {number} dt @param {number} tau */
  const heat = (target, dt, tau) => {
    state.temperature += (target - state.temperature) * Math.min(1, dt / tau);
  };

  /** Advance the physics. @param {number} dt seconds */
  function tick(dt) {
    t += dt;
    if (load) {
      const ocv = lfpCell(source.soc) * 4;
      const l = state.load;
      if (l.on && l.timer > 0 && state.runtime >= l.timer) l.on = false;
      let i = l.on ? l.current : 0;
      let v = ocv - i * source.resistance;
      if (l.on && v < l.cutoff) {
        // Cutoff reached: the DL24 stops by itself.
        l.on = false;
        i = 0;
        v = ocv;
      }
      state.voltage = v;
      state.current = i;
      source.soc = Math.max(0, source.soc - ((i * dt) / 3600 / source.capacityAh) * 100);
      if (l.on) state.runtime += dt;
      heat(24 + v * i * 0.55, dt, 40);
    } else if (line) {
      line.step(dt);
      state.voltage = line.voltage;
      state.current = Math.abs(line.current);
      if (state.current > 0) state.runtime += dt;
      heat(23 + state.current * 0.15, dt, 120);
    } else if (ac) {
      const demand = 1.25 + 0.9 * Math.sin(t / 45) + (random() - 0.5) * 0.08;
      state.voltage = 230.5 + 2.2 * Math.sin(t / 17) + (random() - 0.5) * 0.4;
      state.current = state.relayOn ? Math.max(0.05, demand) : 0;
      state.powerFactor = 0.93 + 0.03 * Math.sin(t / 30);
      state.frequency = 50 + 0.03 * Math.sin(t / 11);
      state.power = state.voltage * state.current * state.powerFactor;
      if (state.current > 0) state.runtime += dt;
      heat(29 + state.current * 0.8, dt, 120);
    } else {
      // USB tester on a Quick Charge 2.0 source at 9 V: D- about 0.6 V, D+ about 3.3 V.
      state.voltage = 9.02 + (random() - 0.5) * 0.04;
      state.current = Math.max(0, 1.25 + 0.55 * Math.sin(t / 25) + (random() - 0.5) * 0.04);
      state.dataMinus = 0.6 + (random() - 0.5) * 0.02;
      state.dataPlus = 3.3 + (random() - 0.5) * 0.02;
      state.runtime += dt;
      if (opts.temperature) heat(opts.temperature, dt, 1);
    }
    const p = ac ? state.power : state.voltage * state.current;
    state.energy += (p * dt) / 3600;
    if (state.capacity !== undefined) state.capacity += (state.current * dt) / 3600;
  }

  /** The current report frame. */
  function report() {
    return encodeReport(
      {
        deviceType,
        voltage: state.voltage,
        current: state.current,
        power: state.power,
        energy: state.energy,
        capacity: state.capacity,
        price: state.price,
        frequency: state.frequency,
        powerFactor: state.powerFactor,
        dataMinus: state.dataMinus,
        dataPlus: state.dataPlus,
        temperature: state.temperature,
        runtime: state.runtime,
        backlight: state.backlight,
      },
      { checksum: opts.checksum ?? 'valid' },
    );
  }

  const push = () => send(device, report());
  /** @param {number} status */
  const reply = (status) => send(device, encodeReply(status));
  /** @param {number} value */
  const answer = (value) => send(device, encodePx100Reply(value));
  const ack = () => {
    if (px100Ack) send(device, Uint8Array.of(PX100_ACK));
  };

  /** @param {Uint8Array} frame */
  function onCommand(frame) {
    const c = parseCommand(frame);
    received.push({ ...c, at: Date.now() });
    // What a real meter does with a wrong checksum is not documented; this one ignores the frame.
    if (!replies || !c.checksumValid) return;
    // [LP]: the device type of a command must match the reports.
    if (c.deviceType !== deviceType) return reply(STATUS.FAILED);
    if (unsupported.has(c.command)) return reply(STATUS.UNSUPPORTED);
    switch (c.command) {
      case OP.RESET_ENERGY:
        state.energy = 0;
        break;
      case OP.RESET_CAPACITY:
        if (ac) state.relayOn = !state.relayOn;
        else state.capacity = 0;
        break;
      case OP.RESET_RUNTIME:
        state.runtime = 0;
        break;
      case OP.RESET_ALL:
        state.energy = 0;
        if (state.capacity !== undefined) state.capacity = 0;
        state.runtime = 0;
        break;
      case OP.SET_BACKLIGHT:
        if (c.value > 60) return reply(STATUS.FAILED);
        if (applySettings) state.backlight = c.value;
        break;
      case OP.SET_PRICE:
        if (applySettings) state.price = c.value / 100;
        break;
      case OP.ENTER:
        // The ON/OFF key of the DL24 toggles the load.
        if (load) state.load.on = !state.load.on;
        break;
      case OP.SETUP:
      case OP.PLUS:
      case OP.MINUS:
      case OP.PLUS_USB:
      case OP.MINUS_USB:
        break;
      default:
        return reply(STATUS.UNSUPPORTED);
    }
    reply(STATUS.OK);
  }

  /** @param {Uint8Array} frame */
  function onPx100(frame) {
    const q = parsePx100Request(frame);
    received.push({ ...q, at: Date.now() });
    if (!px100) return;
    const l = state.load;
    switch (q.command) {
      case PX100.LOAD:
        l.on = q.d1 === 1;
        return ack();
      case PX100.SET_CURRENT:
        l.current = q.d1 + q.d2 / 100;
        return ack();
      case PX100.SET_CUTOFF:
        l.cutoff = q.d1 + q.d2 / 100;
        return ack();
      case PX100.SET_TIMER:
        // The load keeps whole minutes ([WH], unverified).
        l.timer = Math.floor(((q.d1 << 8) | q.d2) / 60) * 60;
        return ack();
      case PX100.RESET:
        state.energy = 0;
        if (state.capacity !== undefined) state.capacity = 0;
        state.runtime = 0;
        return ack();
      case PX100.Q_LOAD:
        return answer(l.on ? 1 : 0);
      case PX100.Q_VOLTAGE:
        return answer(state.voltage * 1000);
      case PX100.Q_CURRENT:
        return answer(state.current * 1000);
      case PX100.Q_TIME:
        return answer(px100TimeValue(state.runtime));
      case PX100.Q_CAPACITY:
        return answer((state.capacity ?? 0) * 1000);
      case PX100.Q_ENERGY:
        return answer(state.energy * 1000);
      case PX100.Q_TEMPERATURE:
        return answer(state.temperature);
      case PX100.Q_CURRENT_SETTING:
        return answer(l.current * 100);
      case PX100.Q_CUTOFF_SETTING:
        return answer(l.cutoff * 100);
      case PX100.Q_TIMER_SETTING:
        return answer(px100TimeValue(l.timer));
      default:
        // Invalid commands get no answer ([TS]).
        return undefined;
    }
  }

  const assembler = createDeviceAssembler({
    onFrame: (frame) => {
      if (isCommandFrame(frame)) onCommand(frame);
      else if (isPx100Request(frame)) onPx100(frame);
      else received.push({ unknown: Array.from(frame), at: Date.now() });
    },
  });
  const off = device.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));

  tick(0);
  const dt = intervalMs / 1000;
  const stopTimer =
    intervalMs > 0
      ? every(() => {
          tick(dt);
          push();
        }, intervalMs)
      : () => {};

  return {
    state,
    source,
    received,
    tick,
    report,
    push,
    /**
     * Answer PX100 frames or ignore them from now on (a load that stops answering).
     * @param {boolean} on
     */
    setPx100(on) {
      px100 = on;
    },
    stop() {
      stopTimer();
      off();
    },
  };
}
