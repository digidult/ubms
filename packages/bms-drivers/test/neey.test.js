import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ProtocolLog, createLinkPair, fromHex, hex, concat, sum8 } from '@ubms/transport';
import { BaseDriver, BmsSession, DriverRegistry, fieldMap, validateValue, warnAll } from '@ubms/bms-core';
import * as P from '../src/neey/protocol.js';
import {
  BATTERY_TYPES,
  BUZZER_MODES,
  NAME_PATTERN,
  NAME_PREFIXES,
  NeeyBleDriver,
  balancerStateText,
  balancingFlags,
  buildNeeySchema,
  createNeeySimulator,
  decodeNeeySettings,
  encodeSettingWrite,
  neeyBleDefinition,
  neeyDeviceInfo,
  neeyDrivers,
  neeySnapshot,
} from '../src/neey/index.js';
import { drivers } from '../src/index.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors/neey.json', import.meta.url), 'utf8'));
/** @param {string} id */
const vector = (id) => {
  const v = vectors.find((/** @type {any} */ x) => x.id === id);
  assert.ok(v, `vector ${id} exists`);
  return v;
};
/** @param {string} id */
const bytesOf = (id) => fromHex(vector(id).hex);

/** Decimals of a number literal (the vectors round floats to the digits they list). @param {number} x */
const decimals = (x) => {
  const s = String(x);
  if (/e/i.test(s)) return 12;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
};
/** @param {number} v @param {number} d */
const roundTo = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
/**
 * Expected value of a vector against a decoded value: floats compared at the precision of the
 * expected literal (float32 noise), everything else exactly.
 * @param {any} e
 * @param {any} g
 * @returns {boolean}
 */
const same = (e, g) =>
  Array.isArray(e)
    ? Array.isArray(g) && e.length === g.length && e.every((x, i) => same(x, g[i]))
    : typeof e === 'number'
      ? typeof g === 'number' && roundTo(g, decimals(e)) === e
      : e === g;

/**
 * @param {Record<string, any>} actual
 * @param {Record<string, any>} expected
 * @param {string} id
 */
function assertFields(actual, expected, id) {
  for (const [k, v] of Object.entries(expected)) {
    if (k === 'notifications') continue;
    assert.ok(k in actual, `${id}: ${k} decoded`);
    assert.ok(same(v, actual[k]), `${id}: ${k} = ${JSON.stringify(actual[k])}, expected ${JSON.stringify(v)}`);
  }
}

/** @param {() => any} fn @param {number} [timeout] */
async function until(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Frames out of the host assembler. */
function hostAssembler() {
  /** @type {Uint8Array[]} */
  const frames = [];
  /** @type {string[]} */
  const discards = [];
  const a = P.createAnswerAssembler({ onFrame: (f) => frames.push(f), onDiscard: (_b, reason) => discards.push(reason) });
  return { a, frames, discards };
}

/**
 * Decode a received vector by its frame type.
 * @param {any} v
 */
function decodeVector(v) {
  const b = fromHex(v.hex);
  if (b.length === P.FRAME_LENGTH.SHORT) return P.parseShortAnswer(b);
  if (P.isDeviceInfoFrame(b)) return P.parseDeviceInfo(b);
  if (P.isSettingsFrame(b)) return P.parseSettings(b);
  if (P.isCellInfoFrame(b)) return P.parseCellInfo(b, v.variant);
  if (P.isFactoryFrame(b)) return P.parseFactory(b);
  throw new Error(`${v.id}: unknown frame`);
}

/** Definitions of the other families, as registered in the app. */
const others = drivers.filter((d) => d.family !== 'neey');

/**
 * The app's definitions with this family where spec 11.6 recommends it (after the JK family,
 * before ANT); the app's own list once the family is registered there.
 */
function appDrivers() {
  if (drivers.some((d) => d.id === 'neey-ble')) return drivers;
  const lastJk = others.map((x) => x.family).lastIndexOf('jk');
  return [...others.slice(0, lastJk + 1), ...neeyDrivers, ...others.slice(lastJk + 1)];
}

const own = vectors.filter((/** @type {any} */ v) => !v.expected?.foreign);
const rxFrames = own.filter((/** @type {any} */ v) => v.direction === 'rx' && !v.expected?.frameTypes);
const txFrames = own.filter((/** @type {any} */ v) => v.direction === 'tx');
const foreign = vectors.filter((/** @type {any} */ v) => v.expected?.foreign);

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

test('vectors: the file holds requests, answers and foreign frames of both variants', () => {
  assert.equal(vectors.length, 103);
  assert.equal(txFrames.length, 41);
  assert.equal(rxFrames.length + 1, 55, 'answers plus the byte stream vector');
  assert.equal(foreign.length, 7);
  const variants = new Set(own.map((/** @type {any} */ v) => v.variant));
  assert.deepEqual([...variants].sort(), ['NEEY_V1', 'NEEY_V2']);
});

test('vectors: every received frame passes the envelope and decodes to its expected values', () => {
  for (const v of rxFrames) {
    const b = fromHex(v.hex);
    assert.ok(P.isAnswerFrame(b), `${v.id}: envelope`);
    const { a, frames } = hostAssembler();
    a.push(b);
    assert.equal(frames.length, 1, `${v.id}: one frame out of the assembler`);
    assertFields(decodeVector(v), v.expected, v.id);
  }
});

test('vectors: every request decodes and equals the encoder output', () => {
  for (const v of txFrames) {
    const b = fromHex(v.hex);
    assert.ok(P.isRequestFrame(b), `${v.id}: request envelope`);
    const q = P.parseRequest(b);
    assertFields(q, v.expected, v.id);
    const again = P.encodeRequest({
      function: q.function,
      command: q.command,
      register: q.register,
      value: q.value ?? 0,
      checksum: q.checksumAlgorithm,
      swappedLength: q.lengthField === 0x1400,
    });
    assert.equal(hex(again), v.hex.toUpperCase(), `${v.id}: encoder output`);
  }
  // Named encoders produce the current (sum8) forms.
  assert.equal(hex(P.deviceInfoRequest()), vector('tx-device-info').hex);
  assert.equal(hex(P.settingsRequest()), vector('tx-settings').hex);
  assert.equal(hex(P.cellInfoRequest()), vector('tx-cell-info').hex);
  assert.equal(hex(P.factoryRequest()), vector('tx-factory-defaults').hex);
  assert.equal(hex(P.balancerSwitchRequest(true)), vector('tx-balancer-on').hex);
  assert.equal(hex(P.balancerSwitchRequest(false)), vector('tx-balancer-off').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.TRIGGER_DELTA, 0.005)), vector('tx-trigger-delta-0p005').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.MAX_CURRENT, 4)), vector('tx-max-balance-current-4p0').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.SLEEP_VOLTAGE, 3.4)), vector('tx-sleep-voltage-3p4').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.START_VOLTAGE, 3.45)), vector('tx-start-voltage-3p45').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.NOMINAL_CAPACITY, 280)), vector('tx-nominal-capacity-280').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.CELL_COUNT, 16)), vector('tx-cell-count-16').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.BUZZER_MODE, 1)), vector('tx-buzzer-mode-off').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.BATTERY_TYPE, 2)), vector('tx-battery-type-lfp').hex);
  assert.equal(hex(P.writeRequest(P.REGISTER.STOP_DELTA, 0.003)), vector('tx-balance-stop-diff-0p003').hex);
  assert.equal(hex(P.writeV2Request(P.V2_REGISTER.cellOvp, 3.65)), vector('tx-v2-cell-ovp-3p65').hex);
  assert.equal(hex(P.writeV2Request(P.V2_REGISTER.chargeOcpDelay, 5)), vector('tx-v2-charge-ocp-delay-5').hex);
  assert.equal(hex(P.writeV2Request(P.V2_REGISTER.scpDelay, 500)), vector('tx-v2-scp-delay-500').hex);
});

