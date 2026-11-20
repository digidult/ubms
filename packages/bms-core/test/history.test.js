import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HistoryBuffer,
  historyRecord,
  HISTORY_GROUPS,
  HISTORY_SERIES,
  cellSeries,
  temperatureSeries,
  availableSeries,
  historyDeviceMeta,
  UNNAMED_DEVICE,
  deviceHistoryKey,
  usableSerial,
  deriveSnapshot,
  chartedExtras,
  extraSeries,
  historyGroups,
} from '../src/index.js';

const snapshot = () =>
  deriveSnapshot({
    timestamp: 1700000000123.4,
    voltage: 53.12345,
    current: -12.34567,
    soc: 87.25,
    capacityRemaining: 245.6789,
    balanceCurrent: 0.0456,
    cells: [3.3201, 3.3249, NaN, 3.31],
    temperatures: [
      { id: 'mos', label: 'MOS', value: 31.26, kind: 'mos' },
      { id: 't1', label: 'T1', value: NaN },
    ],
  });

test('historyRecord: compact record with t first, rounded values, no absent keys', () => {
  const r = historyRecord(snapshot());
  assert.equal(Object.keys(r)[0], 't');
  assert.equal(r.t, 1700000000123);
  assert.equal(r.u, 53.123);
  assert.equal(r.i, -12.346);
  assert.equal(r.p, -655.8);
  assert.equal(r.soc, 87.3);
  assert.equal(r.cmin, 3.31);
  assert.equal(r.cmax, 3.325);
  assert.equal(r.cavg, 3.318);
  assert.equal(r.cdel, 0.0149);
  assert.deepEqual(r.c, [3.32, 3.325, null, 3.31]);
  assert.deepEqual(r.tc, [31.3, null]);
  assert.equal(r.bi, 0.046);
  assert.equal(r.cap, 245.68);
  const line = JSON.stringify(r);
  assert.match(line, /^\{"t":1700000000123,/);
  assert.ok(!line.includes('NaN'));

  const bare = historyRecord({ timestamp: 5, voltage: 13.2 });
  assert.deepEqual(bare, { t: 5, u: 13.2 });
  assert.ok(!('c' in bare) && !('tc' in bare) && !('cmin' in bare));
  // Negative zero would serialize as 0 anyway; keep the value clean.
  assert.ok(Object.is(historyRecord({ timestamp: 1, current: -0.0001 }).i, 0));
});

test('HISTORY_SERIES pick values and convert the cell difference to mV', () => {
  const r = historyRecord(snapshot());
  const by = Object.fromEntries(HISTORY_SERIES.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by), ['voltage', 'current', 'power', 'soc', 'cellMin', 'cellMax', 'cellAvg', 'cellDelta', 'balanceCurrent', 'capacity']);
  assert.equal(by.voltage.pick(r), 53.123);
  assert.equal(by.cellDelta.pick(r), 14.9);
  assert.equal(by.cellDelta.unit, 'mV');
  assert.equal(by.capacity.pick({ t: 1 }), undefined);
  const groups = new Set(HISTORY_GROUPS.map((g) => g.id));
  for (const s of HISTORY_SERIES) {
    assert.ok(groups.has(s.group), s.id);
    assert.ok(s.label && s.unit && Number.isInteger(s.decimals), s.id);
  }
  assert.deepEqual(
    HISTORY_GROUPS.map((g) => g.id),
    ['voltage', 'current', 'power', 'soc', 'cells', 'cellDelta', 'temperature', 'balance', 'capacity'],
  );
});

test('cellSeries and temperatureSeries', () => {
  const r = historyRecord(snapshot());
  const c2 = cellSeries(1);
  assert.equal(c2.id, 'cell2');
  assert.equal(c2.label, 'Cell {n}');
  assert.deepEqual(c2.params, { n: 2 });
  assert.equal(c2.group, 'cells');
  assert.equal(c2.pick(r), 3.325);
  assert.equal(cellSeries(2).pick(r), undefined);
  assert.equal(cellSeries(9).pick(r), undefined);
  const t1 = temperatureSeries(0, 'MOS');
  assert.equal(t1.id, 'temp1');
  assert.equal(t1.label, 'MOS');
  assert.equal(t1.params, undefined);
  assert.equal(t1.pick(r), 31.3);
  const t3 = temperatureSeries(2);
  assert.equal(t3.label, 'Temperature {n}');
  assert.deepEqual(t3.params, { n: 3 });
});

