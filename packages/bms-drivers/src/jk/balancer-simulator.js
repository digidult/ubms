import { SimBattery } from '../common/sim-battery.js';
import { every, r } from '../common/util.js';
import {
  BAL_CMD,
  BAL_DEFAULT_ADDRESS,
  BAL_MAX_CELLS,
  createBalancerRequestAssembler,
  encodeBalancerStatus,
  encodeBalancerWriteAnswer,
  parseBalancerRequest,
} from './balancer-protocol.js';

/**
 * Device side of the RS485 port of a JK-DZ11-B2A24S active balancer (docs/protocols/jk-balancer.md
 * sections 4.2, 6.5, 6.6) for the demo mode and tests, on top of the protocol independent
 * SimBattery. It answers the status request and the four writes of its own address and ignores
 * other addresses (a shared bus). A write outside the range of the vendor document is answered
 * with the value in effect, as that document describes; the alarm byte reads 0x01 like the
 * captured unit (spec 9.2).
 *
 * Simplifications (not device facts): while the cell difference reaches the trigger voltage the
 * balancer alternates every few seconds between taking energy from the highest cell and giving
 * it to the lowest cell, with a current that ramps up to the maximum balance current (at most
 * 2 A); a wrong cell count stops balancing; the maximum balance current accepts 30 to 2000 mA
 * (a 2 A model); the temperature probe follows the simulated battery temperature.
 */

/** @typedef {import('@ubms/transport').Link} Link */

/** Seconds per balancing direction (simulator choice). */
const DIRECTION_S = 3;

/**
 * @param {Link} link device side of a link
 * @param {Object} [opts]
 * @param {number} [opts.address] RS485 address (default 1)
 * @param {SimBattery} [opts.battery] default: 16S LFP 280 Ah with a visible cell spread
 * @param {number} [opts.stepMs] simulation step (0: no timer, call `step()`)
 * @param {number} [opts.answerDelayMs] turnaround before an answer (the device answers within 1 s)
 * @param {number} [opts.maxCurrentLimitMa] highest maximum balance current accepted, mA (default
 *   2000; the vendor document says 1000)
 */