test('encoders: payload types, limits and the checksum forms', () => {
  assert.equal(P.registerType(P.COMMAND.WRITE, P.REGISTER.BALANCER_SWITCH), 'u32');
  assert.equal(P.registerType(P.COMMAND.WRITE, P.REGISTER.NOMINAL_CAPACITY), 'u32');
  assert.equal(P.registerType(P.COMMAND.WRITE, P.REGISTER.TRIGGER_DELTA), 'f32');
  assert.equal(P.registerType(P.COMMAND.WRITE, P.REGISTER.DEVICE_NAME), 'ascii');
  // Register 0x0D: balancer switch with 0x05, short circuit delay with 0x06 (spec 12 item 10).
  assert.equal(P.registerType(P.COMMAND.WRITE_V2, 0x0d), 'u32');
  assert.equal(P.registerType(P.COMMAND.WRITE_V2, P.V2_REGISTER.cellOvp), 'f32');
  assert.throws(() => P.writeRequest(P.REGISTER.NOMINAL_CAPACITY, 280.5), RangeError);
  assert.throws(() => P.writeRequest(P.REGISTER.NOMINAL_CAPACITY, -1), RangeError);
  assert.throws(() => P.writeRequest(P.REGISTER.TRIGGER_DELTA, NaN), RangeError);
  assert.throws(() => P.encodeRequest({ function: P.FUNCTION.WRITE, command: P.COMMAND.WRITE, register: P.REGISTER.DEVICE_NAME, value: 'eleven char' }), RangeError);
  for (const req of [P.deviceInfoRequest(), P.settingsRequest(), P.cellInfoRequest(), P.balancerSwitchRequest(true)]) {
    assert.equal(req.length, 20);
    assert.equal(req[18], sum8(req, 0, 18));
    assert.equal(req[19], 0xff);
    assert.equal(P.parseRequest(req).lengthField, 20);
  }
  const xor = P.encodeRequest({ function: P.FUNCTION.READ, command: P.COMMAND.DEVICE_INFO, checksum: 'xor8' });
  assert.equal(hex(xor), vector('tx-device-info-xor-app').hex);
  assert.equal(P.parseRequest(Uint8Array.from([...xor.subarray(0, 18), 0x00, 0xff])).checksumAlgorithm, 'invalid');
});

test('vectors: answer encoders reproduce every captured answer byte for byte', () => {
  for (const v of rxFrames) {
    const b = fromHex(v.hex);
    /** @type {Uint8Array} */
    let again;
    if (b.length === 20) {
      again = b[3] === P.FUNCTION.WRITE ? P.encodeAck(b[4], b[5], b.subarray(8, 18)) : P.encodeFactoryEcho();
    } else if (P.isDeviceInfoFrame(b)) again = P.encodeDeviceInfo(P.parseDeviceInfo(b));
    else if (P.isSettingsFrame(b)) again = b.length === 150 ? P.encodeSettingsV2(P.parseSettingsV2(b)) : P.encodeSettingsV1(P.parseSettingsV1(b));
    else if (P.isCellInfoFrame(b)) again = P.encodeCellInfo(P.parseCellInfo(b, v.variant), v.variant);
    else again = P.encodeFactory(P.parseFactory(b));
    assert.equal(hex(again), v.hex.toUpperCase(), `${v.id}: encoder round trip`);
  }
  // GW SW-1.1.0 acknowledges with zero value bytes (spec 6.7).
  assert.equal(hex(P.encodeAck(P.COMMAND.WRITE, P.REGISTER.BALANCER_SWITCH)), vector('rx-gw-sw110-ack-balancer').hex);
});

test('vectors: split notifications and a byte stream reassemble into frames', () => {
  for (const v of own.filter((/** @type {any} */ x) => x.expected?.notifications)) {
    const { a, frames } = hostAssembler();
    for (const n of v.expected.notifications) a.push(fromHex(n));
    assert.equal(frames.length, 1, v.id);
    assert.equal(hex(frames[0]), v.hex.toUpperCase());
  }
  const stream = vector('rx-ek-zh129-stream-settings-then-cell-info');
  const { a, frames } = hostAssembler();
  // 20-byte notifications, like a connection without MTU exchange.
  const bytes = fromHex(stream.hex);
  for (let i = 0; i < bytes.length; i += 20) a.push(bytes.subarray(i, i + 20));
  assert.deepEqual(
    frames.map((f) => f[4]),
    stream.expected.frameTypes,
  );
  assert.deepEqual(
    frames.map((f) => f.length),
    stream.expected.frameLengths,
  );
  assert.deepEqual(
    frames.map((f) => f[f.length - 2]),
    stream.expected.checksums,
  );
});

test('assembler: 0xFF inside data, random chunking, garbage and a lost notification', () => {
  // Byte 137 of this frame is 0xFF inside a resistance float (spec 3.5).
  const cell = bytesOf('rx-ek-zh211-cell-info');
  assert.equal(cell[137], 0xff);
  const all = rxFrames.map((/** @type {any} */ v) => fromHex(v.hex));
  const joined = concat(Uint8Array.from([0x00, 0x55, 0xaa, 0x13]), ...all.flatMap((f) => [f, Uint8Array.from([0x41, 0x54, 0x0d, 0x0a])]));
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const { a, frames } = hostAssembler();
  for (let i = 0; i < joined.length; ) {
    const n = 1 + Math.floor(rnd() * 60);
    a.push(joined.subarray(i, i + n));
    i += n;
  }
  assert.deepEqual(
    frames.map((f) => hex(f)),
    all.map((f) => hex(f)),
  );

  // A lost notification: the next frame, which starts a notification, is still found at once.
  const settings = bytesOf('rx-ek-zh211-settings');
  const lost = hostAssembler();
  lost.a.push(cell.subarray(0, 20));
  lost.a.push(cell.subarray(40, 60));
  for (let i = 0; i < settings.length; i += 20) lost.a.push(settings.subarray(i, i + 20));
  assert.equal(lost.frames.length, 1);
  assert.equal(hex(lost.frames[0]), hex(settings));
  assert.ok(lost.discards.includes('incomplete frame before a new frame start'));

  // A false start with a length outside 20..300 drops one byte only.
  const bad = hostAssembler();
  bad.a.push(concat(Uint8Array.from([0x55, 0xaa, 0x11, 0x01, 0x02, 0x00, 0xff, 0xff]), settings));
  assert.equal(bad.frames.length, 1);
});

test('vectors: foreign frames fail the NEEY envelope and never become frames', () => {
  for (const v of foreign) {
    const b = fromHex(v.hex);
    if (v.direction === 'rx') {
      assert.equal(P.isAnswerFrame(b), false, v.id);
      const { a, frames } = hostAssembler();
      for (let i = 0; i < b.length; i += 20) a.push(b.subarray(i, i + 20));
      assert.equal(frames.length, 0, `${v.id}: no frame`);
    } else {
      // Foreign requests a NEEY unit may receive on FFE1 (spec 11.3).
      const asRequest = b.length === 20 && P.isRequestFrame(b) && sum8(b, 0, 18) === b[18];
      assert.equal(asRequest, false, v.id);
      assert.equal(P.describe(b)?.name?.startsWith('NEEY write') ?? false, false, `${v.id}: never a write`);
    }
  }
});

