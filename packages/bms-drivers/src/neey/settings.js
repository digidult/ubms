import { buildSchema, field, msg } from '@ubms/bms-core';
import { r } from '../common/util.js';
import { COMMAND, FUNCTION, REGISTER, V2_REGISTER, VARIANT, encodeRequest } from './protocol.js';

/**
 * Settings schema of the NEEY balancers (docs/protocols/neey.md sections 5, 7; "spec" below).
 *
 * Writable (spec 7.1): on both variants the balancer switch (command 0x05, register 0x0D), the
 * only register with a captured write followed by a settings frame that shows the new value. On
 * NEEY_V1 also the balance trigger voltage difference, maximum balance current, sleep voltage,
 * balance start voltage and nominal capacity: their encoding is captured from the old NEEY app
 * (xor8 requests to GW SW-1.1.0 and ZH-1.2.3) without a settings frame after the writes in the
 * capture, the sum8 form ubms sends is computed, and on EK firmware they rest on the use by [SY]
 * and [BSC], the maintainer's note for ZH-2.1.1 and one user report for the maximum balance
 * current on an EK-24S20EB. The session reads every write back through the settings frame.
 *
 * Read only, with a description that says why: the V1 values whose write register comes from the
 * vendor app table or one open source project without a capture (cell count 0x01, buzzer mode
 * 0x14, battery type 0x15, balance stop voltage difference 0x1A), and every other V2 value
 * (command 0x05 with balancer registers and command 0x06 are not captured on V2, spec 5.3).
 *
 * No actions: the factory data request 0x03 is not offered, as one source names that command
 * "Factory reset" (spec 5.1, 6.6, 8).
 *
 * Field `meta`: `key` is the parser field name of the settings frame; `write` is the write that
 * is sent ({ command, register, type }); `unverifiedWrite` documents a register that is never sent.
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

const SWITCH_HELP = msg('Switching the balancer off stops all balancing until it is switched on again.');
const SLEEP_HELP = msg('Balancing stops while the cells are below this voltage.');
const MAX_CURRENT_HELP = msg('At most the rating in the model name, for example 4 A for a 24S4EB unit. The vendor recommends at most 0.1 C of the battery capacity.');
const CELL_COUNT_RO = msg(
  'The write register is known only from the command table of the vendor app, without a capture, so the value is shown but never written. A cell count that does not match the wired cells raises an alarm; change it in the vendor app.',
);
const APP_TABLE_RO = msg('The write register and the value list come from the command table of the vendor app only, without a capture, so the value is shown but never written.');
const STOP_DELTA_RO = msg('Firmware ZH-2.1.1 and later. The write register is known from one open source project only, without a capture, so the value is shown but never written.');
const V2_BALANCER_RO = msg('Writing balancer values is confirmed for the 100 byte settings layout only. This model uses the 150 byte layout, so the value is shown but never written.');
const V2_SWAPPED_RO = msg(
  'Offset and meaning come from one open source project and are not confirmed by a capture, so the value is shown but never written. In every capture the value at offset 22 is above the one at offset 26, the opposite of the sleep and start voltages of the 100 byte layout, so the two labels may be swapped.',
);
const V2_LIMIT_RO = msg('The write command for the BMS limits of this model is known from one open source project only, without a capture, so the value is shown but never written.');
const V2_DELAY_RO = msg(
  'The write command for the BMS limits of this model is known from one open source project only, without a capture, so the value is shown but never written. The unit is not confirmed either.',
);
const TRIGGER_WARN = msg('The vendor recommends at least 0.005 V for batteries above 50 Ah and 0.01 V for smaller batteries.');
const TRIGGER_STOP_WARN = msg('The trigger voltage difference should be above the balance stop voltage difference.');
const CURRENT_WARN = msg('The vendor recommends at most 0.1 C of the battery capacity.');
const START_SLEEP_WARN = msg('Every known unit uses a balance start voltage above the sleep voltage.');

/** Buzzer mode (spec 9.4): [SY] BUZZER_MODES; the app table also lists 4 (meaning unverified). */
export const BUZZER_MODES = Object.freeze([
  { value: 1, label: msg('Off') },
  { value: 2, label: msg('Beep once') },
  { value: 3, label: msg('Beep regularly') },
  { value: 4, label: msg('Mode 4 (meaning unknown)') },
]);

/** Battery type (spec 9.5): [SY] BATTERY_TYPES and [BSC]; the app table lists only 1..3 (4 unverified). */
export const BATTERY_TYPES = Object.freeze([
  { value: 1, label: msg('Li-ion (NMC)') },
  { value: 2, label: msg('LiFePO4') },
  { value: 3, label: msg('LTO') },
  { value: 4, label: msg('Lead acid') },
]);

