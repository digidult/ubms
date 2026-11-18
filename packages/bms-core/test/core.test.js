import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolLog, createLinkPair, FrameChannel, FrameAssembler, sum8, concat, u16le } from '@ubms/transport';
import {
  BaseDriver,
  BmsSession,
  DriverRegistry,
  buildSchema,
  field,
  cellStats,
  deriveSnapshot,
  coerce,
  validateValue,
  validateAll,
  relation,
  alarm,
} from '../src/index.js';

test('cellStats and deriveSnapshot', () => {
  const s = cellStats([3.3, 3.31, 3.29, NaN]);
  assert.equal(s?.count, 3);
  assert.equal(s?.minIndex, 2);
  assert.equal(s?.maxIndex, 1);
  assert.ok(Math.abs((s?.delta ?? 0) - 0.02) < 1e-9);
  const d = deriveSnapshot({ timestamp: 1, voltage: 52, current: -10, capacityRemaining: 50, capacityNominal: 100 });
  assert.equal(d.power, -520);
  assert.equal(d.state, 'discharging');
  assert.equal(d.timeToEmpty, 5);
  const c = deriveSnapshot({ timestamp: 1, voltage: 52, current: 20, capacityRemaining: 50, capacityNominal: 100 });
  assert.equal(c.timeToFull, 2.5);
});

test('settings schema helpers', () => {
  const ovp = field('cell.ovp', { min: 1.2, max: 4.35 });
  assert.equal(ovp.label, 'Cell overvoltage protection');
  assert.equal(ovp.unit, 'V');
  assert.equal(ovp.step, 0.001);
  const sw = field('switch.charge');
  assert.equal(sw.type, 'boolean');
  const custom = field('x.mode', { label: 'Mode', group: 'x', options: [{ value: 1, label: 'A' }] });
  assert.equal(custom.type, 'enum');
  const schema = buildSchema([custom, sw, ovp], { x: { label: 'Extra' } });
  assert.deepEqual(schema.groups.map((g) => g.id), ['cell_voltage', 'controls', 'x']);
  assert.equal(coerce(ovp, '3,65'), 3.65);
  assert.equal(coerce(custom, '1'), 1);
  assert.equal(coerce(custom, '7'), undefined);
  assert.deepEqual(validateValue(ovp, 5), { message: 'Maximum is {max}', params: { max: 4.35, unit: 'V' } });
  assert.equal(validateValue(ovp, 3.6), null);
  const ovpr = field('cell.ovpr', { validate: relation('cell.ovpr', '<', 'cell.ovp', 'Recovery must be below protection') });
  const s2 = buildSchema([ovp, ovpr]);
  assert.deepEqual(validateAll(s2, { 'cell.ovp': 3.6, 'cell.ovpr': 3.7 }), { 'cell.ovpr': 'Recovery must be below protection' });
  assert.equal(alarm('short_circuit').severity, 'protection');
});

// ---- A toy protocol used to exercise the session: frame = 7E <cmd> <len> <payload> <sum8>
const toyFrame = (cmd, payload = []) => {
  const head = concat([0x7e, cmd, payload.length], payload);
  return concat(head, [sum8(head)]);
};

function toyAssembler({ onFrame, onDiscard }) {
  return new FrameAssembler({
    sync: [[0x7e]],
    length: (b) => (b.length < 3 ? 0 : b[2] + 4),
    validate: (f) => sum8(f, 0, f.length - 1) === f.at(-1),
    onFrame,
    onDiscard,
  });
}

class ToyDriver extends BaseDriver {
  constructor(def, ctx) {
    super(def, ctx);
    this.channel = new FrameChannel(ctx.link, { createAssembler: toyAssembler, describe: (f) => ({ name: `toy ${f[1]}` }) }).start();
  }
  get capabilities() {
    return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 50, minPollIntervalMs: 20 };
  }
  async probe({ timeout } = {}) {
    try {
      const f = await this.channel.request(toyFrame(0x01), { match: (fr) => fr[1] === 0x81, timeout: timeout ?? 300 });
      return { variant: `v${f[3]}` };
    } catch {
      return null;
    }
  }
  async poll() {
    const f = await this.channel.requestUnqueued(toyFrame(0x02), { match: (fr) => fr[1] === 0x82, timeout: 300 });
    this.publish({ voltage: u16le(f, 3) / 100, current: 1, cells: [3.3, 3.31] });
  }
  getSettingsSchema() {
    return buildSchema([field('cell.ovp', { min: 3, max: 4, meta: { reg: 1 } })]);
  }
  async readSettings() {
    const f = await this.channel.requestUnqueued(toyFrame(0x03), { match: (fr) => fr[1] === 0x83, timeout: 300 });
    return { 'cell.ovp': u16le(f, 3) / 1000 };
  }
  async writeSetting(id, value) {
    const raw = Math.round(value * 1000);
    await this.channel.requestUnqueued(toyFrame(0x04, [raw & 0xff, raw >> 8]), { match: (fr) => fr[1] === 0x84, timeout: 300 });
  }
  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

const toyDefinition = {
  id: 'toy',
  family: 'toy',
  vendor: 'Toy',
  protocol: 'Toy protocol',
  deviceType: 'bms',
  links: { serial: { profiles: [{ id: 'toy-9600', baudRate: 9600 }] } },
  create: (ctx) => new ToyDriver(toyDefinition, ctx),
};

