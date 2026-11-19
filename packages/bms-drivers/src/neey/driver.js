import { BaseDriver, SEVERITY_ORDER, alarm, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import { r } from '../common/util.js';
import {
  MAX_CELLS,
  STATUS,
  VARIANT,
  balancerRating,
  cellInfoRequest,
  createAnswerAssembler,
  describe,
  deviceInfoProblem,
  deviceInfoRequest,
  formatDate,
  isAckFor,
  isCellInfoFrame,
  isDeviceInfoFrame,
  isSettingsFrame,
  parseCellInfo,
  parseDeviceInfo,
  parseSettings,
  parseShortAnswer,
  settingsRequest,
  settingsVariant,
  variantFromModel,
} from './protocol.js';
import { buildNeeySchema, decodeNeeySettings, encodeSettingWrite } from './settings.js';
import { createNeeySimulator } from './simulator.js';

/**
 * NEEY / Heltec / EnerKey active balancers over Bluetooth LE (docs/protocols/neey.md, "spec"
 * below), device type 'balancer'. One definition, `neey-ble`, for both protocol variants:
 * NEEY_V1 (100-byte settings, 2 temperatures: GW-24S4EB, EK-24S4EB, EK-16S2EB, EK-24S10EB and
 * the other EK-..EB units) and NEEY_V2 (150-byte settings with BMS limits, pack current, SOC and
 * 4 temperatures: EK-B24S8E200A). No serial definition: no usable wired port is known (spec 2.2).
 *
 * The balancer streams a cell info frame about every 0.5 s once the settings request was sent
 * (spec 4.1, 4.2), so `poll()` sends nothing while frames arrive and re-sends the cell info
 * request after about 3 s of silence. That this request restarts a stopped stream is not
 * documented: when two of them in a row bring at most one frame each, one settings request (the
 * documented stream starter) follows, once per stall. Settings are not polled otherwise: the
 * balancer beeps on requests it accepts (spec 4.2, unverified for models other than the GW-24S4EB
 * ZH-1.2.3).
 *
 * Requests use sum8. A unit that answers neither device info attempt in that form gets the xor8
 * form of the old app once; when it answers, every later request uses the captured xor8 forms
 * (GW SW-1.1.0, whose sum8 support is unverified, spec 3.4, 11.2).
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').AlarmState} AlarmState
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('@ubms/bms-core/model').TemperatureReading} TemperatureReading
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

export const NEEY_VENDOR = 'NEEY';

/** Default names start with these (spec 11.1); no other ubms family uses them. */
export const NAME_PREFIXES = Object.freeze(['GW-', 'EK-']);

/**
 * Default names (spec 11.1): GW-24S4EB, EK-24S4EB, EK-16S2EB, EK-24S10EB, EK-24S20EB,
 * EK-B24S8E200A and the advertised "EK-24S200A" of the EK-B24S8E200A.
 */
export const NAME_PATTERN = /^(GW|EK)-(B?\d{1,2}S\d{1,3}E|\d{1,2}S\d{1,3}A)/i;

/** Listen before the first request: a balancer that still streams is evidence (spec 11.2 step 2). */
const LISTEN_MS = 300;
/** Device info answer window per attempt, one retry (spec 11.2 steps 4, 5). */
const PROBE_ATTEMPT_MS = 1500;
/** Answer window of the xor8 device info request after both sum8 attempts (spec 11.2 step 6). */
const XOR_ATTEMPT_MS = 1000;
/** Send the cell info request once when no cell frame came within this time after start (spec 4.1 step 5). */
const FIRST_CELL_MS = 1000;
/** Silence before the cell info request is sent again (spec 4.2, 4.4). */
const SILENCE_MS = 3000;
/** Poll reports a problem after this long without a cell frame. */
const STALL_MS = 10000;
/**
 * Cell info requests in a row that each brought at most one frame before a settings request is
 * sent to restart the stream (spec 4.2).
 */
const WEAK_CELL_REQUESTS = 2;
/** Acknowledgement of a write (about 0.03 s on the device, spec 4.3 step 2). */
const ACK_TIMEOUT_MS = 1000;
/**
 * EK firmware pushes a settings frame after a write; wait this long before requesting one (spec
 * 4.3 step 3). The EK-B24S8E200A pushed it 0.39 s and 0.43 s after the first acknowledgement
 * ([HA#670] 2026-04-07 log), so 1 s leaves room for radio jitter: a request costs a beep.
 */
const SETTINGS_PUSH_MS = 1000;
const SETTINGS_TIMEOUT_MS = 1500;
/** At least this long between writes (spec 4.3 step 4). */
const WRITE_GAP_MS = 200;
/**
 * A settings frame younger than this is returned without a new request: the frame of the probe
 * serves the first settings screen and the frame after a write serves the read-back, so the
 * balancer does not beep for them (spec 4.2). Only the vendor app changes settings otherwise, and
 * it cannot be connected at the same time (spec 2.1).
 */
const SETTINGS_CACHE_MS = 10000;
/** Device info is requested again by readInfo() only when older than this. */
const INFO_REFRESH_MS = 60000;
/** Settings requests per connection while the variant is still provisional (each one may beep). */
const MAX_VARIANT_REQUESTS = 3;
const VARIANT_RETRY_MS = 10000;

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));
/** @param {number} at epoch ms */
const waitUntil = (at) => {
  const ms = at - Date.now();
  return ms > 0 ? sleep(ms) : Promise.resolve();
};
/** @param {number} v */
const z = (v) => (v === 0 ? 0 : v);
/** @param {number} v */
const h2 = (v) => `0x${v.toString(16).toUpperCase().padStart(2, '0')}`;

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