/**
 * @param {number} register
 * @param {'u32'|'f32'} type
 */
const writeMeta = (register, type) => ({ command: COMMAND.WRITE, register, type });

/**
 * Warning on the trigger voltage difference (spec 7.2): at or below the balance stop voltage
 * difference of ZH-2.1.1 and later, which is the difference where balancing ends ([SY#950]:
 * start 0.005 V, stop 0.003 V), or below the vendor recommendation ([MAN] 5.3.3). No source
 * states a firmware limit, so both are warnings only.
 * @param {Record<string, any>} values
 */
function triggerWarning(values) {
  const t = values['balance.trigger_delta'];
  if (!Number.isFinite(t)) return null;
  const stop = values['neey.stop_delta'];
  if (Number.isFinite(stop) && stop > 0 && t <= stop + 1e-9) return TRIGGER_STOP_WARN;
  const cap = values['capacity.nominal'];
  if (!Number.isFinite(cap)) return null;
  return t < (cap > 50 ? 0.005 : 0.01) - 1e-9 ? TRIGGER_WARN : null;
}

/**
 * Warning when the balance start voltage is not above the sleep voltage: every captured V1
 * settings frame has start above sleep (2.6 / 2.5, 3.37 / 3.35, 3.65 / 3.4, 3.45 / 3.4,
 * 3.42 / 3.35 V, spec 7.2); no source states a firmware limit.
 * @param {Record<string, any>} values
 */
function startWarning(values) {
  const start = values['balance.start_voltage'];
  const sleep = values['cell.sleep_voltage'];
  if (!Number.isFinite(start) || !Number.isFinite(sleep) || start <= 0) return null;
  return start <= sleep + 1e-9 ? START_SLEEP_WARN : null;
}

/**
 * Warning when the maximum balance current exceeds 0.1 C ([MAN] 5.3.3).
 * @param {Record<string, any>} values
 */
function currentWarning(values) {
  const a = values['balance.max_current'];
  const cap = values['capacity.nominal'];
  if (!Number.isFinite(a) || !Number.isFinite(cap) || cap <= 0) return null;
  return a > cap * 0.1 + 1e-9 ? CURRENT_WARN : null;
}

/**
 * @typedef {Object} SchemaOptions
 * @property {string} [variant] VARIANT value; NEEY_V1 when unknown
 * @property {Record<string, any> | null} [settings] parsed settings frame of that variant
 * @property {string} [softwareVersion] from the device info frame
 * @property {number} [rating] maximum balance current of the model in A (spec 7.3)
 */

/**
 * NEEY_V1 schema (100-byte settings, spec 6.2, 7.2).
 * @param {SchemaOptions} opts
 * @returns {SettingField[]}
 */
