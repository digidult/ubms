// Session lifecycle: Cancel and Disconnect while connecting, failed detection, read-back after
// writes. A toy protocol (frame = 7E <cmd> <len> <payload> <sum8>) and fake BLE and serial
// handles stand in for real devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolLog, createLinkPair, FrameChannel, FrameAssembler, Emitter, sum8, concat, u16le } from '@ubms/transport';
import { BaseDriver, BmsSession, DriverRegistry, buildSchema, field } from '../src/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => boolean} cond @param {number} [timeoutMs] */
async function waitFor(cond, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('Timed out waiting for a condition');
    await wait(10);
  }
}

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
    this.channel = new FrameChannel(ctx.link, { createAssembler: toyAssembler }).start();
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
    return buildSchema([field('cell.ovp', { min: 3, max: 4 }), field('cell.ovpr', { min: 3, max: 4 })]);
  }
  async readSettings() {
    const f = await this.channel.requestUnqueued(toyFrame(0x03), { match: (fr) => fr[1] === 0x83, timeout: 150 });
    return { 'cell.ovp': u16le(f, 3) / 1000, 'cell.ovpr': u16le(f, 5) / 1000 };
  }
  async writeSetting(id, value) {
    const raw = Math.round(value * 1000);
    const reg = id === 'cell.ovp' ? 1 : 2;
    await this.channel.requestUnqueued(toyFrame(0x04, [reg, raw & 0xff, raw >> 8]), { match: (fr) => fr[1] === 0x84, timeout: 150 });
  }
  dispose() {
    this.channel.stop();
    super.dispose();
  }
}

/** @param {Record<string, any>} over */
function toyDefinition(over) {
  const def = { family: 'toy', vendor: 'Toy', protocol: 'Toy protocol', deviceType: 'bms', links: {}, ...over };
  def.create = (ctx) => new ToyDriver(def, ctx);
  return def;
}

const serialProfiles = { serial: { profiles: [{ id: 'toy-9600', baudRate: 9600 }] } };
const bleProfiles = { ble: { namePrefixes: ['TOY'], profiles: [{ id: 'p', service: 0xffe0, notify: 0xffe1, write: 0xffe1 }] } };

/**
 * Simulated toy device on the device side of a memory link.
 * @param {any} device
 * @param {{ isSilent?: () => boolean, onWrite?: (n: number) => boolean | void }} [opts] onWrite
 *   returning false leaves the write unanswered
 */
function toyDevice(device, { isSilent, onWrite } = {}) {
  const st = { ovp: 3650, ovpr: 3400, writes: 0, silent: false, answerReads: true };
  const silent = isSilent ?? (() => st.silent);
  device.on('data', (bytes) => {
    if (silent()) return;
    const cmd = bytes[1];
    if (cmd === 0x01) device.write(toyFrame(0x81, [7]));
    if (cmd === 0x02) device.write(toyFrame(0x82, [0x72, 0x14]));
    if (cmd === 0x03 && st.answerReads) device.write(toyFrame(0x83, [st.ovp & 0xff, st.ovp >> 8, st.ovpr & 0xff, st.ovpr >> 8]));
    if (cmd === 0x04) {
      st.writes++;
      if (onWrite?.(st.writes) === false) return;
      const raw = bytes[4] | (bytes[5] << 8);
      if (bytes[3] === 1) st.ovp = raw;
      else st.ovpr = raw;
      device.write(toyFrame(0x84));
    }
  });
  return st;
}

/**
 * BLE handle with the WebBleDevice behavior that matters here: Cancel cannot abort a pending GATT
 * connect, so a connect started before disconnect() still completes afterwards.
 */