/**
 * Operation status texts (spec 9.1, [SY] OPERATION_STATUS). 0x07 keeps the neutral [SY] text:
 * the sources do not tell whether the pack or the supply voltage is meant.
 */
const STATUS_LABELS = /** @type {Record<number, string>} */ ({
  [STATUS.UNKNOWN]: msg('Unknown'),
  [STATUS.WRONG_CELL_COUNT]: msg('Wrong cell count'),
  [STATUS.WIRE_TEST]: msg('Testing the sense wire resistance'),
  [STATUS.WIRE_RESISTANCE_HIGH]: msg('Sense wire resistance too high'),
  [STATUS.SYSTEM_TEST_DONE]: msg('System test completed'),
  [STATUS.BALANCING]: msg('Balancing now'),
  [STATUS.BALANCING_FINISHED]: msg('Balancing finished'),
  [STATUS.LOW_VOLTAGE]: msg('Low voltage'),
  [STATUS.OVERTEMPERATURE]: msg('Balancer overtemperature'),
  [STATUS.HOST_FAILS]: msg('Host failure'),
  [STATUS.BATTERY_LOW]: msg('Cells below the sleep voltage, balancing stopped'),
  [STATUS.TEMPERATURE_HIGH]: msg('Temperature too high, balancing stopped'),
  [STATUS.SELF_TEST_DONE]: msg('Self-test completed'),
});

/**
 * Text of an operation status, "Off" while the balancer switch is off, the raw code ("0x0D") for
 * a status without a text (spec 9.1).
 * @param {number} status
 * @param {boolean | undefined} switchOn
 */
export function balancerStateText(status, switchOn) {
  if (switchOn === false) return msg('Off');
  return STATUS_LABELS[status] ?? h2(status);
}

// ---------------------------------------------------------------------------------------------
// Alarms (spec 9)
// ---------------------------------------------------------------------------------------------

const LABEL_LOW_VOLTAGE = msg('Low voltage');
const LABEL_OVERTEMPERATURE = msg('Balancer overtemperature');
const LABEL_POLARITY = msg('Cell connected with reversed polarity');
const LABEL_CHARGE_FAULT = msg('Charging fault');
const LABEL_DISCHARGE_FAULT = msg('Discharging fault');

/**
 * Collects alarms, one per id: a second report of the same id joins the sources and keeps the
 * more severe level.
 */
class AlarmList {
  constructor() {
    /** @type {Map<string, AlarmState>} */
    this.byId = new Map();
  }

  /**
   * @param {string} id
   * @param {Partial<AlarmState>} [extra]
   */
  add(id, extra = {}) {
    const a = alarm(id, extra);
    const old = this.byId.get(id);
    if (!old) {
      this.byId.set(id, a);
      return;
    }
    const sev = /** @type {Record<string, number>} */ (SEVERITY_ORDER);
    if ((sev[a.severity ?? 'warning'] ?? 9) < (sev[old.severity ?? 'warning'] ?? 9)) old.severity = a.severity;
    if (a.source) old.source = old.source ? `${old.source}; ${a.source}` : a.source;
  }

  list() {
    return [...this.byId.values()];
  }
}

/** 1-based cell numbers of a mask. @param {number} mask */
const cellNumbers = (mask) => {
  const out = [];
  for (let i = 0; i < MAX_CELLS; i++) if ((mask >>> i) & 1) out.push(i + 1);
  return out;
};

/**
 * Alarms of the operation status (spec 9.1).
 * @param {AlarmList} out
 * @param {number} status
 */
