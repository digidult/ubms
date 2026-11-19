import { BaseDriver, msg, fieldMap } from '@ubms/bms-core';
import { FrameChannel, sleep, u16be } from '@ubms/transport';
import {
  CMD,
  D2,
  D2_BATTERY_TYPES,
  HOST,
  MODBUS,
  P81,
  TEXT_FRAMES,
  assembleCells,
  assembleTemperatures,
  assembleText,
  balancingFlags,
  boardHostAddress,
  createClassicAssembler,
  createModbusAssembler,
  describe,
  encodeBatteryCodeWrite,
  encodeClassicRead,
  encodeClassicWrite,
  encodeModbusRead,
  encodeModbusWrite,
  encodeMosfet,
  encodeReset,
  encodeSetSoc,
  failureAlarms,
  framesComplete,
  isClassicBoardAddress,
  modbusRegisters,
  modbusRequestAddress,
  modbusResponseAddress,
  p81Alarms,
  parseClassic,
  parseD2MosInfo,
  parseD2ProductionDate,
  parseD2Status,
  parseD2Version,
  parseP81Realtime1,
  parseP81Realtime2,
  parseP81Version,
} from './protocol.js';
import {
  CLASSIC_SETTING_GROUPS,
  D2_SETTING_BLOCKS,
  P81_SETTING_BLOCKS,
  buildClassicSchema,
  buildD2Schema,
  buildP81Schema,
  decodeClassicSettings,
  decodeRegisterSettings,
  groupRaw,
  registerWriteValue,
  setGroupValue,
  storeRegisters,
} from './settings.js';
import { createDalySimulator, createDalyModbusSimulator } from './simulator.js';

/**
 * Daly BMS drivers (docs/protocols/daly.md): `daly` speaks the classic 13 byte protocol
 * (DALY_CLASSIC), `daly-modbus` the newer Modbus style protocol in both register maps (address D2
 * and `0x80 + board`). Both run on the Daly Bluetooth modules (service FFF0, fallback FF00) and on
 * UART / RS485 at 9600 8N1.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 */

export const DALY_VENDOR = 'Daly BMS';

/** Protocol variants reported through `setVariant()`. */
export const VARIANT = Object.freeze({ CLASSIC: 'DALY_CLASSIC', D2: 'DALY_MODBUS_D2', P81: 'DALY_MODBUS_81' });

/** Labels of the cell temperature probes (literal for the translation checker). */
const TEMP_LABELS = [
  msg('Temperature 1'),
  msg('Temperature 2'),
  msg('Temperature 3'),
  msg('Temperature 4'),
  msg('Temperature 5'),
  msg('Temperature 6'),
  msg('Temperature 7'),
  msg('Temperature 8'),
  msg('Temperature 9'),
  msg('Temperature 10'),
  msg('Temperature 11'),
  msg('Temperature 12'),
  msg('Temperature 13'),
  msg('Temperature 14'),
  msg('Temperature 15'),
  msg('Temperature 16'),
];

const NO_ANSWER = msg('No answer from the BMS. It may be asleep or out of range.');

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';
/** @param {import('@ubms/transport').Link} link */
const isSerialLink = (link) => /serial/.test(link?.kind ?? '');
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * RS485 board number from the user options (1..16, default 1, spec 2.2).
 * @param {Record<string, any> | undefined} options
 */
function boardOption(options) {
  const n = Math.round(Number(options?.board ?? options?.address ?? 1));
  return Number.isFinite(n) && n >= 1 && n <= 16 ? n : 1;
}

/**
 * Cell temperatures as readings with stable ids t1..tN; `null` (not available) is skipped.
 * @param {(number | null)[]} temps
 * @returns {TemperatureReading[]}
 */
function cellTemperatures(temps) {
  /** @type {TemperatureReading[]} */
  const out = [];
  temps.forEach((t, i) => {
    if (t !== null && Number.isFinite(t)) out.push({ id: `t${i + 1}`, label: TEMP_LABELS[i] ?? msg('Temperature'), value: t, kind: 'cell' });
  });
  return out;
}

/**
 * Digital in- or outputs as four digits, DI1 / DO1 first (0x94 data 4, spec 9.4).
 * @param {number} nibble
 */
const bitDigits = (nibble) => [0, 1, 2, 3].map((i) => (nibble >> i) & 1).join(' ');

/**
 * Plausibility of a Modbus status (spec 11.2): cell count 1..max, counted cells 1.0..5.0 V,
 * SOC 0..100 %.
 * @param {{ cellCount: number, cellVoltages: number[], soc: number }} st
 * @param {number} maxCells
 */
function plausible(st, maxCells) {
  return st.cellCount >= 1 && st.cellCount <= maxCells && st.cellVoltages.every((v) => v >= 1 && v <= 5) && st.soc >= 0 && st.soc <= 100;
}

/**
 * Power from the unsigned power register, signed like the current (spec 6.3 0x0039, 6.4 0x0058).
 * @param {number} watts
 * @param {number} current A, model sign
 */
const signedPower = (watts, current) => (current < 0 ? -watts : watts);

// ---------------------------------------------------------------------------------------------
// Current sign (spec 12.1 item 1)
// ---------------------------------------------------------------------------------------------

/** Consistent samples needed before the automatic sign check settles. */
const SIGN_SAMPLES = 3;

/**
 * Key of the user's direction choice in the target options. The session passes the same options
 * object to every driver instance of one target, so the choice survives reconnects. One key per
 * driver id, because the two protocol families have opposite defaults.
 * @param {string} driverId
 */
const invertOption = (driverId) => `${driverId}.invertCurrent`;

/**
 * Current sign policy. The protocol default follows the majority of sources (classic: raw values
 * below 30000 mean charging; Modbus: above 30000). While the user has not chosen a direction, the
 * decoded current is compared with the charge state the BMS reports (charging / discharging) when
 * |I| > 0.5 A; three disagreeing samples in a row flip the automatic direction once.
 */
export class CurrentSign {
  /**
   * @param {boolean} defaultInvert true when the model current is the negated raw decode
   * @param {unknown} [user] direction the user chose earlier (kept in the target options)
   */
  constructor(defaultInvert, user) {
    this.defaultInvert = defaultInvert;
    /** @type {boolean | undefined} user choice (settings field `daly.invert_current`) */
    this.user = typeof user === 'boolean' ? user : undefined;
    this.auto = defaultInvert;
    this.agree = 0;
    this.disagree = 0;
    this.settled = false;
  }

  get invert() {
    return this.user ?? this.auto;
  }

