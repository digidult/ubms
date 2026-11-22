import { BaseDriver, alarm, msg } from '@ubms/bms-core';
import { FrameChannel, hex, sleep, slcanBitrateCommand, slcanCommand } from '@ubms/transport';
import {
  CMD,
  DEFAULT_ADDRESS,
  TYPE_CAPACITY,
  batteryTypeText,
  cipherBlock,
  createAa55Assembler,
  createBleAssembler,
  describeAa55,
  describeBle,
  encodeRandom,
  encodeRequest,
  encodeResult,
  encryptRequest,
  isAnswer,
  mainProblem,
  parseAlarmBlock,
  parseCells,
  parseFrame,
  parseHandshake,
  parseMain,
  parseTemperatures,
  randomString,
  sessionKey,
} from './protocol.js';
import { DEYE_ALARM_LABELS, DeyeCanState, PCS_BITRATE, canInfo, canSnapshot, createSlcanAssembler, describeSlcan, slcanMessage } from './can.js';
import { DEMO_BLE_NAME, createDeyeBleSimulator, createDeyeCanSimulator, createDeyeRs485Simulator } from './simulator.js';

/**
 * Deye low voltage battery drivers (docs/protocols/deye.md, "spec" below):
 *
 * - `deye-rs485`: the AA 55 request / answer protocol on the RS485 pins of the PCS port.
 * - `deye-ble`: the same AA 55 frames inside the AES encrypted Bluetooth session (SE-F series).
 * - `deye-can`: the PCS CAN broadcast, read through an SLCAN USB-CAN adapter. The adapter opens in
 *   listen only mode and switches to normal (acknowledging) mode only for a lone battery; it never
 *   transmits a CAN frame.
 *
 * All three are read only: no setting is readable or writable through a documented interface and
 * no action is offered (spec 7, 8). Probes only send the read commands 0x01..0x04, the three
 * handshake messages and SLCAN adapter commands (spec 11.2).
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {import('./protocol.js').MainInfo} MainInfo
 */

export const DEYE_VENDOR = 'Deye';

export const VARIANT = Object.freeze({ RS485: 'DEYE_RS485', BLE: 'DEYE_BLE', CAN: 'DEYE_PCS_CAN' });

/** Advertised name: BAT and the serial number of the QR sticker (spec 2.3, length unverified). */
export const BLE_NAME_PATTERN = /^BAT[0-9A-Z]{6,24}$/;

const NO_ANSWER = msg('No answer from the BMS. It may be asleep or out of range.');
const BAD_ANSWER = msg('The BMS sent an answer that could not be decoded');
const IMPLAUSIBLE = msg('The BMS sent implausible data');

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * RS485 address from the connection options (1..255), or undefined.
 * @param {Record<string, any> | undefined} options
 */
function addressOption(options) {
  const a = Number(options?.address);
  return Number.isInteger(a) && a >= 1 && a <= 255 ? a : undefined;
}

/** Error of an answer that fails the plausibility checks. @param {string} reason */
function implausible(reason) {
  const err = new Error(IMPLAUSIBLE);
  /** @type {any} */ (err).code = 'IMPLAUSIBLE';
  /** @type {any} */ (err).reason = reason;
  return err;
}

/** Error of a Bluetooth session that could not be renewed (the handshake was refused). */
function sessionLost() {
  const err = new Error(NO_ANSWER);
  /** @type {any} */ (err).code = 'NO_SESSION';
  return err;
}

/**
 * @param {unknown} err
 * @param {BaseDriver} driver
 */
function pollError(err, driver) {
  if (isTimeout(err)) return new Error(NO_ANSWER);
  if (/** @type {any} */ (err)?.code === 'NO_SESSION') return /** @type {Error} */ (err);
  if (/** @type {any} */ (err)?.code === 'IMPLAUSIBLE') {
    driver.log?.warn(`${driver.definition.id}: ${/** @type {any} */ (err).reason}`, { source: driver.definition.id });
    return /** @type {Error} */ (err);
  }
  driver.log?.warn(`${driver.definition.id}: ${errorText(err)}`, { source: driver.definition.id });
  return new Error(BAD_ANSWER);
}

// ---------------------------------------------------------------------------------------------
// AA 55 snapshot and device information
// ---------------------------------------------------------------------------------------------

const TEMP_LABELS = [msg('Temperature 1'), msg('Temperature 2'), msg('Temperature 3'), msg('Temperature 4'), msg('Temperature 5'), msg('Temperature 6'), msg('Temperature 7'), msg('Temperature 8')];

/** @param {number} v */
const hexByte = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

