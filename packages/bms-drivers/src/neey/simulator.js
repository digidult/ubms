import { sum8, u16le, xor8 } from '@ubms/transport';
import { SimBattery } from '../common/sim-battery.js';
import { every, r } from '../common/util.js';
import {
  COMMAND,
  FUNCTION,
  MAX_CELLS,
  REGISTER,
  STATUS,
  VARIANT,
  balancerRating,
  createRequestAssembler,
  encodeAck,
  encodeCellInfo,
  encodeDeviceInfo,
  encodeFactory,
  encodeFactoryEcho,
  encodeSettingsV1,
  encodeSettingsV2,
  parseRequest,
} from './protocol.js';

/**
 * Device side of a NEEY active balancer (docs/protocols/neey.md, "spec" below) for the demo mode
 * and tests, on top of the protocol independent SimBattery. It speaks the real frames:
 *
 * - answers the device info (0x01), factory (0x03) and settings (0x04) read requests; the
 *   settings request starts the cell info stream (spec 4.1);
 * - answers the cell info request (0x02) with one frame while the stream is stopped and with
 *   nothing extra while it runs (in [SYC] gw-24s4eb-sw110 the requests at 65.9 s and 86.6 s
 *   brought no extra frame); whether 0x02 restarts a stopped stream is not documented (spec
 *   4.2), so it does so only with `cellRequestStartsStream`;
 * - accepts writes of command 0x05 with an acknowledgement (spec 6.7) and applies the registers
 *   the spec lists as writable: the balancer switch on both variants, the balancer values on
 *   NEEY_V1;
 * - `firmware: 'ek'` (default) answers only sum8 requests with the length `14 00`, echoes the
 *   written value in the acknowledgement and pushes a settings frame `settingsPushDelayMs` after
 *   a write (default 430 ms, measured on the EK-B24S8E200A in [HA#670]; no timing is captured
 *   for NEEY_V1 EK units); NEEY_V2 sends every acknowledgement twice about 0.2 s apart as in
 *   [HA#670] (`duplicateAck`). `'gw'` (GW-24S4EB SW-1.1.0) answers both length forms,
 *   acknowledges with zero value bytes and pushes nothing (spec 3.4, 4.3, 6.7). Its checksum
 *   forms are `checksums`, default sum8 and xor8: every request seen reaching SW-1.1.0 used xor8
 *   and its sum8 support is an assumption (unverified, spec 3.4); `checksums: ['xor8']` models a
 *   unit without it. Malformed and foreign requests get no answer (spec 3.4).
 *
 * Simplifications (not device facts): while the switch is on, the cells are above the sleep and
 * start voltages and the cell difference reaches the trigger voltage, the balancer alternates
 * every frame between taking energy from the highest cell (negative current) and giving it to the
 * lowest cell (positive current), with a current that ramps up to the maximum balance current; on
 * NEEY_V2 the lower of the two voltages at settings offsets 22 and 26 (labels unverified, spec
 * 6.3) serves as both thresholds; a configured cell count that differs from the wired cells
 * reports status 0x01; out of range writes are acknowledged but not applied; command 0x06 (NEEY_V2
 * limits, unverified) and the registers without a capture are acknowledged and ignored; the
 * detection mask sets the bits of the unused slots as several units do (spec 9.2).
 */

/** @typedef {import('@ubms/transport').Link} Link */

/** Firmware identities by variant and firmware type (from the vectors). */
const IDENTITY = {
  ek: { model: 'EK-24S4EB', hardwareVersion: 'HW-3.2.0', softwareVersion: 'ZH-2.1.1', protocolVersion: 'V1.3.13', manufacturingDate: '20260201', identifier: 'C1B201513338123456' },
  gw: { model: 'GW-24S4EB', hardwareVersion: 'HW-2.8.0', softwareVersion: 'SW-1.1.0', protocolVersion: 'V1.0.0', manufacturingDate: '20210915', identifier: '' },
  v2: {
    model: 'EK-B24S8E200A',
    hardwareVersion: 'HW-2.0.0',
    softwareVersion: 'SW-2.0.0',
    protocolVersion: 'V1.3.36',
    manufacturingDate: '20251015',
    identifier: '440501043933123456',
    modelAlias: 'EK-24S200A',
  },
};

