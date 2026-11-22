import { SETTINGS, buildSchema, field, msg, relation } from '@ubms/bms-core';
import { BYTE_PARAMS, EVENT_BITS, INT_PARAMS } from './protocol-v2.js';
import { SFA_BITS, SPA_REGISTERS } from './protocol-v3.js';

/**
 * Settings schemas of the Seplos drivers (docs/protocols/seplos.md section 7):
 *
 * - V2 (ASCII and Bluetooth): the 169 byte parameter block of 0x47, written back whole with 0xA1
 *   (spec 7.1, 7.2, 7.5). Every parameter and function switch except the Bluetooth switch.
 * - V3: SPA registers (function 0x10, two register writes), SFA coils (function 0x0F, whole
 *   bytes), the SCA MOSFET commands and two actions (spec 7.3, 7.4, 7.5, 8.3).
 *
 * Values are engineering units. Discharge currents are stored negative and shown as magnitudes
 * (`meta.negate`), temperatures are 0.1 K with 2731 on the wire and degrees C here.
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

/** Driver group for the function switch bits (spec 7.6). */
export const FUNCTIONS_GROUP = 'seplos.functions';

const EXTRA_GROUPS = {
  [FUNCTIONS_GROUP]: {
    label: msg('Function switches'),
    icon: 'sliders',
    description: msg('Alarms, protections and functions the BMS has switched on'),
  },
};

/**
 * Labels, groups and units of the driver specific ids, and unit overrides of canonical ids
 * (spec 7.1, 7.3).
 * @type {Record<string, { label?: string, group?: string, unit?: string, decimals?: number, description?: string, advanced?: boolean }>}
 */
