import { BaseDriver, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import {
  ASCII_CMD,
  ASCII_VER,
  BATTERY_TYPES,
  BLE_CMD,
  CAN_PROTOCOLS,
  CID1,
  RS485_PROTOCOLS,
  RTN,
  RTN_NAMES,
  cellsFromBits,
  createAsciiAssembler,
  createBleAssembler,
  describeAscii,
  describeBle,
  encodeAscii,
  encodeAsciiRequest,
  encodeBle,
  encodeBleRead,
  isAsciiAnswer,
  isParamBlockLayout,
  isParamBlockShape,
  parseAlarmInfo,
  parseAscii,
  parseAsciiInfo,
  parseBleFrame,
  parseBleInfo,
  parseBleParallel,
  parseBleSingle,
  parseParamBlock,
  parseTelemetry,
  plausibleAsciiInfo,
  setBlockParam,
  setBlockSwitch,
  switchStates,
  systemStateText,
  v2Alarms,
} from './protocol-v2.js';
import {
  ADDRESS,
  BLOCK,
  EXCEPTION,
  FN,
  INVERTER_PROTOCOLS,
  SCA,
  SCA_VALUE,
  SPA_BY_REG,
  V3_SYSTEM_BITS,
  calendarRegisters,
  createModbusAssembler,
  currentScaleFromName,
  describeModbus,
  encodeRead,
  encodeWriteCoils,
  encodeWriteRegisters,
  parseCalendar,
  parseEia,
  parsePct,
  parsePia,
  parsePib,
  parsePic,
  parseVia,
  registers,
  spaPairStart,
  spaRaw,
  spaValue,
  v3Alarms,
} from './protocol-v3.js';
import { buildV2Schema, buildV3Schema, decodeV2Settings, decodeV3Settings } from './settings.js';
import { createSeplosV2BleSimulator, createSeplosV2Simulator, createSeplosV3Simulator } from './simulator.js';

/**
 * Seplos drivers (docs/protocols/seplos.md):
 *
 * - `seplos-v3`: BMS 3.0 Modbus RTU over the Bluetooth module (FFF0) and RS485.
 * - `seplos-v2-ble`: the binary protocol of the V2 Bluetooth module (FF00, names BP00..BP15).
 * - `seplos-v2`: the V2.0 ASCII protocol on RS485 / RS232.
 *
 * Probes only read (spec 11.2). One request at a time on every link (spec 4).
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

export const SEPLOS_VENDOR = 'Seplos';

export const VARIANT = Object.freeze({ V2_ASCII: 'SEPLOS_V2_ASCII', V2_BLE: 'SEPLOS_V2_BLE', V3: 'SEPLOS_V3_MODBUS' });

/** V2 Bluetooth names: BP and the two digit DIP address (spec 2.1, 11.1). */
export const V2_BLE_NAME = /^BP\d{2}$/;
/** V3 Bluetooth names (spec 11.1). 'ST' is matched by aiobmsble but too generic to use. */
export const V3_NAME_PATTERNS = Object.freeze([/^SP\d{2}B/, /^SP1\d{2}B/, /^XZH/, /^CSY/]);

const NO_ANSWER = msg('No answer from the BMS. It may be asleep or out of range.');

const BAD_ANSWER = msg('The BMS sent an answer that could not be decoded');

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';
/** @param {any} link */
const isSerialLink = (link) => /serial/.test(link?.kind ?? '');
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * RS485 address from the connection options, or undefined when none was given.
 * @param {Record<string, any> | undefined} options
 */
function addressOption(options) {
  const a = Number(options?.address);
  return Number.isInteger(a) && a >= 0 && a <= 255 ? a : undefined;
}

/**
 * Error of a poll: a lost answer, a refusal of the BMS, or an answer that does not decode (the
 * details go to the log).
 * @param {unknown} err
 * @param {BaseDriver} driver
 */
function pollError(err, driver) {
  if (isTimeout(err)) return new Error(NO_ANSWER);
  const code = /** @type {any} */ (err)?.code;
  if (code === 'DEVICE' || code === 'MODBUS') return /** @type {Error} */ (err);
  driver.log?.warn(`${driver.definition.id}: ${errorText(err)}`, { source: driver.definition.id });
  return new Error(BAD_ANSWER);
}

/** Error carrying a protocol return code, so callers can tell a refusal from a lost answer. */
class DeviceError extends Error {
  /** @param {string} message @param {number} code */
  constructor(message, code) {
    super(message);
    this.code = 'DEVICE';
    this.deviceCode = code;
  }
}

const TEMP_LABELS = [msg('Temperature 1'), msg('Temperature 2'), msg('Temperature 3'), msg('Temperature 4'), msg('Temperature 5'), msg('Temperature 6')];

/**
 * Temperatures of a V2 answer: N - 2 cell sensors, then ambient, then power (MOSFET) (spec 6.1.1).
 * @param {number[]} temps
 * @returns {TemperatureReading[]}
 */
function v2Temperatures(temps) {
  const n = temps.length;
  return temps.map((value, j) => {
    if (n >= 2 && j === n - 2) return { id: 'ambient', label: msg('Ambient temperature'), value, kind: /** @type {const} */ ('ambient') };
    if (n >= 2 && j === n - 1) return { id: 'mos', label: msg('MOSFET temperature'), value, kind: /** @type {const} */ ('mos') };
    return { id: `t${j + 1}`, label: TEMP_LABELS[j] ?? `T${j + 1}`, value, kind: /** @type {const} */ ('cell') };
  });
}

/**
 * Shared V2 snapshot parts: switches, balancing, system state and alarms (spec 9.2 to 9.5).
 * @param {{ cellCount: number, tempCount: number, events: number[], switchState?: number, systemState?: number, balance?: number[], disconnect?: number[], cellAlarms?: number[], tempAlarms?: number[] }} a
 */
function v2Status(a) {
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  /** @type {Partial<BmsSnapshot>} */
  const out = { extra };
  if (a.switchState !== undefined) {
    const s = switchStates(a.switchState);
    out.switches = { charge: s.charge, discharge: s.discharge, heater: s.heater };
    extra.currentLimit = { label: msg('Current limit active'), value: s.currentLimit };
  }
  if (a.balance) {
    const on = new Set(cellsFromBits(a.balance, a.cellCount));
    out.balancing = Array.from({ length: a.cellCount }, (_, i) => on.has(i));
    out.balancingActive = on.size > 0;
  }
  if (a.systemState !== undefined) extra.systemState = { label: msg('System state'), value: systemStateText(a.systemState) };
  out.alarms = v2Alarms(a);
  return out;
}

/**
 * Unified snapshot of a V2 ASCII poll: 0x42 telemetry and, when answered, 0x44 alarms.
 * @param {Record<string, any>} t parseTelemetry result
 * @param {Record<string, any> | null} a parseAlarmInfo result
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function v2AsciiSnapshot(t, a) {
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {
    voltage: t.voltage,
    current: t.current,
    capacityRemaining: t.remainingAh,
    cells: t.cellVoltages,
    temperatures: v2Temperatures(t.temperatures),
  };
  if (t.soc !== undefined) s.soc = t.soc;
  if (t.soh !== undefined) s.soh = t.soh;
  if (t.capacityAh !== undefined) s.capacityFull = t.capacityAh;
  if (t.ratedAh !== undefined) s.capacityNominal = t.ratedAh;
  if (t.cycles !== undefined) s.cycles = t.cycles;
  /** @type {Record<string, ExtraValue>} */
  let extra = {};
  if (a) {
    const st = v2Status({ ...a, cellCount: t.cellCount, tempCount: t.tempCount });
    extra = /** @type {Record<string, ExtraValue>} */ (st.extra);
    delete st.extra;
    Object.assign(s, st);
  }
  if (t.portVoltage !== undefined) extra.portVoltage = { label: msg('Port voltage'), value: t.portVoltage, unit: 'V', decimals: 2 };
  s.extra = extra;
  return s;
}