export function createJkBalancerRs485Simulator(link, opts = {}) {
  const address = opts.address ?? BAL_DEFAULT_ADDRESS;
  const maxCurrentLimitMa = opts.maxCurrentLimitMa ?? 2000;
  let battery = opts.battery;
  if (!battery) {
    battery = new SimBattery({ cells: 16, capacityAh: 280, chemistry: 'lfp', soc: 64, tempSensors: 1, seed: 11, maxCurrent: 40 });
    // A few cells out of line, so the demo shows the balancer at work.
    battery.cellOffset[4] += 9;
    battery.cellOffset[11] -= 7;
  }
  const sim = battery;
  // SimBattery's own (passive) balancing stays off: this simulator moves the energy.
  sim.switches.balance = false;
  const stepMs = opts.stepMs ?? 500;
  const answerDelayMs = opts.answerDelayMs ?? 40;
  const state = {
    cellCount: Math.min(sim.cellCount, BAL_MAX_CELLS),
    triggerMv: 5,
    maxCurrentMa: 2000,
    switchOn: true,
    /** 0 idle, 1 energy into the lowest cell, 2 out of the highest cell (spec 9.1). */
    action: 0,
    actionTime: 0,
    /** Balance current, A, unsigned as on the wire. */
    current: 0,
    minIndex: 0,
    maxIndex: 0,
    statusAnswers: 0,
  };
  /** Every request received, for tests. @type {Uint8Array[]} */
  const received = [];

  /** Cell voltages of the configured cells, 0 V where no cell is wired. */
  const configuredCells = () => {
    const wired = sim.cellVoltages();
    return Array.from({ length: state.cellCount }, (_, i) => wired[i] ?? 0);
  };

  /** @param {number[]} cells */
  const updateIndexes = (cells) => {
    let min = 0;
    let max = 0;
    cells.forEach((v, i) => {
      if (v < cells[min]) min = i;
      if (v > cells[max]) max = i;
    });
    state.minIndex = min;
    state.maxIndex = max;
    return cells.length ? cells[max] - cells[min] : 0;
  };

  /** Advance the simulation. @param {number} dt seconds */
  const step = (dt) => {
    sim.step(dt);
    const delta = updateIndexes(configuredCells());
    const active = state.switchOn && state.cellCount === sim.cellCount && delta * 1000 >= state.triggerMv;
    if (!active) {
      state.action = 0;
      state.actionTime = 0;
      state.current = 0;
      return;
    }
    state.actionTime += dt;
    if (state.action === 0 || state.actionTime >= DIRECTION_S) {
      state.action = state.action === 2 ? 1 : 2;
      state.actionTime = 0;
    }
    const limit = Math.min(state.maxCurrentMa / 1000, 2);
    state.current = r(Math.min(limit, state.current + limit * 0.4 * Math.max(dt, 0.1)), 3);
    // Charge moved per step, as SOC percent of the cell (the capacitor itself is not modelled).
    const soc = ((state.current * dt) / 3600 / sim.capacityAh) * 100;
    if (state.action === 2) sim.cellOffset[state.maxIndex] -= soc;
    else sim.cellOffset[state.minIndex] += soc;
  };

  const status = () => {
    const cells = configuredCells();
    const sum = cells.reduce((a, b) => a + b, 0);
    const max = Math.max(...cells);
    const min = Math.min(...cells);
    state.statusAnswers++;
    return encodeBalancerStatus({
      address,
      totalVoltage: r(sum, 2),
      cellVoltageAverage: r(sum / Math.max(1, cells.length), 3),
      cellCountDetected: sim.cellCount,
      cellVoltageMaxIndex: state.maxIndex,
      cellVoltageMinIndex: state.minIndex,
      balanceStatus: state.action === 1 ? 0x01 : state.action === 2 ? 0x02 : 0,
      alarmBitmask: 0x01,
      cellVoltageDelta: r(max - min, 3),
      balanceCurrent: state.current,
      balanceTriggerVoltage: state.triggerMv / 1000,
      maxBalanceCurrent: state.maxCurrentMa / 1000,
      balancerSwitch: state.switchOn,
      cellCount: state.cellCount,
      cellVoltages: cells,
      temperatureRaw: Math.round((sim.temps[0] ?? sim.ambient) * 10),
    });
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
   * Apply a write when the value is in range and answer with the value in effect (spec 6.6).
   * @param {number} command
   * @param {number} value
   */
  const write = (command, value) => {
    switch (command) {
      case BAL_CMD.CELL_COUNT:
        if (value >= 2 && value <= BAL_MAX_CELLS) state.cellCount = value;
        return state.cellCount;
      case BAL_CMD.TRIGGER:
        if (value >= 2 && value <= 1000) state.triggerMv = value;
        return state.triggerMv;
      case BAL_CMD.MAX_CURRENT:
        if (value >= 30 && value <= maxCurrentLimitMa) state.maxCurrentMa = value;
        return state.maxCurrentMa;
      default:
        if (value <= 1) state.switchOn = value === 1;
        return state.switchOn ? 1 : 0;
    }
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    received.push(frame);
    const q = parseBalancerRequest(frame);
    if (q.address !== address) return;
    if (q.function === BAL_CMD.STATUS) reply(status());
    else if ([BAL_CMD.CELL_COUNT, BAL_CMD.TRIGGER, BAL_CMD.MAX_CURRENT, BAL_CMD.SWITCH].includes(q.function)) {
      reply(encodeBalancerWriteAnswer(address, q.function, write(q.function, q.value)));
    }
  };

  updateIndexes(configuredCells());
  const assembler = createBalancerRequestAssembler({ onFrame: handle });
  const off = link.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const stopTimer = stepMs > 0 ? every(() => step(stepMs / 1000), stepMs) : () => {};

  return {
    battery: sim,
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