const INFO = {
  // Cell voltage
  'seplos.cell_ov_alarm_recovery': { label: msg('Cell high voltage alarm recovery'), group: 'cell_voltage', unit: 'V' },
  'seplos.cell_uv_alarm_recovery': { label: msg('Cell low voltage alarm recovery'), group: 'cell_voltage', unit: 'V' },
  'seplos.low_voltage_charge_forbid': {
    label: msg('Charging prohibited below cell voltage'),
    group: 'cell_voltage',
    description: msg('Below this cell voltage the BMS does not allow charging.'),
  },
  'seplos.cell_uv_failure': { label: msg('Cell undervoltage failure'), group: 'cell_voltage', unit: 'V' },
  'seplos.cell_diff_protection_recovery': { label: msg('Cell voltage difference protection recovery'), group: 'cell_voltage', unit: 'V' },
  'seplos.cell_diff_alarm_recovery': { label: msg('Cell voltage difference alarm recovery'), group: 'cell_voltage', unit: 'V' },
  'seplos.float_lock_voltage': { label: msg('Float charge lock voltage'), group: 'charging', unit: 'V' },
  'seplos.float_release_voltage': { label: msg('Float charge release voltage'), group: 'charging', unit: 'V' },
  'seplos.float_lock_current': { label: msg('Float charge lock current'), group: 'charging', unit: 'A', decimals: 3 },
  // Pack voltage
  'seplos.pack_ov_alarm_recovery': { label: msg('Pack high voltage alarm recovery'), group: 'pack_voltage', unit: 'V' },
  'seplos.pack_uv_alarm_recovery': { label: msg('Pack low voltage alarm recovery'), group: 'pack_voltage', unit: 'V' },
  'seplos.charge_ovp': {
    label: msg('Charging overvoltage protection'),
    group: 'charging',
    unit: 'V',
    decimals: 2,
    description: msg('Pack voltage on the charger side at which the BMS stops charging.'),
  },
  'seplos.charge_ovp_recovery': { label: msg('Charging overvoltage recovery'), group: 'charging', unit: 'V', decimals: 2 },
  'seplos.charge_request_voltage': {
    label: msg('Charge request voltage (pack)'),
    group: 'charging',
    unit: 'V',
    decimals: 2,
    description: msg('Charge voltage the BMS asks the inverter for.'),
  },
  'seplos.charge_request_current': { label: msg('Charge request current'), group: 'charging', unit: 'A', decimals: 0 },
  'seplos.discharge_request_current': { label: msg('Discharge request current'), group: 'charging', unit: 'A', decimals: 0 },
  'seplos.charge_limit_delay': { label: msg('Charge current limit delay'), group: 'charging', unit: 'min', decimals: 0 },
  'seplos.charge_limit_duration': { label: msg('Charge current limit duration'), group: 'charging', unit: 's', decimals: 1 },
  'seplos.charge_activation_delay': { label: msg('Charge activation delay'), group: 'charging', unit: 'min', decimals: 0, advanced: true },
  'seplos.charge_activation_interval': { label: msg('Charge activation interval'), group: 'charging', unit: 'h', decimals: 0, advanced: true },
  'seplos.charge_activation_count': { label: msg('Number of charge activations'), group: 'charging', decimals: 0, advanced: true },
  'seplos.top_up_soc': {
    label: msg('Top-up charge SOC'),
    group: 'charging',
    unit: '%',
    description: msg('Below this state of charge an idle pack starts an intermittent top-up charge.'),
  },
  // Temperature
  'seplos.charge_ot_alarm': { label: msg('Charge high temperature alarm'), group: 'temperature' },
  'seplos.charge_ot_alarm_recovery': { label: msg('Charge high temperature alarm recovery'), group: 'temperature' },
  'seplos.charge_ut_alarm': { label: msg('Charge low temperature alarm'), group: 'temperature' },
  'seplos.charge_ut_alarm_recovery': { label: msg('Charge low temperature alarm recovery'), group: 'temperature' },
  'seplos.discharge_ot_alarm': { label: msg('Discharge high temperature alarm'), group: 'temperature' },
  'seplos.discharge_ot_alarm_recovery': { label: msg('Discharge high temperature alarm recovery'), group: 'temperature' },
  'seplos.discharge_ut_alarm': { label: msg('Discharge low temperature alarm'), group: 'temperature' },
  'seplos.discharge_ut_alarm_recovery': { label: msg('Discharge low temperature alarm recovery'), group: 'temperature' },
  'seplos.ambient_ot_alarm': { label: msg('Ambient high temperature alarm'), group: 'temperature' },
  'seplos.ambient_ot_alarm_recovery': { label: msg('Ambient high temperature alarm recovery'), group: 'temperature' },
  'seplos.ambient_ut_alarm': { label: msg('Ambient low temperature alarm'), group: 'temperature' },
  'seplos.ambient_ut_alarm_recovery': { label: msg('Ambient low temperature alarm recovery'), group: 'temperature' },
  'seplos.ambient_otp': { label: msg('Ambient overtemperature protection'), group: 'temperature' },
  'seplos.ambient_otp_recovery': { label: msg('Ambient overtemperature recovery'), group: 'temperature' },
  'seplos.ambient_utp': { label: msg('Ambient undertemperature protection'), group: 'temperature' },
  'seplos.ambient_utp_recovery': { label: msg('Ambient undertemperature recovery'), group: 'temperature' },
  'seplos.mos_ot_alarm': { label: msg('MOSFET high temperature alarm'), group: 'temperature' },
  'seplos.mos_ot_alarm_recovery': { label: msg('MOSFET high temperature alarm recovery'), group: 'temperature' },
  'seplos.heating_start': { label: msg('Heating start temperature'), group: 'temperature' },
  'seplos.heating_stop': { label: msg('Heating stop temperature'), group: 'temperature' },
  'seplos.balance_max_temp': { label: msg('Balancing disabled above'), group: 'balancing' },
  'seplos.balance_min_temp': { label: msg('Balancing disabled below'), group: 'balancing' },
  // Current
  'seplos.charge_oc_alarm_recovery': { label: msg('Charge overcurrent alarm recovery'), group: 'current', unit: 'A' },
  'seplos.discharge_oc_alarm_recovery': { label: msg('Discharge overcurrent alarm recovery'), group: 'current', unit: 'A' },
  'seplos.charge_oc_recovery': { label: msg('Charge overcurrent recovery current'), group: 'current', unit: 'A', decimals: 0 },
  'seplos.discharge_oc_recovery': { label: msg('Discharge overcurrent recovery current'), group: 'current', unit: 'A', decimals: 0 },
  'seplos.charge_ocp2': { label: msg('Charge overcurrent protection, level 2'), group: 'current', unit: 'A', decimals: 0 },
  'seplos.charge_ocp2_delay': { label: msg('Charge overcurrent delay, level 2'), group: 'current', unit: 'ms', decimals: 0 },
  'seplos.oc_recovery_delay': { label: msg('Overcurrent recovery delay'), group: 'current', unit: 's' },
  'seplos.oc_lockout_count': {
    label: msg('Overcurrent recovery attempts'),
    group: 'current',
    decimals: 0,
    description: msg('After this many overcurrent events the BMS locks the output until it is reset.'),
  },
  'seplos.pulse_limit_current': { label: msg('Pulse current limit current'), group: 'current', unit: 'A', decimals: 0, advanced: true },
  'seplos.pulse_limit_time': { label: msg('Pulse current limit time'), group: 'current', unit: 's', decimals: 1, advanced: true },
  'seplos.soft_start_delay': { label: msg('Output soft start delay'), group: 'current', unit: 'ms', decimals: 0, advanced: true },
  'seplos.precharge_ratio_short': { label: msg('Precharge completion ratio (short circuit)'), group: 'current', unit: '%', decimals: 1, advanced: true },
  'seplos.precharge_ratio_normal': { label: msg('Precharge completion ratio (normal)'), group: 'current', unit: '%', decimals: 1, advanced: true },
  'seplos.precharge_ratio_abnormal': { label: msg('Precharge completion ratio (abnormal)'), group: 'current', unit: '%', decimals: 1, advanced: true },
  'seplos.precharge_timeout': { label: msg('Precharge timeout'), group: 'current', unit: 's', decimals: 1, advanced: true },
  // Balancing
  'seplos.balance_stop_delta': { label: msg('Balance stop voltage difference'), group: 'balancing', unit: 'V', decimals: 3 },
  'seplos.static_balance_time': { label: msg('Static balancing time'), group: 'balancing', unit: 'h', decimals: 0 },
  // Capacity
  'seplos.full_capacity': { label: msg('Full charge capacity'), group: 'capacity', unit: 'Ah', decimals: 2 },
  'seplos.soc_low_protection': { label: msg('Low SOC protection'), group: 'capacity', unit: '%' },
  'seplos.soc_low_alarm_recovery': { label: msg('Low SOC alarm recovery'), group: 'capacity', unit: '%' },
  'seplos.soc_low_protection_recovery': { label: msg('Low SOC protection recovery'), group: 'capacity', unit: '%' },
  'seplos.cycle_capacity_ratio': {
    label: msg('Capacity counted as one cycle'),
    group: 'capacity',
    unit: '%',
    decimals: 0,
    description: msg('Share of the rated capacity that counts as one cycle. Meaning inferred from the name of the parameter (unverified).'),
  },
  // System
  'seplos.work_record_interval': { label: msg('Record interval while working'), group: 'system', unit: 'min', decimals: 0, advanced: true },
  'seplos.standby_record_interval': { label: msg('Record interval in standby'), group: 'system', unit: 'min', decimals: 0, advanced: true },
  'seplos.forced_output_delay': { label: msg('Forced output delay'), group: 'system', unit: 's', decimals: 1, advanced: true },
  'seplos.forced_output_interval': { label: msg('Forced output interval'), group: 'system', unit: 'min', decimals: 0, advanced: true },
  'seplos.forced_output_count': { label: msg('Forced output count'), group: 'system', decimals: 0, advanced: true },
  'seplos.inverter_protocol': { label: msg('Inverter protocol'), group: 'system', decimals: 0 },
  'seplos.current_correction': { label: msg('Current detector correction factor'), group: 'advanced', decimals: 0 },
  // Wire resistance
  'seplos.connection_fault_resistance': { label: msg('Connection fault resistance'), group: 'wire_resistance', unit: 'mΩ', decimals: 1 },
  'seplos.comp1_cell': { label: msg('Compensation point 1 (cell)'), group: 'wire_resistance', decimals: 0 },
  'seplos.comp1_resistance': { label: msg('Compensation point 1 resistance'), group: 'wire_resistance', unit: 'mΩ', decimals: 1 },
  'seplos.comp2_cell': { label: msg('Compensation point 2 (cell)'), group: 'wire_resistance', decimals: 0 },
  'seplos.comp2_resistance': { label: msg('Compensation point 2 resistance'), group: 'wire_resistance', unit: 'mΩ', decimals: 1 },
  // Canonical ids with Seplos units
  'system.sleep_delay': { unit: 'h', decimals: 0 },
  'charge.ocp_delay': { unit: 's' },
  'discharge.ocp_delay': { unit: 's' },
};

