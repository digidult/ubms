import { html, css, nothing } from 'lit';
import { UiElement, define } from '../element.js';
import { sharedStyles } from '../theme.js';
import { i18n, t } from '../i18n.js';
import { downsampleMinMax } from '../timeseries.js';

/**
 * Time series line chart on a canvas: several series sharing one y axis, nice ticks, local time
 * labels, gaps where samples are missing, crosshair with tooltip (pointer and touch), legend with
 * toggles, theme colors, and `drawTo()` for image export.
 *
 * Charts stacked above each other share the time axis when they get the same `from`, `to` and
 * `gutter` (the width left of the plot for the y labels) and have the same width. Each chart
 * reports the width its own labels need (`labelWidth()` and the `chart-gutter` event); the
 * container passes the largest one to all of them.
 *
 * Events (bubbling, composed):
 * - `chart-cursor` detail `{ time: number | null }` when the user moves the crosshair (null when
 *   it leaves); set `cursor` on sibling charts to synchronize them.
 * - `chart-gutter` detail `{ width: number }` when the width the y labels need has changed.
 * - `legend-change` detail `{ id, hidden: string[] }` when a legend entry is toggled.
 *
 * Touch: a tap shows the crosshair, a tap on it again or outside the plot hides it, and so does a
 * scroll that starts on the chart.
 *
 * @typedef {Object} ChartSeries
 * @property {string} id
 * @property {string} label display label (already translated)
 * @property {Array<{ t: number, v: number }>} points sorted by time
 * @property {string} [color] CSS color or `var(--token)`; defaults to the palette by position
 * @property {string} [unit] unit in the tooltip (defaults to the chart unit)
 * @property {number} [decimals] tooltip decimals
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_STEPS = [
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  91 * DAY,
  182 * DAY,
  365 * DAY,
];

/**
 * @param {unknown} v
 * @returns {v is number}
 */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Number of decimals needed to print multiples of `step` exactly.
 * @param {number} step
 */
function stepDecimals(step) {
  let d = 0;
  while (d < 10) {
    const f = step * 10 ** d;
    if (Math.abs(f - Math.round(f)) < 1e-6 * Math.max(1, f)) break;
    d++;
  }
  return d;
}

/**
 * "Nice" axis ticks (multiples of 1, 2, 2.5 or 5 times a power of ten) covering [lo, hi].
 * @param {number} lo
 * @param {number} hi
 * @param {number} [maxTicks] approximate number of intervals
 * @returns {{ min: number, max: number, step: number, ticks: number[], decimals: number }}
 */
export function niceTicks(lo, hi, maxTicks = 5) {
  if (!isNum(lo) || !isNum(hi)) return { min: 0, max: 1, step: 1, ticks: [0, 1], decimals: 0 };
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi - lo < 1e-12) {
    const pad = Math.abs(lo) * 0.02 || 1;
    lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / Math.max(1, Math.floor(maxTicks));
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const decimals = stepDecimals(step);
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const f = 10 ** decimals;
  /** @type {number[]} */
  const ticks = [];
  for (let k = 0, v = min; v <= max + step * 1e-6 && k < 200; k++, v = min + k * step) ticks.push(Math.round(v * f) / f + 0);
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks, decimals };
}

/**
 * Offset of local time from UTC at an instant, ms (positive east of Greenwich).
 * @param {number} time
 */
const localOffset = (time) => -new Date(time).getTimezoneOffset() * MINUTE;

/**
 * Time axis ticks at round local times (seconds, minutes, hours, midnights, month starts).
 * @param {number} from epoch ms
 * @param {number} to epoch ms
 * @param {number} [maxTicks]
 * @returns {{ step: number, ticks: number[] }}
 */
export function timeTicks(from, to, maxTicks = 6) {
  if (!isNum(from) || !isNum(to) || !(to > from)) return { step: SECOND, ticks: [] };
  const span = to - from;
  const want = Math.max(1, Math.floor(maxTicks));
  const step = TIME_STEPS.find((s) => span / s <= want) ?? Math.ceil(span / want / (365 * DAY)) * 365 * DAY;
  /** @type {number[]} */
  const ticks = [];
  if (step < DAY) {
    // Align in local time, so hour ticks land on full local hours in every time zone.
    let local = Math.ceil((from + localOffset(from)) / step) * step;
    for (let k = 0; k < 500; k++, local += step) {
      // Local wall time back to an instant; the second lookup handles a DST change in between.
      const time = local - localOffset(local - localOffset(from));
      if (time > to) break;
      // Wall times skipped or repeated by a DST change would go backwards: keep ticks increasing.
      if (time >= from && (!ticks.length || time > ticks[ticks.length - 1])) ticks.push(time);
    }
    return { step, ticks };
  }
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (step >= 365 * DAY) {
    // Whole years: every tick on January 1 (a step of 3 years is not 37 months of 30 days).
    const years = Math.round(step / (365 * DAY));
    d.setMonth(0, 1);
    while (d.getTime() < from) d.setFullYear(d.getFullYear() + 1);
    for (let k = 0; k < 500 && d.getTime() <= to; k++) {
      ticks.push(d.getTime());
      d.setFullYear(d.getFullYear() + years);
    }
    return { step, ticks };
  }
  if (step >= 30 * DAY) {
    const months = Math.max(1, Math.round(step / (30 * DAY)));
    d.setDate(1);
    d.setMonth(Math.ceil(d.getMonth() / months) * months);
    while (d.getTime() < from) d.setMonth(d.getMonth() + months);
    for (let k = 0; k < 500 && d.getTime() <= to; k++) {
      ticks.push(d.getTime());
      d.setMonth(d.getMonth() + months);
    }
    return { step, ticks };
  }
  const days = Math.round(step / DAY);
  while (d.getTime() < from) d.setDate(d.getDate() + 1);
  for (let k = 0; k < 500 && d.getTime() <= to; k++) {
    ticks.push(d.getTime());
    d.setDate(d.getDate() + days);
  }
  return { step, ticks };
}

