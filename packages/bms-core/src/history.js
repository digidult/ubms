import { msg } from './msg.js';
import { round } from './model.js';

/**
 * Fixed-size time series of key values for small charts (sparklines) and trend views.
 *
 * @typedef {Object} HistoryPoint
 * @property {number} t epoch ms
 * @property {number} [voltage]
 * @property {number} [current]
 * @property {number} [power]
 * @property {number} [soc]
 * @property {number} [cellMin]
 * @property {number} [cellMax]
 * @property {number} [tempMax]
 */
export class HistoryBuffer {
  /** @param {number} [capacity] number of points kept */
  constructor(capacity = 3600) {
    this.capacity = capacity;
    /** @type {HistoryPoint[]} */
    this.points = [];
  }

  /** @param {import('./model.js').BmsSnapshot} s */
  push(s) {
    const temps = s.temperatures?.map((t) => t.value).filter(Number.isFinite) ?? [];
    this.points.push({
      t: s.timestamp,
      voltage: s.voltage,
      current: s.current,
      power: s.power,
      soc: s.soc,
      cellMin: s.cellStats?.min,
      cellMax: s.cellStats?.max,
      tempMax: temps.length ? Math.max(...temps) : undefined,
    });
    if (this.points.length > this.capacity) this.points.splice(0, this.points.length - this.capacity);
  }

  /**
   * Values of one key within the last `windowMs` milliseconds.
   * @param {keyof HistoryPoint} key
   * @param {number} [windowMs]
   * @returns {Array<{ t: number, v: number }>}
   */
  series(key, windowMs = Infinity) {
    const end = this.points.at(-1)?.t ?? 0;
    const out = [];
    for (const p of this.points) {
      if (end - p.t > windowMs) continue;
      const v = p[key];
      if (typeof v === 'number' && Number.isFinite(v)) out.push({ t: p.t, v });
    }
    return out;
  }

  clear() {
    this.points = [];
  }
}

/* ------------------------------------------------------------------------------------------------
 * Persistent history: compact records, chart series, device metadata and device keys.
 * ---------------------------------------------------------------------------------------------- */

/**
 * One stored history record. `t` is always the first key, so a line of serialized JSON starts with
 * `{"t":<integer>` (the desktop file store filters lines by that prefix). Absent values are
 * omitted. In the arrays `c` and `tc` the position is the cell or sensor index, so a value the
 * device did not report is written as null there (JSON has no NaN).
 *
 * @typedef {Object} HistoryRecord
 * @property {number} t epoch ms, integer
 * @property {number} [u] pack voltage, V (3 decimals)
 * @property {number} [i] current, A (3 decimals)
 * @property {number} [p] power, W (1 decimal)
 * @property {number} [soc] state of charge, % (1 decimal)
 * @property {number} [cmin] lowest cell, V (3 decimals)
 * @property {number} [cmax] highest cell, V (3 decimals)
 * @property {number} [cavg] cell average, V (3 decimals)
 * @property {number} [cdel] cell difference, V (4 decimals)
 * @property {Array<number|null>} [c] cell voltages, V (3 decimals)
 * @property {Array<number|null>} [tc] temperatures in snapshot order, degrees Celsius (1 decimal)
 * @property {number} [bi] balance current, A (3 decimals)
 * @property {number} [cap] remaining capacity, Ah (2 decimals)
 * @property {Record<string, number>} [x] driver extra values marked with `chart` (model.js
 *   ExtraValue), by extra id, rounded to their decimals
 */

/**
 * @param {unknown} v
 * @param {number} decimals
 * @returns {number | undefined}
 */
function num(v, decimals) {
  return typeof v === 'number' && Number.isFinite(v) ? round(v, decimals) + 0 : undefined;
}

/**
 * Convert a snapshot into a compact history record.
 * @param {import('./model.js').BmsSnapshot} s
 * @returns {HistoryRecord}
 */