/**
 * Unified snapshot of an AA 55 poll (spec 6.1). Voltage and current are the system (bank) values
 * of the pack that answers; for a single pack they are its own.
 * @param {{ main: MainInfo, temps?: ReturnType<typeof parseTemperatures> | null, cells?: ReturnType<typeof parseCells> | null, alarmBlock?: ReturnType<typeof parseAlarmBlock> | null }} p
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function aa55Snapshot({ main, temps, cells, alarmBlock }) {
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = { voltage: main.voltage, soc: main.soc, soh: main.soh, cycles: main.cycles };
  const nominal = TYPE_CAPACITY[/** @type {keyof typeof TYPE_CAPACITY} */ (main.batteryType)];
  if (nominal) s.capacityNominal = nominal;
  /** @type {Record<string, ExtraValue>} */
  const extra = {
    chargeCurrentLimit: { label: msg('Charge current limit'), value: main.chargeCurrentLimit, unit: 'A', decimals: 1 },
    dischargeCurrentLimit: { label: msg('Discharge current limit'), value: main.dischargeCurrentLimit, unit: 'A', decimals: 1 },
    heatingCurrent: { label: msg('Heating current'), value: main.heatingCurrent, unit: 'A', decimals: 1 },
  };
  if (main.current !== undefined) s.current = main.current;
  else extra.currentRaw = { label: msg('Current (raw, out of range)'), value: main.currentRaw, decimals: 0 };

  if (cells) {
    const n = main.cellCount >= 1 && main.cellCount <= cells.cellVoltages.length ? main.cellCount : cells.cellVoltages.filter((v) => v > 0).length;
    // Statistics come from the array: the header extremes are sampled separately (spec 6.1.4).
    s.cells = cells.cellVoltages.slice(0, n);
  }

  /** @type {TemperatureReading[]} */
  const temperatures = [];
  if (temps) {
    const n = Math.min(main.tempCount, temps.temperatures.length);
    for (let i = 0; i < n; i++) temperatures.push({ id: `t${i + 1}`, label: TEMP_LABELS[i], value: temps.temperatures[i], kind: 'cell' });
  }
  temperatures.push({ id: 'mos', label: msg('MOSFET temperature'), value: main.mosTemp, kind: 'mos' });
  // -40 degC (raw 0) means no sensor (spec 6.1.1, 12).
  if (main.boardTemp > -40) temperatures.push({ id: 'board', label: msg('Board temperature'), value: main.boardTemp, kind: 'board' });
  if (main.heaterTemp > -40) temperatures.push({ id: 'heater', label: msg('Heater temperature'), value: main.heaterTemp, kind: 'heater' });
  s.temperatures = temperatures;

  // Bits 0 and 1 are the charge and discharge MOSFETs, which is which is unverified (spec 9.5):
  // only the states where both bits agree are certain.
  const mos = main.mosState & 0x03;
  if (mos === 0x03) s.switches = { charge: true, discharge: true };
  else if (mos === 0) s.switches = { charge: false, discharge: false };
  extra.mosState = { label: msg('MOSFET state (raw)'), value: hexByte(main.mosState) };

  s.alarms = [];
  if (alarmBlock?.active) {
    s.alarms.push(alarm('deye.alarm_raw', { severity: 'warning', label: DEYE_ALARM_LABELS['deye.alarm_raw'], source: `0x02 ${alarmBlock.alarmBytes}` }));
  }

  extra.systemStatus = { label: msg('System status code'), value: main.systemStatus, decimals: 0 };
  extra.subState = { label: msg('Sub-state (raw)'), value: hexByte(main.subState) };
  if (main.socAh !== main.soc) extra.socAh = { label: msg('Second SOC value'), value: main.socAh, unit: '%', decimals: 1 };
  if (main.heatRequest) extra.heatRequest = { label: msg('Heating request (raw)'), value: hexByte(main.heatRequest) };
  if (main.chargeRequest) extra.chargeRequest = { label: msg('Charge request (raw)'), value: hexByte(main.chargeRequest) };
  if (main.statusByte) extra.statusByte = { label: msg('Status byte (raw)'), value: hexByte(main.statusByte) };
  if (main.boardNumber !== undefined) extra.boardNumber = { label: msg('Board number'), value: main.boardNumber, decimals: 0 };
  s.extra = extra;
  return s;
}

/**
 * Device information of a 0x01 answer (spec 10). The hardware version is the best model label.
 * @param {MainInfo} main
 * @param {{ protocol: string, serialNumber?: string }} opts
 * @returns {DeviceInfo}
 */
