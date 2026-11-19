import { SimBattery } from '../common/sim-battery.js';
import { every, r } from '../common/util.js';
import {
  BLOCK,
  CURRENT_ZERO,
  D2_ADDRESS,
  FN,
  REG,
  WRITABLE_REGISTERS,
  createRequestAssembler,
  encodeReadResponse,
  encodeWrite,
  parseRequest,
} from './protocol.js';

/**
 * Device side of a Daly active balancer (docs/protocols/daly-balancer.md) for the demo mode and
 * tests, on top of the protocol independent SimBattery. Register contents follow the captured
 * 16S unit (spec 6.1 to 6.6): fixed BMS fields (current 30000, SOC, capacity, cycles and MOSFETs
 * 0), all current limits 30000, one board temperature, slots 7 and 8 with the total and average
 * voltage, 0xFF filled blocks at 0x0063 and 0x00DF, the reversed version strings and the switch
 * block `00 01 01 00 <cells> <switch> 000A`.
 *
 * Writes: only the four registers ubms writes (spec 7) are applied and echoed; a value outside the
 * documented range is echoed but not applied, so only the read-back shows it. Writes to any other
 * register and 0x10 writes get no answer.
 *
 * Simplifications (simulator choices, not device facts, spec 9.1 and 6.2 are unverified):
 * balancing runs while the switch is on, the highest cell is at or above the start voltage and the
 * difference reaches the start difference; the state register 0x0034 then reads 1, the balance
 * current ramps up to 1 A ((raw - 30000) mA, positive), and energy moves from the highest to the
 * lowest cell; 0x003E / 0x003F flag the two cells involved. The balancer answers after a fixed
 * delay and never sleeps.
 */

/** @typedef {import('@ubms/transport').Link} Link */

/** Register space answered by reads (0x0000..0x00FF). */
const REGISTER_SPACE = 0x100;

/**
 * Write registers into the 16 bit register image as big endian ASCII, NUL padded.
 * @param {Uint16Array} regs
 * @param {number} start
 * @param {number} count registers
 * @param {string} text
 */