test('vectors: no frame of any other family passes the NEEY assembler, one by one or as a stream', () => {
  const dir = new URL('./vectors/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'neey.json');
  assert.ok(['jk.json', 'jk-balancer.json', 'ant.json', 'atorch.json', 'daly.json'].every((f) => files.includes(f)));
  // Frames of the other families on the shared FFE0 / FFE1 profile and on serial ports.
  /** @type {Uint8Array[]} */
  const all = [];
  const core = ['jk.json', 'jk-balancer.json', 'ant.json', 'atorch.json', 'daly.json'];
  for (const f of files) {
    /** @type {any[]} */
    let list;
    try {
      list = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    } catch (err) {
      // Vector files of families in progress may be incomplete; the core families must parse.
      if (core.includes(f)) throw err;
      continue;
    }
    for (const v of Array.isArray(list) ? list : []) {
      if (typeof v.hex !== 'string' || !v.hex || /[^0-9a-f\s]/i.test(v.hex)) continue;
      const b = fromHex(v.hex);
      all.push(b);
      assert.equal(P.isAnswerFrame(b), false, `${f} ${v.id}`);
      const { a, frames } = hostAssembler();
      for (let i = 0; i < b.length; i += 20) a.push(b.subarray(i, i + 20));
      assert.equal(frames.length, 0, `${f} ${v.id}: no NEEY frame`);
    }
  }
  assert.ok(all.length > 700, `${all.length} foreign frames`);
  const { a, frames } = hostAssembler();
  const stream = concat(...all);
  for (let i = 0; i < stream.length; i += 20) a.push(stream.subarray(i, i + 20));
  assert.equal(frames.length, 0, 'not even across frame boundaries');
});

// ---------------------------------------------------------------------------------------------
// Parsers, snapshot and device info
// ---------------------------------------------------------------------------------------------

test('cell info: without a variant only the shared part up to offset 216 is decoded', () => {
  const b = bytesOf('rx-v2-cell-info');
  const shared = P.parseCellInfo(b);
  assert.equal(shared.cellCount, 16);
  assert.equal(shared.operationStatus, 5);
  assert.equal(shared.temperature1, undefined);
  assert.equal(shared.balanceCurrent, undefined);
  // A V1 decoder applied to a V2 frame reads the pack current as a temperature (spec 1.3).
  const wrong = P.parseCellInfo(b, P.VARIANT.V1);
  assert.notEqual(roundTo(wrong.temperature1, 1), roundTo(P.parseCellInfo(b, P.VARIANT.V2).temperature1, 1));
  const snap = neeySnapshot(shared);
  assert.equal(snap.temperatures, undefined);
  assert.equal(snap.current, undefined);
  assert.equal(snap.balanceCurrent, undefined);
  assert.equal(snap.cells?.length, 16);
  assert.equal(snap.balancingActive, true);
});

test('snapshot: NEEY_V1 cells, lead resistances in milliohm, temperatures, balancing flags', () => {
  const settings = P.parseSettings(bytesOf('rx-gw-sw110-settings-balancer-on'));
  const c = P.parseCellInfo(bytesOf('rx-gw-sw110-cell-info-balancing'), P.VARIANT.V1);
  const s = neeySnapshot(c, { settings });
  assert.equal(s.cells?.length, 16);
  assert.equal(s.cells?.[0], 3.3218);
  assert.equal(s.cellResistances?.[0], 162.97);
  assert.equal(s.voltage, 53.16);
  assert.equal(s.balanceCurrent, 2.056);
  assert.equal(s.balancingActive, true);
  // Positive current: energy into the lowest cell, index 0 reported by the frame.
  assert.deepEqual(
    s.balancing?.map((x, i) => (x ? i : -1)).filter((i) => i >= 0),
    [0],
  );
  assert.deepEqual(
    s.temperatures?.map((t) => [t.id, t.value, t.kind]),
    [
      ['t1', 26.5, 'balancer'],
      ['t2', 26.5, 'balancer'],
    ],
  );
  assert.equal(s.switches?.balance, true);
  assert.equal(s.uptime, 257597);
  assert.equal(s.current, undefined, 'a balancer has no pack current');
  assert.deepEqual(s.alarms, []);
  assert.equal(s.extra?.balancer.value, 'Balancing now');
  assert.equal(s.extra?.maxBalanceCurrent.value, 2);
  assert.equal(s.extra?.cellCount.value, 16);

  // Negative current: out of the highest cell (frame index 10).
  const neg = neeySnapshot(P.parseCellInfo(bytesOf('rx-gw-zh123-cell-info-balancing'), P.VARIANT.V1), { settings });
  assert.ok(/** @type {number} */ (neg.balanceCurrent) < 0);
  assert.equal(neg.balancing?.indexOf(true), 10);
  // Switched off: the state says so.
  const off = neeySnapshot(P.parseCellInfo(bytesOf('rx-ek-zh129-cell-info-switched-off'), P.VARIANT.V1), { settings: P.parseSettings(bytesOf('rx-ek-zh129-settings-balancer-off')) });
  assert.equal(off.extra?.balancer.value, 'Off');
  assert.equal(off.switches?.balance, false);
  assert.ok(off.balancing?.every((x) => !x));
});

test('snapshot: unused slots in the detection mask raise no alarm; real faults do', () => {
  const settings = P.parseSettings(bytesOf('rx-ek-zh211-settings'));
  const c = P.parseCellInfo(bytesOf('rx-ek-zh211-cell-info'), P.VARIANT.V1);
  assert.equal(c.cellDetectionFailedMask, 0xfe0000);
  const s = neeySnapshot(c, { settings });
  assert.deepEqual(s.alarms, [], 'bits above 16 cells are masked');
  assert.equal(s.extra?.balancer.value, 'Cells below the sleep voltage, balancing stopped');

  const faulty = P.encodeCellInfo(
    {
      ...c,
      operationStatus: P.STATUS.WIRE_RESISTANCE_HIGH,
      cellDetectionFailedMask: 0xff0004,
      cellOvervoltageMask: 0x000001,
      cellUndervoltageMask: 0x000002,
      cellPolarityErrorMask: 0x008000,
      cellWireResistanceMask: 0x000010,
      temperatureWarningMask: 0x02,
      chargingFault: true,
      dischargingFault: true,
    },
    P.VARIANT.V1,
  );
  const a = neeySnapshot(P.parseCellInfo(faulty, P.VARIANT.V1), { settings }).alarms ?? [];
  const byId = Object.fromEntries(a.map((x) => [x.id, x]));
  assert.equal(byId.cell_wire_open.source, 'cells 3');
  assert.equal(byId.cell_wire_open.severity, 'fault');
  assert.equal(byId.cell_overvoltage.severity, 'warning');
  assert.equal(byId.cell_undervoltage.source, 'cells 2');
  assert.equal(byId['neey.cell_polarity'].source, 'cells 16');
  assert.equal(byId['neey.cell_polarity'].severity, 'fault');
  assert.equal(byId.wire_resistance.source, 'status 0x03; cells 5', 'status and mask merge into one alarm');
  assert.equal(byId['neey.system_overtemperature'].source, 'sensors 2');
  assert.ok(byId['neey.charge_fault'] && byId['neey.discharge_fault']);

  for (const [status, id, severity] of /** @type {Array<[number, string, string]>} */ ([
    [P.STATUS.WRONG_CELL_COUNT, 'cell_count_mismatch', 'fault'],
    [P.STATUS.LOW_VOLTAGE, 'neey.low_voltage', 'warning'],
    [P.STATUS.OVERTEMPERATURE, 'neey.system_overtemperature', 'protection'],
    [P.STATUS.HOST_FAILS, 'communication_fault', 'fault'],
    [P.STATUS.TEMPERATURE_HIGH, 'neey.system_overtemperature', 'warning'],
  ])) {
    const f = P.parseCellInfo(P.encodeCellInfo({ ...c, operationStatus: status, cellDetectionFailedMask: 0 }, P.VARIANT.V1), P.VARIANT.V1);
    const al = neeySnapshot(f, { settings }).alarms ?? [];
    assert.deepEqual(
      al.map((x) => [x.id, x.severity]),
      [[id, severity]],
      `status ${status}`,
    );
  }
  assert.equal(balancerStateText(0x0d, true), '0x0D', 'a status without a text shows its raw code (spec 9.1)');
  assert.equal(balancerStateText(P.STATUS.BALANCING, false), 'Off');
  assert.equal(balancerStateText(P.STATUS.LOW_VOLTAGE, true), 'Low voltage', 'neutral text, pack or supply is not known');

  // NEEY_V2 is a BMS: cell voltage bits keep the catalog severity, fault bytes are protections.
  const v2settings = P.parseSettings(bytesOf('rx-v2-settings'));
  const v2cell = P.parseCellInfo(bytesOf('rx-v2-cell-info'), P.VARIANT.V2);
  const v2faulty = P.encodeCellInfo({ ...v2cell, cellOvervoltageMask: 0x000001, cellUndervoltageMask: 0x000002, chargingFault: true, dischargingFault: true }, P.VARIANT.V2);
  const v2alarms = Object.fromEntries((neeySnapshot(P.parseCellInfo(v2faulty, P.VARIANT.V2), { settings: v2settings }).alarms ?? []).map((x) => [x.id, x.severity]));
  assert.deepEqual(v2alarms, { cell_overvoltage: 'protection', cell_undervoltage: 'protection', 'neey.charge_fault': 'protection', 'neey.discharge_fault': 'protection' });
  const v1alarms = Object.fromEntries(a.map((x) => [x.id, x.severity]));
  assert.equal(v1alarms['neey.charge_fault'], 'warning', 'a NEEY_V1 balancer has no MOSFETs');
  assert.equal(v1alarms.cell_undervoltage, 'warning');
});

test('snapshot: cells wired beyond the configured count stay visible (status 0x01)', () => {
  const settings = { ...P.parseSettings(bytesOf('rx-ek-zh211-settings')), cellCount: 15 };
  const c = P.parseCellInfo(bytesOf('rx-ek-zh211-cell-info'), P.VARIANT.V1);
  assert.equal(c.cellCount, 16, '16 non-zero slots');
  const frame = P.encodeCellInfo({ ...c, operationStatus: P.STATUS.WRONG_CELL_COUNT, cellOvervoltageMask: 0x008000, cellDetectionFailedMask: 0xff8000 }, P.VARIANT.V1);
  const s = neeySnapshot(P.parseCellInfo(frame, P.VARIANT.V1), { settings });
  assert.equal(s.cells?.length, 16, 'the 16th cell is shown');
  assert.equal(s.cellResistances?.length, 16);
  assert.ok(/** @type {number} */ (s.cells?.[15]) > 3);
  const byId = Object.fromEntries((s.alarms ?? []).map((x) => [x.id, x.source]));
  assert.equal(byId.cell_count_mismatch, 'status 0x01');
  assert.equal(byId.cell_overvoltage, 'cells 16', 'masks cover the displayed cells');
  assert.equal(byId.cell_wire_open, undefined, 'the detection mask stays limited to the configured count');
  // A configured slot without a cell still shows 0 V.
  const more = neeySnapshot(c, { settings: { ...settings, cellCount: 17 } });
  assert.equal(more.cells?.length, 17);
  assert.equal(more.cells?.[16], 0);
});

test('snapshot: NEEY_V2 pack current, SOC, capacity and four temperatures', () => {
  const settings = P.parseSettings(bytesOf('rx-v2-settings'));
  const s = neeySnapshot(P.parseCellInfo(bytesOf('rx-v2-cell-info-charging'), P.VARIANT.V2), { settings });
  assert.equal(s.current, 18.03);
  assert.equal(s.soc, 83.6);
  assert.equal(s.capacityNominal, 320);
  assert.ok(Math.abs(/** @type {number} */ (s.capacityRemaining) - 267.4) < 0.5);
  assert.deepEqual(
    s.temperatures?.map((t) => t.id),
    ['t1', 't2', 'mos', 'balancer'],
  );
  assert.ok(/** @type {number} */ (s.balanceCurrent) < -7);
  assert.equal(s.extra?.maxBalanceCurrent.value, 8);
  assert.equal(s.extra?.balanceStopVoltage, undefined, 'unverified V2 labels are not shown as live values');
  assert.deepEqual(s.alarms, []);
  assert.deepEqual(
    balancingFlags([3.3, 3.2, 3.4], { active: true, current: -1, minIndex: 9, maxIndex: 9 }),
    [false, false, true],
    'an index outside the cells falls back to the voltages',
  );
});

test('device info: model, versions, identifier, alias and rating', () => {
  const gw = neeyDeviceInfo(P.parseDeviceInfo(bytesOf('rx-gw-sw110-device-info')), { variant: P.VARIANT.V1 });
  assert.equal(gw.vendor, 'NEEY');
  assert.equal(gw.model, 'GW-24S4EB');
  assert.equal(gw.hardwareVersion, 'HW-2.8.0');
  assert.equal(gw.softwareVersion, 'SW-1.1.0');
  assert.equal(gw.manufactureDate, '2021-09-15');
  assert.equal(gw.powerOnCount, 33);
  assert.equal(gw.serialNumber, undefined, 'zero identifier on SW-1.1.0');
  assert.equal(gw.protocol, 'NEEY_V1 (V1.0.0)');
  assert.equal(gw.extra?.rating.value, 4);
  assert.equal(gw.extra?.totalRuntime.value, 1129);
  const ek = neeyDeviceInfo(P.parseDeviceInfo(bytesOf('rx-ek-zh208-device-info')), { variant: P.VARIANT.V1 });
  assert.equal(ek.serialNumber, '3CA5519C110C123456');
  const v2 = neeyDeviceInfo(P.parseDeviceInfo(bytesOf('rx-v2-device-info')), { variant: P.VARIANT.V2 });
  assert.equal(v2.name, 'EK-24S200A');
  assert.equal(v2.extra?.rating.value, 8);
  assert.equal(P.balancerRating('EK-24S10EB'), 10);
  assert.equal(P.balancerRating('EK-16S2EB'), 2);
  assert.equal(P.balancerRating('neey'), 4);
  assert.equal(P.variantFromModel('EK-B24S8E200A'), P.VARIANT.V2);
  assert.equal(P.variantFromModel('EK-24S4EB'), P.VARIANT.V1);
  for (const id of ['rx-gw-sw110-device-info', 'rx-gw-zh124-device-info', 'rx-ek-zh211-device-info', 'rx-ek24s10eb-device-info', 'rx-v2-device-info']) {
    assert.equal(P.deviceInfoProblem(bytesOf(id)), null, id);
  }
  // A frame with the right header but no printable model, or with neither "HW-" nor a GW / EK
  // model, is rejected (spec 11.2).
  const d = P.parseDeviceInfo(bytesOf('rx-ek-zh211-device-info'));
  assert.match(String(P.deviceInfoProblem(P.encodeDeviceInfo({ ...d, model: '' }))), /model/);
  assert.match(String(P.deviceInfoProblem(P.encodeDeviceInfo({ ...d, model: 'XY-1000', hardwareVersion: 'V3.2' }))), /hardware/);
  // "HW-" is only an observed pattern: a known model name is enough (EK-16S2EB has no captured frame).
  assert.equal(P.deviceInfoProblem(P.encodeDeviceInfo({ ...d, model: 'EK-16S2EB', hardwareVersion: 'V3.2' })), null);
  assert.equal(P.deviceInfoProblem(P.encodeDeviceInfo({ ...d, model: 'neey', hardwareVersion: 'HW-3.2.0' })), null);
  const binary = P.encodeDeviceInfo(d);
  binary[9] = 0x07;
  binary[98] = sum8(binary, 0, 98);
  assert.match(String(P.deviceInfoProblem(binary)), /model/);
  const hwBinary = P.encodeDeviceInfo(d);
  hwBinary[25] = 0x07;
  hwBinary[98] = sum8(hwBinary, 0, 98);
  assert.match(String(P.deviceInfoProblem(hwBinary)), /hardware version not printable/);
});

// ---------------------------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------------------------

/** @param {import('@ubms/bms-core/settings').SettingsSchema} schema */
function census(schema) {
  const all = schema.groups.flatMap((g) => g.fields);
  return {
    writable: all.filter((f) => f.type !== 'action' && !f.readOnly).map((f) => f.id),
    readOnly: all.filter((f) => f.type !== 'action' && f.readOnly).map((f) => f.id),
    actions: all.filter((f) => f.type === 'action').map((f) => f.id),
    all,
  };
}

test('settings schema: NEEY_V1 census, writes confirmed by captures only', () => {
  const settings = P.parseSettings(bytesOf('rx-ek-zh211-settings'));
  const schema = buildNeeySchema({ variant: P.VARIANT.V1, settings, softwareVersion: 'ZH-2.1.1', rating: 4 });
  const c = census(schema);
  assert.deepEqual(c.writable.sort(), ['balance.max_current', 'balance.start_voltage', 'balance.trigger_delta', 'capacity.nominal', 'cell.sleep_voltage', 'switch.balance']);
  assert.deepEqual(c.readOnly.sort(), ['neey.buzzer_mode', 'neey.stop_delta', 'system.battery_type', 'system.cell_count']);
  assert.deepEqual(c.actions, [], 'no factory data action: one source names 0x03 "Factory reset" (spec 8)');
  for (const f of c.all) {
    if (f.type === 'action') continue;
    assert.ok(f.meta?.key, `${f.id}: frame key`);
    if (f.readOnly) {
      assert.ok(f.description, `${f.id}: says why it is read only`);
      assert.equal(f.meta.write, undefined, `${f.id}: no write`);
    } else {
      assert.equal(f.meta.write.command, P.COMMAND.WRITE, `${f.id}: command 0x05`);
    }
  }
  const fields = fieldMap(schema);
  assert.equal(fields.get('switch.balance')?.danger, true);
  assert.equal(fields.get('balance.max_current')?.max, 4);
  assert.equal(fields.get('cell.sleep_voltage')?.group, 'balancing');
  assert.equal(fields.get('capacity.nominal')?.step, 1);
  assert.deepEqual(
    fields.get('neey.buzzer_mode')?.options?.map((o) => o.value),
    BUZZER_MODES.map((o) => o.value),
  );
  assert.deepEqual(
    fields.get('system.battery_type')?.options?.map((o) => o.value),
    BATTERY_TYPES.map((o) => o.value),
  );
  const values = decodeNeeySettings(schema, settings);
  assert.deepEqual(values, {
    'switch.balance': true,
    'balance.trigger_delta': 0.005,
    'balance.max_current': 4,
    'cell.sleep_voltage': 3.4,
    'balance.start_voltage': 3.45,
    'capacity.nominal': 314,
    'system.cell_count': 16,
    'neey.stop_delta': 0.003,
    'neey.buzzer_mode': 1,
    'system.battery_type': 2,
  });
  // Every read only value passes nothing to the device.
  assert.ok(validateValue(/** @type {any} */ (fields.get('system.cell_count')), 16));

  // GW SW-1.1.0 has no start voltage (reads 0) and older firmware no stop difference.
  const gw = census(buildNeeySchema({ variant: P.VARIANT.V1, settings: P.parseSettings(bytesOf('rx-gw-sw110-settings-balancer-on')), softwareVersion: 'SW-1.1.0', rating: 4 }));
  assert.ok(!gw.writable.includes('balance.start_voltage'));
  assert.ok(!gw.readOnly.includes('neey.stop_delta'));
  const zh123 = census(buildNeeySchema({ variant: P.VARIANT.V1, settings: P.parseSettings(bytesOf('rx-gw-zh123-settings-balancer-on')), softwareVersion: 'ZH-1.2.3', rating: 4 }));
  assert.ok(zh123.writable.includes('balance.start_voltage'));
  // The rating limits the current; a held value above it stays valid (EK-16S2EB).
  const ek10 = fieldMap(buildNeeySchema({ variant: P.VARIANT.V1, settings: P.parseSettings(bytesOf('rx-ek24s10eb-settings')), rating: 10 }));
  assert.equal(ek10.get('balance.max_current')?.max, 10);
  const held = fieldMap(buildNeeySchema({ variant: P.VARIANT.V1, settings: { ...settings, maxBalanceCurrent: 2.5 }, rating: 2 }));
  assert.equal(held.get('balance.max_current')?.max, 2.5);
});

test('settings schema: NEEY_V2 writes only the balancer switch', () => {
  const settings = P.parseSettings(bytesOf('rx-v2-settings'));
  const schema = buildNeeySchema({ variant: P.VARIANT.V2, settings, rating: 8 });
  const c = census(schema);
  assert.deepEqual(c.writable, ['switch.balance']);
  assert.equal(c.readOnly.length, 33);
  assert.deepEqual(c.actions, []);
  for (const f of c.all) if (f.readOnly) assert.ok(f.description, `${f.id}: says why`);
  const fields = fieldMap(schema);
  // Offsets 22 and 26 are not shown under the canonical sleep and start ids: their order is the
  // opposite of every V1 frame (spec 6.3).
  assert.equal(fields.has('cell.sleep_voltage'), false);
  assert.equal(fields.has('balance.start_voltage'), false);
  assert.match(String(fields.get('neey.v2_voltage_22')?.label), /offset 22/);
  assert.match(String(fields.get('neey.v2_voltage_26')?.description), /swapped/);
  assert.equal(fields.get('neey.v2_voltage_22')?.unit, 'V');
  assert.doesNotMatch(String(fields.get('system.cell_count')?.description), /150 byte/, 'the cell count register is unverified on both layouts');
  assert.match(String(fields.get('system.cell_count')?.description), /command table/);
  // Command 0x06 is documented in meta, never used for a write.
  assert.deepEqual(fields.get('scp.delay')?.meta.unverifiedWrite, { command: P.COMMAND.WRITE_V2, register: 0x0d, type: 'u32' });
  assert.equal(fields.get('switch.balance')?.meta.write.register, 0x0d);
  assert.equal(fields.get('switch.balance')?.meta.write.command, P.COMMAND.WRITE);
  const values = decodeNeeySettings(schema, settings);
  assert.equal(values['switch.balance'], true);
  assert.equal(values['cell.ovp'], 3.65);
  assert.equal(values['discharge.ocp2_delay'], 1000);
  assert.equal(values['scp.delay'], 500);
  assert.equal(values['charge.utp'], -2);
  assert.equal(values['capacity.nominal'], 320);
  assert.equal(values['neey.v2_voltage_22'], 3.4);
  assert.equal(values['neey.v2_voltage_26'], 3.38);
  assert.equal(values['neey.cell_diff_recovery'], 0.7);
  assert.equal(Object.keys(values).length, 34);
  assert.equal(decodeNeeySettings(schema, P.parseSettings(bytesOf('rx-v2-settings-balancer-off')))['switch.balance'], false);
});

test('settings: write encoding equals the captured requests, read only values never encode', () => {
  const schema = buildNeeySchema({ variant: P.VARIANT.V1, settings: P.parseSettings(bytesOf('rx-ek-zh211-settings')), softwareVersion: 'ZH-2.1.1' });
  const f = fieldMap(schema);
  /** @param {string} id */
  const get = (id) => /** @type {import('@ubms/bms-core/settings').SettingField} */ (f.get(id));
  assert.equal(hex(encodeSettingWrite(get('switch.balance'), true)), vector('tx-balancer-on').hex);
  assert.equal(hex(encodeSettingWrite(get('switch.balance'), false)), vector('tx-balancer-off').hex);
  assert.equal(hex(encodeSettingWrite(get('balance.trigger_delta'), 0.005)), vector('tx-trigger-delta-0p005').hex);
  assert.equal(hex(encodeSettingWrite(get('balance.max_current'), 4)), vector('tx-max-balance-current-4p0').hex);
  assert.equal(hex(encodeSettingWrite(get('cell.sleep_voltage'), 3.4)), vector('tx-sleep-voltage-3p4').hex);
  assert.equal(hex(encodeSettingWrite(get('balance.start_voltage'), 3.45)), vector('tx-start-voltage-3p45').hex);
  assert.equal(hex(encodeSettingWrite(get('capacity.nominal'), 280)), vector('tx-nominal-capacity-280').hex);
  for (const id of ['system.cell_count', 'neey.stop_delta', 'neey.buzzer_mode', 'system.battery_type']) {
    assert.throws(() => encodeSettingWrite(get(id), 1), /read only/, id);
  }
  const v2 = fieldMap(buildNeeySchema({ variant: P.VARIANT.V2 }));
  assert.throws(() => encodeSettingWrite(/** @type {any} */ (v2.get('cell.ovp')), 3.6), /read only/);
  assert.throws(() => encodeSettingWrite(/** @type {any} */ (v2.get('balance.trigger_delta')), 0.005), /read only/);
  assert.equal(hex(encodeSettingWrite(/** @type {any} */ (v2.get('switch.balance')), false)), vector('tx-balancer-off').hex);

  // The xor8 fallback (spec 3.4, 11.2) sends exactly the requests the old app sent to SW-1.1.0.
  const xor = { checksum: /** @type {const} */ ('xor8') };
  assert.equal(hex(encodeSettingWrite(get('switch.balance'), true, xor)), vector('tx-balancer-on-xor-app').hex);
  assert.equal(hex(encodeSettingWrite(get('balance.trigger_delta'), 0.004, xor)), vector('tx-trigger-delta-0p004-xor-app').hex);
  assert.equal(hex(encodeSettingWrite(get('balance.max_current'), 2, xor)), vector('tx-max-balance-current-2p0-xor-app').hex);
  assert.equal(hex(encodeSettingWrite(get('cell.sleep_voltage'), 2.3, xor)), vector('tx-sleep-voltage-2p3-xor-app').hex);
  assert.equal(hex(encodeSettingWrite(get('balance.start_voltage'), 2.5, xor)), vector('tx-start-voltage-2p5-xor-app').hex);
  assert.equal(hex(encodeSettingWrite(get('capacity.nominal'), 300, xor)), vector('tx-nominal-capacity-300-xor-app').hex);
  assert.equal(hex(P.deviceInfoRequest('xor8')), vector('tx-device-info-xor-app').hex);
  assert.equal(hex(P.settingsRequest('xor8')), vector('tx-settings-xor-app').hex);
  assert.equal(hex(P.cellInfoRequest('xor8')), vector('tx-cell-info-xor-app-swapped-length').hex);

  // Vendor recommendations as warnings (spec 7.2): trigger and 0.1 C.
  const warnings = warnAll(schema, { 'balance.trigger_delta': 0.003, 'capacity.nominal': 280, 'balance.max_current': 4 });
  assert.ok(warnings['balance.trigger_delta']);
  assert.equal(warnings['balance.max_current'], undefined);
  const small = warnAll(schema, { 'balance.trigger_delta': 0.008, 'capacity.nominal': 30, 'balance.max_current': 4 });
  assert.ok(small['balance.trigger_delta']);
  assert.ok(small['balance.max_current']);
  // Cross-field hints (spec 7.2): trigger at or below the stop difference, start not above sleep.
  const stored = decodeNeeySettings(schema, P.parseSettings(bytesOf('rx-ek-zh211-settings')));
  assert.deepEqual(warnAll(schema, stored), {}, 'a captured settings frame raises no warning');
  const crossed = warnAll(schema, { ...stored, 'balance.trigger_delta': 0.003, 'cell.sleep_voltage': 3.5 });
  assert.match(String(crossed['balance.trigger_delta']), /stop voltage difference/);
  assert.match(String(crossed['balance.start_voltage']), /above the sleep voltage/);
  assert.equal(warnAll(schema, { ...stored, 'neey.stop_delta': 0, 'balance.trigger_delta': 0.005 })['balance.trigger_delta'], undefined, 'older firmware has no stop difference');
  for (const id of ['rx-gw-zh123-settings-balancer-on', 'rx-gw-zh124-settings', 'rx-ek-zh208-settings', 'rx-ek24s10eb-settings']) {
    const s = P.parseSettings(bytesOf(id));
    const sc = buildNeeySchema({ variant: P.VARIANT.V1, settings: s, rating: 10 });
    assert.equal(warnAll(sc, decodeNeeySettings(sc, s))['balance.start_voltage'], undefined, id);
  }
});

// ---------------------------------------------------------------------------------------------
// Definition and registration
// ---------------------------------------------------------------------------------------------

test('definition: NEEY balancer on FFE0 / FFE1, names, filters and demo', () => {
  assert.deepEqual(
    neeyDrivers.map((d) => d.id),
    ['neey-ble'],
  );
  const d = neeyBleDefinition;
  assert.equal(d.family, 'neey');
  assert.equal(d.vendor, 'NEEY');
  assert.equal(d.deviceType, 'balancer');
  assert.equal(d.experimental, true);
  assert.equal(d.protocol, 'NEEY balancer (Bluetooth)');
  assert.equal(d.links.serial, undefined, 'no wired port (spec 2.2)');
  assert.deepEqual(d.links.ble?.profiles, [{ id: 'neey-ffe0', label: 'FFE0/FFE1', service: 0xffe0, notify: 0xffe1, write: 0xffe1, writeMode: 'without-response', chunkSize: 20 }]);
  assert.deepEqual(d.links.ble?.namePrefixes, ['GW-', 'EK-']);
  assert.deepEqual([...NAME_PREFIXES], ['GW-', 'EK-']);
  assert.deepEqual(d.links.ble?.advertisedServices, [0xffe0]);
  for (const name of ['GW-24S4EB', 'EK-24S4EB', 'EK-16S2EB', 'EK-24S10EB', 'EK-24S20EB', 'EK-24S200A', 'EK-B24S8E200A']) assert.ok(NAME_PATTERN.test(name), name);
  for (const name of ['GW-24Srenamed1', 'neey', 'Backup BMS', 'JK-B2A24S', 'ANT-BLE16ZMUB', 'DL24-BLE']) assert.equal(NAME_PATTERN.test(name), false, name);
  assert.match(d.demo?.name ?? '', /\(demo\)$/);
  const reg = new DriverRegistry(neeyDrivers);
  const { request, filterable } = reg.bleRequest({ selection: 'neey-ble' });
  assert.equal(filterable, true);
  assert.deepEqual(request.filters, [{ namePrefix: 'GW-' }, { namePrefix: 'EK-' }, { services: [0xffe0] }]);
  assert.deepEqual(request.optionalServices, ['0000ffe0-0000-1000-8000-00805f9b34fb']);
});

test('registration: a temporary registry with the existing drivers keeps working (spec 11.6)', () => {
  // Recommended place: after the JK family, before ANT.
  const combined = appDrivers();
  const registry = new DriverRegistry(combined);
  assert.equal(registry.list().length, others.length + 1);
  assert.equal(combined.find((x) => x.demo)?.id, 'jk-ble', 'the default demo of the app stays the JK BMS');
  assert.ok(registry.families().some((f) => f.id === 'neey' && f.vendor === 'NEEY'));
  const ffe0 = ['0000ffe0-0000-1000-8000-00805f9b34fb'];
  const order = registry.bleCandidates({ name: 'Backup BMS', services: ffe0 }).map((c) => c.definition.id);
  const n = order.indexOf('neey-ble');
  assert.ok(n > 0, 'NEEY is a candidate for an unnamed FFE0 device');
  assert.ok(order.slice(0, n).every((id) => id.startsWith('jk')), `only JK probes before NEEY: ${order.join(', ')}`);
  assert.ok(order.indexOf('ant') > n);
  assert.equal(order.at(-1), 'atorch');
  // Default names rank NEEY first; other families keep their own names.
  for (const name of ['GW-24S4EB', 'EK-24S4EB', 'EK-24S200A', 'GW-24Srenamed1']) {
    assert.equal(registry.bleCandidates({ name, services: ffe0 })[0].definition.id, 'neey-ble', name);
  }
  assert.ok(registry.bleCandidates({ name: 'JK-B2A24S15P', services: ffe0 })[0].definition.id.startsWith('jk'));
  assert.equal(registry.bleCandidates({ name: 'ANT-BLE16ZMUB', services: ffe0 })[0].definition.id, 'ant');
  assert.equal(registry.bleCandidates({ name: 'DL24-BLE', services: ffe0 })[0].definition.id, 'atorch');
  const auto = registry.bleRequest({ selection: 'auto' }).request;
  assert.ok(auto.filters?.some((f) => f.namePrefix === 'EK-'));
  assert.ok(auto.filters?.some((f) => f.namePrefix === 'GW-'));
  assert.deepEqual(
    registry.select('family:neey').map((x) => x.id),
    ['neey-ble'],
  );
  assert.deepEqual(registry.serialCandidates({ selection: 'family:neey' }), []);
});

test('driver contract: BaseDriver subclass, capabilities, schema and no browser APIs', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, name: 'silent' });
  await host.open();
  await device.open();
  const driver = neeyBleDefinition.create({ link: host, log, profileId: 'neey-ffe0', options: {} });
  try {
    assert.ok(driver instanceof BaseDriver);
    assert.ok(driver instanceof NeeyBleDriver);
    assert.deepEqual(driver.capabilities, { settings: true, writeSettings: true, streaming: true, pollIntervalMs: 1000, minPollIntervalMs: 500 });
    const schema = driver.getSettingsSchema();
    assert.ok(schema.groups.length > 0);
    for (const m of ['probe', 'start', 'poll', 'stop', 'readInfo', 'readSettings', 'writeSetting', 'runAction', 'dispose']) {
      assert.equal(typeof (/** @type {any} */ (driver)[m]), 'function', m);
    }
    await assert.rejects(driver.writeSetting('nope', 1), /Unknown setting/);
    await assert.rejects(driver.writeSetting('system.cell_count', 16), /read only/);
    // No actions: the factory request 0x03 is never offered (spec 8).
    await assert.rejects(driver.runAction('neey.read_factory_data'), /not supported/);
    assert.equal(
      schema.groups.flatMap((g) => g.fields).filter((f) => f.type === 'action').length,
      0,
    );
  } finally {
    driver.dispose();
    await host.close();
    await device.close();
  }
  // Drivers never touch browser APIs, and no file of this family contains the em dash.
  const dir = new URL('../src/neey/', import.meta.url);
  const files = [...readdirSync(dir).map((f) => new URL(f, dir)), new URL('../test/neey.test.js', import.meta.url), new URL('../../../docs/protocols/neey.md', import.meta.url), new URL('./vectors/neey.json', import.meta.url)];
  const dash = String.fromCharCode(0x2014);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(text.includes(dash), false, `${f.pathname}: em dash`);
    if (f.pathname.includes('/src/neey/')) assert.doesNotMatch(text, /\b(navigator|window|document|localStorage)\./, f.pathname);
  }
});

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/**
 * Driver on one end of a link pair, the given device attached on the other end.
 * @param {(device: import('@ubms/transport').MemoryLink) => any} attach
 * @param {{ name?: string }} [opts]
 */
