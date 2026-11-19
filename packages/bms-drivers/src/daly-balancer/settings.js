import { buildSchema, field, msg } from '@ubms/bms-core';
import { BATTERY_TYPES, REG, SLEEP_NEVER, WRITABLE_REGISTERS, encodeWrite } from './protocol.js';

/**
 * Settings schema of the Daly active balancers (docs/protocols/daly-balancer.md section 7) and the
 * conversion between engineering units and register values.
 *
 * Writable (function 0x06, one register, echo compared, then read back by the session), only
 * within the schema range (also when the driver is called directly):
 * - `switch.balance` 0x00CF: captured app writes with echo and read-back (spec 7.2);
 * - `balance.start_voltage` 0x00A3 and `balance.trigger_delta` 0x00A4: register meaning confirmed
 *   by two balancer reads that match the manual defaults and by the R/W vendor list, and the same
 *   D2 writes are confirmed on Daly BMS boards (spec 7.1); the write itself is not captured on a
 *   balancer, so the read-back decides whether the value was taken, and the UI asks for a
 *   confirmation (`danger`);
 * - `system.sleep_delay` 0x008A: write echoed on hardware (spec 7.3).
 *
 * Read only, with the reason in the description:
 * - `system.cell_count`: the register the app writes for the cell count is not captured (0x0083 or
 *   0x00CE, spec 7.3);
 * - `system.battery_type` 0x0089: the effect of a write on a balancer is unknown (spec 7.3).
 *
 * Not in the schema (spec 7.1, 7.4): the balance current (candidate 0x00D0, unit unverified), the
 * BMS protection thresholds of the settings block (fixed at neutral values on a balancer), board
 * and sensor counts, MOSFET and SOC registers, 0x00A8 and the password. No action: no restart,
 * reset or calibration command is documented for a balancer (spec 8).
 *
 * Field `meta` (driver private): `{ kind: 'register', register, source, key, scale }` for a
 * register value (`source` is the parsed block it is read from: 'settings' or 'switch', `key` the
 * field of the parsed block, `scale` engineering units per raw unit; booleans have no scale).
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 */

const START_VOLTAGE = msg(
  'Balancing starts only when a cell is at or above this voltage and the cell difference reaches the start difference. Factory value 3.3 V on the UART/RS485 model (one unit read 3.2 V), 3.0 V in the dual UART instruction. On the dual UART model balancing also stops above the cut-off voltage set in the Daly app (default 3.7 V), so keep the start voltage below it. No app capture of this write exists for a balancer, so every write is read back to confirm it.',
);
const TRIGGER_DELTA = msg(
  'Cell voltage difference at which balancing starts. Factory value 20 mV (50 mV in the older dual UART instruction). No app capture of this write exists for a balancer, so every write is read back to confirm it.',
);
const SLEEP = msg(
  'Idle time after which the balancer sleeps and stops answering until it is woken with its button or a power cycle. 65535 s means it never sleeps; the factory value is 3600 s.',
);
const SHORT_SLEEP = msg('With a sleep time below 600 s the balancer soon stops answering and has to be woken by hand.');
const CELL_COUNT = msg(
  'Sum of the cell counts of the configured acquisition boards. It must match the cells wired to the balancer. The register the official app writes for the cell count is not known, so the value is shown but never written.',
);
const BATTERY_TYPE = msg(
  'What a write of the battery type changes on a balancer is not known, so the value is shown but never written. For other chemistries adjust the balance start voltage instead.',
);
const SWITCH = msg('Turns balancing on or off (register 0x00CF), as the official app does.');
const START_OUTSIDE_CHEMISTRY = msg(
  'The start voltage lies outside the normal cell voltage range of the configured battery type. Above that range the balancer never starts.',
);

/**
 * Normal cell voltage range per battery type (V), from the wiring check of the Daly manual
 * (spec 7.5): LiFePO4 2.5 to 3.6 V, ternary lithium 3.0 to 4.15 V, LTO 1.8 to 2.8 V.
 * @type {Record<number, [number, number]>}
 */
export const CHEMISTRY_RANGE = { 0: [2.5, 3.6], 1: [3.0, 4.15], 2: [1.8, 2.8] };

/** Shortest sleep time ubms writes, s (ubms choice: the effect of shorter values is undocumented). */
export const MIN_SLEEP_S = 60;

/** Sleep time below which the write is warned about, s (ubms choice, spec 7.3). */
export const SHORT_SLEEP_S = 600;

/**
 * @param {string} id
 * @param {number} register
 * @param {'settings'|'switch'} source
 * @param {string} key field of the parsed block
 * @param {number | undefined} scale engineering units per raw unit
 * @param {Partial<SettingField>} [props]
 */
const reg = (id, register, source, key, scale, props = {}) => field(id, { ...props, meta: { kind: 'register', register, source, key, ...(scale === undefined ? {} : { scale }) } });