class FakeBle extends Emitter {
  /** @param {string} name @param {{ connectDelayMs?: number }} [opts] */
  constructor(name, { connectDelayMs = 0 } = {}) {
    super();
    this.kind = 'ble';
    this.id = `fake-${name}`;
    this.name = name;
    this.connected = false;
    this.connectDelayMs = connectDelayMs;
    this.silent = false;
    this.channels = 0;
  }
  describe() {
    return { kind: 'ble', id: this.id, name: this.name };
  }
  async connect() {
    if (this.connected) return;
    if (this.connectDelayMs) await wait(this.connectDelayMs);
    this.connected = true;
  }
  async discover() {
    return [{ uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', characteristics: [] }];
  }
  async openChannel() {
    if (!this.connected) await this.connect();
    this.channels++;
    const { host, device } = createLinkPair({ name: this.name });
    await device.open();
    await host.open();
    toyDevice(device, { isSilent: () => this.silent });
    return host;
  }
  async disconnect() {
    this.connected = false;
  }
}

const bleToy = toyDefinition({ id: 'toy-ble', links: bleProfiles });
const linkToy = toyDefinition({ id: 'toy' });

async function directLink(log, opts) {
  const { host, device } = createLinkPair({ log });
  await device.open();
  return { host, device, st: toyDevice(device, opts) };
}

test('BmsSession: Cancel during a pending BLE connect stays idle and releases the late GATT connection', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 100 });
  const states = [];
  session.on('state', (s) => states.push(s.state));
  const ble = new FakeBle('TOY-A', { connectDelayMs: 150 });
  const pending = session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  await wait(10);
  await session.disconnect();
  await assert.rejects(pending, (e) => e.code === 'cancelled');
  assert.equal(session.state, 'idle');
  assert.equal(ble.connected, false);
  assert.equal(ble.channels, 0);
  assert.deepEqual(states, ['connecting', 'disconnecting', 'idle']);
});

test('BmsSession: a stale BLE connect does not disturb the next session', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy, linkToy]), log, pollIntervalMs: 30, probeTimeoutMs: 100 });
  const ble = new FakeBle('TOY-A', { connectDelayMs: 150 });
  const pending = session.connect({ kind: 'ble', handle: ble, selection: 'auto' }).catch((e) => e.code);
  await wait(10);
  await session.disconnect();
  const { host } = await directLink(log);
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  let snapshots = 0;
  session.on('snapshot', () => snapshots++);
  assert.equal(await pending, 'cancelled');
  await wait(150);
  assert.equal(session.state, 'connected');
  assert.ok(snapshots >= 2, 'the new session keeps polling');
  assert.equal(ble.connected, false, 'the stale GATT connection is released');
  await session.disconnect();
});

test('BmsSession: Disconnect during auto-reconnect releases the late GATT connection', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 100, reconnectDelayMs: 10 });
  const ble = new FakeBle('TOY-A');
  await session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  assert.equal(session.state, 'connected');
  ble.connected = false;
  ble.connectDelayMs = 200;
  session.link.simulateDrop('Bluetooth disconnected');
  await wait(40);
  assert.equal(session.state, 'reconnecting');
  await session.disconnect();
  await wait(250);
  assert.equal(session.state, 'idle');
  assert.equal(ble.connected, false);
  assert.equal(ble.channels, 1, 'no channel is opened after Disconnect');
});

test('BmsSession: a failed BLE detection releases GATT, so do exhausted reconnect attempts', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 30, reconnectDelayMs: 5 });
  const silent = new FakeBle('TOY-A');
  silent.silent = true;
  await assert.rejects(session.connect({ kind: 'ble', handle: silent, selection: 'auto' }), (e) => e.code === 'not-detected');
  assert.equal(session.state, 'error');
  assert.equal(silent.connected, false);

  const ble = new FakeBle('TOY-B');
  await session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  ble.silent = true;
  ble.connected = false;
  session.link.simulateDrop('Bluetooth disconnected');
  await waitFor(() => session.state === 'error');
  assert.ok(ble.channels > 1, 'reconnect attempts reopened the channel');
  assert.equal(ble.connected, false, 'GATT is released after the last attempt');
});

