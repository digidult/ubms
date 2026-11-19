import { BaseDriver, alarm, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import {
  APP_KEY_RESULT,
  FFAA,
  FUNC_UNIT_BIT,
  PROTECTION_ALARMS,
  REG,
  REGISTERS,
  STATUS,
  TAIL_ALARMS,
  TEMP_MAX,
  TEMP_MIN,
  VARIANT,
  basicProblem,
  createJbdAssembler,
  describe,
  encodeAppKey,
  encodeBmsPassword,
  encodeControl,
  encodeEnterFactory,
  encodeExitFactory,
  encodeMos,
  encodeRandomRequest,
  encodeRead,
  encodeRootPassword,
  encodeUserPassword,
  encodeWriteU16,
  isFfaaFrame,
  isModulePassword,
  isRequestFrame,
  parseBasic,
  parseCells,
  parseErrorCounts,
  parseHardwareVersion,
  parseMac,
} from './protocol.js';
import { OPTIONAL_REGISTERS, SETTINGS_REGISTERS, buildJbdSchema, decodeJbdSettings, encodeFieldValue, normaliseLocal } from './settings.js';
import { createJbdSimulator } from './simulator.js';

/**
 * JBD (Jiabaida) BMS driver for the "DD A5" protocol (docs/protocols/jbd.md, "spec" below) over
 * Bluetooth LE (FF00 / FF01 / FF02, or the FFF0 layout of the JBD-DH04SC02) and UART / RS485 at
 * 9600 8N1. It reads 0x03 and 0x04 for the live data, 0x05 and 0xAA for the device information,
 * the EEPROM registers inside factory mode for the settings, and writes registers, the MOSFET
 * switches 0xE1 and the confirmed 0x0A control codes.
 *
 * Bluetooth modules of 2024 may need the FF AA login (spec 4.2), which needs the module password
 * and the Bluetooth device address; browsers hide the address, so the user enters both in the
 * settings and the driver logs in as soon as both are known.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 */

export const JBD_VENDOR = 'JBD (Jiabaida)';

/** Labels of the NTC probes (literal for the translation checker). */
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

/** Labels and severities of the driver specific and the disputed protection bits (spec 9.1). */
const ALARM_OVERRIDES = {
  'jbd.mos_software_lock': { label: msg('MOSFET switched off by software'), severity: /** @type {const} */ ('info') },
  'jbd.protection_bit15': { label: msg('Protection bit 15 (reserved) set'), severity: /** @type {const} */ ('warning') },
  // Bit 13: charge MOSFET breakdown per [V11], charge timeout per [SY] and [AIO] (unverified).
  charge_mos_fault: { label: msg('Charge MOSFET fault or charge timeout') },
};

/**
 * Why a Bluetooth module is locked (spec 4.2, 11.2 step 4): 'credentials' (none entered),
 * 'password' (the module rejected them), 'timeout' (a login step was not answered, retried),
 * 'pairing' (the module echoes the app key).
 */
const LOCK_ALARMS = {
  credentials: msg('Bluetooth module locked: enter the module password and the device address in the settings'),
  password: msg('Bluetooth module login failed: check the module password and the device address in the settings'),
  timeout: msg('Bluetooth module did not answer the login, retrying'),
  pairing: msg('Bluetooth module needs pairing: pair the BMS in the Bluetooth settings of the operating system, then connect again'),
};

const IMPLAUSIBLE = msg('The BMS sent implausible data');
const REFUSED = msg('The BMS refused the command');
const NOT_SUPPORTED = msg('This BMS does not support the command');
const NOT_APPLIED = msg('The BMS did not take the new value');
const NOT_SAVED = msg('The value was written but the BMS did not confirm saving it');
const NO_FACTORY = msg('The BMS did not answer the factory mode request');
const FACTORY_REFUSED = msg('The BMS refused factory mode. If it has a BMS password, enter it in the settings (Device identity).');
const LOCKED = msg('The Bluetooth module is locked. Enter the module password and the device address in the settings first.');
const LOGIN_FAILED = msg('The Bluetooth module rejected the login. Check the module password and the device address.');
const LOGIN_SILENT = msg('The Bluetooth module did not answer the login. Try again.');
const DAREN_UNSUPPORTED = msg('Daren clones are not documented for settings, switches or actions, so ubms only monitors them');

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** @param {any} link */
const isSerialLink = (link) => /serial/.test(link?.kind ?? '');
/** @param {Uint8Array} d */
const word = (d) => ((d[0] << 8) | d[1]) >>> 0;
/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

/** Error for a DD answer with a status other than 0 (spec 3.4). */
export class JbdStatusError extends Error {
  /**
   * @param {number} register
   * @param {number} status
   * @param {string} [message]
   */
  constructor(register, status, message = REFUSED) {
    super(message);
    this.code = 'STATUS';
    this.register = register;
    this.status = status;
  }
}

/**
 * Request timing (spec 4.3, 4.5): 1.5 s per answer and one repeat over Bluetooth; serial answers
 * take about 40 ms at 9600 baud, syssi waits 50 ms between requests.
 */
const TIMING = Object.freeze({
  ble: { timeout: 1500, retries: 1, gap: 0 },
  serial: { timeout: 1000, retries: 1, gap: 50 },
});

/** Daren clones advertise names starting with DWF (spec 1.1, 11.4). */
const DAREN_NAME = /^DWF/i;

/**
 * Names for which an echoed app key counts as a JBD module that needs pairing (spec 11.2 step 4,
 * unverified: one report, [SY] issue 245, a LIONTRON module advertising the serial number
 * "0521150067"). Besides the JBD names: Liontron names (spec 1.1) and bare serial numbers.
 */
const ECHO_NAMES = [/^\d{6,}$/, /^(LT\d|LISMART)/i, DAREN_NAME];

/** Factory mode transaction that may still be open (spec 4.4, 12 item 10), kept across reconnects. */
const FACTORY_OPEN = 'jbd.factoryOpen';
/** MOSFET command as last sent (spec 8.1), kept across reconnects. */
const MOS_COMMAND = 'jbd.mosCommand';
/** Attempts to close a factory mode transaction left open, one per poll. */
const PENDING_EXIT_TRIES = 3;
/** Software switch bit of the protection word (spec 9.1 bit 12). */
const SOFT_LOCK = 0x1000;

// ---------------------------------------------------------------------------------------------
// Snapshot and device information
// ---------------------------------------------------------------------------------------------

/**
 * Alarms of the protection bits and of the V11 tail alarm bits (spec 9.1, 9.2). A tail warning
 * is dropped when the same condition is an active protection.
 * @param {Record<string, any>} b parsed 0x03 (parseBasic)
 * @returns {AlarmState[]}
 */
export function basicAlarms(b) {
  /** @type {AlarmState[]} */
  const out = [];
  for (let bit = 0; bit < 16; bit++) {
    if (((b.protectionBits >> bit) & 1) === 0) continue;
    const id = PROTECTION_ALARMS[bit];
    const o = /** @type {Record<string, { label?: string, severity?: any }>} */ (ALARM_OVERRIDES)[id] ?? {};
    out.push(alarm(id, { ...o, source: `protection bit ${bit}` }));
  }
  const tail = b.extension?.alarmBits ?? 0;
  for (let bit = 0; bit < TAIL_ALARMS.length; bit++) {
    if (((tail >> bit) & 1) === 0) continue;
    const id = TAIL_ALARMS[bit];
    if (out.some((a) => a.id === id)) continue;
    out.push(alarm(id, { severity: 'warning', source: `alarm bit ${bit}` }));
  }
  return out;
}

/**
 * Unified snapshot of a 0x03 answer and the cell voltages of 0x04 (spec 6.1 to 6.3, 9).
 * @param {Record<string, any>} b parsed 0x03 (parseBasic)
 * @param {{ cells?: number[] | null, balanceSwitch?: boolean, cellCountMismatch?: boolean }} [opts]
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function basicSnapshot(b, { cells = null, balanceSwitch, cellCountMismatch = false } = {}) {
  const n = cells?.length ?? b.cellCount;
  const flags = Array.from({ length: n }, (_, i) => b.balancingCells.includes(i));
  const alarms = basicAlarms(b);
  if (cellCountMismatch && cells) alarms.push(alarm('cell_count_mismatch', { source: `0x04 has ${cells.length} cells, 0x03 reports ${b.cellCount}` }));
  // An open or shorted NTC (raw 0 is -273.1 °C) is no reading: leave it out and report the probe.
  /** @type {import('@ubms/bms-core/model').TemperatureReading[]} */
  const temperatures = [];
  /** @type {string[]} */
  const badProbes = [];
  b.temperatures.forEach((/** @type {number} */ value, /** @type {number} */ i) => {
    if (value < TEMP_MIN || value > TEMP_MAX) badProbes.push(`NTC ${i + 1}`);
    else temperatures.push({ id: `t${i + 1}`, label: TEMP_LABELS[i] ?? `T${i + 1}`, value });
  });
  if (badProbes.length) alarms.push(alarm('temperature_sensor_fault', { source: badProbes.join(', ') }));
  /** @type {Record<string, ExtraValue>} */
  const extra = {
    // Bits 2 to 7 of this byte are disputed or unreliable (spec 9.3); the raw byte helps reports.
    fetStatus: { label: msg('FET status byte'), value: h2(b.fetStatus) },
  };
  if (b.unit100mA) extra.unit = { label: msg('Current and capacity unit'), value: '100 mA / 100 mAh' };
  const full = b.extension?.fullChargeCapacity;
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {
    voltage: b.totalVoltage,
    current: b.current,
    soc: b.soc,
    capacityRemaining: b.remainingCapacity,
    capacityNominal: b.nominalCapacity,
    cycles: b.cycleCount,
    temperatures,
    balancing: flags,
    balancingActive: b.balanceBits !== 0,
    switches: { charge: b.chargeMos, discharge: b.dischargeMos, ...(balanceSwitch === undefined ? {} : { balance: balanceSwitch }) },
    alarms,
    extra,
  };
  if (cells) s.cells = cells;
  if (Number.isFinite(full) && full > 0) s.capacityFull = full;
  return s;
}