async function probeSetup(attach, { name = 'device' } = {}) {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, name, deviceChunkSize: 20 });
  await host.open();
  await device.open();
  /** @type {Uint8Array[]} */
  const written = [];
  device.on('data', (/** @type {Uint8Array} */ c) => written.push(c));
  const sim = attach(device);
  const driver = /** @type {NeeyBleDriver} */ (neeyBleDefinition.create({ link: host, log, profileId: 'neey-ffe0', options: {} }));
  const close = async () => {
    driver.dispose();
    sim?.stop?.();
    await host.close();
    await device.close();
  };
  return { log, host, device, sim, driver, written, close };
}

test('detection: accepts NEEY_V1 (EK and GW firmware) and NEEY_V2, decides the variant from the settings length', async () => {
  for (const [opts, variant, model] of /** @type {Array<[any, string, string]>} */ ([
    [{}, 'NEEY_V1', 'EK-24S4EB'],
    [{ firmware: 'gw' }, 'NEEY_V1', 'GW-24S4EB'],
    [{ variant: 'NEEY_V2' }, 'NEEY_V2', 'EK-B24S8E200A'],
  ])) {
    const s = await probeSetup((d) => createNeeySimulator(d, { stepMs: 0, ...opts }));
    try {
      const res = await s.driver.probe({ timeout: 2500 });
      assert.ok(res, `${model}: detected`);
      assert.equal(res.variant, variant);
      assert.equal(res.confidence, 1);
      assert.equal(res.info?.model, model);
      assert.equal(s.driver.variantConfirmed, true);
      // Only read requests: device info, then settings.
      assert.deepEqual(
        s.sim.received.map((/** @type {any} */ q) => [q.function, q.command]),
        [
          [1, 1],
          [1, 4],
        ],
      );
    } finally {
      await s.close();
    }
  }
});