test('BmsSession: connecting from the error state releases the previous device and resets its data', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 100, autoReconnect: false });
  const a = new FakeBle('TOY-A');
  await session.connect({ kind: 'ble', handle: a, selection: 'auto' });
  await session.loadSettings();
  // The channel is gone while GATT stays up.
  session.link.simulateDrop('Notifications stopped');
  await waitFor(() => session.state === 'error');
  assert.equal(a.connected, true);
  assert.notEqual(session.settings.values, null);
  const states = [];
  session.on('state', (s) => states.push(s.state));
  const b = new FakeBle('TOY-B');
  await session.connect({ kind: 'ble', handle: b, selection: 'auto' });
  assert.deepEqual(states.slice(0, 3), ['disconnecting', 'idle', 'connecting'], "'idle' tells subscribers to drop the old data");
  assert.equal(a.connected, false, 'the previous device is released');
  assert.equal(session.settings.values, null);
  assert.equal(session.state, 'connected');
  await session.disconnect();
  assert.equal(b.connected, false);
});

test('BmsSession: Try again after a failed connect uses the selection of the new target', async () => {
  const log = new ProtocolLog();
  const serialToy = toyDefinition({ id: 'alpha', family: 'alpha', links: serialProfiles });
  const session = new BmsSession({ registry: new DriverRegistry([linkToy, serialToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 50 });
  const { host } = await directLink(log);
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  host.simulateDrop('cable unplugged');
  await waitFor(() => session.state === 'error');
  let awake = false;
  const port = {
    async openLink() {
      const pair = createLinkPair({ log });
      await pair.device.open();
      await pair.host.open();
      toyDevice(pair.device, { isSilent: () => !awake });
      return pair.host;
    },
  };
  await assert.rejects(session.connect({ kind: 'serial', handle: port, selection: 'auto' }), (e) => e.code === 'not-detected');
  assert.equal(session.definition, null, 'no driver of the previous target is kept');
  awake = true;
  await session.reconnect();
  assert.equal(session.state, 'connected');
  assert.equal(session.definition?.id, 'alpha');
  await session.disconnect();
});

test('BmsSession: Cancel during serial detection closes the port of the running probe', async () => {
  const log = new ProtocolLog();
  const first = toyDefinition({ id: 'toy-a', family: 'a', links: serialProfiles });
  const second = toyDefinition({ id: 'toy-b', family: 'b', links: serialProfiles });
  const session = new BmsSession({ registry: new DriverRegistry([first, second]), log, pollIntervalMs: 1000, probeTimeoutMs: 800 });
  // Like Web Serial, the port refuses to open twice.
  let isOpen = false;
  let asleep = true;
  const port = {
    async openLink() {
      if (isOpen) throw new Error('The port is already open');
      isOpen = true;
      const { host, device } = createLinkPair({ log });
      await device.open();
      await host.open();
      host.on('close', () => (isOpen = false));
      toyDevice(device, { isSilent: () => asleep });
      return host;
    },
  };
  const pending = session.connect({ kind: 'serial', handle: port, selection: 'auto' }).catch((e) => e.code);
  await wait(30);
  assert.equal(isOpen, true);
  await session.disconnect();
  assert.equal(isOpen, false, 'Cancel closes the probe link at once');
  asleep = false;
  await session.connect({ kind: 'serial', handle: port, selection: 'auto' });
  assert.equal(session.state, 'connected');
  assert.equal(session.definition?.id, 'toy-a');
  assert.equal(await pending, 'cancelled');
  assert.equal(session.state, 'connected');
  await session.disconnect();
});

test('BmsSession: a failed read-back leaves writes unverified instead of comparing old values', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([linkToy]), log, pollIntervalMs: 1000 });
  const { host, st } = await directLink(log);
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  await session.loadSettings();
  assert.equal(session.settings.values['cell.ovp'], 3.65);
  st.answerReads = false;
  const [r] = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
  assert.equal(st.ovp, 3600);
  assert.equal(r.ok, true);
  assert.equal(r.verified, undefined);
  assert.equal(r.actual, undefined);
  assert.equal(typeof r.readBackError, 'string');
  await session.disconnect();
});