/**
 * The balancer settings schema (spec 7). Ranges: start voltage 1.5 to 4.5 V and start difference
 * 0.01 to 1.5 V from the dual UART specification ([SW11] 2.1; the range of the UART/RS485 model is
 * not documented); sleep time 60 to 65535 s.
 * @returns {SettingsSchema}
 */
export function buildDalyBalancerSchema() {
  return buildSchema([
    reg('switch.balance', REG.SWITCH, 'switch', 'balancerSwitch', undefined, { description: SWITCH }),
    reg('balance.start_voltage', REG.START_VOLTAGE, 'settings', 'balanceStartVoltage', 0.001, {
      min: 1.5,
      max: 4.5,
      danger: true,
      description: START_VOLTAGE,
      warn: (values) => {
        const range = CHEMISTRY_RANGE[values['system.battery_type']];
        const v = values['balance.start_voltage'];
        if (!range || !Number.isFinite(v)) return null;
        return v < range[0] || v > range[1] ? START_OUTSIDE_CHEMISTRY : null;
      },
    }),
    reg('balance.trigger_delta', REG.TRIGGER_DELTA, 'settings', 'balanceTriggerDelta', 0.001, { min: 0.01, max: 1.5, danger: true, description: TRIGGER_DELTA }),
    reg('system.sleep_delay', REG.SLEEP, 'settings', 'sleepDelay', 1, {
      min: MIN_SLEEP_S,
      max: SLEEP_NEVER,
      step: 1,
      description: SLEEP,
      warn: (values) => {
        const v = values['system.sleep_delay'];
        return Number.isFinite(v) && v < SHORT_SLEEP_S ? SHORT_SLEEP : null;
      },
    }),
    reg('system.cell_count', REG.BOARD_CELLS, 'settings', 'cellCountConfigured', 1, { readOnly: true, step: 1, description: CELL_COUNT }),
    reg('system.battery_type', REG.BATTERY_TYPE, 'settings', 'batteryType', 1, {
      readOnly: true,
      options: Object.entries(BATTERY_TYPES).map(([value, label]) => ({ value: Number(value), label })),
      description: BATTERY_TYPE,
    }),
  ]);
}

/**
 * Setting values from the parsed blocks (spec 6.3, 6.5). A value whose block was not read is left
 * out. Enumeration values outside the known options are left out too (the UI cannot show them).
 * @param {SettingsSchema} schema
 * @param {{ settings?: Record<string, any> | null, switchBlock?: Record<string, any> | null }} blocks
 * @returns {Record<string, any>}
 */
export function decodeBalancerSettings(schema, { settings = null, switchBlock = null }) {
  /** @type {Record<string, any>} */
  const values = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      const m = f.meta;
      if (m?.kind !== 'register') continue;
      const src = m.source === 'switch' ? switchBlock : settings;
      const v = src?.[m.key];
      if (v === undefined || v === null) continue;
      if (f.type === 'enum' && !f.options?.some((o) => o.value === v)) continue;
      values[f.id] = v;
    }
  }
  return values;
}

/**
 * Whether a value lies inside the schema range of a number field (spec 7.1, 7.3). The ranges are
 * the only guard against values whose effect is undocumented (a 0 s sleep time, for example), so
 * the driver checks them itself instead of relying on the session validation. Other field types
 * have no range.
 * @param {SettingField} f
 * @param {any} value engineering units
 */
export function inSchemaRange(f, value) {
  if (f.type !== 'number') return true;
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n)) return false;
  return (f.min === undefined || n >= f.min) && (f.max === undefined || n <= f.max);
}

/**
 * Register value of a setting: 0 / 1 for booleans, otherwise the engineering value divided by the
 * scale, rounded. Returns undefined when the value lies outside the schema range or does not fit
 * a u16 register.
 * @param {SettingField} f
 * @param {any} value engineering units
 */
export function rawSettingValue(f, value) {
  if (!inSchemaRange(f, value)) return undefined;
  const raw = f.type === 'boolean' ? (value ? 1 : 0) : Math.round(Number(value) / (f.meta?.scale ?? 1));
  return Number.isInteger(raw) && raw >= 0 && raw <= 0xffff ? raw : undefined;
}

/**
 * The write frame for a setting (spec 5.2), or null for read only fields, registers ubms does not
 * write, values outside the schema range and values that do not fit the register.
 * @param {SettingField} f
 * @param {any} value engineering units
 */
export function settingWriteFrame(f, value) {
  const register = f.meta?.register;
  if (f.readOnly || f.meta?.kind !== 'register' || !WRITABLE_REGISTERS.includes(register)) return null;
  const raw = rawSettingValue(f, value);
  return raw === undefined ? null : encodeWrite(register, raw);
}