/**
 * Device information from the 0x03 answer and the 0x05 model string (spec 10).
 * @param {Record<string, any>} b parsed 0x03
 * @param {{ model?: string, protocol?: string, variant?: string }} [opts]
 * @returns {DeviceInfo}
 */
export function basicInfo(b, { model, protocol, variant } = {}) {
  /** @type {DeviceInfo} */
  const info = {
    vendor: JBD_VENDOR,
    softwareVersion: b.softwareVersion,
    protocol: variant && variant !== VARIANT.JBD ? `${protocol} (${variant})` : protocol,
    extra: {
      cellCount: { label: msg('Cell count'), value: b.cellCount, decimals: 0 },
      ntcCount: { label: msg('Temperature sensor count'), value: b.ntcCount, decimals: 0 },
    },
  };
  if (model) info.model = model;
  if (b.productionDate) info.manufactureDate = b.productionDate;
  if (!info.protocol) delete info.protocol;
  return info;
}

/** Labels of the protection counters 0xAA (spec 6.5), literal for the translation checker. */
const COUNTER_LABELS = {
  shortCircuit: msg('Short circuit events'),
  chargeOvercurrent: msg('Charge overcurrent events'),
  dischargeOvercurrent: msg('Discharge overcurrent events'),
  cellOvervoltage: msg('Cell overvoltage events'),
  cellUndervoltage: msg('Cell undervoltage events'),
  chargeOvertemperature: msg('Charge overtemperature events'),
  chargeUndertemperature: msg('Charge undertemperature events'),
  dischargeOvertemperature: msg('Discharge overtemperature events'),
  dischargeUndertemperature: msg('Discharge undertemperature events'),
  packOvervoltage: msg('Pack overvoltage events'),
  packUndervoltage: msg('Pack undervoltage events'),
};

/**
 * Device info extras of the protection counters 0xAA.
 * @param {{ errorCounts: Record<string, number>, restartCount?: number }} c
 * @returns {Record<string, ExtraValue>}
 */