/** Ids in amps that hold a discharge value stored negative (spec 7.1 encoding rules, 7.3). */
const V2_NEGATIVE = new Set(['discharge.oc_alarm', 'seplos.discharge_oc_alarm_recovery', 'discharge.ocp', 'discharge.ocp2']);

/** Cell voltage thresholds (limits 1 to 5 V). */
const CELL_VOLTAGE = /^(cell\.(ovp|ovpr|uvp|uvpr|ov_alarm|uv_alarm)|balance\.start_voltage|seplos\.(cell_ov_alarm_recovery|cell_uv_alarm_recovery|low_voltage_charge_forbid|cell_uv_failure|float_lock_voltage|float_release_voltage))$/;
/** Cell voltage differences (limits 0 to 2 V). */
const CELL_DELTA = /^(cell\.diff_(alarm|protection)|balance\.trigger_delta|seplos\.(cell_diff_protection_recovery|cell_diff_alarm_recovery|balance_stop_delta))$/;

/**
 * Plausibility bound of every current threshold in A. Not a vendor limit: no source gives limits
 * (spec 7.1, 7.3). Boards are rated up to 300 A and 400 A ([XZH] V0.2; 400 A boards are not in
 * use yet per [XZH] "Notes from Seplos"), and the captured 200 A board holds 300 A for the short
 * circuit (`v3-rx-spa1-sg`). The raw range (32767 A) would let a typo switch the overcurrent and
 * short circuit protections off.
 */
const MAX_CURRENT_A = 1000;

/** Compensation points index the cells 1..16 (spec 7.1, 7.3); 0 as "off" is **unverified**. */
const COMP_CELL = /^seplos\.comp[12]_cell$/;

/**
 * Limits of a field: the raw range of its register, narrowed for temperatures, percentages,
 * voltages, currents and cell positions to values a BMS can use.
 * @param {string} id
 * @param {string | undefined} unit
 * @param {number} lo raw range in engineering units
 * @param {number} hi
 */
function limits(id, unit, lo, hi) {
  let min = lo;
  let max = hi;
  if (unit === '°C') [min, max] = [Math.max(lo, -40), Math.min(hi, 120)];
  else if (unit === '%') [min, max] = [Math.max(lo, 0), Math.min(hi, 100)];
  else if (CELL_VOLTAGE.test(id)) [min, max] = [Math.max(lo, 1), Math.min(hi, 5)];
  else if (CELL_DELTA.test(id)) [min, max] = [Math.max(lo, 0), Math.min(hi, 2)];
  else if (unit === 'V') [min, max] = [Math.max(lo, 0), Math.min(hi, 100)];
  else if (unit === 'A') [min, max] = [Math.max(lo, 0), Math.min(hi, MAX_CURRENT_A)];
  else if (COMP_CELL.test(id)) [min, max] = [Math.max(lo, 0), Math.min(hi, 16)];
  return { min, max };
}

/**
 * @param {string} id
 * @param {{ unit?: string, decimals: number, lo: number, hi: number }} raw
 * @param {Partial<SettingField>} overrides
 */
