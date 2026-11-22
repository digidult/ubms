import { test } from 'node:test';
import assert from 'node:assert/strict';

// Build constants of vite.config.js.
for (const k of ['__APP_VERSION__', '__APP_REVISION__', '__APP_COMMIT__']) /** @type {any} */ (globalThis)[k] = 'test';

/** localStorage in memory, shared by every controller of this file (like one browser profile). */
const mem = new Map();
/** @type {any} */ (globalThis).localStorage = {
  getItem: (/** @type {string} */ k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => void mem.set(k, String(v)),
  removeItem: (/** @type {string} */ k) => void mem.delete(k),
};

const { AppController } = await import('../src/controller.js');

/** @type {Array<{ message: string, tone?: string }>} */
const toasts = [];
// Installed after the controller module (and Lit) is loaded: toast() then finds this toaster.
/** @type {any} */ (globalThis).document = {
  visibilityState: 'hidden',
  documentElement: { dataset: {} },
  addEventListener() {},
  querySelector: (/** @type {string} */ sel) =>
    sel === 'ui-toaster' ? { show: (/** @type {string} */ message, /** @type {any} */ o) => toasts.push({ message, tone: o?.tone }) } : null,
};

/** A controller connected to a demo device, with its settings read. @param {string} driverId */
async function connected(driverId) {
  const c = new AppController();
  await c.connectDemo(driverId);
  assert.equal(c.state.state, 'connected');
  await c.loadSettings();
  assert.ok(c.state.settings.values, 'settings read');
  toasts.length = 0;
  return c;
}

test('a write whose read-back fails is not reported as written', async () => {
  const c = await connected('jk-ble');
  const before = c.state.settings.values?.['cell.ovp'];
  const driver = /** @type {any} */ (c.session.driver);
  driver.readSettings = async () => {
    throw new Error('Timed out');
  };
  const results = await c.writeSettings([{ id: 'cell.ovp', value: Math.round((before - 0.05) * 1000) / 1000 }]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].readBackError, 'Timed out');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].tone, 'warn');
  assert.match(toasts[0].message, /could not be read back: Timed out/);
  await c.disconnect();
});

test('a write without a connection resolves with failed results and a message', async () => {
  const c = new AppController();
  toasts.length = 0;
  const results = await c.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok]),
    [['cell.ovp', false]],
  );
  assert.ok(results[0].error);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].tone, 'danger');
});

test('a rejected write shows the limit, not a placeholder', async () => {
  const c = await connected('ant');
  await c.writeSettings([{ id: 'ant.password', value: 'x'.repeat(40) }], { quiet: true });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].tone, 'danger');
  assert.doesNotMatch(toasts[0].message, /\{max\}/);
  await c.disconnect();
});

test('a settings import skips values that do not fit the field', async () => {
  const c = await connected('jk-ble');
  const values = c.state.settings.values ?? {};
  assert.equal(values['switch.charge'], true);
  const file = (/** @type {Record<string, any>} */ v) => JSON.stringify({ format: 'ubms-settings', version: 1, driver: 'jk-ble', values: v });
  for (const raw of ['on', 'yes', null, {}]) {
    const { changes, skipped } = c.parseSettingsImport(file({ 'switch.charge': raw }));
    assert.deepEqual(changes, [], `switch.charge = ${JSON.stringify(raw)}`);
    assert.deepEqual(skipped, ['switch.charge']);
  }
  const off = c.parseSettingsImport(file({ 'switch.charge': false }));
  assert.deepEqual(off.changes, [{ id: 'switch.charge', value: false, from: true }]);
  const textField = /** @type {any} */ (c.state.settings.schema)?.groups.flatMap((/** @type {any} */ g) => g.fields).find((/** @type {any} */ f) => f.type === 'text' && !f.readOnly);
  if (textField) assert.deepEqual(c.parseSettingsImport(file({ [textField.id]: null })).skipped, [textField.id]);
  await c.disconnect();
});

test('a file that is not a settings export gives one translatable message', () => {
  const c = new AppController();
  for (const text of ['<!DOCTYPE html>', '{"format":"ubms-log"}']) {
    assert.throws(() => c.parseSettingsImport(text), { message: 'Not a ubms settings file' });
  }
});

test('reset preferences keeps the language after a restart', () => {
  const c = new AppController();
  c.setPref('lang', 'de');
  c.setPref('pollMs', 5000);
  c.resetPrefs();
  assert.equal(c.state.prefs.lang, 'de');
  assert.equal(c.state.prefs.pollMs, 1000);
  const next = new AppController();
  assert.equal(next.state.prefs.lang, 'de');
  assert.equal(next.state.prefs.pollMs, 1000);
});

test('Recent devices keep no Web Serial port whose id is valid for this page only', () => {
  const c = new AppController();
  const session = /** @type {any} */ (c.session);
  const emitConnected = (/** @type {any} */ handle) => {
    session.target = { kind: 'serial', handle };
    session.definition = { id: 'daly', vendor: 'Daly', protocol: 'Daly', deviceType: 'bms' };
    session.emit('state', { state: 'connected' });
  };
  emitConnected({ id: 'serial-abc-1', name: 'Serial port', unique: false });
  assert.deepEqual(c.state.recent, []);
  emitConnected({ id: 'usb-1a86-7523', name: 'CH340', unique: true });
  // The desktop app's ports have no `unique`: their id is the port path.
  emitConnected({ id: 'COM7', name: 'COM7' });
  assert.deepEqual(
    c.state.recent.map((r) => r.id),
    ['COM7', 'usb-1a86-7523'],
  );
  // Ends the history recording the 'connected' event started.
  session.emit('state', { state: 'idle' });
  session.target = null;
  session.definition = null;
});

test('settings and log exports leave passwords out', async () => {
  const { withoutSecrets } = await import('../src/controller.js');
  const schema = {
    groups: [
      {
        id: 'identity',
        label: 'Identity',
        fields: [
          { id: 'x.pin', label: 'PIN', type: 'text', secret: true },
          { id: 'x.bms_password', label: 'Password', type: 'text' },
          { id: 'cell.ovp', label: 'OVP', type: 'number' },
        ],
      },
    ],
  };
  assert.deepEqual(withoutSecrets(/** @type {any} */ (schema), { 'x.pin': '1234', 'x.bms_password': 'abc', 'cell.ovp': 3.65 }), { 'cell.ovp': 3.65 });
  assert.equal(withoutSecrets(/** @type {any} */ (schema), null), null);
});

test('a cancelled reconnect shows no toast', async () => {
  const c = new AppController();
  toasts.length = 0;
  /** @type {any} */ (c.session).reconnect = async () => {
    throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
  };
  await c.reconnect();
  assert.equal(toasts.length, 0);
  /** @type {any} */ (c.session).reconnect = async () => {
    throw new Error('Timed out');
  };
  await c.reconnect();
  assert.equal(toasts.length, 1);
});

test('availability is checked again when the Bluetooth provider reports a change', async () => {
  const c = new AppController();
  /** @type {Array<() => void>} */
  const handlers = [];
  let state = 'off';
  const ble = /** @type {any} */ (c.providers.ble);
  ble.availability = async () => ({ available: state === 'on' });
  ble.onAvailabilityChange = async (/** @type {() => void} */ h) => {
    handlers.push(h);
    return () => {};
  };
  await c.init();
  assert.equal(handlers.length, 1);
  assert.equal(/** @type {any} */ (c.state.availability).ble.available, false);
  state = 'on';
  handlers[0]();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(/** @type {any} */ (c.state.availability).ble.available, true);
});
