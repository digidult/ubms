import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceTicks, timeTicks, estimateInterval, splitSegments, nearestPoint, UiChart } from '../src/components/chart.js';
import * as kit from '../src/index.js';
import { iconNames } from '../src/icons.js';

/** Local wall time of an instant as ms since the epoch (for alignment checks in any time zone). */
const local = (/** @type {number} */ t) => t - new Date(t).getTimezoneOffset() * 60000;

test('niceTicks covers the range with round steps', () => {
  const a = niceTicks(3.271, 3.348, 5);
  assert.equal(a.step, 0.02);
  assert.equal(a.decimals, 2);
  assert.equal(a.min, 3.26);
  assert.equal(a.max, 3.36);
  assert.deepEqual(a.ticks, [3.26, 3.28, 3.3, 3.32, 3.34, 3.36]);
  const b = niceTicks(-42, 118, 4);
  assert.equal(b.step, 50);
  assert.deepEqual(b.ticks, [-50, 0, 50, 100, 150]);
  assert.equal(b.decimals, 0);
  const c = niceTicks(0, 1, 4);
  assert.equal(c.step, 0.25);
  assert.equal(c.decimals, 2);
  // A flat line still gets a range around the value.
  const d = niceTicks(52, 52, 4);
  assert.ok(d.min < 52 && d.max > 52);
  const z = niceTicks(0, 0, 4);
  assert.ok(z.min < 0 && z.max > 0);
  // Swapped and invalid input.
  assert.deepEqual(niceTicks(10, 0, 2).ticks, [0, 5, 10]);
  assert.deepEqual(niceTicks(NaN, 1).ticks, [0, 1]);
});

test('timeTicks picks a step by span and aligns ticks to local time', () => {
  const from = Date.UTC(2026, 10, 19, 10, 3, 17);
  const five = timeTicks(from, from + 5 * 60000, 6);
  assert.equal(five.step, 60000);
  assert.equal(five.ticks.length, 5);
  for (const t of five.ticks) assert.equal(local(t) % 60000, 0);
  const twoHours = timeTicks(from, from + 2 * 3600000, 6);
  assert.equal(twoHours.step, 30 * 60000);
  for (const t of twoHours.ticks) {
    assert.equal(local(t) % (30 * 60000), 0);
    assert.ok(t >= from && t <= from + 2 * 3600000);
  }
  const seconds = timeTicks(from, from + 20000, 5);
  assert.equal(seconds.step, 5000);
  const week = timeTicks(from, from + 7 * 86400000, 8);
  assert.equal(week.step, 86400000);
  for (const t of week.ticks) {
    const d = new Date(t);
    assert.equal(d.getHours() * 60 + d.getMinutes(), 0);
  }
  assert.equal(week.ticks.length, 7);
  const year = timeTicks(from, from + 365 * 86400000, 6);
  for (const t of year.ticks) assert.equal(new Date(t).getDate(), 1);
  assert.deepEqual(timeTicks(5, 5).ticks, []);
});

test('timeTicks stays increasing across daylight saving changes', () => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    for (const [from, to] of [
      [Date.UTC(2026, 2, 8, 5), Date.UTC(2026, 2, 8, 9)], // clocks jump from 02:00 to 03:00
      [Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 1, 10)], // clocks go back from 02:00 to 01:00
    ]) {
      for (const max of [4, 8, 16]) {
        const { ticks } = timeTicks(from, to, max);
        assert.ok(ticks.length >= 2);
        for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] > ticks[i - 1], `${max}: ${ticks.map((t) => new Date(t).toISOString())}`);
        for (const t of ticks) assert.ok(t >= from && t <= to);
      }
    }
    const days = timeTicks(Date.UTC(2026, 9, 28), Date.UTC(2026, 10, 5), 8).ticks;
    for (const t of days) assert.equal(new Date(t).getHours(), 0);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test('estimateInterval, splitSegments and nearestPoint', () => {
  const pts = [0, 2000, 4000, 6000, 30000, 32000, 34000].map((t) => ({ t, v: t / 1000 }));
  assert.equal(estimateInterval(pts), 2000);
  assert.equal(estimateInterval([{ t: 1 }]), 0);
  const segs = splitSegments(pts, 6000);
  assert.deepEqual(segs.map((s) => s.map((p) => p.t)), [
    [0, 2000, 4000, 6000],
    [30000, 32000, 34000],
  ]);
  assert.deepEqual(splitSegments([], 1000), []);
  assert.equal(nearestPoint(pts, 2900)?.t, 2000);
  assert.equal(nearestPoint(pts, 3100)?.t, 4000);
  assert.equal(nearestPoint(pts, -100)?.t, 0);
  assert.equal(nearestPoint(pts, 99999)?.t, 34000);
  assert.equal(nearestPoint(pts, 18000, 3000), null);
  assert.equal(nearestPoint([], 1), null);
});

