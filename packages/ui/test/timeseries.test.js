import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSeriesStore,
  memoryBackend,
  tauriFileBackend,
  indexedDbBackend,
  fallbackBackend,
  downsampleMinMax,
  csvEscape,
  toCsv,
} from '../src/timeseries.js';
import { downloadFile, setFileSaver } from '../src/files.js';

test('series store on the memory backend: append, ranges, meta, list, prune, remove', async () => {
  const store = createSeriesStore(memoryBackend());
  assert.deepEqual(await store.info(), { kind: 'memory', persistent: false });
  await store.append('a', [
    { t: 1000, u: 1 },
    { u: 3, t: 3000.4 },
    { t: 2000, u: 2 },
    { u: 9 }, // no time: dropped
    null,
  ]);
  const all = await store.read('a');
  assert.deepEqual(all, [
    { t: 1000, u: 1 },
    { t: 2000, u: 2 },
    { t: 3000, u: 3 },
  ]);
  for (const r of all) assert.equal(Object.keys(r)[0], 't');
  assert.deepEqual((await store.read('a', { from: 1500 })).map((r) => r.t), [2000, 3000]);
  assert.deepEqual((await store.read('a', { to: 2000 })).map((r) => r.t), [1000, 2000]);
  assert.deepEqual((await store.read('a', { from: 2000, to: 2000 })).map((r) => r.t), [2000]);
  assert.deepEqual(await store.read('a', { from: 5000, to: 1000 }), []);
  assert.deepEqual(await store.read('missing'), []);
  // A record with an existing time replaces it.
  await store.append('a', [{ t: 2000, u: 2.5 }]);
  assert.deepEqual((await store.read('a')).map((r) => r.u), [1, 2.5, 3]);

  await store.writeMeta('a', { name: 'Pack A' });
  await store.writeMeta('b', { name: 'Pack B' });
  await store.append('b', [{ t: 9000, u: 5 }]);
  const list = await store.list();
  assert.deepEqual(
    list.map((x) => [x.key, x.meta?.name, x.count, x.first, x.last]),
    [
      ['b', 'Pack B', 1, 9000, 9000],
      ['a', 'Pack A', 3, 1000, 3000],
    ],
  );
  assert.equal(await store.prune('a', 2500), 2);
  assert.deepEqual((await store.read('a')).map((r) => r.t), [3000]);
  assert.equal(await store.prune('a', NaN), 0);
  await store.remove('a');
  assert.deepEqual(await store.read('a'), []);
  assert.deepEqual((await store.list()).map((x) => x.key), ['b']);
});

test('series store serializes operations per key', async () => {
  const log = [];
  const base = memoryBackend();
  /** @type {import('../src/timeseries.js').SeriesBackend} */
  const slow = {
    ...base,
    async append(key, records) {
      log.push(`append start ${records[0].t}`);
      await new Promise((r) => setTimeout(r, 15));
      await base.append(key, records);
      log.push(`append end ${records[0].t}`);
    },
    async read(key, range) {
      log.push('read');
      return base.read(key, range);
    },
  };
  const store = createSeriesStore(slow);
  const a = store.append('k', [{ t: 1 }]);
  const b = store.append('k', [{ t: 2 }]);
  const r = store.read('k');
  await Promise.all([a, b]);
  assert.deepEqual((await r).map((x) => x.t), [1, 2]);
  assert.deepEqual(log, ['append start 1', 'append end 1', 'append start 2', 'append end 2', 'read']);
  // A failed operation does not block the next one.
  const failing = createSeriesStore({ ...base, append: async () => Promise.reject(new Error('disk full')) });
  await assert.rejects(failing.append('x', [{ t: 1 }]), /disk full/);
  assert.deepEqual(await failing.read('x'), []);
});

/**
 * In-memory model of the Tauri history commands (same rules as the Rust side).
 * @param {{ withLast?: boolean }} [opts] withLast: history_list reports the last record time
 */