function numberField(id, raw, overrides) {
  const info = INFO[id] ?? {};
  const canonical = SETTINGS[id];
  const unit = info.unit ?? raw.unit ?? canonical?.unit;
  const decimals = info.decimals ?? raw.decimals;
  /** @type {Partial<SettingField>} */
  const extra = {};
  if (!canonical) {
    extra.label = info.label ?? id;
    extra.group = info.group ?? 'advanced';
  } else if (info.group) extra.group = info.group;
  if (info.description) extra.description = info.description;
  if (info.advanced) extra.advanced = true;
  return field(id, {
    type: 'number',
    ...extra,
    ...(unit ? { unit } : {}),
    decimals,
    step: 10 ** -decimals,
    ...limits(id, unit, raw.lo, raw.hi),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------
// Cross-field checks (spec 7.1 "Ranges", 7.7)
// ---------------------------------------------------------------------------------------------

/**
 * [recovery id, threshold id, recovery is 'below' or 'above' the threshold, threshold kind].
 * Both fields get a check, so an edit of either side is caught.
 * @type {Array<[string, string, 'below'|'above', 'protection'|'alarm']>}
 */
const RECOVERY_PAIRS = [
  ['cell.ovpr', 'cell.ovp', 'below', 'protection'],
  ['cell.uvpr', 'cell.uvp', 'above', 'protection'],
  ['seplos.cell_ov_alarm_recovery', 'cell.ov_alarm', 'below', 'alarm'],
  ['seplos.cell_uv_alarm_recovery', 'cell.uv_alarm', 'above', 'alarm'],
  ['pack.ovpr', 'pack.ovp', 'below', 'protection'],
  ['pack.uvpr', 'pack.uvp', 'above', 'protection'],
  ['seplos.pack_ov_alarm_recovery', 'pack.ov_alarm', 'below', 'alarm'],
  ['seplos.pack_uv_alarm_recovery', 'pack.uv_alarm', 'above', 'alarm'],
  ['seplos.charge_ovp_recovery', 'seplos.charge_ovp', 'below', 'protection'],
  ['seplos.cell_diff_protection_recovery', 'cell.diff_protection', 'below', 'protection'],
  ['seplos.cell_diff_alarm_recovery', 'cell.diff_alarm', 'below', 'alarm'],
  ['charge.otpr', 'charge.otp', 'below', 'protection'],
  ['charge.utpr', 'charge.utp', 'above', 'protection'],
  ['discharge.otpr', 'discharge.otp', 'below', 'protection'],
  ['discharge.utpr', 'discharge.utp', 'above', 'protection'],
  ['mos.otpr', 'mos.otp', 'below', 'protection'],
  ['seplos.charge_ot_alarm_recovery', 'seplos.charge_ot_alarm', 'below', 'alarm'],
  ['seplos.charge_ut_alarm_recovery', 'seplos.charge_ut_alarm', 'above', 'alarm'],
  ['seplos.discharge_ot_alarm_recovery', 'seplos.discharge_ot_alarm', 'below', 'alarm'],
  ['seplos.discharge_ut_alarm_recovery', 'seplos.discharge_ut_alarm', 'above', 'alarm'],
  ['seplos.ambient_ot_alarm_recovery', 'seplos.ambient_ot_alarm', 'below', 'alarm'],
  ['seplos.ambient_ut_alarm_recovery', 'seplos.ambient_ut_alarm', 'above', 'alarm'],
  ['seplos.ambient_otp_recovery', 'seplos.ambient_otp', 'below', 'protection'],
  ['seplos.ambient_utp_recovery', 'seplos.ambient_utp', 'above', 'protection'],
  ['seplos.mos_ot_alarm_recovery', 'seplos.mos_ot_alarm', 'below', 'alarm'],
  ['seplos.charge_oc_alarm_recovery', 'charge.oc_alarm', 'below', 'alarm'],
  ['seplos.discharge_oc_alarm_recovery', 'discharge.oc_alarm', 'below', 'alarm'],
  // V3 0x1315 and 0x131B: recovery current of the overcurrent alarm ([XZH] example 103 A below
  // the alarm of 105 A; captured 203 A below 205 A, `v3-rx-spa1-sg`).
  ['seplos.charge_oc_recovery', 'charge.oc_alarm', 'below', 'alarm'],
  ['seplos.discharge_oc_recovery', 'discharge.oc_alarm', 'below', 'alarm'],
  ['seplos.soc_low_alarm_recovery', 'soc.low_alarm', 'above', 'alarm'],
  ['seplos.soc_low_protection_recovery', 'seplos.soc_low_protection', 'above', 'protection'],
];

/**
 * [alarm id, protection id, the alarm is 'below' or 'above' the protection]: the alarm comes
 * before the protection (spec 7.1 "protection beyond alarm"). Every captured block and the
 * vendor examples follow it.
 * @type {Array<[string, string, 'below'|'above']>}
 */
const ALARM_PAIRS = [
  ['cell.ov_alarm', 'cell.ovp', 'below'],
  ['cell.uv_alarm', 'cell.uvp', 'above'],
  ['pack.ov_alarm', 'pack.ovp', 'below'],
  ['pack.uv_alarm', 'pack.uvp', 'above'],
  ['cell.diff_alarm', 'cell.diff_protection', 'below'],
  ['seplos.charge_ot_alarm', 'charge.otp', 'below'],
  ['seplos.charge_ut_alarm', 'charge.utp', 'above'],
  ['seplos.discharge_ot_alarm', 'discharge.otp', 'below'],
  ['seplos.discharge_ut_alarm', 'discharge.utp', 'above'],
  ['seplos.ambient_ot_alarm', 'seplos.ambient_otp', 'below'],
  ['seplos.ambient_ut_alarm', 'seplos.ambient_utp', 'above'],
  ['seplos.mos_ot_alarm', 'mos.otp', 'below'],
  ['charge.oc_alarm', 'charge.ocp', 'below'],
  ['discharge.oc_alarm', 'discharge.ocp', 'below'],
  ['soc.low_alarm', 'seplos.soc_low_protection', 'above'],
];

const LEVEL1_BELOW_LEVEL2 = msg('Must be below the level 2 protection');
const LEVEL2_ABOVE_LEVEL1 = msg('Must be above the level 1 protection');
const UV_BELOW_OV = msg('The undervoltage protection must be below the overvoltage protection');

/**
 * Other ordered pairs: [a, op, b, message on a, message on b], read "a op b". The short circuit
 * current is not compared with the level 2 discharge protection: the captured SG16S200A block
 * holds 350 A for level 2 and 300 A for the short circuit (`v3-rx-spa1-sg`).
 * @type {Array<[string, '<'|'>', string, string, string]>}
 */
const ORDER_PAIRS = [
  ['cell.uvp', '<', 'cell.ovp', UV_BELOW_OV, UV_BELOW_OV],
  ['charge.ocp', '<', 'seplos.charge_ocp2', LEVEL1_BELOW_LEVEL2, LEVEL2_ABOVE_LEVEL1],
  ['discharge.ocp', '<', 'discharge.ocp2', LEVEL1_BELOW_LEVEL2, LEVEL2_ABOVE_LEVEL1],
  ['seplos.cell_uv_failure', '<', 'cell.uvp', msg('The failure voltage must be below the undervoltage protection'), msg('The undervoltage protection must be above the failure voltage')],
  [
    'seplos.low_voltage_charge_forbid',
    '<',
    'cell.uvp',
    msg('Must be below the cell undervoltage protection'),
    msg('The undervoltage protection must be above the charging prohibited voltage'),
  ],
  ['seplos.heating_start', '<', 'seplos.heating_stop', msg('Heating start temperature must be below the stop temperature'), msg('Heating stop temperature must be above the start temperature')],
  ['seplos.balance_stop_delta', '<', 'balance.trigger_delta', msg('Stop difference must be below the start difference'), msg('Start difference must be above the stop difference')],
];

/** @param {'below'|'above'} side @param {'protection'|'alarm'} kind message on the recovery field */
function recoveryMessage(side, kind) {
  if (kind === 'protection') return side === 'below' ? msg('Recovery must be below protection') : msg('Recovery must be above protection');
  return side === 'below' ? msg('Recovery must be below the alarm value') : msg('Recovery must be above the alarm value');
}

/** @param {'below'|'above'} side of the recovery @param {'protection'|'alarm'} kind message on the threshold field */
function thresholdMessage(side, kind) {
  if (kind === 'protection') return side === 'below' ? msg('The protection must be above its recovery value') : msg('The protection must be below its recovery value');
  return side === 'below' ? msg('The alarm must be above its recovery value') : msg('The alarm must be below its recovery value');
}

/** @param {...((values: Record<string, any>) => string | null)} checks first failing check wins */
function all(...checks) {
  if (checks.length === 1) return checks[0];
  return (/** @type {Record<string, any>} */ values) => {
    for (const c of checks) {
      const e = c(values);
      if (e) return e;
    }
    return null;
  };
}

/**
 * Pack limit against cell limit times cell count (as in the JBD family): a non-blocking warning
 * when they differ by more than one cell step.
 * @param {string} packId
 * @param {string} cellId
 */
function packWarning(packId, cellId) {
  return (/** @type {Record<string, any>} */ values) => {
    const pack = values[packId];
    const cell = values[cellId];
    const n = values['system.cell_count'];
    if (![pack, cell, n].every(Number.isFinite) || n < 1) return null;
    return Math.abs(pack - cell * n) > cell ? msg('The pack limit does not match the cell limit times the cell count') : null;
  };
}

/** Firmware V1.43l limits the remaining capacity to the full capacity on every SPA write ([SO] `Reg_WriteWords`). */
const CAPACITY_CLAMP = msg('The BMS limits the remaining capacity to the full charge capacity');

/** @param {Record<string, any>} v */
const capacityWarning = (v) =>
  Number.isFinite(v['capacity.remaining']) && Number.isFinite(v['seplos.full_capacity']) && v['capacity.remaining'] > v['seplos.full_capacity'] ? CAPACITY_CLAMP : null;

/**
 * Attach the cross-field checks to the writable fields present. Every relation is checked on both
 * of its fields, so the settings view blocks an edit of either side (it blocks Apply only for an
 * error on the edited field). The firmware applies SPA and parameter block values without range
 * checks ([SO] `Reg_WriteWords`), so these checks are the only guard.
 * @param {SettingField[]} fields
 */
function addRelations(fields) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  /** @type {Map<string, Array<(values: Record<string, any>) => string | null>>} */
  const checks = new Map();
  /** @param {string} self @param {'<'|'>'} op @param {string} other @param {string} message */
  const add = (self, op, other, message) => {
    const f = byId.get(self);
    if (!f || f.readOnly || !byId.has(other)) return;
    checks.set(self, [...(checks.get(self) ?? []), relation(self, op, other, message)]);
  };
  /** @param {string} a @param {'<'|'>'} op @param {string} b @param {string} onA @param {string} onB */
  const pair = (a, op, b, onA, onB) => {
    add(a, op, b, onA);
    add(b, op === '<' ? '>' : '<', a, onB);
  };
  for (const [rec, ref, side, kind] of RECOVERY_PAIRS) pair(rec, side === 'below' ? '<' : '>', ref, recoveryMessage(side, kind), thresholdMessage(side, kind));
  for (const [alarm, prot, side] of ALARM_PAIRS) {
    if (side === 'below') pair(alarm, '<', prot, msg('The alarm must be below the protection value'), msg('The protection must be above the alarm value'));
    else pair(alarm, '>', prot, msg('The alarm must be above the protection value'), msg('The protection must be below the alarm value'));
  }
  for (const [a, op, b, onA, onB] of ORDER_PAIRS) pair(a, op, b, onA, onB);
  for (const [id, list] of checks) /** @type {SettingField} */ (byId.get(id)).validate = all(...list);
  // Non-blocking checks.
  for (const [packId, cellId] of [
    ['pack.ovp', 'cell.ovp'],
    ['pack.uvp', 'cell.uvp'],
  ]) {
    const f = byId.get(packId);
    if (f && !f.readOnly && byId.has(cellId) && byId.has('system.cell_count')) f.warn = packWarning(packId, cellId);
  }
  for (const id of ['capacity.remaining', 'seplos.full_capacity']) {
    const f = byId.get(id);
    if (f && !f.readOnly && byId.has('capacity.remaining') && byId.has('seplos.full_capacity')) f.warn = capacityWarning;
  }
  return fields;
}

// ---------------------------------------------------------------------------------------------
// V2 parameter block (spec 7.1, 7.2)
// ---------------------------------------------------------------------------------------------

/**
 * Two byte parameters: block key to ubms id (spec 7.1).
 * @type {Record<string, string>}
 */
export const V2_INT_IDS = {
  cellHighAlarm: 'cell.ov_alarm',
  cellHighAlarmRecovery: 'seplos.cell_ov_alarm_recovery',
  cellLowAlarm: 'cell.uv_alarm',
  cellLowAlarmRecovery: 'seplos.cell_uv_alarm_recovery',
  cellOvp: 'cell.ovp',
  cellOvpRecovery: 'cell.ovpr',
  cellUvp: 'cell.uvp',
  cellUvpRecovery: 'cell.uvpr',
  balanceStartVoltage: 'balance.start_voltage',
  lowVoltageChargeForbid: 'seplos.low_voltage_charge_forbid',
  packHighAlarm: 'pack.ov_alarm',
  packHighAlarmRecovery: 'seplos.pack_ov_alarm_recovery',
  packLowAlarm: 'pack.uv_alarm',
  packLowAlarmRecovery: 'seplos.pack_uv_alarm_recovery',
  packOvp: 'pack.ovp',
  packOvpRecovery: 'pack.ovpr',
  packUvp: 'pack.uvp',
  packUvpRecovery: 'pack.uvpr',
  chargeOvp: 'seplos.charge_ovp',
  chargeOvpRecovery: 'seplos.charge_ovp_recovery',
  chargeHighTempAlarm: 'seplos.charge_ot_alarm',
  chargeHighTempAlarmRecovery: 'seplos.charge_ot_alarm_recovery',
  chargeLowTempAlarm: 'seplos.charge_ut_alarm',
  chargeLowTempAlarmRecovery: 'seplos.charge_ut_alarm_recovery',
  chargeOtp: 'charge.otp',
  chargeOtpRecovery: 'charge.otpr',
  chargeUtp: 'charge.utp',
  chargeUtpRecovery: 'charge.utpr',
  dischargeHighTempAlarm: 'seplos.discharge_ot_alarm',
  dischargeHighTempAlarmRecovery: 'seplos.discharge_ot_alarm_recovery',
  dischargeLowTempAlarm: 'seplos.discharge_ut_alarm',
  dischargeLowTempAlarmRecovery: 'seplos.discharge_ut_alarm_recovery',
  dischargeOtp: 'discharge.otp',
  dischargeOtpRecovery: 'discharge.otpr',
  dischargeUtp: 'discharge.utp',
  dischargeUtpRecovery: 'discharge.utpr',
  heatingStart: 'seplos.heating_start',
  heatingStop: 'seplos.heating_stop',
  ambientHighAlarm: 'seplos.ambient_ot_alarm',
  ambientHighAlarmRecovery: 'seplos.ambient_ot_alarm_recovery',
  ambientLowAlarm: 'seplos.ambient_ut_alarm',
  ambientLowAlarmRecovery: 'seplos.ambient_ut_alarm_recovery',
  ambientOtp: 'seplos.ambient_otp',
  ambientOtpRecovery: 'seplos.ambient_otp_recovery',
  ambientUtp: 'seplos.ambient_utp',
  ambientUtpRecovery: 'seplos.ambient_utp_recovery',
  powerHighAlarm: 'seplos.mos_ot_alarm',
  powerHighAlarmRecovery: 'seplos.mos_ot_alarm_recovery',
  powerOtp: 'mos.otp',
  powerOtpRecovery: 'mos.otpr',
  chargeOcAlarm: 'charge.oc_alarm',
  chargeOcAlarmRecovery: 'seplos.charge_oc_alarm_recovery',
  dischargeOcAlarm: 'discharge.oc_alarm',
  dischargeOcAlarmRecovery: 'seplos.discharge_oc_alarm_recovery',
  chargeOcp: 'charge.ocp',
  dischargeOcp: 'discharge.ocp',
  transientOcp: 'discharge.ocp2',
  softStartDelayMs: 'seplos.soft_start_delay',
  ratedCapacityAh: 'capacity.nominal',
  remainingCapacityAh: 'capacity.remaining',
};

/** One byte parameters: block key to ubms id (spec 7.1). @type {Record<string, string>} */
export const V2_BYTE_IDS = {
  cellFailureDiff: 'cell.diff_protection',
  cellFailureDiffRecovery: 'seplos.cell_diff_protection_recovery',
  balanceStartDiff: 'balance.trigger_delta',
  balanceStopDiff: 'seplos.balance_stop_delta',
  staticBalanceHours: 'seplos.static_balance_time',
  cellCount: 'system.cell_count',
  chargeOcDelayS: 'charge.ocp_delay',
  dischargeOcDelayS: 'discharge.ocp_delay',
  transientOcDelayMs: 'discharge.ocp2_delay',
  ocRecoveryDelayS: 'seplos.oc_recovery_delay',
  ocRecoveryTimes: 'seplos.oc_lockout_count',
  chargeCurrentLimitDelayMin: 'seplos.charge_limit_delay',
  chargeActivationDelayMin: 'seplos.charge_activation_delay',
  chargeActivationIntervalH: 'seplos.charge_activation_interval',
  chargeActivationTimes: 'seplos.charge_activation_count',
  workRecordIntervalMin: 'seplos.work_record_interval',
  standbyRecordIntervalMin: 'seplos.standby_record_interval',
  standbyShutdownDelayH: 'system.sleep_delay',
  socAlarmPercent: 'soc.low_alarm',
  socProtectPercent: 'seplos.soc_low_protection',
  intermittentChargeSocPercent: 'seplos.top_up_soc',
  cycleCapacityPercent: 'seplos.cycle_capacity_ratio',
  connectionFaultMilliohm: 'seplos.connection_fault_resistance',
  comp1Cell: 'seplos.comp1_cell',
  comp1Milliohm: 'seplos.comp1_resistance',
  comp2Cell: 'seplos.comp2_cell',
  comp2Milliohm: 'seplos.comp2_resistance',
};

/** @type {Record<string, { unit?: string, decimals: number, lo: number, hi: number }>} */
const V2_KIND_RAW = {
  mv: { unit: 'V', decimals: 3, lo: 0, hi: 65.535 },
  cv: { unit: 'V', decimals: 2, lo: 0, hi: 655.35 },
  temp: { unit: '°C', decimals: 1, lo: -273.1, hi: 6280.4 },
  amp: { unit: 'A', decimals: 2, lo: 0, hi: 327.67 },
  ms: { unit: 'ms', decimals: 0, lo: 0, hi: 65535 },
  ah: { unit: 'Ah', decimals: 2, lo: 0, hi: 655.35 },
};

/**
 * @typedef {Object} V2Switch
 * @property {number} byte 1..8
 * @property {number} bit
 * @property {string} id
 * @property {string} label
 * @property {boolean} [readOnly]
 * @property {string} [reason]
 * @property {boolean} [advanced]
 * @property {string} [group]
 * @property {boolean} [danger] the bit enables an alarm, protection, lockout or failure check
 */

/** Description of a function switch that enables a protection or a check (spec 7.2, 7.4). */
export const PROTECTION_SWITCH = msg('Off disables this protection or check.');

/**
 * V2 function switches (spec 7.2): bytes 1 to 6 enable the event bits of the same position
 * (labelled with the event names), byte 6 bits 1 and 7 and bytes 7 and 8 enable functions. Byte 6
 * bit 1 is the intermittent (top-up) charge function ([BSX] `bit_para` ByteIndex 5 BitIndex 1),
 * not its waiting event. Every other bit of bytes 1 to 6 except the heating (byte 4 bit 6) enables
 * an alarm, a protection, a lockout or a failure detection and is marked danger.
 * @type {V2Switch[]}
 */
export const V2_SWITCHES = [
  ...EVENT_BITS.filter((e) => e.event <= 6 && !(e.event === 6 && (e.bit === 1 || e.bit === 7))).map((e) => ({
    byte: e.event,
    bit: e.bit,
    id: `seplos.fn_event${e.event}_${e.bit}`,
    label: e.name,
    advanced: true,
    ...(e.event === 4 && e.bit === 6 ? {} : { danger: true }),
  })),
  { byte: 6, bit: 1, id: 'seplos.fn_top_up', label: msg('Top-up charge') },
  { byte: 6, bit: 7, id: 'seplos.fn_soft_start', label: msg('Output soft start') },
  { byte: 7, bit: 0, id: 'balance.enabled', label: msg('Balancer enabled'), group: 'balancing' },
  { byte: 7, bit: 1, id: 'seplos.fn_static_balance', label: msg('Static balancing') },
  { byte: 7, bit: 2, id: 'seplos.fn_balance_timeout', label: msg('Stop balancing after the timeout') },
  { byte: 7, bit: 3, id: 'seplos.fn_balance_overtemp', label: msg('Stop balancing when over temperature') },
  { byte: 7, bit: 4, id: 'seplos.fn_auto_charge_activation', label: msg('Automatic charge activation') },
  { byte: 7, bit: 5, id: 'seplos.fn_manual_charge_activation', label: msg('Manual charge activation') },
  { byte: 7, bit: 6, id: 'seplos.fn_active_current_limit', label: msg('Active current limiting while charging') },
  { byte: 7, bit: 7, id: 'seplos.fn_passive_current_limit', label: msg('Passive current limiting while charging') },
  { byte: 8, bit: 0, id: 'seplos.fn_switch_shutdown', label: msg('Shutdown with the switch') },
  { byte: 8, bit: 1, id: 'seplos.fn_standby_power_off', label: msg('Power off in standby') },
  { byte: 8, bit: 2, id: 'seplos.fn_history', label: msg('History recording') },
  { byte: 8, bit: 3, id: 'seplos.fn_lcd', label: msg('LCD display') },
  {
    byte: 8,
    bit: 4,
    id: 'seplos.fn_bluetooth',
    label: msg('Bluetooth communication'),
    readOnly: true,
    reason: msg('Switching Bluetooth off would cut the Bluetooth connection, so it is shown read only.'),
  },
  { byte: 8, bit: 5, id: 'seplos.fn_auto_address', label: msg('Automatic address coding'), advanced: true },
  { byte: 8, bit: 6, id: 'seplos.fn_parallel_polling', label: msg('Parallel external polling'), advanced: true },
  { byte: 8, bit: 7, id: 'seplos.fn_1c_charging', label: msg('Standalone 1.0 C charging'), advanced: true },
];

/** Shown when the block has another layout than 60 / 27 / 8 parameters. */
export const V2_LAYOUT_REASON = msg('The parameter block of this BMS has an unexpected layout, so every value is shown read only.');

/**
 * Settings schema of both V2 drivers.
 * @param {{ writable?: boolean, reason?: string }} [opts] writable false makes every field read only
 * @returns {SettingsSchema}
 */
export function buildV2Schema({ writable = true, reason = V2_LAYOUT_REASON } = {}) {
  /** @type {SettingField[]} */
  const fields = [];
  /** @param {Partial<SettingField>} f */
  const ro = (f) => (writable ? f : { ...f, readOnly: true, description: reason });
  for (const [key, kind] of INT_PARAMS) {
    const id = V2_INT_IDS[key];
    const raw = V2_KIND_RAW[kind];
    /** @type {Partial<SettingField>} */
    const o = { meta: { kind: 'param', key, negate: V2_NEGATIVE.has(id) } };
    if (id === 'capacity.remaining') o.description = msg('Live value of the BMS. A write of any other setting sends back the value just read.');
    fields.push(numberField(id, raw, ro(o)));
  }
  for (const [key, scale] of BYTE_PARAMS) {
    const id = V2_BYTE_IDS[key];
    const decimals = scale === 1 ? 0 : Math.round(-Math.log10(scale));
    /** @type {Partial<SettingField>} */
    const o = { meta: { kind: 'param', key } };
    if (id === 'system.cell_count') {
      // The V2 boards monitor 8 to 16 cells ([MAN100] "8-16 cells in series", [MAN200] "8s-16s");
      // the vendor tool defines 16 cells ([BSX] Cell01..Cell16) and 0x44 / 0x61 carry two
      // balancing bytes (spec 6.1.2, 6.2.2).
      o.danger = true;
      o.min = 8;
      o.max = 16;
      o.description = msg('Number of cells in series. A wrong value stops the cell protection.');
    }
    fields.push(numberField(id, { decimals, lo: 0, hi: 255 * scale }, ro(o)));
  }
  for (const s of V2_SWITCHES) {
    const readOnly = !writable || s.readOnly;
    fields.push(
      field(s.id, {
        type: 'boolean',
        label: SETTINGS[s.id]?.label ?? s.label,
        group: s.group ?? (SETTINGS[s.id] ? SETTINGS[s.id].group : FUNCTIONS_GROUP),
        ...(s.advanced ? { advanced: true } : {}),
        ...(s.danger ? { danger: true, description: PROTECTION_SWITCH } : {}),
        ...(readOnly ? { readOnly: true, description: s.readOnly ? s.reason : reason } : {}),
        meta: { kind: 'switch', byte: s.byte, bit: s.bit },
      }),
    );
  }
  return buildSchema(addRelations(fields), EXTRA_GROUPS);
}

/**
 * Setting values of a decoded parameter block.
 * @param {import('./protocol-v2.js').ParamBlock} block
 * @param {SettingsSchema} schema
 */
export function decodeV2Settings(block, schema) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const m = f.meta ?? {};
      if (m.kind === 'param' && block.params[m.key] !== undefined) {
        const v = block.params[m.key];
        values[f.id] = m.negate ? -v || 0 : v;
      } else if (m.kind === 'switch' && m.byte <= block.functionSwitches.length) {
        values[f.id] = ((block.functionSwitches[m.byte - 1] >> m.bit) & 1) === 1;
      }
    }
  }
  return values;
}