function v1Fields({ settings = null, softwareVersion = '', rating = 4 }) {
  // A value above the rating that the balancer already holds stays valid (EK-16S2EB reports more
  // than its name says, spec 7.3).
  const held = Number(settings?.maxBalanceCurrent);
  const maxCurrent = Math.max(rating, Number.isFinite(held) ? Math.ceil(r(held, 3) * 10) / 10 : 0);
  /** @type {SettingField[]} */
  const fields = [
    field('switch.balance', { danger: true, description: SWITCH_HELP, meta: { key: 'balancerSwitch', write: writeMeta(REGISTER.BALANCER_SWITCH, 'u32') } }),
    field('balance.trigger_delta', { min: 0.001, max: 1, warn: triggerWarning, meta: { key: 'balanceTriggerVoltage', write: writeMeta(REGISTER.TRIGGER_DELTA, 'f32') } }),
    field('balance.max_current', {
      decimals: 1,
      min: 1,
      max: maxCurrent,
      description: MAX_CURRENT_HELP,
      warn: currentWarning,
      meta: { key: 'maxBalanceCurrent', write: writeMeta(REGISTER.MAX_CURRENT, 'f32') },
    }),
    field('cell.sleep_voltage', { group: 'balancing', min: 1, max: 4.5, description: SLEEP_HELP, meta: { key: 'balanceStopVoltage', write: writeMeta(REGISTER.SLEEP_VOLTAGE, 'f32') } }),
  ];
  // GW-24S4EB SW-1.1.0 has no start voltage and reads 0 (spec 6.2, 12 item 12): no field there.
  const noStartVoltage = /^SW-1\.1\.0$/i.test(String(softwareVersion).trim()) && settings !== null && !(Number(settings.balanceStartVoltage) > 0);
  if (!noStartVoltage) {
    fields.push(field('balance.start_voltage', { min: 1, max: 4.5, warn: startWarning, meta: { key: 'balanceStartVoltage', write: writeMeta(REGISTER.START_VOLTAGE, 'f32') } }));
  }
  fields.push(
    field('capacity.nominal', { decimals: 0, min: 1, max: 2000, meta: { key: 'nominalCapacity', write: writeMeta(REGISTER.NOMINAL_CAPACITY, 'u32') } }),
    field('system.cell_count', { min: 2, max: 24, step: 1, readOnly: true, description: CELL_COUNT_RO, meta: { key: 'cellCount', unverifiedWrite: writeMeta(REGISTER.CELL_COUNT, 'u32') } }),
  );
  // ZH-2.1.1 and ZL-2.0.2 only: byte 32 is 1 and the value 0.003 V; 0 elsewhere (spec 6.2).
  if (settings && (settings.byte32 !== 0 || Number(settings.balanceStopDiffVoltage) !== 0)) {
    fields.push(
      field('neey.stop_delta', {
        label: msg('Balance stop voltage difference'),
        group: 'balancing',
        type: 'number',
        unit: 'V',
        decimals: 3,
        readOnly: true,
        description: STOP_DELTA_RO,
        meta: { key: 'balanceStopDiffVoltage', unverifiedWrite: writeMeta(REGISTER.STOP_DELTA, 'f32') },
      }),
    );
  }
  fields.push(
    field('neey.buzzer_mode', {
      label: msg('Buzzer mode'),
      group: 'system',
      type: 'enum',
      options: [...BUZZER_MODES],
      readOnly: true,
      description: APP_TABLE_RO,
      meta: { key: 'buzzerMode', unverifiedWrite: writeMeta(REGISTER.BUZZER_MODE, 'u32') },
    }),
    field('system.battery_type', {
      options: [...BATTERY_TYPES],
      readOnly: true,
      description: APP_TABLE_RO,
      meta: { key: 'batteryType', unverifiedWrite: writeMeta(REGISTER.BATTERY_TYPE, 'u32') },
    }),
  );
  return fields;
}

/**
 * NEEY_V2 schema (150-byte settings of the EK-B24S8E200A, spec 6.3, 7.2): only the balancer
 * switch is written.
 * @returns {SettingField[]}
 */