function fakeTauri({ withLast = true } = {}) {
  /** @type {Map<string, string[]>} */
  const files = new Map();
  /** @type {Map<string, string>} */
  const metas = new Map();
  const calls = [];
  const lead = /^\{"t":(-?\d+)[,}]/;
  /**
   * @param {string} cmd
   * @param {Record<string, any>} [args]
   */
  const invoke = async (cmd, args = {}) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case 'history_info':
        return { dir: 'C:/apps/ubms/ubms-data/history', portable: true, reason: 'portable marker file next to the executable' };
      case 'history_append':
        for (const line of args.lines) if (/[\r\n]/.test(line)) throw 'line contains a line break';
        files.set(args.key, [...(files.get(args.key) ?? []), ...args.lines]);
        return null;
      case 'history_read': {
        const from = args.from ?? -Infinity;
        const to = args.to ?? Infinity;
        return (files.get(args.key) ?? []).filter((l) => {
          const m = lead.exec(l);
          return m && Number(m[1]) >= from && Number(m[1]) <= to;
        });
      }
      case 'history_write_meta':
        metas.set(args.key, args.meta);
        return null;
      case 'history_list':
        return [...new Set([...files.keys(), ...metas.keys()])].map((key) => {
          // Like line_time: a complete record line ends with '}' (a cut line does not count).
          const times = (files.get(key) ?? [])
            .filter((l) => l.endsWith('}'))
            .map((l) => lead.exec(l))
            .filter(Boolean)
            .map((m) => Number(m?.[1]));
          return {
            key,
            meta: metas.get(key) ?? null,
            bytes: (files.get(key) ?? []).reduce((n, l) => n + l.length + 1, 0),
            modified: 1700000000000,
            // An older bridge does not report the last record time.
            ...(withLast ? { last: times.length ? Math.max(...times) : null } : {}),
          };
        });
      case 'history_remove':
        files.delete(args.key);
        metas.delete(args.key);
        return null;
      case 'history_prune': {
        const lines = files.get(args.key) ?? [];
        const keep = lines.filter((l) => {
          const m = lead.exec(l);
          return !m || Number(m[1]) >= args.before;
        });
        files.set(args.key, keep);
        return lines.length - keep.length;
      }
      default:
        throw `unknown command ${cmd}`;
    }
  };
  return { invoke, files, metas, calls };
}

test('tauriFileBackend: JSON lines with t first, ranges, meta, list', async () => {
  const fake = fakeTauri();
  const store = createSeriesStore(tauriFileBackend(fake.invoke));
  assert.deepEqual(await store.info(), {
    kind: 'file',
    persistent: true,
    dir: 'C:/apps/ubms/ubms-data/history',
    portable: true,
    reason: 'portable marker file next to the executable',
  });
  await store.append('sn:jk:1', [
    { u: 52.1, t: 1000.6, note: 'a\r\nb' },
    { t: 3000, u: 52.3 },
    { t: 2000, u: 52.2 },
  ]);
  const lines = fake.files.get('sn:jk:1') ?? [];
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '{"t":1001,"u":52.1,"note":"a\\r\\nb"}');
  for (const l of lines) assert.match(l, /^\{"t":\d+,/);
  // Lines come back in file order; the backend sorts them.
  assert.deepEqual((await store.read('sn:jk:1')).map((r) => r.t), [1001, 2000, 3000]);
  assert.deepEqual((await store.read('sn:jk:1', { from: 1500, to: Infinity })).map((r) => r.t), [2000, 3000]);
  const readCall = fake.calls.filter(([c]) => c === 'history_read').at(-1);
  assert.deepEqual(readCall?.[1], { key: 'sn:jk:1', from: 1500 });
  fake.files.get('sn:jk:1')?.push('garbage', '{"t":4000,"u":');
  assert.equal((await store.read('sn:jk:1')).length, 3);

  await store.writeMeta('sn:jk:1', { name: 'Pack', cellCount: 16 });
  assert.equal(fake.metas.get('sn:jk:1'), '{"name":"Pack","cellCount":16}');
  const [item] = await store.list();
  assert.equal(item.key, 'sn:jk:1');
  assert.deepEqual(item.meta, { name: 'Pack', cellCount: 16 });
  assert.equal(item.modified, 1700000000000);
  assert.equal(item.last, 3000, 'the time of the last record, not of the file');
  assert.ok((item.bytes ?? 0) > 0);

  assert.equal(await store.prune('sn:jk:1', 2500), 2);
  assert.deepEqual((await store.read('sn:jk:1')).map((r) => r.t), [3000]);
  await store.remove('sn:jk:1');
  assert.deepEqual(await store.list(), []);
  // A meta without records has no last record time; the file time is the fallback.
  await store.writeMeta('meta-only', { name: 'M' });
  assert.equal((await store.list())[0].last, 1700000000000);

  // A bridge without `last` in history_list: the change of the record file.
  const old = createSeriesStore(tauriFileBackend(fakeTauri({ withLast: false }).invoke));
  await old.append('k', [{ t: 5 }]);
  assert.equal((await old.list())[0].last, 1700000000000);
});