export function historyRecord(s) {
  /** @type {Record<string, any>} */
  const r = { t: Math.round(Number.isFinite(s?.timestamp) ? s.timestamp : Date.now()) };
  /**
   * @param {string} key
   * @param {number | undefined} v
   */
  const put = (key, v) => {
    if (v !== undefined) r[key] = v;
  };
  put('u', num(s.voltage, 3));
  put('i', num(s.current, 3));
  put('p', num(s.power, 1));
  put('soc', num(s.soc, 1));
  const st = s.cellStats;
  if (st) {
    put('cmin', num(st.min, 3));
    put('cmax', num(st.max, 3));
    put('cavg', num(st.avg, 3));
    put('cdel', num(st.delta, 4));
  }
  if (Array.isArray(s.cells) && s.cells.length) r.c = s.cells.map((v) => num(v, 3) ?? null);
  if (Array.isArray(s.temperatures) && s.temperatures.length) r.tc = s.temperatures.map((x) => num(x?.value, 1) ?? null);
  put('bi', num(s.balanceCurrent, 3));
  put('cap', num(s.capacityRemaining, 2));
  /** @type {Record<string, number>} */
  const x = {};
  for (const [id, chart] of chartedExtras(s.extra)) {
    const v = num(chart.value, chart.decimals);
    if (v !== undefined) x[id] = v;
  }
  if (Object.keys(x).length) r.x = x;
  return /** @type {HistoryRecord} */ (r);
}

/** Decimals of a charted extra value when the driver gives none. */
const EXTRA_DECIMALS = 3;

/**
 * The extra values of a snapshot that are marked for charts, as [id, { value, unit, decimals,
 * label }] with a numeric value.
 * @param {Record<string, import('./model.js').ExtraValue> | undefined} extra
 * @returns {Array<[string, { value: number, unit: string, decimals: number, label: string }]>}
 */
export function chartedExtras(extra) {
  /** @type {Array<[string, { value: number, unit: string, decimals: number, label: string }]>} */
  const out = [];
  for (const [id, e] of Object.entries(extra ?? {})) {
    if (!e?.chart) continue;
    const c = e.chart === true ? { value: e.value, unit: e.unit, decimals: e.decimals } : e.chart;
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) continue;
    const decimals = Number.isInteger(c.decimals) ? Number(c.decimals) : EXTRA_DECIMALS;
    out.push([id, { value: c.value, unit: c.unit ?? '', decimals, label: e.label }]);
  }
  return out;
}

/**
 * @typedef {string} HistoryGroupId 'voltage', 'current', 'power', 'soc', 'cells', 'cellDelta',
 *   'temperature', 'balance', 'capacity', or 'x:<extra id>' for the chart of one driver extra
 *   value (see extraSeries())
 *
 * @typedef {Object} HistoryGroup one chart card per group
 * @property {HistoryGroupId} id
 * @property {string} label English, translated by the UI
 * @property {string} unit
 *
 * @typedef {Object} HistorySeries
 * @property {string} id stable id, also used for CSV columns and legend state
 * @property {string} label English label (translated by the UI with `params`)
 * @property {Record<string, any>} [params] interpolation parameters of the label
 * @property {string} unit
 * @property {number} decimals display decimals (the stored precision)
 * @property {HistoryGroupId} group
 * @property {(r: HistoryRecord) => number | undefined} pick value of a record, undefined when absent
 * @property {number} [cell] zero based cell index (per-cell series)
 * @property {number} [sensor] zero based temperature index (temperature series)
 * @property {string} [extra] extra value id (driver extra series)
 */

/** Chart groups in display order. */
export const HISTORY_GROUPS = /** @type {HistoryGroup[]} */ ([
  { id: 'voltage', label: msg('Voltage'), unit: 'V' },
  { id: 'current', label: msg('Current'), unit: 'A' },
  { id: 'power', label: msg('Power'), unit: 'W' },
  { id: 'soc', label: msg('State of charge'), unit: '%' },
  { id: 'cells', label: msg('Cell voltages'), unit: 'V' },
  { id: 'cellDelta', label: msg('Cell difference'), unit: 'mV' },
  { id: 'temperature', label: msg('Temperatures'), unit: '°C' },
  { id: 'balance', label: msg('Balance current'), unit: 'A' },
  { id: 'capacity', label: msg('Remaining capacity'), unit: 'Ah' },
]);

