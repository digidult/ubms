import { alarm } from '@ubms/bms-core';

/**
 * @typedef {{ bit: number, id: string, severity?: 'info'|'warning'|'protection'|'fault', label?: string }} AlarmBit
 */

/**
 * Convert a bit mask into alarm states using a table of bit definitions.
 * @param {number} mask
 * @param {AlarmBit[]} table
 * @param {string} [sourcePrefix] for example 'alarms' produces source 'alarms bit 3'
 * @returns {import('@ubms/bms-core/model').AlarmState[]}
 */
export function alarmsFromBits(mask, table, sourcePrefix = 'bit') {
  const out = [];
  for (const def of table) {
    if (((mask >>> def.bit) & 1) === 1) {
      out.push(alarm(def.id, { severity: def.severity, label: def.label, source: `${sourcePrefix} ${def.bit}` }));
    }
  }
  return out;
}

/**
 * Plain bit list of a mask (for logs and extra values).
 * @param {number} mask
 * @param {number} width
 */
export function setBits(mask, width = 32) {
  const out = [];
  for (let b = 0; b < width; b++) if (((mask >>> b) & 1) === 1) out.push(b);
  return out;
}

/**
 * Round a number to a given count of decimals.
 * @param {number} v
 * @param {number} [d]
 */
export const r = (v, d = 3) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/**
 * Format a date as YYYY-MM-DD.
 * @param {number} y @param {number} m @param {number} d
 */
export function ymd(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Periodic timer helper for simulators (setInterval that can be stopped and is unref'd in Node).
 * @param {() => void} fn
 * @param {number} ms
 */
export function every(fn, ms) {
  const id = setInterval(fn, ms);
  /** @type {any} */ (id).unref?.();
  return () => clearInterval(id);
}