/**
 * Unified snapshot of a V2 BLE 0x61 answer, with bank values of 0x62 when the pack is a master.
 * @param {Record<string, any>} d parseBleSingle result
 * @param {Record<string, any> | null} [bank] parseBleParallel result
 * @param {number} [packs] packs in the bank (slaves + 1)
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function v2BleSnapshot(d, bank = null, packs) {
  const st = v2Status(/** @type {any} */ (d));
  const extra = /** @type {Record<string, ExtraValue>} */ (st.extra);
  delete st.extra;
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {
    voltage: d.voltage,
    current: d.current,
    capacityRemaining: d.remainingAh,
    cells: d.cellVoltages,
    temperatures: v2Temperatures(d.temperatures),
    ...st,
  };
  if (d.soc !== undefined) s.soc = d.soc;
  if (d.soh !== undefined) s.soh = d.soh;
  if (d.capacityAh !== undefined) s.capacityFull = d.capacityAh;
  if (d.ratedAh !== undefined) s.capacityNominal = d.ratedAh;
  if (d.cycles !== undefined) s.cycles = d.cycles;
  if (d.portVoltage !== undefined) extra.portVoltage = { label: msg('Port voltage'), value: d.portVoltage, unit: 'V', decimals: 2 };
  if (packs !== undefined && packs > 1) extra.packCount = { label: msg('Packs in the bank'), value: packs, decimals: 0 };
  if (bank && bank.eventCount > 0) {
    extra.bankVoltage = { label: msg('Bank voltage'), value: bank.voltage, unit: 'V', decimals: 2 };
    extra.bankCurrent = { label: msg('Bank current'), value: bank.current, unit: 'A', decimals: 1 };
    if (bank.soc !== undefined) extra.bankSoc = { label: msg('Bank state of charge'), value: bank.soc, unit: '%', decimals: 1 };
    extra.bankRemaining = { label: msg('Bank remaining capacity'), value: bank.remainingAh, unit: 'Ah', decimals: 1 };
  }
  s.extra = extra;
  return s;
}

/**
 * Unified snapshot of a V3 poll (spec 6.3, 9.9).
 * @param {{ pia: Record<string, number>, pib: ReturnType<typeof parsePib>, pic: ReturnType<typeof parsePic> | null, cellCount?: number, ntcCount?: number, ratedAh?: number, eia?: ReturnType<typeof parseEia> | null }} p
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function v3Snapshot({ pia, pib, pic, cellCount, ntcCount, ratedAh, eia }) {
  let cells = pib.cellVoltages;
  if (cellCount !== undefined && cellCount >= 1 && cellCount <= 16) cells = cells.slice(0, cellCount);
  else {
    let n = cells.length;
    while (n > 0 && cells[n - 1] === 0) n--;
    cells = cells.slice(0, n);
  }
  const ntc = ntcCount !== undefined && ntcCount >= 0 && ntcCount <= 4 ? ntcCount : 4;
  /** @type {TemperatureReading[]} */
  const temperatures = pib.cellTemps.slice(0, ntc).map((value, j) => ({ id: `t${j + 1}`, label: TEMP_LABELS[j], value, kind: /** @type {const} */ ('cell') }));
  temperatures.push(
    { id: 'ambient', label: msg('Ambient temperature'), value: pib.ambientTemp, kind: 'ambient' },
    { id: 'mos', label: msg('MOSFET temperature'), value: pib.powerTemp, kind: 'mos' },
  );
  /** @type {Record<string, ExtraValue>} */
  const extra = {
    chargeLimit: { label: msg('Charge current limit'), value: pia.maxChargeCurrent, unit: 'A', decimals: 0 },
    dischargeLimit: { label: msg('Discharge current limit'), value: pia.maxDischargeCurrent, unit: 'A', decimals: 0 },
    dischargedAh: { label: msg('Total discharged capacity'), value: pia.dischargedAh, unit: 'Ah', decimals: 0 },
  };
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = {
    voltage: pia.voltage,
    current: pia.current,
    soc: pia.soc,
    soh: pia.soh,
    capacityRemaining: pia.remainingAh,
    capacityFull: pia.totalAh,
    cycles: pia.cycles,
    cells,
    temperatures,
    extra,
  };
  if (ratedAh !== undefined && ratedAh > 0) s.capacityNominal = ratedAh;
  if (pic) {
    const st = pic.state;
    s.switches = { discharge: (st.fet & 1) === 1, charge: (st.fet & 2) === 2, heater: (st.fet & 8) === 8 };
    extra.currentLimit = { label: msg('Current limit active'), value: (st.fet & 4) === 4 };
    const on = new Set(pic.balancing);
    s.balancing = cells.map((_, i) => on.has(i));
    s.balancingActive = s.balancing.some(Boolean);
    extra.staticBalancing = { label: msg('Static balancing'), value: (st.balance & 2) === 2 };
    const names = V3_SYSTEM_BITS.filter((b) => (st.system >> b.bit) & 1).map((b) => b.name);
    extra.systemState = { label: msg('System state'), value: names.length ? names.join(', ') : msg('None') };
    s.alarms = v3Alarms(st, { cellHigh: pic.cellHigh, cellLow: pic.cellLow, tempHigh: pic.tempHigh, tempLow: pic.tempLow });
  }
  if (eia && eia.packCount > 1) {
    extra.packCount = { label: msg('Packs in the bank'), value: eia.packCount, decimals: 0 };
    extra.bankVoltage = { label: msg('Bank voltage'), value: eia.voltage, unit: 'V', decimals: 2 };
    extra.bankCurrent = { label: msg('Bank current'), value: eia.current, unit: 'A', decimals: 1 };
    extra.bankSoc = { label: msg('Bank state of charge'), value: eia.soc, unit: '%', decimals: 1 };
  }
  return s;
}

/** @param {string} s */
const trim = (s) => s.replace(/[\s\0]+$/, '');

// ---------------------------------------------------------------------------------------------
// V2 ASCII (wired)
// ---------------------------------------------------------------------------------------------

/**
 * Seplos layout of a 0x42 answer (spec 11.2 step 2): M, N, P = 10 and the LENID they give. This
 * alone decides the detection; Pylontech shares the framing and VER 0x20 but sends P = 2 or 4.
 * @param {Record<string, any>} t
 * @param {number} lenid
 */
export function telemetryLayout(t, lenid) {
  const m = t.cellCount;
  const n = t.tempCount;
  if (m < 1 || m > 24 || n < 1 || n > 8 || t.customCount !== 10) return false;
  return lenid === 2 * (3 + 2 * m + 1 + 2 * n + 7 + 2 * t.customCount);
}

