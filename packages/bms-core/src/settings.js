import { SETTINGS, SETTING_GROUPS } from './catalog.js';
import { msg } from './msg.js';

/**
 * Declarative settings schema. Drivers describe what can be configured; the UI renders forms from
 * it and never needs device specific code. Values are always engineering units (V, A, degrees C,
 * seconds, Ah, %); conversion to raw protocol values happens inside the driver.
 *
 * @typedef {'number'|'boolean'|'enum'|'text'|'action'} FieldType
 *
 * @typedef {Object} SettingField
 * @property {string} id
 * @property {string} label English label
 * @property {FieldType} type
 * @property {string} group group id (see SETTING_GROUPS) or a driver specific group id
 * @property {string} [unit]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {number} [decimals]
 * @property {Array<{ value: number|string, label: string }>} [options] for 'enum'
 * @property {number} [maxLength] for 'text'
 * @property {boolean} [readOnly]
 * @property {boolean} [writeOnly] the device does not report this value (calibration inputs): no
 *   read-back verification, the input starts empty
 * @property {{ label?: string, unit?: string, min?: number, max?: number, step?: number, decimals?: number, default?: number }} [argument]
 *   for 'action' fields that take a number (for example "set SOC to N %")
 * @property {boolean} [danger] confirm before writing / running
 * @property {boolean} [advanced] hidden unless the user enables advanced settings
 * @property {string} [description] English help text
 * @property {(values: Record<string, any>) => string | null} [validate] cross-field check, returns an English error
 * @property {(values: Record<string, any>) => string | null} [warn] non-blocking cross-field check: an English
 *   warning shown next to the field and in the confirmation before writing
 * @property {any} [meta] driver private data (register, scale, offset...)
 *
 * @typedef {Object} SettingGroup
 * @property {string} id
 * @property {string} label
 * @property {string} [icon]
 * @property {string} [description]
 * @property {SettingField[]} fields
 *
 * @typedef {Object} SettingsSchema
 * @property {SettingGroup[]} groups
 */

/**
 * Create a field from a canonical id (inherits label, unit, decimals, group) plus overrides.
 * For driver specific ids pass at least `label`, `group` and `type`.
 * @param {string} id
 * @param {Partial<SettingField>} [overrides]
 * @returns {SettingField}
 */
export function field(id, overrides = {}) {
  const base = /** @type {{ label?: string, group?: string, unit?: string, decimals?: number, description?: string, type?: FieldType }} */ (SETTINGS[id] ?? {});
  const type = overrides.type ?? base.type ?? (overrides.options ? 'enum' : 'number');
  const f = /** @type {SettingField} */ ({
    id,
    label: base.label ?? id,
    group: base.group ?? 'advanced',
    ...(base.unit ? { unit: base.unit } : {}),
    ...(base.decimals !== undefined ? { decimals: base.decimals } : {}),
    ...(base.description ? { description: base.description } : {}),
    type,
    ...overrides,
  });
  if (f.type === 'number' && f.step === undefined && f.decimals !== undefined) f.step = 10 ** -f.decimals;
  return f;
}

/**
 * Group a flat field list into a schema, ordering groups by SETTING_GROUPS and then by first use.
 * @param {SettingField[]} fields
 * @param {Record<string, { label: string, icon?: string, description?: string }>} [extraGroups] driver specific groups
 * @returns {SettingsSchema}
 */
export function buildSchema(fields, extraGroups = {}) {
  /** @type {Map<string, SettingGroup>} */
  const groups = new Map();
  const order = [...Object.keys(SETTING_GROUPS), ...Object.keys(extraGroups)];
  for (const f of fields) {
    let g = groups.get(f.group);
    if (!g) {
      const def = extraGroups[f.group] ?? SETTING_GROUPS[f.group] ?? { label: f.group };
      g = { id: f.group, label: def.label, icon: def.icon, description: def.description, fields: [] };
      groups.set(f.group, g);
    }
    g.fields.push(f);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  return { groups: sorted };
}

/**
 * @param {SettingsSchema | null | undefined} schema
 * @returns {Map<string, SettingField>}
 */
export function fieldMap(schema) {
  const m = new Map();
  for (const g of schema?.groups ?? []) for (const f of g.fields) m.set(f.id, f);
  return m;
}

/**
 * Coerce user input to the field type. Returns undefined when the input cannot be parsed.
 * Accepts both decimal separators for numbers.
 * @param {SettingField} f
 * @param {any} raw
 */
export function coerce(f, raw) {
  switch (f.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'enum': {
      const opt = f.options?.find((o) => String(o.value) === String(raw));
      return opt ? opt.value : undefined;
    }
    case 'text':
      return String(raw ?? '');
    default:
      return raw;
  }
}

/**
 * Validate a single value against the field limits. Returns an English message or null.
 * Messages use {placeholders} so the UI can translate them.
 * @param {SettingField} f
 * @param {any} value
 * @returns {{ message: string, params?: Record<string, any> } | null}
 */
export function validateValue(f, value) {
  if (f.readOnly) return { message: msg('This value is read only') };
  if (value === undefined) return { message: msg('Invalid value') };
  if (f.type === 'number') {
    if (f.min !== undefined && value < f.min) return { message: msg('Minimum is {min}'), params: { min: f.min, unit: f.unit ?? '' } };
    if (f.max !== undefined && value > f.max) return { message: msg('Maximum is {max}'), params: { max: f.max, unit: f.unit ?? '' } };
  }
  if (f.type === 'text' && f.maxLength !== undefined && String(value).length > f.maxLength) {
    return { message: msg('At most {max} characters'), params: { max: f.maxLength } };
  }
  return null;
}

/**
 * Cross-field validation for a full value set (current values with pending edits applied).
 * @param {SettingsSchema} schema
 * @param {Record<string, any>} values
 * @returns {Record<string, string>} field id to English message
 */
export function validateAll(schema, values) {
  /** @type {Record<string, string>} */
  const errors = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      if (!f.validate) continue;
      try {
        const m = f.validate(values);
        if (m) errors[f.id] = m;
      } catch {
        /* a broken validator must not block the form */
      }
    }
  }
  return errors;
}

/**
 * Non-blocking warnings for a full value set (see `SettingField.warn`).
 * @param {SettingsSchema} schema
 * @param {Record<string, any>} values
 * @returns {Record<string, string>} field id to English message
 */
export function warnAll(schema, values) {
  /** @type {Record<string, string>} */
  const warnings = {};
  for (const g of schema.groups) {
    for (const f of g.fields) {
      if (!f.warn) continue;
      try {
        const m = f.warn(values);
        if (m) warnings[f.id] = m;
      } catch {
        /* a broken check must not block the form */
      }
    }
  }
  return warnings;
}

/**
 * Build a validator comparing this field with another one.
 * @param {string} selfId
 * @param {'>'|'<'|'>='|'<='} op
 * @param {string} otherId
 * @param {string} message English message
 * @returns {(values: Record<string, any>) => string | null}
 */
export function relation(selfId, op, otherId, message) {
  return (values) => {
    const a = values[selfId];
    const b = values[otherId];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const ok = op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
    return ok ? null : message;
  };
}