test('ui-chart and the chart icon are exported', () => {
  assert.equal(kit.UiChart, UiChart);
  assert.equal(typeof UiChart.prototype.drawTo, 'function');
  assert.ok(iconNames.includes('chart'));
  for (const name of ['createSeriesStore', 'indexedDbBackend', 'tauriFileBackend', 'memoryBackend', 'fallbackBackend', 'downsampleMinMax', 'csvEscape', 'toCsv', 'setFileSaver']) {
    assert.equal(typeof (/** @type {any} */ (kit)[name]), 'function', name);
  }
});

/** A 2D context that records `rect()` calls and measures text as 6 px per character. */
function recordingContext() {
  /** @type {number[][]} */
  const rects = [];
  /** @type {Record<string | symbol, any>} */
  const target = { rects, measureText: (/** @type {string} */ s) => ({ width: String(s).length * 6 }), rect: (/** @type {number[]} */ ...a) => rects.push(a) };
  const ctx = new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : () => {}),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return /** @type {any} */ (ctx);
}

/**
 * Left edge and width of the plot that `drawTo()` used (from its clip rectangle of the lines).
 * @param {UiChart} chart
 * @param {number} [gutter]
 */
function plotOf(chart, gutter) {
  const ctx = recordingContext();
  chart.drawTo(ctx, 0, 0, 600, 220, gutter === undefined ? {} : { gutter });
  const [x, , w] = ctx.rects.at(-1);
  return { x: x + 1, w: w - 2 };
}

/** A 2D context that records every call with its arguments and the fill alpha at that time. */
function callRecorder() {
  /** @type {Array<{ name: string, args: any[], alpha: number }>} */
  const calls = [];
  /** @type {Record<string | symbol, any>} */
  const target = { calls, globalAlpha: 1, measureText: (/** @type {string} */ s) => ({ width: String(s).length * 6 }) };
  const ctx = new Proxy(target, {
    get: (t, k) => (k in t ? t[k] : (/** @type {any[]} */ ...args) => calls.push({ name: String(k), args, alpha: t.globalAlpha })),
    set: (t, k, v) => {
      t[k] = v;
      return true;
    },
  });
  return { ctx: /** @type {any} */ (ctx), calls };
}

test('ui-chart fills the area toward zero, also when every value is negative', () => {
  const from = 1_700_000_000_000;
  const to = from + 300_000;
  /** @param {(i: number) => number} f */
  const draw = (f, zero = true) => {
    const chart = new UiChart();
    chart.series = [{ id: 'i', label: 'Current', points: Array.from({ length: 31 }, (_, i) => ({ t: from + i * 10_000, v: f(i) })) }];
    chart.from = from;
    chart.to = to;
    chart.zero = zero;
    const { ctx, calls } = callRecorder();
    chart.drawTo(ctx, 0, 0, 600, 220);
    const at = calls.findLastIndex((c) => c.name === 'rect');
    const clip = calls[at].args;
    const plot = { top: clip[1] + 3, bottom: clip[1] + clip[3] - 3 };
    // The fill outline: the first moveTo after the clip of the lines, drawn at the area alpha.
    const start = calls.slice(at).find((c) => c.name === 'moveTo' && c.alpha < 1);
    return { plot, base: /** @type {number} */ (start?.args[1]) };
  };
  const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 1e-6;
  const negative = draw((i) => -5 - (i % 7));
  assert.ok(near(negative.base, negative.plot.top), `all negative: zero is the top of the axis (${negative.base}, ${negative.plot.top})`);
  const positive = draw((i) => 5 + (i % 7));
  assert.ok(near(positive.base, positive.plot.bottom), `all positive: zero is the bottom of the axis (${positive.base})`);
  const mixed = draw((i) => (i === 10 ? 3 : -5 - (i % 7)));
  assert.ok(mixed.base > mixed.plot.top && mixed.base < mixed.plot.bottom, 'mixed: the zero line inside');
});

