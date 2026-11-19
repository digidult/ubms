import { asciiBytes, formatSlcanFrame, setU16be, setU16le, setU32le } from '@ubms/transport';
import { SimBattery } from '../common/sim-battery.js';
import { every } from '../common/util.js';
import {
  CMD,
  DEFAULT_ADDRESS,
  cipherBlock,
  createAa55Assembler,
  decryptRequest,
  encodeCipher,
  encodeFrame,
  encryptAnswer,
  isValidFrame,
  parseHandshake,
  sessionKey,
} from './protocol.js';
import { PACK_BASE } from './can.js';

/**
 * Device side of the three Deye links for the demo mode and the tests
 * (docs/protocols/deye.md): the pack answering AA 55 reads on RS485, the encrypted Bluetooth
 * session of an SE-F pack, and an SLCAN USB-CAN adapter on the PCS bus of a bank. Values come
 * from SimBattery; layouts follow the captures.
 */

/** Advertised name of the demo pack (the session key derives from it). */
export const DEMO_BLE_NAME = 'BAT00000000000001 (demo)';

/**
 * @typedef {Object} PackConfig
 * @property {number} [address]
 * @property {string} [software] 0x01 software version
 * @property {string} [hardware] 0x01 hardware version
 * @property {number} [currentOffset] 3000 (LVESS02) or 30000 (LVESS15)
 * @property {61|65} [mainLength]
 * @property {number} [batteryType]
 * @property {number} [tempSensors]
 * @property {number} [chargeLimit] A
 * @property {number} [dischargeLimit] A
 * @property {boolean} [boardSensor]
 * @property {number} [tickMs] simulation step, 0 for none (tests)
 * @property {SimBattery} [battery]
 */

/** @param {SimBattery} bat @param {number} tickMs */
function attachBattery(bat, tickMs) {
  return tickMs > 0 ? every(() => bat.step(tickMs / 1000), tickMs) : () => {};
}

/**
 * Builds the AA 55 answers of one pack.
 * @param {SimBattery} bat
 * @param {Required<Omit<PackConfig, 'battery'|'tickMs'>>} cfg
 */
function packAnswers(bat, cfg) {
  let life = 0;
  /** Bytes forced by a test: the 12 alarm bytes of 0x02. */
  const overrides = { /** @type {number[] | null} */ alarmBytes: null, /** @type {number | null} */ currentRaw: null };

  const main = () => {
    const d = new Uint8Array(cfg.mainLength);
    const soc10 = Math.round(bat.soc * 10);
    setU16be(d, 0, 0);
    setU16be(d, 2, soc10);
    setU16be(d, 4, 1000);
    d[6] = Math.round(bat.mosTemp) + 40;
    d[7] = cfg.boardSensor ? Math.round(bat.ambient) + 40 : 0;
    d[8] = 0;
    setU16be(d, 9, bat.cycles);
    setU16be(d, 12, Math.round(cfg.chargeLimit * 10));
    setU16be(d, 14, Math.round(cfg.dischargeLimit * 10));
    d[18] = 0x0f;
    setU16be(d, 19, Math.round(bat.voltage * 10));
    setU16be(d, 21, overrides.currentRaw ?? Math.round(bat.current * 10) + cfg.currentOffset);
    setU16be(d, 23, soc10);
    // Bit order of the MOSFET byte is unverified (spec 9.5); the simulator uses bit 0 = charge.
    d[25] = (bat.switches.charge ? 1 : 0) | (bat.switches.discharge ? 2 : 0);
    d[26] = cfg.batteryType;
    d[27] = life++ & 0xff;
    d[28] = cfg.tempSensors;
    d[29] = bat.cellCount;
    d.set(asciiBytes(cfg.software, 16), 30);
    d.set(asciiBytes(cfg.hardware.padEnd(14, ' '), 14), 46);
    d[60] = bat.current > 0.15 ? 1 : bat.current < -0.15 ? 2 : 0;
    if (cfg.mainLength === 65) d[61] = 1;
    return d;
  };

  const temps = () => {
    const t = Array.from({ length: cfg.tempSensors }, (_, i) => Math.round(bat.temps[i % bat.temps.length] + (i >= bat.temps.length ? 0.5 : 0)));
    const max = Math.max(...t);
    const min = Math.min(...t);
    const d = new Uint8Array(21);
    d[0] = max + 40;
    d[1] = t.indexOf(max) + 1;
    d[2] = min + 40;
    d[3] = t.indexOf(min) + 1;
    d[4] = max - min;
    t.forEach((v, i) => (d[5 + i] = v + 40));
    return d;
  };

  const cells = () => {
    const v = bat.cellVoltages().map((x) => Math.round(x * 1000));
    const max = Math.max(...v);
    const min = Math.min(...v);
    const d = new Uint8Array(72);
    setU16be(d, 0, max);
    d[2] = v.indexOf(max) + 1;
    setU16be(d, 3, min);
    d[5] = v.indexOf(min) + 1;
    setU16be(d, 6, max - min);
    v.forEach((x, i) => setU16be(d, 8 + 2 * i, x));
    return d;
  };

  /**
   * Answer frame of a request frame, or null (wrong address, not a request, unknown command).
   * @param {Uint8Array} f
   */
  const answer = (f) => {
    if (!isValidFrame(f) || f[4] !== 0 || f[2] !== cfg.address) return null;
    switch (f[3]) {
      case CMD.MAIN:
        return encodeFrame(cfg.address, CMD.MAIN, main());
      case CMD.ALARMS:
        return encodeFrame(cfg.address, CMD.ALARMS, overrides.alarmBytes ?? new Uint8Array(12));
      case CMD.TEMPERATURES:
        return encodeFrame(cfg.address, CMD.TEMPERATURES, temps());
      case CMD.CELLS:
        return encodeFrame(cfg.address, CMD.CELLS, cells());
      case CMD.EXTENDED:
        return encodeFrame(cfg.address, CMD.EXTENDED, new Uint8Array(64));
      default:
        return null;
    }
  };
  return { answer, overrides };
}