test('BmsSession: a link drop in the middle of a write batch still returns per-field results', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([linkToy]), log, pollIntervalMs: 1000 });
  const { host, device, st } = await directLink(log, {
    onWrite: (n) => {
      if (n !== 2) return;
      device.simulateDrop('BMS restarted');
      return false;
    },
  });
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  const results = await session.writeSettings([
    { id: 'cell.ovp', value: 3.6 },
    { id: 'cell.ovpr', value: 3.3 },
  ]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok]),
    [
      ['cell.ovp', true],
      ['cell.ovpr', false],
    ],
  );
  assert.equal(st.ovp, 3600);
  assert.equal(results[0].verified, undefined);
  assert.equal(results[0].readBackError, 'Not connected');
  assert.equal(session.state, 'error');
});

/**
 * Toy driver with the hooks the overlap tests need: a settings or info read that finishes late
 * (real drivers wait for their timeouts and return partial values after dispose()), a start() that
 * can fail, and two fields kept in the app (a secret password and a normalised address).
 */
class HookedToyDriver extends ToyDriver {
  async start() {
    if (this.definition.startFails?.()) throw new Error('The connection is not open');
  }
  getSettingsSchema() {
    return buildSchema([
      field('cell.ovp', { min: 3, max: 4 }),
      field('toy.password', { label: 'Password', group: 'identity', type: 'text', maxLength: 8, secret: true, meta: { kind: 'local' } }),
      field('toy.address', { label: 'Address', group: 'identity', type: 'text', meta: { kind: 'local' } }),
    ]);
  }
  async readSettings() {
    const delay = this.definition.readDelayMs;
    if (!delay) return { ...(await super.readSettings()), 'toy.address': this.ctx.options.address };
    await wait(delay);
    if (this.definition.readError) throw new Error(this.definition.readError);
    return { 'cell.ovp': this.definition.ovp };
  }
  async readInfo() {
    if (this.definition.infoDelayMs) await wait(this.definition.infoDelayMs);
    return this.definition.serial ? { serialNumber: this.definition.serial } : { model: 'Toy' };
  }
  async writeSetting(id, value) {
    if (id === 'toy.password') this.ctx.options.password = value;
    else if (id === 'toy.address') this.ctx.options.address = String(value).toUpperCase();
    else await super.writeSetting(id, value);
  }
}

/** @param {Record<string, any>} over */
function hookedDefinition(over) {
  const def = { family: 'toy', vendor: 'Toy', protocol: 'Toy protocol', deviceType: 'bms', links: {}, ...over };
  def.create = (ctx) => new HookedToyDriver(def, ctx);
  return def;
}

/** Make link.close() (and the cleanup after a remote close) take `ms`, like a GATT unsubscribe. */
function slowClose(link, ms) {
  const close = link._close.bind(link);
  link._close = async () => {
    await wait(ms);
    await close();
  };
  return link;
}

test('BmsSession: Disconnect and an immediate connect end connected, with no channel left behind', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([linkToy]), log, pollIntervalMs: 30 });
  const a = await directLink(log);
  slowClose(a.host, 120);
  await session.connect({ kind: 'link', link: a.host, selection: 'toy' });
  const leaving = session.disconnect();
  await wait(10);
  const b = await directLink(log);
  await session.connect({ kind: 'link', link: b.host, selection: 'toy' });
  await leaving;
  await wait(150);
  assert.equal(session.state, 'connected', 'the late first pass does not return the new connection to idle');
  assert.equal(session.definition?.id, 'toy');
  assert.notEqual(session.driver, null);
  assert.equal(a.host.isOpen, false);
  await session.disconnect();
  assert.equal(b.host.isOpen, false, 'Disconnect releases the new connection');
});