test('detection: a GW SW-1.1.0 that answers only the xor8 form of the old app is found by the fallback', async () => {
  const s = await probeSetup((d) => createNeeySimulator(d, { stepMs: 0, firmware: 'gw', checksums: ['xor8'] }));
  try {
    const res = await s.driver.probe({ timeout: 1000 });
    assert.ok(res, 'detected');
    assert.equal(res.variant, 'NEEY_V1');
    assert.equal(res.confidence, 1);
    assert.equal(res.info?.softwareVersion, 'SW-1.1.0');
    assert.equal(s.driver.checksum, 'xor8');
    // Two sum8 device info requests were dropped, then the captured xor8 requests were answered.
    assert.deepEqual(
      s.sim.ignored.map((f) => hex(f)),
      [vector('tx-device-info').hex, vector('tx-device-info').hex],
    );
    assert.deepEqual(
      s.sim.received.map((/** @type {any} */ q) => [q.function, q.command, q.checksumAlgorithm]),
      [
        [1, 1, 'xor8'],
        [1, 4, 'xor8'],
      ],
    );
  } finally {
    await s.close();
  }
  // EK firmware never sees the xor8 form: sum8 is answered first.
  const ek = await probeSetup((d) => createNeeySimulator(d, { stepMs: 0 }));
  try {
    assert.ok(await ek.driver.probe({ timeout: 1000 }));
    assert.equal(ek.driver.checksum, 'sum8');
    assert.equal(ek.sim.ignored.length, 0);
  } finally {
    await ek.close();
  }
});