function statusAlarms(out, status) {
  const source = `status ${h2(status)}`;
  if (status === STATUS.WRONG_CELL_COUNT) out.add('cell_count_mismatch', { source });
  if (status === STATUS.WIRE_RESISTANCE_HIGH) out.add('wire_resistance', { source });
  // [SY] "Low voltage": pack or supply voltage, the sources do not tell ([AIO]: pack
  // undervoltage; [DS]: the balancer needs more than 30 V or an external supply). Unverified, spec 9.1.
  if (status === STATUS.LOW_VOLTAGE) out.add('neey.low_voltage', { label: LABEL_LOW_VOLTAGE, severity: 'warning', source });
  if (status === STATUS.OVERTEMPERATURE) out.add('neey.system_overtemperature', { label: LABEL_OVERTEMPERATURE, severity: 'protection', source });
  if (status === STATUS.HOST_FAILS) out.add('communication_fault', { source });
  if (status === STATUS.TEMPERATURE_HIGH) out.add('neey.system_overtemperature', { label: LABEL_OVERTEMPERATURE, severity: 'warning', source });
}

/** Mask of the first `n` cells. @param {number} n */
const firstCells = (n) => (n >= MAX_CELLS ? 0xffffff : n > 0 ? (1 << n) - 1 : 0);

/**
 * Alarms of the bitmask block (spec 9.2, 9.3). The detection-failed mask is limited to the
 * configured cell count: unused slots read as "detection failed" on several units (0xFF0000 with
 * 16 cells). The other cell masks cover every displayed cell, so a cell wired beyond the
 * configured count still raises its alarm.
 *
 * Severities: NEEY_V1 units are balancers without MOSFETs, so cell over- and undervoltage and the
 * charging and discharging fault bytes are warnings. The EK-B24S8E200A (NEEY_V2) is a 200 A BMS
 * with protection settings, so there the cell voltage bits keep the catalog severity and the
 * fault bytes are protections. The meaning of these bits on V2 is unverified in both directions
 * (spec 9.2, 9.3); the higher level avoids under-reporting a protection.
 * @param {AlarmList} out
 * @param {Record<string, any>} c parsed cell info with a known variant
 * @param {{ configured: number, shown: number }} counts configured cells, displayed cells
 */
function maskAlarms(out, c, { configured, shown }) {
  const v2 = c.variant === VARIANT.V2;
  /**
   * @param {number} mask
   * @param {number} limit
   * @param {string} id
   * @param {Partial<AlarmState>} [extra]
   */
  const cells = (mask, limit, id, extra = {}) => {
    const m = (mask ?? 0) & limit;
    if (m) out.add(id, { ...extra, source: `cells ${cellNumbers(m).join(', ')}` });
  };
  const all = firstCells(shown);
  cells(c.cellDetectionFailedMask, firstCells(configured), 'cell_wire_open');
  const cellSeverity = v2 ? {} : { severity: /** @type {const} */ ('warning') };
  cells(c.cellOvervoltageMask, all, 'cell_overvoltage', cellSeverity);
  cells(c.cellUndervoltageMask, all, 'cell_undervoltage', cellSeverity);
  cells(c.cellPolarityErrorMask, all, 'neey.cell_polarity', { label: LABEL_POLARITY, severity: 'fault' });
  cells(c.cellWireResistanceMask, all, 'wire_resistance');
  const t = c.temperatureWarningMask ?? 0;
  if (t) {
    const sensors = [0, 1, 2, 3, 4, 5, 6, 7].filter((b) => (t >>> b) & 1).map((b) => b + 1);
    out.add('neey.system_overtemperature', { label: LABEL_OVERTEMPERATURE, severity: 'warning', source: `sensors ${sensors.join(', ')}` });
  }
  // Meaning unverified on both variants (spec 9.3).
  const faultSeverity = v2 ? 'protection' : 'warning';
  if (c.chargingFault) out.add('neey.charge_fault', { label: LABEL_CHARGE_FAULT, severity: faultSeverity, source: 'charging fault byte' });
  if (c.dischargingFault) out.add('neey.discharge_fault', { label: LABEL_DISCHARGE_FAULT, severity: faultSeverity, source: 'discharging fault byte' });
}

// ---------------------------------------------------------------------------------------------
// Snapshot mapping
// ---------------------------------------------------------------------------------------------

/**
 * Per cell balancing flags. The protocol has none: the balance current is signed (negative while
 * the highest cell is discharged into the supercapacitor, positive while the lowest cell is
 * charged, spec 6.4) and the frame names the highest and lowest cell, so the flag follows those
 * indexes; an index outside the cell list falls back to the extreme of the voltages.
 * @param {number[]} cells
 * @param {{ active: boolean, current: number, minIndex?: number, maxIndex?: number }} state
 */