/** @param {PackConfig} cfg */
function packConfig(cfg) {
  return {
    address: cfg.address ?? DEFAULT_ADDRESS,
    software: cfg.software ?? 'LVESS0223526N03',
    hardware: cfg.hardware ?? 'LVESS02_V1',
    currentOffset: cfg.currentOffset ?? 3000,
    mainLength: cfg.mainLength ?? 61,
    batteryType: cfg.batteryType ?? 3,
    tempSensors: cfg.tempSensors ?? 6,
    chargeLimit: cfg.chargeLimit ?? 40,
    dischargeLimit: cfg.dischargeLimit ?? 100,
    boardSensor: cfg.boardSensor ?? true,
  };
}

/**
 * Pack on RS485 (9600 8N1): answers AA 55 reads addressed to it, ignores everything else.
 * @param {import('@ubms/transport').Link} link device side of a link pair
 * @param {PackConfig} [opts]
 */
export function createDeyeRs485Simulator(link, opts = {}) {
  const bat = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 100, tempSensors: 6, soc: 76, seed: 23, maxCurrent: 40 });
  const cfg = packConfig(opts);
  const { answer, overrides } = packAnswers(bat, cfg);
  const state = { /** @type {Array<{ address: number, command: number }>} */ received: [], /** @type {Uint8Array[]} */ raw: [] };
  const asm = createAa55Assembler({
    onFrame: (f) => {
      state.received.push({ address: f[2], command: f[3] });
      const a = answer(f);
      if (a) void link.write(a).catch(() => {});
    },
  });
  const off = link.on('data', (/** @type {Uint8Array} */ c) => {
    state.raw.push(Uint8Array.from(c));
    asm.push(c);
  });
  const stopTick = attachBattery(bat, opts.tickMs ?? 1000);
  return {
    battery: bat,
    state,
    overrides,
    stop() {
      off();
      stopTick();
    },
  };
}

/**
 * SE-F pack with built-in Bluetooth (characteristic FFF2): the handshake, then encrypted AA 55
 * answers. Like the real module it drops messages with a wrong trailer silently and handles every
 * write on its own.
 * @param {import('@ubms/transport').Link} link
 * @param {PackConfig & { name?: string }} [opts]
 */