function toyDevice(device) {
  let ovp = 3650;
  let voltage = 5234;
  device.on('data', (bytes) => {
    const cmd = bytes[1];
    if (cmd === 0x01) device.write(toyFrame(0x81, [7]));
    if (cmd === 0x02) device.write(toyFrame(0x82, [voltage & 0xff, voltage >> 8]));
    if (cmd === 0x03) device.write(toyFrame(0x83, [ovp & 0xff, ovp >> 8]));
    if (cmd === 0x04) {
      ovp = bytes[3] | (bytes[4] << 8);
      device.write(toyFrame(0x84));
    }
  });
  return { setVoltage: (v) => (voltage = v) };
}

test('BmsSession: direct link, polling, settings write with verification', async () => {
  const log = new ProtocolLog();
  const registry = new DriverRegistry([toyDefinition]);
  const session = new BmsSession({ registry, log, pollIntervalMs: 30 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 3 });
  await device.open();
  toyDevice(device);
  const states = [];
  session.on('state', (s) => states.push(s.state));
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  assert.equal(session.state, 'connected');
  assert.equal(session.variant, 'v7');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(snapshots.length >= 2, 'poll loop produces snapshots');
  assert.equal(snapshots[0].voltage, 52.34);
  assert.equal(snapshots[0].cellStats.count, 2);
  assert.ok(session.history.points.length >= 2);

  const settings = await session.loadSettings();
  assert.equal(settings.values['cell.ovp'], 3.65);
  const results = await session.writeSettings([
    { id: 'cell.ovp', value: 3.6 },
    { id: 'cell.ovp', value: 9 },
    { id: 'nope', value: 1 },
  ]);
  assert.deepEqual(
    results.map((r) => [r.ok, r.verified ?? null]),
    [
      [true, true],
      [false, null],
      [false, null],
    ],
  );
  assert.equal(session.settings.values['cell.ovp'], 3.6);
  await session.disconnect();
  assert.equal(session.state, 'idle');
  assert.deepEqual(states.slice(0, 3), ['connecting', 'detecting', 'connected']);
});

test('BmsSession: serial detection tries profiles and reports failure', async () => {
  const log = new ProtocolLog();
  const silent = { ...toyDefinition, id: 'silent', family: 'silent', create: (ctx) => new ToyDriver(silent, ctx) };
  const registry = new DriverRegistry([silent, toyDefinition]);
  const session = new BmsSession({ registry, log, pollIntervalMs: 30, probeTimeoutMs: 100 });
  let opened = 0;
  const port = {
    async openLink() {
      opened++;
      const { host, device } = createLinkPair({ log });
      await host.open();
      await device.open();
      // only the second profile attempt gets a responsive device
      if (opened === 2) toyDevice(device);
      return host;
    },
  };
  const detections = [];
  session.on('detect', (d) => detections.push(d.driverId));
  await session.connect({ kind: 'serial', handle: port, selection: 'auto' });
  assert.equal(session.definition.id, 'toy');
  assert.deepEqual(detections, ['silent', 'toy']);
  await session.disconnect();

  opened = 10;
  await assert.rejects(session.connect({ kind: 'serial', handle: port, selection: 'auto' }), /No supported BMS protocol/);
  assert.equal(session.state, 'error');
});

test('DriverRegistry builds chooser filters and ranks candidates', () => {
  const a = {
    id: 'a-ble',
    family: 'a',
    vendor: 'A',
    protocol: 'A',
    deviceType: 'bms',
    links: { ble: { namePrefixes: ['AAA'], profiles: [{ id: 'p', service: 0xffe0, notify: 0xffe1, write: 0xffe1 }] } },
    create: () => null,
  };
  const b = {
    id: 'b-ble',
    family: 'b',
    vendor: 'B',
    protocol: 'B',
    deviceType: 'bms',
    links: { ble: { namePrefixes: ['BBB'], namePatterns: [/^B-\d+/], profiles: [{ id: 'q', service: 0xfff0, notify: 0xfff1, write: 0xfff2 }] } },
    create: () => null,
  };
  const reg = new DriverRegistry([a, b]);
  const all = reg.bleRequest();
  assert.equal(all.filterable, true);
  assert.equal(all.request.filters.length, 2);
  assert.equal(all.request.optionalServices.length, 2);
  const onlyB = reg.bleRequest({ selection: 'b' });
  assert.deepEqual(onlyB.request.filters, [{ namePrefix: 'BBB' }]);
  const showAll = reg.bleRequest({ showAll: true });
  assert.equal(showAll.request.acceptAllDevices, true);
  const ranked = reg.bleCandidates({ name: 'B-123', services: ['0000ffe0-0000-1000-8000-00805f9b34fb', '0000fff0-0000-1000-8000-00805f9b34fb'] });
  assert.deepEqual(ranked.map((c) => c.definition.id), ['b-ble', 'a-ble']);
  const filtered = reg.bleCandidates({ name: 'x', services: ['0000ffe0-0000-1000-8000-00805f9b34fb'] });
  assert.deepEqual(filtered.map((c) => c.definition.id), ['a-ble']);
});

test('DriverRegistry: family prefix wins over a driver with the same id', () => {
  const mk = (id, family) => ({ id, family, vendor: family, protocol: id, deviceType: 'bms', links: { serial: { profiles: [{ id: `${id}-p`, baudRate: 9600 }] } }, create: () => null });
  const reg = new DriverRegistry([mk('daly-modbus', 'daly'), mk('daly', 'daly'), mk('jk-ble', 'jk')]);
  assert.deepEqual(reg.select('daly').map((d) => d.id), ['daly']);
  assert.deepEqual(reg.select('family:daly').map((d) => d.id), ['daly-modbus', 'daly']);
  assert.deepEqual(reg.select('jk').map((d) => d.id), ['jk-ble']);
  assert.deepEqual(reg.serialCandidates({ selection: 'family:daly' }).map((c) => c.definition.id), ['daly-modbus', 'daly']);
});
