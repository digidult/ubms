import { field, buildSchema, relation, msg } from '@ubms/bms-core';
import { u16be, u32be, setU16be, setU32be } from '@ubms/transport';
import { r } from '../common/util.js';
import { CMD, D2_BATTERY_TYPES, D2_REG, P81_REG, rtcText } from './protocol.js';

/**
 * Daly settings schemas and raw/engineering conversion (docs/protocols/daly.md section 7).
 *
 * Safety rule: whatever the specification marks unverified, inferred or unknown (units, bit
 * orders, value tables, register locations) is `readOnly` with a description saying so. Writable
 * fields use layouts confirmed by captures and at least one implementation:
 * - classic: the "Set All" captures of the PC software (spec 5.3); writes always send the whole
 *   8 byte group read just before, with the undefined bytes copied back unchanged;
 * - D2: the vendor register list (R/W column) confirmed by syssi and captures (spec 6.3);
 * - 0x81 map: only the registers patagonaa writes (spec 5.5); every other 0x81 value is inferred
 *   from one capture and read-only.
 *
 * Field `meta` (driver private):
 * - `{ kind: 'group', cmd, offset, size, scale?, add?, codec? }` classic field in the 8 byte group
 *   of read command `cmd` (value = raw x scale + add; codecs for the 30000 offset currents)
 * - `{ kind: 'group-sum', cmd, offsets }`, `{ kind: 'group-date', cmd, offset }`,
 *   `{ kind: 'group-text', cmd }`, `{ kind: 'rtc' }` classic read-only views
 * - `{ kind: 'battery-code' }` classic battery code (0x57 / 0x17, five frames)
 * - `{ kind: 'register', register, words?, scale?, add?, codec? }` Modbus register (u16, or u32
 *   over two registers), written with function 0x06
 * - `{ kind: 'register-sum', registers }`, `{ kind: 'register-text', register, length }`,
 *   `{ kind: 'register-date', register }` Modbus read-only views
 * - `{ kind: 'soc', register? }` state of charge: read from the live data, written with 0x21
 *   (classic) or to `register` (Modbus)
 * - `{ kind: 'switch', key, register? }` MOSFET or feature switch; the value is the state the BMS
 *   reports, the command is 0xDA / 0xD9 (classic) or a register write (Modbus)
 * - `{ kind: 'action', action, register?, value? }` one-shot command
 * - `{ kind: 'local' }` value kept in the driver instance (current sign)
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 *
 * @typedef {Object} NumericMeta
 * @property {number} [scale] engineering value = raw x scale + add
 * @property {number} [add]
 * @property {'charge-current'|'discharge-current'} [codec] 30000 offset currents (spec 7.3)
 */

const UNVERIFIED = msg('The encoding of this value is not confirmed, so it is shown but never written.');
const INFERRED_81 = msg('Register location inferred from one capture of this protocol version, so the value is shown but never written.');
const HARDWARE_CONFIG = msg('Changing this breaks the measurements, so it is shown but never written.');
const PRODUCTION_DATE = msg('Stored by the manufacturer, shown only.');
const RATED_GROUP = msg('Rated capacity and nominal cell voltage are written together (command 0x10). Change them only when the pack itself changed.');
const LEVEL1 = msg('Level 1: the BMS reports a warning.');
const LEVEL2 = msg('Level 2: the BMS switches the MOSFETs off.');

const HIGH_ABOVE_LOW = msg('The high threshold must be above the low threshold');
const LOW_BELOW_HIGH = msg('The low threshold must be below the high threshold');
const L2_NOT_BELOW_L1 = msg('Level 2 must not be below level 1');
const L1_NOT_ABOVE_L2 = msg('Level 1 must not be above level 2');
const L2_NOT_ABOVE_L1 = msg('Level 2 must not exceed level 1');
const L1_NOT_BELOW_L2 = msg('Level 1 must not be below level 2');

/** @param {...((values: Record<string, any>) => string | null)} checks */
function all(...checks) {
  return (/** @type {Record<string, any>} */ values) => {
    for (const c of checks) {
      const e = c(values);
      if (e) return e;
    }
    return null;
  };
}

const CELL_V = { min: 1, max: 5 };
const CELL_DIFF = { min: 0.001, max: 1.5 };
const PACK_V = { min: 1, max: 250 };
const CURRENT = { min: 0.1, max: 3000 };
const TEMP = { min: -40, max: 100 };
const SOC_LIMIT = { min: 0, max: 110 };

/**
 * Cross-field checks shared by the classic and the D2 schema. Only orders that every captured
 * configuration follows are enforced: high above low, and level 2 beyond level 1 for temperatures
 * and SOC. Captured cell voltage, current and difference groups do not keep a level order, so the
 * BMS does not enforce one there (spec 7.8).
 * @type {Record<string, (values: Record<string, any>) => string | null>}
 */