function putText(regs, start, count, text) {
  const bytes = Array.from({ length: 2 * count }, (_, i) => (i < text.length ? text.charCodeAt(i) & 0xff : 0));
  for (let i = 0; i < count; i++) regs[start + i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
}

/**
 * @param {Link} link device side of a link
 * @param {Object} [opts]
 * @param {SimBattery} [opts.battery] default: 16S LiFePO4 100 Ah near the top knee with a visible spread
 * @param {number} [opts.stepMs] simulation step (0: no timer, call `step()`)
 * @param {number} [opts.answerDelayMs] turnaround before a reply (the captured unit: 63 to 501 ms)
 * @param {number} [opts.dropFirst] ignore this many first requests (a module that loses the first one)
 * @param {number} [opts.corruptEchoes] send this many write echoes with a wrong CRC (spec 6.7)
 * @param {number} [opts.dropWrites] ignore this many first writes completely (no effect, no echo)
 * @param {(start: number, count: number) => boolean} [opts.ignoreRead] reads that get no answer
 * @param {Record<number, number>} [opts.registers] register overrides (tests: BMS like values)
 * @param {number} [opts.sleepDelay] register 0x008A (default 3600, the factory value)
 */
export function createDalyBalancerSimulator(link, opts = {}) {
  let battery = opts.battery;
  if (!battery) {
    battery = new SimBattery({ cells: 16, capacityAh: 100, chemistry: 'lfp', soc: 93, tempSensors: 1, seed: 29, maxCurrent: 6 });
    // A few cells out of line, so the demo shows the balancer at work.
    battery.cellOffset[3] += 4;
    battery.cellOffset[10] -= 3;
  }
  const sim = battery;
  // SimBattery's own (passive) balancing stays off: this simulator moves the energy.
  sim.switches.balance = false;
  const stepMs = opts.stepMs ?? 500;
  const answerDelayMs = opts.answerDelayMs ?? 80;
  const regs = new Uint16Array(REGISTER_SPACE);
  const cells = sim.cellCount;

  // Settings block, values of the captured unit (spec 6.3), factory start voltage and sleep time.
  regs.set([500, 3200, 1, cells, 6, 6, 1, 1, 1, sim.chemistry === 'nmc' ? 1 : 0, opts.sleepDelay ?? 3600], REG.RATED_CAPACITY);
  regs.set([3550, 3650, 2300, 2200, 0, 0, 5000, 5000], REG.CELL_LIMITS);
  regs.set([CURRENT_ZERO, CURRENT_ZERO, CURRENT_ZERO, CURRENT_ZERO], REG.CURRENT_LIMITS);
  regs.set([40, 125, 40, 0, 40, 125, 40, 0, 0, 0, 0, 0], REG.TEMP_LIMITS);
  regs.set([3300, 20, 0, 0, 0, 87], REG.START_VOLTAGE);
  putText(regs, REG.SOFTWARE_VERSION, 8, 'B002_111132_03');
  putText(regs, REG.SOFTWARE_VERSION + 8, 8, 'E303-032DG-SMB');
  putText(regs, REG.PASSWORD, 3, '123456');
  regs.set([0x0001, 0x0100, cells, 1, 10], REG.PRODUCTION_DATE);
  // Blocks the balancer does not implement (spec 6.6).
  regs.fill(0xffff, 0x0063, 0x0063 + 28);
  regs.fill(0xffff, 0x00df, 0x00df + 17);
  for (const [k, v] of Object.entries(opts.registers ?? {})) regs[Number(k)] = v;
  const overrides = new Set(Object.keys(opts.registers ?? {}).map(Number));

  const state = {
    /** 0 idle, 1 balancing (register 0x0034). */
    balancing: 0,
    /** Balance current, A. */
    current: 0,
    minIndex: 0,
    maxIndex: 0,
    drop: opts.dropFirst ?? 0,
    corruptEchoes: opts.corruptEchoes ?? 0,
    dropWrites: opts.dropWrites ?? 0,
    reads: 0,
    writes: 0,
  };
  /** Every request received, for tests. @type {Uint8Array[]} */
  const received = [];

  /** Write a status register unless a test overrides it. @param {number} reg @param {number} value */
  const put = (reg, value) => {
    if (!overrides.has(reg)) regs[reg] = value & 0xffff;
  };

  /** Advance the simulation. @param {number} dt seconds */
  const step = (dt) => {
    sim.step(dt);
    const v = sim.cellVoltages();
    let min = 0;
    let max = 0;
    v.forEach((x, i) => {
      if (x < v[min]) min = i;
      if (x > v[max]) max = i;
    });
    state.minIndex = min;
    state.maxIndex = max;
    const start = regs[REG.START_VOLTAGE] / 1000;
    const trigger = regs[REG.TRIGGER_DELTA] / 1000;
    const active = regs[REG.SWITCH] === 1 && v[max] >= start && v[max] - v[min] >= trigger;
    if (!active) {
      state.balancing = 0;
      state.current = 0;
      return;
    }
    state.balancing = 1;
    state.current = r(Math.min(1, state.current + 0.4 * Math.max(dt, 0.1)), 3);
    // Charge moved per step, as SOC percent of a cell (the transfer losses are not modelled).
    const soc = ((state.current * dt) / 3600 / sim.capacityAh) * 100;
    sim.cellOffset[max] -= soc;
    sim.cellOffset[min] += soc;
  };

  /** Fill the status and balance registers from the battery (spec 6.1, 6.2). */
  const refreshStatus = () => {
    const v = sim.cellVoltages().map((x) => Math.round(x * 1000));
    for (let i = 0; i < 32; i++) put(REG.CELLS + i, v[i] ?? 0);
    const sum = v.reduce((a, b) => a + b, 0);
    const maxV = Math.max(...v);
    const minV = Math.min(...v);
    const avg = Math.floor(sum / v.length);
    const temp = Math.round(sim.temps[0] ?? sim.ambient) + 40;
    const total = Math.floor(sum / 100);
    put(REG.TEMPERATURES, temp);
    for (let i = 1; i < 6; i++) put(REG.TEMPERATURES + i, 0);
    // Slots 7 and 8 repeat the total and the average cell voltage (spec 12 item 2).
    put(REG.TEMPERATURES + 6, total);
    put(REG.TEMPERATURES + 7, avg);
    put(REG.TOTAL_VOLTAGE, total);
    put(REG.CURRENT, CURRENT_ZERO);
    put(REG.SOC, 0);
    put(REG.CELL_MAX, maxV);
    put(REG.CELL_MIN, minV);
    put(REG.TEMP_MAX, temp);
    put(REG.TEMP_MIN, temp);
    put(REG.CHARGE_STATE, 0);
    put(REG.REMAINING, 0);
    put(REG.CELL_COUNT, v.length);
    put(REG.TEMP_COUNT, 1);
    put(REG.CYCLES, 0);
    put(REG.BALANCING_STATE, state.balancing);
    put(REG.CHARGE_MOS, 0);
    put(REG.DISCHARGE_MOS, 0);
    put(REG.CELL_AVG, avg);
    put(REG.CELL_DELTA, maxV - minV);
    put(REG.POWER, 0);
    let bits = 0;
    if (state.balancing) bits = (1 << state.minIndex) | (1 << state.maxIndex);
    put(REG.BALANCE_BITS, bits & 0xffff);
    put(REG.BALANCE_BITS + 1, (bits >>> 16) & 0xffff);
    put(REG.BALANCE_CURRENT, CURRENT_ZERO + Math.round(state.current * 1000));
    put(REG.MOS_TEMP, 0xffff);
    put(REG.BOARD_TEMP, 0);
  };

  /** @param {Uint8Array} bytes */
  const reply = (bytes) => {
    const send = () => {
      if (link.isOpen) link.write(bytes).catch(() => {});
    };
    if (answerDelayMs > 0) {
      const t = setTimeout(send, answerDelayMs);
      /** @type {any} */ (t).unref?.();
    } else send();
  };

  /**
   * Apply a write when the register is one of the four and the value in range (spec 7).
   * @param {number} register
   * @param {number} value
   */
  const applies = (register, value) => {
    switch (register) {
      case REG.SWITCH:
        return value === 0 || value === 1;
      case REG.START_VOLTAGE:
        return value >= 1500 && value <= 4500;
      case REG.TRIGGER_DELTA:
        return value >= 10 && value <= 1500;
      default:
        return register === REG.SLEEP;
    }
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    if (frame[0] !== D2_ADDRESS) return;
    if (state.drop > 0) {
      state.drop--;
      return;
    }
    const q = parseRequest(frame);
    if (q.function === FN.READ) {
      if (q.count < 1 || q.count > 125 || q.start + q.count > REGISTER_SPACE) return;
      if (opts.ignoreRead?.(q.start, q.count)) return;
      state.reads++;
      if (q.start < BLOCK.STATUS_80.count) refreshStatus();
      reply(encodeReadResponse(regs.subarray(q.start, q.start + q.count)));
    } else if (q.function === FN.WRITE) {
      if (!WRITABLE_REGISTERS.includes(q.register)) return;
      if (state.dropWrites > 0) {
        state.dropWrites--;
        return;
      }
      state.writes++;
      if (applies(q.register, q.value)) regs[q.register] = q.value;
      if (q.register === REG.SWITCH && q.value === 0) {
        state.balancing = 0;
        state.current = 0;
      }
      const echo = encodeWrite(q.register, q.value);
      if (state.corruptEchoes > 0) {
        state.corruptEchoes--;
        echo[echo.length - 1] ^= 0x5a;
      }
      reply(echo);
    }
    // 0x10 writes (the app's clock) get no answer, as in the capture (spec 3.3).
  };

  step(0);
  const assembler = createRequestAssembler({ onFrame: handle });
  const off = link.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const stopTimer = stepMs > 0 ? every(() => step(stepMs / 1000), stepMs) : () => {};

  return {
    battery: sim,
    registers: regs,
    state,
    received,
    /** Advance the simulation by dt seconds (tests without the timer). */
    step,
    stop() {
      stopTimer();
      off();
    },
  };
}