export function counterExtras(c) {
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  for (const [k, v] of Object.entries(c.errorCounts)) {
    const label = /** @type {Record<string, string>} */ (COUNTER_LABELS)[k];
    if (label) extra[`count.${k}`] = { label, value: v, decimals: 0 };
  }
  // d22 of 0xAA: [V11] only, [SY] ignores the word (spec 6.5, unverified).
  if (c.restartCount !== undefined) extra['count.restarts'] = { label: msg('System restarts'), value: c.restartCount, decimals: 0 };
  return extra;
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export class JbdDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.serial = isSerialLink(ctx.link);
    this.ble = !this.serial;
    /**
     * The FF AA login exists on the FF00 modules of 2024 (spec 4.2). The FFF0 layout is rare for
     * JBD and the default of Daly, so the probe on FFF0 only reads 0x03 and a Daly device there
     * pays two reads instead of three frames (spec 11.2, 11.4).
     */
    this.appKeyProbe = this.ble && ctx.profileId !== 'jbd-fff0';
    this.timing = this.serial ? TIMING.serial : TIMING.ble;
    /**
     * Shared target options, kept across reconnects: password, address, bmsPassword, the MOSFET
     * command (`jbd.mosCommand`) and the flag of a factory mode transaction that may still be open
     * (`jbd.factoryOpen`).
     */
    this.options = ctx.options ?? {};
    this.channel = new FrameChannel(ctx.link, { createAssembler: (h) => createJbdAssembler(h), describe, log: ctx.log }).start();
    /** Last parsed 0x03. @type {Record<string, any> | null} */
    this.basic = null;
    /** @type {number[] | null} */
    this.cells = null;
    this.cellsAt = 0;
    this.mismatchCount = 0;
    /** Hardware version of 0x05; null when refused. @type {string | null | undefined} */
    this.model = undefined;
    /** EEPROM data by register, as last read. @type {Map<number, Uint8Array>} */
    this.regs = new Map();
    /** Registers the BMS refused (their fields are hidden). @type {Set<number>} */
    this.missing = new Set();
    this.unit100 = false;
    /**
     * Locked Bluetooth module: 'credentials' | 'password' | 'timeout' | 'pairing' | null (spec
     * 4.2, LOCK_ALARMS). @type {string | null}
     */
    this.lock = null;
    /** Credentials the module rejected, so a wrong password is not retried every poll. */
    this.failedLogin = '';
    /** Unanswered logins in a row, and polls to skip before the next attempt (back-off). */
    this.loginTimeouts = 0;
    this.loginSkip = 0;
    /** Attempts made to close a factory mode transaction left open (FACTORY_OPEN). */
    this.pendingExitTries = 0;
    /** Flags of spec 11.6. */
    this.flags = { extendedTail: false, unit100mA: false, moduleLogin: false, factoryModeRequired: false };
    this.lastIoAt = 0;
    this.#rebuildSchema();
  }

  /** Daren clone without a pending module login: monitoring only (spec 1.3, 11.4). */
  get #monitorOnly() {
    return this.variant === VARIANT.DAREN && !this.lock;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    const writable = !this.#monitorOnly;
    // syssi updates every 2 s; one poll is two requests (spec 4.3).
    return { settings: writable, writeSettings: writable, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  #rebuildSchema() {
    this.schema = buildJbdSchema({ unit100: this.unit100, missing: this.missing, ble: this.ble, locked: !!this.lock, variant: this.variant });
    this.fields = fieldMap(this.schema);
  }

  getSettingsSchema() {
    return this.schema;
  }

  /** Wait the gap after the last exchange (serial, spec 2.2). */
  async #gap() {
    if (!this.timing.gap) return;
    const idle = Date.now() - this.lastIoAt;
    if (idle < this.timing.gap) await sleep(this.timing.gap - idle);
  }

  /**
   * Request with one DD answer for the register. Only call inside `channel.exclusive`. Echoed
   * requests are ignored (byte 1 is the operation). Answers can arrive seconds late (spec 3.5), so
   * a read takes only a refusal or an answer with data, and a write only an answer without data:
   * a late acknowledgement never answers a read of the same register, and a late read answer never
   * acknowledges a write.
   * @param {Uint8Array} bytes
   * @param {number} register
   * @param {{ timeout?: number, retries?: number, expectData?: boolean }} [opts]
   */
  async #request(bytes, register, { timeout = this.timing.timeout, retries = this.timing.retries, expectData = false } = {}) {
    await this.#gap();
    const d = describe(bytes);
    try {
      return await this.channel.requestUnqueued(bytes, {
        match: (f) => f[0] === 0xdd && !isRequestFrame(f) && f[1] === register && (expectData ? f[2] !== STATUS.OK || f[3] > 0 : f[3] === 0),
        timeout,
        retries,
        name: d?.name,
        decode: d?.decode,
      });
    } finally {
      this.lastIoAt = Date.now();
    }
  }

  /**
   * Read a register and return its data bytes; throws JbdStatusError for a refusal.
   * @param {number} register
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #readData(register, opts) {
    const f = await this.#request(encodeRead(register), register, { ...opts, expectData: true });
    if (f[2] !== STATUS.OK) throw new JbdStatusError(register, f[2]);
    return Uint8Array.from(f.subarray(4, 4 + f[3]));
  }

  /**
   * Write and expect the acknowledgement `DD r 00 00 00 00 77` (spec 6.7).
   * @param {Uint8Array} bytes
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #write(bytes, opts = {}) {
    const register = bytes[2];
    const f = await this.#request(bytes, register, { retries: 0, ...opts, expectData: false });
    if (f[2] !== STATUS.OK) throw new JbdStatusError(register, f[2]);
  }

  /**
   * FF AA module command with a one byte answer (spec 6.9).
   * @param {Uint8Array} bytes
   * @param {number} timeout
   */
  async #ffaa(bytes, timeout) {
    const cmd = bytes[2];
    const d = describe(bytes);
    const f = await this.channel.requestUnqueued(bytes, { match: (fr) => isFfaaFrame(fr) && fr[2] === cmd && fr[3] === 1, timeout, retries: 0, name: d?.name, decode: d?.decode });
    this.lastIoAt = Date.now();
    return f[4];
  }

  /**
   * Basic information with the plausibility rules of spec 11.2 step 3: the full rule for the
   * detection (`strict`), the structural part otherwise, so an open NTC does not stop polling.
   * @param {{ timeout?: number, retries?: number, strict?: boolean }} [opts]
   */
  async #readBasic({ strict = false, ...opts } = {}) {
    const data = await this.#readData(REG.BASIC, opts);
    const problem = basicProblem(data, { strict });
    if (problem) {
      this.log?.warn(`JBD 0x03 answer ignored, implausible ${problem}`, { source: this.definition.id });
      const err = new Error(IMPLAUSIBLE);
      /** @type {any} */ (err).code = 'IMPLAUSIBLE';
      throw err;
    }
    // Bit 12 of 0x2D, once read, also selects the 0x03 units ([V11], spec 6.2, unverified).
    const b = parseBasic(data, { variant: this.variant, unit100: this.unit100 });
    this.basic = b;
    this.flags.extendedTail = !!b.extension;
    this.flags.unit100mA = b.unit100mA;
    return b;
  }

  /**
   * App key `FF AA 15` (spec 4.2 step 1, 11.2 step 4): the result byte, 'echo' when the module
   * returned the frame unchanged, null on silence.
   * @param {number} timeout
   * @returns {Promise<number | 'echo' | null>}
   */
  async #appKey(timeout) {
    const bytes = encodeAppKey();
    const d = describe(bytes);
    try {
      const f = await this.channel.requestUnqueued(bytes, { match: (fr) => isFfaaFrame(fr) && fr[2] === FFAA.APP_KEY, timeout, retries: 0, name: d?.name, decode: d?.decode });
      this.lastIoAt = Date.now();
      if (f[3] === bytes[3] && f.every((v, i) => v === bytes[i])) return 'echo';
      return f[3] === 1 ? f[4] : null;
    } catch (err) {
      if (isTimeout(err)) return null;
      throw err;
    }
  }

  /** Module password and address from the target options, or null. */
  #credentials() {
    const mac = parseMac(this.options.address);
    const password = this.options.password;
    return mac && isModulePassword(password) ? { mac, password: /** @type {string} */ (password), key: `${password}@${this.options.address}` } : null;
  }

  /**
   * Login steps 2 to 5 after an accepted app key (spec 4.2). Returns false when the module
   * rejected a password; an unanswered step throws the TIMEOUT error of the channel.
   * @param {{ mac: Uint8Array, password: string }} c
   * @param {number} timeout
   * @returns {Promise<boolean>}
   */
  async #loginAfterKey(c, timeout) {
    const random1 = await this.#ffaa(encodeRandomRequest(), timeout);
    if ((await this.#ffaa(encodeUserPassword(c.mac, c.password, random1), timeout)) !== 0) return false;
    const random2 = await this.#ffaa(encodeRandomRequest(), timeout);
    return (await this.#ffaa(encodeRootPassword(c.mac, random2), timeout)) === 0;
  }

  /**
   * Login steps 2 to 5 as an outcome: 'ok', 'rejected' (a password result other than 0) or
   * 'silent' (a step was not answered).
   * @param {{ mac: Uint8Array, password: string }} c
   * @param {number} timeout
   * @returns {Promise<'ok'|'rejected'|'silent'>}
   */
  async #loginSteps(c, timeout) {
    try {
      return (await this.#loginAfterKey(c, timeout)) ? 'ok' : 'rejected';
    } catch (err) {
      if (isTimeout(err)) return 'silent';
      throw err;
    }
  }

  /**
   * Record the outcome of a login and update `lock`. Only a rejection by the module marks the
   * credentials as wrong; an unanswered step is retried by the next polls with a back-off (one
   * attempt, then every 2nd, 3rd, 4th and finally every 5th poll).
   * @param {'ok'|'rejected'|'silent'|'echo'} outcome
   * @param {string} key credentials key
   */
  #loginResult(outcome, key) {
    this.flags.moduleLogin = true;
    if (outcome === 'ok') {
      this.lock = null;
      this.failedLogin = '';
      this.loginTimeouts = 0;
      this.loginSkip = 0;
      this.#rebuildSchema();
      this.log?.event('JBD Bluetooth module login accepted', { source: this.definition.id });
      return true;
    }
    if (outcome === 'rejected') {
      this.failedLogin = key;
      this.lock = 'password';
    } else if (outcome === 'echo') {
      this.lock = 'pairing';
    } else {
      this.lock = 'timeout';
      this.loginTimeouts++;
      this.loginSkip = Math.min(this.loginTimeouts - 1, 4);
    }
    this.#rebuildSchema();
    this.log?.warn(`JBD Bluetooth module login failed (${outcome})`, { source: this.definition.id });
    return false;
  }

  /**
   * Full module login (spec 4.2) with the credentials of the options. Only call inside
   * `channel.exclusive`. Updates `lock`.
   * @param {number} timeout
   */
  async #unlock(timeout = this.timing.timeout) {
    const c = this.#credentials();
    if (!c) {
      this.lock = 'credentials';
      return false;
    }
    /** @type {'ok'|'rejected'|'silent'|'echo'} */
    let outcome;
    const key = await this.#appKey(timeout);
    if (key === null) outcome = 'silent';
    else if (key === 'echo') outcome = 'echo';
    else if (key === APP_KEY_RESULT.NO_PASSWORD) outcome = 'ok';
    else if (key === APP_KEY_RESULT.PASSWORD_REQUIRED || key === APP_KEY_RESULT.REJECTED) outcome = await this.#loginSteps(c, timeout);
    else outcome = 'rejected';
    if (outcome === 'ok') {
      try {
        await this.#readBasic({ timeout, retries: 1 });
      } catch (err) {
        this.log?.warn(`JBD module login accepted, but no 0x03 answer: ${errorText(err)}`, { source: this.definition.id });
        outcome = 'silent';
      }
    }
    return this.#loginResult(outcome, c.key);
  }

  /** An echoed app key counts as a JBD module only for these names (ECHO_NAMES, spec 11.2). */
  #echoFromJbdName() {
    const name = this.link?.name ?? '';
    return JBD_NAME_PATTERNS.some((p) => p.test(name)) || JBD_NAME_PREFIXES.some((p) => name.startsWith(p)) || ECHO_NAMES.some((p) => p.test(name));
  }

  /** Daren clones by name (spec 11.4); the 0x05 refusal is checked in readInfo. */
  #variantByName() {
    if (DAREN_NAME.test(this.link?.name ?? '') || this.variant === VARIANT.DAREN) return VARIANT.DAREN;
    return VARIANT.JBD;
  }

  /**
   * Read only probe (spec 11.2, 11.3): 0x03 with one repeat (a sleeping BMS drops the first
   * request). Over Bluetooth, silence is followed by one app key frame: a locked module is
   * accepted as JBD with `locked: true`, so the session connects and the user can enter the
   * login data. Never enters factory mode, never writes a register.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const perTry = this.serial ? clamp(Math.floor(timeout / 4), 300, 500) : clamp(Math.floor(timeout / 2), 500, 1500);
    return this.channel.exclusive(async () => {
      /** @type {Record<string, any> | null} */
      let b = await this.#probeBasic(perTry);
      if (!b && this.appKeyProbe) {
        const key = await this.#appKey(perTry);
        if (key === null) return null;
        if (key === 'echo') {
          // One report only ([SY] issue 245): a loopback bridge would echo too, so the echo counts
          // only for JBD, Liontron and serial number names (spec 11.2 step 4, unverified).
          if (!this.#echoFromJbdName()) {
            this.log?.event('JBD app key echoed by a device without a JBD name: not taken as JBD', { source: this.definition.id });
            return null;
          }
          this.#loginResult('echo', '');
        } else if (key === APP_KEY_RESULT.NO_PASSWORD) {
          this.flags.moduleLogin = true;
          b = await this.#probeBasic(perTry);
          if (!b) return null;
        } else {
          const c = this.#credentials();
          if (c) {
            let outcome = await this.#loginSteps(c, perTry);
            if (outcome === 'ok') {
              b = await this.#probeBasic(perTry);
              if (!b) outcome = 'silent';
            }
            this.#loginResult(outcome, c.key);
          } else {
            this.flags.moduleLogin = true;
            this.lock = 'credentials';
          }
        }
      }
      if (!b && !this.lock) return null;
      const variant = this.#variantByName();
      this.setVariant(variant);
      this.#rebuildSchema();
      if (this.lock) {
        this.log?.event(`JBD Bluetooth module locked (${this.lock})`, { source: this.definition.id });
        const info = { vendor: JBD_VENDOR, protocol: this.definition.protocol, model: this.link?.name };
        this.publishInfo(info);
        return { variant, confidence: 0.6, info, locked: true };
      }
      const basic = /** @type {Record<string, any>} */ (b);
      const info = basicInfo(basic, { protocol: this.definition.protocol, variant });
      this.publishInfo(info);
      this.log?.event(`JBD BMS: ${basic.cellCount} cells, ${basic.ntcCount} NTC, software ${basic.softwareVersion}${basic.extension ? ', V11 tail' : ''}${basic.unit100mA ? ', 100 mA units' : ''}`, {
        source: this.definition.id,
      });
      return { variant, confidence: 1, info };
    });
  }

  /** @param {number} perTry */
  async #probeBasic(perTry) {
    try {
      return await this.#readBasic({ timeout: perTry, retries: 1, strict: true });
    } catch (err) {
      if (!isTimeout(err) && /** @type {any} */ (err)?.code !== 'IMPLAUSIBLE' && /** @type {any} */ (err)?.code !== 'STATUS') this.log?.warn(errorText(err), { source: this.definition.id });
      return null;
    }
  }

  /** Snapshot of a locked module: only the reason as an alarm. */
  #lockedSnapshot() {
    const label = /** @type {Record<string, string>} */ (LOCK_ALARMS)[this.lock ?? 'credentials'] ?? LOCK_ALARMS.credentials;
    return { alarms: [alarm('jbd.module_locked', { label, severity: 'fault', source: 'FF AA login' })] };
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      if (this.lock) {
        const c = this.#credentials();
        if (this.lock === 'pairing' || !c || c.key === this.failedLogin) {
          if (!c && (this.lock === 'password' || this.lock === 'timeout')) this.lock = 'credentials';
          return this.#lockedSnapshot();
        }
        if (this.lock === 'timeout' && this.loginSkip > 0) {
          this.loginSkip--;
          return this.#lockedSnapshot();
        }
        if (!(await this.#unlock())) return this.#lockedSnapshot();
      }
      await this.#closePendingFactory();
      const b = await this.#readBasic();
      /** @type {number[] | null} */
      let cells = null;
      try {
        cells = parseCells(await this.#readData(REG.CELLS)).cellVoltages;
        this.cells = cells;
        this.cellsAt = Date.now();
      } catch (err) {
        this.log?.warn(`JBD cell voltages: ${errorText(err)}`, { source: this.definition.id });
        // Keep the previous voltages for a short while instead of an empty cell view.
        if (this.cells && Date.now() - this.cellsAt < 10000) cells = this.cells;
      }
      // Cell count mismatch only after two consistent reads (spec 6.3, a ubms policy).
      this.mismatchCount = cells && cells.length !== b.cellCount ? this.mismatchCount + 1 : 0;
      const balanceSwitch = this.regs.has(0x2d) ? ((word(/** @type {Uint8Array} */ (this.regs.get(0x2d))) >> 2) & 1) === 1 : undefined;
      return basicSnapshot(b, { cells, balanceSwitch, cellCountMismatch: this.mismatchCount >= 2 });
    });
    this.publish(snap);
  }

  /**
   * Model (0x05) once per connection and the protection counters 0xAA (spec 4.3, 6.4, 6.5). A
   * Daren clone refuses 0x05 with status 0x80 (spec 11.4).
   */
  async readInfo() {
    if (this.lock) return this.lastInfo;
    const info = await this.channel.exclusive(async () => {
      if (this.model === undefined) {
        try {
          this.model = parseHardwareVersion(await this.#readData(REG.VERSION, { retries: 2 })) || null;
        } catch (err) {
          if (/** @type {any} */ (err)?.code === 'STATUS') {
            this.model = null;
            // Bytes after the NTC words that are no V11 tail (spec 6.2) plus the refusal: Daren.
            const tail = this.basic?.extraBytes;
            if (tail && this.variant !== VARIANT.DAREN) {
              this.setVariant(VARIANT.DAREN);
              this.#rebuildSchema();
            }
          } else this.log?.warn(`JBD hardware version: ${errorText(err)}`, { source: this.definition.id });
        }
      }
      /** @type {DeviceInfo} */
      const out = this.basic ? basicInfo(this.basic, { model: this.model ?? this.link?.name, protocol: this.definition.protocol, variant: this.variant }) : { vendor: JBD_VENDOR };
      try {
        const counters = parseErrorCounts(await this.#readData(REG.ERROR_COUNTS, { retries: 0 }));
        out.extra = { ...out.extra, ...counterExtras(counters) };
        // Restart counter d22: [V11] only, unverified (spec 6.5, 10).
        if (counters.restartCount !== undefined) out.powerOnCount = counters.restartCount;
      } catch (err) {
        this.log?.event(`JBD protection counters not available: ${errorText(err)}`, { source: this.definition.id });
      }
      return out;
    });
    return this.publishInfo(info);
  }

  // -------------------------------------------------------------------------------------------
  // Factory mode transactions (spec 4.4, 8.4)
  // -------------------------------------------------------------------------------------------

  /**
   * Enter factory mode; after a 0x81 refusal send the BMS password of the options with 0x06,
   * first as ASCII, then as binary digits, and try again (spec 8.4).
   */
  async #enterFactory() {
    /** @returns {Promise<number>} status */
    const enter = async () => {
      try {
        const f = await this.#request(encodeEnterFactory(), REG.FACTORY_ENTER, { retries: 1 });
        return f[2];
      } catch (err) {
        if (!isTimeout(err)) throw err;
        const e = new Error(NO_FACTORY);
        /** @type {any} */ (e).code = 'NO_FACTORY';
        throw e;
      }
    };
    let status = await enter();
    if (status === STATUS.OK) return;
    this.flags.factoryModeRequired = true;
    const pw = typeof this.options.bmsPassword === 'string' ? this.options.bmsPassword : '';
    if ((status === STATUS.INVALID || status === STATUS.PASSWORD) && pw.length === 6) {
      for (const encoding of /** @type {const} */ (['ascii', 'digits'])) {
        if (encoding === 'digits' && !/^[0-9]{6}$/.test(pw)) continue;
        try {
          await this.#write(encodeBmsPassword(pw, encoding));
        } catch (err) {
          this.log?.warn(`JBD BMS password (${encoding}): ${errorText(err)}`, { source: this.definition.id });
          continue;
        }
        status = await enter();
        if (status === STATUS.OK) return;
      }
    }
    this.log?.warn(`JBD factory mode refused, status ${h2(status)}`, { source: this.definition.id });
    throw new JbdStatusError(REG.FACTORY_ENTER, status, FACTORY_REFUSED);
  }

  /**
   * Run a task inside factory mode and always leave it: with `28 28` after a successful write
   * task, with `00 00` otherwise (spec 4.4, 12 item 10).
   *
   * - The transaction is marked in the shared options (FACTORY_OPEN) before the enter request and
   *   cleared by an acknowledged exit. A transaction that could not be closed (lost answers, link
   *   lost) is closed with `00 00` by the next poll, also of a new driver instance after a
   *   reconnect (never by the probe, which stays read only).
   * - An unanswered enter request is followed by `00 00` anyway: the answer may be lost while the
   *   BMS did enter ([BM] `_fetch_device_info`, "00 00 is harmless").
   * - A save whose `28 28` is not acknowledged is reported as an error: the value may be in RAM
   *   only (spec 4.4, [BT] CHANGELOG v1.1.2).
   * @template T
   * @param {() => Promise<T>} task
   * @param {{ save: boolean }} opts
   * @returns {Promise<T>}
   */
  async #factory(task, { save }) {
    this.options[FACTORY_OPEN] = true;
    try {
      await this.#enterFactory();
    } catch (err) {
      // A refusal (status answer) means the BMS stayed out of factory mode.
      if (/** @type {any} */ (err)?.code === 'STATUS') delete this.options[FACTORY_OPEN];
      else await this.#exitFactory(false);
      throw err;
    }
    /** @type {T} */
    let result;
    try {
      result = await task();
    } catch (err) {
      await this.#exitFactory(false);
      throw err;
    }
    if (!(await this.#exitFactory(save)) && save) throw new Error(NOT_SAVED);
    return result;
  }

  /**
   * Leave factory mode; true when the BMS acknowledged it (then the open transaction is closed).
   * @param {boolean} save `28 28` instead of `00 00`
   * @param {{ retries?: number }} [opts]
   */
  async #exitFactory(save, { retries = 1 } = {}) {
    try {
      await this.#write(encodeExitFactory(save), { retries });
      delete this.options[FACTORY_OPEN];
      this.pendingExitTries = 0;
      return true;
    } catch (err) {
      this.log?.warn(`JBD exit factory mode${save ? ' and save' : ''}: ${errorText(err)}`, { source: this.definition.id });
      return false;
    }
  }

  /**
   * Close a factory mode transaction that an earlier request or driver instance could not close
   * (FACTORY_OPEN), with `00 00`; at most PENDING_EXIT_TRIES attempts, one per poll.
   */
  async #closePendingFactory() {
    if (!this.options[FACTORY_OPEN]) return;
    if (this.pendingExitTries >= PENDING_EXIT_TRIES) {
      delete this.options[FACTORY_OPEN];
      this.log?.warn('JBD factory mode may still be open: the BMS did not acknowledge the exit, giving up', { source: this.definition.id });
      return;
    }
    this.pendingExitTries++;
    this.log?.event('JBD factory mode may still be open: sending exit 00 00', { source: this.definition.id });
    await this.#exitFactory(false, { retries: 0 });
  }

  /** Values of the local fields (never the passwords: settings end up in exports). */
  #localValues() {
    /** @type {Record<string, any>} */
    const values = {};
    if (this.ble && this.fields.has('jbd.module_address')) values['jbd.module_address'] = typeof this.options.address === 'string' ? this.options.address : '';
    return values;
  }

  async readSettings() {
    if (this.#monitorOnly) throw new Error(DAREN_UNSUPPORTED);
    return this.channel.exclusive(async () => {
      if (this.lock) return this.#localValues();
      /** @type {Map<number, Uint8Array>} */
      const regs = new Map();
      /** @type {Set<number>} */
      const missing = new Set();
      await this.#factory(
        async () => {
          let silent = 0;
          for (const register of SETTINGS_REGISTERS) {
            const optional = OPTIONAL_REGISTERS.includes(register);
            try {
              regs.set(register, await this.#readData(register, { retries: optional ? 0 : 1 }));
              silent = 0;
            } catch (err) {
              if (/** @type {any} */ (err)?.code === 'STATUS' || optional) missing.add(register);
              this.log?.event(`JBD register ${h2(register)}: ${errorText(err)}`, { source: this.definition.id });
              // A BMS that stopped answering would cost 3 s per register: give up after three
              // unanswered core registers (older firmware may not answer the optional ones).
              if (isTimeout(err) && !optional && ++silent >= 3) throw new Error(msg('The BMS stopped answering the settings requests'));
            }
          }
        },
        { save: false },
      );
      if (!regs.size) throw new Error(msg('The BMS did not answer the settings requests'));
      this.regs = regs;
      this.missing = missing;
      const fc = regs.get(0x2d);
      this.unit100 = !!fc && fc.length === 2 && ((word(fc) >> FUNC_UNIT_BIT) & 1) === 1;
      this.#rebuildSchema();
      const values = decodeJbdSettings(this.schema, regs, { unit100: this.unit100 });
      try {
        const b = await this.#readBasic();
        values['switch.charge'] = b.chargeMos;
        values['switch.discharge'] = b.dischargeMos;
      } catch (err) {
        this.log?.warn(`JBD MOSFET state: ${errorText(err)}`, { source: this.definition.id });
      }
      Object.assign(values, this.#localValues());
      this.#publishFactoryInfo(values);
      return values;
    });
  }

  /** @param {Record<string, any>} values */
  #publishFactoryInfo(values) {
    /** @type {DeviceInfo} */
    const info = { extra: { ...(this.lastInfo?.extra ?? {}) } };
    const extra = /** @type {Record<string, ExtraValue>} */ (info.extra);
    if (values['jbd.manufacturer']) extra.manufacturer = { label: msg('Manufacturer'), value: values['jbd.manufacturer'] };
    if (values['jbd.barcode']) info.serialNumber = values['jbd.barcode'];
    else if (values['jbd.serial_number']) info.serialNumber = String(values['jbd.serial_number']);
    if (values['jbd.model'] && !this.model) info.model = values['jbd.model'];
    this.publishInfo(info);
  }

  /**
   * Write one register field: read the register (byte pairs, bits) or the unit flag first, write,
   * read back and compare the raw word, then leave factory mode with `28 28` (spec 7.1).
   * @param {SettingField} f
   * @param {any} value
   */
  async #writeRegisterField(f, value) {
    const register = f.meta.register;
    /**
     * A register answer has two data bytes; anything else would give a wrong unit or a wrong
     * merge, so nothing is written.
     * @param {Uint8Array} d
     * @param {number} reg
     */
    const wordOf = (d, reg) => {
      if (d.length !== 2) {
        this.log?.warn(`JBD register ${h2(reg)}: ${d.length} data bytes, nothing written`, { source: this.definition.id });
        throw new Error(IMPLAUSIBLE);
      }
      return word(d);
    };
    await this.#factory(
      async () => {
        const fc = await this.#readData(0x2d);
        this.unit100 = ((wordOf(fc, 0x2d) >> FUNC_UNIT_BIT) & 1) === 1;
        if (this.unit100 && REGISTERS[register]?.unitScaled) {
          this.#rebuildSchema();
          throw new Error(msg('This value is read only'));
        }
        const current = register === 0x2d ? fc : f.meta.kind === 'reg' ? undefined : await this.#readData(register);
        if (current) wordOf(current, register);
        let raw;
        try {
          raw = encodeFieldValue(f, value, current, { unit100: this.unit100 });
        } catch {
          throw new Error(msg('Invalid value'));
        }
        await this.#write(encodeWriteU16(register, raw));
        const back = await this.#readData(register);
        this.regs.set(register, back);
        if (back.length !== 2 || word(back) !== raw) {
          this.log?.warn(`JBD register ${h2(register)}: wrote ${raw}, read back ${back.length === 2 ? word(back) : '?'}`, { source: this.definition.id });
          throw new Error(NOT_APPLIED);
        }
      },
      { save: true },
    );
  }

  /**
   * Bit of the other MOSFET for a new 0xE1 command (spec 8.1: keep it as commanded, not as
   * measured), from a fresh 0x03 and the command last sent (MOS_COMMAND, kept across reconnects):
   *
   * - a MOSFET that 0x03 reports on is not held by 0xE1, so it is never commanded off;
   * - with the software lock bit 12 clear nothing is held by 0xE1 (the switch was released by
   *   another app or a power cycle), so the saved command is stale and dropped;
   * - otherwise the saved command decides; without one, an off MOSFET under bit 12 is kept off.
   *   Bit 12 does not tell which MOSFET it holds: when other protection bits are set too, the
   *   MOSFET may be held by a protection instead, which is logged.
   * @param {Record<string, any>} b fresh 0x03
   * @param {'charge'|'discharge'} other
   */
  #otherMosOff(b, other) {
    const otherOn = other === 'charge' ? b.chargeMos : b.dischargeMos;
    const softLock = (b.protectionBits & SOFT_LOCK) !== 0;
    const raw = this.options[MOS_COMMAND];
    const saved = raw && typeof raw === 'object' ? raw : null;
    if (!softLock) delete this.options[MOS_COMMAND];
    if (otherOn || !softLock) return false;
    if (saved) return !!saved[`${other}Off`];
    if ((b.protectionBits & ~SOFT_LOCK) !== 0) {
      this.log?.event(`JBD ${other} MOSFET is off with protection bits 0x${b.protectionBits.toString(16).padStart(4, '0')} and no saved command: kept off`, { source: this.definition.id });
    }
    return true;
  }

  /**
   * MOSFET switch (spec 8.1): read 0x03 for the other bit, factory mode, 0xE1 with both bits, exit
   * `00 00`, then 0x03 until the state matches (a protection may hold it off).
   * @param {'charge'|'discharge'} key
   * @param {boolean} on
   */
  async #writeMos(key, on) {
    const before = await this.#readBasic({ retries: 1 });
    const other = key === 'charge' ? 'discharge' : 'charge';
    const otherOff = this.#otherMosOff(before, other);
    const cmd = key === 'charge' ? { chargeOff: !on, dischargeOff: otherOff } : { chargeOff: otherOff, dischargeOff: !on };
    await this.#factory(() => this.#write(encodeMos(cmd)), { save: false });
    this.options[MOS_COMMAND] = cmd;
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 100 : 300);
      try {
        const b = await this.#readBasic({ retries: 0 });
        if ((key === 'charge' ? b.chargeMos : b.dischargeMos) === on) return;
        if (i === 3 && (b.protectionBits & ~SOFT_LOCK) !== 0) this.log?.event(`JBD ${key} MOSFET held by a protection (bits ${h2(b.protectionBits >> 8)}${h2(b.protectionBits & 0xff).slice(2)})`, { source: this.definition.id });
      } catch {
        /* the settings reload tells */
      }
    }
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    if (this.#monitorOnly) throw new Error(DAREN_UNSUPPORTED);
    const f = this.fields.get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    const kind = f.meta?.kind;
    if (kind === 'local') {
      const option = f.meta.option;
      const v = normaliseLocal(option, value);
      if (v === '') delete this.options[option];
      else this.options[option] = v;
      if ((option === 'password' || option === 'address') && this.lock && this.lock !== 'pairing' && this.#credentials()) {
        const ok = await this.channel.exclusive(() => this.#unlock());
        if (!ok) throw new Error(this.lock === 'timeout' ? LOGIN_SILENT : this.lock === 'pairing' ? LOCK_ALARMS.pairing : LOGIN_FAILED);
      }
      return;
    }
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    if (this.lock) throw new Error(LOCKED);
    await this.channel.exclusive(async () => {
      if (kind === 'mos') return this.#writeMos(f.meta.key, !!value);
      if (kind === 'reg' || kind === 'pair' || kind === 'bit') return this.#writeRegisterField(f, value);
      throw new Error(msg('Unknown setting'));
    });
  }

  /**
   * Control command 0x0A (spec 8.3). Any non-zero status means the board does not know it; it is
   * never retried.
   * @param {string} id
   */
  async runAction(id) {
    if (this.#monitorOnly) throw new Error(DAREN_UNSUPPORTED);
    const f = this.fields.get(id);
    if (!f || f.type !== 'action' || f.meta?.kind !== 'control') throw new Error(msg('Unknown action'));
    if (this.lock) throw new Error(LOCKED);
    await this.channel.exclusive(async () => {
      try {
        await this.#write(encodeControl(f.meta.code));
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'STATUS') throw new Error(NOT_SUPPORTED);
        throw err;
      }
    });
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
 * GATT layouts (spec 2.1): FF00 with FF01 notify and FF02 write on every known module; FFF0 with
 * FFF1 / FFF2 on the JBD-DH04SC02 (unverified, no capture). Write without response when the
 * characteristic offers it, otherwise with response (older dongles). 20 byte writes: the module
 * does not need a larger MTU.
 */
export const JBD_BLE_PROFILES = Object.freeze([
  { id: 'jbd-ff00', label: 'FF00 (FF01/FF02)', service: 0xff00, notify: 0xff01, write: 0xff02, writeMode: /** @type {const} */ ('prefer-without-response'), chunkSize: 20 },
  { id: 'jbd-fff0', label: 'FFF0 (FFF1/FFF2), JBD-DH04SC02', service: 0xfff0, notify: 0xfff1, write: 0xfff2, writeMode: /** @type {const} */ ('prefer-without-response'), chunkSize: 20 },
]);

/**
 * Chooser name prefixes (spec 11.1): only distinctive ones. Short prefixes such as SP or LT would
 * list unrelated devices; model codes are ranked by the patterns instead.
 */
export const JBD_NAME_PREFIXES = Object.freeze(['JBD-', 'xiaoxiang', 'SBL-', 'LSG-', 'OGR-', 'SX1', 'SX60', 'TITAN-', 'TZ-H', 'ECO-LFP', '@KsM:']);

/** Ranking patterns (spec 11.1, [AIO] matcher patterns). */
export const JBD_NAME_PATTERNS = Object.freeze([
  /^(JBD-|xiaoxiang)/i,
  /^(SP|DP|AP|UP)\d{2}S\d{3}/,
  /^(SBL-|LSG-|OGR-|TITAN-|TZ-H|SJ-\d{3}-|SX(1|60)|ECO-LFP)/,
  /^(12|24)\d{3}BL/,
  /^[JN]-\d{5}[YB]/,
]);

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const jbdDefinition = {
  id: 'jbd',
  family: 'jbd',
  vendor: JBD_VENDOR,
  protocol: msg('JBD DD A5 (Bluetooth, UART, RS485)'),
  deviceType: 'bms',
  description: msg(
    'JBD (Jiabaida) smart BMS and the brands built on it (Xiaoxiang app, Overkill Solar, LLT Power, ECO-WORTHY and others): live data, protection counters, EEPROM settings in factory mode and MOSFET switches.',
  ),
  links: {
    ble: {
      profiles: [...JBD_BLE_PROFILES],
      namePrefixes: [...JBD_NAME_PREFIXES],
      namePatterns: [...JBD_NAME_PATTERNS],
      // Every JBD module in [AIO] test data advertises FF00 (spec 2.1). The company id of the
      // manufacturer data is part of the device address, so it is no filter (spec 2.1, 11.1).
      advertisedServices: [0xff00],
      optionalServices: [0xff00, 0xfff0],
    },
    serial: {
      profiles: [{ id: 'jbd-9600', label: 'UART / RS485 9600 8N1', baudRate: 9600, dataBits: /** @type {const} */ (8), stopBits: /** @type {const} */ (1), parity: /** @type {const} */ ('none') }],
      note: msg('4 pin UART port of the board (3.3 V TTL: GND, RX, TX) or an RS485 model, 9600 baud. The protocol has no address: connect one BMS per adapter, and isolate the grounds of several packs.'),
    },
  },
  create: (ctx) => new JbdDriver(jbdDefinition, ctx),
  demo: { name: 'JBD-SP25S003-L16S-100A (demo)', chunkSize: 20, create: (link) => createJbdSimulator(link) },
};