export function createDeyeBleSimulator(link, opts = {}) {
  const name = opts.name ?? DEMO_BLE_NAME;
  const bat = opts.battery ?? new SimBattery({ cells: 16, capacityAh: 314, tempSensors: 6, soc: 64, seed: 29, maxCurrent: 80 });
  const cfg = packConfig({ software: 'LVESS1526701N01', hardware: 'LVESS15MOS', currentOffset: 30000, mainLength: 65, batteryType: 27, chargeLimit: 160, dischargeLimit: 230, boardSensor: false, ...opts });
  const { answer, overrides } = packAnswers(bat, cfg);
  const state = {
    /** @type {string | null} */ key: null,
    /** @type {string | null} */ pendingKey: null,
    handshakes: 0,
    /** @type {Array<{ address: number, command: number }>} */ received: [],
    /** @type {Uint8Array[]} */ writes: [],
    ignored: 0,
  };
  /** @param {Uint8Array} bytes */
  const reply = (bytes) => void link.write(bytes).catch(() => {});
  const off = link.on('data', (/** @type {Uint8Array} */ chunk) => {
    state.writes.push(Uint8Array.from(chunk));
    const h = parseHandshake(chunk);
    if (h) {
      if (!h.trailerValid) return void state.ignored++;
      if (h.tag === 'random' && h.randomStr) {
        state.handshakes++;
        state.key = null;
        state.pendingKey = sessionKey(name, h.randomStr);
        reply(encodeCipher(cipherBlock(state.pendingKey, h.randomStr)));
      } else if (h.tag === 'result' && state.pendingKey) {
        state.key = state.pendingKey;
      }
      return;
    }
    if (!state.key) return void state.ignored++;
    const plain = decryptRequest(state.key, chunk);
    if (!plain || !isValidFrame(plain)) return void state.ignored++;
    state.received.push({ address: plain[2], command: plain[3] });
    const a = answer(plain);
    if (a) reply(encryptAnswer(state.key, a));
  });
  const stopTick = attachBattery(bat, opts.tickMs ?? 1000);
  return {
    battery: bat,
    state,
    overrides,
    /** The module forgets the session while GATT stays up: encrypted requests are ignored until a new handshake. */
    dropSession() {
      state.key = null;
      state.pendingKey = null;
    },
    stop() {
      off();
      stopTick();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// SLCAN adapter on the PCS bus
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/**
 * @typedef {Object} CanSimOptions
 * @property {'deye'|'pylontech'|'intercan'|'silent'} [bus] what is on the bus: a Deye bank, a
 *   Pylontech battery, the 29-bit InterCAN port, or nothing
 * @property {'deye'|'victron'} [profile] PCS profile of the Deye bank (spec 6.3)
 * @property {number} [packs] packs in the bank
 * @property {number} [intervalMs] bank cycle (1 s on the battery)
 * @property {number} [tickMs] battery simulation step, 0 for none
 * @property {number} [bitrate] bus bit rate; frames arrive only when the adapter uses it. Default
 *   500 kbit/s, 250 kbit/s for InterCAN (spec 2.2)
 * @property {'bel'|'cr'|'none'} [closedCloseReply] answer to C on a closed channel: BEL (Lawicel
 *   CANUSB), CR, or nothing
 * @property {boolean} [otherNode] another node acknowledges frames, so they also arrive in listen
 *   only mode
 * @property {boolean} [heartbeat] an inverter on the bus: acknowledges frames and sends the 0x305
 *   heartbeat every cycle (eight zero bytes, as a Victron GX)
 * @property {boolean} [shifted] firmware that clears bit 10 of the per-pack identifiers (spec 12)
 */

/** Fault counters of every simulated pack (0x700, 0x750), non-zero as on a used pack. */
const COUNTS_1 = Object.freeze([2, 0, 26, 0, 0, 0, 0, 0]);
const COUNTS_2 = Object.freeze([2, 0, 1, 0, 0, 0, 0, 0]);

/**
 * SLCAN (Lawicel) adapter with a Deye bank (or another bus) behind it. Commands: C, S0..S8, O, L,
 * V, N, t/T (recorded, answered z/Z, never reach the simulated battery). While the channel is open
 * the bank broadcasts: bank frames and the fast per-pack frames every cycle, 0x500/0x600/0x650
 * every second cycle, 0x550/0x700/0x750 every fifth (spec 4.3). In listen only mode with no other
 * node nothing arrives: nobody acknowledges, the battery repeats its first frame and the adapter
 * sees each attempt end in an error at the acknowledge delimiter (general CAN behaviour).
 * @param {import('@ubms/transport').Link} link
 * @param {CanSimOptions} [opts]
 */
export function createDeyeCanSimulator(link, opts = {}) {
  const { bus = 'deye', profile = 'deye', packs = 1, intervalMs = 1000, tickMs = 1000, closedCloseReply = 'bel', heartbeat = false, shifted = false } = opts;
  const bitrate = opts.bitrate ?? (bus === 'intercan' ? 250000 : 500000);
  let otherNode = opts.otherNode ?? heartbeat;
  const batteries = Array.from({ length: packs }, (_, i) => new SimBattery({ cells: 16, capacityAh: 230, tempSensors: 4, soc: 81 - i * 3, seed: 31 + i, maxCurrent: 60 }));
  const state = {
    open: false,
    /** @type {'normal'|'listen'|null} */ mode: null,
    /** @type {number | null} */ bitrate: null,
    /** @type {string[]} */ commands: [],
    /** @type {string[]} */ transmitted: [],
    cycles: 0,
    framesSent: 0,
  };
  /** Fault table bytes forced by a test: bank 0x359 and per pack 0x110. */
  const overrides = { /** @type {number[] | null} */ bankTables: null, /** @type {Record<number, number[]>} */ packTables: {} };
  let line = '';

  /** @param {string} text */
  const send = (text) => void link.write(encoder.encode(text)).catch(() => {});
  /** @param {number} id @param {ArrayLike<number>} data @param {boolean} [extended] */
  const frame = (id, data, extended = false) => {
    state.framesSent++;
    send(`${formatSlcanFrame({ id, extended, data })}\r`);
  };

  const bank = () => {
    const n = batteries.length;
    const v = batteries.reduce((a, b) => a + b.voltage, 0) / n;
    const i = batteries.reduce((a, b) => a + b.current, 0);
    const soc = batteries.reduce((a, b) => a + b.soc, 0) / n;
    const allTemps = batteries.flatMap((b) => b.temps);
    const allCells = batteries.flatMap((b) => b.cellVoltages());
    return { n, v, i, soc, allTemps, allCells, capacity: 230 * n };
  };

  const cycle = () => {
    if (!state.open || state.bitrate !== bitrate || bus === 'silent') return;
    // Listen only without another node: no frame completes (spec 4.3).
    if (state.mode === 'listen' && !otherNode) return;
    const k = state.cycles++;
    if (bus === 'intercan') {
      frame(0x02098001, [0x0d, 0x05, 3, 0x0d, 0x01, 9], true);
      frame(0x04008001, [0x0d, 0x02, 0x0d, 0x03, 0x0d, 0x04, 0x0d, 0x05], true);
      return;
    }
    if (heartbeat) frame(0x305, new Uint8Array(8));
    const b = bank();
    if (bus === 'pylontech') {
      const d351 = new Uint8Array(8);
      setU16le(d351, 0, 532);
      setU16le(d351, 2, 500);
      setU16le(d351, 4, 1000);
      setU16le(d351, 6, 450);
      frame(0x351, d351);
      frame(0x355, [Math.round(b.soc), 0, 100, 0, 0, 0, 0, 0]);
      const d356 = new Uint8Array(8);
      setU16le(d356, 0, Math.round(b.v * 100));
      setU16le(d356, 2, Math.round(b.i * 10) & 0xffff);
      setU16le(d356, 4, 250);
      frame(0x356, d356);
      frame(0x359, [0, 0, 0, 0, 1, 0, 0x50, 0x4e]);
      frame(0x35c, [0xc0, 0, 0, 0, 0, 0, 0, 0]);
      frame(0x35e, asciiBytes('PYLON   ', 8));
      return;
    }
    // Deye bank, Deye native or victronCAN profile.
    const full = b.soc >= 99;
    const d351 = new Uint8Array(8);
    setU16le(d351, 0, 584);
    setU16le(d351, 2, full ? 0 : 1600 * b.n);
    setU16le(d351, 4, 2300 * b.n);
    setU16le(d351, 6, 480);
    frame(0x351, d351);
    frame(0x355, [Math.round(b.soc), 0, 100, 0, 0, 0, 0, 0]);
    const d356 = new Uint8Array(8);
    setU16le(d356, 0, Math.round(b.v * 100));
    const wire = Math.round(b.i * 10) * (profile === 'victron' ? 1 : -1);
    setU16le(d356, 2, wire & 0xffff);
    setU16le(d356, 4, Math.round((b.allTemps.reduce((a, x) => a + x, 0) / b.allTemps.length) * 10) & 0xffff);
    frame(0x356, d356);
    const capacity = Math.round(b.capacity * 10);
    if (profile === 'victron') {
      const d35a = new Uint8Array(8);
      frame(0x35a, d35a);
      const d35e = new Uint8Array(8);
      d35e.set(asciiBytes('PYLON', 5));
      d35e[5] = 28;
      setU16le(d35e, 6, capacity);
      frame(0x35e, d35e);
      const d35f = new Uint8Array(8);
      d35f[1] = 28;
      d35f[2] = 0xf0;
      d35f[3] = 0x05;
      setU16le(d35f, 4, capacity);
      d35f.set(asciiBytes('DY', 2), 6);
      frame(0x35f, d35f);
    } else {
      frame(0x359, [...(overrides.bankTables ?? [0, 0, 0, 0, 0, 0, 0]), 0]);
      frame(0x35c, [0x40 | (full ? 0 : 0x80), 0, 0, 0, 0, 0, 0, 0]);
      const d35e = new Uint8Array(8);
      d35e.set(asciiBytes('DY001', 5));
      d35e[5] = 28;
      setU16le(d35e, 6, capacity);
      frame(0x35e, d35e);
      const mv = b.allCells.map((x) => Math.round(x * 1000));
      const d361 = new Uint8Array(8);
      setU16le(d361, 0, Math.max(...mv));
      setU16le(d361, 2, Math.min(...mv));
      setU16le(d361, 4, Math.round(Math.max(...b.allTemps) * 10) & 0xffff);
      setU16le(d361, 6, Math.round(Math.min(...b.allTemps) * 10) & 0xffff);
      frame(0x361, d361);
      frame(0x363, [0xf0, 0x02, 0xf0, 0x02, 0, 0, 0, 0]);
      frame(0x364, [b.n, full ? b.n : 0, 0, 0, b.n, 0, 0, 0]);
      const d371 = new Uint8Array(8);
      setU16le(d371, 0, full ? 0 : 1600 * b.n);
      setU16le(d371, 2, 2300 * b.n);
      frame(0x371, d371);
    }
    batteries.forEach((bat, idx) => {
      // The shifted firmware clears bit 10 of 0x400 and above (spec 12).
      const id = (/** @type {number} */ base) => (shifted && base >= 0x400 ? base & ~0x400 : base) + idx;
      const mos = 0x01 | (bat.switches.charge && !full ? 0x10 : 0) | (bat.switches.discharge ? 0x20 : 0);
      frame(id(PACK_BASE.FAULTS), [...(overrides.packTables[idx + 1] ?? [0, 0, 0, 0, 0, 0, 0]), mos]);
      const d150 = new Uint8Array(8);
      setU16le(d150, 0, Math.round(bat.voltage * 10));
      setU16le(d150, 2, -Math.round(bat.current * 10) & 0xffff);
      setU16le(d150, 4, Math.round(bat.soc * 10));
      setU16le(d150, 6, 1000);
      frame(id(PACK_BASE.SUMMARY), d150);
      const mv = bat.cellVoltages().map((x) => Math.round(x * 1000));
      const d200 = new Uint8Array(8);
      setU16le(d200, 0, Math.max(...mv));
      setU16le(d200, 2, Math.min(...mv));
      setU16le(d200, 4, Math.round(Math.max(...bat.temps) * 10) & 0xffff);
      setU16le(d200, 6, Math.round(Math.min(...bat.temps) * 10) & 0xffff);
      frame(id(PACK_BASE.EXTREMES), d200);
      const d250 = new Uint8Array(8);
      setU16le(d250, 0, Math.round(bat.mosTemp * 10) & 0xffff);
      setU16le(d250, 2, -400 & 0xffff);
      setU16le(d250, 4, full ? 0 : 160);
      setU16le(d250, 6, 230);
      frame(id(PACK_BASE.LIMITS), d250);
      const d400 = new Uint8Array(8);
      d400[0] = bat.current > 0.15 ? 1 : bat.current < -0.15 ? 2 : 0;
      setU16le(d400, 2, bat.cycles);
      setU16le(d400, 4, bat.balancing.reduce((m, on, c) => (on && c < 16 ? m | (1 << c) : m), 0));
      setU16le(d400, 6, 0x0f);
      frame(id(PACK_BASE.STATUS), d400);
      if (k % 2 === 0) {
        frame(id(PACK_BASE.SOFTWARE), [0xf0, 0x02, 0xaa, ...asciiBytes('V1.0F', 5)]);
        frame(id(PACK_BASE.SERIAL_1), asciiBytes('DEMO0000', 8));
        frame(id(PACK_BASE.SERIAL_2), asciiBytes(`PACK000${idx + 1}`, 8));
      }
      if (k % 5 === 0) {
        const d550 = new Uint8Array(8);
        setU32le(d550, 0, Math.round(bat.cycleAh * 51.2) + 6190);
        setU32le(d550, 4, Math.round(bat.cycleAh * 51.2));
        frame(id(PACK_BASE.ENERGY), d550);
        // Shifted, pack n's counters land on 0x300 + n - 1 (0x305..0x307 for packs 6..8) and
        // 0x350 + n - 1 (bank identifiers from pack 2 on, spec 12).
        frame(id(PACK_BASE.COUNTS_1), COUNTS_1);
        frame(id(PACK_BASE.COUNTS_2), COUNTS_2);
      }
    });
  };

  /** @param {string} cmd */
  const command = (cmd) => {
    state.commands.push(cmd);
    const c = cmd[0];
    if (c === 'C') {
      if (!state.open) return closedCloseReply === 'none' ? undefined : send(closedCloseReply === 'bel' ? '\x07' : '\r');
      state.open = false;
      state.mode = null;
      return send('\r');
    }
    if (c === 'S' && /^S[0-8]$/.test(cmd)) {
      if (state.open) return send('\x07');
      state.bitrate = [10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000][Number(cmd[1])];
      return send('\r');
    }
    if (cmd === 'O' || cmd === 'L') {
      if (state.open || state.bitrate === null) return send('\x07');
      state.open = true;
      state.mode = cmd === 'O' ? 'normal' : 'listen';
      send('\r');
      // The battery's next cycle starts shortly after the channel opens.
      setTimeout(cycle, 5);
      return;
    }
    if (cmd === 'V') return send('V1013\r');
    if (cmd === 'N') return send('NA123\r');
    if (c === 't' || c === 'T' || c === 'r' || c === 'R') {
      state.transmitted.push(cmd);
      if (!state.open || state.mode !== 'normal') return send('\x07');
      return send(c === 't' || c === 'r' ? 'z\r' : 'Z\r');
    }
    send('\x07');
  };

  const off = link.on('data', (/** @type {Uint8Array} */ chunk) => {
    for (const byte of chunk) {
      if (byte === 0x0d) {
        command(line);
        line = '';
      } else if (line.length < 64) {
        line += String.fromCharCode(byte);
      }
    }
  });
  const stopCycle = every(cycle, intervalMs);
  const stopTicks = tickMs > 0 ? batteries.map((b) => every(() => b.step(tickMs / 1000), tickMs)) : [];
  return {
    batteries,
    battery: batteries[0],
    state,
    overrides,
    /** Emit one cycle now (tests). */
    cycle,
    /** The acknowledging node joins or leaves the bus (tests). @param {boolean} on */
    setOtherNode(on) {
      otherNode = on;
    },
    stop() {
      off();
      stopCycle();
      for (const s of stopTicks) s();
    },
  };
}
