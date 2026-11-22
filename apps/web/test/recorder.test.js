import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeriesStore, memoryBackend } from '@ubms/ui/timeseries';
import { HistoryRecorder, stableLinkId } from '../src/history/recorder.js';

/** A session stand-in: the recorder only listens to its events and reads these fields. */
function fakeSession({ info = /** @type {any} */ ({}), target = /** @type {any} */ ({ kind: 'ble', handle: { id: 'dev-1', name: 'JK-B2A24S' } }) } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();
  return {
    target,
    info,
    snapshot: null,
    definition: { id: 'jk-ble', family: 'jk', vendor: 'JK', protocol: 'JK', deviceType: 'bms' },
    link: { name: target.handle.name },
    /** @param {string} name @param {Function} fn */
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)?.add(fn);
      return () => handlers.get(name)?.delete(fn);
    },
    /** @param {string} name @param {any} value */
    emit(name, value) {
      for (const fn of handlers.get(name) ?? []) fn(value);
    },
  };
}

const prefs = () => ({ historyEnabled: true, historyIntervalMs: 1000, historyRetentionDays: 0 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a serial port names the adapter, not the device: no history key from the port path', () => {
  const tauriPort = { id: 'COM7', name: 'COM7', describe: () => ({ backend: 'tauri', kind: 'serial', name: 'COM7' }) };
  assert.equal(stableLinkId({ kind: 'serial', handle: tauriPort }), '');
  assert.equal(stableLinkId({ kind: 'serial', handle: { id: 'usb-1a86-7523', name: 'CH340' } }), '');
  assert.equal(stableLinkId({ kind: 'ble', handle: { id: 'dev-1' } }), 'dev-1');
});

test('two batteries behind one desktop serial port get two histories', async () => {
  const store = createSeriesStore(memoryBackend());
  for (const [driver, model] of [
    ['daly', 'DL-BMS-R16-02E'],
    ['jbd', 'JBD-SP25S003-L16S'],
  ]) {
    const port = { id: 'COM7', name: 'COM7', describe: () => ({ backend: 'tauri' }) };
    const session = fakeSession({ info: { model }, target: { kind: 'serial', handle: port } });
    session.definition = { ...session.definition, id: driver, family: driver };
    const rec = new HistoryRecorder({ session: /** @type {any} */ (session), store, demoStore: store, prefs });
    session.emit('state', { state: 'connected' });
    session.emit('state', { state: 'idle' });
    rec.dispose();
  }
  const stored = (await store.list()).map((/** @type {any} */ x) => x.key).sort();
  assert.equal(new Set(stored).size, 2, JSON.stringify(stored));
  assert.ok(stored.every((/** @type {string} */ k) => !k.startsWith('serial:')), JSON.stringify(stored));
});

test('stored records ahead of the clock do not stop the recording', async () => {
  const now = 1_800_000_000_000;
  const store = createSeriesStore(memoryBackend());
  const key = 'sn:jk:ABC123';
  // Written while the clock was 30 minutes ahead.
  await store.append(key, [
    { t: now + 30 * 60e3, u: 53 },
    { t: now + 31 * 60e3, u: 53 },
  ]);
  const session = fakeSession({ info: { serialNumber: 'ABC123' } });
  const rec = new HistoryRecorder({ session: /** @type {any} */ (session), store, demoStore: store, prefs, now: () => now });
  session.emit('state', { state: 'connected' });
  assert.equal(rec.live?.key, key);
  await tick();
  for (let i = 0; i < 5; i++) session.emit('snapshot', { timestamp: now + i * 1000, voltage: 52 + i / 10 });
  assert.deepEqual(
    rec.live?.tail.map((r) => r.t),
    [0, 1, 2, 3, 4].map((i) => now + i * 1000),
  );
  assert.equal(rec.buffer.length, 5);
  rec.dispose();
});

test('a clock step back in the middle of a session keeps recording', () => {
  const session = fakeSession({ info: { serialNumber: 'ABC123' } });
  const store = createSeriesStore(memoryBackend());
  const rec = new HistoryRecorder({ session: /** @type {any} */ (session), store, demoStore: store, prefs, now: () => 2_000_000 });
  session.emit('state', { state: 'connected' });
  const t0 = 10_000_000;
  for (let i = 0; i < 3; i++) session.emit('snapshot', { timestamp: t0 + i * 1000, voltage: 52 });
  // The clock goes back by five minutes.
  for (let i = 0; i < 3; i++) session.emit('snapshot', { timestamp: t0 - 300_000 + i * 1000, voltage: 51 });
  const tail = rec.live?.tail.map((r) => r.t) ?? [];
  assert.deepEqual(tail, [0, 1, 2].map((i) => t0 - 300_000 + i * 1000));
  assert.equal(rec.buffer.length, 6, 'every reading is kept for the store');
  rec.dispose();
});