/**
 * Seplos layout with plausible values (every cell 0 or 1..5 V, SOC at most 100 %): only raises
 * the probe confidence, so a pack with a dead cell or an open sense lead still connects.
 * @param {Record<string, any>} t
 * @param {number} lenid
 */
export function plausibleTelemetry(t, lenid) {
  if (!telemetryLayout(t, lenid)) return false;
  if (!t.cellVoltages.every((/** @type {number} */ v) => v === 0 || (v >= 1 && v <= 5))) return false;
  return t.soc === undefined || t.soc <= 100;
}

/** Timeouts of the V2 ASCII requests (spec 4.1): 500 ms per the document, 1.5 s for the long answers at 9600. */
const ASCII_TIMEOUT = 1500;

export class SeplosV2AsciiDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.address = addressOption(ctx.options) ?? 0;
    /** Command of the request in flight, names the answer in the log. @type {number | undefined} */
    this.pendingCommand = undefined;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: (h) => createAsciiAssembler(h),
      describe: (f) => describeAscii(f, { command: this.pendingCommand }),
      log: ctx.log,
    }).start();
    /** @type {SettingsSchema | null} */
    this.schema = null;
    /** The schema was built for a block with the standard layout. @type {boolean | undefined} */
    this.schemaStandard = undefined;
    this.protocolVersion = '2.0';
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 1500, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * One request and its answer (only inside `channel.exclusive`). The answer must come from this
   * address with VER 0x20 and CID1 0x46; a return code other than 0 throws.
   * @param {number} cid2
   * @param {ArrayLike<number>} [info]
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #request(cid2, info, { timeout = ASCII_TIMEOUT, retries = 1 } = {}) {
    const bytes = info ? encodeAscii({ adr: this.address, cid2, info }) : encodeAsciiRequest(cid2, this.address);
    const d = describeAscii(bytes);
    this.pendingCommand = cid2;
    try {
      const frame = await this.channel.requestUnqueued(bytes, {
        match: (f) => {
          const p = parseAscii(f);
          return !!p && p.ver === ASCII_VER && p.adr === this.address && p.cid1 === CID1 && isAsciiAnswer(p);
        },
        timeout,
        retries,
        name: d?.name,
        decode: d?.decode,
      });
      const p = /** @type {import('./protocol-v2.js').AsciiFrame} */ (parseAscii(frame));
      if (p.cid2 !== RTN.OK) {
        this.log?.warn(`Seplos V2: command 0x${cid2.toString(16).toUpperCase()} answered ${RTN_NAMES[/** @type {keyof typeof RTN_NAMES} */ (p.cid2)] ?? p.cid2}`, { source: this.definition.id });
        throw new DeviceError(p.cid2 === RTN.DATA_INVALID ? msg('The BMS rejected the value') : msg('The BMS rejected the request'), p.cid2);
      }
      return p;
    } finally {
      this.pendingCommand = undefined;
    }
  }

  /**
   * Read only probe (spec 11.2): 0x51 device information, then 0x42 telemetry. Pylontech and
   * other batteries with the same framing fail the VER or the layout checks.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const per = clamp(Math.floor(timeout / 2), 400, ASCII_TIMEOUT);
    return this.channel.exclusive(async () => {
      /** @type {import('./protocol-v2.js').AsciiFrame} */
      let infoFrame;
      try {
        infoFrame = await this.#request(ASCII_CMD.INFO, undefined, { timeout: per, retries: 0 });
      } catch {
        return null;
      }
      if (infoFrame.lenid !== 64 || !plausibleAsciiInfo(infoFrame.info)) return null;
      const dev = parseAsciiInfo(infoFrame.info);
      let confidence = 0.6;
      try {
        const t = await this.#request(ASCII_CMD.TELEMETRY, undefined, { timeout: per, retries: 0 });
        const telemetry = parseTelemetry(t.info);
        if (!telemetryLayout(telemetry, t.lenid)) return null;
        if (plausibleTelemetry(telemetry, t.lenid)) confidence = 0.95;
        else this.log?.warn('Seplos V2: 0x42 has the Seplos layout but implausible values (cell or SOC out of range): lower confidence', { source: this.definition.id });
      } catch (err) {
        if (!isTimeout(err)) return null;
      }
      this.setVariant(VARIANT.V2_ASCII);
      return {
        variant: VARIANT.V2_ASCII,
        confidence,
        info: { vendor: SEPLOS_VENDOR, model: trim(dev.model), softwareVersion: dev.softwareVersion, protocol: this.definition.protocol },
      };
    });
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      try {
        const t = parseTelemetry((await this.#request(ASCII_CMD.TELEMETRY)).info);
        /** @type {Record<string, any> | null} */
        let a = null;
        try {
          a = parseAlarmInfo((await this.#request(ASCII_CMD.ALARMS)).info);
        } catch (err) {
          this.log?.warn(`Seplos V2 alarms: ${errorText(err)}`, { source: this.definition.id });
        }
        return v2AsciiSnapshot(t, a);
      } catch (err) {
        throw pollError(err, this);
      }
    });
    this.publish(snap);
  }

  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /** @type {DeviceInfo} */
      const out = { vendor: SEPLOS_VENDOR, protocol: this.definition.protocol };
      try {
        const f = await this.#request(ASCII_CMD.INFO);
        const d = parseAsciiInfo(f.info);
        out.model = trim(d.model);
        out.softwareVersion = d.softwareVersion;
        out.extra = { manufacturerField: { label: msg('Manufacturer field'), value: trim(d.manufacturer) } };
        this.protocolVersion = `${f.ver >> 4}.${f.ver & 15}`;
        out.extra.protocolVersion = { label: msg('Protocol version'), value: this.protocolVersion };
      } catch (err) {
        this.log?.warn(`Seplos V2 device information: ${errorText(err)}`, { source: this.definition.id });
      }
      return out;
    });
    return this.publishInfo(info);
  }

  /**
   * Read and decode the parameter block (only inside `channel.exclusive`). INFO 0x00 as the vendor
   * tool sends it; captured only at address 0, so whether a pack at another DIP address accepts
   * group 0 here and in the 0xA1 block is **unverified** (spec 4.1 step 6, 7.1).
   */
  async #readBlock() {
    const f = await this.#request(ASCII_CMD.PARAMS, [0x00], { timeout: 2500 });
    const block = parseParamBlock(f.info);
    if (!this.schema || this.schemaStandard !== block.standard) {
      this.schema = buildV2Schema({ writable: block.standard });
      this.schemaStandard = block.standard;
    }
    return block;
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      try {
        const block = await this.#readBlock();
        return decodeV2Settings(block, /** @type {SettingsSchema} */ (this.schema));
      } catch (err) {
        if (isTimeout(err)) throw new Error(msg('The BMS did not answer the settings requests'));
        throw err;
      }
    });
  }

  /**
   * Write one parameter or function switch: read the block, change the field, send the whole
   * block with 0xA1 (spec 7.5). The session reads everything back afterwards.
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = fieldMap(this.schema).get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    await this.channel.exclusive(async () => {
      const block = await this.#readBlock();
      if (!block.standard) throw new Error(msg('This value is read only'));
      const next = applyV2Field(block.raw, f, value);
      await this.#request(ASCII_CMD.WRITE_PARAMS, next, { timeout: 2500, retries: 0 });
    });
  }

  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

/**
 * The block with one field changed (spec 7.1, 7.2); discharge currents go back negative.
 * @param {Uint8Array} raw
 * @param {import('@ubms/bms-core/settings').SettingField} f
 * @param {any} value
 */