const VALIDATORS = {
  'cell.ov_alarm': relation('cell.ov_alarm', '>', 'cell.uv_alarm', HIGH_ABOVE_LOW),
  'cell.uv_alarm': relation('cell.uv_alarm', '<', 'cell.ov_alarm', LOW_BELOW_HIGH),
  'cell.ovp': relation('cell.ovp', '>', 'cell.uvp', HIGH_ABOVE_LOW),
  'cell.uvp': relation('cell.uvp', '<', 'cell.ovp', LOW_BELOW_HIGH),
  'pack.ov_alarm': relation('pack.ov_alarm', '>', 'pack.uv_alarm', HIGH_ABOVE_LOW),
  'pack.uv_alarm': relation('pack.uv_alarm', '<', 'pack.ov_alarm', LOW_BELOW_HIGH),
  'pack.ovp': relation('pack.ovp', '>', 'pack.uvp', HIGH_ABOVE_LOW),
  'pack.uvp': relation('pack.uvp', '<', 'pack.ovp', LOW_BELOW_HIGH),
  'daly.charge_ot_alarm': all(
    relation('daly.charge_ot_alarm', '>', 'daly.charge_ut_alarm', HIGH_ABOVE_LOW),
    relation('daly.charge_ot_alarm', '<=', 'charge.otp', L1_NOT_ABOVE_L2),
  ),
  'charge.otp': all(relation('charge.otp', '>', 'charge.utp', HIGH_ABOVE_LOW), relation('charge.otp', '>=', 'daly.charge_ot_alarm', L2_NOT_BELOW_L1)),
  'daly.charge_ut_alarm': all(
    relation('daly.charge_ut_alarm', '<', 'daly.charge_ot_alarm', LOW_BELOW_HIGH),
    relation('daly.charge_ut_alarm', '>=', 'charge.utp', L1_NOT_BELOW_L2),
  ),
  'charge.utp': all(relation('charge.utp', '<', 'charge.otp', LOW_BELOW_HIGH), relation('charge.utp', '<=', 'daly.charge_ut_alarm', L2_NOT_ABOVE_L1)),
  'daly.discharge_ot_alarm': all(
    relation('daly.discharge_ot_alarm', '>', 'daly.discharge_ut_alarm', HIGH_ABOVE_LOW),
    relation('daly.discharge_ot_alarm', '<=', 'discharge.otp', L1_NOT_ABOVE_L2),
  ),
  'discharge.otp': all(
    relation('discharge.otp', '>', 'discharge.utp', HIGH_ABOVE_LOW),
    relation('discharge.otp', '>=', 'daly.discharge_ot_alarm', L2_NOT_BELOW_L1),
  ),
  'daly.discharge_ut_alarm': all(
    relation('daly.discharge_ut_alarm', '<', 'daly.discharge_ot_alarm', LOW_BELOW_HIGH),
    relation('daly.discharge_ut_alarm', '>=', 'discharge.utp', L1_NOT_BELOW_L2),
  ),
  'discharge.utp': all(
    relation('discharge.utp', '<', 'discharge.otp', LOW_BELOW_HIGH),
    relation('discharge.utp', '<=', 'daly.discharge_ut_alarm', L2_NOT_ABOVE_L1),
  ),
  'daly.soc_high_alarm': all(
    relation('daly.soc_high_alarm', '>', 'soc.low_alarm', HIGH_ABOVE_LOW),
    relation('daly.soc_high_alarm', '<=', 'daly.soc_high_protection', L1_NOT_ABOVE_L2),
  ),
  'daly.soc_high_protection': relation('daly.soc_high_protection', '>=', 'daly.soc_high_alarm', L2_NOT_BELOW_L1),
  'soc.low_alarm': all(relation('soc.low_alarm', '<', 'daly.soc_high_alarm', LOW_BELOW_HIGH), relation('soc.low_alarm', '>=', 'daly.soc_low_protection', L1_NOT_BELOW_L2)),
  'daly.soc_low_protection': relation('daly.soc_low_protection', '<=', 'soc.low_alarm', L2_NOT_ABOVE_L1),
};

/** Labels of Daly specific ids (literals for the translation checker). */
const LABELS = {
  'daly.charge_ot_alarm': msg('Charge high temperature alarm'),
  'daly.charge_ut_alarm': msg('Charge low temperature alarm'),
  'daly.discharge_ot_alarm': msg('Discharge high temperature alarm'),
  'daly.discharge_ut_alarm': msg('Discharge low temperature alarm'),
  'daly.temp_diff_protection': msg('Temperature difference protection'),
  'daly.soc_high_alarm': msg('High SOC alarm'),
  'daly.soc_high_protection': msg('High SOC protection'),
  'daly.soc_low_protection': msg('Low SOC protection'),
  'daly.cell_nominal_voltage': msg('Nominal cell voltage'),
};

/**
 * Field with the Daly level description and the shared validator.
 * @param {string} id
 * @param {Partial<SettingField>} overrides
 */
function daly(id, overrides) {
  const label = /** @type {Record<string, string>} */ (LABELS)[id];
  return field(id, { ...(label ? { label } : {}), ...(VALIDATORS[id] ? { validate: VALIDATORS[id] } : {}), ...overrides });
}

/** @param {string} group */
const volts = (group) => ({ group, unit: 'V', decimals: 3, ...CELL_V });
const packVolts = { group: 'pack_voltage', unit: 'V', decimals: 1, ...PACK_V };
const amps = { group: 'current', unit: 'A', decimals: 1, ...CURRENT };
const degrees = { group: 'temperature', unit: '°C', decimals: 0, step: 1, ...TEMP };
const socPercent = { group: 'capacity', unit: '%', decimals: 1, ...SOC_LIMIT };

/**
 * Invert current direction (local). Daly firmware disagrees on the current sign (spec 12.1 item 1);
 * the default follows the majority of each protocol.
 */
function invertCurrentField() {
  return field('daly.invert_current', {
    label: msg('Invert current direction'),
    group: 'system',
    type: 'boolean',
    advanced: true,
    description: msg(
      'Daly firmware versions disagree on the sign of the current. Switch this when charging is shown as discharging. The default follows most devices of this protocol; the app also checks it against the charge state the BMS reports.',
    ),
    meta: { kind: 'local' },
  });
}

// ---------------------------------------------------------------------------------------------
// Classic schema (spec 6.2, 7)
// ---------------------------------------------------------------------------------------------

/**
 * Classic group field.
 * @param {string} id
 * @param {number} cmd read command of the group
 * @param {number} offset data offset
 * @param {1|2|4} size
 * @param {NumericMeta} codec
 * @param {Partial<SettingField>} [overrides]
 */