test('indexedDbBackend reports a missing IndexedDB as an error, also from info()', async () => {
  const store = createSeriesStore(indexedDbBackend('test-db'));
  await assert.rejects(store.info(), /IndexedDB is not available/);
  await assert.rejects(store.read('x'), /IndexedDB is not available/);
});

test('indexedDbBackend rejects a failed write with the error of the request, not null', async () => {
  const quota = new Error('QuotaExceededError');
  /** @type {any} */
  let tx = null;
  const fakeDb = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      tx = { error: null, objectStore: () => store };
      return tx;
    },
  };
  const store = {
    put: () => {
      // IndexedDB order: the request's error event bubbles to the transaction first (tx.error is
      // still null), then the transaction aborts with the request's error.
      setTimeout(() => {
        tx.onerror?.({ target: { error: quota } });
        tx.error = quota;
        tx.onabort?.();
      });
      return {};
    },
  };
  globalThis.indexedDB = /** @type {any} */ ({
    open: () => {
      /** @type {any} */
      const req = { result: fakeDb };
      setTimeout(() => req.onsuccess?.());
      return req;
    },
  });
  try {
    const series = createSeriesStore(indexedDbBackend('test-db'));
    await assert.rejects(series.append('k', [{ t: 1, u: 2 }]), (err) => err === quota);
  } finally {
    delete (/** @type {any} */ (globalThis)).indexedDB;
  }
});

test('fallbackBackend uses the second backend when the first cannot be opened', async () => {
  // No IndexedDB here (like a profile that blocks site data): memory instead.
  const store = createSeriesStore(fallbackBackend(indexedDbBackend('test-db'), memoryBackend()));
  assert.deepEqual(await store.info(), { kind: 'memory', persistent: false });
  await store.append('k', [{ t: 1, u: 2 }]);
  await store.writeMeta('k', { name: 'Pack' });
  assert.deepEqual(await store.read('k'), [{ t: 1, u: 2 }]);
  assert.deepEqual((await store.list()).map((x) => [x.key, x.count]), [['k', 1]]);
  assert.equal(await store.prune('k', 5), 1);
  await store.remove('k');
  assert.deepEqual(await store.list(), []);

  // A primary that opens stays in use, and its later errors reach the caller.
  const primary = memoryBackend();
  let fail = false;
  const flaky = { ...primary, append: (/** @type {string} */ key, /** @type {any[]} */ records) => (fail ? Promise.reject(new Error('disk full')) : primary.append(key, records)) };
  const secondary = memoryBackend();
  const both = createSeriesStore(fallbackBackend(flaky, secondary));
  await both.append('k', [{ t: 1 }]);
  fail = true;
  await assert.rejects(both.append('k', [{ t: 2 }]), /disk full/);
  assert.deepEqual((await both.read('k')).map((r) => r.t), [1]);
  assert.deepEqual(await secondary.read('k', {}), []);
});

