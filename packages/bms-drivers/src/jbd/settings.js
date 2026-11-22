import { field, buildSchema, relation, msg } from '@ubms/bms-core';
import { r } from '../common/util.js';
import { AFE, CONTROL, FUNC_UNIT_BIT, REGISTERS, VARIANT, dateFromRaw, isModulePassword, parseMac, formatMac, scaledValue, shuntFromRaw, tempFromRaw, tempToRaw } from './protocol.js';

/**
 * JBD settings schema and raw/engineering conversion (docs/protocols/jbd.md section 7, "spec").
 *
 * Safety rule: whatever the specification marks unverified, inferred or conflicting is `readOnly`
 * with a description saying why. Writable fields are EEPROM registers whose encoding several
 * sources agree on and the captures confirm (spec 7.2); they are written one register at a time
 * inside factory mode, read back, and saved with exit `28 28` (spec 4.4, 7.1).
 *
 * Field `meta` (driver private):
 * - `{ kind: 'reg', register }` single value register of REGISTERS (u16, s16neg, temp, date,
 *   shunt, string)
 * - `{ kind: 'pair', register, byte }` one byte of a delay pair register (0x3A..0x3F)
 * - `{ kind: 'bit', register, bit }` one bit of 0x2D (function configuration) or 0x2E (NTCs)
 * - `{ kind: 'word', register }` the whole register shown as hex text (0x2D)
 * - `{ kind: 'raw', register }` the raw u16 of a register whose unit is disputed (0x14)
 * - `{ kind: 'afe', register, part }` read-only view of the AFE registers 0x38 / 0x39
 * - `{ kind: 'mos', key }` MOSFET software switch 0xE1, value = state reported by 0x03
 * - `{ kind: 'control', code }` V11 control command 0x0A (action)
 * - `{ kind: 'local', option }` value kept in the target options (module login, BMS password)
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 *
 * @typedef {Object} SchemaOptions
 * @property {boolean} [unit100] bit 12 of 0x2D is set: capacities and currents in 100 mAh / 100 mA
 * @property {Set<number>} [missing] registers the BMS refused or did not answer: their fields are hidden
 * @property {boolean} [ble] the link is Bluetooth (module login fields)
 * @property {boolean} [locked] the Bluetooth module waits for the login: only the login fields
 * @property {string} [variant] protocol variant; Daren clones get no fields (spec 1.3, 11.4)
 */

