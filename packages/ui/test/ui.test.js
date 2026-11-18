import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createI18n, negotiateLocale, interpolate } from '../src/i18n.js';
import { Store, shallowEqual } from '../src/store.js';
import { HashRouter } from '../src/router.js';
import { createStorage } from '../src/storage.js';

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