test('availableSeries lists only series with data, cells and sensors in order', () => {
  const records = [historyRecord(snapshot()), { t: 1700000002000, u: 53.2, c: [3.3, 3.3, 3.3, 3.3, 3.31], tc: [30, 29.5] }];
  const ids = availableSeries(records, { tempLabels: ['MOS', 'T1'] }).map((s) => s.id);
  assert.deepEqual(ids, [
    'voltage',
    'current',
    'power',
    'soc',
    'cellMin',
    'cellMax',
    'cellAvg',
    'cellDelta',
    'balanceCurrent',
    'capacity',
    'cell1',
    'cell2',
    'cell3',
    'cell4',
    'cell5',
    'temp1',
    'temp2',
  ]);
  const temps = availableSeries(records, { tempLabels: ['MOS', 'T1'] }).filter((s) => s.group === 'temperature');
  assert.deepEqual(temps.map((s) => s.label), ['MOS', 'T1']);
  assert.deepEqual(availableSeries([{ t: 1, u: 12 }]).map((s) => s.id), ['voltage']);
  assert.deepEqual(availableSeries([]), []);
});

test('historyDeviceMeta collects identity, cell count and temperature labels', () => {
  const definition = { id: 'jk-ble', family: 'jk', vendor: 'JK BMS', protocol: 'JK02 (Bluetooth)', deviceType: /** @type {const} */ ('bms') };
  const meta = historyDeviceMeta({
    definition,
    info: { model: 'BD6A20S10P', serialNumber: ' 4021234567\u0000 ', name: '' },
    snapshot: snapshot(),
    deviceName: 'JK_B2A24S',
  });
  assert.deepEqual(meta, {
    name: 'JK_B2A24S',
    vendor: 'JK BMS',
    protocol: 'JK02 (Bluetooth)',
    driverId: 'jk-ble',
    deviceType: 'bms',
    model: 'BD6A20S10P',
    serialNumber: '4021234567',
    cellCount: 4,
    tempLabels: ['MOS', 'T1'],
  });
  const own = historyDeviceMeta({ definition, info: { name: 'Garage pack', serialNumber: '0000' } });
  assert.equal(own.name, 'Garage pack');
  assert.equal(own.serialNumber, undefined);
  assert.deepEqual(own.tempLabels, []);
  assert.equal(historyDeviceMeta({}).name, 'Device');
  assert.equal(UNNAMED_DEVICE, 'Device', 'the fallback name is the English key the UI translates');
  assert.equal(historyDeviceMeta({ definition, address: 2 }).address, 2);
  assert.equal(historyDeviceMeta({ definition, address: Number.NaN }).address, undefined);
});

test('deviceHistoryKey prefers the serial number, then a stable link id, then the name', () => {
  const definition = { id: 'jk-ble', family: 'jk' };
  assert.equal(deviceHistoryKey({ definition, info: { serialNumber: ' 402123 ' }, linkKind: 'ble', linkId: 'abc' }), 'sn:jk:402123');
  for (const bad of ['', '   ', '0', '000000', undefined, null]) {
    assert.equal(
      deviceHistoryKey({ definition, info: { serialNumber: /** @type {any} */ (bad) }, linkKind: 'ble', linkId: 'Xy+12/==' }),
      'ble:Xy+12/==',
      String(bad),
    );
  }
  assert.equal(deviceHistoryKey({ definition, info: null, linkKind: 'tauri-serial', linkId: 'COM5' }), 'tauri-serial:COM5');
  assert.equal(deviceHistoryKey({ definition, info: {}, linkKind: 'serial', linkId: '', deviceName: 'USB Serial' }), 'name:jk-ble:USB Serial');
  assert.equal(deviceHistoryKey({ definition }), 'name:jk-ble:device');
  // Two packs on one RS485 bus: the bus address tells them apart, on the desktop (stable port
  // path) and in the browser (adapter or device name).
  const pack = (/** @type {number | undefined} */ address) => deviceHistoryKey({ definition, info: {}, linkKind: 'serial', linkId: 'COM7', address });
  assert.equal(pack(1), 'serial:COM7#1');
  assert.equal(pack(2), 'serial:COM7#2');
  assert.notEqual(pack(1), pack(2));
  assert.equal(pack(0), 'serial:COM7#0');
  assert.equal(pack(undefined), 'serial:COM7', 'no address set: the port alone');
  assert.equal(pack(Number.NaN), 'serial:COM7');
  assert.equal(deviceHistoryKey({ definition, info: {}, linkKind: 'serial', deviceName: 'CH340 (1a86:7523)', address: 3 }), 'name:jk-ble:CH340 (1a86:7523)#3');
  assert.equal(deviceHistoryKey({ definition, info: { serialNumber: 'A1' }, linkKind: 'serial', linkId: 'COM7', address: 3 }), 'sn:jk:A1', 'a serial number needs no address');
  assert.equal(usableSerial(12345), '12345');
  assert.equal(usableSerial(0), '');
});