export function aa55Info(main, { protocol, serialNumber }) {
  /** @type {DeviceInfo} */
  const info = { vendor: DEYE_VENDOR, protocol };
  if (main.hardwareVersion) {
    info.model = main.hardwareVersion;
    info.hardwareVersion = main.hardwareVersion;
  }
  if (main.softwareVersion) info.softwareVersion = main.softwareVersion;
  if (serialNumber) info.serialNumber = serialNumber;
  /** @type {Record<string, ExtraValue>} */
  const extra = {
    batteryType: { label: msg('Battery type'), value: batteryTypeText(main.batteryType) },
    cellCount: { label: msg('Cell count'), value: main.cellCount, decimals: 0 },
    tempCount: { label: msg('Temperature sensor count'), value: main.tempCount, decimals: 0 },
    currentEncoding: { label: msg('Current encoding'), value: main.currentOffset === 3000 ? msg('Offset 3000 (confirmed)') : msg('Offset 30000 (not confirmed)') },
  };
  if (main.pcsProtocol !== undefined) extra.pcsProtocol = { label: msg('PCS protocol (raw)'), value: main.pcsProtocol, decimals: 0 };
  info.extra = extra;
  return info;
}

/**
 * Serial number in an advertised name (BAT + serial, spec 10), or undefined.
 * @param {string} name
 */
export function serialFromName(name) {
  return BLE_NAME_PATTERN.test(name) ? name.slice(3) : undefined;
}

// ---------------------------------------------------------------------------------------------
// AA 55 drivers (RS485 and Bluetooth)
// ---------------------------------------------------------------------------------------------

/** Values of the optional reads older than this are dropped from the snapshot. */
const PART_FRESH_MS = 15000;

/**
 * Shared poll logic of the AA 55 drivers. Subclasses implement `exchange()`, which sends one read
 * command and returns the plaintext answer frame.
 */
export class DeyeAa55Driver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.address = addressOption(ctx.options) ?? DEFAULT_ADDRESS;
    /** @type {FrameChannel} */
    this.channel = /** @type {any} */ (null);
    /** @type {MainInfo | null} */
    this.main = null;
    /** @type {Record<string, { value: any, at: number }>} */
    this.parts = {};
    /** Consecutive polls whose 0x01 read timed out. */
    this.mainTimeouts = 0;
  }

  /**
   * Called inside `channel.exclusive` before the 0x01 read of every poll; the Bluetooth driver
   * renews its session here.
   */
  async beforeMain() {}

  /**
   * Sends one read command and returns the answer frame (only inside `channel.exclusive`).
   * @param {number} _command
   * @param {{ timeout?: number, retries?: number }} [_opts]
   * @returns {Promise<Uint8Array>}
   */
  async exchange(_command, _opts) {
    throw new Error('Not implemented');
  }

  /**
   * @param {number} command
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async read(command, opts) {
    const p = /** @type {import('./protocol.js').Aa55Frame} */ (parseFrame(await this.exchange(command, opts)));
    return p.data;
  }

  /**
   * 0x01 with the detection checks (spec 11.2).
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async readMain(opts) {
    const data = await this.read(CMD.MAIN, opts);
    const problem = mainProblem(data);
    if (problem) throw implausible(`0x01 answer rejected: ${problem}`);
    const main = parseMain(data);
    if (main.current === undefined) this.log?.warn(`Deye: pack current raw ${main.currentRaw} is outside ±1000 A with offset ${main.currentOffset}, not shown`, { source: this.definition.id });
    this.main = main;
    return main;
  }

  /** Optional read: kept with its time, failures only logged. @param {number} command @param {string} key @param {(d: Uint8Array) => any} parse */
  async #part(command, key, parse) {
    try {
      this.parts[key] = { value: parse(await this.read(command, { retries: 0 })), at: Date.now() };
    } catch (err) {
      this.log?.warn(`Deye 0x0${command}: ${isTimeout(err) ? 'no answer' : errorText(err)}`, { source: this.definition.id });
    }
    const p = this.parts[key];
    return p && Date.now() - p.at <= PART_FRESH_MS ? p.value : null;
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      try {
        await this.beforeMain();
        const main = await this.readMain();
        this.mainTimeouts = 0;
        const temps = await this.#part(CMD.TEMPERATURES, 'temps', parseTemperatures);
        const cells = await this.#part(CMD.CELLS, 'cells', parseCells);
        const alarmBlock = await this.#part(CMD.ALARMS, 'alarms', parseAlarmBlock);
        return aa55Snapshot({ main, temps, cells, alarmBlock });
      } catch (err) {
        // The optional reads catch their own errors: a timeout here is the 0x01 read (or the
        // renewal handshake of the Bluetooth session).
        if (isTimeout(err)) this.mainTimeouts++;
        throw pollError(err, this);
      }
    });
    this.publish(snap);
  }

  /** @returns {string | undefined} */
  serialNumber() {
    return undefined;
  }

  async readInfo() {
    if (!this.main) {
      try {
        await this.channel.exclusive(() => this.readMain());
      } catch (err) {
        this.log?.warn(`Deye device information: ${errorText(err)}`, { source: this.definition.id });
        return this.lastInfo;
      }
    }
    return this.publishInfo(aa55Info(/** @type {MainInfo} */ (this.main), { protocol: this.definition.protocol, serialNumber: this.serialNumber() }));
  }

  dispose() {
    this.channel?.stop();
    super.dispose();
  }
}