/**
 * @param {Link} link device side of a link
 * @param {Object} [opts]
 * @param {string} [opts.variant] VARIANT value (default NEEY_V1)
 * @param {'ek'|'gw'} [opts.firmware] default 'ek'
 * @param {Partial<Record<string, any>>} [opts.identity] device info overrides (model, versions ...)
 * @param {Partial<Record<string, any>>} [opts.settings] settings overrides (parser field names)
 * @param {SimBattery} [opts.battery] default: 16S LFP with a visible cell spread
 * @param {number} [opts.intervalMs] cell info stream interval (default 500, spec 4.2)
 * @param {number} [opts.stepMs] simulation step (0: no timer, call `step()`)
 * @param {number} [opts.answerDelayMs] turnaround before an answer (about 30 to 80 ms, spec 4.4)
 * @param {boolean} [opts.streaming] stream from the start, as after an earlier session
 * @param {boolean} [opts.unusedSlotBits] set the detection bits of unused slots (default true)
 * @param {Array<'sum8'|'xor8'>} [opts.checksums] request checksums of 'gw' firmware (default both)
 * @param {number} [opts.settingsPushDelayMs] 'ek' firmware: settings push after a write (430)
 * @param {boolean} [opts.duplicateAck] send every acknowledgement twice (default: NEEY_V2 only)
 * @param {boolean} [opts.cellRequestStartsStream] the cell info request restarts a stopped stream
 */
