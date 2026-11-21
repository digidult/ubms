import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, createLinkPair } from '@ubms/transport';
import { BmsSession, DriverRegistry } from '@ubms/bms-core';
import { drivers } from '@ubms/bms-drivers';
import { PLUGIN_API_VERSION, PluginProblem, createPluginApi, loadPlugins, readRegistration, validateDefinition } from '../src/plugins.js';

/** The example plugin, loaded exactly like the desktop app loads a file of the plugins folder. */
const EXAMPLE_FILE = 'example-bms.js';
const exampleSource = readFileSync(new URL('../../../examples/plugins/example-bms.js', import.meta.url), 'utf8');

/**
 * Node cannot import Blob URLs; a data URL runs the same module text the same way.
 * @param {string} source
 */
const importFromData = (source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const api = createPluginApi({ appVersion: '0.0.0-test' });

/**
 * Load plugin files through loadPlugins() with a fresh registry of the built-in drivers.
 * @param {Array<{ file: string, source: string }>} plugins
 * @param {{ errors?: Array<{ file: string, error: string }>, dirs?: string[], timeoutMs?: number, list?: () => Promise<any> }} [opts]
 */
async function load(plugins, { errors = [], dirs = ['/opt/ubms/plugins'], timeoutMs = 2000, list } = {}) {
  const registry = new DriverRegistry(drivers);
  const log = new ProtocolLog();
  const report = await loadPlugins({ list: list ?? (async () => ({ dirs, plugins, errors })), registry, log, api, importModule: importFromData, timeoutMs });
  return { registry, log, report };
}

/** A minimal valid definition; `create` is never called by the checks. */
const valid = (over = {}) => ({
  id: 'acme-ble',
  family: 'acme',
  vendor: 'Acme',
  protocol: 'Acme (Bluetooth)',
  deviceType: 'bms',
  links: { ble: { profiles: [{ id: 'acme', service: 0xfff0, notify: 0xfff1, write: 0xfff2 }], namePrefixes: ['ACME'] } },
  create: () => null,
  ...over,
});

/** Source of a plugin whose register() returns the given definitions literal. @param {string} defs */
const pluginReturning = (defs) => `export default function register(api) { return { name: 'Test', drivers: ${defs} }; }`;

/** @param {any} report */
const failureTexts = (report) => report.failures.map((/** @type {any} */ f) => `${f.file}: ${f.message.replace(/\{(\w+)\}/g, (/** @type {string} */ m, /** @type {string} */ k) => (k in f.params ? String(f.params[k]) : m))}`);

test('api: versioned, frozen and complete', () => {
  assert.equal(api.version, PLUGIN_API_VERSION);
  assert.equal(api.version, 1);
  assert.equal(api.app.version, '0.0.0-test');
  assert.ok(Object.isFrozen(api) && Object.isFrozen(api.core) && Object.isFrozen(api.transport) && Object.isFrozen(api.drivers));
  for (const name of ['BaseDriver', 'msg', 'field', 'buildSchema', 'relation', 'fieldMap', 'alarm', 'cellStats', 'SETTINGS', 'SETTING_GROUPS', 'ALARMS']) {
    assert.ok(api.core[name], `core.${name}`);
  }
  for (const name of ['FrameAssembler', 'FrameChannel', 'hex', 'fromHex', 'concat', 'u16le', 'u16be', 'i16le', 'i16be', 'u32le', 'u32be', 'i32le', 'i32be', 'ByteReader', 'sum8', 'xor8', 'crc16Modbus', 'crc16CcittFalse', 'canonicalUuid', 'shortUuid', 'sleep']) {
    assert.equal(typeof api.transport[name], 'function', `transport.${name}`);
  }
  assert.equal(typeof api.drivers.SimBattery, 'function');
  assert.ok(!('ProtocolLog' in api.transport), 'plugins get the log through the driver context only');
});

test('example plugin: loads through register(api) and registers after the built-in drivers', async () => {
  const { registry, log, report } = await load([{ file: EXAMPLE_FILE, source: exampleSource }]);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.dirs, ['/opt/ubms/plugins']);
  assert.deepEqual(report.plugins, [{ file: EXAMPLE_FILE, name: 'Example BMS', version: '1.0.0', drivers: ['example-bms'] }]);
  const ids = registry.list().map((d) => d.id);
  assert.equal(ids.at(-1), 'example-bms', 'after every built-in driver');
  assert.equal(ids.length, drivers.length + 1);
  const def = /** @type {any} */ (registry.get('example-bms'));
  assert.equal(def.family, 'example');
  assert.equal(typeof def.demo?.create, 'function');
  assert.ok(registry.families().some((f) => f.id === 'example' && f.vendor === 'Example'), 'its own family in the type list');
  assert.ok(log.entries().some((e) => e.kind === 'event' && /Plugin example-bms\.js loaded: Example BMS 1\.0\.0, drivers example-bms/.test(e.text ?? '')));

  // Detection: Bluetooth candidates by name and service, serial candidates in automatic mode.
  const ble = registry.bleCandidates({ name: 'EXB-8S100', services: ['5ea1c0de-e7b1-4c00-8000-00000000e7b0'] });
  assert.deepEqual(ble.map((c) => c.definition.id), ['example-bms']);
  assert.equal(registry.bleCandidates({ name: 'EXB-8S100' })[0].definition.id, 'example-bms', 'the name ranks it first');
  assert.equal(registry.serialCandidates().at(-1)?.definition.id, 'example-bms');
  assert.ok(registry.bleRequest({ selection: 'family:example' }).request.filters?.some((f) => f.namePrefix === 'EXB-'));
});