/** Answer timeout on RS485: answers come in 60 to 80 ms (spec 3.4, 4.1). */
const RS485_TIMEOUT = 500;
/** Pause between requests on the half duplex bus (not documented; the vendor tool waits longer). */
const RS485_GAP_MS = 30;

export class DeyeRs485Driver extends DeyeAa55Driver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: (h) => createAa55Assembler(h), describe: describeAa55, log: ctx.log }).start();
    this.lastIoAt = 0;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: false, writeSettings: false, streaming: false, pollIntervalMs: 1000, minPollIntervalMs: 1000 };
  }

  /**
   * @param {number} command
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async exchange(command, { timeout = RS485_TIMEOUT, retries = 1 } = {}) {
    const idle = Date.now() - this.lastIoAt;
    if (idle < RS485_GAP_MS) await sleep(RS485_GAP_MS - idle);
    const req = encodeRequest(command, this.address);
    const d = describeAa55(req);
    try {
      // The answer repeats address and command and carries data; an echo of the request (n = 0)
      // on adapters that hear themselves never matches.
      return await this.channel.requestUnqueued(req, { match: (f) => f[2] === this.address && f[3] === command && isAnswer(f), timeout, retries, name: d?.name, decode: d?.decode });
    } finally {
      this.lastIoAt = Date.now();
    }
  }

  /**
   * Read only probe (spec 11.2): 0x01 at 9600, then an optional 0x04 check of the cells.
   * Seplos V2 and Pylontech packs wait for '~', Modbus devices see address 0xAA, JBD waits for
   * 0xDD and Daly for 0xA5, so foreign devices stay silent.
   * @param {{ timeout?: number }} [_opts]
   */
  async probe(_opts) {
    return this.channel.exclusive(async () => {
      /** @type {MainInfo} */
      let main;
      try {
        main = await this.readMain({ timeout: RS485_TIMEOUT, retries: 1 });
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'IMPLAUSIBLE') this.log?.event(`Deye RS485: ${/** @type {any} */ (err).reason}`, { source: this.definition.id });
        return null;
      }
      let confidence = main.softwareVersion.startsWith('LVESS') ? 0.95 : 0.8;
      try {
        const cells = parseCells(await this.read(CMD.CELLS, { timeout: RS485_TIMEOUT, retries: 0 })).cellVoltages.slice(0, main.cellCount);
        if (!cells.every((v) => v >= 1 && v <= 5)) {
          this.log?.event('Deye RS485: cell voltages outside 1..5 V in the 0x04 answer', { source: this.definition.id });
          confidence = Math.min(confidence, 0.8);
        }
      } catch {
        /* the 0x04 check is optional */
      }
      this.setVariant(VARIANT.RS485);
      return { variant: VARIANT.RS485, confidence, info: aa55Info(main, { protocol: this.definition.protocol }) };
    });
  }
}

/** Waiting time for the cipher answer and the encrypted answers ([SX] client: 5 s). */
const BLE_TIMEOUT = 2500;
/** Pause after the result message before the first encrypted request (not documented). */
const BLE_SESSION_PAUSE_MS = 100;
/**
 * Polls in a row whose 0x01 read timed out before the session is renewed with a new handshake.
 * Whether and when the battery drops a session while GATT stays connected (module reset, idle
 * time, the Deye app connecting) is not documented (spec 4.2); renewing is harmless.
 */
const SESSION_RENEW_AFTER = 2;