test('BmsSession: two connects in a row keep one connection and cancel the first', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 100 });
  const a = new FakeBle('TOY-A');
  await session.connect({ kind: 'ble', handle: a, selection: 'auto' });
  slowClose(session.link, 80);
  const b = new FakeBle('TOY-B');
  const first = session.connect({ kind: 'ble', handle: b, selection: 'auto' }).then(
    () => 'ok',
    (e) => e.code,
  );
  await wait(10);
  await session.connect({ kind: 'ble', handle: b, selection: 'auto' });
  assert.equal(await first, 'cancelled');
  assert.equal(session.state, 'connected');
  assert.equal(b.channels, 1, 'only one channel is opened on the device');
  await session.disconnect();
});

test('BmsSession: two Disconnect calls share one pass', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([linkToy]), log, pollIntervalMs: 1000 });
  const { host } = await directLink(log);
  slowClose(host, 50);
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  const states = [];
  session.on('state', (s) => states.push(s.state));
  await Promise.all([session.disconnect(), session.disconnect()]);
  assert.deepEqual(states, ['disconnecting', 'idle']);
});

test('BmsSession: Disconnect while a lost link is torn down ends idle, not reconnecting', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 100, reconnectDelayMs: 10 });
  const ble = new FakeBle('TOY-A');
  await session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  slowClose(session.link, 80);
  session.link.simulateDrop('Bluetooth disconnected');
  await wait(10);
  await session.disconnect();
  await wait(150);
  assert.equal(session.state, 'idle');
  assert.equal(ble.channels, 1, 'no reconnect attempt runs');
});

for (const readError of [undefined, 'The BMS did not answer the settings requests']) {
  test(`BmsSession: a ${readError ? 'failed' : 'late'} settings read of the previous device does not land on the next one`, async () => {
    const log = new ProtocolLog();
    const slow = hookedDefinition({ id: 'slow', readDelayMs: 120, ovp: 3.99, readError });
    const session = new BmsSession({ registry: new DriverRegistry([slow, linkToy]), log, pollIntervalMs: 1000 });
    const a = await directLink(log);
    await session.connect({ kind: 'link', link: a.host, selection: 'slow' });
    const reading = session.loadSettings();
    await wait(10);
    await session.disconnect();
    assert.equal(session.settings.loading, false, 'Disconnect clears the pending read');
    const b = await directLink(log);
    await session.connect({ kind: 'link', link: b.host, selection: 'toy' });
    const events = [];
    session.on('settings', (s) => events.push(s));
    const stale = await reading;
    assert.equal(stale.error, 'Not connected');
    assert.equal(stale.values, null);
    assert.deepEqual(events, [], "no 'settings' event on the new connection");
    assert.deepEqual(session.settings, { schema: null, values: null, loading: false, error: null });
    await session.disconnect();
  });
}

test('BmsSession: refreshInfo of the previous device does not merge into the next one', async () => {
  const log = new ProtocolLog();
  const slow = hookedDefinition({ id: 'slow-a', serial: 'SN-A' });
  const other = hookedDefinition({ id: 'slow-b' });
  const session = new BmsSession({ registry: new DriverRegistry([slow, other]), log, pollIntervalMs: 1000 });
  const a = await directLink(log);
  await session.connect({ kind: 'link', link: a.host, selection: 'slow-a' });
  await waitFor(() => session.info?.serialNumber === 'SN-A');
  slow.infoDelayMs = 100;
  const refreshing = session.refreshInfo();
  await wait(10);
  await session.disconnect();
  const b = await directLink(log);
  await session.connect({ kind: 'link', link: b.host, selection: 'slow-b' });
  await refreshing;
  await waitFor(() => session.info?.model === 'Toy');
  assert.equal(session.info?.serialNumber, undefined, 'no serial number of the previous device');
  await session.disconnect();
});

