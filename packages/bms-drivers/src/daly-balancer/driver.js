import { BaseDriver, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, equals, sleep, u16be } from '@ubms/transport';
import {
  BLOCK,
  FN,
  REG,
  VARIANT,
  WRITABLE_REGISTERS,
  createAssembler,
  describe,
  encodeRead,
  encodeWrite,
  parseSettings,
  parseStatus,
  parseSwitchBlock,
  parseBalanceBlock,
  parseVersion,
  reverseText,
  settingsSignature,
  statusProblem,
  statusSignature,
} from './protocol.js';
import { buildDalyBalancerSchema, decodeBalancerSettings, rawSettingValue } from './settings.js';
import { createDalyBalancerSimulator } from './simulator.js';

/**
 * Driver of the Daly active balancers (docs/protocols/daly-balancer.md, "spec" below): the Daly
 * "Smart Active Balance Module" boards read over the Daly Bluetooth module (service FFF0) or the
 * UART port at 9600 baud with the Modbus style D2 frames. Device type 'balancer', family 'daly'.
 *
 * The balancer answers the same register blocks as a Daly D2 BMS but fills current, SOC, capacity,
 * cycles, MOSFET flags and the current limits with fixed values (spec 1.4); the probe uses exactly
 * that signature (spec 11.3), so it runs before `daly-modbus`, which would otherwise take a
 * balancer for a BMS with 0 A (spec 11.5, 12 item 1).
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 */

/**
 * Vendor name of this definition: the same string as DALY_VENDOR of `../daly/`, written as a
 * literal to keep this folder independent. The family `daly` is shared
 * with the Daly BMS drivers and the type selector names a family after its first registered
 * definition, so an equal vendor keeps the label "Daly BMS" with the balancer registered first
 * (spec 11.5).
 */
export const DALY_BALANCER_VENDOR = 'Daly BMS';

const PROTOCOL = msg('Daly balancer (Modbus D2)');
const MODEL = msg('Active balancer');
const NO_ANSWER = msg('No answer from the balancer. It may be asleep or out of range.');
const IMPLAUSIBLE = msg('The balancer sent implausible data');
const REJECTED = msg('The balancer rejected the request');
const NOT_APPLIED = msg('The balancer did not apply the new value.');

const STATE_LABELS = {
  off: msg('Off'),
  idle: msg('Idle'),
  balancing: msg('Balancing now'),
};

/** Labels of temperature slots 2..8 (literal for the translation checker). */
const TEMP_LABELS = [
  msg('Board temperature'),
  msg('Temperature 2'),
  msg('Temperature 3'),
  msg('Temperature 4'),
  msg('Temperature 5'),
  msg('Temperature 6'),
  msg('Temperature 7'),
  msg('Temperature 8'),
];

/**
 * Timing per link kind (spec 4.2 step 6): BLE replies came 63 to 501 ms after the request, so
 * 1.5 s; on the UART a reply ends up to 510 ms after the request, so 1.2 s. The pause after the
 * last frame before the next request is a ubms choice (the app paced its requests by the replies).
 */
const TIMING = Object.freeze({
  ble: { timeout: 1500, gap: 30 },
  serial: { timeout: 1200, gap: 50 },
});

/** Shortest probe attempt, ms (when the session asks for a short probe timeout). */
const MIN_PROBE_MS = 400;

/**
 * Consecutive lost replies (timeout or exception reply) after which an optional block (balance
 * block, switch block) is skipped for OPTIONAL_SKIP_POLLS polls (ubms choice: a firmware without
 * it must not slow every poll down, and a lossy link must not lose the block for good).
 */
const OPTIONAL_FAILURES = 2;

/** Polls an optional block is skipped after OPTIONAL_FAILURES lost replies in a row (ubms choice). */
const OPTIONAL_SKIP_POLLS = 15;

/** Highest believable temperature, degrees C: slots 7 and 8 may hold voltages (spec 12 item 2). */
const MAX_TEMPERATURE = 150;

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';
/** @param {unknown} err */
const isRejected = (err) => /** @type {any} */ (err)?.code === 'REJECTED';
/** Error of an exception reply (function with bit 7 set, spec 3.5 step 1). */
function rejectedError() {
  const err = new Error(REJECTED);
  /** @type {any} */ (err).code = 'REJECTED';
  return err;
}
/** @param {import('@ubms/transport').Link} link */
const isSerialLink = (link) => /serial/.test(link?.kind ?? '');
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Drop undefined properties.
 * @template {Record<string, any>} T
 * @param {T} o
 * @returns {T}
 */