/**
 * @param {unknown} v
 * @returns {number | undefined}
 */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * Fixed series (one value per record). Per-cell and temperature series come from `cellSeries()`
 * and `temperatureSeries()`.
 * @type {HistorySeries[]}
 */
export const HISTORY_SERIES = [
  { id: 'voltage', label: msg('Voltage'), unit: 'V', decimals: 3, group: 'voltage', pick: (r) => finite(r.u) },
  { id: 'current', label: msg('Current'), unit: 'A', decimals: 3, group: 'current', pick: (r) => finite(r.i) },
  { id: 'power', label: msg('Power'), unit: 'W', decimals: 1, group: 'power', pick: (r) => finite(r.p) },
  { id: 'soc', label: msg('State of charge'), unit: '%', decimals: 1, group: 'soc', pick: (r) => finite(r.soc) },
  { id: 'cellMin', label: msg('Lowest cell'), unit: 'V', decimals: 3, group: 'cells', pick: (r) => finite(r.cmin) },
  { id: 'cellMax', label: msg('Highest cell'), unit: 'V', decimals: 3, group: 'cells', pick: (r) => finite(r.cmax) },
  { id: 'cellAvg', label: msg('Cell average'), unit: 'V', decimals: 3, group: 'cells', pick: (r) => finite(r.cavg) },
  {
    id: 'cellDelta',
    label: msg('Cell difference'),
    unit: 'mV',
    decimals: 1,
    group: 'cellDelta',
    pick: (r) => {
      const v = finite(r.cdel);
      return v === undefined ? undefined : round(v * 1000, 1) + 0;
    },
  },
  { id: 'balanceCurrent', label: msg('Balance current'), unit: 'A', decimals: 3, group: 'balance', pick: (r) => finite(r.bi) },
  { id: 'capacity', label: msg('Remaining capacity'), unit: 'Ah', decimals: 2, group: 'capacity', pick: (r) => finite(r.cap) },
];

/**
 * Series of one cell voltage (group 'cells').
 * @param {number} index zero based
 * @returns {HistorySeries}
 */
export function cellSeries(index) {
  return {
    id: `cell${index + 1}`,
    label: msg('Cell {n}'),
    params: { n: index + 1 },
    unit: 'V',
    decimals: 3,
    group: 'cells',
    cell: index,
    pick: (r) => finite(r.c?.[index]),
  };
}

/**
 * Series of one temperature sensor (group 'temperature').
 * @param {number} index zero based position in the snapshot temperatures
 * @param {string} [label] English sensor label from the driver (stored in the device meta)
 * @returns {HistorySeries}
 */
export function temperatureSeries(index, label) {
  const own = typeof label === 'string' && label.trim() ? label.trim() : '';
  return {
    id: `temp${index + 1}`,
    label: own || msg('Temperature {n}'),
    params: own ? undefined : { n: index + 1 },
    unit: '°C',
    decimals: 1,
    group: 'temperature',
    sensor: index,
    pick: (r) => finite(r.tc?.[index]),
  };
}

/**
 * @typedef {Object} ExtraSeriesMeta label, unit and decimals of a charted driver extra value
 * @property {string} id extra id
 * @property {string} label English label (translated by the UI)
 * @property {string} unit
 * @property {number} decimals
 */

/**
 * Series of one driver extra value (its own group and chart card, 'x:<id>').
 * @param {string} id extra id
 * @param {Partial<ExtraSeriesMeta>} [def] label, unit and decimals from the device meta
 * @returns {HistorySeries}
 */