test('BmsSession: a start() failure on reconnect keeps the session reconnecting', async () => {
  const log = new ProtocolLog();
  let fail = false;
  let failures = 0;
  const def = hookedDefinition({
    id: 'toy-start',
    links: bleProfiles,
    startFails: () => {
      if (!fail) return false;
      fail = false;
      failures++;
      return true;
    },
  });
  const session = new BmsSession({ registry: new DriverRegistry([def]), log, pollIntervalMs: 1000, probeTimeoutMs: 100, reconnectDelayMs: 60 });
  const ble = new FakeBle('TOY-A');
  await session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  const states = [];
  session.on('state', (s) => states.push(s.state));
  fail = true;
  session.link.simulateDrop('Bluetooth disconnected');
  await waitFor(() => failures === 1);
  await wait(20);
  assert.equal(session.state, 'reconnecting', 'no false connected state between attempts');
  assert.equal(session.driver, null);
  await waitFor(() => session.state === 'connected');
  assert.deepEqual(states, ['reconnecting', 'connected', 'reconnecting', 'connected']);
  await session.disconnect();
});

test('BmsSession: a cancelled BLE connect that fails later reports the cancel', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 100 });
  const ble = new FakeBle('TOY-A');
  ble.connect = async () => {
    await wait(80);
    throw new Error('Bluetooth connection timed out');
  };
  const pending = session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  await wait(10);
  await session.disconnect();
  await assert.rejects(pending, (e) => e.code === 'cancelled');
  assert.equal(session.state, 'idle');
});

test('BmsSession: failed links report translatable messages', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([bleToy, linkToy]), log, pollIntervalMs: 1000, probeTimeoutMs: 30, reconnectDelayMs: 5 });
  const silent = await directLink(log, { isSilent: () => true });
  await assert.rejects(session.connect({ kind: 'link', link: silent.host, selection: 'toy' }), (e) => e.code === 'not-detected' && e.message === 'The device sent no valid answer');
  const ble = new FakeBle('TOY-B');
  await session.connect({ kind: 'ble', handle: ble, selection: 'auto' });
  ble.silent = true;
  ble.connected = false;
  session.link.simulateDrop('Bluetooth disconnected');
  await waitFor(() => session.state === 'error');
  assert.equal(session.error?.message, 'Bluetooth disconnected', 'the reason is the translation key');
});

test('BmsSession: writeSettings keeps the placeholders of a validation message', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry([linkToy]), log, pollIntervalMs: 1000 });
  const { host } = await directLink(log);
  await session.connect({ kind: 'link', link: host, selection: 'toy' });
  const [r] = await session.writeSettings([{ id: 'cell.ovp', value: 5 }]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Maximum is {max}');
  assert.equal(r.errorParams?.max, 4);
  await session.disconnect();
});

test('BmsSession: a secret is not logged, values kept in the app are not verified by read-back', async () => {
  const log = new ProtocolLog();
  const def = hookedDefinition({ id: 'toy-local' });
  const session = new BmsSession({ registry: new DriverRegistry([def]), log, pollIntervalMs: 1000 });
  const { host } = await directLink(log);
  await session.connect({ kind: 'link', link: host, selection: 'toy-local' });
  const results = await session.writeSettings([
    { id: 'toy.password', value: 'Pw-77x' },
    { id: 'toy.address', value: 'a4c137042dbe' },
    { id: 'cell.ovp', value: 3.6 },
  ]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results[1].verified, undefined, 'a normalised local value is not reported as different');
  assert.equal(results[2].verified, true);
  const texts = log.entries().map((e) => e.text ?? '');
  assert.ok(!texts.some((t) => t.includes('Pw-77x')), 'the password is not in the log');
  assert.ok(!JSON.stringify(log.export({ includeDecoded: true })).includes('Pw-77x'));
  assert.ok(texts.includes('Setting written: toy.password'));
  assert.ok(texts.includes('Setting written: toy.address = a4c137042dbe'), 'other values are still logged');
  await session.disconnect();
});