test('downsampleMinMax keeps first, min, max and last per bucket in time order', () => {
  /** @type {Array<{ t: number, v: number }>} */
  const pts = [];
  for (let i = 0; i < 1000; i++) pts.push({ t: i, v: Math.sin(i / 10) });
  pts[503].v = 50; // a spike must survive
  pts[707].v = -50;
  pts[800].v = NaN; // skipped
  const out = downsampleMinMax(pts, 0, 999, 10);
  assert.ok(out.length <= 40, String(out.length));
  assert.ok(out.length >= 20);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t);
  assert.ok(out.some((p) => p.v === 50));
  assert.ok(out.some((p) => p.v === -50));
  assert.equal(out[0].t, 0);
  assert.equal(out.at(-1)?.t, 999);
  assert.ok(out.every((p) => Number.isFinite(p.v)));
  // The window clips, small inputs come back as they are.
  const clipped = downsampleMinMax(pts, 100, 109, 10);
  assert.deepEqual(clipped.map((p) => p.t), [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
  assert.deepEqual(downsampleMinMax([], 0, 1, 10), []);
  // Open bounds keep everything that is small enough.
  assert.equal(downsampleMinMax(pts.slice(0, 30), -Infinity, Infinity, 100).length, 30);
});

test('downsampleMinMax is fast on a week of 2 s records', () => {
  const n = 302400;
  const pts = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = { t: 1.7e12 + i * 2000, v: 52 + Math.sin(i / 500) };
  const started = performance.now();
  const out = downsampleMinMax(pts, pts[0].t, pts[n - 1].t, 1600);
  const ms = performance.now() - started;
  assert.ok(out.length <= 6400);
  assert.ok(ms < 500, `${ms} ms`);
});

test('CSV: escaping, numbers with a dot, CRLF, optional BOM', () => {
  assert.equal(csvEscape(3.25), '3.25');
  assert.equal(csvEscape(-0.5), '-0.5');
  assert.equal(csvEscape(NaN), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('two\nlines'), '"two\nlines"');
  assert.equal(csvEscape('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvEscape('-12.5'), '-12.5');
  assert.equal(csvEscape(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), '2026-01-02T03:04:05.000Z');
  const csv = toCsv(['Time', 'Voltage (V)', 'MOS, inner (°C)'], [
    ['2026-01-02T05:04:05+02:00', 52.1, 30],
    ['2026-01-02T05:04:07+02:00', undefined, 30.5],
  ]);
  assert.equal(csv, 'Time,Voltage (V),"MOS, inner (°C)"\r\n2026-01-02T05:04:05+02:00,52.1,30\r\n2026-01-02T05:04:07+02:00,,30.5\r\n');
  assert.ok(toCsv(['a'], [], { bom: true }).startsWith('\uFEFFa\r\n'));
});

test('downloadFile hands the blob to a saver when one is set', async () => {
  /** @type {Array<[string, Blob]>} */
  const seen = [];
  setFileSaver(async (name, blob) => {
    seen.push([name, blob]);
    return 'C:/Users/me/Downloads/data.csv';
  });
  try {
    const path = await downloadFile('data.csv', 'a,b\r\n', 'text/csv');
    assert.equal(path, 'C:/Users/me/Downloads/data.csv');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'data.csv');
    assert.equal(seen[0][1].type, 'text/csv');
    assert.equal(await seen[0][1].text(), 'a,b\r\n');
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    await downloadFile('chart.png', png);
    assert.equal(seen[1][1], png);
    setFileSaver(() => {
      throw new Error('no permission');
    });
    await assert.rejects(downloadFile('x.txt', 'x', 'text/plain'), /no permission/);
  } finally {
    setFileSaver(null);
  }
});