// ---------------------------------------------------------------------------------------------
// V3 SPA, SFA, SCA (spec 7.3, 7.4, 8.3)
// ---------------------------------------------------------------------------------------------

/** Read only reason of every V3 field when writes are not possible on this connection. */
export const V3_ADDRESS_REASON = msg(
  'Address 0 on a wired bus is the Modbus broadcast address, so nothing is written there. Connect through the PC port (address 224) or set the address of the pack.',
);

/**
 * @param {import('./protocol-v3.js').SpaRegister} def
 */
function spaRange(def) {
  const decimals = def.kind === 'temp' ? 1 : def.scale >= 1 ? 0 : Math.round(-Math.log10(def.scale));
  if (def.kind === 'temp') return { unit: '°C', decimals, lo: -273.1, hi: 6280.4 };
  // Every s16 SPA register is a current threshold with a fixed sign: charge values positive,
  // discharge values stored negative and shown as magnitudes (`negate`). A negative charge
  // threshold would invert the protection, so neither side goes below 0.
  if (def.type === 's16') return def.negate ? { decimals, lo: 0, hi: 32768 * def.scale } : { decimals, lo: 0, hi: 32767 * def.scale };
  return { decimals, lo: 0, hi: 65535 * def.scale };
}

/** Units of the V3 ids that the shared table does not fix (spec 7.3). @type {Record<string, string>} */
const V3_UNITS = {
  'scp.delay': 'µs',
  'charge.ocp': 'A',
  'charge.oc_alarm': 'A',
  'discharge.ocp': 'A',
  'discharge.oc_alarm': 'A',
  'discharge.ocp2': 'A',
  'scp.current': 'A',
  'seplos.oc_recovery_delay': 's',
};