test('example plugin: its simulator runs in a BmsSession end to end', async () => {
  const { registry } = await load([{ file: EXAMPLE_FILE, source: exampleSource }]);
  const def = /** @type {any} */ (registry.get('example-bms'));
  const log = new ProtocolLog();
  const session = new BmsSession({ registry, log, pollIntervalMs: 200, probeTimeoutMs: 1000, autoReconnect: false });
  const { host, device } = createLinkPair({ log, deviceChunkSize: def.demo.chunkSize, kind: 'demo', name: def.demo.name });
  await device.open();
  const sim = def.demo.create(device);
  try {
    const first = new Promise((resolve) => session.once('snapshot', resolve));
    await session.connect({ kind: 'link', link: host, selection: 'example-bms' });
    assert.equal(session.state, 'connected');
    assert.equal(session.variant, 'EXB1');
    const s = /** @type {any} */ (await first);
    assert.equal(s.cells.length, 8);
    assert.ok(Math.abs(s.voltage - s.cellStats.sum) < 0.02, 'pack voltage matches the cells');
    assert.ok(Math.abs(s.current - sim.battery.current) < 0.02, 'current is positive while charging');
    assert.equal(s.soc, Math.round(sim.battery.soc));
    assert.deepEqual(s.temperatures.map((/** @type {any} */ t) => t.id), ['t1', 't2']);
    assert.deepEqual(s.switches, { charge: true, discharge: true, balance: s.balancingActive });
    assert.equal(s.capacityFull, 100);

    await session.refreshInfo();
    assert.equal(session.info?.model, 'EXB-8S100');
    assert.equal(session.info?.softwareVersion, '1.2.0');
    assert.equal(session.info?.serialNumber, 'EXB2026000042');

    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.deepEqual(settings.values, {
      'cell.ovp': 3.65,
      'cell.ovpr': 3.45,
      'cell.uvp': 2.6,
      'cell.uvpr': 2.9,
      'charge.ocp': 100,
      'switch.buzzer': true,
      'exb.sleep_minutes': 30,
    });
    assert.deepEqual(settings.schema?.groups.map((g) => g.id), ['cell_voltage', 'current', 'controls', 'system']);

    const results = await session.writeSettings([
      { id: 'cell.ovp', value: 3.6 },
      { id: 'switch.buzzer', value: false },
      { id: 'exb.sleep_minutes', value: 300 },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [
        ['cell.ovp', true, true],
        ['switch.buzzer', true, true],
        ['exb.sleep_minutes', false, undefined],
      ],
    );
    assert.match(String(results[2].error), /Maximum is/, 'the schema limit stops the write before the device');
    assert.equal(session.settings.values?.['cell.ovp'], 3.6);

    // The protocol log names and decodes the frames of the plugin.
    const status = log.entries().find((e) => e.kind === 'frame' && e.name === 'Status answer');
    assert.ok(status, 'status answers are logged with their name');
  } finally {
    await session.disconnect();
    sim.stop();
    await device.close();
  }
});

test('validation: the built-in drivers pass the same checks', () => {
  for (const def of drivers) assert.equal(validateDefinition(def), null, def.id);
});

test('validation: bad definitions are rejected with a reason', () => {
  const taken = new Map([
    ['jk-ble', ''],
    ['acme-old', 'acme.js'],
  ]);
  const families = new Set(['jk', 'daly']);
  /** @type {Array<[any, RegExp]>} */
  const cases = [
    [null, /not an object/],
    [[valid()], /not an object/],
    [valid({ id: '' }), /Invalid driver id/],
    [valid({ id: 'has space' }), /Invalid driver id/],
    [valid({ id: 'family:jk' }), /Invalid driver id/],
    [valid({ id: 42 }), /Invalid driver id/],
    [valid({ id: 'auto' }), /reserved/],
    [valid({ id: 'jk-ble' }), /built-in driver/],
    [valid({ id: 'acme-old' }), /already used by \{file\}/],
    [valid({ id: 'jk' }), /device family/],
    [valid({ family: '' }), /must be a non-empty string/],
    [valid({ family: 'a b' }), /is not valid/],
    [valid({ vendor: 3 }), /must be a non-empty string/],
    [valid({ protocol: undefined }), /must be a non-empty string/],
    [valid({ deviceType: 'inverter' }), /deviceType must be/],
    [valid({ create: 'nope' }), /must be a function/],
    [valid({ links: {} }), /links needs ble or serial/],
    [valid({ links: null }), /links needs ble or serial/],
    [valid({ links: { ble: { profiles: [] } } }), /is not valid/],
    [valid({ links: { ble: { profiles: [{ id: 'x', service: 'not-a-uuid', notify: 1, write: 1 }] } } }), /is not valid/],
    [valid({ links: { ble: { profiles: [{ id: 'x', service: 0xfff0, notify: 0xfff1 }] } } }), /is not valid/],
    [valid({ links: { ble: { profiles: [{ id: 'x', service: 1, notify: 1, write: 1, writeMode: 'fast' }] } } }), /is not valid/],
    [valid({ links: { ble: { profiles: [{ id: 'x', service: 1, notify: 1, write: 1 }], namePatterns: ['^ACME'] } } }), /is not valid/],
    [valid({ links: { ble: { profiles: [{ id: 'x', service: 1, notify: 1, write: 1 }], manufacturerIds: [70000] } } }), /is not valid/],
    [valid({ links: { serial: { profiles: [{ id: 's', baudRate: 0 }] } } }), /is not valid/],
    [valid({ links: { serial: { profiles: [{ id: 's', baudRate: 9600, parity: 'mark' }] } } }), /is not valid/],
    [valid({ links: { serial: { profiles: [{ id: 's', baudRate: 9600 }], autoDetect: 'no' } } }), /is not valid/],
    [valid({ demo: { name: 'x' } }), /must be a function/],
    [valid({ demo: { create: () => ({}) } }), /is not valid/],
    [valid({ experimental: 'yes' }), /is not valid/],
  ];
  for (const [def, expected] of cases) {
    const p = validateDefinition(def, taken, families);
    assert.ok(p instanceof PluginProblem, `rejected: ${JSON.stringify(def?.id ?? def)}`);
    assert.match(p.message, expected, `${JSON.stringify(def?.id ?? def)}: ${p.message}`);
  }
  assert.equal(validateDefinition(valid(), taken, families), null);
  assert.equal(validateDefinition(valid({ links: { serial: { profiles: [{ id: 's', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' }], autoDetect: false } } })), null);
  assert.equal(validateDefinition(valid({ family: 'jk' }), taken, families), null, 'a plugin may add a driver to a built-in family');
  const p = validateDefinition(valid({ links: { ble: { profiles: [{ id: 'x', service: 'zz', notify: 1, write: 1 }] } } }));
  assert.deepEqual(p?.params, { id: 'acme-ble', field: 'links.ble.profiles[0].service' }, 'the reason names the field');
});

test('registration: an array or { name, version, drivers }', () => {
  assert.deepEqual(readRegistration([1], 'a.js'), { name: 'a', version: '', definitions: [1] });
  assert.deepEqual(readRegistration({ name: ' Acme ', version: '2', drivers: [] }, 'acme.JS'), { name: 'Acme', version: '2', definitions: [] });
  assert.throws(() => readRegistration({ drivers: 'x' }, 'a.js'), PluginProblem);
  assert.throws(() => readRegistration(undefined, 'a.js'), PluginProblem);
});

test('loader: a failing plugin never stops the others', async () => {
  const acme = pluginReturning(`[{ id: 'acme-ble', family: 'acme', vendor: 'Acme', protocol: 'Acme', deviceType: 'bms', links: { serial: { profiles: [{ id: 'a', baudRate: 9600 }] } }, create: () => null }]`);
  const { registry, log, report } = await load(
    [
      { file: 'a-throws.js', source: `export default function register() { throw new Error('Broken on purpose'); }` },
      { file: 'b-syntax.js', source: 'export default function register( {' },
      { file: 'c-no-default.js', source: 'export function register() { return []; }' },
      { file: 'd-empty.js', source: 'export default () => [];' },
      { file: 'e-bad-return.js', source: 'export default () => 42;' },
      { file: 'f-hangs.js', source: 'await new Promise(() => {}); export default () => [];' },
      { file: 'g-acme.js', source: acme },
      { file: 'h-acme-again.js', source: acme },
      {
        file: 'i-mixed.js',
        source: pluginReturning(`[
          { id: 'jk-ble', family: 'x', vendor: 'X', protocol: 'X', deviceType: 'bms', links: { serial: { profiles: [{ id: 'x', baudRate: 9600 }] } }, create: () => null },
          { id: 'mixed-ok', family: 'x', vendor: 'X', protocol: 'X', deviceType: 'meter', links: { serial: { profiles: [{ id: 'x', baudRate: 9600 }] } }, create: () => null },
        ]`),
      },
      { file: 'j-async.js', source: pluginReturning(`[]`).replace('function register(api) {', 'async function register(api) { await api.transport.sleep(5);') },
    ],
    { errors: [{ file: 'huge.js', error: 'The file is larger than 1 MiB' }], timeoutMs: 300 },
  );
  assert.deepEqual(
    report.plugins.map((p) => [p.file, p.drivers]),
    [
      ['g-acme.js', ['acme-ble']],
      ['i-mixed.js', ['mixed-ok']],
    ],
  );
  const texts = failureTexts(report);
  const byFile = (/** @type {string} */ file) => texts.filter((t) => t.startsWith(`${file}: `));
  assert.equal(texts[0], 'huge.js: The file is larger than 1 MiB', 'bridge errors come first');
  assert.match(byFile('a-throws.js')[0], /register\(api\) failed: Broken on purpose/);
  assert.match(byFile('b-syntax.js')[0], /could not be loaded/);
  assert.match(byFile('c-no-default.js')[0], /no default export/);
  assert.match(byFile('d-empty.js')[0], /registers no drivers/);
  assert.match(byFile('e-bad-return.js')[0], /must return/);
  assert.match(byFile('f-hangs.js')[0], /did not load within 0\.3 s/);
  assert.match(byFile('h-acme-again.js')[0], /The driver id acme-ble is already used by g-acme\.js/);
  assert.match(byFile('i-mixed.js')[0], /The driver id jk-ble is already used by a built-in driver/);
  assert.match(byFile('j-async.js')[0], /registers no drivers/, 'an async register() is awaited');
  assert.equal(texts.length, 10);
  assert.ok(registry.get('mixed-ok') && registry.get('acme-ble'));
  assert.equal(registry.get('jk-ble')?.vendor, 'JK BMS', 'the built-in driver stays');
  assert.equal(log.entries().filter((e) => e.kind === 'warn' && e.source === 'plugins').length, 10, 'every problem is in the protocol log');
});

test('loader: no folder, no plugins, a failing or silent bridge', async () => {
  const empty = await load([], { dirs: [] });
  assert.deepEqual(empty.report, { dirs: [], plugins: [], failures: [] });
  assert.equal(empty.log.entries().length, 0, 'nothing to log');
  assert.equal(empty.registry.list().length, drivers.length);

  const failing = await load([], { list: async () => Promise.reject('Access is denied. (os error 5)') });
  assert.deepEqual(failureTexts(failing.report), [': The plugin list could not be read: Access is denied. (os error 5)']);

  const silent = await load([], { list: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(silent.report.failures.length, 1);
  assert.match(failureTexts(silent.report)[0], /could not be read/);

  const garbage = await load([], { list: async () => ({ plugins: [{ file: 1 }, null], errors: 'x' }) });
  assert.deepEqual(garbage.report, { dirs: [], plugins: [], failures: [] });
});