test('detection: a streaming balancer counts as evidence; a silent device is given up after one retry', async () => {
  const s = await probeSetup((d) => createNeeySimulator(d, { stepMs: 0, streaming: true, intervalMs: 100 }));
  try {
    const res = await s.driver.probe({ timeout: 2500 });
    assert.ok(res);
    assert.ok(s.log.entries().some((/** @type {any} */ e) => /streaming already/.test(e.text ?? '')));
  } finally {
    await s.close();
  }
  const silent = await probeSetup(() => null);
  const started = Date.now();
  try {
    assert.equal(await silent.driver.probe({ timeout: 1000 }), null);
    assert.ok(Date.now() - started >= 300 + 3 * 600 - 50, 'listen plus two sum8 attempts and one xor8 attempt');
    assert.deepEqual(
      silent.written.map((c) => hex(c)),
      [vector('tx-device-info').hex, vector('tx-device-info').hex, vector('tx-device-info-xor-app').hex],
      'only the device info request: twice, then once in the xor8 form',
    );
  } finally {
    await silent.close();
  }
});

test('detection: foreign devices on FFE0 are rejected by the envelope, without a write', async () => {
  // Real simulators of the other families, from their definitions.
  const ffe0Demos = others.filter((d) => d.demo && d.links.ble?.profiles.some((p) => p.service === 0xffe0)).map((d) => d.id);
  for (const id of ['jk-ble', 'ant', 'atorch']) assert.ok(ffe0Demos.includes(id), `${id} simulator exercised`);
  for (const id of ffe0Demos) {
    const def = /** @type {any} */ (others.find((d) => d.id === id));
    const s = await probeSetup((d) => def.demo.create(d));
    try {
      assert.equal(await s.driver.probe({ timeout: 800 }), null, `${id} is not a NEEY`);
      const sent = concat(...s.written);
      for (let i = 0; i < sent.length; i += 20) {
        const q = P.parseRequest(sent.subarray(i, i + 20));
        assert.equal(q.function, P.FUNCTION.READ, `${id}: read requests only`);
      }
    } finally {
      await s.close();
    }
  }
  // A device that answers with a valid envelope but neither a "HW-" hardware version nor a GW / EK
  // model is not taken.
  const d = P.parseDeviceInfo(bytesOf('rx-ek-zh211-device-info'));
  const fake = await probeSetup((dev) => {
    const off = dev.on('data', () => void dev.write(P.encodeDeviceInfo({ ...d, model: 'XY-1000', hardwareVersion: 'XX' })));
    return { stop: off };
  });
  try {
    assert.equal(await fake.driver.probe({ timeout: 1000 }), null);
  } finally {
    await fake.close();
  }
});