  /**
   * @param {number} decoded `(raw - 30000) x 0.1`
   * @param {number | undefined} state 0 idle, 1 charging, 2 discharging
   * @returns {{ current: number, flipped: boolean }}
   */
  apply(decoded, state) {
    let flipped = false;
    if (this.user === undefined && !this.settled && Math.abs(decoded) > 0.5 && (state === 1 || state === 2)) {
      const shown = this.auto ? -decoded : decoded;
      if ((shown > 0) === (state === 1)) {
        this.disagree = 0;
        if (++this.agree >= SIGN_SAMPLES) this.settled = true;
      } else {
        this.agree = 0;
        if (++this.disagree >= SIGN_SAMPLES) {
          this.auto = !this.auto;
          this.settled = true;
          flipped = true;
        }
      }
    }
    const v = this.invert ? -decoded : decoded;
    return { current: v === 0 ? 0 : v, flipped };
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} ClassicLive parsed classic replies of one poll (missing parts are undefined)
 * @property {Record<string, any>} soc 0x90
 * @property {Record<string, any>} [cellRange] 0x91
 * @property {Record<string, any>} [mosfet] 0x93
 * @property {Record<string, any>} [status] 0x94
 * @property {number[] | null} [cells] 0x95
 * @property {number[] | null} [temperatures] 0x96
 * @property {Uint8Array} [balance] 0x97 data
 * @property {Uint8Array} [failures] 0x98 data
 */

/**
 * Unified snapshot from the classic live data (spec 6.1).
 * @param {ClassicLive} live
 * @param {{ current: number, capacityNominal?: number }} extra current with the sign policy applied
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function classicSnapshot(live, { current, capacityNominal }) {
  const { soc, mosfet, status } = live;
  const cellCount = status?.cellCount ?? live.cells?.length ?? 0;
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = { voltage: soc.packVoltage, current, soc: soc.soc };
  if (capacityNominal) s.capacityNominal = capacityNominal;
  if (mosfet) {
    s.capacityRemaining = mosfet.remainingCapacity;
    s.switches = { charge: mosfet.chargeMos, discharge: mosfet.dischargeMos };
  }
  if (status) s.cycles = status.cycles;
  if (live.cells?.length) s.cells = live.cells;
  if (live.balance && cellCount) {
    // Bit order unverified (spec 6.1 0x97, 12.1 item 4): shown with the order of three sources.
    s.balancing = balancingFlags(live.balance, cellCount);
    s.balancingActive = s.balancing.some(Boolean);
  }
  if (live.temperatures) s.temperatures = cellTemperatures(live.temperatures);
  // 0x94 data 7 holds the MOSFET temperature on DL_HKMS boards only (unverified elsewhere, spec 6.1),
  // so it is not shown.
  if (live.failures) s.alarms = failureAlarms(live.failures);
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  if (status) {
    extra.chargerConnected = { label: msg('Charger connected'), value: status.chargerConnected };
    extra.loadConnected = { label: msg('Load connected'), value: status.loadConnected };
    extra.digitalInputs = { label: msg('Digital inputs DI1 to DI4'), value: bitDigits(status.dioBits & 0x0f) };
    extra.digitalOutputs = { label: msg('Digital outputs DO1 to DO4'), value: bitDigits(status.dioBits >> 4) };
  }
  if (live.failures && live.failures[7]) extra.faultCode = { label: msg('Fault code'), value: live.failures[7], decimals: 0 };
  if (Object.keys(extra).length) s.extra = extra;
  return s;
}

/**
 * Unified snapshot from a D2 status block (spec 6.3).
 * @param {Record<string, any>} st parseD2Status result
 * @param {{ current: number, mos?: { mosTemperature: number | null, balanceCurrent: number } | null, balancerSwitch?: boolean, capacityNominal?: number, batteryType?: number }} extra
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function d2Snapshot(st, { current, mos, balancerSwitch, capacityNominal, batteryType }) {
  const temperatures = cellTemperatures(st.temperatures);
  const mosTemperature = st.mosTemperature ?? mos?.mosTemperature ?? null;
  if (mosTemperature !== null) temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: mosTemperature, kind: 'mos' });
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {
    voltage: st.totalVoltage,
    current,
    power: signedPower(st.power, current),
    soc: st.soc,
    capacityRemaining: st.remainingCapacity,
    cycles: st.cycles,
    cells: st.cellVoltages,
    // Per cell balancing bits (0x003E/0x003F) are inferred only (spec 6.3), so only the flag is shown.
    balancingActive: st.balancerState === 1,
    temperatures,
    switches: { charge: st.chargeMos, discharge: st.dischargeMos, ...(balancerSwitch !== undefined ? { balance: balancerSwitch } : {}) },
    alarms: failureAlarms(st.faultBytes),
  };
  if (capacityNominal) s.capacityNominal = capacityNominal;
  const balanceCurrent = st.balanceCurrent ?? mos?.balanceCurrent;
  if (balanceCurrent !== undefined) s.balanceCurrent = balanceCurrent;
  if (batteryType !== undefined) {
    const label = /** @type {Record<number, string>} */ (D2_BATTERY_TYPES)[batteryType];
    s.extra = { batteryType: { label: msg('Battery type'), value: label ?? String(batteryType) } };
  }
  return s;
}

/** Balancer states of the 0x81 map (register 0x004D, spec 9.4). */
const P81_BALANCE_STATES = Object.freeze({ 0: msg('Off'), 1: msg('Passive balancing'), 2: msg('Active balancing') });

/**
 * Unified snapshot from the two 0x81 realtime blocks (spec 6.4).
 * @param {Record<string, any>} rt1 parseP81Realtime1 result
 * @param {Record<string, any> | null} rt2 parseP81Realtime2 result
 * @param {{ current: number }} extra
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function p81Snapshot(rt1, rt2, { current }) {
  const temperatures = cellTemperatures(rt1.temperatures);
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = { voltage: rt1.totalVoltage, current, soc: rt1.soc, cells: rt1.cellVoltages, temperatures };
  if (!rt2) return s;
  if (rt2.mosTemperature !== null) temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: rt2.mosTemperature, kind: 'mos' });
  if (rt2.boardTemperature !== null) temperatures.push({ id: 'board', label: msg('Board temperature'), value: rt2.boardTemperature, kind: 'board' });
  // Packs without a heater report raw 0 (-40 degrees C) in both captures: treated as absent.
  if (rt2.heaterTemperature !== null && rt2.heaterTemperature > -40) {
    temperatures.push({ id: 'heater', label: msg('Heater temperature'), value: rt2.heaterTemperature, kind: 'heater' });
  }
  const balancing = rt2.balancing.slice(0, rt1.cellCount);
  s.power = signedPower(rt2.power, current);
  s.capacityRemaining = rt2.remainingCapacity;
  s.cycles = rt2.cycles;
  s.balancing = balancing;
  s.balancingActive = balancing.some(Boolean) || rt2.balanceState === 1 || rt2.balanceState === 2;
  if (rt2.balanceCurrent !== null) s.balanceCurrent = rt2.balanceCurrent;
  s.switches = { charge: rt2.chargeMos, discharge: rt2.dischargeMos, precharge: rt2.prechargeMos, heater: rt2.heaterMos };
  s.alarms = p81Alarms(rt2.type2Bytes);
  s.extra = {
    fan: { label: msg('Fan'), value: rt2.fanMos },
    balancerState: {
      label: msg('Balancer state'),
      value: /** @type {Record<number, string>} */ (P81_BALANCE_STATES)[rt2.balanceState] ?? String(rt2.balanceState),
    },
  };
  return s;
}

