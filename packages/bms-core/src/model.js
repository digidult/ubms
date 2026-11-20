/**
 * Unified BMS data model. Every driver converts its protocol into these shapes; the UI renders
 * only these shapes. All values are in SI-style engineering units.
 *
 * @typedef {Object} TemperatureReading
 * @property {string} id stable id, for example 'mos', 't1', 't2', 'ambient', 'balancer'
 * @property {string} label English label (translated by the UI)
 * @property {number} value degrees Celsius
 * @property {'cell'|'mos'|'ambient'|'balancer'|'board'|'heater'|'other'} [kind]
 *
 * @typedef {Object} AlarmState
 * @property {string} id canonical id from ALARMS or a driver specific id
 * @property {string} [label] English label override (defaults from the catalog)
 * @property {'info'|'warning'|'protection'|'fault'} [severity]
 * @property {string} [source] raw origin, for example 'bit 5 of 0x8B'
 *
 * @typedef {Object} ExtraValue
 * @property {string} label English label
 * @property {number|string|boolean} value
 * @property {string} [unit]
 * @property {number} [decimals]
 * @property {true | ExtraChart} [chart] record this value in the history and offer it as a chart
 *   (one card per value): `true` uses value, unit and decimals (value must be a number); an
 *   object gives the numeric value to chart when the shown value is text (a duration, say)
 *
 * @typedef {Object} ExtraChart
 * @property {number} value
 * @property {string} [unit]
 * @property {number} [decimals]
 *
 * @typedef {Object} SwitchStates actual MOSFET / feature states reported by the device
 * @property {boolean} [charge]
 * @property {boolean} [discharge]
 * @property {boolean} [balance]
 * @property {boolean} [heater]
 * @property {boolean} [precharge]
 *
 * @typedef {Object} CellStats
 * @property {number} count
 * @property {number} min
 * @property {number} max
 * @property {number} avg
 * @property {number} delta
 * @property {number} sum
 * @property {number} minIndex zero based
 * @property {number} maxIndex zero based
 *
 * @typedef {Object} BmsSnapshot
 * @property {number} timestamp epoch ms
 * @property {number} [voltage] pack voltage, V
 * @property {number} [current] A, positive while charging, negative while discharging
 * @property {number} [power] W, same sign convention as current
 * @property {number} [soc] state of charge, %
 * @property {number} [soh] state of health, %
 * @property {number} [capacityRemaining] Ah
 * @property {number} [capacityFull] Ah, full charge capacity
 * @property {number} [capacityNominal] Ah, design / configured capacity
 * @property {number} [cycles]
 * @property {number} [cycleCapacity] Ah, accumulated
 * @property {number} [uptime] seconds
 * @property {number[]} [cells] cell voltages, V
 * @property {number[]} [cellResistances] milliohm, per cell (cell or wire resistance, see driver)
 * @property {boolean[]} [balancing] per cell balancing flags
 * @property {boolean} [balancingActive]
 * @property {number} [balanceCurrent] A, signed when the device reports direction
 * @property {TemperatureReading[]} [temperatures]
 * @property {SwitchStates} [switches]
 * @property {AlarmState[]} [alarms] active alarms only
 * @property {Record<string, ExtraValue>} [extra] driver specific values
 * @property {CellStats} [cellStats] derived
 * @property {'charging'|'discharging'|'idle'} [state] derived
 * @property {number} [timeToFull] hours, derived estimate
 * @property {number} [timeToEmpty] hours, derived estimate
 *
 * @typedef {Object} DeviceInfo
 * @property {string} [vendor]
 * @property {string} [model]
 * @property {string} [name] user assigned device name
 * @property {string} [hardwareVersion]
 * @property {string} [softwareVersion]
 * @property {string} [serialNumber]
 * @property {string} [manufactureDate]
 * @property {string} [protocol] protocol / variant label
 * @property {number} [uptime] seconds
 * @property {number} [powerOnCount]
 * @property {Record<string, ExtraValue>} [extra]
 */

/**
 * @param {number[] | undefined} cells
 * @returns {CellStats | undefined}
 */
export function cellStats(cells) {
  if (!cells?.length) return undefined;
  let min = Infinity;
  let max = -Infinity;
  let minIndex = 0;
  let maxIndex = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i];
    if (!Number.isFinite(v)) continue;
    count++;
    sum += v;
    if (v < min) {
      min = v;
      minIndex = i;
    }
    if (v > max) {
      max = v;
      maxIndex = i;
    }
  }
  if (!count) return undefined;
  return { count, min, max, avg: sum / count, delta: max - min, sum, minIndex, maxIndex };
}

/** Current below this magnitude (A) counts as idle. */
export const IDLE_CURRENT = 0.15;

/**
 * Fill in derived values (cell statistics, power, state, time estimates).
 * Returns a new object; the input is not modified.
 * @param {BmsSnapshot} s
 * @returns {BmsSnapshot}
 */
export function deriveSnapshot(s) {
  const out = { ...s };
  out.cellStats = cellStats(s.cells);
  if (out.power === undefined && Number.isFinite(s.voltage) && Number.isFinite(s.current)) {
    out.power = /** @type {number} */ (s.voltage) * /** @type {number} */ (s.current);
  }
  if (Number.isFinite(s.current)) {
    const i = /** @type {number} */ (s.current);
    out.state = i > IDLE_CURRENT ? 'charging' : i < -IDLE_CURRENT ? 'discharging' : 'idle';
    const remaining = s.capacityRemaining;
    const full = s.capacityFull ?? s.capacityNominal;
    if (out.state === 'discharging' && Number.isFinite(remaining)) out.timeToEmpty = /** @type {number} */ (remaining) / -i;
    if (out.state === 'charging' && Number.isFinite(remaining) && Number.isFinite(full)) {
      out.timeToFull = Math.max(0, /** @type {number} */ (full) - /** @type {number} */ (remaining)) / i;
    }
  }
  return out;
}

/**
 * Round to a number of decimals, avoiding binary noise like 3.3000000000000003.
 * @param {number} v
 * @param {number} decimals
 */
export function round(v, decimals) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}