test('detection: without a settings answer the variant is provisional, cells are decoded up to 216, nothing is written', async () => {
  const info = P.parseDeviceInfo(bytesOf('rx-v2-device-info'));
  const cell = bytesOf('rx-v2-cell-info');
  const s = await probeSetup((dev) => {
    const req = P.createRequestAssembler({
      onFrame: (f) => {
        // Answers the device info request only; settings requests stay unanswered.
        if (f[3] === P.FUNCTION.READ && f[4] === P.COMMAND.DEVICE_INFO) void dev.write(P.encodeDeviceInfo(info));
      },
    });
    const off = dev.on('data', (/** @type {Uint8Array} */ c) => req.push(c));
    return { stop: off };
  });
  try {
    const res = await s.driver.probe({ timeout: 1000 });
    assert.ok(res);
    assert.equal(res.variant, 'NEEY_V2', 'the model "EK-B..." is the hint');
    assert.equal(res.confidence, 0.9);
    assert.equal(s.driver.variantConfirmed, false);
    /** @type {any[]} */
    const snaps = [];
    s.driver.on('snapshot', (/** @type {any} */ x) => snaps.push(x));
    await s.driver.start();
    await s.device.write(cell);
    const snap = await until(() => snaps[0]);
    assert.equal(snap.cells.length, 16);
    assert.equal(snap.temperatures, undefined, 'no decode beyond offset 216');
    assert.equal(snap.current, undefined);
    await assert.rejects(s.driver.writeSetting('switch.balance', false), /variant is unknown/);
    const sent = concat(...s.written);
    for (let i = 0; i < sent.length; i += 20) assert.equal(sent[i + 3], P.FUNCTION.READ, 'read requests only');
  } finally {
    await s.close();
  }
});

test('detection: the simulator ignores foreign probes and malformed requests (spec 3.4, 11.3)', async () => {
  const s = await probeSetup((d) => createNeeySimulator(d, { stepMs: 0 }));
  /** @type {Uint8Array[]} */
  const answers = [];
  s.host.on('data', (/** @type {Uint8Array} */ c) => answers.push(c));
  try {
    for (const id of ['foreign-jk-request-device-info', 'foreign-ant-request-status', 'foreign-ant-legacy-request-status', 'tx-device-info-xor-app', 'tx-cell-info-xor-app-swapped-length']) {
      await s.host.write(bytesOf(id));
    }
    await wait(200);
    assert.equal(answers.length, 0, 'EK firmware answers none of them');
    assert.equal(s.sim.received.length, 0);
    assert.equal(s.sim.ignored.length, 2, 'the two old app requests reached the simulator and were dropped');
  } finally {
    await s.close();
  }
  // GW firmware answers the old app's xor8 form (spec 3.4).
  const gw = await probeSetup((d) => createNeeySimulator(d, { stepMs: 0, firmware: 'gw' }));
  const got = hostAssembler();
  gw.host.on('data', (/** @type {Uint8Array} */ c) => got.a.push(c));
  try {
    await gw.host.write(bytesOf('tx-device-info-xor-app'));
    await until(() => got.frames.length);
    assert.equal(P.parseDeviceInfo(got.frames[0]).model, 'GW-24S4EB');
  } finally {
    await gw.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * Session with the simulator behind a direct link.
 * @param {Parameters<typeof createNeeySimulator>[1]} simOpts
 * @param {{ registry?: DriverRegistry, probeTimeoutMs?: number }} [opts]
 */
async function startSession(simOpts, { registry = new DriverRegistry(neeyDrivers), probeTimeoutMs = 2500 } = {}) {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry, log, pollIntervalMs: 200, probeTimeoutMs });
  const { host, device } = createLinkPair({ log, name: 'EK-24S4EB', deviceChunkSize: 20 });
  await device.open();
  const sim = createNeeySimulator(device, { stepMs: 100, intervalMs: 150, ...simOpts });
  const close = async () => {
    await session.disconnect();
    sim.stop();
    await device.close();
  };
  return { log, session, host, device, sim, close };
}

/** @param {any} sim @param {number} command */
const requests = (sim, command) => sim.received.filter((/** @type {any} */ q) => q.function === P.FUNCTION.READ && q.command === command).length;

test('session: NEEY_V1 end to end (detection, stream, settings from the cache, verified writes)', async () => {
  const s = await startSession({});
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    assert.equal(session.state, 'connected');
    assert.equal(session.variant, 'NEEY_V1');
    const snap = await until(() => session.snapshot?.temperatures && session.snapshot);
    assert.equal(snap.cells.length, 16);
    assert.equal(snap.cellResistances.length, 16);
    assert.ok(snap.voltage > 40);
    assert.equal(snap.switches.balance, true);
    assert.deepEqual(snap.alarms, [], 'unused detection bits are masked');
    assert.equal(session.info?.model, 'EK-24S4EB');
    assert.equal(session.info?.vendor, 'NEEY');

    // The probe's settings frame serves the first settings screen: no second request (no beep).
    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.equal(settings.values?.['balance.trigger_delta'], 0.005);
    assert.equal(settings.values?.['neey.stop_delta'], 0.003);
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 1);

    const results = await session.writeSettings([
      { id: 'balance.trigger_delta', value: 0.008 },
      { id: 'balance.max_current', value: 3.5 },
      { id: 'cell.sleep_voltage', value: 3.1 },
      { id: 'balance.start_voltage', value: 3.25 },
      { id: 'capacity.nominal', value: 300 },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [
        ['balance.trigger_delta', true, true],
        ['balance.max_current', true, true],
        ['cell.sleep_voltage', true, true],
        ['balance.start_voltage', true, true],
        ['capacity.nominal', true, true],
      ],
    );
    assert.equal(sim.settings.nominalCapacity, 300);
    // EK firmware pushes the settings after every write: still the probe's request only.
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 1);
    const writes = sim.received.filter((/** @type {any} */ q) => q.function === P.FUNCTION.WRITE);
    assert.deepEqual(
      writes.map((/** @type {any} */ q) => [q.command, q.register, q.checksumAlgorithm]),
      [
        [5, 0x02, 'sum8'],
        [5, 0x03, 'sum8'],
        [5, 0x04, 'sum8'],
        [5, 0x17, 'sum8'],
        [5, 0x16, 'sum8'],
      ],
    );

    // Out of range for the device: acknowledged but not applied, the read-back says so.
    const [above] = await session.writeSettings([{ id: 'balance.max_current', value: 5 }]);
    assert.equal(above.ok, false, 'the schema limits the current to the 4 A rating');
    const [cap] = await session.writeSettings([{ id: 'system.cell_count', value: 15 }]);
    assert.equal(cap.ok, false);
    assert.match(String(cap.error), /read only/);

    // Switch off: verified, the stream shows the state.
    const [sw] = await session.writeSettings([{ id: 'switch.balance', value: false }]);
    assert.equal(sw.verified, true);
    await until(() => session.snapshot?.extra?.balancer.value === 'Off');
    assert.equal(session.snapshot?.balancingActive, false);
  } finally {
    await s.close();
  }
});