export function balancingFlags(cells, { active, current, minIndex, maxIndex }) {
  const flags = cells.map(() => false);
  if (!active || !cells.length || !current) return flags;
  /** @param {number | undefined} i @param {(a: number, b: number) => boolean} better */
  const pick = (i, better) => {
    if (Number.isInteger(i) && /** @type {number} */ (i) >= 0 && /** @type {number} */ (i) < cells.length) return /** @type {number} */ (i);
    let best = 0;
    cells.forEach((v, k) => {
      if (better(v, cells[best])) best = k;
    });
    return best;
  };
  if (current > 0) flags[pick(minIndex, (a, b) => a < b)] = true;
  else flags[pick(maxIndex, (a, b) => a > b)] = true;
  return flags;
}

/**
 * @param {string} id
 * @param {string} label
 * @param {number} value
 * @param {TemperatureReading['kind']} kind
 * @returns {TemperatureReading | null}
 */
function temperature(id, label, value, kind) {
  if (!Number.isFinite(value) || value < -60 || value > 200) return null;
  return { id, label, value: z(r(value, 1)), kind };
}

/**
 * Unified snapshot of a cell info frame (spec 6.4, 6.5, 9). Without a variant (`c.variant`
 * undefined) only the shared part is mapped: cells, lead resistances, total voltage and the
 * operation status (spec 1.3). Cells: the configured count of the settings frame or the slots up
 * to the last non-zero voltage, whichever is higher. An unwired configured slot shows 0 V, and a
 * cell wired beyond the configured count (status 0x01, "wrong cell count") stays visible.
 * @param {Record<string, any>} c parsed cell info (parseCellInfo)
 * @param {{ settings?: Record<string, any> | null }} [opts] parsed settings frame
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function neeySnapshot(c, { settings = null } = {}) {
  const value = Number(settings?.cellCount);
  const configured = Number.isInteger(value) && value >= 1 && value <= MAX_CELLS ? value : c.cellCount;
  const count = Math.max(configured, c.cellCount);
  const cells = /** @type {number[]} */ (c.cellSlots).slice(0, count).map((v) => z(r(v, 4)));
  // Lead resistance in ohm on the wire, milliohm in the model (spec 6.4, 12 item 17).
  const cellResistances = /** @type {number[]} */ (c.resistanceSlots).slice(0, count).map((v) => z(r(v * 1000, 2)));
  const status = c.operationStatus;
  const active = status === STATUS.BALANCING;
  const switchOn = settings ? !!settings.balancerSwitch : undefined;
  const alarms = new AlarmList();
  statusAlarms(alarms, status);
  /** @type {Record<string, ExtraValue>} */
  const extra = { balancer: { label: msg('Balancer state'), value: balancerStateText(status, switchOn) } };
  /** @type {Omit<BmsSnapshot, 'timestamp'>} */
  const s = { voltage: r(c.totalVoltage, 3), cells, cellResistances, balancingActive: active };
  if (switchOn !== undefined) s.switches = { balance: switchOn };
  if (c.variant === VARIANT.V1 || c.variant === VARIANT.V2) {
    const current = z(r(c.balanceCurrent, 3));
    s.balanceCurrent = current;
    s.balancing = balancingFlags(cells, { active, current, minIndex: c.cellVoltageMinIndex, maxIndex: c.cellVoltageMaxIndex });
    s.uptime = c.uptime;
    maskAlarms(alarms, c, { configured, shown: count });
    /** @type {Array<TemperatureReading | null>} */
    let temps;
    if (c.variant === VARIANT.V2) {
      // Labels of the four sensors from [SY] only (unverified, spec 6.5).
      temps = [
        temperature('t1', msg('Temperature 1'), c.temperature1, 'cell'),
        temperature('t2', msg('Temperature 2'), c.temperature2, 'cell'),
        temperature('mos', msg('MOSFET temperature'), c.temperatureMos, 'mos'),
        temperature('balancer', msg('Balancer temperature'), c.temperatureBalancer, 'balancer'),
      ];
      s.current = z(r(c.current, 2));
      s.soc = r(c.soc, 1);
      s.capacityRemaining = r(c.capacityRemaining, 2);
      s.capacityNominal = r(c.nominalCapacity, 1);
    } else {
      // Sensors on the balancer board ([SY] "Temperature 1", spec 6.4).
      temps = [temperature('t1', msg('Temperature 1'), c.temperature1, 'balancer'), temperature('t2', msg('Temperature 2'), c.temperature2, 'balancer')];
    }
    s.temperatures = /** @type {TemperatureReading[]} */ (temps.filter(Boolean));
  }
  s.alarms = alarms.list();
  if (settings) {
    /** @param {string} key @param {string} label @param {number} decimals @param {string} [unit] */
    const put = (key, label, decimals, unit) => {
      const v = Number(settings[key]);
      if (Number.isFinite(v) && v !== 0) extra[key] = compact({ label, value: r(v, decimals + 1), unit, decimals });
    };
    put('balanceTriggerVoltage', msg('Balance trigger voltage difference'), 3, 'V');
    put('maxBalanceCurrent', msg('Maximum balance current'), 1, 'A');
    if (settings.variant === VARIANT.V1) {
      put('balanceStartVoltage', msg('Balance start voltage'), 2, 'V');
      put('balanceStopVoltage', msg('Sleep voltage'), 2, 'V');
    }
    put('cellCount', msg('Cell count'), 0);
  }
  s.extra = extra;
  return compact(s);
}