function compact(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

// ---------------------------------------------------------------------------------------------
// Snapshot and device info mapping (spec 6.8, 10)
// ---------------------------------------------------------------------------------------------

/**
 * Temperatures of the counted slots: the first is the board sensor (spec 6.1, [CEPR] 4.5). A
 * value above 150 degrees C is dropped (a voltage register read as a temperature, spec 12 item 2).
 * @param {number[]} temps parsed temperatures of the counted slots
 * @returns {TemperatureReading[]}
 */
function temperatures(temps) {
  /** @type {TemperatureReading[]} */
  const out = [];
  temps.slice(0, TEMP_LABELS.length).forEach((value, i) => {
    if (!Number.isFinite(value) || value > MAX_TEMPERATURE) return;
    out.push(i === 0 ? { id: 'board', label: TEMP_LABELS[0], value, kind: 'board' } : { id: `t${i + 1}`, label: TEMP_LABELS[i], value, kind: 'other' });
  });
  return out;
}

/**
 * Balancer state for the overview: balancing while the state register 0x0034 is not 0 (its value
 * set is unverified, spec 9.1), otherwise off or idle by the switch 0x00CF.
 * @param {boolean} active
 * @param {boolean | undefined} switchOn
 */
function stateLabel(active, switchOn) {
  if (active) return STATE_LABELS.balancing;
  return switchOn === false ? STATE_LABELS.off : STATE_LABELS.idle;
}

/**
 * Unified snapshot of a balancer (spec 6.8): cells, the total voltage register, the counted
 * temperatures, the balancing state, the balance current of the balance block (unverified scale),
 * the switch, alarms of the fault registers, a non-zero fault code (classic byte 7, spec 9.2), and
 * the balancing configuration of the last settings read as extra values. No current, power, SOC,
 * capacity, cycles or MOSFET states: the balancer has no current sensor and no MOSFETs (fixed
 * values, spec 6.1). No per cell balancing flags until a capture of an active balancer confirms
 * 0x003E / 0x003F (spec 6.2).
 * @param {Record<string, any>} st parsed status (parseStatus)
 * @param {{ balance?: Record<string, any> | null, switchBlock?: Record<string, any> | null, settings?: Record<string, any> | null }} [blocks]
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function balancerSnapshot(st, { balance = null, switchBlock = null, settings = null } = {}) {
  const switchOn = /** @type {boolean | undefined} */ (switchBlock?.balancerSwitch);
  const active = st.balancingState !== 0;
  const current = balance?.balanceCurrent ?? st.balance?.balanceCurrent;
  /** @type {Record<string, ExtraValue>} */
  const extra = { balancer: { label: msg('Balancer state'), value: stateLabel(active, switchOn) } };
  if (st.faultCode) extra.faultCode = { label: msg('Fault code'), value: st.faultCode, decimals: 0 };
  if (settings) {
    extra.startVoltage = { label: msg('Balance start voltage'), value: settings.balanceStartVoltage, unit: 'V', decimals: 3 };
    extra.triggerDelta = { label: msg('Balance trigger voltage difference'), value: settings.balanceTriggerDelta, unit: 'V', decimals: 3 };
  }
  const temps = temperatures(st.temperatures);
  return compact({
    voltage: st.totalVoltage,
    cells: st.cellVoltages,
    temperatures: temps.length ? temps : undefined,
    balancingActive: active,
    balanceCurrent: current === null || current === undefined ? undefined : current,
    switches: switchOn === undefined ? undefined : { balance: switchOn },
    alarms: st.alarms,
    extra,
  });
}

/**
 * Device info (spec 10): the version strings as read, plus the reversed form the Daly tools
 * probably show (unverified, spec 6.4), the machine code when set and the production date when
 * set. The parameter password (0x00C9) is neither read nor shown: device info goes into log
 * exports, and a password the user changed must not end up in bug reports (spec 10).
 * @param {{ version?: Record<string, any> | null, switchBlock?: Record<string, any> | null, status?: Record<string, any> | null }} parts
 * @returns {DeviceInfo}
 */