export class DeyeBleDriver extends DeyeAa55Driver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    /** The advertised name: the session key derives from it (spec 3.2). */
    this.deviceName = String(ctx.link?.name ?? '');
    /** @type {string | null} session key after a successful handshake */
    this.key = null;
    /** Random string source; tests may replace it. */
    this.random = () => randomString();
    /** Waiting time for each handshake and encrypted answer during polls; tests may shorten it. */
    this.answerTimeout = BLE_TIMEOUT;
    this.channel = new FrameChannel(ctx.link, { createAssembler: (h) => createBleAssembler({ ...h, getKey: () => this.key }), describe: describeBle, log: ctx.log }).start();
  }

  /**
   * Renews the session after SESSION_RENEW_AFTER polls without a 0x01 answer (or without a key):
   * the battery may have dropped the session while GATT stayed connected, and then ignores every
   * request encrypted with the old key. A refused handshake fails the poll.
   */
  async beforeMain() {
    if (this.key && this.mainTimeouts < SESSION_RENEW_AFTER) return;
    this.log?.event(`Deye BLE: ${this.key ? `no answer to ${this.mainTimeouts} polls` : 'no session key'}, renewing the session (new handshake)`, { source: this.definition.id });
    if (!(await this.handshake(this.answerTimeout))) throw sessionLost();
    this.mainTimeouts = 0;
    await sleep(BLE_SESSION_PAUSE_MS);
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // A sensible Bluetooth poll interval is unverified (spec 4.2): 2 s, at least 1 s.
    return { settings: false, writeSettings: false, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  serialNumber() {
    return serialFromName(this.deviceName);
  }

  /**
   * Handshake (spec 3.2): random, check of the cipher block, result. Only inside
   * `channel.exclusive`. Returns false when the block does not match (foreign device, or a name
   * that differs from the advertised one).
   * @param {number} timeout
   */
  async handshake(timeout) {
    this.key = null;
    const randomStr = this.random();
    const key = sessionKey(this.deviceName, randomStr);
    const answer = await this.channel.requestUnqueued(encodeRandom(randomStr), {
      match: (f) => parseHandshake(f)?.tag === 'cipher',
      timeout,
      retries: 0,
      name: 'Deye handshake random',
      decode: () => ({ randomStr }),
    });
    const h = /** @type {import('./protocol.js').HandshakeMessage} */ (parseHandshake(answer));
    const expected = hex(cipherBlock(key, randomStr));
    if (h.block !== expected) {
      this.log?.warn(`Deye BLE: the cipher block does not match the name "${this.deviceName}" (got ${h.block}, expected ${expected})`, { source: this.definition.id });
      return false;
    }
    await this.link.write(encodeResult(1), { name: 'Deye handshake result', decode: () => ({ status: 1 }) });
    this.key = key;
    return true;
  }

  /**
   * @param {number} command
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async exchange(command, { timeout = this.answerTimeout, retries = 1 } = {}) {
    if (!this.key) throw new Error(msg('The Bluetooth session is not established'));
    const plain = encodeRequest(command, this.address);
    const d = describeAa55(plain);
    return this.channel.requestUnqueued(encryptRequest(this.key, plain), {
      match: (f) => f[0] === 0xaa && f[2] === this.address && f[3] === command && isAnswer(f),
      timeout,
      retries,
      name: d ? `${d.name} (encrypted)` : undefined,
      decode: d?.decode,
    });
  }

  /**
   * Read only probe (spec 11.2): the handshake (0.9 when the cipher block matches), then an
   * encrypted 0x01 whose answer passes the RS485 checks (0.98).
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = BLE_TIMEOUT } = {}) {
    const per = clamp(timeout, 1500, 5000);
    return this.channel.exclusive(async () => {
      try {
        if (!(await this.handshake(per))) return null;
      } catch (err) {
        if (!isTimeout(err)) this.log?.warn(`Deye BLE handshake: ${errorText(err)}`, { source: this.definition.id });
        return null;
      }
      let confidence = 0.9;
      /** @type {MainInfo | null} */
      let main = null;
      await sleep(BLE_SESSION_PAUSE_MS);
      try {
        main = await this.readMain({ timeout: per, retries: 0 });
        confidence = 0.98;
      } catch (err) {
        this.log?.warn(`Deye BLE: first encrypted read: ${/** @type {any} */ (err)?.reason ?? errorText(err)}`, { source: this.definition.id });
      }
      this.setVariant(VARIANT.BLE);
      /** @type {Partial<DeviceInfo>} */
      const info = main ? aa55Info(main, { protocol: this.definition.protocol, serialNumber: this.serialNumber() }) : { vendor: DEYE_VENDOR, protocol: this.definition.protocol };
      return { variant: VARIANT.BLE, confidence, info };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// PCS CAN through an SLCAN adapter
// ---------------------------------------------------------------------------------------------

/** Listen window of the probe: three bank cycles (spec 11.2). */
export const LISTEN_MS = 3000;
/**
 * First part of the window, in listen only mode: when another node (the inverter) acknowledges,
 * the battery's frames arrive within one bank cycle of 1 s (spec 4.3).
 */
export const LISTEN_ONLY_MS = 1500;
/** Without battery frames for this long the poll reports an error. */
const STALL_MS = 5000;
/** Waiting time for the CR or BEL of an adapter command. */
const COMMAND_TIMEOUT = 500;
/** The frames of one bank cycle come back to back; this much silence ends the burst. */
const SETTLE_QUIET_MS = 150;

export class DeyeCanDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.state = new DeyeCanState();
    this.listenMs = LISTEN_MS;
    this.listenOnlyMs = LISTEN_ONLY_MS;
    this.channelOpen = false;
    /** @type {'listen'|'normal'|null} mode of the open adapter channel */
    this.mode = null;
    /** The stall fallback from listen only to normal mode was tried. */
    this.normalFallback = false;
    this.disposed = false;
    this.streaming = false;
    this.startedAt = 0;
    /** @type {(() => void) | null} */
    this.onUpdate = null;
    /** @type {(() => void) | null} */
    this.cancelListen = null;
    this.infoKey = '';
    this.channel = new FrameChannel(ctx.link, { createAssembler: (h) => createSlcanAssembler(h), describe: describeSlcan, log: ctx.log });
    this.offFrame = this.channel.on('frame', (/** @type {Uint8Array} */ f) => this.#onLine(f));
    this.channel.start();
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // The battery broadcasts; poll() only builds the snapshot from the latest frames.
    return { settings: false, writeSettings: false, streaming: true, pollIntervalMs: 1000, minPollIntervalMs: 1000 };
  }

  /** @param {Uint8Array} f */
  #onLine(f) {
    const m = slcanMessage(f);
    if (m.type !== 'frame') return;
    const before = this.state.profile;
    this.state.ingest(m.frame);
    if (this.state.profile && this.state.profile !== before) {
      this.log?.event(`Deye CAN: ${this.state.profile === 'victron' ? 'victronCAN' : 'Deye native'} profile`, { source: this.definition.id });
    }
    this.onUpdate?.();
  }

  /**
   * One adapter command; resolves 'ok' (CR) or 'error' (BEL). Only inside `channel.exclusive`.
   * @param {Uint8Array} bytes
   * @param {string} name
   */
  async #command(bytes, name) {
    const f = await this.channel.requestUnqueued(bytes, { match: (fr) => fr.length === 1 && (fr[0] === 0x0d || fr[0] === 0x07), timeout: COMMAND_TIMEOUT, name: `SLCAN ${name}` });
    return f[0] === 0x0d ? 'ok' : 'error';
  }

  /** Best effort C without waiting (the channel may be open, the link may be closing). */
  #closeNow() {
    void this.link.write(slcanCommand('C'), { name: 'SLCAN C' }).catch(() => {});
  }

  /**
   * Opens the adapter channel in listen only (L) or normal (O) mode. A timed out open command
   * leaves the adapter state unknown, so a best effort C follows. Returns the reason of a failure
   * or null. Only inside `channel.exclusive`.
   * @param {'L'|'O'} cmd
   */
  async #openChannel(cmd) {
    try {
      if ((await this.#command(slcanCommand(cmd), cmd)) !== 'ok') return 'the adapter refused to open the channel (BEL)';
      this.channelOpen = true;
      this.mode = cmd === 'L' ? 'listen' : 'normal';
      return null;
    } catch (err) {
      if (isTimeout(err)) this.#closeNow();
      throw err;
    }
  }

  /**
   * C, S6, L (spec 4.3): close a channel left open (a Lawicel adapter answers BEL when it was
   * closed already), set 500 kbit/s, open listen only, so the adapter neither acknowledges nor
   * sends error frames. An adapter without listen only mode (BEL to L) is opened normally.
   * Returns the reason of a failure or null.
   */
  async #open() {
    try {
      try {
        await this.#command(slcanCommand('C'), 'C');
      } catch (err) {
        // Only the answer to S6 decides whether an SLCAN adapter is there.
        if (!isTimeout(err)) throw err;
      }
      if ((await this.#command(slcanBitrateCommand(PCS_BITRATE), 'S6')) !== 'ok') return 'the adapter refused the bit rate command S6 (BEL)';
      if (!(await this.#openChannel('L'))) return null;
      this.log?.event('Deye CAN: the adapter refused listen only mode (L), opening it in normal mode', { source: this.definition.id });
      return await this.#openChannel('O');
    } catch (err) {
      return isTimeout(err) ? 'no SLCAN reply (not an SLCAN adapter, an adapter that does not answer commands such as the stock CANable firmware, or wrong state)' : errorText(err);
    }
  }

  /**
   * C, O: reopens the channel in normal mode, so the adapter acknowledges the frames of a battery
   * that is the only other node (in listen only mode nobody acknowledges, the battery repeats its
   * first frame and the adapter receives nothing, spec 4.3). Normal mode transmits no frame of its
   * own. Returns the reason of a failure or null. Only inside `channel.exclusive`.
   */
  async #reopenNormal() {
    try {
      this.channelOpen = false;
      this.mode = null;
      if ((await this.#command(slcanCommand('C'), 'C')) !== 'ok') return 'the adapter refused to close the channel (BEL)';
      return await this.#openChannel('O');
    } catch (err) {
      return isTimeout(err) ? 'no SLCAN reply' : errorText(err);
    }
  }

  async #close() {
    if (!this.channelOpen) return;
    this.channelOpen = false;
    this.mode = null;
    try {
      await this.channel.send(slcanCommand('C'), { name: 'SLCAN C' });
    } catch {
      /* the link may be gone */
    }
  }

  /**
   * Waits until the 0.95 rule holds or the window ends, then returns the detection result.
   * @param {number} ms
   * @returns {Promise<ReturnType<DeyeCanState['detection']>>}
   */
  #listen(ms) {
    return new Promise((resolve) => {
      /** @param {ReturnType<DeyeCanState['detection']>} d */
      const finish = (d) => {
        clearTimeout(timer);
        this.onUpdate = null;
        this.cancelListen = null;
        resolve(d);
      };
      const timer = setTimeout(() => finish(this.state.detection()), ms);
      this.cancelListen = () => finish(null);
      this.onUpdate = () => {
        const d = this.state.detection();
        if (d && d.confidence >= 0.95) finish(d);
      };
      this.onUpdate();
    });
  }

  /**
   * Probe (spec 11.2): opens the adapter channel listen only and listens; when nothing arrives in
   * the first LISTEN_ONLY_MS (no other node acknowledges: a lone battery repeats its first frame),
   * reopens it in normal mode for the rest of the window. Never transmits a CAN frame.
   * @param {{ timeout?: number }} [_opts]
   */
  async probe(_opts) {
    const problem = await this.channel.exclusive(() => this.#open());
    if (problem) {
      this.log?.event(`Deye CAN: ${problem}`, { source: this.definition.id });
      return null;
    }
    const started = Date.now();
    let d = await this.#listen(this.mode === 'listen' ? Math.min(this.listenOnlyMs, this.listenMs) : this.listenMs);
    if (this.disposed) return null;
    if (this.mode === 'listen' && (!d || d.confidence < 0.95)) {
      if (this.state.frames === 0) {
        const reopen = await this.channel.exclusive(() => this.#reopenNormal());
        if (reopen) {
          this.log?.event(`Deye CAN: ${reopen}`, { source: this.definition.id });
          this.#closeNow();
          return null;
        }
        this.log?.event('Deye CAN: no frames in listen only mode, the adapter now acknowledges (normal mode, lone battery)', { source: this.definition.id });
      } else {
        this.log?.event('Deye CAN: listen only mode (another node acknowledges the frames)', { source: this.definition.id });
      }
      d = await this.#listen(Math.max(0, this.listenMs - (Date.now() - started)));
      if (this.disposed) return null;
    } else if (this.mode === 'listen') {
      this.log?.event('Deye CAN: listen only mode (another node acknowledges the frames)', { source: this.definition.id });
    }
    if (!d) {
      this.log?.event(`Deye CAN: ${this.state.detectionProblem()}`, { source: this.definition.id });
      await this.#close();
      return null;
    }
    // Let the current burst of the bank cycle finish, so the first snapshot is complete.
    while (Date.now() - this.state.lastBatteryAt < SETTLE_QUIET_MS && Date.now() - started < this.listenMs) await sleep(25);
    this.setVariant(VARIANT.CAN);
    return { variant: VARIANT.CAN, confidence: d.confidence, info: canInfo(this.state, this.definition.protocol) };
  }

  async start() {
    this.streaming = true;
    this.startedAt = Date.now();
  }

  async poll() {
    if (!this.streaming) return;
    const now = Date.now();
    if (now - Math.max(this.state.lastBatteryAt, this.startedAt) > STALL_MS) {
      // In listen only mode the frames stop when the acknowledging node (the inverter) leaves the
      // bus: then the adapter has to acknowledge them itself (spec 4.3). Tried once.
      if (this.mode === 'listen' && !this.normalFallback) {
        this.normalFallback = true;
        const problem = await this.channel.exclusive(() => this.#reopenNormal());
        if (!problem) {
          this.log?.event('Deye CAN: no frames in listen only mode, the adapter now acknowledges (normal mode)', { source: this.definition.id });
          this.startedAt = Date.now();
          return;
        }
        this.log?.warn(`Deye CAN: ${problem}`, { source: this.definition.id });
        this.#closeNow();
      }
      throw new Error(msg('No CAN frames from the battery for several seconds'));
    }
    this.publish(canSnapshot(this.state, now));
    // Serial number and versions arrive every 2.1 s, often after the probe.
    const info = canInfo(this.state, this.definition.protocol);
    const key = JSON.stringify(info);
    if (key !== this.infoKey) {
      this.infoKey = key;
      this.publishInfo(info);
    }
  }

  async readInfo() {
    const info = canInfo(this.state, this.definition.protocol);
    this.infoKey = JSON.stringify(info);
    return this.publishInfo(info);
  }

  async stop() {
    this.streaming = false;
    await this.#close();
  }

  dispose() {
    this.disposed = true;
    this.cancelListen?.();
    this.offFrame?.();
    // The session may release a driver without stop() (a probe result dropped by Cancel): close
    // the adapter channel so it does not stay open on the battery bus.
    if (this.channelOpen) {
      this.channelOpen = false;
      this.mode = null;
      this.#closeNow();
    }
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------------------------

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const deyeRs485Definition = {
  id: 'deye-rs485',
  family: 'deye',
  vendor: DEYE_VENDOR,
  protocol: msg('Deye LVESS (RS485)'),
  deviceType: 'bms',
  description: msg(
    'Deye low voltage batteries with the LVESS BMS (SE-G5.1 Pro, SE-F series, RW-M6.1 and others) on the RS485 pins of the PCS port: read only cells, temperatures, limits and versions.',
  ),
  links: {
    serial: {
      profiles: [{ id: 'deye-rs485-9600', label: 'RS485 9600 8N1', baudRate: 9600, dataBits: /** @type {const} */ (8), stopBits: /** @type {const} */ (1), parity: /** @type {const} */ ('none') }],
      // Reading while the inverter talks RS485 to the pack is covered by no source (spec 4.1, 12).
      note: msg(
        'USB to RS485 adapter on the PCS port at 9600 baud: pin 1 or 8 is B, pin 2 or 7 is A (CAN is on pins 4 and 5). Never connect the port to another device with a straight patch cable. Use the RS485 pins only when the inverter talks to the battery over CAN; with the inverter on RS485, ubms would share the bus with it.',
      ),
    },
  },
  create: (ctx) => new DeyeRs485Driver(deyeRs485Definition, ctx),
  demo: { name: 'Deye SE-G5.1 Pro (demo)', chunkSize: 0, create: (link) => createDeyeRs485Simulator(link) },
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const deyeBleDefinition = {
  id: 'deye-ble',
  family: 'deye',
  vendor: DEYE_VENDOR,
  protocol: msg('Deye LVESS (Bluetooth)'),
  deviceType: 'bms',
  experimental: true,
  description: msg('Deye SE-F series batteries with built-in Bluetooth (names BAT and the serial number): read only live data through the encrypted session of the Deye Cloud app.'),
  links: {
    ble: {
      profiles: [
        {
          id: 'deye-fff1',
          label: 'FFF1 (FFF2)',
          service: 0xfff1,
          notify: 0xfff2,
          write: 0xfff2,
          writeMode: /** @type {const} */ ('prefer-without-response'),
          // Each GATT write must carry one whole message (the battery decrypts every write on its
          // own, spec 3.2); the longest is 32 bytes, so never split. Needs an ATT MTU of at least 35,
          // which the browser and the OS negotiate (unverified for every platform).
          chunkSize: 64,
        },
      ],
      namePrefixes: ['BAT'],
      namePatterns: [BLE_NAME_PATTERN],
      // Whether the battery advertises FFF1 is not documented: request access, do not filter on it.
      optionalServices: [0xfff1],
    },
  },
  create: (ctx) => new DeyeBleDriver(deyeBleDefinition, ctx),
  demo: { name: DEMO_BLE_NAME, chunkSize: 20, create: (link) => createDeyeBleSimulator(link, { name: DEMO_BLE_NAME }) },
};

/**
 * @type {import('../index.js').DriverDefinitionWithDemo & { links: { serial: import('@ubms/bms-core/driver').SerialRequirements & { autoDetect: false } } }}
 */
export const deyeCanDefinition = {
  id: 'deye-can',
  family: 'deye',
  vendor: DEYE_VENDOR,
  protocol: msg('Deye PCS CAN (USB-CAN adapter)'),
  deviceType: 'bms',
  description: msg(
    'Deye low voltage batteries on the CAN pins of the PCS port, read through an SLCAN (Lawicel) USB-CAN adapter: bank and pack values, limits and alarms. Never sends a CAN frame; the adapter acknowledges frames only when no inverter does. No individual cell voltages.',
  ),
  links: {
    serial: {
      // 115200 is ignored by USB CDC adapters such as the CANable and is the usual default of
      // serial SLCAN adapters (general practice, unverified for clones; spec 11.4).
      profiles: [{ id: 'deye-can-slcan', label: 'SLCAN, CAN 500 kbit/s', baudRate: 115200, dataBits: /** @type {const} */ (8), stopBits: /** @type {const} */ (1), parity: /** @type {const} */ ('none') }],
      // Explicit selection only (spec 11.4): the probe writes SLCAN commands, which an RS485 BMS
      // receives as noise, and the binary probes of other families could make an SLCAN adapter
      // open the channel and transmit a frame onto the battery bus.
      autoDetect: false,
      // The adapter must answer every command with CR or BEL. The stock CANable slcan firmware
      // answers none and has no L command (source read, unverified on hardware; spec 2.4).
      note: msg(
        'SLCAN (Lawicel) USB-CAN adapter that answers its commands, for example a USBtin or a Lawicel CANUSB: CAN H on pin 4 and CAN L on pin 5 of the PCS port, 500 kbit/s. The stock CANable slcan firmware sends no answers and is not supported. Select this type explicitly; automatic detection does not try it.',
      ),
    },
  },
  create: (ctx) => new DeyeCanDriver(deyeCanDefinition, ctx),
  demo: { name: 'Deye SE-F12-C, USB-CAN adapter (demo)', chunkSize: 0, create: (link) => createDeyeCanSimulator(link) },
};