test('timeTicks puts year steps on January 1, also from a window that starts mid year', () => {
  const nine = timeTicks(new Date(2020, 0, 1).getTime(), new Date(2029, 0, 1).getTime(), 4);
  assert.equal(nine.step, 3 * 365 * 86400000);
  assert.deepEqual(nine.ticks.map((t) => new Date(t).getFullYear()), [2020, 2023, 2026, 2029]);
  for (const [a, b, want] of [
    [new Date(2020, 5, 15), new Date(2029, 0, 1), 2],
    [new Date(2020, 5, 15), new Date(2024, 6, 1), 2],
    [new Date(2000, 0, 1), new Date(2026, 10, 21), 9],
  ]) {
    const { ticks } = timeTicks(a.getTime(), b.getTime(), /** @type {number} */ (want));
    assert.ok(ticks.length >= 2, `${a.toISOString()}: ${ticks.length} ticks`);
    for (const t of ticks) {
      const d = new Date(t);
      assert.equal(d.getMonth() * 100 + d.getDate(), 1, d.toString());
      assert.ok(t >= a.getTime() && t <= b.getTime());
    }
  }
});

test('ui-chart time labels carry the year on windows longer than a month', () => {
  const from = new Date(2024, 8, 1).getTime();
  const to = new Date(2026, 11, 1).getTime();
  const chart = new UiChart();
  chart.series = [{ id: 'u', label: 'Voltage', points: [{ t: from, v: 1 }, { t: to, v: 2 }] }];
  chart.from = from;
  chart.to = to;
  const { ctx, calls } = callRecorder();
  chart.drawTo(ctx, 0, 0, 340, 220);
  const labels = calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
  const timeLabels = labels.filter((s) => /20\d\d/.test(s));
  assert.ok(timeLabels.length >= 2, labels.join(' | '));
  assert.equal(new Set(timeLabels).size, timeLabels.length, 'no repeated labels');
});

test('stacked charts with the same gutter share the time axis, also in drawTo()', () => {
  const from = 1_700_000_000_000;
  const to = from + 3600_000;
  const points = (/** @type {(i: number) => number} */ f) => Array.from({ length: 61 }, (_, i) => ({ t: from + i * 60_000, v: f(i) }));
  const voltage = new UiChart();
  voltage.series = [{ id: 'u', label: 'Voltage', points: points((i) => 53.1 + i * 0.005) }];
  voltage.unit = 'V';
  const current = new UiChart();
  current.series = [{ id: 'i', label: 'Current', points: points((i) => 25 * Math.sin(i / 9)) }];
  current.unit = 'A';
  for (const c of [voltage, current]) {
    c.from = from;
    c.to = to;
  }
  // Each chart alone: the y labels have different widths, so the plots start at different x.
  assert.notEqual(plotOf(voltage).x, plotOf(current).x);
  const ctx = recordingContext();
  const gutter = Math.max(voltage.exportLabelWidth(ctx, 600, 220), current.exportLabelWidth(ctx, 600, 220));
  assert.ok(gutter > 0);
  assert.deepEqual(plotOf(voltage, gutter), plotOf(current, gutter));
  assert.equal(plotOf(voltage, gutter).x, gutter);
  // The gutter is a minimum: labels that need more space still get it.
  assert.equal(plotOf(voltage, 1).x, plotOf(voltage).x);
  // On screen the `gutter` property does the same.
  voltage.gutter = gutter;
  current.gutter = gutter;
  assert.deepEqual(plotOf(voltage), plotOf(current));
  assert.equal(voltage.labelWidth(), 0, 'nothing drawn on screen yet');
});