// ---------------------------------------------------------------------------------------------
// Classic driver
// ---------------------------------------------------------------------------------------------

/**
 * Request timing (spec 4.1, 4.2): serial 20 ms gap after the last frame, 500 ms per frame and 3
 * attempts; BLE modules answer slower and may drop the first request after connecting.
 */
const CLASSIC_TIMING = Object.freeze({
  ble: { timeout: 1500, retries: 1, gap: 0, quiet: 80 },
  serial: { timeout: 500, retries: 2, gap: 20, quiet: 40 },
});

export class DalyClassicDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.serial = isSerialLink(ctx.link);
    this.board = boardOption(ctx.options);
    this.timing = this.serial ? CLASSIC_TIMING.serial : CLASSIC_TIMING.ble;
    /** Host address: 0x80 over Bluetooth, `0x3F + board` on UART / RS485 (spec 2.2, 4.2). */
    this.host = this.serial ? boardHostAddress(this.board) : HOST.BLUETOOTH;
    /** Board number in the replies; learned from the first reply when the host is 0x80. @type {number | undefined} */
    this.replyBoard = this.serial ? this.board : undefined;
    this.channel = new FrameChannel(ctx.link, { createAssembler: createClassicAssembler, describe: (f) => describe(f), log: ctx.log }).start();
    this.schema = buildClassicSchema();
    this.fields = fieldMap(this.schema);
    this.sign = new CurrentSign(true, ctx.options?.[invertOption(definition.id)]);
    /** Last parsed live replies by command. @type {Map<number, Record<string, any>>} */
    this.live = new Map();
    /** @type {number[] | null} */
    this.cells = null;
    /** @type {number[] | null} */
    this.temperatures = null;
    /** @type {Uint8Array | undefined} */
    this.balance = undefined;
    /** @type {Uint8Array | undefined} */
    this.failures = undefined;
    /** @type {number | undefined} rated capacity, Ah (0x50) */
    this.capacityNominal = undefined;
    /** Configuration groups as last read. @type {Map<number, Uint8Array>} */
    this.groups = new Map();
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // One poll is nine requests and two multi-frame answers (spec 4.1 step 3).
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /** @param {Uint8Array} f */
  #fromBms(f) {
    if (!isClassicBoardAddress(f[1])) return false;
    return this.replyBoard === undefined || f[1] === this.replyBoard;
  }

  /** @param {number} cmd */
  #match(cmd) {
    return (/** @type {Uint8Array} */ f) => f[2] === cmd && this.#fromBms(f);
  }

  /** Wait the gap after the last received frame (half duplex RS485, spec 2.2 and 4.1). */
  async #gap() {
    if (!this.timing.gap) return;
    const idle = Date.now() - this.channel.lastFrameAt;
    if (idle < this.timing.gap) await sleep(this.timing.gap - idle);
  }

  /**
   * Wait until no frame arrived for `quiet` ms (extra frames of a multi-frame answer, spec 12.2).
   * @param {number} [max]
   */
  async #quiet(max = 800) {
    const started = Date.now();
    while (Date.now() - started < max) {
      const idle = Date.now() - this.channel.lastFrameAt;
      if (idle >= this.timing.quiet) return;
      await sleep(this.timing.quiet - idle);
    }
  }

  /**
   * Request with one reply. Only call inside `this.channel.exclusive()`.
   * @param {Uint8Array} bytes
   * @param {number} replyCmd
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #request(bytes, replyCmd, { timeout = this.timing.timeout, retries = this.timing.retries } = {}) {
    await this.#gap();
    const d = describe(bytes);
    const frame = await this.channel.requestUnqueued(bytes, { match: this.#match(replyCmd), timeout, retries, name: d?.name, decode: d?.decode });
    if (this.replyBoard === undefined) this.replyBoard = frame[1];
    return frame;
  }

  /**
   * Read command with one reply frame.
   * @param {number} cmd
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  #read(cmd, opts) {
    return this.#request(encodeClassicRead(this.host, cmd), cmd, opts);
  }

  /**
   * Read command with a multi-frame answer: collects frames until 1..needed are present, then
   * waits for the line to be quiet (the BLE module sends all 16 cell frames, spec 4.2).
   * @param {number} cmd
   * @param {number} needed
   * @returns {Promise<Uint8Array[]>}
   */
  async #readFrames(cmd, needed) {
    const req = encodeClassicRead(this.host, cmd);
    const d = describe(req);
    const match = this.#match(cmd);
    let lastErr;
    for (let attempt = 0; attempt <= Math.min(1, this.timing.retries); attempt++) {
      await this.#gap();
      try {
        const frames = await this.channel.requestManyUnqueued(req, {
          match: (f) => match(f) && f[4] >= 1,
          until: (frs) => framesComplete(frs, needed),
          timeout: this.timing.timeout + 60 * needed,
          partialOnTimeout: true,
          name: d?.name,
          decode: d?.decode,
        });
        if (this.replyBoard === undefined && frames.length) this.replyBoard = frames[0][1];
        await this.#quiet();
        return frames;
      } catch (err) {
        lastErr = err;
        if (!isTimeout(err)) throw err;
      }
    }
    throw lastErr;
  }

  /**
   * Fresh 8 data bytes of a configuration group.
   * @param {number} cmd
   */
  async #readGroup(cmd) {
    const f = await this.#read(cmd);
    const data = Uint8Array.from(f.subarray(4, 12));
    this.groups.set(cmd, data);
    return data;
  }

  /**
   * Read only probe (spec 11.2 steps 3 and 4): 0x90 with the preferred host address, repeated once
   * because some modules drop the first request after connecting; then 0x94 with the other host
   * address (some modules answer only 0x40, batmon-ha issue #416).
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const perTry = this.serial ? clamp(Math.floor(timeout / 4), 300, 600) : clamp(Math.floor(timeout / 2), 400, 1500);
    const preferred = this.host;
    const other = preferred === HOST.BLUETOOTH ? boardHostAddress(this.board) : HOST.BLUETOOTH;
    return this.channel.exclusive(async () => {
      /** @type {Record<string, any> | null} */
      let soc = null;
      /** @type {Record<string, any> | null} */
      let status = null;
      try {
        soc = parseClassic(await this.#read(CMD.SOC, { timeout: perTry, retries: 1 }));
      } catch {
        /* try the other host address */
      }
      if (!soc) {
        this.host = other;
        if (other === HOST.BLUETOOTH) this.replyBoard = undefined;
        try {
          status = parseClassic(await this.#read(CMD.STATUS, { timeout: perTry, retries: 0 }));
        } catch {
          this.host = preferred;
          this.replyBoard = this.serial ? this.board : undefined;
          return null;
        }
      }
      if (soc && soc.soc > 100) return null;
      if (!status) {
        try {
          status = parseClassic(await this.#read(CMD.STATUS, { timeout: perTry, retries: 1 }));
        } catch {
          /* the poll reads it again */
        }
      }
      if (status && (status.cellCount < 1 || status.cellCount > 48)) return null;
      if (status) this.live.set(CMD.STATUS, status);
      this.setVariant(VARIANT.CLASSIC);
      this.log?.event(`Daly classic: host address 0x${this.host.toString(16).toUpperCase()}, board ${this.replyBoard ?? '?'}`, { source: this.definition.id });
      return { variant: VARIANT.CLASSIC, confidence: 1, info: { vendor: DALY_VENDOR, protocol: this.definition.protocol } };
    });
  }

  async poll() {
    const snap = await this.channel.exclusive(() => this.#poll());
    this.publish(snap);
  }

  /** Live poll 0x90..0x98 (spec 4.1 step 3). */
  async #poll() {
    /** @type {Record<string, any>} */
    let soc;
    try {
      soc = parseClassic(await this.#read(CMD.SOC));
    } catch (err) {
      if (isTimeout(err)) throw new Error(NO_ANSWER);
      throw err;
    }
    for (const cmd of [CMD.CELL_RANGE, CMD.TEMP_RANGE, CMD.MOSFET, CMD.STATUS]) {
      try {
        this.live.set(cmd, parseClassic(await this.#read(cmd)));
      } catch (err) {
        this.log?.warn(`Daly ${describe(encodeClassicRead(this.host, cmd))?.name}: ${errorText(err)}`, { source: this.definition.id });
      }
    }
    const status = this.live.get(CMD.STATUS);
    const cellCount = Math.min(status?.cellCount ?? 0, 48);
    const sensorCount = Math.min(status?.temperatureSensorCount ?? 0, 16);
    if (cellCount) {
      try {
        // A set with a missing or duplicated frame keeps the previous values (spec 12.2).
        const cells = assembleCells(await this.#readFrames(CMD.CELLS, Math.ceil(cellCount / 3)), cellCount);
        if (cells) this.cells = cells;
      } catch (err) {
        this.log?.warn(`Daly cell voltages: ${errorText(err)}`, { source: this.definition.id });
      }
    }
    if (sensorCount) {
      try {
        const temps = assembleTemperatures(await this.#readFrames(CMD.TEMPERATURES, Math.ceil(sensorCount / 7)), sensorCount);
        if (temps) this.temperatures = temps;
      } catch (err) {
        this.log?.warn(`Daly temperatures: ${errorText(err)}`, { source: this.definition.id });
      }
    }
    for (const cmd of [CMD.BALANCE, CMD.FAILURES]) {
      try {
        const data = Uint8Array.from((await this.#read(cmd)).subarray(4, 12));
        if (cmd === CMD.BALANCE) this.balance = data;
        else this.failures = data;
      } catch (err) {
        this.log?.warn(`Daly ${describe(encodeClassicRead(this.host, cmd))?.name}: ${errorText(err)}`, { source: this.definition.id });
      }
    }
    const mosfet = this.live.get(CMD.MOSFET);
    const { current, flipped } = this.sign.apply(soc.current, mosfet?.state);
    if (flipped) this.log?.event('Daly: the current sign disagreed with the charge state of the BMS, the direction is inverted', { source: this.definition.id });
    return classicSnapshot(
      { soc, mosfet, status, cells: this.cells, temperatures: this.temperatures, balance: this.balance, failures: this.failures },
      { current, capacityNominal: this.capacityNominal },
    );
  }

  /**
   * Text of a multi-frame answer (0x57, 0x62, 0x63).
   * @param {number} cmd
   */
  async #readText(cmd) {
    const count = /** @type {Record<number, number>} */ (TEXT_FRAMES)[cmd];
    return assembleText(await this.#readFrames(cmd, count), count);
  }

  /** Versions, production date, battery code, firmware index and capacity (spec 10.1). */
  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /** @type {DeviceInfo} */
      const out = { vendor: DALY_VENDOR, protocol: this.definition.protocol };
      /** @type {Record<string, ExtraValue>} */
      const extra = { hostAddress: { label: msg('Host address'), value: `0x${this.host.toString(16).toUpperCase()}` } };
      const attempt = async (/** @type {string} */ what, /** @type {() => Promise<void>} */ fn) => {
        try {
          await fn();
        } catch (err) {
          this.log?.warn(`Daly ${what}: ${errorText(err)}`, { source: this.definition.id });
        }
      };
      await attempt('software version', async () => {
        const v = await this.#readText(CMD.SOFTWARE_VERSION);
        if (v) out.softwareVersion = v;
      });
      await attempt('hardware version', async () => {
        const v = await this.#readText(CMD.HARDWARE_VERSION);
        if (v) {
          out.hardwareVersion = v;
          out.model = v;
        }
      });
      await attempt('battery information', async () => {
        const g = parseClassic(await this.#read(CMD.BATTERY_INFO));
        out.manufactureDate = g.productionDate;
      });
      await attempt('rated capacity', async () => {
        const g = parseClassic(await this.#read(CMD.RATED));
        if (g.ratedCapacity > 0) this.capacityNominal = g.ratedCapacity;
      });
      await attempt('battery code', async () => {
        const code = await this.#readText(CMD.BATTERY_CODE);
        if (code) extra.batteryCode = { label: msg('Battery code'), value: code };
      });
      await attempt('firmware index', async () => {
        const g = parseClassic(await this.#read(CMD.FIRMWARE_INDEX));
        if (g.text.trim()) extra.firmwareIndex = { label: msg('Firmware index'), value: g.text.trim() };
      });
      out.extra = extra;
      return out;
    });
    return this.publishInfo(info);
  }

  /** Configuration groups 0x50..0x61, the battery code, and the live SOC and switch states. */
  async readSettings() {
    return this.channel.exclusive(async () => {
      /** @type {Map<number, Uint8Array>} */
      const groups = new Map();
      let answered = 0;
      for (const cmd of CLASSIC_SETTING_GROUPS) {
        try {
          groups.set(cmd, Uint8Array.from((await this.#read(cmd)).subarray(4, 12)));
          answered++;
        } catch (err) {
          this.log?.warn(`Daly settings group 0x${cmd.toString(16).toUpperCase()}: ${errorText(err)}`, { source: this.definition.id });
        }
      }
      this.groups = groups;
      const values = decodeClassicSettings(this.schema, groups);
      const rated = groups.get(CMD.RATED);
      if (rated && values['capacity.nominal'] > 0) this.capacityNominal = values['capacity.nominal'];
      try {
        const code = await this.#readText(CMD.BATTERY_CODE);
        if (code !== null) values['daly.battery_code'] = code;
      } catch (err) {
        this.log?.warn(`Daly battery code: ${errorText(err)}`, { source: this.definition.id });
      }
      try {
        values['soc.value'] = parseClassic(await this.#read(CMD.SOC)).soc;
        answered++;
      } catch (err) {
        this.log?.warn(`Daly SOC: ${errorText(err)}`, { source: this.definition.id });
      }
      try {
        const m = parseClassic(await this.#read(CMD.MOSFET));
        this.live.set(CMD.MOSFET, m);
        values['switch.charge'] = m.chargeMos;
        values['switch.discharge'] = m.dischargeMos;
        answered++;
      } catch (err) {
        this.log?.warn(`Daly MOSFET state: ${errorText(err)}`, { source: this.definition.id });
      }
      if (!answered) throw new Error(msg('The BMS did not answer the settings requests'));
      values['daly.invert_current'] = this.sign.invert;
      return values;
    });
  }

  /**
   * Write acknowledgement (data 0 = 1, spec 5.3). smefa saw unreliable answers to some writes, so
   * a missing or odd acknowledgement is only logged; the read-back decides.
   * @param {Uint8Array} bytes
   */
  async #sendWrite(bytes) {
    try {
      const ack = await this.#request(bytes, bytes[2], { timeout: this.timing.timeout, retries: 0 });
      if (ack[4] !== 1) this.log?.event(`Daly write 0x${bytes[2].toString(16).toUpperCase()}: acknowledged with ${ack[4]}`, { source: this.definition.id });
    } catch (err) {
      if (!isTimeout(err)) throw err;
      this.log?.warn(`Daly write 0x${bytes[2].toString(16).toUpperCase()}: no acknowledgement`, { source: this.definition.id });
    }
  }

  /**
   * Read the group, change one field, write the whole group back and read it again (spec 5.3, 7.8).
   * @param {import('@ubms/bms-core/settings').SettingField} f
   * @param {number} value
   */
  async #writeGroupField(f, value) {
    const meta = f.meta;
    const data = Uint8Array.from(await this.#readGroup(meta.cmd));
    const raw = setGroupValue(meta, value, data);
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.#sendWrite(encodeClassicWrite(this.host, meta.cmd, data));
      const back = await this.#readGroup(meta.cmd);
      if (groupRaw(meta, back) === raw) return;
    }
    throw new Error(msg('The BMS did not take the new value'));
  }

  /**
   * Set the SOC with the current local time (0x21, spec 12.1 item 16).
   * @param {number} value
   */
  async #writeSoc(value) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.#sendWrite(encodeSetSoc(this.host, value, new Date()));
      try {
        const soc = parseClassic(await this.#read(CMD.SOC)).soc;
        if (Math.abs(soc - value) < 0.05) return;
      } catch {
        /* the settings reload tells */
      }
    }
  }

  /**
   * MOSFET command and read-back of 0x93 until it reports the requested state (spec 8).
   * @param {'charge'|'discharge'} key
   * @param {boolean} on
   */
  async #writeSwitch(key, on) {
    const req = encodeMosfet(this.host, key, on);
    try {
      await this.#request(req, req[2], { retries: 1 });
    } catch (err) {
      if (!isTimeout(err)) throw err;
      this.log?.warn(`Daly ${key} MOSFET: no answer to the command`, { source: this.definition.id });
    }
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 100 : 300);
      try {
        const m = parseClassic(await this.#read(CMD.MOSFET, { retries: 0 }));
        this.live.set(CMD.MOSFET, m);
        if ((key === 'charge' ? m.chargeMos : m.dischargeMos) === on) return;
      } catch {
        /* the next attempt or the settings reload tells */
      }
    }
  }

  /**
   * Battery code: five frames back to back, one acknowledgement, then read back (spec 5.3).
   * @param {string} text
   */
  async #writeBatteryCode(text) {
    if (!/^[\x20-\x7e]*$/.test(text) || text.length > 35) throw new Error(msg('Use at most 35 ASCII letters, digits and symbols'));
    const frames = encodeBatteryCodeWrite(this.host, text);
    await this.#gap();
    for (const fr of frames.slice(0, -1)) {
      const d = describe(fr);
      await this.link.write(fr, { name: d?.name, decode: d?.decode });
    }
    await this.#sendWrite(/** @type {Uint8Array} */ (frames.at(-1)));
    const back = await this.#readText(CMD.BATTERY_CODE);
    if (back !== text.trim()) throw new Error(msg('The BMS did not take the new value'));
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    const kind = f.meta?.kind;
    if (kind === 'local') {
      this.sign.user = !!value;
      if (this.ctx.options) this.ctx.options[invertOption(this.definition.id)] = this.sign.user;
      return;
    }
    await this.channel.exclusive(async () => {
      if (kind === 'group') return this.#writeGroupField(f, Number(value));
      if (kind === 'soc') return this.#writeSoc(Number(value));
      if (kind === 'switch') return this.#writeSwitch(f.meta.key, !!value);
      if (kind === 'battery-code') return this.#writeBatteryCode(String(value ?? ''));
      throw new Error(msg('Unknown setting'));
    });
  }

  /** @param {string} id */
  async runAction(id) {
    const f = this.fields.get(id);
    if (!f || f.type !== 'action' || f.meta?.action !== 'reset') throw new Error(msg('Unknown action'));
    await this.channel.exclusive(async () => {
      // The reply to 0x00 is unverified and the BMS may restart before answering (spec 5.1).
      try {
        await this.#request(encodeReset(this.host), CMD.RESET, { timeout: 1000, retries: 0 });
      } catch (err) {
        if (!isTimeout(err)) throw err;
        this.log?.event('Daly reset: no answer, the BMS may be restarting', { source: this.definition.id });
      }
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Modbus driver (D2 and 0x81 maps)
// ---------------------------------------------------------------------------------------------

/**
 * Request timing (spec 4.3, 4.4): BLE about 1.5 s per request with one retry (aiobmsble doubles a
 * 0.7 s timeout, batmon-ha retries the first request); RS485 80 ms between reads (Sundaya).
 */
const MODBUS_TIMING = Object.freeze({
  ble: { timeout: 1500, retries: 1, gap: 0 },
  serial: { timeout: 800, retries: 1, gap: 80 },
});

const D2_LABEL = msg('Daly Modbus, D2 register map');
const P81_LABEL = msg('Daly Modbus, 0x81 register map');

export class DalyModbusDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.serial = isSerialLink(ctx.link);
    this.board = boardOption(ctx.options);
    this.timing = this.serial ? MODBUS_TIMING.serial : MODBUS_TIMING.ble;
    /** @type {import('./protocol.js').ModbusFlavour | null} */
    this.flavour = null;
    /** Byte count of the outstanding read (assembler check, spec 3.3 step 4). @type {number | undefined} */
    this.expectedByteCount = undefined;
    /** Start register of the outstanding read, for the protocol log. @type {number | undefined} */
    this.pendingStart = undefined;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: (h) =>
        createModbusAssembler({ ...h, addresses: [MODBUS.D2, modbusResponseAddress('p81', this.board)], expectedByteCount: () => this.expectedByteCount }),
      describe: (f) => describe(f, { direction: 'rx', start: this.pendingStart }),
      log: ctx.log,
    }).start();
    this.sign = new CurrentSign(false, ctx.options?.[invertOption(definition.id)]);
    /** @type {import('@ubms/bms-core/settings').SettingsSchema | null} */
    this.schema = null;
    /** @type {Map<string, import('@ubms/bms-core/settings').SettingField>} */
    this.fields = new Map();
    /** D2 MOSFET temperature block: 'unknown' until read, 'off' after a timeout or 0 / 0xFFFF. */
    this.mosInfo = 'unknown';
    /** @type {{ mosTemperature: number | null, balanceCurrent: number } | null} */
    this.mos = null;
    /** D2 balancer switch (0x00CF) when the device has one. @type {boolean | undefined} */
    this.balancerSwitch = undefined;
    /** @type {number | undefined} */
    this.capacityNominal = undefined;
    /** @type {number | undefined} */
    this.batteryType = undefined;
    /** @type {Record<string, any> | null} */
    this.rt2 = null;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 1000, minPollIntervalMs: 500 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  get protocolLabel() {
    return this.flavour === 'p81' ? P81_LABEL : this.flavour === 'd2' ? D2_LABEL : this.definition.protocol;
  }

  /** @param {import('./protocol.js').ModbusFlavour} flavour */
  #selectFlavour(flavour) {
    this.flavour = flavour;
    this.schema = flavour === 'd2' ? buildD2Schema({ balancerSwitch: this.balancerSwitch !== undefined }) : buildP81Schema();
    this.fields = fieldMap(this.schema);
    this.setVariant(flavour === 'd2' ? VARIANT.D2 : VARIANT.P81);
  }

  async #gap() {
    if (!this.timing.gap) return;
    const idle = Date.now() - this.channel.lastFrameAt;
    if (idle < this.timing.gap) await sleep(this.timing.gap - idle);
  }

  get #requestAddress() {
    return modbusRequestAddress(this.flavour ?? 'd2', this.board);
  }

  get #responseAddress() {
    return modbusResponseAddress(this.flavour ?? 'd2', this.board);
  }

  /**
   * Read holding registers. Replies carry no start register: one request in flight and a byte
   * count check match them (spec 3.2). Only call inside `this.channel.exclusive()`.
   * @param {number} start
   * @param {number} count
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #read(start, count, { timeout = this.timing.timeout, retries = this.timing.retries } = {}) {
    await this.#gap();
    const req = encodeModbusRead(this.#requestAddress, start, count);
    const resp = this.#responseAddress;
    const d = describe(req, { direction: 'tx' });
    this.expectedByteCount = 2 * count;
    this.pendingStart = start;
    try {
      const frame = await this.channel.requestUnqueued(req, {
        match: (f) => f[0] === resp && ((f[1] === MODBUS.READ && f[2] === 2 * count) || f[1] === (MODBUS.READ | 0x80)),
        timeout,
        retries,
        name: d?.name,
        decode: d?.decode,
      });
      if (frame[1] & 0x80) {
        this.log?.warn(`Daly Modbus exception ${frame[2]} for register 0x${start.toString(16).toUpperCase()}`, { source: this.definition.id });
        throw new Error(msg('The BMS rejected the request'));
      }
      return frame;
    } finally {
      this.expectedByteCount = undefined;
      this.pendingStart = undefined;
    }
  }

  /**
   * Write one register (0x06) and check the echo.
   * @param {number} register
   * @param {number} value
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #write(register, value, { timeout = this.timing.timeout, retries = 1 } = {}) {
    await this.#gap();
    const req = encodeModbusWrite(this.#requestAddress, register, value);
    const resp = this.#responseAddress;
    const d = describe(req, { direction: 'tx' });
    // A write echo with a bad CRC is dropped by the assembler; the retry repeats the (idempotent)
    // write (spec 12.2).
    const echo = await this.channel.requestUnqueued(req, {
      match: (f) => f[0] === resp && f[1] === MODBUS.WRITE && u16be(f, 2) === register,
      timeout,
      retries,
      name: d?.name,
      decode: d?.decode,
    });
    if (u16be(echo, 4) !== value) throw new Error(msg('The BMS did not confirm the written value'));
  }

  /** @param {{ timeout?: number, retries?: number }} [opts] */
  async #readD2Status(opts) {
    return parseD2Status(await this.#read(D2.STATUS.start, D2.STATUS.count, opts));
  }

  /** @param {{ timeout?: number, retries?: number }} [opts] */
  async #readP81Realtime(opts) {
    const rt1 = parseP81Realtime1(await this.#read(P81.REALTIME_1.start, P81.REALTIME_1.count, opts));
    try {
      this.rt2 = parseP81Realtime2(await this.#read(P81.REALTIME_2.start, P81.REALTIME_2.count, opts));
    } catch (err) {
      this.log?.warn(`Daly realtime block 2: ${errorText(err)}`, { source: this.definition.id });
    }
    return rt1;
  }

  /**
   * Read only probe (spec 11.2 steps 1 and 2): D2 status (repeated once, the first request may be
   * lost), then realtime block 1 of the 0x81 map. A known variant (reconnect) is tried first.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const perTry = this.serial ? clamp(Math.floor(timeout / 4), 300, 600) : clamp(Math.floor(timeout / 2), 400, 1500);
    /** @type {import('./protocol.js').ModbusFlavour[]} */
    const order = this.variant === VARIANT.P81 ? ['p81', 'd2'] : ['d2', 'p81'];
    return this.channel.exclusive(async () => {
      for (const [i, flavour] of order.entries()) {
        this.flavour = flavour;
        try {
          const opts = { timeout: perTry, retries: i === 0 ? 1 : 0 };
          const ok =
            flavour === 'd2'
              ? plausible(await this.#readD2Status(opts), 32)
              : plausible(parseP81Realtime1(await this.#read(P81.REALTIME_1.start, P81.REALTIME_1.count, opts)), 48);
          if (!ok) continue;
          this.#selectFlavour(flavour);
          return { variant: /** @type {string} */ (this.variant), confidence: 1, info: { vendor: DALY_VENDOR, protocol: this.protocolLabel } };
        } catch {
          /* next flavour */
        }
      }
      this.flavour = null;
      return null;
    });
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      try {
        return this.flavour === 'p81' ? await this.#pollP81() : await this.#pollD2();
      } catch (err) {
        if (isTimeout(err)) throw new Error(NO_ANSWER);
        throw err;
      }
    });
    this.publish(snap);
  }

  async #pollD2() {
    const st = await this.#readD2Status();
    if (this.mosInfo !== 'off') {
      // aiobmsble reads 9 registers from 0x003E for the MOSFET temperature and stops when it times
      // out or reports 0x0000 / 0xFFFF (spec 4.3 step 2).
      try {
        const m = parseD2MosInfo(await this.#read(D2.MOS_INFO.start, D2.MOS_INFO.count, { timeout: Math.min(800, this.timing.timeout), retries: 0 }));
        this.mosInfo = m.mosTemperature === null ? 'off' : 'ok';
        this.mos = m.mosTemperature === null ? null : m;
      } catch {
        this.mosInfo = 'off';
        this.mos = null;
      }
    }
    const { current, flipped } = this.sign.apply(st.current, st.chargeDischargeState);
    if (flipped) this.log?.event('Daly: the current sign disagreed with the charge state of the BMS, the direction is inverted', { source: this.definition.id });
    return d2Snapshot(st, { current, mos: this.mos, balancerSwitch: this.balancerSwitch, capacityNominal: this.capacityNominal, batteryType: this.batteryType });
  }

  async #pollP81() {
    const rt1 = await this.#readP81Realtime();
    const { current, flipped } = this.sign.apply(rt1.current, this.rt2?.chargeDischargeState);
    if (flipped) this.log?.event('Daly: the current sign disagreed with the charge state of the BMS, the direction is inverted', { source: this.definition.id });
    return p81Snapshot(rt1, this.rt2, { current });
  }

  /**
   * D2 balancer switch register: 0 or 1 on active balancers, anything else means none (spec 6.3).
   * Rebuilds the schema when the presence changes.
   * @param {number | undefined} raw
   */
  #setBalancerRegister(raw) {
    const before = this.balancerSwitch !== undefined;
    this.balancerSwitch = raw === 0 || raw === 1 ? raw === 1 : undefined;
    if (this.flavour === 'd2' && before !== (this.balancerSwitch !== undefined)) {
      this.schema = buildD2Schema({ balancerSwitch: this.balancerSwitch !== undefined });
      this.fields = fieldMap(this.schema);
    }
  }

  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /** @type {DeviceInfo} */
      const out = { vendor: DALY_VENDOR, protocol: this.protocolLabel };
      /** @type {Record<string, ExtraValue>} */
      const extra = {};
      const attempt = async (/** @type {string} */ what, /** @type {() => Promise<void>} */ fn) => {
        try {
          await fn();
        } catch (err) {
          this.log?.warn(`Daly ${what}: ${errorText(err)}`, { source: this.definition.id });
        }
      };
      if (this.flavour === 'p81') {
        await attempt('version', async () => {
          // Field names other than the battery code are unverified (spec 10.3).
          const v = parseP81Version(await this.#read(P81.VERSION.start, P81.VERSION.count));
          if (v.softwareVersion) out.softwareVersion = v.softwareVersion;
          if (v.hardwareVersion) out.hardwareVersion = v.hardwareVersion;
          if (v.model) out.model = v.model;
          if (v.serialNumber) out.serialNumber = v.serialNumber;
          if (v.batteryCode) extra.batteryCode = { label: msg('Battery code'), value: v.batteryCode };
        });
      } else {
        await attempt('version', async () => {
          const v = parseD2Version(await this.#read(D2.VERSION.start, D2.VERSION.count));
          if (v.softwareVersion) out.softwareVersion = v.softwareVersion;
          if (v.hardwareVersion) out.hardwareVersion = v.hardwareVersion;
          if (v.machineCode) extra.machineCode = { label: msg('Machine code'), value: v.machineCode };
        });
        await attempt('production date', async () => {
          out.manufactureDate = parseD2ProductionDate(await this.#read(D2.PRODUCTION_DATE.start, D2.PRODUCTION_DATE.count)).productionDate;
        });
        await attempt('settings', async () => {
          const g = modbusRegisters(await this.#read(D2.SETTINGS.start, D2.SETTINGS.count));
          if (g[0] > 0) this.capacityNominal = g[0] / 10;
          this.batteryType = g[9];
        });
        await attempt('balancer switch', async () => {
          this.#setBalancerRegister(modbusRegisters(await this.#read(D2.BALANCER.start, D2.BALANCER.count, { retries: 0 }))[0]);
        });
      }
      if (Object.keys(extra).length) out.extra = extra;
      return out;
    });
    return this.publishInfo(info);
  }

  async readSettings() {
    if (!this.flavour || !this.schema) throw new Error(msg('The protocol version is not known yet'));
    return this.channel.exclusive(async () => {
      /** @type {Map<number, number>} */
      const regs = new Map();
      let answered = 0;
      const blocks = this.flavour === 'p81' ? P81_SETTING_BLOCKS : D2_SETTING_BLOCKS;
      for (const block of blocks) {
        try {
          storeRegisters(regs, block.start, modbusRegisters(await this.#read(block.start, block.count)));
          answered++;
        } catch (err) {
          this.log?.warn(`Daly ${block.name} (0x${block.start.toString(16).toUpperCase()}): ${errorText(err)}`, { source: this.definition.id });
        }
      }
      /** @type {Record<string, any>} */
      let live = {};
      try {
        if (this.flavour === 'p81') {
          const rt1 = await this.#readP81Realtime();
          live = { soc: rt1.soc, charge: this.rt2?.chargeMos, discharge: this.rt2?.dischargeMos };
        } else {
          try {
            this.#setBalancerRegister(modbusRegisters(await this.#read(D2.BALANCER.start, D2.BALANCER.count, { retries: 0 }))[0]);
          } catch {
            this.#setBalancerRegister(undefined);
          }
          const st = await this.#readD2Status();
          live = { soc: st.soc, charge: st.chargeMos, discharge: st.dischargeMos, balance: this.balancerSwitch };
        }
        answered++;
      } catch (err) {
        this.log?.warn(`Daly live data for settings: ${errorText(err)}`, { source: this.definition.id });
      }
      if (!answered) throw new Error(msg('The BMS did not answer the settings requests'));
      const schema = /** @type {import('@ubms/bms-core/settings').SettingsSchema} */ (this.schema);
      const values = decodeRegisterSettings(schema, regs);
      // SOC and switches show what the BMS reports live (the verification of spec 8).
      if (live.soc !== undefined) values['soc.value'] = live.soc;
      for (const key of ['charge', 'discharge', 'balance']) {
        const f = this.fields.get(`switch.${key}`);
        if (f?.meta?.kind === 'switch' && live[key] !== undefined) values[`switch.${key}`] = live[key];
      }
      values['daly.invert_current'] = this.sign.invert;
      if (this.flavour === 'd2') {
        if (values['capacity.nominal'] > 0) this.capacityNominal = values['capacity.nominal'];
        if (values['system.battery_type'] !== undefined) this.batteryType = values['system.battery_type'];
      }
      return values;
    });
  }

  /**
   * After a switch command, read the live state a few times until it reports the requested state.
   * @param {'charge'|'discharge'|'balance'} key
   * @param {boolean} wanted
   */
  async #awaitSwitch(key, wanted) {
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 100 : 300);
      try {
        /** @type {boolean | undefined} */
        let state;
        if (key === 'balance') {
          this.#setBalancerRegister(modbusRegisters(await this.#read(D2.BALANCER.start, D2.BALANCER.count, { retries: 0 }))[0]);
          state = this.balancerSwitch;
        } else if (this.flavour === 'p81') {
          await this.#readP81Realtime({ retries: 0 });
          state = key === 'charge' ? this.rt2?.chargeMos : this.rt2?.dischargeMos;
        } else {
          const st = await this.#readD2Status({ retries: 0 });
          state = key === 'charge' ? st.chargeMos : st.dischargeMos;
        }
        if (state === wanted) return;
      } catch {
        /* the next attempt or the settings reload tells */
      }
    }
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    const meta = f.meta ?? {};
    if (meta.kind === 'local') {
      this.sign.user = !!value;
      if (this.ctx.options) this.ctx.options[invertOption(this.definition.id)] = this.sign.user;
      return;
    }
    await this.channel.exclusive(async () => {
      switch (meta.kind) {
        case 'register':
          return this.#write(meta.register, registerWriteValue(meta, Number(value)));
        case 'register-flag':
          return this.#write(meta.register, value ? 1 : 0);
        case 'soc':
          return this.#write(meta.register, Math.round(Number(value) * 10));
        case 'switch':
          await this.#write(meta.register, value ? 1 : 0);
          return this.#awaitSwitch(meta.key, !!value);
        default:
          throw new Error(msg('Unknown setting'));
      }
    });
  }

  /** @param {string} id */
  async runAction(id) {
    const f = this.fields.get(id);
    if (!f || f.type !== 'action' || f.meta?.kind !== 'action') throw new Error(msg('Unknown action'));
    const { register, value } = f.meta;
    await this.channel.exclusive(async () => {
      try {
        await this.#write(register, value, { retries: 0 });
      } catch (err) {
        // Restart and shutdown may silence the BMS before the echo arrives.
        if (!isTimeout(err) || id === 'daly.current_zero') throw err;
        this.log?.event(`Daly ${id}: no echo, the BMS may be restarting or off`, { source: this.definition.id });
      }
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

/**
 * GATT layouts (spec 2.1.2): FFF0 with FFF1 notify / FFF2 write on every Daly module, FF00 with
 * FF01 / FF02 as the fallback of newer firmware. Writes without response, as the official app does.
 * @param {string} prefix
 */
const bleProfiles = (prefix) => [
  {
    id: `${prefix}-fff0`,
    label: 'FFF0 (FFF1/FFF2)',
    service: 0xfff0,
    notify: 0xfff1,
    write: 0xfff2,
    writeMode: /** @type {const} */ ('prefer-without-response'),
    chunkSize: 20,
  },
  {
    id: `${prefix}-ff00`,
    label: 'FF00 (FF01/FF02)',
    service: 0xff00,
    notify: 0xff01,
    write: 0xff02,
    writeMode: /** @type {const} */ ('prefer-without-response'),
    chunkSize: 20,
  },
];

/**
 * Advertisement (spec 2.1.1, 11.1): `DL-` or `JHB-` names; the first two manufacturer data bytes
 * (reported as company id, not a registered vendor id) seen on Daly modules. Renamed devices are
 * found through the manufacturer data.
 */
const bleAdvertising = {
  namePrefixes: ['DL-', 'JHB-'],
  namePatterns: [/^DL-/, /^JHB-/],
  manufacturerIds: [0x0102, 0x0104, 0x0107, 0x0302, 0x0303, 0x0402],
};

/**
 * UART / RS485 at 9600 8N1 (spec 2.2). One RS485 user runs 115200, which is not confirmed as a
 * setting, so it is not offered.
 * @param {string} prefix
 */
const serialProfiles = (prefix) => [
  {
    id: `${prefix}-9600`,
    label: 'UART / RS485 9600 8N1',
    baudRate: 9600,
    dataBits: /** @type {const} */ (8),
    stopBits: /** @type {const} */ (1),
    parity: /** @type {const} */ ('none'),
  },
];

const SERIAL_NOTE = msg(
  'UART (3.3 V TTL, ground is the battery negative B-) or RS485 at 9600 baud. RS485 traffic does not wake a sleeping BMS: wake it with current, the button or the UART.',
);

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const dalyDefinition = {
  id: 'daly',
  family: 'daly',
  vendor: DALY_VENDOR,
  protocol: msg('Daly classic (A5)'),
  deviceType: 'bms',
  description: msg('Daly Smart BMS with the classic 13 byte protocol (frames starting with A5): older J/T/A/U/W/ND series, their Bluetooth dongles and the UART port of some newer boards.'),
  links: {
    ble: { profiles: bleProfiles('daly'), ...bleAdvertising },
    serial: { profiles: serialProfiles('daly-uart'), note: SERIAL_NOTE },
  },
  create: (ctx) => new DalyClassicDriver(dalyDefinition, ctx),
  demo: { name: 'DL-401710015C9B (demo)', chunkSize: 20, create: (link) => createDalySimulator(link) },
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const dalyModbusDefinition = {
  id: 'daly-modbus',
  family: 'daly',
  vendor: DALY_VENDOR,
  protocol: msg('Daly Modbus'),
  deviceType: 'bms',
  description: msg('Daly H/K/M/S series, ESS packs and active balancers with the Modbus style protocol (address D2, or 0x81 for board 1 with replies from 0x51).'),
  links: {
    ble: { profiles: bleProfiles('daly-modbus'), ...bleAdvertising },
    serial: { profiles: serialProfiles('daly-modbus-uart'), note: SERIAL_NOTE },
  },
  create: (ctx) => new DalyModbusDriver(dalyModbusDefinition, ctx),
  demo: { name: 'DL-40D63C3223A2 (demo)', chunkSize: 20, create: (link) => createDalyModbusSimulator(link) },
};