function applyV2Field(raw, f, value) {
  const m = f.meta ?? {};
  try {
    if (m.kind === 'param') return setBlockParam(raw, m.key, m.negate ? -Number(value) : Number(value));
    if (m.kind === 'switch') return setBlockSwitch(raw, m.byte, m.bit, value === true || value === 1 || value === 'true');
  } catch {
    throw new Error(msg('Invalid value'));
  }
  throw new Error(msg('Unknown setting'));
}

// ---------------------------------------------------------------------------------------------
// V2 BLE
// ---------------------------------------------------------------------------------------------

/** Request timeouts (spec 4.2): the app waits up to 5 s; the parameter block takes about 1 s. */
const BLE_TIMEOUT = 2000;
const BLE_PARAMS_TIMEOUT = 4000;
/** Read the bank summary (0x62) every this many polls on a master pack. */
const PARALLEL_EVERY = 3;

/**
 * 0x61 answer plausible for detection (spec 11.2): M up to 24, P = 8, SOC up to 100 %.
 * @param {Record<string, any>} d
 */
export function plausibleSingle(d) {
  return d.cellCount >= 1 && d.cellCount <= 24 && d.tempCount >= 1 && d.tempCount <= 8 && d.eventCount === 8 && (d.soc === undefined || d.soc <= 100);
}