function grp(id, cmd, offset, size, codec, overrides = {}) {
  return daly(id, { ...overrides, meta: { kind: 'group', cmd, offset, size, ...codec } });
}

/** Read commands of the configuration groups loaded by readSettings (spec 4.1 step 4). */
export const CLASSIC_SETTING_GROUPS = Object.freeze([
  CMD.RATED,
  CMD.BOARDS,
  CMD.CUMULATIVE,
  CMD.BATTERY_INFO,
  CMD.FIRMWARE_INDEX,
  CMD.CELL_LIMITS,
  CMD.PACK_LIMITS,
  CMD.CURRENT_LIMITS,
  CMD.TEMP_LIMITS,
  CMD.SOC_LIMITS,
  CMD.DIFF_LIMITS,
  CMD.BALANCE_LIMITS,
  CMD.SHORT_CIRCUIT,
  CMD.RTC,
]);

/** @returns {SettingsSchema} */
export function buildClassicSchema() {
  const mv = { scale: 0.001 };
  const dv = { scale: 0.1 };
  const t40 = { add: -40 };
  return buildSchema([
    // Cell voltage (0x59 / 0x19, 0x5E / 0x1E, 0x50 / 0x10)
    grp('cell.ov_alarm', CMD.CELL_LIMITS, 0, 2, mv, { ...volts('cell_voltage'), description: LEVEL1 }),
    grp('cell.ovp', CMD.CELL_LIMITS, 2, 2, mv, { ...volts('cell_voltage'), description: LEVEL2 }),
    grp('cell.uv_alarm', CMD.CELL_LIMITS, 4, 2, mv, { ...volts('cell_voltage'), description: LEVEL1 }),
    grp('cell.uvp', CMD.CELL_LIMITS, 6, 2, mv, { ...volts('cell_voltage'), description: LEVEL2 }),
    grp('cell.diff_alarm', CMD.DIFF_LIMITS, 0, 2, mv, { group: 'cell_voltage', unit: 'V', decimals: 3, ...CELL_DIFF, description: LEVEL1 }),
    grp('cell.diff_protection', CMD.DIFF_LIMITS, 2, 2, mv, { group: 'cell_voltage', unit: 'V', decimals: 3, ...CELL_DIFF, description: LEVEL2 }),
    grp('daly.cell_nominal_voltage', CMD.RATED, 6, 2, mv, { ...volts('cell_voltage'), advanced: true, danger: true, description: RATED_GROUP }),
    // Pack voltage (0x5A / 0x1A)
    grp('pack.ov_alarm', CMD.PACK_LIMITS, 0, 2, dv, { ...packVolts, description: LEVEL1 }),
    grp('pack.ovp', CMD.PACK_LIMITS, 2, 2, dv, { ...packVolts, description: LEVEL2 }),
    grp('pack.uv_alarm', CMD.PACK_LIMITS, 4, 2, dv, { ...packVolts, description: LEVEL1 }),
    grp('pack.uvp', CMD.PACK_LIMITS, 6, 2, dv, { ...packVolts, description: LEVEL2 }),
    // Current (0x5B / 0x1B; 0x60 / 0x20)
    grp('charge.oc_alarm', CMD.CURRENT_LIMITS, 0, 2, { codec: 'charge-current' }, { ...amps, description: LEVEL1 }),
    grp('charge.ocp', CMD.CURRENT_LIMITS, 2, 2, { codec: 'charge-current' }, { ...amps, description: LEVEL2 }),
    grp('discharge.oc_alarm', CMD.CURRENT_LIMITS, 4, 2, { codec: 'discharge-current' }, { ...amps, description: LEVEL1 }),
    grp('discharge.ocp', CMD.CURRENT_LIMITS, 6, 2, { codec: 'discharge-current' }, { ...amps, description: LEVEL2 }),
    grp('scp.current', CMD.SHORT_CIRCUIT, 0, 2, {}, { min: 1, max: 10000, step: 1, advanced: true }),
    grp('daly.current_sampling_resistance', CMD.SHORT_CIRCUIT, 2, 2, {}, {
      label: msg('Current sampling resistance (raw)'),
      group: 'current',
      decimals: 0,
      readOnly: true,
      advanced: true,
      description: msg('Unit not confirmed. A wrong value corrupts the current measurement, so it is shown but never written.'),
    }),
    grp('daly.current_deadband', CMD.BATTERY_INFO, 7, 1, { scale: 0.1 }, {
      label: msg('Zero current band'),
      group: 'current',
      unit: 'A',
      decimals: 1,
      readOnly: true,
      advanced: true,
      description: msg('Currents below this value are reported as 0 A. Known from a single forum post, so it is shown but never written.'),
    }),
    // Temperature (0x5C / 0x1C, +40 offset; 0x5E data 4..5 plain degrees, unverified)
    grp('daly.charge_ot_alarm', CMD.TEMP_LIMITS, 0, 1, t40, { ...degrees, description: LEVEL1 }),
    grp('charge.otp', CMD.TEMP_LIMITS, 1, 1, t40, { ...degrees, description: LEVEL2 }),
    grp('daly.charge_ut_alarm', CMD.TEMP_LIMITS, 2, 1, t40, { ...degrees, description: LEVEL1 }),
    grp('charge.utp', CMD.TEMP_LIMITS, 3, 1, t40, { ...degrees, description: LEVEL2 }),
    grp('daly.discharge_ot_alarm', CMD.TEMP_LIMITS, 4, 1, t40, { ...degrees, description: LEVEL1 }),
    grp('discharge.otp', CMD.TEMP_LIMITS, 5, 1, t40, { ...degrees, description: LEVEL2 }),
    grp('daly.discharge_ut_alarm', CMD.TEMP_LIMITS, 6, 1, t40, { ...degrees, description: LEVEL1 }),
    grp('discharge.utp', CMD.TEMP_LIMITS, 7, 1, t40, { ...degrees, description: LEVEL2 }),
    grp('temp.diff_alarm', CMD.DIFF_LIMITS, 4, 1, {}, { readOnly: true, description: msg('Offset not confirmed by a write test (plain degrees assumed), so it is shown but never written.') }),
    grp('daly.temp_diff_protection', CMD.DIFF_LIMITS, 5, 1, {}, {
      group: 'temperature',
      unit: '°C',
      decimals: 0,
      readOnly: true,
      description: msg('Offset not confirmed by a write test (plain degrees assumed), so it is shown but never written.'),
    }),
    // Balancing (0x5F / 0x1F)
    grp('balance.start_voltage', CMD.BALANCE_LIMITS, 0, 2, mv, { ...CELL_V }),
    grp('balance.trigger_delta', CMD.BALANCE_LIMITS, 2, 2, mv, {
      min: 0.001,
      max: 1,
      description: msg('The Daly PC software does not accept values below 0.050 V; the BMS does.'),
    }),
    // Capacity and SOC (0x50 / 0x10, 0x21, 0x5D / 0x1D, 0x52)
    grp('capacity.nominal', CMD.RATED, 0, 4, { scale: 0.001 }, { min: 1, max: 10000, danger: true, description: RATED_GROUP }),
    daly('soc.value', {
      decimals: 1,
      min: 0,
      max: 100,
      description: msg('Sets the state of charge. The BMS clock is set to the time of this computer at the same time.'),
      meta: { kind: 'soc' },
    }),
    grp('daly.soc_high_alarm', CMD.SOC_LIMITS, 0, 2, dv, { ...socPercent, description: LEVEL1 }),
    grp('daly.soc_high_protection', CMD.SOC_LIMITS, 2, 2, dv, { ...socPercent, description: LEVEL2 }),
    grp('soc.low_alarm', CMD.SOC_LIMITS, 4, 2, dv, { ...socPercent, description: LEVEL1 }),
    grp('daly.soc_low_protection', CMD.SOC_LIMITS, 6, 2, dv, { ...socPercent, description: LEVEL2 }),
    grp('daly.cumulative_charge', CMD.CUMULATIVE, 0, 4, {}, {
      label: msg('Cumulative charge (raw)'),
      group: 'capacity',
      decimals: 0,
      readOnly: true,
      advanced: true,
      description: msg('Unit not confirmed (probably Ah).'),
    }),
    grp('daly.cumulative_discharge', CMD.CUMULATIVE, 4, 4, {}, {
      label: msg('Cumulative discharge (raw)'),
      group: 'capacity',
      decimals: 0,
      readOnly: true,
      advanced: true,
      description: msg('Unit not confirmed (probably Ah).'),
    }),
    // Switches (0xDA, 0xD9)
    field('switch.charge', { meta: { kind: 'switch', key: 'charge' } }),
    field('switch.discharge', { meta: { kind: 'switch', key: 'discharge' } }),
    // System (0x51, 0x53)
    field('system.cell_count', { readOnly: true, description: HARDWARE_CONFIG, meta: { kind: 'group-sum', cmd: CMD.BOARDS, offsets: [1, 2, 3] } }),
    field('system.temp_sensor_count', { readOnly: true, description: HARDWARE_CONFIG, meta: { kind: 'group-sum', cmd: CMD.BOARDS, offsets: [4, 5, 6] } }),
    grp('daly.board_count', CMD.BOARDS, 0, 1, {}, { label: msg('Acquisition boards'), group: 'system', decimals: 0, readOnly: true, advanced: true, description: HARDWARE_CONFIG }),
    grp('system.battery_type', CMD.BATTERY_INFO, 1, 1, {}, {
      type: 'number',
      decimals: 0,
      readOnly: true,
      description: msg('Raw battery type code; its meaning is not confirmed for this protocol.'),
    }),
    grp('daly.operation_mode', CMD.BATTERY_INFO, 0, 1, {}, { label: msg('Operation mode (raw)'), group: 'system', decimals: 0, readOnly: true, advanced: true, description: UNVERIFIED }),
    grp('system.sleep_delay', CMD.BATTERY_INFO, 5, 2, {}, { min: 10, max: 65535, step: 1, description: msg('65535 s means the BMS never goes to sleep.') }),
    field('daly.rtc', {
      label: msg('BMS clock'),
      group: 'system',
      type: 'text',
      readOnly: true,
      advanced: true,
      description: msg('Set together with the state of charge, to the time of this computer.'),
      meta: { kind: 'rtc' },
    }),
    invertCurrentField(),
    // Identity (0x57 / 0x17, 0x54, 0x53)
    field('daly.battery_code', {
      label: msg('Battery code'),
      group: 'identity',
      type: 'text',
      maxLength: 35,
      description: msg('Up to 35 ASCII characters, stored by the BMS.'),
      meta: { kind: 'battery-code' },
    }),
    field('daly.firmware_index', {
      label: msg('Firmware index'),
      group: 'identity',
      type: 'text',
      readOnly: true,
      advanced: true,
      description: msg('Maintained by the Daly PC software, so it is shown but never written.'),
      meta: { kind: 'group-text', cmd: CMD.FIRMWARE_INDEX },
    }),
    field('daly.production_date', {
      label: msg('Production date'),
      group: 'identity',
      type: 'text',
      readOnly: true,
      description: PRODUCTION_DATE,
      meta: { kind: 'group-date', cmd: CMD.BATTERY_INFO, offset: 2 },
    }),
    // Actions. Never sent: the "engineering unlock" 0xE0..0xE3, 0x64 and 0xD8 (meaning unverified,
    // spec 4.5 and 5.1); the clock has no command of its own, it is set with the SOC (0x21).
    field('daly.reset', {
      label: msg('Reset BMS'),
      group: 'actions',
      type: 'action',
      danger: true,
      description: msg('Sends the classic reset command (0x00), which implementations use to restart the BMS. The BMS may not answer and the output may be interrupted.'),
      meta: { kind: 'action', action: 'reset' },
    }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Classic conversion
// ---------------------------------------------------------------------------------------------

/**
 * Raw integer of a classic group field.
 * @param {{ offset: number, size: number }} meta
 * @param {Uint8Array} data 8 data bytes
 */
export function groupRaw(meta, data) {
  if (meta.size === 1) return data[meta.offset];
  if (meta.size === 4) return u32be(data, meta.offset);
  return u16be(data, meta.offset);
}

/**
 * Engineering value of a raw number.
 * @param {NumericMeta} meta
 * @param {number} raw
 * @param {number} [decimals]
 */
export function rawToValue(meta, raw, decimals = 3) {
  if (meta.codec === 'charge-current' || meta.codec === 'discharge-current') {
    // The stored sign is not reliable (spec 7.3): show the magnitude.
    return r(Math.abs(raw - 30000) / 10, 1);
  }
  return r(raw * (meta.scale ?? 1) + (meta.add ?? 0), decimals);
}

/**
 * Raw number of an engineering value. Currents: charge `30000 - A x 10`, discharge
 * `30000 + A x 10` (spec 7.3).
 * @param {NumericMeta} meta
 * @param {number} value
 */
export function valueToRaw(meta, value) {
  if (meta.codec === 'charge-current') return 30000 - Math.round(value * 10);
  if (meta.codec === 'discharge-current') return 30000 + Math.round(value * 10);
  return Math.round((value - (meta.add ?? 0)) / (meta.scale ?? 1));
}

/**
 * Store a value into a copy of the group data. Throws when the raw value does not fit.
 * @param {{ offset: number, size: number } & NumericMeta} meta
 * @param {number} value
 * @param {Uint8Array} data 8 data bytes, modified in place
 * @returns {number} raw value written
 */
export function setGroupValue(meta, value, data) {
  const raw = valueToRaw(meta, value);
  const max = meta.size === 1 ? 0xff : meta.size === 4 ? 0xffffffff : 0xffff;
  if (!Number.isFinite(raw) || raw < 0 || raw > max) throw new Error(msg('The value is outside the range the BMS can store'));
  if (meta.size === 1) data[meta.offset] = raw;
  else if (meta.size === 4) setU32be(data, meta.offset, raw);
  else setU16be(data, meta.offset, raw);
  return raw;
}

/**
 * Decode the classic settings that live in configuration groups.
 * @param {SettingsSchema} schema
 * @param {Map<number, Uint8Array>} groups read command to 8 data bytes
 * @returns {Record<string, any>}
 */
export function decodeClassicSettings(schema, groups) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const meta = f.meta ?? {};
      const data = meta.cmd !== undefined ? groups.get(meta.cmd) : undefined;
      if (meta.kind === 'group' && data) values[f.id] = rawToValue(meta, groupRaw(meta, data), f.decimals ?? 3);
      else if (meta.kind === 'group-sum' && data) values[f.id] = meta.offsets.reduce((/** @type {number} */ s, /** @type {number} */ o) => s + data[o], 0);
      else if (meta.kind === 'group-date' && data) values[f.id] = `${2000 + data[meta.offset]}-${String(data[meta.offset + 1]).padStart(2, '0')}-${String(data[meta.offset + 2]).padStart(2, '0')}`;
      else if (meta.kind === 'group-text' && data) values[f.id] = asciiTrim(data);
      else if (meta.kind === 'rtc') {
        const rtc = groups.get(CMD.RTC);
        if (rtc) values[f.id] = rtcText(rtc, 0);
      }
    }
  }
  return values;
}

/** @param {Uint8Array} data */
function asciiTrim(data) {
  let s = '';
  for (const b of data) {
    if (b === 0) break;
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
  }
  return s.trim();
}

// ---------------------------------------------------------------------------------------------
// Modbus schemas (spec 6.3, 6.4, 7)
// ---------------------------------------------------------------------------------------------

/**
 * Modbus register field (u16, or u32 over two registers, high word first).
 * @param {string} id
 * @param {number} register
 * @param {NumericMeta & { words?: 1|2 }} codec
 * @param {Partial<SettingField>} [overrides]
 */
function reg(id, register, codec, overrides = {}) {
  return daly(id, { ...overrides, meta: { kind: 'register', register, ...codec } });
}

/**
 * Read-only Modbus register field with a reason.
 * @param {string} id
 * @param {number} register
 * @param {NumericMeta & { words?: 1|2 }} codec
 * @param {Partial<SettingField>} [overrides]
 */
function roReg(id, register, codec, overrides = {}) {
  // Read-only fields never get cross-field checks: they cannot be edited.
  return reg(id, register, codec, { description: INFERRED_81, ...overrides, readOnly: true, validate: undefined });
}

/** D2 register blocks loaded by readSettings (spec 4.3, 5.4). */
export const D2_SETTING_BLOCKS = Object.freeze([
  { start: 0x0080, count: 41, name: 'settings' },
  { start: 0x00c9, count: 3, name: 'password' },
  { start: 0x00cc, count: 2, name: 'production date' },
]);

/**
 * D2 schema. `balancerSwitch` adds the switch of Daly active balancers (register 0x00CF), which
 * is offered only when the device answers that register with 0 or 1: on BMS boards the vendor list
 * places the cloud server address there (spec 6.3).
 * @param {{ balancerSwitch?: boolean }} [opts]
 * @returns {SettingsSchema}
 */
export function buildD2Schema({ balancerSwitch = false } = {}) {
  const mv = { scale: 0.001 };
  const dv = { scale: 0.1 };
  const t40 = { add: -40 };
  const fields = [
    reg('cell.ov_alarm', 0x008b, mv, { ...volts('cell_voltage'), description: LEVEL1 }),
    reg('cell.ovp', 0x008c, mv, { ...volts('cell_voltage'), description: LEVEL2 }),
    reg('cell.uv_alarm', 0x008d, mv, { ...volts('cell_voltage'), description: LEVEL1 }),
    reg('cell.uvp', 0x008e, mv, { ...volts('cell_voltage'), description: LEVEL2 }),
    reg('cell.diff_alarm', 0x009f, mv, { group: 'cell_voltage', unit: 'V', decimals: 3, ...CELL_DIFF, description: LEVEL1 }),
    reg('cell.diff_protection', 0x00a0, mv, { group: 'cell_voltage', unit: 'V', decimals: 3, ...CELL_DIFF, description: LEVEL2 }),
    reg('daly.cell_nominal_voltage', 0x0081, mv, { ...volts('cell_voltage'), advanced: true }),
    reg('pack.ov_alarm', 0x008f, dv, { ...packVolts, description: LEVEL1 }),
    reg('pack.ovp', 0x0090, dv, { ...packVolts, description: LEVEL2 }),
    reg('pack.uv_alarm', 0x0091, dv, { ...packVolts, description: LEVEL1 }),
    reg('pack.uvp', 0x0092, dv, { ...packVolts, description: LEVEL2 }),
    reg('charge.oc_alarm', 0x0093, { codec: 'charge-current' }, { ...amps, description: LEVEL1 }),
    reg('charge.ocp', 0x0094, { codec: 'charge-current' }, { ...amps, description: LEVEL2 }),
    reg('discharge.oc_alarm', 0x0095, { codec: 'discharge-current' }, { ...amps, description: LEVEL1 }),
    reg('discharge.ocp', 0x0096, { codec: 'discharge-current' }, { ...amps, description: LEVEL2 }),
    reg('daly.charge_ot_alarm', 0x0097, t40, { ...degrees, description: LEVEL1 }),
    reg('charge.otp', 0x0098, t40, { ...degrees, description: LEVEL2 }),
    reg('daly.charge_ut_alarm', 0x0099, t40, { ...degrees, description: LEVEL1 }),
    reg('charge.utp', 0x009a, t40, { ...degrees, description: LEVEL2 }),
    reg('daly.discharge_ot_alarm', 0x009b, t40, { ...degrees, description: LEVEL1 }),
    reg('discharge.otp', 0x009c, t40, { ...degrees, description: LEVEL2 }),
    reg('daly.discharge_ut_alarm', 0x009d, t40, { ...degrees, description: LEVEL1 }),
    reg('discharge.utp', 0x009e, t40, { ...degrees, description: LEVEL2 }),
    reg('temp.diff_alarm', 0x00a1, {}, { min: 1, max: 255, step: 1, description: LEVEL1 }),
    reg('daly.temp_diff_protection', 0x00a2, {}, { group: 'temperature', unit: '°C', decimals: 0, min: 1, max: 255, step: 1, description: LEVEL2 }),
    reg('mos.otp', 0x00a8, t40, { ...degrees, max: 120 }),
    reg('balance.start_voltage', 0x00a3, mv, { ...CELL_V }),
    reg('balance.trigger_delta', 0x00a4, mv, { min: 0.001, max: 1 }),
    reg('capacity.nominal', 0x0080, dv, { min: 0.1, max: 6553.5 }),
    daly('soc.value', { decimals: 1, min: 0, max: 100, meta: { kind: 'soc', register: D2_REG.SOC } }),
    field('switch.charge', { meta: { kind: 'switch', key: 'charge', register: D2_REG.CHARGE_MOS } }),
    field('switch.discharge', { meta: { kind: 'switch', key: 'discharge', register: D2_REG.DISCHARGE_MOS } }),
    field('system.cell_count', { readOnly: true, description: HARDWARE_CONFIG, meta: { kind: 'register-sum', registers: [0x0083, 0x0084, 0x0085] } }),
    field('system.temp_sensor_count', { readOnly: true, description: HARDWARE_CONFIG, meta: { kind: 'register-sum', registers: [0x0086, 0x0087, 0x0088] } }),
    reg('daly.board_count', 0x0082, {}, { label: msg('Acquisition boards'), group: 'system', decimals: 0, readOnly: true, advanced: true, description: HARDWARE_CONFIG }),
    reg('system.battery_type', 0x0089, {}, {
      options: Object.entries(D2_BATTERY_TYPES).map(([value, label]) => ({ value: Number(value), label })),
      danger: true,
      advanced: true,
    }),
    reg('system.sleep_delay', 0x008a, {}, { min: 0, max: 65535, step: 1 }),
    invertCurrentField(),
    field('identity.password', {
      readOnly: true,
      maxLength: 6,
      description: msg('Parameter password of the official app (the app checks it, the BMS does not). Shown but never written.'),
      meta: { kind: 'register-text', register: 0x00c9, length: 6 },
    }),
    field('daly.production_date', { label: msg('Production date'), group: 'identity', type: 'text', readOnly: true, description: PRODUCTION_DATE, meta: { kind: 'register-date', register: 0x00cc } }),
    field('daly.restart', {
      label: msg('Restart BMS'),
      group: 'actions',
      type: 'action',
      danger: true,
      description: msg('Writes 1 to register 0x00F0 (value taken from one implementation). The output may be interrupted while the BMS restarts.'),
      meta: { kind: 'action', register: D2_REG.RESTART, value: 1 },
    }),
    field('daly.shutdown', {
      label: msg('Switch BMS off'),
      group: 'actions',
      type: 'action',
      danger: true,
      description: msg('Writes 1 to register 0x00F1 (value taken from one implementation). The BMS stops answering.'),
      meta: { kind: 'action', register: D2_REG.SHUTDOWN, value: 1 },
    }),
    field('daly.current_zero', {
      label: msg('Zero current calibration'),
      group: 'actions',
      type: 'action',
      danger: true,
      description: msg('Writes 1 to register 0x00F2 (value taken from one implementation). Run it only while no current flows.'),
      meta: { kind: 'action', register: D2_REG.CURRENT_ZERO, value: 1 },
    }),
    // Left out on purpose: register 0x00F3 ("reset"; syssi calls it factory reset), because what it
    // resets is not confirmed, and the clock write to 0x00D4 (function 0x10), seen only on an active
    // balancer and unverified on BMS firmware (spec 5.4).
  ];
  if (balancerSwitch) {
    fields.splice(
      fields.findIndex((f) => f.id === 'switch.discharge') + 1,
      0,
      field('switch.balance', {
        danger: true,
        description: msg('Switch of Daly active balancers (register 0x00CF). On BMS boards this register belongs to the cloud server address.'),
        meta: { kind: 'switch', key: 'balance', register: D2_REG.BALANCER },
      }),
    );
  }
  return buildSchema(fields);
}

/** 0x81 map register blocks loaded by readSettings (spec 4.4). */
export const P81_SETTING_BLOCKS = Object.freeze([
  { start: 0x00a4, count: 10, name: 'allowed currents' },
  { start: 0x00cf, count: 1, name: 'balancer switch' },
  { start: 0x0100, count: 81, name: 'settings block 1' },
  { start: 0x0151, count: 39, name: 'settings block 2' },
  { start: 0x01c3, count: 80, name: 'settings block 3' },
]);

/** @returns {SettingsSchema} */
export function buildP81Schema() {
  const mv = { scale: 0.001 };
  const dv = { scale: 0.1 };
  const t40 = { add: -40 };
  const raw = { decimals: 0, unit: '', description: msg('Register location inferred from one capture and unit not confirmed, so the raw value is shown but never written.') };
  return buildSchema([
    roReg('cell.ov_alarm', 0x0130, mv, { ...volts('cell_voltage') }),
    roReg('cell.ovp', 0x0131, mv, { ...volts('cell_voltage') }),
    roReg('cell.ovpr', 0x0132, mv, { ...volts('cell_voltage') }),
    roReg('cell.ovp_delay', 0x0133, {}, raw),
    roReg('cell.uv_alarm', 0x0134, mv, { ...volts('cell_voltage') }),
    roReg('cell.uvp', 0x0135, mv, { ...volts('cell_voltage') }),
    roReg('cell.uvpr', 0x0136, mv, { ...volts('cell_voltage') }),
    roReg('cell.uvp_delay', 0x0137, {}, raw),
    roReg('cell.diff_alarm', 0x015a, mv, { group: 'cell_voltage', unit: 'V', decimals: 3 }),
    roReg('cell.diff_protection', 0x015b, mv, { group: 'cell_voltage', unit: 'V', decimals: 3 }),
    roReg('daly.cell_nominal_voltage', 0x0114, mv, { ...volts('cell_voltage'), advanced: true }),
    roReg('pack.ov_alarm', 0x0138, dv, packVolts),
    roReg('pack.ovp', 0x0139, dv, packVolts),
    roReg('pack.ovpr', 0x013a, dv, packVolts),
    roReg('pack.uv_alarm', 0x013c, dv, packVolts),
    roReg('pack.uvp', 0x013d, dv, packVolts),
    roReg('pack.uvpr', 0x013e, dv, packVolts),
    roReg('charge.oc_alarm', 0x0140, { codec: 'charge-current' }, amps),
    roReg('charge.ocp', 0x0141, { codec: 'charge-current' }, amps),
    roReg('daly.charge_ocp3', 0x0143, { codec: 'charge-current' }, { ...amps, label: msg('Charge overcurrent protection, level 3') }),
    roReg('discharge.oc_alarm', 0x0145, { codec: 'discharge-current' }, amps),
    roReg('discharge.ocp', 0x0146, { codec: 'discharge-current' }, amps),
    roReg('discharge.ocp2', 0x0148, { codec: 'discharge-current' }, { ...amps, label: msg('Discharge overcurrent protection, level 3') }),
    roReg('daly.allowed_charge_current', 0x00a6, dv, { label: msg('Allowed charge current'), ...amps }),
    roReg('daly.allowed_discharge_current', 0x00a7, dv, { label: msg('Allowed discharge current'), ...amps }),
    roReg('daly.charge_ot_alarm', 0x014a, t40, degrees),
    roReg('charge.otp', 0x014b, t40, degrees),
    roReg('charge.otpr', 0x014c, t40, degrees),
    roReg('daly.charge_ut_alarm', 0x014e, t40, degrees),
    roReg('charge.utp', 0x014f, t40, degrees),
    roReg('charge.utpr', 0x0150, t40, degrees),
    roReg('daly.discharge_ot_alarm', 0x0152, t40, degrees),
    roReg('discharge.otp', 0x0153, t40, degrees),
    roReg('discharge.otpr', 0x0154, t40, degrees),
    roReg('daly.discharge_ut_alarm', 0x0156, t40, degrees),
    roReg('discharge.utp', 0x0157, t40, degrees),
    roReg('temp.diff_alarm', 0x015e, {}, {}),
    roReg('daly.temp_diff_protection', 0x015f, {}, { group: 'temperature', unit: '°C', decimals: 0 }),
    roReg('mos.otp', 0x0167, t40, degrees),
    roReg('capacity.nominal', 0x0109, { words: 2, scale: 0.001 }, {}),
    daly('soc.value', { decimals: 1, min: 0, max: 100, meta: { kind: 'soc', register: P81_REG.SOC } }),
    roReg('daly.soh', 0x0117, dv, { label: msg('State of health'), group: 'capacity', unit: '%', decimals: 1 }),
    roReg('daly.cumulative_charge', 0x010d, { words: 2 }, { ...raw, label: msg('Cumulative charge (raw)'), group: 'capacity', advanced: true }),
    roReg('daly.cumulative_discharge', 0x010f, { words: 2 }, { ...raw, label: msg('Cumulative discharge (raw)'), group: 'capacity', advanced: true }),
    field('switch.charge', { meta: { kind: 'switch', key: 'charge', register: P81_REG.CHARGE_MOS } }),
    field('switch.discharge', { meta: { kind: 'switch', key: 'discharge', register: P81_REG.DISCHARGE_MOS } }),
    field('switch.balance', {
      readOnly: true,
      description: msg('Balancer switch register 0x00CF (any value other than 0 means on). Writing it is not confirmed for this protocol version, so it is shown but never written.'),
      meta: { kind: 'register-flag', register: 0x00cf },
    }),
    field('switch.heater', { label: msg('Force heater on'), meta: { kind: 'register-flag', register: P81_REG.FORCE_HEATER } }),
    field('daly.force_fan', { label: msg('Force fan on'), group: 'controls', type: 'boolean', meta: { kind: 'register-flag', register: P81_REG.FORCE_FAN } }),
    field('system.cell_count', { readOnly: true, description: INFERRED_81, meta: { kind: 'register-sum', registers: [0x0103, 0x0104, 0x0105] } }),
    field('system.temp_sensor_count', { readOnly: true, description: INFERRED_81, meta: { kind: 'register-sum', registers: [0x0106, 0x0107, 0x0108] } }),
    roReg('daly.board_count', 0x0102, {}, { label: msg('Acquisition boards'), group: 'system', decimals: 0, advanced: true }),
    roReg('system.address', 0x0100, {}, {
      description: msg('Board number; the Modbus address is 0x80 plus this number. Changing it changes the address, so it is shown but never written.'),
    }),
    reg('system.sleep_delay', P81_REG.SLEEP, { scale: 10 }, {
      min: 10,
      max: 655350,
      step: 10,
      description: msg('Set in steps of 10 s; 655350 s means the BMS never goes to sleep.'),
    }),
    invertCurrentField(),
    field('identity.password', { readOnly: true, maxLength: 6, description: INFERRED_81, meta: { kind: 'register-text', register: 0x0126, length: 6 } }),
    field('daly.production_date', { label: msg('Production date'), group: 'identity', type: 'text', readOnly: true, description: INFERRED_81, meta: { kind: 'register-date', register: 0x0129 } }),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Modbus conversion
// ---------------------------------------------------------------------------------------------

/**
 * Raw value of a register field from a register image (u32 fields read two registers, high word
 * first). Undefined when a register was not read.
 * @param {{ register: number, words?: number }} meta
 * @param {Map<number, number>} regs
 */
export function registerRaw(meta, regs) {
  const hi = regs.get(meta.register);
  if (hi === undefined) return undefined;
  if (meta.words !== 2) return hi;
  const lo = regs.get(meta.register + 1);
  return lo === undefined ? undefined : hi * 65536 + lo;
}

/**
 * Raw u16 value to write for a register field. Throws when it does not fit.
 * @param {NumericMeta} meta
 * @param {number} value
 */
export function registerWriteValue(meta, value) {
  const raw = valueToRaw(meta, value);
  if (!Number.isFinite(raw) || raw < 0 || raw > 0xffff) throw new Error(msg('The value is outside the range the BMS can store'));
  return raw;
}

/**
 * Decode Modbus settings from a register image.
 * @param {SettingsSchema} schema
 * @param {Map<number, number>} regs register address to raw value
 * @returns {Record<string, any>}
 */
export function decodeRegisterSettings(schema, regs) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const meta = f.meta ?? {};
      if (meta.kind === 'register') {
        const raw = registerRaw(meta, regs);
        if (raw !== undefined) values[f.id] = rawToValue(meta, raw, f.decimals ?? 3);
      } else if (meta.kind === 'register-flag') {
        const raw = regs.get(meta.register);
        if (raw !== undefined) values[f.id] = raw !== 0;
      } else if (meta.kind === 'register-sum') {
        const parts = meta.registers.map((/** @type {number} */ a) => regs.get(a));
        if (parts.every((/** @type {number | undefined} */ v) => v !== undefined)) values[f.id] = parts.reduce((/** @type {number} */ s, /** @type {number} */ v) => s + v, 0);
      } else if (meta.kind === 'register-text') {
        const bytes = [];
        for (let i = 0; i < meta.length / 2; i++) {
          const v = regs.get(meta.register + i);
          if (v === undefined) break;
          bytes.push(v >> 8, v & 0xff);
        }
        if (bytes.length === meta.length) values[f.id] = asciiTrim(Uint8Array.from(bytes));
      } else if (meta.kind === 'register-date') {
        const a = regs.get(meta.register);
        const b = regs.get(meta.register + 1);
        if (a !== undefined && b !== undefined) values[f.id] = `${2000 + (a >> 8)}-${String(a & 0xff).padStart(2, '0')}-${String(b >> 8).padStart(2, '0')}`;
      }
    }
  }
  return values;
}

/**
 * Store a block of register values into a register image.
 * @param {Map<number, number>} regs
 * @param {number} start
 * @param {number[]} values
 */
export function storeRegisters(regs, start, values) {
  values.forEach((v, i) => regs.set(start + i, v));
}