/**
 * Typical sampling interval: the median distance of the last (up to) 200 points.
 * @param {Array<{ t: number }>} points sorted by time
 * @returns {number} ms, 0 when unknown
 */
export function estimateInterval(points) {
  const n = points?.length ?? 0;
  if (n < 2) return 0;
  /** @type {number[]} */
  const diffs = [];
  for (let i = Math.max(1, n - 200); i < n; i++) {
    const d = points[i].t - points[i - 1].t;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

/**
 * Split points into runs without gaps longer than `gapMs`.
 * @template {{ t: number }} P
 * @param {P[]} points sorted by time
 * @param {number} gapMs
 * @returns {P[][]}
 */
export function splitSegments(points, gapMs) {
  /** @type {P[][]} */
  const out = [];
  /** @type {P[]} */
  let cur = [];
  for (const p of points) {
    if (cur.length && p.t - cur[cur.length - 1].t > gapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Point closest in time, or null when none lies within `tolerance` ms.
 * @template {{ t: number }} P
 * @param {P[]} points sorted by time
 * @param {number} time
 * @param {number} [tolerance]
 * @returns {P | null}
 */
export function nearestPoint(points, time, tolerance = Infinity) {
  const n = points?.length ?? 0;
  if (!n || !isNum(time)) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (points[mid].t < time) lo = mid + 1;
    else hi = mid;
  }
  /** @type {P | null} */
  let best = null;
  for (const i of [lo - 1, lo]) {
    const p = points[i];
    if (p && (!best || Math.abs(p.t - time) < Math.abs(best.t - time))) best = p;
  }
  return best && Math.abs(best.t - time) <= tolerance ? best : null;
}

/** Default palette: theme tokens first (they have light and dark variants). */
const PALETTE_TOKENS = [
  ['--ui-primary', '#1f6feb'],
  ['--ui-discharge', '#d0611a'],
  ['--ui-ok', '#16834a'],
  ['--ui-danger', '#c62f3b'],
  ['--ui-info', '#0a7ea4'],
  ['--ui-warn', '#b26a00'],
];

/** @type {CanvasRenderingContext2D | null} */
let probeCtx = null;

/**
 * Normalize a CSS color through the canvas parser ('#rrggbb' or 'rgba(...)').
 * @param {string} value
 * @param {string} fallback
 */
function canvasColor(value, fallback) {
  if (!value) return fallback;
  if (!probeCtx && typeof document !== 'undefined') probeCtx = document.createElement('canvas').getContext('2d');
  if (!probeCtx) return value;
  probeCtx.fillStyle = '#010203';
  probeCtx.fillStyle = value;
  const out = String(probeCtx.fillStyle);
  return out === '#010203' && value.toLowerCase() !== '#010203' ? fallback : out;
}

/**
 * Relative luminance (0 to 1) of a normalized canvas color.
 * @param {string} color
 */
function luminance(color) {
  let r = 255;
  let g = 255;
  let b = 255;
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  const rgb = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/i.exec(color);
  if (hex) {
    const n = parseInt(hex[1], 16);
    r = (n >> 16) & 255;
    g = (n >> 8) & 255;
    b = n & 255;
  } else if (rgb) {
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** @type {Map<string, Intl.DateTimeFormat>} */
const dateFormats = new Map();
/** @type {Map<string, Intl.NumberFormat>} */
const numberFormats = new Map();

/**
 * @param {string} locale
 * @param {Intl.DateTimeFormatOptions} opts
 */
function dateFormat(locale, opts) {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dateFormats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, opts);
    } catch {
      f = new Intl.DateTimeFormat(undefined, opts);
    }
    dateFormats.set(key, f);
  }
  return f;
}

/**
 * Number formatter with a fixed number of decimals. A negative value that rounds to zero prints
 * without a minus ("0.0", not "-0.0").
 * @param {string} locale
 * @param {number} decimals
 * @returns {{ format: (value: number) => string }}
 */
function numberFormat(locale, decimals) {
  const d = Math.max(0, Math.min(10, Math.round(decimals)));
  const key = `${locale}|${d}`;
  let f = numberFormats.get(key);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
    } catch {
      f = new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
    }
    numberFormats.set(key, f);
  }
  const nf = f;
  const tiny = 0.5 * 10 ** -d;
  return { format: (value) => nf.format(Math.abs(value) < tiny ? 0 : value) };
}

/** Local calendar day of an instant, for "does the window cross midnight". */
const dayOf = (/** @type {number} */ time) => {
  const d = new Date(time);
  return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate();
};

/**
 * Label format of time ticks for a tick step.
 * @param {number} step
 * @returns {Intl.DateTimeFormatOptions}
 */
function tickFormat(step) {
  if (step < MINUTE) return { hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (step < DAY) return { hour: '2-digit', minute: '2-digit' };
  if (step >= 365 * DAY) return { year: 'numeric' };
  if (step >= 30 * DAY) return { month: 'short', year: 'numeric' };
  return { month: 'short', day: 'numeric' };
}

const FONT_SIZE = 11;
const PROPS_THAT_REDRAW = ['series', 'from', 'to', 'unit', 'decimals', 'interval', 'height', 'zero', 'min', 'max', 'hidden', 'area', 'gutter'];
/** A tap this close to the crosshair (CSS pixels) hides it on touch screens. */
const TAP_HIDE_PX = 12;

/**
 * @typedef {Object} Theme
 * @property {string} font
 * @property {string} text
 * @property {string} muted
 * @property {string} faint
 * @property {string} border
 * @property {string} surface
 * @property {boolean} dark
 * @property {(index: number, own?: string) => string} color
 *
 * @typedef {Object} DrawnSeries
 * @property {ChartSeries} series
 * @property {string} color
 * @property {Array<{ t: number, v: number }>} points downsampled points in the window
 *
 * @typedef {Object} Layout
 * @property {number} from
 * @property {number} to
 * @property {{ x: number, y: number, w: number, h: number }} plot
 * @property {number} labelWidth width the y labels need left of the plot (without `gutter`)
 * @property {number} lo
 * @property {number} hi
 * @property {number} gapMs
 * @property {number} interval
 * @property {DrawnSeries[]} drawn
 * @property {ReturnType<typeof niceTicks>} y
 * @property {boolean} empty
 */

/** Line chart of time series. */
export class UiChart extends UiElement {
  static properties = {
    series: { type: Array },
    from: { type: Number },
    to: { type: Number },
    unit: { type: String },
    decimals: { type: Number },
    interval: { type: Number },
    height: { type: Number },
    zero: { type: Boolean },
    min: { type: Number },
    max: { type: Number },
    cursor: { type: Number },
    hidden: { type: Array },
    legend: { type: Boolean },
    area: { type: Boolean },
    gutter: { type: Number },
    emptyText: { type: String, attribute: 'empty-text' },
    label: { type: String },
    _tip: { state: true },
    _colors: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        min-width: 0;
        position: relative;
      }
      .wrap {
        position: relative;
        width: 100%;
        height: var(--chart-h, 200px);
      }
      canvas {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
      }
      canvas.overlay {
        touch-action: pan-y;
        cursor: crosshair;
      }
      .empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        color: var(--ui-text-faint);
        font-size: 0.9rem;
        pointer-events: none;
        text-align: center;
        padding: 0 16px;
      }
      .tip {
        position: absolute;
        z-index: 2;
        pointer-events: none;
        min-width: 120px;
        max-width: min(320px, 70%);
        padding: 6px 9px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface);
        border: 1px solid var(--ui-border);
        box-shadow: var(--ui-shadow);
        font-size: 0.78rem;
        line-height: 1.35;
        font-variant-numeric: tabular-nums;
      }
      .tip.left {
        transform: translateX(-100%);
      }
      .tip .time {
        color: var(--ui-text-muted);
        font-weight: 600;
        margin-bottom: 2px;
        white-space: nowrap;
      }
      .tip .rows.many {
        display: grid;
        grid-template-columns: 1fr 1fr;
        column-gap: 10px;
      }
      .tip .r {
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .tip .r .l {
        color: var(--ui-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .tip .r .v {
        margin-left: auto;
        font-weight: 600;
      }
      .sw {
        flex: none;
        width: 9px;
        height: 9px;
        border-radius: 3px;
        background: var(--c);
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 6px;
        margin-top: 6px;
      }
      .legend button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        border: 1px solid var(--ui-border);
        background: var(--ui-surface);
        color: var(--ui-text);
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
      }
      .legend button[aria-pressed='false'] {
        color: var(--ui-text-faint);
        background: transparent;
      }
      .legend button[aria-pressed='false'] .sw {
        background: transparent;
        box-shadow: inset 0 0 0 1.5px var(--c);
      }
      .legend button:focus-visible {
        outline: 2px solid var(--ui-primary);
        outline-offset: 2px;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {ChartSeries[]} */
    this.series = [];
    /** @type {number | undefined} window start, epoch ms (auto from the data when not finite) */
    this.from = undefined;
    /** @type {number | undefined} window end, epoch ms (auto from the data when not finite) */
    this.to = undefined;
    this.unit = '';
    /** @type {number | undefined} tooltip decimals (series decimals win) */
    this.decimals = undefined;
    /** @type {number} sampling interval ms for gap detection; 0 estimates it from the data */
    this.interval = 0;
    this.height = 200;
    /** Always include zero in the y range. */
    this.zero = false;
    /** @type {number | undefined} fixed y axis minimum */
    this.min = undefined;
    /** @type {number | undefined} fixed y axis maximum */
    this.max = undefined;
    /** @type {number | null} crosshair time (set by the user or by a synchronized sibling) */
    this.cursor = null;
    /** @type {string[]} ids of series switched off in the legend */
    this.hidden = [];
    this.legend = true;
    /** Fill the area under the line when one series is shown. */
    this.area = true;
    /** Minimum width left of the plot for the y labels, CSS pixels (shared by stacked charts). */
    this.gutter = 0;
    this.emptyText = '';
    this.label = '';
    /** @type {any} */
    this._tip = null;
    /** Signature of the resolved palette, re-renders the legend after a theme change. */
    this._colors = '';
    /** @type {Layout | null} */
    this.__layout = null;
    /** @type {Theme | null} */
    this.__theme = null;
    this.__raf = 0;
    this.__full = false;
    /** Width the y labels needed in the last drawing. */
    this.__labelWidth = 0;
    /** @type {WeakMap<object, { len: number, from: number, to: number, buckets: number, out: any[] }>} */
    this.__ds = new WeakMap();
  }

  connectedCallback() {
    super.connectedCallback();
    if (typeof window === 'undefined') return;
    const redraw = () => this.redraw();
    this.__offLocaleDraw = i18n.onChange(redraw);
    this.__mo = new MutationObserver(redraw);
    this.__mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] });
    this.__mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    this.__mq?.addEventListener?.('change', redraw);
    this.__mqHandler = redraw;
    // Moved in the DOM (disconnected and connected again): observe the size again and redraw.
    if (this.hasUpdated) {
      this.#observe();
      this.redraw();
    }
  }

  disconnectedCallback() {
    this.__offLocaleDraw?.();
    this.__mo?.disconnect();
    if (this.__mqHandler) this.__mq?.removeEventListener?.('change', this.__mqHandler);
    this.__ro?.disconnect();
    this.__ro = undefined;
    if (this.__raf) cancelAnimationFrame(this.__raf);
    this.__raf = 0;
    super.disconnectedCallback();
  }

  firstUpdated() {
    this.#observe();
  }

  #observe() {
    const wrap = this.renderRoot?.querySelector('.wrap');
    if (!wrap || this.__ro || typeof ResizeObserver === 'undefined') return;
    this.__ro = new ResizeObserver(() => this.redraw());
    this.__ro.observe(wrap);
  }

  /** @param {Map<string, unknown>} changed */
  updated(changed) {
    if (PROPS_THAT_REDRAW.some((k) => changed.has(k))) this.#schedule(true);
    else if (changed.has('cursor')) this.#schedule(false);
  }

  /** Redraw everything on the next animation frame (for example after a theme change). */
  redraw() {
    this.#schedule(true);
  }

  /** @param {boolean} full */
  #schedule(full) {
    this.__full ||= full;
    if (this.__raf || typeof requestAnimationFrame === 'undefined') return;
    this.__raf = requestAnimationFrame(() => {
      this.__raf = 0;
      const all = this.__full;
      this.__full = false;
      if (all) this.#drawBase();
      this.#drawOverlay();
    });
  }

  render() {
    const showLegend = this.legend && (this.series?.length ?? 0) > 1;
    const hidden = new Set(this.hidden ?? []);
    const tip = this._tip;
    const empty = !this.#hasData();
    return html`<div class="wrap" style="--chart-h:${Math.max(60, this.height || 200)}px">
        <canvas class="base" role="img" aria-label=${this.label || (this.series ?? []).map((s) => s.label).join(', ')}></canvas>
        <canvas
          class="overlay"
          aria-hidden="true"
          @pointerdown=${this.#onDown}
          @pointermove=${this.#onMove}
          @pointerleave=${this.#onLeave}
          @pointercancel=${this.#onCancel}
        ></canvas>
        ${empty ? html`<div class="empty">${this.emptyText || t('No data')}</div>` : nothing}
        ${tip
          ? html`<div class="tip ${tip.left ? 'left' : ''}" style="left:${tip.x}px;top:${tip.y}px">
              <div class="time">${tip.time}</div>
              <div class="rows ${tip.rows.length > 10 ? 'many' : ''}">
                ${tip.rows.map(
                  (/** @type {any} */ r) => html`<div class="r"><span class="sw" style="--c:${r.color}"></span><span class="l">${r.label}</span><span class="v">${r.value}</span></div>`,
                )}
              </div>
            </div>`
          : nothing}
      </div>
      ${showLegend
        ? html`<div class="legend">
            ${(this.series ?? []).map((s, i) => {
              const on = !hidden.has(s.id);
              return html`<button aria-pressed=${on ? 'true' : 'false'} style="--c:${this.#color(i, s.color)}" @click=${() => this.#toggle(s.id)}>
                <span class="sw"></span>${s.label}
              </button>`;
            })}
          </div>`
        : nothing}`;
  }

  /**
   * Resolved theme colors and font of this chart, for drawing around `drawTo()` (export
   * background and header).
   * @returns {{ font: string, text: string, muted: string, faint: string, border: string, surface: string, dark: boolean }}
   */
  colors() {
    const { font, text, muted, faint, border, surface, dark } = this.#theme();
    return { font, text, muted, faint, border, surface, dark };
  }

  /**
   * Width the y labels need left of the plot in the last drawing on screen, CSS pixels. Stacked
   * charts pass the largest value of all of them as `gutter`, so their time axes line up.
   */
  labelWidth() {
    return this.__labelWidth;
  }

  /**
   * Width the y labels need when `drawTo()` draws the chart at this size (the number of y ticks
   * depends on the height). An image of stacked charts passes the largest value of all of them
   * as `gutter` to `drawTo()`.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   */
  exportLabelWidth(ctx, width, height) {
    const theme = this.#theme();
    ctx.save();
    const top = this.legend && (this.series?.length ?? 0) > 1 ? this.#paintLegend(ctx, width, theme, false) : 0;
    const layout = this.#layout(ctx, width, height - top, theme, 2, 0);
    ctx.restore();
    return layout.labelWidth;
  }

  /**
   * Draw the chart (axes, lines and, with several series, a legend line) into another canvas,
   * for example an image export. Coordinates are in the context's current units. Nothing is
   * drawn behind the chart: paint the background first (`colors().surface`), because labels use
   * the current theme colors.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} width
   * @param {number} height
   * @param {{ gutter?: number }} [opts] gutter: minimum width left of the plot (defaults to the
   *   `gutter` property); see `exportLabelWidth()`
   */
  drawTo(ctx, x, y, width, height, { gutter = this.gutter } = {}) {
    const theme = this.#theme();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    ctx.translate(x, y);
    let top = 0;
    if (this.legend && (this.series?.length ?? 0) > 1) top = this.#paintLegend(ctx, width, theme);
    ctx.translate(0, top);
    const layout = this.#layout(ctx, width, height - top, theme, 2, gutter);
    this.#paint(ctx, layout, theme);
    if (layout.empty) {
      ctx.fillStyle = theme.faint;
      ctx.font = `${FONT_SIZE + 2}px ${theme.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.emptyText || t('No data'), width / 2, (height - top) / 2);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------------------------------- */

  /** A visible series has a point inside the window. */
  #hasData() {
    const hidden = new Set(this.hidden ?? []);
    const from = isNum(this.from) ? /** @type {number} */ (this.from) : -Infinity;
    const to = isNum(this.to) ? /** @type {number} */ (this.to) : Infinity;
    return (this.series ?? []).some((s) => {
      const pts = s?.points;
      if (!pts?.length || hidden.has(s.id)) return false;
      let lo = 0;
      let hi = pts.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (pts[mid].t < from) lo = mid + 1;
        else hi = mid;
      }
      return lo < pts.length && pts[lo].t <= to;
    });
  }

  /** @param {string} id */
  #toggle(id) {
    const hidden = new Set(this.hidden ?? []);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    this.hidden = [...hidden];
    this.fire('legend-change', { id, hidden: this.hidden });
  }

  /**
   * Series color for the legend (CSS) and the canvas.
   * @param {number} index
   * @param {string} [own]
   */
  #color(index, own) {
    return (this.__theme ?? this.#theme()).color(index, own);
  }

  /** @returns {Theme} */
  #theme() {
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(this) : null;
    /**
     * @param {string} name
     * @param {string} fb
     */
    const prop = (name, fb) => cs?.getPropertyValue(name).trim() || fb;
    /**
     * Resolve `var(--x, fallback)` and normalize.
     * @param {string} value
     * @param {string} fb
     * @returns {string}
     */
    const resolve = (value, fb) => {
      const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
      if (m) return resolve(prop(m[1], m[2] ?? fb), fb);
      return canvasColor(value, fb);
    };
    const surface = resolve(prop('--ui-surface', '#ffffff'), '#ffffff');
    const dark = luminance(surface) < 0.45;
    /** @type {Map<string, string>} */
    const cache = new Map();
    const theme = {
      font: prop('--ui-font', 'system-ui, sans-serif'),
      text: resolve(prop('--ui-text', dark ? '#e6ebf1' : '#18202b'), '#18202b'),
      muted: resolve(prop('--ui-text-muted', '#5b6878'), '#5b6878'),
      faint: resolve(prop('--ui-text-faint', '#8a96a5'), '#8a96a5'),
      border: resolve(prop('--ui-border', '#d9dfe7'), '#d9dfe7'),
      surface,
      dark,
      /**
       * @param {number} index
       * @param {string} [own]
       */
      color(index, own) {
        const key = `${index}|${own ?? ''}`;
        let c = cache.get(key);
        if (c) return c;
        const custom = prop(`--ui-chart-${index + 1}`, '');
        if (own) c = resolve(own, '');
        if (!c && custom) c = resolve(custom, '');
        if (!c && index < PALETTE_TOKENS.length) c = resolve(prop(PALETTE_TOKENS[index][0], PALETTE_TOKENS[index][1]), PALETTE_TOKENS[index][1]);
        if (!c) {
          // Golden angle hues; lightness picked for contrast with the surface.
          const hue = Math.round((index * 137.508 + 265) % 360);
          c = canvasColor(`hsl(${hue}, 62%, ${dark ? 66 : 42}%)`, dark ? '#9aa7b6' : '#5b6878');
        }
        cache.set(key, c);
        return c;
      },
    };
    this.__theme = theme;
    return theme;
  }

  /**
   * Downsampled points of a series in the window (cached per points array).
   * @param {ChartSeries} s
   * @param {number} from
   * @param {number} to
   * @param {number} buckets
   */
  #points(s, from, to, buckets) {
    const pts = s.points ?? [];
    const hit = this.__ds.get(pts);
    if (hit && hit.len === pts.length && hit.from === from && hit.to === to && hit.buckets === buckets) return hit.out;
    const out = downsampleMinMax(pts, from, to, buckets);
    this.__ds.set(pts, { len: pts.length, from, to, buckets, out });
    return out;
  }

  /**
   * Compute scales and the plot rectangle.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {number} height
   * @param {Theme} theme
   * @param {number} pixelRatio
   * @param {number} [gutter] minimum width left of the plot
   * @returns {Layout}
   */
  #layout(ctx, width, height, theme, pixelRatio, gutter = 0) {
    const all = this.series ?? [];
    const hidden = new Set(this.hidden ?? []);
    const visible = all.map((s, i) => ({ s, i })).filter(({ s }) => s && !hidden.has(s.id));
    let from = isNum(this.from) ? /** @type {number} */ (this.from) : Infinity;
    let to = isNum(this.to) ? /** @type {number} */ (this.to) : -Infinity;
    if (!isNum(this.from) || !isNum(this.to)) {
      for (const { s } of visible.length ? visible : all.map((s, i) => ({ s, i }))) {
        const p = s?.points;
        if (!p?.length) continue;
        if (!isNum(this.from)) from = Math.min(from, p[0].t);
        if (!isNum(this.to)) to = Math.max(to, p[p.length - 1].t);
      }
    }
    if (!isNum(from) || !isNum(to)) {
      from = Date.now() - HOUR;
      to = Date.now();
    }
    if (!(to > from)) {
      from -= MINUTE / 2;
      to += MINUTE / 2;
    }
    const unitH = this.unit ? FONT_SIZE + 7 : 6;
    const top = unitH + 4;
    const bottom = FONT_SIZE + 12;
    const right = 12;
    const approxW = Math.max(20, width - 60);
    const buckets = Math.max(16, Math.round(approxW * Math.min(2, Math.max(1, pixelRatio))));
    /** @type {DrawnSeries[]} */
    const drawn = [];
    let lo = Infinity;
    let hi = -Infinity;
    let interval = isNum(this.interval) && this.interval > 0 ? this.interval : 0;
    for (const { s, i } of visible) {
      const pts = this.#points(s, from, to, buckets);
      if (!interval && s.points?.length) interval = estimateInterval(s.points);
      for (const p of pts) {
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
      }
      drawn.push({ series: s, color: theme.color(i, s.color), points: pts });
    }
    const empty = !drawn.some((d) => d.points.length);
    if (!isNum(lo) || !isNum(hi)) {
      lo = 0;
      hi = 1;
    }
    if (this.zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (isNum(this.min)) lo = /** @type {number} */ (this.min);
    if (isNum(this.max)) hi = /** @type {number} */ (this.max);
    const plotH = Math.max(10, height - top - bottom);
    const y = niceTicks(lo, hi, Math.max(2, Math.min(8, Math.floor(plotH / 34))));
    if (isNum(this.min)) y.min = /** @type {number} */ (this.min);
    if (isNum(this.max)) y.max = /** @type {number} */ (this.max);
    y.ticks = y.ticks.filter((v) => v >= y.min - 1e-9 && v <= y.max + 1e-9);
    ctx.font = `${FONT_SIZE}px ${theme.font}`;
    const nf = numberFormat(i18n.locale, y.decimals);
    let labelW = 0;
    for (const v of y.ticks) labelW = Math.max(labelW, ctx.measureText(nf.format(v)).width);
    if (this.unit) labelW = Math.max(labelW, ctx.measureText(this.unit).width);
    const labelWidth = Math.ceil(labelW) + 10;
    // The plot width also picks the time tick step, so a shared gutter gives the same ticks too.
    const left = Math.max(labelWidth, isNum(gutter) && gutter > 0 ? Math.ceil(gutter) : 0);
    const plot = { x: left, y: top, w: Math.max(10, width - left - right), h: plotH };
    const span = to - from;
    const gapMs = interval > 0 ? Math.max(3 * interval, (2.5 * span) / buckets) : Infinity;
    const layout = { from, to, plot, labelWidth, lo: y.min, hi: y.max, gapMs, interval, drawn, y, empty };
    return layout;
  }

  /**
   * Paint axes and lines of a layout into a context whose origin is the chart's top left corner.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Layout} L
   * @param {Theme} theme
   */
  #paint(ctx, L, theme) {
    const { plot, from, to } = L;
    const xOf = (/** @type {number} */ time) => plot.x + ((time - from) / (to - from)) * plot.w;
    const span = L.hi - L.lo || 1;
    const yOf = (/** @type {number} */ v) => plot.y + plot.h - ((v - L.lo) / span) * plot.h;
    const locale = i18n.locale;
    ctx.font = `${FONT_SIZE}px ${theme.font}`;
    ctx.lineWidth = 1;

    // Unit above the y labels (an empty chart has no meaningful y axis).
    if (this.unit && !L.empty) {
      ctx.fillStyle = theme.muted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(this.unit, 2, FONT_SIZE + 1);
    }

    // Horizontal grid and y labels.
    const nf = numberFormat(locale, L.y.decimals);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of L.empty ? [] : L.y.ticks) {
      const yy = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = theme.border;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(plot.x, yy);
      ctx.lineTo(plot.x + plot.w, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = theme.muted;
      ctx.fillText(nf.format(v), plot.x - 6, yy);
    }
    if (!L.empty && L.lo < 0 && L.hi > 0) {
      const yy = Math.round(yOf(0)) + 0.5;
      ctx.strokeStyle = theme.faint;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(plot.x, yy);
      ctx.lineTo(plot.x + plot.w, yy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Time axis.
    const { step, ticks } = timeTicks(from, to, Math.max(2, Math.floor(plot.w / 84)));
    const fmt = dateFormat(locale, tickFormat(step));
    const dateFmt = dateFormat(locale, { month: 'short', day: 'numeric' });
    const crossesDays = dayOf(from) !== dayOf(to);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y + plot.h + 0.5);
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h + 0.5);
    ctx.stroke();
    let lastRight = -Infinity;
    for (const time of ticks) {
      const xx = Math.round(xOf(time)) + 0.5;
      ctx.strokeStyle = theme.border;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(xx, plot.y);
      ctx.lineTo(xx, plot.y + plot.h);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const d = new Date(time);
      const midnight = step < DAY && crossesDays && d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
      const text = midnight ? dateFmt.format(time) : fmt.format(time);
      const w = ctx.measureText(text).width;
      let cx = xx;
      if (cx - w / 2 < plot.x - 6) cx = plot.x - 6 + w / 2;
      if (cx + w / 2 > plot.x + plot.w + 10) cx = plot.x + plot.w + 10 - w / 2;
      if (cx - w / 2 < lastRight + 8) continue;
      ctx.fillStyle = midnight ? theme.text : theme.muted;
      ctx.fillText(text, cx, plot.y + plot.h + 5);
      lastRight = cx + w / 2;
    }

    // Lines.
    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x - 1, plot.y - 3, plot.w + 2, plot.h + 6);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const fill = this.area && L.drawn.filter((d) => d.points.length).length === 1;
    for (const d of L.drawn) {
      if (!d.points.length) continue;
      const segments = splitSegments(d.points, L.gapMs);
      if (fill) {
        // The area reaches toward zero: the zero line, or the axis end nearest to it.
        const base = yOf(Math.max(L.lo, Math.min(L.hi, 0)));
        ctx.fillStyle = d.color;
        ctx.globalAlpha = theme.dark ? 0.18 : 0.12;
        for (const seg of segments) {
          if (seg.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(xOf(seg[0].t), base);
          for (const p of seg) ctx.lineTo(xOf(p.t), yOf(p.v));
          ctx.lineTo(xOf(seg[seg.length - 1].t), base);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = d.color;
      ctx.fillStyle = d.color;
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      for (const seg of segments) {
        for (let k = 0; k < seg.length; k++) {
          const p = seg[k];
          if (k === 0) ctx.moveTo(xOf(p.t), yOf(p.v));
          else ctx.lineTo(xOf(p.t), yOf(p.v));
        }
      }
      ctx.stroke();
      for (const seg of segments) {
        if (seg.length !== 1) continue;
        ctx.beginPath();
        ctx.arc(xOf(seg[0].t), yOf(seg[0].v), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Legend line(s) for the image export. Returns the height used.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} width
   * @param {Theme} theme
   * @param {boolean} [paint] false only measures the height
   */
  #paintLegend(ctx, width, theme, paint = true) {
    const hidden = new Set(this.hidden ?? []);
    const items = (this.series ?? []).map((s, i) => ({ s, i })).filter(({ s }) => s && !hidden.has(s.id));
    if (!items.length) return 0;
    ctx.font = `600 ${FONT_SIZE}px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const rowH = FONT_SIZE + 8;
    let x = 2;
    let row = 0;
    for (const { s, i } of items) {
      const w = 14 + ctx.measureText(s.label).width;
      if (x > 2 && x + w > width) {
        x = 2;
        row++;
      }
      if (paint) {
        const cy = row * rowH + rowH / 2;
        ctx.fillStyle = theme.color(i, s.color);
        ctx.fillRect(x, cy - 4, 9, 9);
        ctx.fillStyle = theme.text;
        ctx.fillText(s.label, x + 14, cy + 0.5);
      }
      x += w + 14;
    }
    return (row + 1) * rowH + 4;
  }

  /** @returns {HTMLCanvasElement[]} */
  #canvases() {
    const root = this.renderRoot;
    return /** @type {HTMLCanvasElement[]} */ ([root?.querySelector('canvas.base'), root?.querySelector('canvas.overlay')]);
  }

  /**
   * Size a canvas to its box in device pixels and return a context in CSS pixels.
   * @param {HTMLCanvasElement} canvas
   */
  #prepare(canvas) {
    const dpr = Math.max(1, Math.min(4, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const bw = Math.max(1, Math.round(w * dpr));
    const bh = Math.max(1, Math.round(h * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h, dpr };
  }

  #drawBase() {
    const [base] = this.#canvases();
    if (!base) return;
    const prep = this.#prepare(base);
    if (!prep || prep.w < 4 || prep.h < 4) return;
    const theme = this.#theme();
    const layout = this.#layout(prep.ctx, prep.w, prep.h, theme, prep.dpr, this.gutter);
    this.__layout = layout;
    this.#paint(prep.ctx, layout, theme);
    // Legend swatches use the resolved colors of the current theme.
    const colors = (this.series ?? []).map((s, i) => theme.color(i, s?.color)).join(',');
    if (colors !== this._colors) this._colors = colors;
    // The y labels depend on the values and the height, never on the gutter: no feedback loop.
    if (layout.labelWidth !== this.__labelWidth) {
      this.__labelWidth = layout.labelWidth;
      this.fire('chart-gutter', { width: layout.labelWidth });
    }
  }

  #drawOverlay() {
    const [, overlay] = this.#canvases();
    if (!overlay) return;
    const prep = this.#prepare(overlay);
    const L = this.__layout;
    const time = this.cursor;
    if (!prep || !L || L.empty || time === null || time === undefined || !isNum(time) || time < L.from || time > L.to) {
      if (this._tip) this._tip = null;
      return;
    }
    const { ctx } = prep;
    const theme = this.__theme ?? this.#theme();
    const { plot } = L;
    const xOf = (/** @type {number} */ v) => plot.x + ((v - L.from) / (L.to - L.from)) * plot.w;
    const span = L.hi - L.lo || 1;
    const yOf = (/** @type {number} */ v) => plot.y + plot.h - ((v - L.lo) / span) * plot.h;
    const x = Math.round(xOf(time)) + 0.5;
    ctx.strokeStyle = theme.faint;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plot.y);
    ctx.lineTo(x, plot.y + plot.h);
    ctx.stroke();
    const tolerance = isNum(L.gapMs) ? L.gapMs / 2 : Infinity;
    /** @type {Array<{ color: string, label: string, value: string }>} */
    const rows = [];
    for (const d of L.drawn) {
      const p = nearestPoint(d.series.points ?? [], time, tolerance);
      if (!p || !isNum(p.v)) continue;
      const px = xOf(p.t);
      const py = yOf(p.v);
      if (py >= plot.y - 2 && py <= plot.y + plot.h + 2) {
        ctx.fillStyle = theme.surface;
        ctx.beginPath();
        ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = d.color;
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const decimals = isNum(d.series.decimals) ? d.series.decimals : isNum(this.decimals) ? this.decimals : L.y.decimals + 1;
      const unit = d.series.unit ?? this.unit;
      rows.push({
        color: d.color,
        label: d.series.label,
        value: `${numberFormat(i18n.locale, /** @type {number} */ (decimals)).format(p.v)}${unit ? ` ${unit}` : ''}`,
      });
    }
    const long = dayOf(L.from) !== dayOf(L.to);
    const years = new Date(L.from).getFullYear() !== new Date(L.to).getFullYear();
    /** @type {Intl.DateTimeFormatOptions} */
    const opts = { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    if (long) Object.assign(opts, { month: 'short', day: 'numeric' });
    if (long && years) opts.year = 'numeric';
    const left = x > plot.x + plot.w * 0.55;
    this._tip = { x: left ? x - 10 : x + 10, y: plot.y + 2, left, time: dateFormat(i18n.locale, opts).format(time), rows };
  }

  /** @param {PointerEvent} e */
  #timeAt(e) {
    const L = this.__layout;
    const canvas = /** @type {HTMLCanvasElement} */ (e.currentTarget);
    if (!L || L.empty || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < L.plot.x - 8 || x > L.plot.x + L.plot.w + 8) return null;
    const f = Math.max(0, Math.min(1, (x - L.plot.x) / L.plot.w));
    return L.from + f * (L.to - L.from);
  }

  /** @param {number | null} time */
  #setCursor(time) {
    if (time === this.cursor) return;
    this.cursor = time;
    this.fire('chart-cursor', { time });
  }

  /**
   * The pointer is within a few pixels of the crosshair.
   * @param {PointerEvent} e
   */
  #nearCursor(e) {
    const L = this.__layout;
    const time = this.cursor;
    const canvas = /** @type {HTMLCanvasElement} */ (e.currentTarget);
    if (!L || L.empty || !canvas || time === null || time === undefined || !isNum(time) || time < L.from || time > L.to) return false;
    const x = L.plot.x + ((time - L.from) / (L.to - L.from)) * L.plot.w;
    return Math.abs(e.clientX - canvas.getBoundingClientRect().left - x) <= TAP_HIDE_PX;
  }

  /** @param {PointerEvent} e */
  #onDown(e) {
    const time = this.#timeAt(e);
    // On touch screens the crosshair stays after the finger lifts: a tap outside the plot or on
    // the crosshair again hides it.
    if (e.pointerType === 'touch' && (time === null || this.#nearCursor(e))) {
      this.#setCursor(null);
      return;
    }
    if (time !== null) this.#setCursor(time);
  }

  /** @param {PointerEvent} e */
  #onMove(e) {
    const time = this.#timeAt(e);
    if (time !== null) this.#setCursor(time);
    else if (e.pointerType !== 'touch') this.#setCursor(null);
  }

  /** @param {PointerEvent} e */
  #onLeave(e) {
    // On touch screens the crosshair stays where the finger lifted, so the values can be read.
    if (e.pointerType === 'touch') return;
    this.#setCursor(null);
  }

  /** The browser took the pointer over (a touch became a page scroll): hide the crosshair. */
  #onCancel() {
    this.#setCursor(null);
  }
}
define('ui-chart', UiChart);