export class SeplosV2BleDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: (h) => createBleAssembler(h), describe: describeBle, log: ctx.log }).start();
    /** @type {SettingsSchema | null} */
    this.schema = null;
    /** @type {boolean | undefined} */
    this.schemaStandard = undefined;
    /** Slaves reported by 0x51; a master with slaves also serves 0x62. */
    this.slaves = 0;
    this.pollCount = 0;
    /** @type {Record<string, any> | null} */
    this.bank = null;
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 };
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * One request and its answer (only inside `channel.exclusive`). The answer carries the CID; a
   * 0x61 answer with the parameter block layout is a late answer to an older 0x47 (spec 12) and is
   * skipped.
   * @param {number} cid
   * @param {{ data?: ArrayLike<number>, timeout?: number, retries?: number, accept?: (data: Uint8Array) => boolean }} [opts]
   */
  async #request(cid, { data, timeout = BLE_TIMEOUT, retries = 1, accept } = {}) {
    const bytes = data ? encodeBle({ cid, data }) : encodeBleRead(cid);
    const d = describeBle(bytes);
    const frame = await this.channel.requestUnqueued(bytes, {
      match: (f) => {
        const p = parseBleFrame(f);
        if (!p || p.b3 !== cid) return false;
        if (p.b4 !== RTN.OK) return true;
        return accept ? accept(p.data) : true;
      },
      timeout,
      retries,
      name: d?.name,
      decode: d?.decode,
    });
    const p = /** @type {import('./protocol-v2.js').BleFrame} */ (parseBleFrame(frame));
    if (p.b4 !== RTN.OK) {
      this.log?.warn(`Seplos V2 BLE: command 0x${cid.toString(16).toUpperCase()} answered ${RTN_NAMES[/** @type {keyof typeof RTN_NAMES} */ (p.b4)] ?? p.b4}`, { source: this.definition.id });
      throw new DeviceError(msg('The BMS rejected the request'), p.b4);
    }
    return p;
  }

  /** @param {{ timeout?: number, retries?: number }} [opts] */
  #readInfoFrame(opts) {
    return this.#request(BLE_CMD.INFO, { ...opts, accept: (d) => d.length >= 36 });
  }

  /** @param {{ timeout?: number, retries?: number }} [opts] */
  async #readSingle(opts) {
    const p = await this.#request(BLE_CMD.SINGLE, { ...opts, accept: (d) => !isParamBlockShape(d) });
    return parseBleSingle(p.data);
  }

  /**
   * Read only probe (spec 11.2): 0x51 (36 bytes, valid CRC) then 0x61. Never 0xA1, 0x63, 0x64,
   * 0x65 or 0xAA.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const per = clamp(Math.floor(timeout / 2), 500, BLE_TIMEOUT);
    return this.channel.exclusive(async () => {
      /** @type {ReturnType<typeof parseBleInfo>} */
      let info;
      try {
        const f = await this.#readInfoFrame({ timeout: per, retries: 1 });
        if (f.length !== 36) return null;
        info = parseBleInfo(f.data);
      } catch {
        return null;
      }
      this.slaves = info.slaves;
      let confidence = 0.8;
      try {
        if (plausibleSingle(await this.#readSingle({ timeout: per, retries: 0 }))) confidence = 0.95;
      } catch {
        /* 0x51 alone already identifies the module */
      }
      this.setVariant(VARIANT.V2_BLE);
      return {
        variant: VARIANT.V2_BLE,
        confidence,
        info: { vendor: SEPLOS_VENDOR, model: trim(info.model), softwareVersion: info.softwareVersion, protocol: this.definition.protocol },
      };
    });
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      try {
        const d = await this.#readSingle();
        if (this.slaves > 0 && this.pollCount++ % PARALLEL_EVERY === 0) {
          try {
            this.bank = parseBleParallel((await this.#request(BLE_CMD.PARALLEL, { retries: 0 })).data);
          } catch (err) {
            this.log?.warn(`Seplos V2 BLE parallel data: ${errorText(err)}`, { source: this.definition.id });
          }
        }
        return v2BleSnapshot(d, this.slaves > 0 ? this.bank : null, this.slaves > 0 ? this.slaves + 1 : undefined);
      } catch (err) {
        throw pollError(err, this);
      }
    });
    this.publish(snap);
  }

  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      /** @type {DeviceInfo} */
      const out = { vendor: SEPLOS_VENDOR, protocol: this.definition.protocol };
      try {
        const d = parseBleInfo((await this.#readInfoFrame()).data);
        this.slaves = d.slaves;
        out.model = trim(d.model);
        out.softwareVersion = d.softwareVersion;
        /** @type {Record<string, ExtraValue>} */
        const extra = {
          manufacturerField: { label: msg('Manufacturer field'), value: trim(d.manufacturer) },
          canProtocol: { label: msg('CAN protocol'), value: CAN_PROTOCOLS[/** @type {keyof typeof CAN_PROTOCOLS} */ (d.canProtocol)] ?? `0x${d.canProtocol.toString(16)}` },
          rs485Protocol: { label: msg('RS485 protocol'), value: RS485_PROTOCOLS[/** @type {keyof typeof RS485_PROTOCOLS} */ (d.rs485Protocol)] ?? `0x${d.rs485Protocol.toString(16)}` },
          batteryType: { label: msg('Battery type'), value: BATTERY_TYPES[/** @type {keyof typeof BATTERY_TYPES} */ (d.batteryType)] ?? `0x${d.batteryType.toString(16).toUpperCase()}` },
        };
        if (d.slaves > 0) extra.packCount = { label: msg('Packs in the bank'), value: d.slaves + 1, decimals: 0 };
        out.extra = extra;
      } catch (err) {
        this.log?.warn(`Seplos V2 BLE manufacturer information: ${errorText(err)}`, { source: this.definition.id });
      }
      return out;
    });
    return this.publishInfo(info);
  }

  /**
   * Read and decode the parameter block. Any block whose counts add up to its length is accepted,
   * so a block with another layout than 60 / 27 / 8 reaches the read only schema (spec 7.7)
   * instead of timing out; a late 0x61 answer carrying the CID 0x47 (spec 12) does not fit.
   */
  async #readBlock() {
    const p = await this.#request(BLE_CMD.PARAMS, { timeout: BLE_PARAMS_TIMEOUT, accept: isParamBlockLayout });
    const block = parseParamBlock(p.data);
    if (!this.schema || this.schemaStandard !== block.standard) {
      this.schema = buildV2Schema({ writable: block.standard });
      this.schemaStandard = block.standard;
    }
    return block;
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      try {
        return decodeV2Settings(await this.#readBlock(), /** @type {SettingsSchema} */ (this.schema));
      } catch (err) {
        if (isTimeout(err)) throw new Error(msg('The BMS did not answer the settings requests'));
        throw err;
      }
    });
  }

  /**
   * Read the block, change one field, write it back with 0xA1 (spec 7.5). Documented by the
   * vendor for Bluetooth; captured only over RS485 (spec 7.1).
   * @param {string} id
   * @param {any} value
   */
  async writeSetting(id, value) {
    const f = fieldMap(this.schema).get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action') throw new Error(msg('This value is read only'));
    await this.channel.exclusive(async () => {
      const block = await this.#readBlock();
      if (!block.standard) throw new Error(msg('This value is read only'));
      try {
        await this.#request(BLE_CMD.WRITE_PARAMS, { data: applyV2Field(block.raw, f, value), timeout: BLE_PARAMS_TIMEOUT, retries: 0 });
      } catch (err) {
        if (/** @type {any} */ (err)?.deviceCode === RTN.FAILED) throw new Error(msg('The BMS refused the new settings'));
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
// V3 Modbus RTU (Bluetooth and RS485)
// ---------------------------------------------------------------------------------------------

/** Request timing (spec 4.3 step 5): about 1 s per answer, the next request only after it. */
const V3_TIMING = Object.freeze({ ble: { timeout: 1500, retries: 1 }, serial: { timeout: 800, retries: 1 } });
/** While the bank size is unknown (EIA not answered at the start), ask again every this many polls. */
const EIA_RETRY_EVERY = 30;

/** Error for a Modbus exception answer. */
class ModbusException extends Error {
  /** @param {number} exception */
  constructor(exception) {
    super(exception === EXCEPTION.BUSY ? msg('The BMS is busy, try again in a moment') : msg('The BMS rejected the request'));
    this.code = 'MODBUS';
    this.exception = exception;
  }
}

/**
 * PIA plausible for detection (spec 11.2): pack 5 to 70 V, average cell 1.5 to 4.5 V, SOC and SOH
 * up to 100 %.
 * @param {Record<string, number>} p
 */
export const plausiblePia = (p) => p.voltage >= 5 && p.voltage <= 70 && p.avgCellVoltage >= 1.5 && p.avgCellVoltage <= 4.5 && p.soc <= 100 && p.soh <= 100;

export class SeplosV3Driver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.serial = isSerialLink(ctx.link);
    this.timing = this.serial ? V3_TIMING.serial : V3_TIMING.ble;
    this.configured = addressOption(ctx.options);
    /** Telemetry address: 0x00 over Bluetooth, the configured or detected address on RS485. */
    this.address = this.serial ? (this.configured ?? ADDRESS.MASTER) : ADDRESS.MASTER;
    /** @type {number | undefined} */
    this.expectedByteCount = undefined;
    /** @type {number | undefined} */
    this.pendingStart = undefined;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: (h) =>
        createModbusAssembler({
          ...h,
          addresses: [ADDRESS.MASTER, ADDRESS.PC, ...(this.configured !== undefined ? [this.configured] : [])],
          expectedByteCount: () => this.expectedByteCount,
        }),
      describe: (f) => describeModbus(f, { direction: 'rx', start: this.pendingStart }),
      log: ctx.log,
    }).start();
    this.currentScale = 0.01;
    /** Board rating from the VIA device name; undefined while the current unit is assumed (spec 12). @type {number | undefined} */
    this.rating = undefined;
    this.scaleWarned = false;
    /** @type {Record<string, string>} */
    this.via = {};
    /** @type {number | undefined} */
    this.cellCount = undefined;
    /** @type {number | undefined} */
    this.ntcCount = undefined;
    /** @type {number | undefined} */
    this.ratedAh = undefined;
    /** Packs in the bank from EIA; undefined until EIA was answered (spec 6.3.6). @type {number | undefined} */
    this.packCount = undefined;
    this.pollCount = 0;
    /** @type {SettingsSchema} */
    this.schema = buildV3Schema({ writable: this.writable });
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    return { settings: true, writeSettings: this.writable, streaming: false, pollIntervalMs: 1000, minPollIntervalMs: 1000 };
  }

  /**
   * Writes go to 0xE0 over Bluetooth and to the pack address on RS485, never to the broadcast
   * address 0 of a wired bus (spec 11.3).
   */
  get writable() {
    return !this.serial || this.address !== ADDRESS.MASTER;
  }

  /** Address of settings reads and of every write (spec 4.3, 11.3). */
  get settingsAddress() {
    return this.serial ? this.address : ADDRESS.PC;
  }

  getSettingsSchema() {
    return this.schema;
  }

  /**
   * Read registers or coils (only inside `channel.exclusive`). Exceptions throw ModbusException.
   * Firmware V1.43l answers a request with a bad CRC with exception 0x03 ([SO]
   * `Rtu_SlaveRequestCheck`, spec 12), so a read refused with 0x03 is sent once more: a request
   * corrupted on a noisy line then does not fail the poll.
   * @param {number} address
   * @param {{ fn: number, start: number, count: number }} block
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #read(address, block, opts) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#readOnce(address, block, opts);
      } catch (err) {
        if (/** @type {any} */ (err)?.exception !== EXCEPTION.ILLEGAL_VALUE || attempt > 0) throw err;
      }
    }
  }

  /**
   * @param {number} address
   * @param {{ fn: number, start: number, count: number }} block
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #readOnce(address, { fn, start, count }, { timeout = this.timing.timeout, retries = this.timing.retries } = {}) {
    const req = encodeRead(address, fn, start, count);
    const d = describeModbus(req, { direction: 'tx' });
    this.expectedByteCount = fn === FN.READ_COILS ? Math.ceil(count / 8) : 2 * count;
    this.pendingStart = start;
    try {
      const frame = await this.channel.requestUnqueued(req, {
        match: (f) => f[0] === address && (f[1] === fn || f[1] === (fn | 0x80)),
        timeout,
        retries,
        name: d?.name,
        decode: d?.decode,
      });
      if (frame[1] & 0x80) {
        this.log?.warn(`Seplos V3: exception ${frame[2]} for 0x${start.toString(16).toUpperCase()} at address ${address}`, { source: this.definition.id });
        throw new ModbusException(frame[2]);
      }
      return frame.slice(3, frame.length - 2);
    } finally {
      this.expectedByteCount = undefined;
      this.pendingStart = undefined;
    }
  }

  /**
   * Write registers (function 0x10) or coils (0x0F) and check the echo (only inside
   * `channel.exclusive`).
   * @param {Uint8Array} req
   * @param {number} fn
   * @param {number} start
   * @param {{ timeout?: number, retries?: number }} [opts]
   */
  async #write(req, fn, start, { timeout = this.timing.timeout, retries = 0 } = {}) {
    const address = req[0];
    if (this.serial && address === ADDRESS.MASTER) throw new Error(msg('This value is read only'));
    const d = describeModbus(req, { direction: 'tx' });
    const frame = await this.channel.requestUnqueued(req, {
      match: (f) => f[0] === address && (f[1] === fn || f[1] === (fn | 0x80)),
      timeout,
      retries,
      name: d?.name,
      decode: d?.decode,
    });
    if (frame[1] & 0x80) {
      this.log?.warn(`Seplos V3: write to 0x${start.toString(16).toUpperCase()} refused with exception ${frame[2]}`, { source: this.definition.id });
      throw new ModbusException(frame[2]);
    }
    if (((frame[2] << 8) | frame[3]) !== start) throw new Error(msg('The BMS did not confirm the written value'));
  }

  /** Addresses tried by the probe: 0 over Bluetooth; on RS485 the configured one, else 0 then 0xE0. */
  get #probeAddresses() {
    if (!this.serial) return [ADDRESS.MASTER];
    return this.configured !== undefined ? [this.configured] : [ADDRESS.MASTER, ADDRESS.PC];
  }

  /**
   * Read only probe (spec 11.2): VIA manufacturer (10 registers); "XZH-ElecTech" identifies the
   * BMS, other OEM strings need a plausible PIA. Functions 0x10 and 0x0F are never sent.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    const addrs = this.#probeAddresses;
    const per = this.serial ? clamp(Math.floor(timeout / (2 * addrs.length)), 300, 1000) : clamp(Math.floor(timeout / 2), 500, 1500);
    return this.channel.exclusive(async () => {
      for (const address of addrs) {
        /** @type {Record<string, string>} */
        let via;
        try {
          via = parseVia(await this.#read(address, BLOCK.VIA_NAME, { timeout: per, retries: this.serial ? 0 : 1 }));
        } catch {
          continue;
        }
        let confidence = 0;
        if (/XZH-ElecTech/i.test(via.manufacturer)) confidence = 0.95;
        else {
          try {
            if (plausiblePia(parsePia(registers(await this.#read(address, BLOCK.PIA, { timeout: per, retries: 0 }))))) confidence = 0.7;
          } catch {
            /* not plausible */
          }
        }
        if (!confidence) continue;
        this.address = address;
        this.schema = buildV3Schema({ writable: this.writable });
        this.via.manufacturer = via.manufacturer;
        this.setVariant(VARIANT.V3);
        return { variant: VARIANT.V3, confidence, info: { vendor: SEPLOS_VENDOR, protocol: this.definition.protocol } };
      }
      return null;
    });
  }

  /** Identity, current unit, cell and sensor counts and rated capacity (spec 4.3 step 3, 6.3.1). */
  async start() {
    await this.channel.exclusive(async () => {
      try {
        this.#setVia(parseVia(await this.#read(this.address, BLOCK.VIA)));
      } catch (err) {
        this.log?.warn(`Seplos V3 version information: ${errorText(err)}`, { source: this.definition.id });
      }
      try {
        this.#setSpa(await this.#readSpa());
      } catch (err) {
        this.log?.warn(`Seplos V3 parameters: ${errorText(err)}`, { source: this.definition.id });
      }
      if (this.rating === undefined) this.#warnScale();
      if (this.address === ADDRESS.MASTER) await this.#readEia();
    });
  }

  /**
   * Bank summary at the master address (only inside `channel.exclusive`). A timeout leaves the bank
   * size unknown, so poll() asks again later; an exception answer means no bank summary (one pack).
   * @returns {Promise<ReturnType<typeof parseEia> | null>}
   */
  async #readEia() {
    try {
      const eia = parseEia(registers(await this.#read(ADDRESS.MASTER, BLOCK.EIA, { retries: 0 })));
      this.packCount = Math.max(1, eia.packCount);
      return eia;
    } catch (err) {
      if (/** @type {any} */ (err)?.code === 'MODBUS') this.packCount = 1;
      this.log?.warn(`Seplos V3 bank summary: ${errorText(err)}`, { source: this.definition.id });
      return null;
    }
  }

  /** @param {Record<string, string>} via */
  #setVia(via) {
    this.via = { ...this.via, ...via };
    const { rating, scale } = currentScaleFromName(via.deviceName);
    this.rating = rating;
    if (rating === undefined) this.#warnScale();
    else if (scale !== this.currentScale) this.log?.event(`Seplos V3: ${rating} A board, current in ${scale} A steps`, { source: this.definition.id });
    this.currentScale = scale;
  }

  /** The current unit is assumed when the device name has no rating (spec 12); said once per connection. */
  #warnScale() {
    if (this.scaleWarned) return;
    this.scaleWarned = true;
    this.log?.warn('Seplos V3: board rating not found in the device name, current unit 0.01 A assumed (unverified)', { source: this.definition.id });
  }

  /** @param {Map<number, number>} spa */
  #setSpa(spa) {
    if (spa.has(0x1301)) this.cellCount = spa.get(0x1301);
    if (spa.has(0x1300)) this.ntcCount = spa.get(0x1300);
    if (spa.has(0x1358)) this.ratedAh = /** @type {number} */ (spa.get(0x1358)) / 100;
  }

  /** SPA in one read of 106 registers, or the two halves of 53 (spec 5.3). */
  async #readSpa() {
    /** @type {Map<number, number>} */
    const out = new Map();
    /** @param {number} start @param {number[]} regs */
    const store = (start, regs) => regs.forEach((v, i) => out.set(start + i, v));
    try {
      store(BLOCK.SPA.start, registers(await this.#read(this.settingsAddress, BLOCK.SPA)));
    } catch (err) {
      if (isTimeout(err)) throw err;
      store(0x1300, registers(await this.#read(this.settingsAddress, { fn: FN.READ_INPUT, start: 0x1300, count: 53 })));
      store(0x1335, registers(await this.#read(this.settingsAddress, { fn: FN.READ_INPUT, start: 0x1335, count: 53 })));
    }
    return out;
  }

  async poll() {
    const snap = await this.channel.exclusive(async () => {
      try {
        const pia = parsePia(registers(await this.#read(this.address, BLOCK.PIA)), { currentScale: this.currentScale });
        const pib = parsePib(registers(await this.#read(this.address, BLOCK.PIB)));
        /** @type {ReturnType<typeof parsePic> | null} */
        let pic = null;
        try {
          pic = parsePic(await this.#read(this.address, BLOCK.PIC));
        } catch (err) {
          if (isTimeout(err)) throw err;
          this.log?.warn(`Seplos V3 status bits: ${errorText(err)}`, { source: this.definition.id });
        }
        // Bank summary on every poll in a bank; while the bank size is unknown (EIA lost at the
        // start), on every EIA_RETRY_EVERY-th poll.
        const poll = this.pollCount++;
        /** @type {ReturnType<typeof parseEia> | null} */
        let eia = null;
        if (this.address === ADDRESS.MASTER && ((this.packCount ?? 0) > 1 || (this.packCount === undefined && poll % EIA_RETRY_EVERY === EIA_RETRY_EVERY - 1))) {
          eia = await this.#readEia();
        }
        return v3Snapshot({ pia, pib, pic, cellCount: this.cellCount, ntcCount: this.ntcCount, ratedAh: this.ratedAh, eia });
      } catch (err) {
        throw pollError(err, this);
      }
    });
    this.publish(snap);
  }

  async readInfo() {
    const info = await this.channel.exclusive(async () => {
      try {
        this.#setVia(parseVia(await this.#read(this.address, BLOCK.VIA)));
      } catch (err) {
        this.log?.warn(`Seplos V3 version information: ${errorText(err)}`, { source: this.definition.id });
      }
      /** @type {Record<string, ExtraValue>} */
      const extra = {};
      const v = this.via;
      if (v.manufacturer) extra.manufacturer = { label: msg('Manufacturer'), value: v.manufacturer };
      if (v.packSerial) extra.packSerial = { label: msg('Pack serial number'), value: v.packSerial };
      try {
        const pct = parsePct(await this.#read(this.address, BLOCK.PCT, { retries: 0 }));
        extra.inverterProtocol = { label: msg('Inverter protocol'), value: pct.protocolName || INVERTER_PROTOCOLS[pct.protocol] || String(pct.protocol) };
        if (pct.inverterName) extra.inverter = { label: msg('Inverter'), value: pct.inverterName };
      } catch (err) {
        this.log?.warn(`Seplos V3 inverter information: ${errorText(err)}`, { source: this.definition.id });
      }
      try {
        // Answered only while history recording (SFA 0x1430 bit 4) is on (spec 5.3).
        extra.clock = { label: msg('BMS clock'), value: parseCalendar(await this.#read(this.address, BLOCK.CALENDAR, { retries: 0 })).text };
      } catch {
        /* exception 0x01 without history recording */
      }
      if (this.address === ADDRESS.MASTER) await this.#readEia();
      if (this.rating === undefined) extra.currentUnit = { label: msg('Current unit'), value: msg('0.01 A, assumed: the device name does not give the board rating') };
      if (this.cellCount !== undefined) extra.cellCount = { label: msg('Cell count'), value: this.cellCount, decimals: 0 };
      if ((this.packCount ?? 0) > 1) extra.packCount = { label: msg('Packs in the bank'), value: this.packCount, decimals: 0 };
      /** @type {DeviceInfo} */
      const out = { vendor: SEPLOS_VENDOR, protocol: this.definition.protocol, extra };
      if (v.deviceName) out.model = v.deviceName;
      if (v.firmware) out.softwareVersion = v.firmware;
      if (v.bmsSerial) out.serialNumber = v.bmsSerial;
      return out;
    });
    return this.publishInfo(info);
  }

  async readSettings() {
    return this.channel.exclusive(async () => {
      let answered = 0;
      /** @type {Map<number, number> | undefined} */
      let spa;
      /** @type {number[] | undefined} */
      let sfa;
      /** @type {number | undefined} */
      let fet;
      try {
        spa = await this.#readSpa();
        this.#setSpa(spa);
        answered++;
      } catch (err) {
        this.log?.warn(`Seplos V3 parameters (SPA): ${errorText(err)}`, { source: this.definition.id });
      }
      try {
        sfa = [...(await this.#read(this.settingsAddress, BLOCK.SFA))];
        answered++;
      } catch (err) {
        this.log?.warn(`Seplos V3 function switches (SFA): ${errorText(err)}`, { source: this.definition.id });
      }
      try {
        fet = parsePic(await this.#read(this.address, BLOCK.PIC)).state.fet;
        answered++;
      } catch (err) {
        this.log?.warn(`Seplos V3 status bits: ${errorText(err)}`, { source: this.definition.id });
      }
      if (!answered) throw new Error(msg('The BMS did not answer the settings requests'));
      return decodeV3Settings(this.schema, { spa, sfa, fet }, (reg, raw) => spaValue(/** @type {any} */ (SPA_BY_REG.get(reg)), raw));
    });
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = fieldMap(this.schema).get(id);
    if (!f) throw new Error(msg('Unknown setting'));
    if (f.readOnly || f.type === 'action' || !this.writable) throw new Error(msg('This value is read only'));
    const m = f.meta ?? {};
    await this.channel.exclusive(async () => {
      if (m.kind === 'spa') return this.#writeSpa(m.reg, Number(value));
      if (m.kind === 'sfa') return this.#writeSfa(m.byte, m.bit, value === true || value === 1 || value === 'true');
      if (m.kind === 'mos') return this.#writeMos(m.key, value === true || value === 1 || value === 'true');
      throw new Error(msg('Unknown setting'));
    });
  }

  /**
   * Two register write (spec 7.5): the target and a neighbour carrying its fresh value, so firmware
   * V1.43l saves the change to flash. Exception 0x06 (busy) is retried once after a second.
   * Vendor documented ([XZH] SPA) and implemented in firmware V1.43l ([SO] `Reg_WriteWords`); no
   * capture of this write exists (**unverified** on the wire, spec 7.3).
   * @param {number} reg
   * @param {number} value
   */
  async #writeSpa(reg, value) {
    const def = SPA_BY_REG.get(reg);
    if (!def || def.write === 'no') throw new Error(msg('This value is read only'));
    /** @type {number} */
    let raw;
    try {
      raw = spaRaw(def, value);
    } catch {
      throw new Error(msg('Invalid value'));
    }
    const start = spaPairStart(reg);
    const address = this.settingsAddress;
    for (let attempt = 0; ; attempt++) {
      const current = registers(await this.#read(address, { fn: FN.READ_INPUT, start, count: 2 }));
      current[reg - start] = raw;
      try {
        await this.#write(encodeWriteRegisters(address, start, current), FN.WRITE_REGISTERS, start);
        return;
      } catch (err) {
        if (/** @type {any} */ (err)?.exception !== EXCEPTION.BUSY || attempt > 0) throw err;
        await sleep(1000);
      }
    }
  }

  /**
   * Write the whole byte that holds the bit (8 coils, spec 7.5), the other bits as just read.
   * Vendor documented ([XZH] SFA) and implemented in firmware V1.43l ([SO] `Reg_WriteBits`); no
   * capture of this write exists (**unverified** on the wire, spec 7.4).
   * @param {number} byte
   * @param {number} bit
   * @param {boolean} on
   */
  async #writeSfa(byte, bit, on) {
    const address = this.settingsAddress;
    const bytes = await this.#read(address, BLOCK.SFA);
    if (byte >= bytes.length) throw new Error(msg('The BMS rejected the request'));
    const b = on ? bytes[byte] | (1 << bit) : bytes[byte] & ~(1 << bit);
    const start = BLOCK.SFA.start + 8 * byte;
    await this.#write(encodeWriteCoils(address, start, 8, [b & 0xff]), FN.WRITE_COILS, start);
  }

  /**
   * MOSFET command (spec 8.3): 0x1510 for discharge, 0x1511 for charge; 0x55AA sets the off
   * command, 0xAA55 cancels it. In firmware V1.43l 0xAA55 to 0x1511 clears the command bits 2
   * (charge off) and 7 ([SO] `Reg_WriteWords` REG_CHG_FET_OFF); this cancel is verified in that
   * firmware only, the vendor app uses 0x1515 instead ([MR] `sca.md`). 0x1515 = 0xAA55 sets command
   * bit 7, whose effect (for example on a charge forbidden by a protection) no source shows
   * (**unverified**), so it is never sent. Vendor documented ([XZH] SCA) and implemented in the
   * firmware; no capture of these writes exists (**unverified** on the wire). Then wait until PIC
   * reports the state or give up after about a second.
   * @param {'charge'|'discharge'} key
   * @param {boolean} on
   */
  async #writeMos(key, on) {
    const address = this.settingsAddress;
    const reg = key === 'discharge' ? SCA.DISCHARGE : SCA.CHARGE_OFF;
    const value = on ? SCA_VALUE.CANCEL : SCA_VALUE.SET;
    await this.#write(encodeWriteRegisters(address, reg, [value]), FN.WRITE_REGISTERS, reg);
    const mask = key === 'discharge' ? 1 : 2;
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 100 : 300);
      try {
        const fet = parsePic(await this.#read(this.address, BLOCK.PIC, { retries: 0 })).state.fet;
        if (((fet & mask) !== 0) === on) return;
      } catch {
        /* the settings reload tells */
      }
    }
  }

  /**
   * Restart (SCA 0x1518 = 0x55AA) and calendar (0x1500) writes. Vendor documented ([XZH] SCA) and
   * implemented in firmware V1.43l ([SO] `Reg_WriteWords`); no capture of these writes exists
   * (**unverified** on the wire, spec 8.3).
   * @param {string} id
   * @param {any} [_arg]
   */
  async runAction(id, _arg) {
    const f = fieldMap(this.schema).get(id);
    if (!f || f.type !== 'action' || !this.writable) throw new Error(msg('Unknown action'));
    const address = this.settingsAddress;
    await this.channel.exclusive(async () => {
      if (f.meta?.kind === 'calendar') {
        try {
          await this.#write(encodeWriteRegisters(address, SCA.CALENDAR, calendarRegisters(new Date())), FN.WRITE_REGISTERS, SCA.CALENDAR);
        } catch (err) {
          if (/** @type {any} */ (err)?.exception === EXCEPTION.ILLEGAL_FUNCTION) throw new Error(msg('The BMS refused the clock. Switch on history recording first.'));
          throw err;
        }
        return;
      }
      if (f.meta?.kind === 'sca' && f.meta.reg === SCA.RESTART) {
        try {
          await this.#write(encodeWriteRegisters(address, SCA.RESTART, [SCA_VALUE.SET]), FN.WRITE_REGISTERS, SCA.RESTART);
        } catch (err) {
          // The BMS resets 100 ms after the answer; a lost answer is expected sometimes.
          if (!isTimeout(err)) throw err;
          this.log?.event('Seplos V3: no answer to the restart command, the BMS may be restarting', { source: this.definition.id });
        }
        return;
      }
      throw new Error(msg('Unknown action'));
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

/** 19200 8N1 (spec 2.2). */
const serial19200 = (/** @type {string} */ id) => ({
  id,
  label: 'RS485 19200 8N1',
  baudRate: 19200,
  dataBits: /** @type {const} */ (8),
  stopBits: /** @type {const} */ (1),
  parity: /** @type {const} */ ('none'),
});

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const seplosV3Definition = {
  id: 'seplos-v3',
  family: 'seplos',
  vendor: SEPLOS_VENDOR,
  protocol: msg('Seplos BMS 3.0 (Modbus RTU)'),
  deviceType: 'bms',
  description: msg('Seplos BMS 3.0 (48100, 48200, XZH boards) with Modbus RTU over its Bluetooth module or RS485.'),
  links: {
    ble: {
      // Bluetooth module (spec 2.1): FFF1 notify, FFF2 write without response, as syssi and
      // aiobmsble do. The same service is used by Daly modules; the probe decides.
      profiles: [
        {
          id: 'seplos-v3-fff0',
          label: 'FFF0 (FFF1/FFF2)',
          service: 0xfff0,
          notify: 0xfff1,
          write: 0xfff2,
          writeMode: /** @type {const} */ ('prefer-without-response'),
          chunkSize: 20,
        },
      ],
      // 'SP' plus a digit (SP05B..., SP57B-A...); the ranking patterns are stricter.
      namePrefixes: ['SP0', 'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7', 'SP8', 'SP9', 'XZH', 'CSY'],
      namePatterns: [...V3_NAME_PATTERNS],
    },
    serial: {
      profiles: [serial19200('seplos-v3-19200')],
      note: msg(
        'RS485 of the pack at 19200 baud. The master pack answers address 0, the PC and display port address 224; set the address of another pack in the options. Nothing is written to address 0 on a wired bus.',
      ),
    },
  },
  create: (ctx) => new SeplosV3Driver(seplosV3Definition, ctx),
  demo: { name: 'SP05B2312190075 (demo)', chunkSize: 20, create: (link) => createSeplosV3Simulator(link) },
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const seplosV2BleDefinition = {
  id: 'seplos-v2-ble',
  family: 'seplos',
  vendor: SEPLOS_VENDOR,
  protocol: msg('Seplos V2 (Bluetooth)'),
  deviceType: 'bms',
  description: msg('Bluetooth module of the Seplos BMS 1.0 and 2.0 boards (names BP00 to BP15).'),
  links: {
    ble: {
      // FF01 notify, FF02 write with response as the official app does (spec 2.1). Daly uses the
      // same layout as its fallback profile.
      profiles: [
        {
          id: 'seplos-v2-ff00',
          label: 'FF00 (FF01/FF02)',
          service: 0xff00,
          notify: 0xff01,
          write: 0xff02,
          writeMode: /** @type {const} */ ('auto'),
          chunkSize: 20,
        },
      ],
      namePrefixes: ['BP0', 'BP1'],
      namePatterns: [V2_BLE_NAME],
    },
  },
  create: (ctx) => new SeplosV2BleDriver(seplosV2BleDefinition, ctx),
  demo: { name: 'BP00 (demo)', chunkSize: 20, create: (link) => createSeplosV2BleSimulator(link) },
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const seplosV2Definition = {
  id: 'seplos-v2',
  family: 'seplos',
  vendor: SEPLOS_VENDOR,
  protocol: msg('Seplos V2 (RS485, ASCII)'),
  deviceType: 'bms',
  description: msg('Seplos BMS 1.0 and 2.0 boards (1101-SP.., EMU10xx, EMU11xx) with the V2.0 ASCII protocol on RS485 or RS232.'),
  links: {
    serial: {
      // 19200 on the RS485 ports of the 48 V packs, 9600 per the V2.0 document (spec 2.2).
      profiles: [serial19200('seplos-v2-19200'), { ...serial19200('seplos-v2-9600'), label: 'RS485 / RS232 9600 8N1', baudRate: 9600 }],
      note: msg('RS485 (RJ45 pins 1 and 8 B, 2 and 7 A, 3 and 6 ground) or RS232. The pack answers its DIP switch address, 0 unless set in the options.'),
    },
  },
  create: (ctx) => new SeplosV2AsciiDriver(seplosV2Definition, ctx),
  demo: { name: 'Seplos 1101-SP76 (demo)', chunkSize: 0, create: (link) => createSeplosV2Simulator(link) },
};