test('session: GW SW-1.1.0 pushes no settings after a write, the driver requests them', async () => {
  const s = await startSession({ firmware: 'gw' });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    assert.equal(session.info?.softwareVersion, 'SW-1.1.0');
    const settings = await session.loadSettings();
    assert.equal(settings.values?.['balance.start_voltage'], undefined, 'no start voltage on SW-1.1.0');
    assert.equal(fieldMap(settings.schema).has('balance.start_voltage'), false);
    const [r] = await session.writeSettings([{ id: 'balance.trigger_delta', value: 0.004 }]);
    assert.equal(r.verified, true);
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 2, 'one request after the write');
  } finally {
    await s.close();
  }
});

test('session: NEEY_V2 shows pack values and writes only the balancer switch', async () => {
  const s = await startSession({ variant: 'NEEY_V2' });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    assert.equal(session.variant, 'NEEY_V2');
    const snap = await until(() => session.snapshot?.temperatures && session.snapshot);
    assert.equal(snap.temperatures.length, 4);
    assert.ok(Number.isFinite(snap.current));
    assert.ok(Number.isFinite(snap.soc));
    assert.equal(snap.capacityNominal, 320);
    assert.equal(session.info?.name, 'EK-24S200A');
    const settings = await session.loadSettings();
    assert.equal(settings.values?.['cell.ovp'], 3.65);
    const results = await session.writeSettings([
      { id: 'switch.balance', value: false },
      { id: 'cell.ovp', value: 3.6 },
      { id: 'balance.trigger_delta', value: 0.005 },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [
        ['switch.balance', true, true],
        ['cell.ovp', false, undefined],
        ['balance.trigger_delta', false, undefined],
      ],
    );
    assert.equal(sim.settings.balancerSwitch, false);
    assert.ok(sim.received.every((/** @type {any} */ q) => q.command !== P.COMMAND.WRITE_V2), 'command 0x06 is never sent');
    // The settings frame pushed 0.43 s after the doubled acknowledgement ([HA#670]) serves the
    // read-back: no settings request, so no beep (spec 4.3).
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 1, 'only the probe requested settings');
  } finally {
    await s.close();
  }
});

test('session: a settings frame pushed late (radio jitter) still serves the read-back without a request', async () => {
  // [HA#670]: pushes 0.39 s and 0.43 s after the acknowledgement; 0.75 s models a slow radio.
  const s = await startSession({ settingsPushDelayMs: 750 });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    const [r] = await session.writeSettings([{ id: 'capacity.nominal', value: 300 }]);
    assert.equal(r.verified, true);
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 1, 'no extra request, so no extra beep');
    assert.equal(sim.state.settingsFrames, 2, 'one pushed frame, no second one');
  } finally {
    await s.close();
  }
});

test('session: a write whose settings frame never comes reports a read-back error, not the old value', async () => {
  // GW SW-1.1.0 pushes nothing after a write; this unit also leaves the settings requests after
  // the write unanswered.
  const s = await startSession({ firmware: 'gw' });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    const before = await session.loadSettings();
    assert.equal(before.values?.['balance.trigger_delta'], 0.005);
    sim.mute.add(P.COMMAND.SETTINGS);
    const [r] = await session.writeSettings([{ id: 'balance.trigger_delta', value: 0.008 }]);
    assert.equal(r.ok, true, 'the write was acknowledged');
    assert.equal(r.verified, undefined, 'nothing to compare against');
    assert.equal(r.actual, undefined, 'never the value from before the write');
    assert.ok(r.readBackError, 'the read-back failed');
    assert.ok(Math.abs(sim.settings.balanceTriggerVoltage - 0.008) < 1e-6, 'the unit applied it');
    assert.ok(requests(sim, P.COMMAND.SETTINGS) >= 3, 'probe, after the write, and the read-back');
  } finally {
    await s.close();
  }
});

test('session: a GW SW-1.1.0 that answers only xor8 is read and written with the captured xor8 requests', async () => {
  const s = await startSession({ firmware: 'gw', checksums: ['xor8'] }, { probeTimeoutMs: 1000 });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    assert.equal(session.variant, 'NEEY_V1');
    const snap = await until(() => session.snapshot?.temperatures && session.snapshot);
    assert.equal(snap.cells.length, 16);
    const [r] = await session.writeSettings([{ id: 'switch.balance', value: false }]);
    assert.equal(r.verified, true);
    assert.equal(sim.settings.balancerSwitch, false);
    assert.ok(sim.received.length >= 4);
    assert.ok(
      sim.received.every((/** @type {any} */ q) => q.checksumAlgorithm === 'xor8'),
      'every answered request used xor8',
    );
    assert.ok(sim.ignored.every((f) => hex(f) === vector('tx-device-info').hex), 'only the two sum8 probe requests were dropped');
  } finally {
    await s.close();
  }
});

test('session: a stall that the cell info request ends needs no settings request', async () => {
  const s = await startSession({ cellRequestStartsStream: true });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    await until(() => session.snapshot?.temperatures);
    sim.setStreaming(false);
    const before = requests(sim, P.COMMAND.CELL_INFO);
    await until(() => requests(sim, P.COMMAND.CELL_INFO) > before, 6000);
    await until(() => sim.state.cellFrames > 3 && sim.state.streaming);
    const frames = sim.state.cellFrames;
    await until(() => sim.state.cellFrames >= frames + 3, 3000);
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 1, 'settings are not requested while the stream runs');
    assert.equal(requests(sim, P.COMMAND.DEVICE_INFO), 1);
  } finally {
    await s.close();
  }
});

test('session: when cell info requests bring single frames only, one settings request restarts the stream', async () => {
  // Default simulator: a stopped stream answers 0x02 with one frame and stays stopped.
  const s = await startSession({});
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'neey-ble' });
    await until(() => session.snapshot?.temperatures);
    sim.setStreaming(false);
    const cellRequests = requests(sim, P.COMMAND.CELL_INFO);
    await until(() => requests(sim, P.COMMAND.SETTINGS) === 2, 15000);
    assert.equal(requests(sim, P.COMMAND.CELL_INFO) - cellRequests, 2, 'two cell info requests with one frame each came first');
    await until(() => sim.state.streaming);
    const frames = sim.state.cellFrames;
    await until(() => sim.state.cellFrames >= frames + 4, 3000);
    assert.equal(session.state, 'connected');
    // Once per stall: the stream runs again, nothing more is requested.
    await wait(600);
    assert.equal(requests(sim, P.COMMAND.SETTINGS), 2);
  } finally {
    await s.close();
  }
});

test('session: Bluetooth auto detection in a registry with every family (default and user defined names)', async () => {
  const registry = new DriverRegistry(appDrivers());
  for (const name of ['EK-24S4EB', 'Backup BMS']) {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 200, probeTimeoutMs: 600 });
    /** @type {any[]} */
    const sims = [];
    const handle = {
      name,
      connected: false,
      async connect() {
        this.connected = true;
      },
      async disconnect() {
        this.connected = false;
      },
      async discover() {
        return [{ uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', characteristics: [] }];
      },
      /** @param {{ chunkSize?: number }} profile */
      async openChannel(profile) {
        const { host, device } = createLinkPair({ log, name, deviceChunkSize: profile.chunkSize ?? 20 });
        await host.open();
        await device.open();
        sims.push(createNeeySimulator(device, { stepMs: 0, intervalMs: 200 }));
        return host;
      },
    };
    /** @type {string[]} */
    const probed = [];
    session.on('detect', (/** @type {any} */ e) => probed.push(e.driverId));
    try {
      await session.connect({ kind: 'ble', handle, selection: 'auto' });
      assert.equal(session.definition?.id, 'neey-ble', name);
      assert.equal(session.variant, 'NEEY_V1');
      if (name === 'EK-24S4EB') assert.deepEqual(probed, ['neey-ble']);
      else assert.ok(probed.slice(0, -1).every((id) => id.startsWith('jk')), `JK probes first: ${probed.join(', ')}`);
      // The foreign probes before it were not taken for requests, let alone writes.
      for (const sim of sims) assert.ok(sim.received.every((/** @type {any} */ q) => q.function === P.FUNCTION.READ));
      await until(() => session.snapshot);
    } finally {
      await session.disconnect();
      for (const sim of sims) sim.stop();
    }
  }
});