export function createNeeySimulator(link, opts = {}) {
  const variant = opts.variant === VARIANT.V2 ? VARIANT.V2 : VARIANT.V1;
  const firmware = opts.firmware === 'gw' ? 'gw' : 'ek';
  const checksums = new Set(opts.checksums ?? ['sum8', 'xor8']);
  const settingsPushDelayMs = opts.settingsPushDelayMs ?? 430;
  const duplicateAck = opts.duplicateAck ?? variant === VARIANT.V2;
  const identity = { ...(variant === VARIANT.V2 ? IDENTITY.v2 : IDENTITY[firmware]), powerOnCount: 6, totalRuntime: 127854, ...(opts.identity ?? {}) };
  const rating = balancerRating(identity.model);
  let battery = opts.battery;
  if (!battery) {
    battery = new SimBattery({ cells: 16, capacityAh: variant === VARIANT.V2 ? 320 : 280, chemistry: 'lfp', soc: 72, tempSensors: 2, seed: 23, maxCurrent: 40 });
    // A few cells out of line, so the demo shows the balancer at work.
    battery.cellOffset[3] += 8;
    battery.cellOffset[12] -= 6;
  }
  const sim = battery;
  // SimBattery's own (passive) balancing stays off: this simulator moves the energy.
  sim.switches.balance = false;
  const intervalMs = opts.intervalMs ?? 500;
  const stepMs = opts.stepMs ?? 500;
  const answerDelayMs = opts.answerDelayMs ?? 30;
  const gw110 = firmware === 'gw' && /^SW-1\.1\.0$/.test(identity.softwareVersion);

  /** Settings with parser field names of both layouts (spec 6.2, 6.3). */
  const settings = {
    cellCount: Math.min(sim.cellCount, MAX_CELLS),
    balanceTriggerVoltage: 0.005,
    maxBalanceCurrent: Math.min(4, rating),
    balanceStopVoltage: 3.0,
    balancerSwitch: true,
    buzzerMode: 1,
    batteryType: 2,
    nominalCapacity: sim.capacityAh,
    balanceStartVoltage: gw110 ? 0 : 3.2,
    byte32: firmware === 'ek' ? 1 : 0,
    balanceStopDiffVoltage: firmware === 'ek' ? 0.003 : 0,
    float37: firmware === 'ek' ? 1.5 : 0,
    // NEEY_V2 only (values of the vector rx-v2-settings).
    byte8: 2,
    float18: 0.001,
    cellOvp: 3.65,
    cellOvpr: 3.55,
    cellUvp: 2.6,
    cellUvpr: 2.9,
    cellDiffProtection: 1,
    cellDiffRecovery: 0.7,
    cellShutdownVoltage: 2,
    chargeOcp: 170,
    chargeOcpDelay: 5,
    chargeOcpRecovery: 300,
    dischargeOcp: 200,
    dischargeOcpDelay: 5,
    dischargeOcpRecovery: 120,
    dischargeOcp2: 400,
    dischargeOcp2Delay: 1000,
    dischargeOcp2Recovery: 120,
    scpCurrent: 800,
    scpDelay: 500,
    scpRecovery: 0,
    chargeOtp: 60,
    chargeOtpr: 50,
    chargeUtp: -2,
    chargeUtpr: 2,
    dischargeOtp: 60,
    dischargeOtpr: 50,
    dischargeUtp: -10,
    dischargeUtpr: -5,
    byte126: 1,
    byte127: 1,
    byte129: 1,
    ...(variant === VARIANT.V2 ? { balanceTriggerVoltage: 0.003, maxBalanceCurrent: 8 } : {}),
    ...(opts.settings ?? {}),
  };
  if (variant === VARIANT.V2) {
    // The pair of the captures rx-v2-settings-balancer-on / -off ([HA#670] 2026-04-07).
    settings.float22 ??= 3.25;
    settings.float26 ??= 3.15;
  }
  /** V2 threshold: the lower of the voltages at offsets 22 and 26 (labels unverified, spec 6.3). */
  const v2Threshold = () => Math.min(settings.float22, settings.float26);
  /** Sleep and start voltage of the layout in use. */
  const sleepVoltage = () => (variant === VARIANT.V2 ? v2Threshold() : settings.balanceStopVoltage);
  const startVoltage = () => (variant === VARIANT.V2 ? v2Threshold() : settings.balanceStartVoltage);

  const state = {
    status: /** @type {number} */ (STATUS.SYSTEM_TEST_DONE),
    /** Signed balance current, A: negative out of the highest cell, positive into the lowest (spec 6.4). */
    current: 0,
    magnitude: 0,
    minIndex: 0,
    maxIndex: 0,
    frameCounter: 0,
    uptime: 4 * 3600 + 17,
    streaming: !!opts.streaming,
    cellFrames: 0,
    settingsFrames: 0,
    writes: 0,
  };
  /** Every request received (parsed), for tests. @type {Array<Record<string, any>>} */
  const received = [];
  /** Requests dropped without an answer (wrong checksum or length), for tests. @type {Uint8Array[]} */
  const ignored = [];
  /** Read commands that get no answer although they are received (tests). @type {Set<number>} */
  const mute = new Set();
  /** Resistance of the sense wires, ohm (0.07 to 0.20 in the vectors). */
  const leads = Array.from({ length: MAX_CELLS }, (_, i) => (i < sim.cellCount ? 0.07 + ((i * 37) % 13) / 100 : 0));

  /** Voltages of the 24 slots: wired cells up to the configured count, 0 elsewhere. */
  const slots = () => {
    const wired = sim.cellVoltages();
    const n = Math.min(settings.cellCount, MAX_CELLS);
    return Array.from({ length: MAX_CELLS }, (_, i) => (i < n ? wired[i] ?? 0 : 0));
  };

  /** @param {number[]} cells */
  const extremes = (cells) => {
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
    state.uptime += dt;
    const n = Math.min(settings.cellCount, sim.cellCount);
    const cells = sim.cellVoltages().slice(0, n);
    const delta = extremes(cells);
    const min = Math.min(...cells);
    const max = Math.max(...cells);
    let status = STATUS.BALANCING_FINISHED;
    if (!settings.balancerSwitch) status = STATUS.SYSTEM_TEST_DONE;
    else if (settings.cellCount !== sim.cellCount) status = STATUS.WRONG_CELL_COUNT;
    else if (min < sleepVoltage() || max < startVoltage()) status = STATUS.BATTERY_LOW;
    else if (delta >= settings.balanceTriggerVoltage) status = STATUS.BALANCING;
    state.status = status;
    if (status !== STATUS.BALANCING) {
      state.magnitude = 0;
      state.current = 0;
      return;
    }
    const limit = Math.max(0, settings.maxBalanceCurrent);
    state.magnitude = Math.min(limit, state.magnitude + limit * 0.5 * Math.max(dt, 0.1));
    // The sign alternates between frames (spec 6.4, 12 item 16).
    state.current = state.current < 0 ? state.magnitude : -state.magnitude;
    const soc = ((state.magnitude * dt) / 3600 / sim.capacityAh) * 100;
    if (state.current < 0) sim.cellOffset[state.maxIndex] -= soc;
    else sim.cellOffset[state.minIndex] += soc;
  };

  const deviceInfo = () => encodeDeviceInfo(identity);
  const settingsFrame = () => {
    state.settingsFrames++;
    return variant === VARIANT.V2 ? encodeSettingsV2(settings) : encodeSettingsV1(settings);
  };

  const cellInfo = () => {
    const cellSlots = slots();
    const n = Math.min(settings.cellCount, MAX_CELLS);
    const cells = cellSlots.slice(0, n);
    const sum = cells.reduce((a, b) => a + b, 0);
    extremes(cells);
    const board = r((sim.temps[0] ?? sim.ambient) + 2 + (Math.abs(state.current) / Math.max(1, rating)) * 12, 2);
    const unused = opts.unusedSlotBits === false || n >= MAX_CELLS ? 0 : 0xffffff & ~((1 << n) - 1);
    state.frameCounter = (state.frameCounter + 1) % 255;
    state.cellFrames++;
    return encodeCellInfo(
      {
        frameCounter: state.frameCounter,
        cellSlots,
        resistanceSlots: leads,
        totalVoltage: sum,
        cellVoltageAverage: n ? sum / n : 0,
        cellVoltageDelta: n ? Math.max(...cells) - Math.min(...cells) : 0,
        cellVoltageMaxIndex: state.maxIndex,
        cellVoltageMinIndex: state.minIndex,
        operationStatus: state.status,
        balanceCurrent: state.current,
        temperature1: board,
        temperature2: board,
        current: sim.current,
        temperatureMos: sim.mosTemp,
        temperatureBalancer: board,
        nominalCapacity: sim.capacityAh,
        capacityRemaining: sim.remainingAh,
        soc: sim.soc,
        float254: sim.capacityAh,
        float262: 5.36,
        cellDetectionFailedMask: unused,
        uptime: Math.floor(state.uptime),
        ...(variant === VARIANT.V2 ? { temperature1: sim.temps[0] ?? sim.ambient, temperature2: sim.temps[1] ?? sim.ambient } : {}),
      },
      variant,
    );
  };

  /** @param {Uint8Array} bytes @param {number} [delay] */
  const reply = (bytes, delay = answerDelayMs) => {
    const send = () => {
      if (link.isOpen) link.write(bytes).catch(() => {});
    };
    if (delay > 0) {
      const t = setTimeout(send, delay);
      /** @type {any} */ (t).unref?.();
    } else send();
  };

  /** @type {(() => void) | null} */
  let streamTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let firstTimer = null;
  /** Start the cell info stream: first frame about 80 ms after the answer (spec 4.1 step 4). */
  const startStream = () => {
    state.streaming = true;
    if (streamTimer || firstTimer) return;
    firstTimer = setTimeout(() => {
      firstTimer = null;
      if (!state.streaming) return;
      reply(cellInfo(), 0);
      streamTimer = every(() => {
        if (state.streaming) reply(cellInfo(), 0);
      }, intervalMs);
    }, answerDelayMs + 80);
    /** @type {any} */ (firstTimer).unref?.();
  };
  const haltStream = () => {
    state.streaming = false;
    if (firstTimer) clearTimeout(firstTimer);
    firstTimer = null;
    streamTimer?.();
    streamTimer = null;
  };

  /**
   * Apply a write of command 0x05 (spec 5.2). Out of range values are kept unchanged.
   * @param {number} register
   * @param {number} value u32 or float32 by register
   */
  const write = (register, value) => {
    state.writes++;
    /** @param {number} lo @param {number} hi */
    const inRange = (lo, hi) => Number.isFinite(value) && value >= lo - 1e-6 && value <= hi + 1e-6;
    if (register === REGISTER.BALANCER_SWITCH) {
      if (value === 0 || value === 1) settings.balancerSwitch = value === 1;
      return;
    }
    // NEEY_V2 balancer registers of command 0x05 are not captured (spec 5.3): ignored here.
    if (variant === VARIANT.V2) return;
    switch (register) {
      case REGISTER.TRIGGER_DELTA:
        if (inRange(0.001, 1)) settings.balanceTriggerVoltage = value;
        break;
      case REGISTER.MAX_CURRENT:
        if (inRange(1, rating)) settings.maxBalanceCurrent = value;
        break;
      case REGISTER.SLEEP_VOLTAGE:
        if (inRange(1, 4.5)) settings.balanceStopVoltage = value;
        break;
      case REGISTER.START_VOLTAGE:
        // GW SW-1.1.0 has no start voltage (spec 6.2).
        if (!gw110 && inRange(1, 4.5)) settings.balanceStartVoltage = value;
        break;
      case REGISTER.NOMINAL_CAPACITY:
        if (Number.isInteger(value) && inRange(1, 2000)) settings.nominalCapacity = value;
        break;
      default:
      // Registers without a capture (cell count, buzzer, battery type, stop difference, name)
      // and the factory registers: acknowledged, not applied.
    }
  };

  /** @param {Uint8Array} frame */
  const accepted = (frame) => {
    const ok8 = sum8(frame, 0, 18) === frame[18];
    if (firmware === 'ek') return ok8 && u16le(frame, 6) === 20;
    // GW firmware: both length forms; xor8 as captured, sum8 by assumption (spec 3.4).
    return (checksums.has('sum8') && ok8) || (checksums.has('xor8') && xor8(frame, 0, 18) === frame[18]);
  };

  /** @param {Uint8Array} frame */
  const handle = (frame) => {
    if (!accepted(frame)) {
      ignored.push(frame);
      return;
    }
    const q = parseRequest(frame);
    received.push(q);
    if (q.function === FUNCTION.READ) {
      if (mute.has(q.command)) return;
      switch (q.command) {
        case COMMAND.DEVICE_INFO:
          reply(deviceInfo());
          break;
        case COMMAND.CELL_INFO:
          // The running stream brings the next frame; a stopped one gets a single frame.
          if (!state.streaming) reply(cellInfo());
          if (opts.cellRequestStartsStream) startStream();
          break;
        case COMMAND.FACTORY:
          reply(encodeFactoryEcho());
          reply(factoryFrame(0), answerDelayMs + 20);
          reply(factoryFrame(1), answerDelayMs + 40);
          break;
        case COMMAND.SETTINGS:
          reply(settingsFrame());
          startStream();
          break;
        default:
      }
      return;
    }
    if (q.function !== FUNCTION.WRITE || (q.command !== COMMAND.WRITE && q.command !== COMMAND.WRITE_V2)) return;
    if (q.command === COMMAND.WRITE) write(q.register, q.value);
    const ack = encodeAck(q.command, q.register, firmware === 'ek' ? frame.subarray(8, 18) : undefined);
    reply(ack);
    // [HA#670]: every acknowledgement twice, 0.18 to 0.21 s apart.
    if (duplicateAck) reply(ack, answerDelayMs + 200);
    // EK firmware and the EK-B24S8E200A push a settings frame after a write (spec 4.3 step 3);
    // the frame holds the values at the time of the push.
    if (firmware === 'ek') {
      const t = setTimeout(() => reply(settingsFrame(), 0), Math.max(answerDelayMs, settingsPushDelayMs));
      /** @type {any} */ (t).unref?.();
    }
  };

  /** Factory data frames (values of the vector rx-gw-zh123-factory-defaults). @param {number} k */
  const factoryFrame = (k) =>
    encodeFactory({
      standardVoltage1: 1.4986 + k * 0.0001,
      standardVoltage2: 1.4984,
      batteryVoltage1: 3.3205 + k * 0.0004,
      batteryVoltage2: 3.8,
      standardCurrent1: 1.7168 + k * 0.0002,
      standardCurrent2: 1.7178,
      superBat1: 1.8815 + k * 0.001,
      superBat2: 0,
      resistor1: 1,
      batteryStatus: 1.65,
      maxVoltage: 1.645,
      minVoltage: 1.46,
      maxTemperature: 85,
      minTemperature: 65,
      powerOnCount: identity.powerOnCount,
      totalRuntime: identity.totalRuntime,
      productionDate: identity.manufacturingDate,
    });

  step(0);
  const assembler = createRequestAssembler({ onFrame: handle });
  const off = link.on('data', (/** @type {Uint8Array} */ chunk) => assembler.push(chunk));
  const stopTimer = stepMs > 0 ? every(() => step(stepMs / 1000), stepMs) : () => {};
  if (state.streaming) startStream();

  return {
    battery: sim,
    settings,
    identity,
    state,
    received,
    ignored,
    /** Read commands to leave unanswered (tests), e.g. `mute.add(COMMAND.SETTINGS)`. */
    mute,
    /** Advance the simulation by dt seconds (tests without the timer). */
    step,
    /** Start or stop the cell info stream (tests). @param {boolean} on */
    setStreaming(on) {
      if (on) startStream();
      else haltStream();
    },
    /** Encoders of the current state (tests). */
    frames: { deviceInfo, settings: settingsFrame, cellInfo },
    stop() {
      haltStream();
      stopTimer();
      off();
    },
  };
}