function v2Fields() {
  /**
   * BMS limit of command 0x06 (spec 5.3), read only.
   * @param {string} id
   * @param {string} key
   * @param {Partial<SettingField>} [props]
   * @param {string} [description]
   */
  const limit = (id, key, props = {}, description = V2_LIMIT_RO) =>
    field(id, { ...props, readOnly: true, description, meta: { key, unverifiedWrite: { command: COMMAND.WRITE_V2, register: /** @type {Record<string, number>} */ (V2_REGISTER)[key], type: 'f32' } } });
  /**
   * Delay or recovery time of command 0x06 (u16 in the frame, u32 in the write), read only.
   * @param {string} id
   * @param {string} key
   * @param {Partial<SettingField>} [props]
   */
  const delay = (id, key, props = {}) =>
    field(id, { decimals: 0, ...props, readOnly: true, description: V2_DELAY_RO, meta: { key, unverifiedWrite: { command: COMMAND.WRITE_V2, register: /** @type {Record<string, number>} */ (V2_REGISTER)[key], type: 'u32' } } });
  /**
   * Balancer value of the 150-byte layout, read only.
   * @param {string} id
   * @param {string} key
   * @param {Partial<SettingField>} [props]
   * @param {string} [description]
   */
  const ro = (id, key, props = {}, description = V2_BALANCER_RO) => field(id, { ...props, readOnly: true, description, meta: { key } });
  // Offsets 22 and 26: [SY] labels them sleep and start voltage, but their order is the opposite
  // of every V1 frame (spec 6.3, 12 item 9), so they are not shown under the canonical ids.
  const voltage = { group: 'balancing', type: /** @type {const} */ ('number'), unit: 'V', decimals: 3 };
  return [
    field('switch.balance', { danger: true, description: SWITCH_HELP, meta: { key: 'balancerSwitch', write: writeMeta(REGISTER.BALANCER_SWITCH, 'u32') } }),
    ro('balance.trigger_delta', 'balanceTriggerVoltage'),
    ro('balance.max_current', 'maxBalanceCurrent', { decimals: 1 }),
    ro('neey.v2_voltage_22', 'float22', { ...voltage, label: msg('Voltage setting at offset 22 (sleep voltage per one source)') }, V2_SWAPPED_RO),
    ro('neey.v2_voltage_26', 'float26', { ...voltage, label: msg('Voltage setting at offset 26 (balance start voltage per one source)') }, V2_SWAPPED_RO),
    ro('capacity.nominal', 'nominalCapacity', { decimals: 0 }),
    ro('system.cell_count', 'cellCount', { step: 1 }, CELL_COUNT_RO),
    limit('cell.ovp', 'cellOvp'),
    limit('cell.ovpr', 'cellOvpr'),
    limit('cell.uvp', 'cellUvp'),
    limit('cell.uvpr', 'cellUvpr'),
    limit('cell.diff_protection', 'cellDiffProtection'),
    limit('neey.cell_diff_recovery', 'cellDiffRecovery', { label: msg('Cell voltage difference recovery'), group: 'cell_voltage', type: 'number', unit: 'V', decimals: 3 }),
    limit('cell.power_off_voltage', 'cellShutdownVoltage'),
    limit('charge.ocp', 'chargeOcp'),
    delay('charge.ocp_delay', 'chargeOcpDelay'),
    delay('charge.ocp_recovery', 'chargeOcpRecovery'),
    limit('discharge.ocp', 'dischargeOcp'),
    delay('discharge.ocp_delay', 'dischargeOcpDelay'),
    delay('discharge.ocp_recovery', 'dischargeOcpRecovery'),
    limit('discharge.ocp2', 'dischargeOcp2'),
    delay('discharge.ocp2_delay', 'dischargeOcp2Delay'),
    delay('neey.discharge_ocp2_recovery', 'dischargeOcp2Recovery', { label: msg('Discharge overcurrent recovery time, level 2'), group: 'current', type: 'number', unit: 's' }),
    limit('scp.current', 'scpCurrent'),
    delay('scp.delay', 'scpDelay'),
    delay('scp.recovery', 'scpRecovery'),
    limit('charge.otp', 'chargeOtp'),
    limit('charge.otpr', 'chargeOtpr'),
    limit('charge.utp', 'chargeUtp'),
    limit('charge.utpr', 'chargeUtpr'),
    limit('discharge.otp', 'dischargeOtp'),
    limit('discharge.otpr', 'dischargeOtpr'),
    limit('discharge.utp', 'dischargeUtp'),
    limit('discharge.utpr', 'dischargeUtpr'),
  ];
}

/**
 * Settings schema for a variant. No actions (spec 8).
 * @param {SchemaOptions} [opts]
 * @returns {SettingsSchema}
 */
export function buildNeeySchema(opts = {}) {
  return buildSchema(opts.variant === VARIANT.V2 ? v2Fields() : v1Fields(opts));
}

/**
 * Engineering values of a schema from a parsed settings frame (spec 6.2, 6.3). Floats are rounded
 * to 6 decimals, which removes the float32 noise (0.004999999888 reads 0.005).
 * @param {SettingsSchema} schema
 * @param {Record<string, any> | null} settings
 * @returns {Record<string, any>}
 */
export function decodeNeeySettings(schema, settings) {
  /** @type {Record<string, any>} */
  const values = {};
  if (!settings) return values;
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const key = f.meta?.key;
      if (!key || !(key in settings)) continue;
      const v = settings[key];
      values[f.id] = f.type === 'boolean' ? !!v : typeof v === 'number' ? r(v, 6) : v;
    }
  }
  return values;
}

/**
 * Request bytes for a write (spec 5.2): u32 for the switch and the capacity, float32 otherwise.
 * Throws for read only fields.
 * @param {SettingField} f
 * @param {any} value engineering units
 * @param {{ checksum?: 'sum8'|'xor8' }} [opts] xor8 only for units that answer the old app's form
 *   (spec 3.4, 11.2); the xor8 writes are the captured requests of the old app
 */
export function encodeSettingWrite(f, value, { checksum = 'sum8' } = {}) {
  const w = f.meta?.write;
  if (f.readOnly || !w) throw new Error(msg('This value is read only'));
  /** @type {number} */
  let raw;
  if (f.type === 'boolean') raw = value ? 1 : 0;
  else if (w.type === 'u32') raw = Math.round(Number(value));
  else raw = Number(value);
  if (!Number.isFinite(raw)) throw new Error(msg('Invalid value'));
  return encodeRequest({ function: FUNCTION.WRITE, command: w.command, register: w.register, value: raw, valueType: w.type, checksum });
}