/**
 * Settings schema of the V3 driver.
 * @param {{ writable?: boolean, reason?: string }} [opts] writable false (RS485 at address 0) makes every field read only and drops the actions
 * @returns {SettingsSchema}
 */
export function buildV3Schema({ writable = true, reason = V3_ADDRESS_REASON } = {}) {
  /** @type {SettingField[]} */
  const fields = [];
  for (const def of SPA_REGISTERS) {
    const range = spaRange(def);
    const raw = { ...range, unit: V3_UNITS[def.id] ?? range.unit };
    /** @type {Partial<SettingField>} */
    const o = { meta: { kind: 'spa', reg: def.reg } };
    if (def.write === 'no') {
      o.readOnly = true;
      o.description = def.reason;
    } else if (!writable) {
      o.readOnly = true;
      o.description = reason;
    }
    if (def.write === 'danger') {
      o.danger = true;
      if (def.id === 'system.cell_count') {
        // PIB holds 16 cell voltages (spec 6.3.2); no V3 source gives a minimum (**unverified**).
        o.min = 1;
        o.max = 16;
        o.description = o.description ?? msg('Number of cells in series. A wrong value stops the cell protection.');
      } else {
        // PIB holds 4 cell temperature slots (spec 6.3.2); 0 would remove every cell sensor and
        // with them the cell temperature protections.
        o.min = 1;
        o.max = 4;
        o.description = o.description ?? msg('Number of cell temperature sensors. A wrong value disables temperature protection.');
      }
    }
    if (def.id === 'capacity.remaining' && !o.readOnly) o.description = msg('Live value of the BMS, limited to the full charge capacity.');
    fields.push(numberField(def.id, raw, o));
  }
  for (const s of SFA_BITS) {
    const readOnly = !writable || s.readOnly;
    const canonical = SETTINGS[s.id];
    fields.push(
      field(s.id, {
        type: 'boolean',
        label: canonical?.label ?? s.label,
        group: canonical ? canonical.group : FUNCTIONS_GROUP,
        ...(canonical && canonical.label !== s.label ? { description: s.label } : {}),
        ...(s.advanced ? { advanced: true } : {}),
        ...(s.danger ? { danger: true, description: PROTECTION_SWITCH } : {}),
        ...(readOnly ? { readOnly: true, description: s.readOnly ? s.reason : reason } : {}),
        meta: { kind: 'sfa', byte: s.byte, bit: s.bit },
      }),
    );
  }
  const control = writable ? {} : { readOnly: true, description: reason };
  // On cancels the off command only (0x1510 / 0x1511 = 0xAA55, spec 8.3); it never forces a
  // MOSFET on.
  fields.push(
    field('switch.discharge', {
      type: 'boolean',
      danger: true,
      description: msg('Off forces the discharge MOSFET off until it is switched on again here. On only cancels that command; it does not force the MOSFET on.'),
      ...control,
      meta: { kind: 'mos', key: 'discharge' },
    }),
    field('switch.charge', {
      type: 'boolean',
      danger: true,
      description: msg('Off forces the charge MOSFET off until it is switched on again here. On only cancels that command; it does not force the MOSFET on.'),
      ...control,
      meta: { kind: 'mos', key: 'charge' },
    }),
  );
  if (writable) {
    fields.push(
      field('seplos.restart', {
        type: 'action',
        label: msg('Restart BMS'),
        group: 'actions',
        danger: true,
        description: msg('Restarts the BMS. The output may be interrupted while it restarts.'),
        meta: { kind: 'sca', reg: 0x1518 },
      }),
      field('seplos.sync_clock', {
        type: 'action',
        label: msg('Set the BMS clock'),
        group: 'actions',
        advanced: true,
        description: msg('Sets the BMS clock to the time of this computer. The BMS accepts it only while history recording is on.'),
        meta: { kind: 'calendar' },
      }),
    );
  }
  return buildSchema(addRelations(fields), EXTRA_GROUPS);
}

/**
 * Setting values of the V3 blocks. Missing blocks leave their fields out.
 * @param {SettingsSchema} schema
 * @param {{ spa?: Map<number, number>, sfa?: number[], fet?: number }} data
 * @param {(reg: number, raw: number) => number} spaValue
 */
export function decodeV3Settings(schema, { spa, sfa, fet }, spaValue) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const m = f.meta ?? {};
      if (m.kind === 'spa' && spa?.has(m.reg)) values[f.id] = spaValue(m.reg, /** @type {number} */ (spa.get(m.reg)));
      else if (m.kind === 'sfa' && sfa && m.byte < sfa.length) values[f.id] = ((sfa[m.byte] >> m.bit) & 1) === 1;
      else if (m.kind === 'mos' && fet !== undefined) values[f.id] = m.key === 'discharge' ? (fet & 1) === 1 : (fet & 2) === 2;
    }
  }
  return values;
}