export function extraSeries(id, def = {}) {
  return {
    id: `x.${id}`,
    label: typeof def.label === 'string' && def.label ? def.label : id,
    unit: typeof def.unit === 'string' ? def.unit : '',
    decimals: Number.isInteger(def.decimals) ? Number(def.decimals) : EXTRA_DECIMALS,
    group: `x:${id}`,
    extra: id,
    pick: (r) => finite(r.x?.[id]),
  };
}

/**
 * Chart groups of a series list in display order: the fixed groups that have a series, then one
 * group per driver extra value.
 * @param {HistorySeries[]} series
 * @returns {HistoryGroup[]}
 */
export function historyGroups(series) {
  const present = new Set(series.map((s) => s.group));
  /** @type {HistoryGroup[]} */
  const out = HISTORY_GROUPS.filter((g) => present.has(g.id));
  for (const s of series) {
    if (s.extra !== undefined && !out.some((g) => g.id === s.group)) out.push({ id: s.group, label: s.label, unit: s.unit });
  }
  return out;
}

/**
 * Every series that has at least one value in `records`, in display order: the fixed series,
 * then each cell, then each temperature sensor, then the charted driver extra values.
 * `meta.tempLabels` names the sensors, `meta.extraSeries` the extra values.
 * @param {HistoryRecord[]} records
 * @param {{ cellCount?: number, tempLabels?: string[], extraSeries?: ExtraSeriesMeta[] }} [meta]
 * @returns {HistorySeries[]}
 */
export function availableSeries(records, meta = {}) {
  /** @type {Set<string>} */
  const fixed = new Set();
  /** @type {boolean[]} */
  const cells = [];
  /** @type {boolean[]} */
  const temps = [];
  /** @type {Set<string>} */
  const extras = new Set();
  const pending = new Set(HISTORY_SERIES.map((s) => s.id));
  for (const r of records) {
    if (pending.size) {
      for (const s of HISTORY_SERIES) {
        if (pending.has(s.id) && s.pick(r) !== undefined) {
          fixed.add(s.id);
          pending.delete(s.id);
        }
      }
    }
    if (r.c) for (let i = 0; i < r.c.length; i++) if (!cells[i] && finite(r.c[i]) !== undefined) cells[i] = true;
    if (r.tc) for (let i = 0; i < r.tc.length; i++) if (!temps[i] && finite(r.tc[i]) !== undefined) temps[i] = true;
    if (r.x) for (const id in r.x) if (finite(r.x[id]) !== undefined) extras.add(id);
  }
  const out = HISTORY_SERIES.filter((s) => fixed.has(s.id));
  for (let i = 0; i < cells.length; i++) if (cells[i]) out.push(cellSeries(i));
  const labels = meta.tempLabels ?? [];
  for (let i = 0; i < temps.length; i++) if (temps[i]) out.push(temperatureSeries(i, labels[i]));
  // Extra values in the order of the meta (the driver's order), unknown ones after them.
  const defs = Array.isArray(meta.extraSeries) ? meta.extraSeries : [];
  for (const d of defs) if (extras.delete(d.id)) out.push(extraSeries(d.id, d));
  for (const id of extras) out.push(extraSeries(id));
  return out;
}

/**
 * @typedef {Object} HistoryDeviceMeta stored next to the records of one device
 * @property {string} name display name
 * @property {string} [vendor]
 * @property {string} [protocol]
 * @property {string} [driverId]
 * @property {string} [deviceType]
 * @property {string} [model]
 * @property {string} [serialNumber]
 * @property {number} [cellCount]
 * @property {number} [address] bus address the device was read at (RS485 address or board
 *   number), when one was set
 * @property {string[]} tempLabels English temperature labels in snapshot order
 * @property {ExtraSeriesMeta[]} [extraSeries] charted driver extra values (labels and units)
 */

/**
 * Stored name of a device that reports none and has no link name, in English; the UI translates
 * it when it shows the name.
 */
export const UNNAMED_DEVICE = msg('Device');

/**
 * @param {unknown} v
 * @returns {string}
 */
const text = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '');