/** Optional registers: older firmware refuses them with status 0x80 (spec 7.2, 12 item 24). */
export const OPTIONAL_REGISTERS = Object.freeze([0x31, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);

/** Registers read for the settings screen, in the order of the official app (spec 4.4, [SN]). */
export const SETTINGS_REGISTERS = Object.freeze([
  0x2d, 0x2e, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a,
  0x2b, 0x2c, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0xa0, 0xa1, 0xa2,
]);

const UNIT_RO = msg(
  'The BMS uses 100 mA and 100 mAh units (function configuration bit 12). Writing in that mode is not confirmed by any capture, so the value is shown but never written.',
);
const PAIR_ORDER = msg(
  'The byte order of this delay pair is documented by four sources, but every capture holds the same value in both bytes, and one source calls it a release delay. It is not confirmed, so the value is shown but never written.',
);
const CONFLICT_14 = msg(
  'Raw value of register 0x14. One source reads it as self discharge rate in 0.1 %, the vendor document as system power consumption in mA, so it is shown but never written.',
);
const MEANING_UNVERIFIED = msg('The meaning of this register is not confirmed, so it is shown but never written.');
const STORED = msg('Stored by the manufacturer, shown only.');
const FACTORY_DATA = msg('Stored by the manufacturer, shown only. String writes are encoded differently by the known tools.');
const AFE_RO = msg(
  'Decoded with the tables of the TI bq769x0 front end. Other front end chips use other tables, and the chip type cannot be read, so the value is shown but never written.',
);
const HW_DELAY_RO = msg('Two sources assign the two hardware delay fields the other way round, so the value is shown but never written.');
const SOC100_RO = msg('Present on firmware 0x20 and later. How it relates to the full voltage register 0x12 is not confirmed, so it is shown but never written.');
const SOC_TABLE = msg('Cell voltage of this point of the SOC table (firmware 0x20 and later).');
const CELL_COUNT = msg('Must match the number of connected cells. A wrong value raises cell count and voltage protections.');
const HW_LEVEL = msg('Second level protection of the analog front end. It acts independently of the software and must lie beyond the first level.');
const UNIT_FLAG = msg('Set by the manufacturer for large packs: currents and capacities in 100 mA and 100 mAh. Shown only.');
const FUNCTION_WORD = msg('Raw function configuration word (register 0x2D). Bits 6 to 13 have disputed meanings and are kept unchanged on every write.');
const MOS_SWITCH = msg(
  'Software switch of the BMS (command 0xE1). Switching off holds the MOSFET off until it is switched on again; a protection can keep it off regardless. Whether the state survives a power cycle is not confirmed.',
);
const RESET_CAPACITY = msg('Control command 0x0A, code 0x0100: the BMS estimates the remaining capacity again from the cell voltages. Older boards refuse it.');
const CLEAR_PROTECTION = msg('Control command 0x0A, code 0x0400: clears the protection and alarm states. Older boards refuse it. A protection whose cause persists returns.');
const MODULE_PASSWORD = msg(
  'Six letter or digit password of the Bluetooth module (2024 modules with login). Kept in this app only and used together with the device address to log in.',
);
const MODULE_ADDRESS = msg(
  'Bluetooth address of the BMS module, for example A4:C1:37:04:2D:BE (shown in the vendor app). Browsers do not reveal it, but the module login needs it.',
);
const BMS_PASSWORD = msg('Six character password of the BMS itself (register 0x06), sent only when the BMS refuses factory mode. Kept in this app only.');
const LOAD_DETECT = msg('Release a short circuit protection only after the load was disconnected.');
const SWITCH_INPUT = msg(
  'Use the external switch input of the board to turn the BMS on and off. On a pack without that switch the output can stay off.',
);
const NTC_ENABLE = msg('Disabling a sensor switches its temperature protection off.');

const HIGH_ABOVE_RECOVERY = msg('The protection must be above its recovery value');
const RECOVERY_BELOW_HIGH = msg('The recovery value must be below the protection');
const LOW_BELOW_RECOVERY = msg('The protection must be below its recovery value');
const RECOVERY_ABOVE_LOW = msg('The recovery value must be above the protection');
const UV_BELOW_OV = msg('The undervoltage protection must be below the overvoltage protection');
const UT_BELOW_OT = msg('The undertemperature protection must be below the overtemperature protection');
const BALANCE_BELOW_OVP = msg('Balance start voltage must be below overvoltage protection');
const OVP_ABOVE_BALANCE = msg('Overvoltage protection must be above the balance start voltage');

/** Ids of the NTC enable bits of 0x2E. */
const NTC_IDS = Array.from({ length: 8 }, (_, i) => `jbd.ntc_enable_${i + 1}`);

/** @param {Record<string, any>} values */
function allNtcOff(values) {
  const bits = NTC_IDS.map((id) => values[id]).filter((v) => typeof v === 'boolean');
  return bits.length > 0 && bits.every((v) => !v) ? msg('Every temperature sensor is disabled: charge and discharge temperature protection is off') : null;
}

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

const CELL_V = { min: 1, max: 5, step: 0.001, decimals: 3 };
const PACK_V = { min: 1, max: 655.35, step: 0.01, decimals: 2 };
const TEMP = { min: -40, max: 120, step: 0.1, decimals: 1 };
const DELAY = { min: 0, max: 255, step: 1, decimals: 0, unit: 's' };

/** SOC table from 0 % to 100 % (the 0x47 copy of 100 % is not part of it). */
const SOC_TABLE_IDS = [
  'charge.soc0_voltage',
  'jbd.soc10_voltage',
  'jbd.soc20_voltage',
  'jbd.soc30_voltage',
  'jbd.soc40_voltage',
  'jbd.soc50_voltage',
  'jbd.soc60_voltage',
  'jbd.soc70_voltage',
  'jbd.soc80_voltage',
  'jbd.soc90_voltage',
  'charge.soc100_voltage',
];

/** @param {Record<string, any>} values */
function socTableWarning(values) {
  const points = SOC_TABLE_IDS.map((id) => values[id]).filter((v) => Number.isFinite(v));
  for (let i = 1; i < points.length; i++) if (points[i] <= points[i - 1]) return msg('The SOC voltage table should rise from 0 % to 100 %');
  return null;
}

/**
 * Pack limit against cell limit times cell count (spec 7.7): warn when they differ by more than
 * one cell step.
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

/**
 * Build the JBD schema (spec 7.7).
 * @param {SchemaOptions} [opts]
 * @returns {SettingsSchema}
 */
export function buildJbdSchema({ unit100 = false, missing = new Set(), ble = false, locked = false, variant } = {}) {
  /** @type {SettingField[]} */
  const fields = [];
  /** @param {SettingField} f */
  const add = (f) => {
    const reg = f.meta?.register;
    if (reg !== undefined && missing.has(reg)) return;
    fields.push(f);
  };
  const local = () => {
    if (ble) {
      add(field('jbd.module_password', { label: msg('Bluetooth module password'), group: 'identity', type: 'text', maxLength: 6, description: MODULE_PASSWORD, secret: true, meta: { kind: 'local', option: 'password' } }));
      add(field('jbd.module_address', { label: msg('Bluetooth device address'), group: 'identity', type: 'text', maxLength: 17, description: MODULE_ADDRESS, meta: { kind: 'local', option: 'address' } }));
    }
  };
  if (locked) {
    local();
    return buildSchema(fields);
  }
  // Daren clones: no source documents factory mode, the EEPROM map, 0xE1 or 0x0A on them ([AIO]
  // daren_bms.py uses 0x03, 0x04, 0x05, 0x08 and 0xFF only), so nothing is read or written.
  if (variant === VARIANT.DAREN) return buildSchema(fields);
  /**
   * @param {string} id
   * @param {number} register
   * @param {Partial<SettingField>} [props]
   */
  const reg = (id, register, props = {}) => add(field(id, { ...props, meta: { kind: 'reg', register } }));
  /**
   * @param {string} id
   * @param {number} register
   * @param {0|1} byte
   * @param {Partial<SettingField>} [props]
   */
  const pair = (id, register, byte, props = {}) => add(field(id, { ...DELAY, ...props, meta: { kind: 'pair', register, byte } }));
  /**
   * @param {string} id
   * @param {number} register
   * @param {number} bit
   * @param {Partial<SettingField>} [props]
   */
  const bit = (id, register, bit, props = {}) => add(field(id, { type: 'boolean', ...props, meta: { kind: 'bit', register, bit } }));
  const scaled = unit100 ? { readOnly: true, description: UNIT_RO } : {};
  const k = unit100 ? 10 : 1;
  /** Delay pairs 0x3A..0x3D: byte order not confirmed by a capture (spec 7.2). */
  const pairRo = { readOnly: true, description: PAIR_ORDER };

  // Cell voltage (spec 7.2: 0x24..0x27, 0x3D, 0x36, 0x37)
  reg('cell.ovp', 0x24, {
    ...CELL_V,
    validate: all(relation('cell.ovp', '>', 'cell.ovpr', HIGH_ABOVE_RECOVERY), relation('cell.ovp', '>', 'cell.uvp', UV_BELOW_OV), relation('cell.ovp', '>', 'balance.start_voltage', OVP_ABOVE_BALANCE)),
  });
  reg('cell.ovpr', 0x25, { ...CELL_V, validate: relation('cell.ovpr', '<', 'cell.ovp', RECOVERY_BELOW_HIGH) });
  pair('cell.ovp_delay', 0x3d, 1, pairRo);
  reg('cell.uvp', 0x26, { ...CELL_V, validate: all(relation('cell.uvp', '<', 'cell.uvpr', LOW_BELOW_RECOVERY), relation('cell.uvp', '<', 'cell.ovp', UV_BELOW_OV)) });
  reg('cell.uvpr', 0x27, { ...CELL_V, validate: relation('cell.uvpr', '>', 'cell.uvp', RECOVERY_ABOVE_LOW) });
  pair('cell.uvp_delay', 0x3d, 0, pairRo);
  reg('jbd.cell_ovp_hw', 0x36, {
    label: msg('Cell overvoltage protection, hardware level'),
    group: 'cell_voltage',
    unit: 'V',
    ...CELL_V,
    advanced: true,
    danger: true,
    description: HW_LEVEL,
    warn: (v) => (Number.isFinite(v['jbd.cell_ovp_hw']) && Number.isFinite(v['cell.ovp']) && v['jbd.cell_ovp_hw'] <= v['cell.ovp'] ? msg('The hardware level should be above the cell overvoltage protection') : null),
  });
  reg('jbd.cell_uvp_hw', 0x37, {
    label: msg('Cell undervoltage protection, hardware level'),
    group: 'cell_voltage',
    unit: 'V',
    ...CELL_V,
    advanced: true,
    danger: true,
    description: HW_LEVEL,
    warn: (v) => (Number.isFinite(v['jbd.cell_uvp_hw']) && Number.isFinite(v['cell.uvp']) && v['jbd.cell_uvp_hw'] >= v['cell.uvp'] ? msg('The hardware level should be below the cell undervoltage protection') : null),
  });

  // Pack voltage (0x20..0x23, 0x3C)
  reg('pack.ovp', 0x20, { ...PACK_V, validate: all(relation('pack.ovp', '>', 'pack.ovpr', HIGH_ABOVE_RECOVERY), relation('pack.ovp', '>', 'pack.uvp', UV_BELOW_OV)), warn: packWarning('pack.ovp', 'cell.ovp') });
  reg('pack.ovpr', 0x21, { ...PACK_V, validate: relation('pack.ovpr', '<', 'pack.ovp', RECOVERY_BELOW_HIGH) });
  pair('jbd.pack_ovp_delay', 0x3c, 1, { label: msg('Pack overvoltage delay'), group: 'pack_voltage', ...pairRo });
  reg('pack.uvp', 0x22, { ...PACK_V, validate: all(relation('pack.uvp', '<', 'pack.uvpr', LOW_BELOW_RECOVERY), relation('pack.uvp', '<', 'pack.ovp', UV_BELOW_OV)), warn: packWarning('pack.uvp', 'cell.uvp') });
  reg('pack.uvpr', 0x23, { ...PACK_V, validate: relation('pack.uvpr', '>', 'pack.uvp', RECOVERY_ABOVE_LOW) });
  pair('jbd.pack_uvp_delay', 0x3c, 0, { label: msg('Pack undervoltage delay'), group: 'pack_voltage', ...pairRo });

  // Current (0x28, 0x29, 0x3E, 0x3F, AFE 0x38, 0x39)
  // 0 A would make the protection trip on any current: 1 A is the ubms minimum (spec 7.6).
  reg('charge.ocp', 0x28, { decimals: unit100 ? 1 : 2, min: 1, max: r(327.67 * k, 2), ...scaled });
  pair('charge.ocp_delay', 0x3e, 0);
  pair('charge.ocp_recovery', 0x3e, 1);
  reg('discharge.ocp', 0x29, { decimals: unit100 ? 1 : 2, min: 1, max: r(327.68 * k, 2), ...scaled });
  pair('discharge.ocp_delay', 0x3f, 0);
  pair('discharge.ocp_recovery', 0x3f, 1);
  const afe = { readOnly: true, advanced: true, description: AFE_RO };
  add(field('scp.delay', { ...afe, meta: { kind: 'afe', register: 0x38, part: 'scdDelayUs' } }));
  add(field('jbd.sc_threshold', { label: msg('Short circuit threshold (shunt voltage)'), group: 'current', unit: 'mV', decimals: 0, ...afe, meta: { kind: 'afe', register: 0x38, part: 'scdThresholdMv' } }));
  add(field('discharge.ocp2_delay', { ...afe, meta: { kind: 'afe', register: 0x38, part: 'ocdDelayMs' } }));
  add(field('jbd.ocd2_threshold', { label: msg('Discharge overcurrent level 2 threshold (shunt voltage)'), group: 'current', unit: 'mV', decimals: 0, ...afe, meta: { kind: 'afe', register: 0x38, part: 'ocdThresholdMv' } }));
  add(field('scp.recovery', { readOnly: true, advanced: true, description: msg('Byte 1 of register 0x39. Shown only, because the other byte holds front end delays whose encoding is chip dependent.'), meta: { kind: 'afe', register: 0x39, part: 'scpRecoveryS' } }));

  // Temperature (0x18..0x1F, 0x3A, 0x3B)
  reg('charge.otp', 0x18, { ...TEMP, validate: all(relation('charge.otp', '>', 'charge.otpr', HIGH_ABOVE_RECOVERY), relation('charge.otp', '>', 'charge.utp', UT_BELOW_OT)) });
  reg('charge.otpr', 0x19, { ...TEMP, validate: relation('charge.otpr', '<', 'charge.otp', RECOVERY_BELOW_HIGH) });
  pair('jbd.charge_otp_delay', 0x3a, 1, { label: msg('Charge overtemperature delay'), group: 'temperature', ...pairRo });
  reg('charge.utp', 0x1a, { ...TEMP, validate: all(relation('charge.utp', '<', 'charge.utpr', LOW_BELOW_RECOVERY), relation('charge.utp', '<', 'charge.otp', UT_BELOW_OT)) });
  reg('charge.utpr', 0x1b, { ...TEMP, validate: relation('charge.utpr', '>', 'charge.utp', RECOVERY_ABOVE_LOW) });
  pair('jbd.charge_utp_delay', 0x3a, 0, { label: msg('Charge undertemperature delay'), group: 'temperature', ...pairRo });
  reg('discharge.otp', 0x1c, { ...TEMP, validate: all(relation('discharge.otp', '>', 'discharge.otpr', HIGH_ABOVE_RECOVERY), relation('discharge.otp', '>', 'discharge.utp', UT_BELOW_OT)) });
  reg('discharge.otpr', 0x1d, { ...TEMP, validate: relation('discharge.otpr', '<', 'discharge.otp', RECOVERY_BELOW_HIGH) });
  pair('jbd.discharge_otp_delay', 0x3b, 1, { label: msg('Discharge overtemperature delay'), group: 'temperature', ...pairRo });
  reg('discharge.utp', 0x1e, { ...TEMP, validate: all(relation('discharge.utp', '<', 'discharge.utpr', LOW_BELOW_RECOVERY), relation('discharge.utp', '<', 'discharge.otp', UT_BELOW_OT)) });
  reg('discharge.utpr', 0x1f, { ...TEMP, validate: relation('discharge.utpr', '>', 'discharge.utp', RECOVERY_ABOVE_LOW) });
  pair('jbd.discharge_utp_delay', 0x3b, 0, { label: msg('Discharge undertemperature delay'), group: 'temperature', ...pairRo });

  // Balancing (0x2D bits 2 and 3, 0x2A, 0x2B)
  bit('balance.enabled', 0x2d, 2);
  bit('balance.charge_only', 0x2d, 3);
  reg('balance.start_voltage', 0x2a, { ...CELL_V, validate: relation('balance.start_voltage', '<', 'cell.ovp', BALANCE_BELOW_OVP) });
  reg('balance.trigger_delta', 0x2b, { min: 0.001, max: 1, step: 0.001, decimals: 3 });

  // Capacity and SOC table (0x10..0x13, 0x32..0x35, 0x42..0x47)
  reg('capacity.nominal', 0x10, {
    decimals: unit100 ? 1 : 2,
    min: r(0.01 * k, 2),
    max: r(655.35 * k, 2),
    ...scaled,
    warn: (v) => (Number.isFinite(v['capacity.cycle']) && Number.isFinite(v['capacity.nominal']) && v['capacity.cycle'] > v['capacity.nominal'] ? msg('The cycle capacity is larger than the nominal capacity') : null),
  });
  reg('capacity.cycle', 0x11, { description: msg('Discharged capacity that counts as one cycle.'), decimals: unit100 ? 1 : 2, min: r(0.01 * k, 2), max: r(655.35 * k, 2), ...scaled });
  const socV = { group: 'capacity', unit: 'V', ...CELL_V };
  reg('charge.soc100_voltage', 0x12, { ...CELL_V, warn: socTableWarning });
  reg('jbd.soc90_voltage', 0x42, { label: msg('Cell voltage at 90 % SOC'), ...socV, description: SOC_TABLE });
  reg('jbd.soc80_voltage', 0x32, { label: msg('Cell voltage at 80 % SOC'), ...socV });
  reg('jbd.soc70_voltage', 0x43, { label: msg('Cell voltage at 70 % SOC'), ...socV, description: SOC_TABLE });
  reg('jbd.soc60_voltage', 0x33, { label: msg('Cell voltage at 60 % SOC'), ...socV });
  reg('jbd.soc50_voltage', 0x44, { label: msg('Cell voltage at 50 % SOC'), ...socV, description: SOC_TABLE });
  reg('jbd.soc40_voltage', 0x34, { label: msg('Cell voltage at 40 % SOC'), ...socV });
  reg('jbd.soc30_voltage', 0x45, { label: msg('Cell voltage at 30 % SOC'), ...socV, description: SOC_TABLE });
  reg('jbd.soc20_voltage', 0x35, { label: msg('Cell voltage at 20 % SOC'), ...socV });
  reg('jbd.soc10_voltage', 0x46, { label: msg('Cell voltage at 10 % SOC'), ...socV, description: SOC_TABLE });
  reg('charge.soc0_voltage', 0x13, CELL_V);
  reg('jbd.soc100_voltage_table', 0x47, { label: msg('Cell voltage at 100 % SOC (table)'), ...socV, readOnly: true, advanced: true, description: SOC100_RO });

  // Switches (0xE1, state from 0x03)
  add(field('switch.charge', { danger: true, description: MOS_SWITCH, meta: { kind: 'mos', key: 'charge' } }));
  add(field('switch.discharge', { danger: true, description: MOS_SWITCH, meta: { kind: 'mos', key: 'discharge' } }));

  // System (0x2F, 0x2E, 0x2D, read-only registers)
  reg('system.cell_count', 0x2f, { min: 1, max: 32, step: 1, advanced: true, danger: true, description: CELL_COUNT });
  for (let i = 0; i < 8; i++) {
    bit(NTC_IDS[i], 0x2e, i, { label: NTC_LABELS[i], group: 'system', advanced: true, danger: true, description: NTC_ENABLE, ...(i === 0 ? { warn: allNtcOff } : {}) });
  }
  bit('jbd.switch_input', 0x2d, 0, { label: msg('External switch input'), group: 'system', advanced: true, danger: true, description: SWITCH_INPUT });
  bit('jbd.load_detect', 0x2d, 1, { label: msg('Short circuit release by load removal'), group: 'system', advanced: true, description: LOAD_DETECT });
  bit('jbd.led_enable', 0x2d, 4, { label: msg('LED indicator'), group: 'system', advanced: true });
  bit('jbd.led_capacity', 0x2d, 5, { label: msg('Capacity LEDs'), group: 'system', advanced: true });
  bit('jbd.unit_100ma', 0x2d, FUNC_UNIT_BIT, { label: msg('100 mA and 100 mAh units'), group: 'system', advanced: true, readOnly: true, description: UNIT_FLAG });
  add(field('jbd.function_config', { label: msg('Function configuration word'), group: 'system', type: 'text', advanced: true, readOnly: true, description: FUNCTION_WORD, meta: { kind: 'word', register: 0x2d } }));
  reg('jbd.shunt_resistance', 0x2c, { label: msg('Shunt resistance'), group: 'system', unit: 'mΩ', decimals: 2, readOnly: true, advanced: true, description: msg('Current sense resistor. Changing it breaks the current measurement, so it is shown but never written.') });
  reg('jbd.switch_time', 0x30, { label: msg('Switch control time'), group: 'system', unit: 's', decimals: 0, readOnly: true, advanced: true, description: MEANING_UNVERIFIED });
  reg('jbd.led_time', 0x31, { label: msg('LED operating time'), group: 'system', unit: 's', decimals: 0, readOnly: true, advanced: true, description: MEANING_UNVERIFIED });
  add(field('jbd.self_discharge_rate', { label: msg('Register 0x14 (self discharge or power consumption)'), group: 'system', decimals: 0, readOnly: true, advanced: true, description: CONFLICT_14, meta: { kind: 'raw', register: 0x14 } }));

  // Identity (0xA0..0xA2, 0x15..0x17) and the values kept in the app
  const id = { group: 'identity', readOnly: true };
  reg('jbd.manufacturer', 0xa0, { label: msg('Manufacturer'), type: 'text', ...id, description: FACTORY_DATA });
  reg('jbd.model', 0xa1, { label: msg('Model'), type: 'text', ...id, description: FACTORY_DATA });
  reg('jbd.barcode', 0xa2, { label: msg('Barcode'), type: 'text', ...id, description: FACTORY_DATA });
  reg('jbd.serial_number', 0x16, { label: msg('Serial number'), decimals: 0, ...id, description: STORED });
  reg('jbd.production_date', 0x15, { label: msg('Production date'), type: 'text', ...id, description: STORED });
  reg('jbd.cycle_count', 0x17, { label: msg('Cycle count (EEPROM)'), decimals: 0, ...id, advanced: true, description: msg('Cycle counter kept by the BMS, shown only.') });
  local();
  add(field('jbd.bms_password', { label: msg('BMS password'), group: 'identity', type: 'text', maxLength: 6, advanced: true, description: BMS_PASSWORD, secret: true, meta: { kind: 'local', option: 'bmsPassword' } }));

  // Actions (0x0A, spec 8.3): only the codes with two sources
  add(field('jbd.reset_capacity', { label: msg('Recalculate remaining capacity'), group: 'actions', type: 'action', danger: true, description: RESET_CAPACITY, meta: { kind: 'control', code: CONTROL.RESET_CAPACITY } }));
  add(field('jbd.clear_protection', { label: msg('Clear protection states'), group: 'actions', type: 'action', danger: true, description: CLEAR_PROTECTION, meta: { kind: 'control', code: CONTROL.CLEAR_PROTECTION } }));
  return buildSchema(fields);
}

/** Labels of the NTC enable bits (literal for the translation checker). */
const NTC_LABELS = [
  msg('Temperature sensor 1 enabled'),
  msg('Temperature sensor 2 enabled'),
  msg('Temperature sensor 3 enabled'),
  msg('Temperature sensor 4 enabled'),
  msg('Temperature sensor 5 enabled'),
  msg('Temperature sensor 6 enabled'),
  msg('Temperature sensor 7 enabled'),
  msg('Temperature sensor 8 enabled'),
];

/** @param {Uint8Array} d */
const word = (d) => ((d[0] << 8) | d[1]) >>> 0;

/**
 * Engineering value of a field from the register data read in factory mode.
 * @param {SettingField} f
 * @param {Map<number, Uint8Array>} regs data bytes by register
 * @param {{ unit100?: boolean }} [opts]
 * @returns {any} undefined when the register was not read
 */
export function fieldValue(f, regs, { unit100 = false } = {}) {
  const m = f.meta ?? {};
  const d = m.register !== undefined ? regs.get(m.register) : undefined;
  if (!d) return undefined;
  if (m.kind === 'reg') {
    const def = REGISTERS[m.register];
    if (def.kind === 'string') return String.fromCharCode(...d.subarray(1, 1 + (d[0] ?? 0)));
    if (d.length !== 2) return undefined;
    const raw = word(d);
    switch (def.kind) {
      case 'u16':
      case 's16neg':
        return scaledValue(def, raw, { unit100 });
      case 'temp':
        return tempFromRaw(raw);
      case 'date':
        return dateFromRaw(raw) ?? '';
      case 'shunt':
        return shuntFromRaw(raw, { unit100 });
      default:
        return undefined;
    }
  }
  if (d.length !== 2) return undefined;
  if (m.kind === 'pair') return d[m.byte];
  if (m.kind === 'bit') return ((word(d) >> m.bit) & 1) === 1;
  if (m.kind === 'raw') return word(d);
  if (m.kind === 'word') return `0x${word(d).toString(16).toUpperCase().padStart(4, '0')}`;
  if (m.kind === 'afe') {
    if (m.register === 0x39) return m.part === 'scpRecoveryS' ? d[1] : undefined;
    const rsns = (d[0] & 0x80) !== 0;
    if (m.part === 'scdDelayUs') return AFE.SC_DELAY_US[(d[0] >> 3) & 3];
    if (m.part === 'scdThresholdMv') return (rsns ? AFE.SC_MV_RSNS : AFE.SC_MV)[d[0] & 7];
    if (m.part === 'ocdDelayMs') return AFE.OCD2_MS[(d[1] >> 4) & 7];
    if (m.part === 'ocdThresholdMv') return (rsns ? AFE.OCD2_MV_RSNS : AFE.OCD2_MV)[d[1] & 0x0f];
  }
  return undefined;
}

/**
 * Values of every register backed field of a schema.
 * @param {SettingsSchema} schema
 * @param {Map<number, Uint8Array>} regs
 * @param {{ unit100?: boolean }} [opts]
 */
export function decodeJbdSettings(schema, regs, opts = {}) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const v = fieldValue(f, regs, opts);
      if (v !== undefined) values[f.id] = v;
    }
  }
  return values;
}