test('HistoryBuffer still keeps short trends', () => {
  const b = new HistoryBuffer(2);
  b.push(deriveSnapshot({ timestamp: 1, voltage: 1 }));
  b.push(deriveSnapshot({ timestamp: 2, voltage: 2 }));
  b.push(deriveSnapshot({ timestamp: 3, voltage: 3 }));
  assert.deepEqual(b.series('voltage'), [
    { t: 2, v: 2 },
    { t: 3, v: 3 },
  ]);
});

test('charted extra values: recorded under x, own series and group, labels from the meta', () => {
  const extra = {
    energy: { label: 'Energy', value: 1234.5678, unit: 'Wh', decimals: 1, chart: true },
    duration: { label: 'Duration', value: '1:30:00', chart: { value: 1.5, unit: 'h', decimals: 4 } },
    note: { label: 'Note', value: 'text', chart: true },
    plain: { label: 'Plain', value: 7 },
  };
  assert.deepEqual(
    chartedExtras(extra).map(([id, c]) => [id, c.value, c.unit, c.decimals]),
    [
      ['energy', 1234.5678, 'Wh', 1],
      ['duration', 1.5, 'h', 4],
    ],
    'text values without a numeric chart value and unmarked values are skipped',
  );
  const snap = deriveSnapshot({ timestamp: 1700000000000, voltage: 12, current: 1, extra });
  const rec = historyRecord(snap);
  assert.deepEqual(rec.x, { energy: 1234.6, duration: 1.5 });
  assert.equal(Object.keys(rec)[0], 't');
  assert.equal(historyRecord(deriveSnapshot({ timestamp: 1, voltage: 1 })).x, undefined);

  const meta = historyDeviceMeta({ snapshot: snap, deviceName: 'DL24-BLE' });
  assert.deepEqual(meta.extraSeries, [
    { id: 'energy', label: 'Energy', unit: 'Wh', decimals: 1 },
    { id: 'duration', label: 'Duration', unit: 'h', decimals: 4 },
  ]);
  const series = availableSeries([rec, { t: rec.t + 1000, x: { other: 2 } }], meta);
  const extras = series.filter((s) => s.extra !== undefined);
  assert.deepEqual(
    extras.map((s) => [s.id, s.group, s.label, s.unit]),
    [
      ['x.energy', 'x:energy', 'Energy', 'Wh'],
      ['x.duration', 'x:duration', 'Duration', 'h'],
      ['x.other', 'x:other', 'other', ''],
    ],
  );
  assert.equal(extras[0].pick(rec), 1234.6);
  assert.equal(extraSeries('energy').pick({ t: 0 }), undefined);
  const groups = historyGroups(series);
  assert.deepEqual(
    groups.map((g) => g.id),
    ['voltage', 'current', 'power', 'x:energy', 'x:duration', 'x:other'],
    'fixed groups first, then one group per extra value',
  );
  assert.deepEqual(groups.find((g) => g.id === 'x:energy'), { id: 'x:energy', label: 'Energy', unit: 'Wh' });
});

