import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n, negotiateLocale, interpolate } from '../src/i18n.js';
import { Store, shallowEqual } from '../src/store.js';
import { HashRouter } from '../src/router.js';
import { createStorage } from '../src/storage.js';
import { lightDismiss } from '../src/components/overlays.js';
import { applyTheme } from '../src/theme.js';
import { UiNav } from '../src/components/nav.js';

test('i18n: English keys, fallback, context, plurals and numbers', () => {
  const i = createI18n();
  i.register('en', { '{count} cells': { one: '{count} cell', other: '{count} cells' } });
  i.register('uk', {
    Cells: 'Комірки',
    '{count} cells': { one: '{count} комірка', few: '{count} комірки', many: '{count} комірок', other: '{count} комірки' },
    'noun|Charge': 'Заряд',
  });
  assert.equal(i.t('Cells'), 'Cells');
  assert.equal(i.t('{count} cells', { count: 1 }), '1 cell');
  assert.equal(i.t('{count} cells', { count: 16 }), '16 cells');
  assert.equal(i.t('noun|Charge'), 'Charge');
  let changed = '';
  i.onChange((l) => (changed = l));
  i.setLocale('uk');
  assert.equal(changed, 'uk');
  assert.equal(i.t('Cells'), 'Комірки');
  assert.equal(i.t('Missing text'), 'Missing text');
  assert.equal(i.t('{count} cells', { count: 2 }), '2 комірки');
  assert.equal(i.t('{count} cells', { count: 5 }), '5 комірок');
  assert.equal(i.t('{count} cells', { count: 21 }), '21 комірка');
  assert.equal(i.t('noun|Charge'), 'Заряд');
  assert.equal(i.formatNumber(3.3051, { decimals: 3 }).replace(/\s/g, ' '), '3,305');
  assert.equal(i.formatNumber(NaN), 'n/a');
  assert.equal(interpolate('{a} of {b} {c}', { a: 1, b: 2 }), '1 of 2 {c}');
});

test('i18n: a negative number that rounds to zero prints without a minus', () => {
  const i = createI18n();
  assert.equal(i.formatNumber(-0.04, { decimals: 1 }), '0.0');
  assert.equal(i.formatNumber(-0, { decimals: 1 }), '0.0');
  assert.equal(i.formatNumber(-0.3, { decimals: 0 }), '0');
  assert.equal(i.formatNumber(-0.004, { decimals: 2 }), '0.00');
  assert.equal(i.formatNumber(-0.05, { decimals: 1 }), '-0.1');
  assert.equal(i.formatNumber(-0.004, { decimals: 2, signed: true }), '0.00');
  assert.equal(i.formatNumber(-1.25, { decimals: 1, minDecimals: 0 }), '-1.3');
});

test('applyTheme keeps the browser UI color in step with the system scheme in auto mode', () => {
  const meta = { content: '', setAttribute: (/** @type {string} */ _k, /** @type {string} */ v) => (meta.content = v) };
  /** @type {Array<() => void>} */
  const listeners = [];
  const mq = { matches: false, addEventListener: (/** @type {string} */ type, /** @type {() => void} */ fn) => type === 'change' && listeners.push(fn) };
  const g = /** @type {any} */ (globalThis);
  g.document = { documentElement: { dataset: {} }, querySelector: () => meta };
  g.window = { matchMedia: () => mq };
  try {
    applyTheme('auto');
    assert.equal(meta.content, '#f3f5f8');
    mq.matches = true;
    for (const fn of listeners) fn();
    assert.equal(meta.content, '#0e1116');
    applyTheme('light');
    assert.equal(meta.content, '#f3f5f8');
    for (const fn of listeners) fn();
    assert.equal(meta.content, '#f3f5f8', 'a forced theme ignores the system scheme');
    applyTheme('auto');
    assert.equal(meta.content, '#0e1116');
    assert.equal(listeners.length, 1, 'one listener for all calls');
  } finally {
    delete g.document;
    delete g.window;
  }
});

test('ui-nav: brand icon only when set, a translatable landmark name', () => {
  const nav = new UiNav();
  nav.brand = 'App';
  const values = (/** @type {any} */ r) => r.values;
  assert.equal(values(nav.render())[0], 'Main');
  assert.equal(values(nav.render())[1], '');
  nav.brandIcon = 'chart';
  nav.label = 'Sections';
  assert.equal(values(nav.render())[0], 'Sections');
  assert.notEqual(values(nav.render())[1], '');
});

test('negotiateLocale picks exact, base or fallback', () => {
  const s = ['en', 'uk', 'ru', 'de', 'fr'];
  assert.equal(negotiateLocale(s, ['uk-UA', 'en']), 'uk');
  assert.equal(negotiateLocale(s, ['pl', 'de-AT']), 'de');
  assert.equal(negotiateLocale(s, ['pl']), 'en');
});