export function balancerInfo({ version = null, switchBlock = null, status = null }) {
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  if (version?.softwareVersion) extra.softwareVersionReversed = { label: msg('Software version, read backwards'), value: reverseText(version.softwareVersion) };
  if (version?.hardwareVersion) extra.hardwareVersionReversed = { label: msg('Hardware version, read backwards'), value: reverseText(version.hardwareVersion) };
  if (version?.machineCode) extra.machineCode = { label: msg('Machine code'), value: version.machineCode };
  if (Number.isFinite(status?.cellCount)) extra.cellCount = { label: msg('Cell count'), value: status?.cellCount, decimals: 0 };
  return compact({
    vendor: DALY_BALANCER_VENDOR,
    model: MODEL,
    protocol: PROTOCOL,
    softwareVersion: version?.softwareVersion || undefined,
    hardwareVersion: version?.hardwareVersion || undefined,
    manufactureDate: switchBlock?.productionDate,
    extra: Object.keys(extra).length ? extra : undefined,
  });
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export class DalyBalancerDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.serial = isSerialLink(ctx.link);
    this.timing = this.serial ? TIMING.serial : TIMING.ble;
    /** Byte count of the read in flight (assembler check, spec 3.5 step 4). @type {number | undefined} */
    this.expectedByteCount = undefined;
    /** Start register of the read in flight, for the protocol log. @type {number | undefined} */
    this.pendingStart = undefined;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: (h) => createAssembler({ ...h, expectedByteCount: () => this.expectedByteCount }),
      describe: (f) => describe(f, { direction: 'rx', start: this.pendingStart }),
      log: ctx.log,
    }).start();
    this.schema = buildDalyBalancerSchema();
    this.fields = fieldMap(this.schema);
    /** @type {Record<string, any> | null} */
    this.status = null;
    /** @type {Record<string, any> | null} */
    this.settings = null;
    /** Last switch block read (or updated by a confirmed switch write). @type {Record<string, any> | null} */
    this.switchBlock = null;
    /**
     * Optional blocks: lost replies in a row (not reset when skipping starts, so one more loss
     * after the pause starts the next pause) and polls left to skip.
     */
    this.optional = { balance: { failures: 0, skip: 0 }, switch: { failures: 0, skip: 0 } };
    this.lastIoAt = 0;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // The app refreshes its balancer page every 2.5 to 5 s; one poll is three requests on BLE and
    // two on serial (spec 4.2).
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  async #gap() {
    const last = Math.max(this.lastIoAt, this.channel.lastFrameAt);
    const wait = last + this.timing.gap - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /**
   * One request and its reply, one request in flight (spec 4.2 step 6, 12 item 6). Pending input
   * is discarded before every attempt, so a late reply of a timed-out request cannot complete a
   * frame of the next one (spec 3.5 step 6). Only call inside `this.channel.exclusive()`.
   * @param {Uint8Array} bytes
   * @param {(frame: Uint8Array) => boolean} match
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #request(bytes, match, { timeout = this.timing.timeout, retries = 0 } = {}) {
    const d = describe(bytes, { direction: 'tx' });
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.#gap();
      this.channel.assembler.reset();
      try {
        return await this.channel.requestUnqueued(bytes, { match, timeout, retries: 0, name: d?.name, decode: d?.decode });
      } catch (err) {
        lastErr = err;
        if (!isTimeout(err)) throw err;
        if (attempt < retries) this.log?.warn(`No reply to ${d?.name ?? 'request'}, retrying (${attempt + 1}/${retries})`, { source: this.definition.id });
      } finally {
        this.lastIoAt = Date.now();
      }
    }
    throw lastErr;
  }

  /**
   * Read a register block. Replies carry no start register: the byte count identifies them
   * (spec 3.1). Only call inside `this.channel.exclusive()`.
   * @param {{ start: number, count: number }} block
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #read({ start, count }, opts) {
    this.expectedByteCount = 2 * count;
    this.pendingStart = start;
    try {
      const frame = await this.#request(encodeRead(start, count), (f) => (f[1] === FN.READ && f[2] === 2 * count) || f[1] === (FN.READ | 0x80), opts);
      if (frame[1] & 0x80) {
        this.log?.warn(`Daly balancer: exception ${frame[2]} for registers from 0x${start.toString(16).toUpperCase().padStart(4, '0')}`, { source: this.definition.id });
        throw rejectedError();
      }
      return frame;
    } finally {
      this.expectedByteCount = undefined;
      this.pendingStart = undefined;
    }
  }

  /**
   * Read an optional block without a retry. After OPTIONAL_FAILURES lost replies in a row
   * (timeout or exception reply) it is skipped for OPTIONAL_SKIP_POLLS calls and then tried
   * again; a success ends the back-off. Returns null when it was not read. Only call inside
   * `this.channel.exclusive()`.
   * @template T
   * @param {'balance'|'switch'} key
   * @param {{ start: number, count: number }} block
   * @param {(frame: Uint8Array) => T} parse
   * @returns {Promise<T | null>}
   */
  async #optional(key, block, parse) {
    const state = this.optional[key];
    if (state.skip > 0) {
      state.skip--;
      return null;
    }
    try {
      const value = parse(await this.#read(block));
      state.failures = 0;
      return value;
    } catch (err) {
      if (!isTimeout(err) && !isRejected(err)) throw err;
      if (++state.failures >= OPTIONAL_FAILURES) {
        state.skip = OPTIONAL_SKIP_POLLS;
        this.log?.warn(`Daly balancer: no usable reply to the ${key} block ${state.failures} times in a row, skipped for the next ${OPTIONAL_SKIP_POLLS} polls`, { source: this.definition.id });
      }
      return null;
    }
  }

  /**
   * Whether the cached switch block may go into a snapshot: after a lost read it still shows the
   * state of the previous poll, but once the block is skipped (OPTIONAL_FAILURES lost replies in
   * a row) the switch is left out until a read succeeds again, so a stale state is never shown
   * (the Daly app on the second UART of the dual UART model can change it, spec 4.2).
   */
  get #switchFresh() {
    return this.optional.switch.failures < OPTIONAL_FAILURES;
  }

  /**
   * Read only probe (spec 11.3): the 62 register status read, then the settings read. Nothing else
   * is sent: no clock write, no `HiLink`, no AT command, no A5 frame, no 0x81 probe (spec 5.3).
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const perTry = clamp(timeout, MIN_PROBE_MS, this.timing.timeout);
    return this.channel.exclusive(async () => {
      /** @type {Record<string, any>} */
      let st;
      try {
        st = parseStatus(await this.#read(BLOCK.STATUS, { timeout: perTry, retries: 1 }));
      } catch (err) {
        if (!isTimeout(err)) this.log?.warn(`Daly balancer probe: ${errorText(err)}`, { source: this.definition.id });
        return null;
      }
      const problem = statusProblem(st, { strict: true });
      if (problem) {
        this.log?.event(`Daly balancer probe: implausible status (${problem})`);
        return null;
      }
      if (!statusSignature(st)) {
        this.log?.event('Daly D2 device reports current, SOC, capacity, cycles or MOSFET states: a BMS, left to the Daly BMS driver');
        return null;
      }
      let confidence = 0.7;
      try {
        const s = parseSettings(await this.#read(BLOCK.SETTINGS, { timeout: perTry, retries: 1 }));
        if (!settingsSignature(s)) {
          this.log?.event(`Daly D2 device with current limits ${s.currentLimitsRaw.join(', ')}: a BMS, left to the Daly BMS driver`);
          return null;
        }
        this.settings = s;
        confidence = 1;
      } catch (err) {
        if (!isTimeout(err) && !isRejected(err)) {
          this.log?.warn(`Daly balancer probe: ${errorText(err)}`, { source: this.definition.id });
          return null;
        }
        this.log?.event('Daly balancer probe: no settings reply, detected by the status signature only');
      }
      this.status = st;
      this.setVariant(VARIANT);
      const info = balancerInfo({ status: st });
      this.publishInfo(info);
      this.log?.event(`Daly active balancer: ${st.cellCount} cells (confidence ${confidence})`);
      return { variant: VARIANT, confidence, info };
    });
  }

  /**
   * Status, balance current and switch (spec 4.2 step 5). BLE: the reads of the app, status
   * 0x0000 x 62 and the balance block 0x003E x 9. Serial: the 80 register status read confirmed on
   * the UART by cepr, which covers the balance block, so one turnaround less per poll (a UART reply
   * ends up to 510 ms after the request). Then the switch block 0x00CC x 5 on both links.
   */
  async poll() {
    const snap = await this.channel.exclusive(async () => {
      /** @type {Record<string, any>} */
      let st;
      try {
        st = parseStatus(await this.#read(this.serial ? BLOCK.STATUS_80 : BLOCK.STATUS, { retries: 1 }));
      } catch (err) {
        if (isTimeout(err)) throw new Error(NO_ANSWER);
        throw err;
      }
      const problem = statusProblem(st);
      if (problem) {
        // The detail goes to the protocol log; the error text reaches the user and is translated.
        this.log?.warn(`Daly balancer status ignored, implausible ${problem}`, { source: this.definition.id });
        throw new Error(IMPLAUSIBLE);
      }
      this.status = st;
      const balance = st.balance ? null : await this.#optional('balance', BLOCK.BALANCE, parseBalanceBlock);
      const sw = await this.#optional('switch', BLOCK.SWITCH, parseSwitchBlock);
      if (sw) this.switchBlock = sw;
      return balancerSnapshot(st, { balance, switchBlock: this.#switchFresh ? this.switchBlock : null, settings: this.settings });
    });
    this.publish(snap);
  }

  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /** @type {Record<string, any> | null} */
      let version = null;
      try {
        version = parseVersion(await this.#read(BLOCK.VERSION));
      } catch (err) {
        this.log?.warn(`Daly balancer device info: ${errorText(err)}`, { source: this.definition.id });
      }
      return balancerInfo({ version, switchBlock: this.switchBlock, status: this.status });
    });
    return this.publishInfo(info);
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      try {
        this.settings = parseSettings(await this.#read(BLOCK.SETTINGS, { retries: 1 }));
      } catch (err) {
        if (isTimeout(err)) throw new Error(NO_ANSWER);
        throw err;
      }
      /** @type {Record<string, any> | null} */
      let sw = null;
      try {
        sw = parseSwitchBlock(await this.#read(BLOCK.SWITCH, { retries: 1 }));
        this.switchBlock = sw;
        this.optional.switch = { failures: 0, skip: 0 };
      } catch (err) {
        // A lost or rejected switch read costs only the switch: the settings block was read.
        if (!isTimeout(err) && !isRejected(err)) throw err;
        this.log?.warn('Daly balancer: no switch block reply to the settings read, the balancer switch is not shown', { source: this.definition.id });
      }
      return decodeBalancerSettings(this.schema, { settings: this.settings, switchBlock: sw });
    });
  }

  /**
   * Current value of a writable register, read with its block (settings or switch block, the reads
   * of the app). Only call inside `this.channel.exclusive()`.
   * @param {number} register
   */
  async #readBack(register) {
    if (register === REG.SWITCH) {
      this.switchBlock = parseSwitchBlock(await this.#read(BLOCK.SWITCH, { retries: 1 }));
      return this.switchBlock.registers[register - BLOCK.SWITCH.start];
    }
    this.settings = parseSettings(await this.#read(BLOCK.SETTINGS, { retries: 1 }));
    return this.settings.registers[register - BLOCK.SETTINGS.start];
  }

  /**
   * Write one register and compare the 8 byte echo (spec 4.2 step 8). Without a valid echo (lost,
   * or dropped for a bad CRC although the write took effect, spec 12 item 7) the register is read
   * back and the write repeated only while the old value is still there (spec 7.5). An exception
   * reply (function 0x86) is reported at once, without a read-back or a second write. Only call
   * inside `this.channel.exclusive()`.
   * @param {number} register
   * @param {number} value
   */
  async #write(register, value) {
    if (!WRITABLE_REGISTERS.includes(register)) throw new Error(msg('This value is read only'));
    const req = encodeWrite(register, value);
    const match = (/** @type {Uint8Array} */ f) => (f[1] === FN.WRITE && u16be(f, 2) === register) || f[1] === (FN.WRITE | 0x80);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const echo = await this.#request(req, match);
        if (echo[1] & 0x80) {
          this.log?.warn(`Daly balancer: exception ${echo[2]} for the write of ${value} to 0x${register.toString(16).toUpperCase().padStart(4, '0')}`, { source: this.definition.id });
          throw rejectedError();
        }
        if (!equals(echo, req)) {
          this.log?.warn(`Daly balancer: wrote ${value} to 0x${register.toString(16).toUpperCase()}, the echo carries ${u16be(echo, 4)}`, { source: this.definition.id });
          throw new Error(NOT_APPLIED);
        }
        return;
      } catch (err) {
        if (!isTimeout(err)) throw err;
      }
      /** @type {number} */
      let now;
      try {
        now = await this.#readBack(register);
      } catch (err) {
        if (isTimeout(err)) throw new Error(NO_ANSWER);
        throw err;
      }
      if (now === value) {
        this.log?.warn('Daly balancer: no valid write echo, the read-back shows the new value', { source: this.definition.id });
        return;
      }
      if (attempt === 0) this.log?.warn('Daly balancer: no valid write echo and the old value is still set, writing once more', { source: this.definition.id });
    }
    throw new Error(NOT_APPLIED);
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.meta?.kind !== 'register' || !WRITABLE_REGISTERS.includes(f.meta.register)) throw new Error(msg('This value is read only'));
    // The schema range is checked here too (rawSettingValue), not only by the session: values
    // outside it have an undocumented effect (a 0 s sleep time, spec 7.3), so no caller may send them.
    const raw = rawSettingValue(f, value);
    if (raw === undefined) throw new Error(msg('Invalid value'));
    await this.channel.exclusive(() => this.#write(f.meta.register, raw));
    // The next snapshot shows the new switch state even if its block read is lost.
    if (f.meta.register === REG.SWITCH && this.switchBlock) this.switchBlock = { ...this.switchBlock, balancerSwitchRaw: raw, balancerSwitch: raw === 1 };
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------------------------

/**
 * GATT profile of the Daly Bluetooth module on a balancer (spec 2.1): notify FFF1, write FFF2,
 * write without response as the app does, 20 byte writes (the module negotiates MTU 512 with the
 * app, but smaller MTUs must work). The FF00 / FF01 / FF02 fallback of the Daly BMS definitions is
 * left out on purpose: it was never seen on a balancer module, and it would send D2 frames to JBD
 * BMSes, which use FF00 (spec 11.1 step 2).
 */
const BLE_PROFILE = {
  id: 'daly-balancer-fff0',
  label: 'FFF0 (FFF1/FFF2)',
  service: 0xfff0,
  notify: 0xfff1,
  write: 0xfff2,
  writeMode: /** @type {const} */ ('prefer-without-response'),
  chunkSize: 20,
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const dalyBalancerDefinition = {
  id: 'daly-balancer',
  family: 'daly',
  vendor: DALY_BALANCER_VENDOR,
  protocol: PROTOCOL,
  deviceType: 'balancer',
  description: msg(
    'Daly smart active balancers (1 A, 3 to 24 cells) over the Daly Bluetooth module or the UART port: cell voltages, board temperature, balancing state, balancer switch, start voltage, start difference and sleep time.',
  ),
  links: {
    ble: {
      profiles: [BLE_PROFILE],
      // The advertised name of a balancer is undocumented; it uses the same Daly dongles, so the
      // advertising data of the Daly BMS definitions applies (spec 2.1, 11.1). Probably `DL-` plus
      // the MAC (unverified). Equal name rank with daly-modbus and daly: registration order decides.
      namePrefixes: ['DL-', 'JHB-'],
      namePatterns: [/^DL-/, /^JHB-/],
      manufacturerIds: [0x0102, 0x0104, 0x0107, 0x0302, 0x0303, 0x0402],
    },
    serial: {
      // UART port at 9600 8N1 (spec 2.2). The RS485 port is untested with D2 (unverified).
      profiles: [
        {
          id: 'daly-balancer-uart-9600',
          label: 'UART 9600 8N1',
          baudRate: 9600,
          dataBits: /** @type {const} */ (8),
          stopBits: /** @type {const} */ (1),
          parity: /** @type {const} */ ('none'),
        },
      ],
      note: msg(
        'UART port of the balancer (where the Bluetooth module plugs in) at 9600 baud. Its TX line is open collector and needs a pull-up to 3.3 V; ground is the most negative cell of the string. The RS485 port is not tested.',
      ),
    },
  },
  create: (ctx) => new DalyBalancerDriver(dalyBalancerDefinition, ctx),
  demo: { name: 'Daly active balancer 16S (demo)', chunkSize: 20, create: (link) => createDalyBalancerSimulator(link) },
};
