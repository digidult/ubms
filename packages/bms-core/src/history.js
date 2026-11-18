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