// ---------------------------------------------------------------------------------------------
// Device info (spec 10)
// ---------------------------------------------------------------------------------------------

/**
 * Device information (spec 10). `protocol` is the variant id plus the protocol version string of
 * the frame, for example "NEEY_V1 (V1.0.0)".
 * @param {Record<string, any>} d parsed device info (parseDeviceInfo)
 * @param {{ variant?: string }} [opts]
 * @returns {DeviceInfo}
 */
export function neeyDeviceInfo(d, { variant } = {}) {
  /** @type {Record<string, ExtraValue>} */
  const extra = {};
  if (d.protocolVersion) extra.protocolVersion = { label: msg('Protocol version'), value: d.protocolVersion };
  if (Number.isFinite(d.totalRuntime)) extra.totalRuntime = { label: msg('Total runtime'), value: r(d.totalRuntime / 3600, 1), unit: 'h', decimals: 1 };
  extra.rating = { label: msg('Rated balance current'), value: balancerRating(d.model), unit: 'A', decimals: 0 };
  const identifier = String(d.identifier ?? '');
  return compact({
    vendor: NEEY_VENDOR,
    model: d.model || undefined,
    // Advertised name of the EK-B24S8E200A; zero on every NEEY_V1 frame (unverified, spec 6.1).
    name: d.modelAlias || undefined,
    hardwareVersion: d.hardwareVersion || undefined,
    softwareVersion: d.softwareVersion || undefined,
    // BLE address digits plus "123456" (meaning unknown); all zero on older firmware (spec 6.1).
    serialNumber: /[1-9A-Za-z]/.test(identifier) ? identifier : undefined,
    manufactureDate: formatDate(d.manufacturingDate),
    powerOnCount: Number.isFinite(d.powerOnCount) ? d.powerOnCount : undefined,
    protocol: variant ? `${variant}${d.protocolVersion ? ` (${d.protocolVersion})` : ''}` : d.protocolVersion || undefined,
    extra,
  });
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

export class NeeyBleDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    /** True once a settings frame told the variant (spec 1.3); until then cell frames are decoded up to offset 216 only. */
    this.variantConfirmed = false;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: createAnswerAssembler,
      describe: (f) => describe(f, this.variantConfirmed ? this.variant : undefined),
      log: ctx.log,
    });
    /** @type {Record<string, any> | null} */
    this.device = null;
    this.deviceAt = 0;
    /** @type {Record<string, any> | null} */
    this.settings = null;
    this.settingsAt = 0;
    this.settingsFrames = 0;
    /** @type {Uint8Array | null} */
    this.cellFrame = null;
    this.cellAt = 0;
    this.cellFrames = 0;
    /**
     * Request checksum form: sum8, or xor8 once a unit answered only the old app's form (spec 3.4).
     * @type {import('./protocol.js').Checksum}
     */
    this.checksum = 'sum8';
    this.started = false;
    this.startedAt = 0;
    this.cellRequestAt = 0;
    /** Cell frames counted when the last cell info request was sent. */
    this.cellFramesAtRequest = 0;
    /** Cell info requests in a row that brought at most one frame each (spec 4.2). */
    this.weakCellRequests = 0;
    /** The settings request that restarts a stalled stream was sent for the current stall. */
    this.stallSettingsSent = false;
    this.settingsRequests = 0;
    this.settingsRequestAt = 0;
    this.lastWriteAt = 0;
    /** @type {{ key: string, schema: SettingsSchema } | null} */
    this.schemaCache = null;
    this.offFrame = this.channel.on('frame', (/** @type {Uint8Array} */ f) => this.#onFrame(f));
    this.channel.start();
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // Streaming device: poll() only watches the stream and restarts it.
    return { settings: true, writeSettings: true, streaming: true, pollIntervalMs: 1000, minPollIntervalMs: 500 };
  }

  /** Variant used for decoding cell frames, undefined until a settings frame confirmed it. */
  get decodeVariant() {
    return this.variantConfirmed ? this.variant : undefined;
  }

  /** @param {Uint8Array} f */
  #onFrame(f) {
    if (isCellInfoFrame(f)) {
      this.cellFrame = f;
      this.cellAt = Date.now();
      this.cellFrames++;
      if (this.started) this.#publishCell();
    } else if (isSettingsFrame(f)) {
      this.#onSettings(f);
    } else if (isDeviceInfoFrame(f)) {
      // Unsolicited or answered: keep it only when it identifies a balancer.
      if (!deviceInfoProblem(f)) {
        this.device = parseDeviceInfo(f);
        this.deviceAt = Date.now();
      }
    }
  }

  /**
   * Settings frames arrive after the settings request, after writes and sometimes unrequested
   * (spec 4.2); the length tells the variant (spec 1.3).
   * @param {Uint8Array} f
   */
  #onSettings(f) {
    const variant = settingsVariant(f);
    const changed = !this.variantConfirmed || this.variant !== variant;
    this.settings = parseSettings(f);
    this.settingsAt = Date.now();
    this.settingsFrames++;
    this.variantConfirmed = true;
    if (changed) {
      this.setVariant(variant);
      if (this.device) this.publishInfo(this.#info());
    }
    this.emit('settings', this.settings);
  }

  #publishCell() {
    if (!this.cellFrame) return;
    const c = parseCellInfo(this.cellFrame, this.decodeVariant);
    // The settings frame belongs to the same variant once confirmed; a provisional decode ignores it.
    this.publish(neeySnapshot(c, { settings: this.variantConfirmed ? this.settings : null }));
  }

  #info() {
    return neeyDeviceInfo(this.device ?? {}, { variant: this.variant });
  }

  /**
   * Settings request; the answer is handled by #onFrame. Only call inside `channel.exclusive`.
   * @param {number} timeout
   */
  async #requestSettings(timeout) {
    const req = settingsRequest(this.checksum);
    const d = describe(req);
    this.settingsRequests++;
    this.settingsRequestAt = Date.now();
    return this.channel.requestUnqueued(req, { match: isSettingsFrame, timeout, name: d?.name, decode: d?.decode });
  }

  /**
   * Read only probe (spec 11.2): listen 0.3 s, then the device info request (one retry), then
   * once its xor8 form of the old app (GW SW-1.1.0, spec 3.4); accepted when the 100-byte answer
   * carries a printable model and either a hardware version "HW-..." or a "GW-" / "EK-" model.
   * Foreign devices fail the `55 AA 11` envelope (spec 11.4) and the probe returns null. The
   * settings request that follows decides the variant (spec 11.5) and starts the cell info stream.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = 2500 } = {}) {
    await sleep(LISTEN_MS);
    if (this.cellFrame) this.log?.event('NEEY: cell info frames are streaming already', { source: this.definition.id });
    const attempt = Math.round(Math.max(500, Math.min(PROBE_ATTEMPT_MS, timeout * 0.6)));
    /** @type {Uint8Array | null} */
    let frame = null;
    for (const [checksum, window, retries] of /** @type {Array<[import('./protocol.js').Checksum, number, number]>} */ ([
      ['sum8', attempt, 1],
      ['xor8', Math.min(attempt, XOR_ATTEMPT_MS), 0],
    ])) {
      const req = deviceInfoRequest(checksum);
      const di = describe(req);
      try {
        frame = await this.channel.request(req, { match: isDeviceInfoFrame, timeout: window, retries, name: di?.name, decode: di?.decode });
        this.checksum = checksum;
        break;
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'TIMEOUT') {
          this.log?.warn(`NEEY probe: ${errorText(err)}`);
          return null;
        }
      }
    }
    if (!frame) return null;
    if (this.checksum === 'xor8') this.log?.event('NEEY: the balancer answers only the xor8 requests of the old app, as GW SW-1.1.0 did (spec 3.4)', { source: this.definition.id });
    const problem = deviceInfoProblem(frame);
    if (problem) {
      this.log?.event(`NEEY: device info frame rejected, ${problem}`, { source: this.definition.id });
      return null;
    }
    this.device = parseDeviceInfo(frame);
    this.deviceAt = Date.now();
    const model = this.device.model;
    try {
      await this.channel.exclusive(() => this.#requestSettings(attempt));
    } catch (err) {
      this.log?.warn(`NEEY: no settings frame (${errorText(err)}), the variant is provisional`);
    }
    if (!this.variantConfirmed) {
      // A variant preset by a reconnect is kept, otherwise the model is the hint (spec 11.2 step 7).
      this.setVariant(this.variant ?? variantFromModel(model));
    }
    const variant = /** @type {string} */ (this.variant);
    const info = this.publishInfo(this.#info());
    this.log?.event(
      `NEEY ${model || '?'}, hardware ${this.device.hardwareVersion || '?'}, software ${this.device.softwareVersion || '?'}: ${variant}${this.variantConfirmed ? '' : ' (provisional)'}`,
      { source: this.definition.id },
    );
    return { variant, confidence: this.variantConfirmed ? 1 : 0.9, info };
  }

  async start() {
    this.started = true;
    this.startedAt = Date.now();
    if (this.cellFrame) this.#publishCell();
  }

  /**
   * Watch the stream (spec 4.2): send the cell info request once when no frame came within 1 s
   * after start, then whenever no frame came for 3 s. An answer to that request is documented, a
   * restart of the stream is not: when two cell info requests in a row brought at most one frame
   * each, the next silence gets one settings request instead (the documented stream starter, one
   * beep), once per stall. Settings are also requested while the variant is provisional (a few
   * times per connection) and never polled otherwise.
   */
  async poll() {
    if (!this.started) return;
    const now = Date.now();
    const last = Math.max(this.cellAt, this.startedAt);
    const threshold = this.cellFrames ? SILENCE_MS : FIRST_CELL_MS;
    if (now - last >= threshold && now - this.cellRequestAt >= SILENCE_MS) {
      if (this.cellRequestAt) {
        if (this.cellFrames - this.cellFramesAtRequest <= 1) this.weakCellRequests++;
        else {
          // The stream ran between the requests: a new stall starts here.
          this.weakCellRequests = 0;
          this.stallSettingsSent = false;
        }
      }
      this.cellRequestAt = now;
      this.cellFramesAtRequest = this.cellFrames;
      if (this.weakCellRequests >= WEAK_CELL_REQUESTS && !this.stallSettingsSent) {
        this.stallSettingsSent = true;
        this.log?.event('NEEY: the cell info request did not restart the stream, requesting the settings once', { source: this.definition.id });
        await this.channel.exclusive(() => this.#requestSettings(SETTINGS_TIMEOUT_MS)).catch((err) => this.log?.warn(`NEEY settings request for the stream: ${errorText(err)}`));
      } else {
        const req = cellInfoRequest(this.checksum);
        const d = describe(req);
        await this.channel.send(req, { name: d?.name, decode: d?.decode });
      }
    }
    if (!this.variantConfirmed && this.settingsRequests < MAX_VARIANT_REQUESTS && now - this.settingsRequestAt >= VARIANT_RETRY_MS) {
      await this.channel.exclusive(() => this.#requestSettings(SETTINGS_TIMEOUT_MS)).catch(() => {});
    }
    if (now - last > STALL_MS) throw new Error(msg('No data from the balancer for several seconds'));
  }

  async stop() {
    this.started = false;
  }

  async readInfo() {
    if (!this.device || Date.now() - this.deviceAt > INFO_REFRESH_MS) {
      const req = deviceInfoRequest(this.checksum);
      const d = describe(req);
      try {
        await this.channel.request(req, { match: isDeviceInfoFrame, timeout: PROBE_ATTEMPT_MS, name: d?.name, decode: d?.decode });
      } catch (err) {
        if (!this.device) throw err;
        this.log?.warn(`NEEY device info: ${errorText(err)}`);
      }
    }
    return this.publishInfo(this.#info());
  }

  getSettingsSchema() {
    const variant = this.variant ?? VARIANT.V1;
    const s = this.variantConfirmed && this.settings?.variant === variant ? this.settings : null;
    const rating = balancerRating(this.device?.model);
    const softwareVersion = this.device?.softwareVersion ?? '';
    const key = [variant, rating, softwareVersion, s ? `${s.balanceStartVoltage}|${s.byte32}|${s.balanceStopDiffVoltage}|${s.maxBalanceCurrent}` : '-'].join('|');
    if (this.schemaCache?.key !== key) this.schemaCache = { key, schema: buildNeeySchema({ variant, settings: s, softwareVersion, rating }) };
    return this.schemaCache.schema;
  }

  /**
   * Settings values. A cached frame is served only while it is younger than SETTINGS_CACHE_MS and
   * newer than the last write: writeSetting() clears `settingsAt` when no settings frame arrived
   * after a write, so a failed request then throws and the session reports a read-back error
   * instead of comparing against the values from before the write.
   */
  async readSettings() {
    if (!this.settings || !this.variantConfirmed || !this.settingsAt || Date.now() - this.settingsAt > SETTINGS_CACHE_MS) {
      await this.channel.exclusive(() => this.#requestSettings(SETTINGS_TIMEOUT_MS));
    }
    return decodeNeeySettings(this.getSettingsSchema(), this.settings);
  }

  /**
   * Write one setting (spec 4.3): the write request, its acknowledgement (which does not prove the
   * value was applied: GW SW-1.1.0 does not even echo it, spec 6.7), then a fresh settings frame,
   * pushed by EK firmware within SETTINGS_PUSH_MS or requested, for the read-back of the session.
   * Without such a frame the cached one is marked stale, so readSettings() never serves the values
   * from before the write.
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const known = fieldMap(this.getSettingsSchema()).get(id);
    if (!known || known.type === 'action') throw new Error(msg('Unknown setting'));
    if (known.readOnly || !known.meta?.write) throw new Error(msg('This value is read only'));
    if (!this.variantConfirmed) {
      // The registers differ between the layouts (spec 1.2, 5.3): never write on a provisional variant.
      await this.channel.exclusive(() => this.#requestSettings(SETTINGS_TIMEOUT_MS)).catch(() => {});
      if (!this.variantConfirmed) throw new Error(msg('The balancer did not send its settings, so its protocol variant is unknown and nothing is written.'));
    }
    const f = fieldMap(this.getSettingsSchema()).get(id);
    if (!f || f.type === 'action') throw new Error(msg('Unknown setting'));
    const bytes = encodeSettingWrite(f, value, { checksum: this.checksum });
    const w = f.meta.write;
    const d = describe(bytes);
    await this.channel.exclusive(async () => {
      await waitUntil(this.lastWriteAt + WRITE_GAP_MS);
      const before = this.settingsFrames;
      try {
        const ack = await this.channel.requestUnqueued(bytes, { match: isAckFor(w.command, w.register), timeout: ACK_TIMEOUT_MS, name: d?.name, decode: d?.decode });
        const echo = parseShortAnswer(ack).rawValue;
        this.log?.event(`NEEY: write acknowledged, register ${h2(w.register)}, value bytes ${echo}`, { source: this.definition.id });
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'TIMEOUT') throw err;
        this.log?.warn('NEEY: no acknowledgement for the write; the settings frame shows whether it was applied');
      } finally {
        this.lastWriteAt = Date.now();
      }
      if (this.settingsFrames === before) {
        try {
          await this.channel.waitFor(isSettingsFrame, SETTINGS_PUSH_MS);
        } catch {
          /* not pushed (GW SW-1.1.0): requested below */
        }
      }
      if (this.settingsFrames === before) {
        try {
          await this.#requestSettings(SETTINGS_TIMEOUT_MS);
        } catch (err) {
          this.log?.warn(`NEEY: settings after the write: ${errorText(err)}`);
        }
      }
      // Still no frame after the write: the cached one holds the values from before it.
      if (this.settingsFrames === before) this.settingsAt = 0;
    });
  }

  dispose() {
    this.offFrame?.();
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------------------------

/**
 * GATT profile (spec 2.1): FFE1 for notifications and writes (properties 0x1C), written without
 * response as the vendor apps do, requests of exactly 20 bytes.
 */
const BLE_PROFILE = {
  id: 'neey-ffe0',
  label: 'FFE0/FFE1',
  service: 0xffe0,
  notify: 0xffe1,
  write: 0xffe1,
  writeMode: /** @type {const} */ ('without-response'),
  chunkSize: 20,
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const neeyBleDefinition = {
  id: 'neey-ble',
  family: 'neey',
  vendor: NEEY_VENDOR,
  protocol: msg('NEEY balancer (Bluetooth)'),
  deviceType: 'balancer',
  experimental: true,
  description: msg(
    'NEEY, Heltec and EnerKey active balancers over Bluetooth (GW-24S4EB, EK-24S4EB, EK-16S2EB, EK-24S10EB, EK-B24S8E200A): cell voltages, lead resistances, balance current, alarms and balancer settings. If the balancer is not listed, show all devices.',
  ),
  links: {
    ble: {
      profiles: [BLE_PROFILE],
      namePrefixes: [...NAME_PREFIXES],
      namePatterns: [NAME_PATTERN],
      // Renamed units ("neey", "GW-2BMS", "Backup BMS") and advertisements without a name exist
      // (spec 11.1): the FFE0 service filter keeps them in the chooser, as for `jk-balancer-ble`.
      // FEE7, the "88 A0" manufacturer data and the company ids are module traits shared with
      // JK, ANT and Atorch devices, so they are not filters (spec 2.1).
      advertisedServices: [0xffe0],
    },
  },
  create: (ctx) => new NeeyBleDriver(neeyBleDefinition, ctx),
  demo: { name: 'EK-24S4EB balancer (demo)', chunkSize: 20, create: (link) => createNeeySimulator(link) },
};