/**
 * A bus address that tells devices on one link apart: a finite integer, else undefined.
 * @param {unknown} v
 * @returns {number | undefined}
 */
const busAddress = (v) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);

/**
 * Build the device metadata stored with the history.
 * @param {Object} src
 * @param {Partial<import('./driver.js').DriverDefinition>} [src.definition]
 * @param {import('./model.js').DeviceInfo | null} [src.info]
 * @param {import('./model.js').BmsSnapshot | null} [src.snapshot]
 * @param {string} [src.deviceName] advertised or port name from the link
 * @param {number} [src.address] bus address (RS485 address or board number), when one was set
 * @returns {HistoryDeviceMeta}
 */
export function historyDeviceMeta({ definition, info, snapshot, deviceName, address } = {}) {
  /** @type {Record<string, any>} */
  const m = {};
  const name = text(info?.name) || text(deviceName) || text(info?.model) || text(definition?.vendor) || text(definition?.id) || UNNAMED_DEVICE;
  m.name = name;
  /**
   * @param {string} key
   * @param {unknown} v
   */
  const put = (key, v) => {
    const s = text(v);
    if (s) m[key] = s;
  };
  put('vendor', info?.vendor || definition?.vendor);
  put('protocol', info?.protocol || definition?.protocol);
  put('driverId', definition?.id);
  put('deviceType', definition?.deviceType);
  put('model', info?.model);
  const sn = usableSerial(info?.serialNumber);
  if (sn) m.serialNumber = sn;
  if (Array.isArray(snapshot?.cells) && snapshot.cells.length) m.cellCount = snapshot.cells.length;
  const bus = busAddress(address);
  if (bus !== undefined) m.address = bus;
  m.tempLabels = Array.isArray(snapshot?.temperatures) ? snapshot.temperatures.map((x) => text(x?.label)) : [];
  const charted = chartedExtras(snapshot?.extra);
  if (charted.length) m.extraSeries = charted.map(([id, c]) => ({ id, label: text(c.label) || id, unit: c.unit, decimals: c.decimals }));
  return /** @type {HistoryDeviceMeta} */ (m);
}

/**
 * A serial number that identifies a device: non-empty after trimming, not '0' and not all zeros.
 * @param {unknown} v
 * @returns {string}
 */
export function usableSerial(v) {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : text(v);
  if (!s || /^0+$/.test(s)) return '';
  return s;
}

/**
 * Stable history key of a device:
 * - `sn:<family>:<serialNumber>` when the device reports a usable serial number;
 * - `<linkKind>:<linkId>` when the link has a stable id (BLE device id, desktop serial port path);
 * - `name:<driverId>:<deviceName>` otherwise.
 *
 * Several devices can share one link (packs on one RS485 bus): when a bus address is set, the
 * link and name rules end with `#<address>`, so `serial:COM7#1` and `serial:COM7#2` are two
 * histories. A serial number identifies the device by itself.
 * @param {Object} src
 * @param {import('./model.js').DeviceInfo | null} [src.info]
 * @param {Partial<import('./driver.js').DriverDefinition>} [src.definition]
 * @param {string} [src.linkKind] for example 'ble', 'serial', 'tauri-ble'
 * @param {string} [src.linkId] stable link id, or empty when the link has none
 * @param {string} [src.deviceName]
 * @param {number} [src.address] bus address (RS485 address or board number), when one was set
 * @returns {string}
 */
export function deviceHistoryKey({ info, definition, linkKind, linkId, deviceName, address } = {}) {
  const sn = usableSerial(info?.serialNumber);
  if (sn) return `sn:${text(definition?.family) || text(definition?.id) || 'device'}:${sn}`;
  const bus = busAddress(address);
  const at = bus === undefined ? '' : `#${bus}`;
  const id = text(linkId);
  if (id) return `${text(linkKind) || 'link'}:${id}${at}`;
  const name = text(deviceName) || text(info?.name) || text(info?.model) || 'device';
  return `name:${text(definition?.id) || 'unknown'}:${name}${at}`;
}