test('Store notifies with previous state', () => {
  const s = new Store({ a: 1, b: { x: 1 } });
  const seen = [];
  const off = s.subscribe((n, p) => seen.push([p.a, n.a]));
  s.set({ a: 2 });
  s.set((st) => ({ a: st.a + 1 }));
  off();
  s.set({ a: 10 });
  assert.deepEqual(seen, [
    [1, 2],
    [2, 3],
  ]);
  assert.ok(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' }));
  assert.ok(!shallowEqual({ a: 1 }, { a: 1, b: 2 }));
});

test('HashRouter resolves optional params and query', () => {
  const r = new HashRouter(
    [
      { name: 'overview', path: '/overview' },
      { name: 'settings', path: '/settings/:group?' },
    ],
    '/overview',
  );
  assert.equal(r.route.name, 'overview');
  assert.deepEqual(r.resolve('/settings/cell_voltage?x=1'), { name: 'settings', params: { group: 'cell_voltage' }, path: '/settings/cell_voltage', query: { x: '1' } });
  assert.deepEqual(r.resolve('/settings').params, {});
  assert.equal(r.resolve('/nope'), null);
  r.navigate('/settings/balancing');
  assert.equal(r.route.params.group, 'balancing');
});

test('createStorage works without localStorage', () => {
  const s = createStorage('test');
  assert.equal(s.get('missing', 5), 5);
  s.set('k', { v: 1 });
  assert.deepEqual(s.get('k', null), { v: 1 });
  s.remove('k');
  assert.equal(s.get('k', null), null);
});

test('i18n: empty plural forms count as untranslated like empty strings', () => {
  const i = createI18n();
  i.register('en', { '{count} cells': { one: '{count} cell', other: '{count} cells' } });
  i.register('uk', { '{count} cells': { one: '', few: '', many: '', other: '' }, Cells: '' });
  i.setLocale('uk');
  assert.equal(i.t('{count} cells', { count: 2 }), '2 cells');
  assert.equal(i.t('Cells'), 'Cells');
  i.register('uk', { '{count} cells': { one: 'uk one {count}', few: '', many: '', other: 'uk other {count}' } });
  assert.equal(i.t('{count} cells', { count: 1 }), 'uk one 1');
  assert.equal(i.t('{count} cells', { count: 2 }), 'uk other 2');
  i.register('uk', { '{count} cells': { one: 'uk one {count}', few: '', many: '', other: '' } });
  assert.equal(i.t('{count} cells', { count: 5 }), 'uk one 5');
});

test('HashRouter keeps a malformed percent escape instead of throwing', () => {
  const routes = [
    { name: 'overview', path: '/overview' },
    { name: 'settings', path: '/settings/:group?' },
  ];
  const r = new HashRouter(routes, '/overview');
  assert.deepEqual(r.resolve('/settings/%E0%A4%A').params, { group: '%E0%A4%A' });
  assert.deepEqual(r.resolve('/settings/cell%20voltage').params, { group: 'cell voltage' });
  globalThis.location = /** @type {any} */ ({ hash: '#/settings/100%' });
  try {
    const booted = new HashRouter(routes, '/overview');
    assert.equal(booted.route.name, 'settings');
    assert.equal(booted.route.params.group, '100%');
  } finally {
    delete globalThis.location;
  }
});

test('createStorage keeps the newer in-memory value when localStorage rejects a write', () => {
  const data = new Map();
  let failing = false;
  globalThis.localStorage = /** @type {any} */ ({
    getItem: (/** @type {string} */ k) => (data.has(k) ? data.get(k) : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => {
      if (failing) throw new Error('QuotaExceededError');
      data.set(k, String(v));
    },
    removeItem: (/** @type {string} */ k) => {
      if (failing) throw new Error('SecurityError');
      data.delete(k);
    },
    key: (/** @type {number} */ n) => [...data.keys()][n] ?? null,
    get length() {
      return data.size;
    },
  });
  try {
    const s = createStorage('quota');
    s.set('theme', 'light');
    assert.equal(data.get('quota:theme'), '"light"');
    failing = true;
    s.set('theme', 'dark');
    assert.equal(s.get('theme', 'auto'), 'dark');
    s.remove('theme');
    assert.equal(s.get('theme', 'auto'), 'auto');
    failing = false;
    s.set('theme', 'dark');
    data.set('quota:theme', '"light"'); // written by another tab: localStorage is authoritative again
    assert.equal(s.get('theme', 'auto'), 'light');
  } finally {
    delete globalThis.localStorage;
  }
});

test('ui-dialog light dismiss needs a press that starts and ends on the backdrop', () => {
  const dialog = { getBoundingClientRect: () => ({ left: 100, top: 100, right: 400, bottom: 300 }) };
  const text = {};
  let dismissed = 0;
  const d = lightDismiss(/** @type {any} */ (() => dialog), () => dismissed++);
  const at = (/** @type {object} */ target, /** @type {number} */ x, /** @type {number} */ y) =>
    /** @type {any} */ ({ target, clientX: x, clientY: y });
  // A text selection that starts inside and is released over the backdrop clicks the <dialog>.
  d.pointerdown(at(text, 150, 150));
  d.click(at(dialog, 20, 20));
  assert.equal(dismissed, 0);
  // A press on the dialog padding released outside it.
  d.pointerdown(at(dialog, 110, 110));
  d.click(at(dialog, 20, 20));
  assert.equal(dismissed, 0);
  // A press on the backdrop released inside the dialog.
  d.pointerdown(at(dialog, 20, 20));
  d.click(at(dialog, 150, 150));
  assert.equal(dismissed, 0);
  // A click without a press (keyboard or synthetic).
  d.click(at(dialog, 20, 20));
  assert.equal(dismissed, 0);
  // A real backdrop click.
  d.pointerdown(at(dialog, 20, 20));
  d.click(at(dialog, 22, 21));
  assert.equal(dismissed, 1);
});