/**
 * Raw register word for a new value of a writable field (spec 7.1, 7.6). Byte pairs and bit
 * fields are merged into the current word, so bytes and bits ubms does not show stay unchanged.
 * Throws a RangeError for values outside the register.
 * @param {SettingField} f
 * @param {any} value engineering units
 * @param {Uint8Array | undefined} current data of the register as read just before
 * @param {{ unit100?: boolean }} [opts]
 * @returns {number} u16
 */
export function encodeFieldValue(f, value, current, { unit100 = false } = {}) {
  const m = f.meta ?? {};
  if (m.kind === 'reg') {
    const def = REGISTERS[m.register];
    const v = Number(value);
    if (!Number.isFinite(v)) throw new RangeError('not a number');
    if (def.kind === 'temp') {
      const raw = tempToRaw(v);
      if (raw < 0 || raw > 0xffff) throw new RangeError('temperature out of range');
      return raw;
    }
    const scale = /** @type {number} */ (def.scale) * (def.unitScaled && unit100 ? 10 : 1);
    const n = Math.round(r(v / scale, 6));
    if (def.kind === 's16neg') {
      if (n < 0 || n > 0x8000) throw new RangeError('current out of range');
      return (0x10000 - n) & 0xffff;
    }
    if (def.kind !== 'u16' || n < 0 || n > 0xffff) throw new RangeError('value out of range');
    if (m.register === 0x28 && n > 0x7fff) throw new RangeError('current out of range');
    return n;
  }
  if (!current || current.length !== 2) throw new RangeError('the register was not read');
  const old = word(current);
  if (m.kind === 'pair') {
    const b = Math.round(Number(value));
    if (!Number.isInteger(b) || b < 0 || b > 255) throw new RangeError('delay out of range');
    return m.byte === 0 ? ((b << 8) | (old & 0xff)) >>> 0 : ((old & 0xff00) | b) >>> 0;
  }
  if (m.kind === 'bit') return value ? (old | (1 << m.bit)) >>> 0 : old & ~(1 << m.bit) & 0xffff;
  throw new RangeError('not a writable register field');
}

/** Values kept in the target options, as shown in the settings (passwords are never shown). */
export const LOCAL_OPTIONS = Object.freeze({ password: 'jbd.module_password', address: 'jbd.module_address', bmsPassword: 'jbd.bms_password' });

/**
 * Check and normalise a value typed for a local field. Throws an Error with an English message.
 * @param {'password'|'address'|'bmsPassword'} option
 * @param {unknown} value
 */
export function normaliseLocal(option, value) {
  const s = String(value ?? '').trim();
  if (option === 'address') {
    if (s === '') return '';
    const mac = parseMac(s);
    if (!mac) throw new Error(msg('Enter the address as six hexadecimal byte pairs, for example A4:C1:37:04:2D:BE'));
    return formatMac(mac);
  }
  if (option === 'password') {
    if (s !== '' && !isModulePassword(s)) throw new Error(msg('The module password has exactly six letters or digits'));
    return s;
  }
  if (s !== '' && !/^[\x21-\x7e]{6}$/.test(s)) throw new Error(msg('The BMS password has exactly six characters'));
  return s;
}
