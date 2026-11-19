import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, canonicalUuid, createLinkPair, fromHex, hex, sleep, sum8 } from '@ubms/transport';
import { BaseDriver, BmsSession, DriverRegistry, fieldMap, validateValue, warnAll } from '@ubms/bms-core';
import * as P from '../src/daly-balancer/protocol.js';
import {
  DalyBalancerDriver,
  balancerInfo,
  balancerSnapshot,
  buildDalyBalancerSchema,
  createDalyBalancerSimulator,
  dalyBalancerDefinition,
  dalyBalancerDrivers,
  decodeBalancerSettings,
  settingWriteFrame,
} from '../src/daly-balancer/index.js';
import { createDalyModbusSimulator, createDalySimulator, dalyModbusDefinition, dalyDefinition } from '../src/daly/index.js';
import { drivers } from '../src/index.js';

/**
 * @typedef {{ id: string, variant: string, link: string, direction: 'tx'|'rx', hex: string, expected: Record<string, any> }} Vector
 */

/** @type {Vector[]} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/dalybal.json', import.meta.url), 'utf8'));
/** @param {string} name @returns {Vector[]} */
const vectorFile = (name) => JSON.parse(readFileSync(new URL(`./vectors/${name}.json`, import.meta.url), 'utf8'));
const byId = (/** @type {string} */ id) => {
  const v = vectors.find((x) => x.id === id);
  assert.ok(v, `vector ${id}`);
  return /** @type {Vector} */ (v);
};
const frameOf = (/** @type {string} */ id) => fromHex(byId(id).hex);

const EM_DASH = String.fromCharCode(0x2014);

/**
 * The existing drivers plus this family, registered as recommended in spec 11.5: the balancer
 * definitions right before the first Daly BMS definition. Built here only; the main registration
 * in src/index.js is not touched by this family.
 */
const base = drivers.filter((d) => !dalyBalancerDrivers.some((b) => b.id === d.id));
const firstDaly = base.findIndex((d) => d.family === 'daly');
const combined = [...base.slice(0, firstDaly), ...dalyBalancerDrivers, ...base.slice(firstDaly)];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Decimals written in a number literal. @param {number} n */
function decimalsOf(n) {
  const s = String(n);
  if (s.includes('e')) return 12;
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * Deep comparison: whole numbers exactly, other numbers within half a unit of the last written
 * decimal of the expected value.
 * @param {any} actual
 * @param {any} expected
 * @param {string} path
 */
function assertClose(actual, expected, path) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
    const tol = Number.isInteger(expected) ? 1e-9 : Math.min(5e-4, Math.max(1e-6, 0.5 * 10 ** -decimalsOf(expected))) + 1e-12;
    assert.ok(Math.abs(actual - expected) <= tol, `${path}: got ${actual}, expected ${expected}`);
  } else if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => assertClose(actual[i], e, `${path}[${i}]`));
  } else if (expected !== null && typeof expected === 'object') {
    for (const [k, e] of Object.entries(expected)) assertClose(actual?.[k], e, `${path}.${k}`);
  } else {
    assert.equal(actual, expected, path);
  }
}

/** Poll a condition. @param {() => any} cond @param {number} [timeout] */
async function waitFor(cond, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail('condition not met in time');
}

/** Device side write that ignores a closed link. @param {import('@ubms/transport').Link} device @param {Uint8Array} bytes */
const tx = (device, bytes) => {
  device.write(bytes).catch(() => {});
};

/**
 * Frames the host side assembler emits for a byte stream, fed in the given chunk size.
 * @param {Uint8Array} bytes
 * @param {{ chunk?: number, expectedByteCount?: number }} [opts]
 */
function assemble(bytes, { chunk = bytes.length || 1, expectedByteCount } = {}) {
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = P.createAssembler({ onFrame: (f) => frames.push(f), expectedByteCount: () => expectedByteCount });
  for (let i = 0; i < bytes.length; i += chunk) asm.push(bytes.subarray(i, i + chunk));
  return frames;
}

/**
 * Start register of the request each read reply answers (replies do not carry it, spec 3.1).
 * @type {Array<[RegExp, number]>}
 */
const RX_START = [
  [/-status(62|80)/, 0x0000],
  [/-settings/, 0x0080],
  [/-version/, 0x00a9],
  [/-password/, 0x00c9],
  [/-0063-/, 0x0063],
  [/-00cc-/, 0x00cc],
  [/-block003e/, 0x003e],
  [/-00df-/, 0x00df],
  [/-0057-/, 0x0057],
  [/damaged-after-pipelining/, 0x0057],
  [/-00d7/, 0x00d7],
  [/-switch-(on|off)-syssi/, 0x00cf],
];

/** Keys of the vectors that describe the stream, not one frame. */
const STREAM_KEYS = new Set(['notificationLength', 'frameCount', 'frames', 'text', 'isDalyFrame']);

/**
 * Captured replies of the [SNOOP] balancer by request (start, count); the simulator of a device
 * that only knows these frames.
 * @param {Record<string, string>} [replace] reply vector id per request key, to swap in BMS frames
 */
function capturedReplies(replace = {}) {
  /** @type {Record<string, string>} */
  const ids = {
    '0:62': 'bal-rx-status62-a',
    '128:41': 'bal-rx-settings',
    '169:32': 'bal-rx-version',
    '201:3': 'bal-rx-password',
    '62:9': 'bal-rx-block003e',
    '204:5': 'bal-rx-00cc-5-on',
    ...replace,
  };
  return Object.fromEntries(Object.entries(ids).filter(([, id]) => id).map(([k, id]) => [k, frameOf(id)]));
}

/**
 * A device that answers reads from a table of captured replies (no answer otherwise) and writes
 * with `writeReply` (no answer without it). Records every request.
 * @param {import('@ubms/transport').MemoryLink} device
 * @param {Record<string, Uint8Array>} replies key `${start}:${count}`
 * @param {Uint8Array} [writeReply] reply to every 0x06 write
 */
function replayDevice(device, replies, writeReply) {
  /** @type {Uint8Array[]} */
  const received = [];
  const asm = P.createRequestAssembler({
    onFrame: (f) => {
      received.push(f);
      const q = P.parseRequest(f);
      const reply = q.function === P.FN.READ ? replies[`${q.start}:${q.count}`] : q.function === P.FN.WRITE ? writeReply : undefined;
      if (reply) setTimeout(() => tx(device, reply), 20).unref?.();
    },
  });
  device.on('data', (c) => asm.push(c));
  return { received, stop() {} };
}

/** Direct link pair plus a driver bound to the host side. @param {{ kind?: string, chunk?: number }} [opts] */
async function driverPair({ kind = 'memory', chunk = 20 } = {}) {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, kind, deviceChunkSize: chunk });
  await host.open();
  await device.open();
  const driver = /** @type {DalyBalancerDriver} */ (dalyBalancerDefinition.create({ link: host, log }));
  return { log, host, device, driver };
}

/**
 * Fake BLE device handle: every channel is a new link pair with a device attached.
 * @param {ProtocolLog} log
 * @param {{ name?: string, services?: number[], attach: (device: import('@ubms/transport').MemoryLink) => any }} opts
 */
function fakeBleHandle(log, { name = 'DL-401804013AEF', services = [0xfff0, 0x1800], attach }) {
  /** @type {any[]} */
  const sims = [];
  /** @type {string[]} */
  const profiles = [];
  return {
    name,
    connected: false,
    sims,
    profiles,
    async connect() {
      this.connected = true;
    },
    async disconnect() {
      this.connected = false;
    },
    async discover() {
      return services.map((s) => ({ uuid: canonicalUuid(s), characteristics: [] }));
    },
    /** @param {{ id: string, chunkSize?: number }} profile */
    async openChannel(profile) {
      profiles.push(profile.id);
      const { host, device } = createLinkPair({ log, deviceChunkSize: profile.chunkSize ?? 20 });
      await host.open();
      await device.open();
      sims.push(attach(device));
      return host;
    },
  };
}

/**
 * Fake serial port: every probe opens a new link pair (kind 'serial') with a device attached.
 * @param {ProtocolLog} log
 * @param {(device: import('@ubms/transport').MemoryLink) => any} attach
 */
function fakeSerialPort(log, attach) {
  /** @type {any[]} */
  const sims = [];
  return {
    sims,
    /** @param {{ baudRate: number }} _opts */
    async openLink(_opts) {
      const { host, device } = createLinkPair({ log, deviceChunkSize: 32, kind: 'serial' });
      await host.open();
      await device.open();
      sims.push(attach(device));
      return host;
    },
  };
}

/** A device that never answers. @param {import('@ubms/transport').MemoryLink} device */
function silentDevice(device) {
  /** @type {Uint8Array[]} */
  const received = [];
  device.on('data', (c) => received.push(c));
  return { received, stop() {} };
}

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

test('vectors: every received frame decodes to its expected values', () => {
  const rx = vectors.filter((v) => v.direction === 'rx' && v.variant !== 'BLE_MODULE_TEXT' && !('frames' in v.expected));
  assert.equal(rx.length, 28);
  for (const v of rx) {
    const frame = fromHex(v.hex);
    const start = RX_START.find(([re]) => re.test(v.id))?.[1];
    if (frame[1] === P.FN.READ) assert.notEqual(start, undefined, `${v.id}: no start register known`);
    const decoded = frame[1] === P.FN.READ ? P.decodeReply(frame, /** @type {number} */ (start)) : P.parseResponse(frame);
    const expected = Object.fromEntries(Object.entries(v.expected).filter(([k]) => !STREAM_KEYS.has(k)));
    assertClose(decoded, expected, v.id);
  }
});

test('vectors: the assembler keeps frames with a valid CRC and drops the others', () => {
  const rx = vectors.filter((v) => v.direction === 'rx' && v.hex.startsWith('D2') && 'crcValid' in v.expected);
  for (const v of rx) {
    const frame = fromHex(v.hex);
    for (const chunk of [frame.length, 20, 1]) {
      const frames = assemble(frame, { chunk });
      assert.deepEqual(frames.map((f) => hex(f).toUpperCase()), v.expected.crcValid ? [v.hex] : [], `${v.id}, chunk ${chunk}`);
    }
  }
  // The damaged 29 byte frame (byte count 24, CRC of another reply) must not hide the next reply.
  const damaged = frameOf('bal-rx-damaged-after-pipelining');
  const next = frameOf('bal-rx-0057-zero');
  assert.deepEqual(assemble(new Uint8Array([...damaged, ...next])).map((f) => hex(f).toUpperCase()), [byId('bal-rx-0057-zero').hex]);
});

test('vectors: several replies in one notification are split', () => {
  for (const id of ['bal-rx-stream-two-replies', 'bal-rx-stream-three-replies']) {
    const v = byId(id);
    const bytes = fromHex(v.hex);
    assert.equal(bytes.length, v.expected.notificationLength);
    for (const chunk of [bytes.length, 20, 7, 1]) {
      const frames = assemble(bytes, { chunk });
      assert.equal(frames.length, v.expected.frameCount, `${id}, chunk ${chunk}`);
      assert.deepEqual(frames.map((f) => hex(f).toUpperCase()), v.expected.frames, `${id}, chunk ${chunk}`);
    }
  }
});

test('vectors: module text and the 0x81 reply are skipped, the reply after them is kept', () => {
  const text = vectors.filter((v) => v.variant === 'BLE_MODULE_TEXT');
  assert.equal(text.length, 7);
  for (const v of text) {
    const bytes = fromHex(v.hex);
    assert.equal(new TextDecoder().decode(bytes).trim(), v.expected.text, v.id);
    assert.equal(v.expected.isDalyFrame, false);
    assert.ok(!bytes.includes(P.D2_ADDRESS), `${v.id}: no 0xD2 byte`);
    assert.deepEqual(assemble(bytes), [], v.id);
  }
  const probeReply = frameOf('bal-rx-app-probe-81-reply');
  assert.deepEqual(assemble(probeReply), []);
  const reply = frameOf('bal-rx-00cc-5-on');
  const mixed = new Uint8Array([...fromHex(byId('ble-rx-text-9600').hex), ...probeReply, ...fromHex(byId('ble-rx-text-productinfo').hex), ...reply]);
  for (const chunk of [mixed.length, 20, 3]) {
    assert.deepEqual(assemble(mixed, { chunk }).map((f) => hex(f).toUpperCase()), [byId('bal-rx-00cc-5-on').hex], `chunk ${chunk}`);
  }
});

test('vectors: every transmitted frame equals the encoder output', () => {
  const txs = vectors.filter((v) => v.direction === 'tx');
  assert.equal(txs.length, 35);
  for (const v of txs) {
    const bytes = fromHex(v.hex);
    const e = v.expected;
    if (v.variant === 'BLE_MODULE_TEXT') {
      assert.equal(new TextDecoder().decode(bytes).trim(), e.text, v.id);
      assert.ok(!bytes.includes(P.D2_ADDRESS), v.id);
      continue;
    }
    if (v.variant === 'DALY_CLASSIC') {
      assert.equal(bytes.length, 13);
      assert.deepEqual([bytes[0], bytes[1], bytes[2], bytes[3]], [e.start, e.address, e.command, e.length]);
      assert.equal(bytes[12], e.checksum);
      assert.equal(sum8(bytes, 0, 12) === bytes[12], e.checksumValid);
      assert.equal(P.isAllowedRequest(bytes), false, 'the A5 probe of the app is never sent');
      continue;
    }
    /** @type {Uint8Array} */
    let encoded;
    if (e.function === P.FN.READ) encoded = P.encodeRead(e.start, e.count);
    else if (e.function === P.FN.WRITE) encoded = P.encodeWrite(e.register, e.value);
    else encoded = P.encodeWriteMulti(e.register, e.values, e.address);
    assert.equal(hex(encoded).toUpperCase(), v.hex, v.id);
    assertClose(P.parseRequest(bytes), e, v.id);
    assert.equal(P.isAllowedRequest(bytes), e.writable ?? true, `${v.id}: writable`);
  }
  // Spec 5.2 examples outside the vectors.
  assert.equal(hex(P.encodeWrite(0x00a3, 3200)).toUpperCase(), 'D20600A30C806EEB');
  assert.equal(hex(P.encodeWrite(0x00a4, 30)).toUpperCase(), 'D20600A4001E5B82');
});

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

test('settings: write frames of the schema equal the vectors and the spec examples', () => {
  const f = fieldMap(buildDalyBalancerSchema());
  /** @type {Array<[string, any, string]>} */
  const cases = [
    ['switch.balance', false, 'bal-tx-write-switch-off'],
    ['switch.balance', true, 'bal-tx-write-switch-on'],
    ['system.sleep_delay', 65535, 'bal-tx-write-sleep-never'],
    ['system.sleep_delay', 3600, 'bal-tx-write-sleep-3600'],
    ['balance.start_voltage', 3.3, 'bal-tx-write-start-voltage-3300'],
    ['balance.trigger_delta', 0.02, 'bal-tx-write-trigger-delta-20'],
  ];
  for (const [id, value, vector] of cases) {
    const frame = settingWriteFrame(/** @type {any} */ (f.get(id)), value);
    assert.equal(frame && hex(frame).toUpperCase(), byId(vector).hex, `${id} = ${value}`);
  }
  assert.equal(hex(/** @type {Uint8Array} */ (settingWriteFrame(/** @type {any} */ (f.get('balance.start_voltage')), 3.2))).toUpperCase(), 'D20600A30C806EEB');
  for (const value of [0, 1, 2]) assert.equal(settingWriteFrame(/** @type {any} */ (f.get('system.battery_type')), value), null, 'battery type is never written');
  assert.equal(settingWriteFrame(/** @type {any} */ (f.get('system.cell_count')), 16), null);
  // Values outside the schema range get no frame, even when they fit the u16 register (spec 7).
  /** @type {Array<[string, any]>} */
  const outside = [
    ['system.sleep_delay', 0],
    ['system.sleep_delay', 59],
    ['balance.start_voltage', 0.2],
    ['balance.start_voltage', 4.6],
    ['balance.start_voltage', 65.535],
    ['balance.trigger_delta', 0],
    ['balance.trigger_delta', 1.6],
    ['balance.trigger_delta', NaN],
    ['balance.trigger_delta', null],
    ['balance.trigger_delta', ''],
  ];
  for (const [id, value] of outside) assert.equal(settingWriteFrame(/** @type {any} */ (f.get(id)), value), null, `${id} = ${value}`);
  assert.ok(settingWriteFrame(/** @type {any} */ (f.get('system.sleep_delay')), 60), 'the lowest sleep time ubms writes');
});

test('settings: schema census, limits, descriptions and checks', () => {
  const schema = buildDalyBalancerSchema();
  const all = schema.groups.flatMap((g) => g.fields);
  const writable = all.filter((x) => !x.readOnly && x.type !== 'action').map((x) => x.id);
  const readOnly = all.filter((x) => x.readOnly).map((x) => x.id);
  const actions = all.filter((x) => x.type === 'action').map((x) => x.id);
  assert.deepEqual(writable.sort(), ['balance.start_voltage', 'balance.trigger_delta', 'switch.balance', 'system.sleep_delay']);
  assert.deepEqual(readOnly.sort(), ['system.battery_type', 'system.cell_count']);
  assert.deepEqual(actions, []);
  for (const x of all) {
    assert.ok(x.description && x.description.length > 20, `${x.id}: description`);
    assert.ok(!x.description.includes(EM_DASH), `${x.id}: no em dash`);
    if (!x.readOnly) assert.ok(P.WRITABLE_REGISTERS.includes(x.meta.register), `${x.id}: register 0x${x.meta.register.toString(16)}`);
  }
  for (const id of readOnly) assert.match(/** @type {string} */ (all.find((x) => x.id === id)?.description), /never written/, id);
  const f = fieldMap(schema);
  assert.equal(f.get('switch.balance')?.group, 'controls');
  assert.equal(f.get('balance.start_voltage')?.group, 'balancing');
  // Writes not captured on a balancer ask for a confirmation (spec 7.1).
  assert.deepEqual(
    all.filter((x) => x.danger).map((x) => x.id),
    ['balance.start_voltage', 'balance.trigger_delta'],
  );
  assert.equal(f.get('system.battery_type')?.type, 'enum');
  assert.deepEqual(
    f.get('system.battery_type')?.options?.map((o) => o.value),
    [0, 1, 2],
  );
  const v = (/** @type {string} */ id, /** @type {any} */ value) => validateValue(/** @type {any} */ (f.get(id)), value);
  assert.equal(v('balance.start_voltage', 3.4), null);
  assert.ok(v('balance.start_voltage', 1.4));
  assert.ok(v('balance.start_voltage', 4.6));
  assert.equal(v('balance.trigger_delta', 0.01), null);
  assert.ok(v('balance.trigger_delta', 0.009));
  assert.ok(v('balance.trigger_delta', 1.6));
  assert.equal(v('system.sleep_delay', 65535), null);
  assert.ok(v('system.sleep_delay', 30), 'below 60 s is not offered');
  assert.ok(v('system.cell_count', 16), 'read only');
  assert.ok(v('system.battery_type', 1), 'read only');

  // Values of the captured unit (settings block plus switch block).
  const values = decodeBalancerSettings(schema, { settings: P.parseSettings(frameOf('bal-rx-settings')), switchBlock: P.parseSwitchBlock(frameOf('bal-rx-00cc-5-on')) });
  assert.deepEqual(values, {
    'switch.balance': true,
    'balance.start_voltage': 3.2,
    'balance.trigger_delta': 0.02,
    'system.sleep_delay': 65535,
    'system.cell_count': 16,
    'system.battery_type': 0,
  });
  assert.equal(decodeBalancerSettings(schema, { settings: P.parseSettings(frameOf('bal-rx-settings')) })['switch.balance'], undefined, 'no switch block, no switch value');

  // Non-blocking warnings (spec 7.3, 7.5).
  assert.deepEqual(warnAll(schema, values), {});
  assert.ok(warnAll(schema, { ...values, 'balance.start_voltage': 3.8 })['balance.start_voltage'], 'above the LiFePO4 range');
  assert.equal(warnAll(schema, { ...values, 'balance.start_voltage': 3.8, 'system.battery_type': 1 })['balance.start_voltage'], undefined, 'fine for Li-ion');
  assert.ok(warnAll(schema, { ...values, 'balance.start_voltage': 3.3, 'system.battery_type': 2 })['balance.start_voltage'], 'above the LTO range');
  assert.ok(warnAll(schema, { ...values, 'system.sleep_delay': 300 })['system.sleep_delay']);
  assert.equal(warnAll(schema, { ...values, 'system.sleep_delay': 3600 })['system.sleep_delay'], undefined);
});

// ---------------------------------------------------------------------------------------------
// Status, signatures, snapshot, faults
// ---------------------------------------------------------------------------------------------

test('status: the balancer signature holds for every balancer frame and no Daly BMS frame', () => {
  for (const id of ['bal-rx-status62-a', 'bal-rx-status62-b', 'bal-rx-status62-c']) {
    const st = P.parseStatus(frameOf(id));
    assert.equal(P.statusSignature(st), true, id);
    assert.equal(P.statusProblem(st, { strict: true }), null, id);
  }
  assert.equal(P.settingsSignature(P.parseSettings(frameOf('bal-rx-settings'))), true);
  assert.equal(P.settingsSignature(P.parseSettings(frameOf('bms-rx-settings-4s'))), false);
  // Daly BMS status frames of both vector files: balancerSignature false (the balancer frames of
  // daly.json, captured from the same unit as [SNOOP], are the only exception).
  const daly = vectorFile('daly').filter((v) => v.direction === 'rx' && /^d2-rx-status(62|80)/.test(v.id));
  const bms = [...vectors.filter((v) => /^bms-rx-status/.test(v.id)), ...daly];
  assert.ok(bms.length >= 12);
  for (const v of bms) {
    const st = P.parseStatus(fromHex(v.hex));
    assert.equal(P.statusSignature(st), v.id.endsWith('-balancer'), v.id);
  }
  const dalySettings = vectorFile('daly').filter((v) => /^d2-rx-settings/.test(v.id));
  for (const v of dalySettings) assert.equal(P.settingsSignature(P.parseSettings(fromHex(v.hex))), v.id.endsWith('-balancer'), v.id);
});

test('status: plausibility keeps a 0 mV cell visible and rejects nonsense', () => {
  const st = P.parseStatus(frameOf('bal-rx-status62-a'));
  const withZero = { ...st, cellVoltages: st.cellVoltages.map((/** @type {number} */ x, /** @type {number} */ i) => (i === 5 ? 0 : x)) };
  assert.equal(P.statusProblem(withZero, { strict: true }), null, 'an open sense lead stays visible');
  const allZero = { ...st, cellVoltages: st.cellVoltages.map(() => 0) };
  assert.ok(P.statusProblem(allZero, { strict: true }));
  assert.equal(P.statusProblem(allZero), null, 'polling keeps showing it');
  assert.ok(P.statusProblem({ ...st, cellCount: 0, cellVoltages: [] }));
  assert.ok(P.statusProblem({ ...st, cellCount: 33 }));
  assert.ok(P.statusProblem({ ...st, cellVoltages: st.cellVoltages.map(() => 5.2) }));
  assert.ok(P.statusProblem({ ...st, temperatureSensorCount: 9 }, { strict: true }));
});

test('snapshot: balancer fields only, temperature slots 7 and 8 are not temperatures', () => {
  const st = P.parseStatus(frameOf('bal-rx-status62-a'));
  const balance = P.parseBalanceBlock(frameOf('bal-rx-block003e'));
  const settings = P.parseSettings(frameOf('bal-rx-settings'));
  const on = balancerSnapshot(st, { balance, switchBlock: P.parseSwitchBlock(frameOf('bal-rx-00cc-5-on')), settings });
  assert.equal(on.cells?.length, 16);
  assert.equal(on.voltage, 53.3);
  assert.deepEqual(on.temperatures, [{ id: 'board', label: 'Board temperature', value: 28, kind: 'board' }]);
  assert.equal(on.balancingActive, false);
  assert.equal(on.balanceCurrent, 0);
  assert.deepEqual(on.switches, { balance: true });
  assert.deepEqual(on.alarms, []);
  assert.equal(on.extra?.balancer.value, 'Idle');
  assert.equal(on.extra?.startVoltage.value, 3.2);
  assert.equal(on.extra?.triggerDelta.value, 0.02);
  for (const k of ['current', 'power', 'soc', 'capacityRemaining', 'capacityFull', 'cycles', 'balancing']) assert.equal(k in on, false, `${k} is not reported`);
  const off = balancerSnapshot(st, { switchBlock: P.parseSwitchBlock(frameOf('bal-rx-00cc-5-off')) });
  assert.equal(off.extra?.balancer.value, 'Off');
  assert.deepEqual(off.switches, { balance: false });
  assert.equal('balanceCurrent' in off, false, 'no balance block, no balance current');
  const busy = balancerSnapshot({ ...st, balancingState: 2 }, {});
  assert.equal(busy.balancingActive, true);
  assert.equal(busy.extra?.balancer.value, 'Balancing now');
  assert.equal(busy.switches, undefined);
  // All eight slots counted: slots 7 and 8 hold 533 and 3335 (493 and 3295 degrees C).
  const regs = P.registersOf(frameOf('bal-rx-status62-a'));
  regs[P.REG.TEMP_COUNT] = 8;
  const eight = P.parseStatus(P.encodeReadResponse(regs));
  assert.equal(eight.temperatures.length, 8);
  const temps = balancerSnapshot(eight).temperatures ?? [];
  assert.deepEqual(
    temps.map((t) => t.id),
    ['board', 't2', 't3', 't4', 't5', 't6'],
  );
  // The 80 register read (UART) carries the balance block.
  const status80 = P.parseStatus(P.encodeReadResponse([...regs.slice(0, 62), ...P.registersOf(frameOf('bal-rx-block003e')), ...new Array(9).fill(0)]));
  assert.equal(status80.balance.balanceCurrent, 0);
  assert.equal(balancerSnapshot(status80).balanceCurrent, 0);
  // Balance current: unverified scale, 0 and 0xFFFF mean not available.
  assert.equal(P.balanceFromRegisters([0, 0, 30650, 0, 0, 0, 0, 0, 0]).balanceCurrent, 0.65);
  assert.equal(P.balanceFromRegisters([0, 0, 0, 0, 0, 0, 0, 0, 0]).balanceCurrent, null);
  assert.equal(P.balanceFromRegisters([0, 0, 0xffff, 0, 0, 0, 0, 0, 0]).balanceCurrent, null);
});

test('faults: wire byte order, level 1 as warning, unknown bits with their source', () => {
  /** @type {Record<string, [string, string]>} */
  const expected = {
    'd2-rx-status62-alarm-warn-charging-temp-high': ['charge_overtemperature', 'warning'],
    'd2-rx-status62-alarm-warn-cell-voltage-high': ['cell_overvoltage', 'warning'],
    'd2-rx-status62-alarm-afe-failure': ['afe_fault', 'fault'],
  };
  for (const v of vectorFile('daly').filter((x) => x.id in expected)) {
    const st = P.parseStatus(fromHex(v.hex));
    const [id, severity] = expected[v.id];
    const a = st.alarms.find((/** @type {any} */ x) => x.id === id);
    assert.ok(a, `${v.id}: ${id}`);
    assert.equal(a.severity, severity, v.id);
  }
  assert.deepEqual(P.faultAlarms([0x0100, 0, 0, 0]), [{ id: 'charge_overtemperature', label: 'Charge overtemperature', severity: 'warning', source: 'bit 8 of 0x003A' }]);
  assert.deepEqual(
    P.faultAlarms([0x0003, 0, 0, 0]).map((a) => [a.id, a.severity]),
    [['cell_overvoltage', 'protection']],
    'level 1 and level 2 together: one alarm, the more severe',
  );
  // Classic byte 5 is the high byte of 0x003C: bit 7 internal communication, bit 0 AFE.
  assert.deepEqual(P.faultAlarms([0, 0, 0x8000, 0]).map((a) => a.source), ['bit 15 of 0x003C']);
  assert.deepEqual(P.faultAlarms([0, 0, 0x8000, 0]).map((a) => a.id), ['communication_fault']);
  assert.deepEqual(P.faultAlarms([0, 0, 0x0100, 0]).map((a) => a.id), ['afe_fault']);
  // Classic byte 2 bit 0 (charge overcurrent) is the low byte of 0x003B: no catalog alarm on a
  // balancer, reported with its raw source.
  const unknown = P.faultAlarms([0, 0x0001, 0, 0]);
  assert.deepEqual(unknown, [{ id: 'daly.fault_003B_bit0', label: 'Undocumented fault bit', severity: 'warning', source: 'bit 0 of 0x003B' }]);
  assert.deepEqual(P.faultSource(0, 0), { register: 0x003a, bit: 0, text: 'bit 0 of 0x003A' });
  assert.deepEqual(P.faultSource(7, 7), { register: 0x003d, bit: 15, text: 'bit 15 of 0x003D' });
  // Classic byte 7 (high byte of 0x003D) is one numeric fault code, not eight flags (spec 9.2).
  assert.deepEqual(P.faultAlarms([0, 0, 0, 0x0300]), [], 'fault code 3 is not two alarms');
  assert.deepEqual(P.faultAlarms([0, 0, 0, 0x0301]).map((a) => a.id), ['daly.fault_003D_bit0'], 'classic byte 6 stays bits');
  const regs = P.registersOf(frameOf('bal-rx-status62-a'));
  assert.equal(P.parseStatus(frameOf('bal-rx-status62-a')).faultCode, 0);
  assert.equal('faultCode' in (balancerSnapshot(P.parseStatus(frameOf('bal-rx-status62-a'))).extra ?? {}), false, 'no fault code, no extra value');
  regs[P.REG.FAULTS + 3] = 0x0300;
  const st = P.parseStatus(P.encodeReadResponse(regs));
  assert.equal(st.faultCode, 3);
  assert.deepEqual(st.alarms, []);
  assert.deepEqual(balancerSnapshot(st).extra?.faultCode, { label: 'Fault code', value: 3, decimals: 0 });
});

test('device info: versions as read, reversed form, no password, no placeholder date', () => {
  const info = balancerInfo({
    version: P.parseVersion(frameOf('bal-rx-version')),
    switchBlock: P.parseSwitchBlock(frameOf('bal-rx-00cc-5-on')),
    status: P.parseStatus(frameOf('bal-rx-status62-b')),
  });
  assert.equal(info.vendor, 'Daly BMS');
  assert.equal(info.model, 'Active balancer');
  assert.equal(info.softwareVersion, 'B002_111132_03');
  assert.equal(info.hardwareVersion, 'E303-032DG-SMB');
  assert.equal(info.extra?.softwareVersionReversed.value, '30_231111_200B');
  assert.equal(info.extra?.hardwareVersionReversed.value, 'BMS-GD230-303E');
  assert.equal(info.extra && 'password' in info.extra, false, 'the password would end up in log exports');
  assert.ok(!JSON.stringify(info).includes('123456'));
  assert.equal(info.extra?.cellCount.value, 16);
  assert.equal(info.extra?.machineCode, undefined);
  assert.equal(info.manufactureDate, undefined, '00 01 01 00 is the placeholder');
  const dated = P.parseSwitchBlock(P.encodeReadResponse([0x1803, 0x1500, 16, 1, 10]));
  assert.equal(dated.productionDate, '2024-03-21');
  const bms = balancerInfo({ version: P.parseVersion(frameOf('bms-rx-version-aiobmsble')) });
  assert.equal(bms.extra?.machineCode.value, '20240229');
});

test('protocol log: names and decoders keep the start register of the request', () => {
  const req = P.describe(P.encodeRead(0x0080, 41), { direction: 'tx' });
  assert.equal(req?.name, 'Read settings (41)');
  assert.equal(req?.decode().replyLength, 87);
  assert.equal(P.describe(P.encodeWrite(0x00cf, 1), { direction: 'tx' })?.name, 'Write balancer switch');
  const rx = P.describe(frameOf('bal-rx-settings'), { start: 0x0080 });
  assert.equal(rx?.name, 'Reply: settings');
  assert.equal(rx?.decode().balanceStartVoltage, 3.2);
  assert.equal(P.describe(frameOf('bal-rx-echo-switch-on'))?.name, 'Write echo: balancer switch');
  assert.equal(P.describe(frameOf('bal-rx-settings'))?.decode().byteCount, 82, 'unknown start: generic decode');
  assert.equal(P.describe(frameOf('bal-rx-app-probe-81-reply')), null);
});

// ---------------------------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------------------------

test('probe: captured balancer frames give confidence 1 with exactly the two read requests', async () => {
  const { device, driver } = await driverPair();
  const dev = replayDevice(device, capturedReplies());
  const result = await driver.probe({ timeout: 2500 });
  assert.equal(result?.variant, 'DALY_BALANCER_D2');
  assert.equal(result?.confidence, 1);
  assert.equal(result?.info?.vendor, 'Daly BMS');
  assert.deepEqual(
    dev.received.map((f) => hex(f).toUpperCase()),
    [byId('bal-tx-read-status62').hex, byId('bal-tx-read-settings').hex],
  );
  assert.ok(dev.received.every((f) => P.isAllowedRequest(f) && f[1] === P.FN.READ));
  assert.equal(driver.settings?.balanceStartVoltage, 3.2, 'the settings reply is kept');
  driver.dispose();
});

test('probe: without a settings reply the status signature alone gives confidence 0.7', async () => {
  const { device, driver } = await driverPair();
  const dev = replayDevice(device, capturedReplies({ '128:41': '' }));
  const result = await driver.probe({ timeout: 400 });
  assert.equal(result?.confidence, 0.7);
  assert.equal(dev.received.length, 3, 'status once, settings twice (one retry)');
  driver.dispose();
});

test('probe: Daly BMS replies, foreign frames and silence are rejected', async () => {
  // BMS status frames fail the status signature after one read.
  for (const id of ['bms-rx-status62-aiobmsble', 'bms-rx-status62-8s-idle', 'bms-rx-status62-24s', 'bms-rx-status62-4s-idle-uart']) {
    const { device, driver } = await driverPair();
    const dev = replayDevice(device, capturedReplies({ '0:62': id }));
    assert.equal(await driver.probe({ timeout: 400 }), null, id);
    assert.equal(dev.received.length, 1, `${id}: one status read only`);
    driver.dispose();
  }
  // An idle BMS that happens to pass the status signature fails on its current limits.
  {
    const { device, driver } = await driverPair();
    const dev = replayDevice(device, capturedReplies({ '128:41': 'bms-rx-settings-4s' }));
    assert.equal(await driver.probe({ timeout: 400 }), null);
    assert.equal(dev.received.length, 2);
    driver.dispose();
  }
  // The Daly D2 BMS simulator (also in its active balancer flavour, which is a BMS with a switch).
  for (const balancer of [false, true]) {
    const { device, driver } = await driverPair();
    const sim = createDalyModbusSimulator(device, { tickMs: 0, balancer });
    assert.equal(await driver.probe({ timeout: 400 }), null, `daly-modbus simulator, balancer ${balancer}`);
    assert.ok(sim.received.every((f) => P.isAllowedRequest(f)));
    sim.stop();
    driver.dispose();
  }
  // Frames of every other family answer every request: never a D2 reply.
  const foreign = ['jk', 'jk-balancer', 'ant', 'jbd', 'neey', 'seplos', 'atorch'].flatMap((name) => vectorFile(name).filter((v) => v.direction === 'rx' && v.hex).map((v) => fromHex(v.hex)));
  assert.ok(foreign.length > 300);
  const stream = new Uint8Array(foreign.reduce((n, f) => n + f.length, 0));
  foreign.reduce((o, f) => (stream.set(f, o), o + f.length), 0);
  assert.deepEqual(assemble(stream), [], 'no foreign frame passes the D2 assembler');
  assert.deepEqual(assemble(stream, { chunk: 20 }), []);
  {
    const { device, driver } = await driverPair();
    const asm = P.createRequestAssembler({ onFrame: () => foreign.slice(0, 40).forEach((f) => tx(device, f)) });
    device.on('data', (c) => asm.push(c));
    assert.equal(await driver.probe({ timeout: 400 }), null, 'foreign frames');
    driver.dispose();
  }
  // Silence: two attempts of the status read, nothing else.
  {
    const { device, driver } = await driverPair();
    const dev = silentDevice(device);
    const t0 = Date.now();
    assert.equal(await driver.probe({ timeout: 400 }), null);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(hex(new Uint8Array(dev.received.flatMap((c) => [...c]))).toUpperCase(), byId('bal-tx-read-status62').hex.repeat(2));
    driver.dispose();
  }
});

test('probe: the timeout per attempt follows the spec unless the session asks for less', async () => {
  const run = async (/** @type {string} */ kind, /** @type {number} */ timeout) => {
    const { device, driver } = await driverPair({ kind });
    silentDevice(device);
    const t0 = Date.now();
    assert.equal(await driver.probe({ timeout }), null);
    driver.dispose();
    return Date.now() - t0;
  };
  // Two attempts of the status read: BLE 2 x 1.5 s, serial 2 x 1.2 s (spec 11.3 step 1); a short
  // session probe timeout shortens each attempt (at least 0.4 s).
  const [ble, serial, short] = await Promise.all([run('memory', 10000), run('serial', 10000), run('memory', 100)]);
  assert.ok(ble >= 3000 && ble < 3600, `BLE ${ble} ms`);
  assert.ok(serial >= 2400 && serial < 3000, `serial ${serial} ms`);
  assert.ok(short >= 800 && short < 1400, `short ${short} ms`);
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

test('session: simulator end to end (connect, poll, info, settings, verified writes)', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(dalyBalancerDrivers), log, pollIntervalMs: 200 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await device.open();
  const sim = createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5 });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'link', link: host, selection: 'daly-balancer' });
  try {
    assert.equal(session.definition?.id, 'daly-balancer');
    assert.equal(session.definition?.deviceType, 'balancer');
    assert.equal(session.variant, 'DALY_BALANCER_D2');
    assert.deepEqual(session.driver?.capabilities, { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 });
    await waitFor(() => snapshots.length >= 1 && session.info?.softwareVersion);
    const s = snapshots.at(-1);
    assert.equal(s.cells.length, 16);
    assert.ok(s.voltage > 50 && s.voltage < 56);
    assert.equal(s.temperatures[0].id, 'board');
    assert.equal(s.switches.balance, true);
    assert.equal(s.balancingActive, true, 'the demo pack is spread enough to balance');
    assert.equal(s.extra.balancer.value, 'Balancing now');
    assert.equal(s.current, undefined);
    assert.equal(s.soc, undefined);
    assert.equal(s.state, undefined, 'no current, no charge state');
    assert.equal(session.info?.hardwareVersion, 'E303-032DG-SMB');
    assert.equal(session.info?.extra?.softwareVersionReversed.value, '30_231111_200B');

    const settings = await session.loadSettings();
    assert.deepEqual(settings.values, {
      'switch.balance': true,
      'balance.start_voltage': 3.3,
      'balance.trigger_delta': 0.02,
      'system.sleep_delay': 3600,
      'system.cell_count': 16,
      'system.battery_type': 0,
    });

    const before = sim.received.length;
    const results = await session.writeSettings([
      { id: 'balance.start_voltage', value: 3.35 },
      { id: 'balance.trigger_delta', value: 0.03 },
      { id: 'system.sleep_delay', value: 65535 },
      { id: 'system.battery_type', value: 1 },
      { id: 'system.cell_count', value: 15 },
      { id: 'balance.start_voltage', value: 5 },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [
        ['balance.start_voltage', true, true],
        ['balance.trigger_delta', true, true],
        ['system.sleep_delay', true, true],
        ['system.battery_type', false, undefined],
        ['system.cell_count', false, undefined],
        ['balance.start_voltage', false, undefined],
      ],
    );
    assert.equal(sim.registers[0x00a3], 3350);
    assert.equal(sim.registers[0x00a4], 30);
    assert.equal(sim.registers[0x008a], 65535);
    assert.equal(sim.registers[0x0089], 0, 'battery type untouched');
    const writes = sim.received.slice(before).filter((f) => f[1] === P.FN.WRITE).map((f) => hex(f).toUpperCase());
    assert.deepEqual(writes, [hex(P.encodeWrite(0x00a3, 3350)).toUpperCase(), hex(P.encodeWrite(0x00a4, 30)).toUpperCase(), byId('bal-tx-write-sleep-never').hex]);

    const sw = await session.writeSettings([{ id: 'switch.balance', value: false }]);
    assert.deepEqual(
      sw.map((r) => [r.ok, r.verified]),
      [[true, true]],
    );
    assert.equal(hex(/** @type {Uint8Array} */ (sim.received.findLast((f) => f[1] === P.FN.WRITE))).toUpperCase(), byId('bal-tx-write-switch-off').hex);
    const n = snapshots.length;
    await waitFor(() => snapshots.length > n + 1);
    const after = snapshots.at(-1);
    assert.equal(after.switches.balance, false);
    assert.equal(after.balancingActive, false);
    assert.equal(after.extra.balancer.value, 'Off');
    // Nothing but allowed requests reached the device during the whole session.
    assert.ok(sim.received.every((f) => P.isAllowedRequest(f)));
    assert.equal(sim.received.some((f) => f[1] === P.FN.WRITE_MULTI), false);
    // BLE poll: the reads of the app (spec 4.2 step 5); the password is never read (spec 10).
    const reads = sim.received.filter((f) => f[1] === P.FN.READ).map((f) => hex(f).toUpperCase());
    assert.ok(reads.includes(byId('bal-tx-read-block003e').hex));
    assert.equal(reads.includes(byId('bal-tx-read-status80').hex), false);
    assert.equal(reads.includes(byId('bal-tx-read-password').hex), false, 'the password would end up in log exports');
    assert.equal(session.info?.extra?.password, undefined);
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: a write echo with a bad CRC is verified by reading, not by writing again', async () => {
  const { device, driver } = await driverPair();
  const sim = createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5, corruptEchoes: 1 });
  assert.ok(await driver.probe({ timeout: 400 }));
  driver.timing = { timeout: 300, gap: 0 };
  const t0 = sim.received.length;
  await driver.writeSetting('switch.balance', false);
  const sent = sim.received.slice(t0).map((f) => hex(f).toUpperCase());
  assert.deepEqual(sent, [byId('bal-tx-write-switch-off').hex, byId('bal-tx-read-00cc-5').hex], 'one write, then the switch block read back');
  assert.equal(sim.registers[0x00cf], 0);
  sim.stop();
  driver.dispose();
});

test('session: a lost write is repeated once while the old value is still set, then reported', async () => {
  {
    const { device, driver } = await driverPair();
    const sim = createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5, dropWrites: 1 });
    assert.ok(await driver.probe({ timeout: 400 }));
    driver.timing = { timeout: 300, gap: 0 };
    const t0 = sim.received.length;
    await driver.writeSetting('balance.trigger_delta', 0.025);
    const sent = sim.received.slice(t0).map((f) => hex(f).toUpperCase());
    const write = hex(P.encodeWrite(0x00a4, 25)).toUpperCase();
    assert.deepEqual(sent, [write, byId('bal-tx-read-settings').hex, write]);
    assert.equal(sim.registers[0x00a4], 25);
    sim.stop();
    driver.dispose();
  }
  {
    const { device, driver } = await driverPair();
    const sim = createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5, dropWrites: 2 });
    assert.ok(await driver.probe({ timeout: 400 }));
    driver.timing = { timeout: 300, gap: 0 };
    await assert.rejects(driver.writeSetting('system.sleep_delay', 7200), /did not apply/);
    assert.equal(sim.registers[0x008a], 3600);
    await assert.rejects(driver.writeSetting('system.battery_type', 1), /read only/);
    await assert.rejects(driver.writeSetting('daly.unknown', 1), /Unknown setting/);
    await assert.rejects(driver.runAction('daly.restart'), /not supported/);
    sim.stop();
    driver.dispose();
  }
});

test('driver: values outside the schema range are refused before anything is sent', async () => {
  const { device, driver } = await driverPair();
  const sim = createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5 });
  assert.ok(await driver.probe({ timeout: 400 }));
  const t0 = sim.received.length;
  /** @type {Array<[string, any]>} */
  const cases = [
    ['system.sleep_delay', 0],
    ['system.sleep_delay', 30],
    ['balance.start_voltage', 0.2],
    ['balance.start_voltage', 4.6],
    ['balance.start_voltage', 65.535],
    ['balance.trigger_delta', 0],
    ['balance.trigger_delta', 'x'],
  ];
  for (const [id, value] of cases) await assert.rejects(driver.writeSetting(id, value), /Invalid value/, `${id} = ${value}`);
  assert.deepEqual(sim.received.slice(t0), [], 'no frame reached the balancer');
  assert.deepEqual([sim.registers[0x008a], sim.registers[0x00a3], sim.registers[0x00a4]], [3600, 3300, 20]);
  // The limits themselves are written.
  await driver.writeSetting('system.sleep_delay', 60);
  await driver.writeSetting('balance.start_voltage', 4.5);
  assert.deepEqual([sim.registers[0x008a], sim.registers[0x00a3]], [60, 4500]);
  sim.stop();
  driver.dispose();
});

test('driver: an exception reply to a write is reported at once, without a read-back or a second write', async () => {
  const { device, driver } = await driverPair();
  const dev = replayDevice(device, capturedReplies(), P.withCrc([P.D2_ADDRESS, P.FN.WRITE | 0x80, 0x02]));
  assert.ok(await driver.probe({ timeout: 400 }));
  driver.timing = { timeout: 1000, gap: 0 };
  const t0 = dev.received.length;
  const start = Date.now();
  await assert.rejects(driver.writeSetting('balance.trigger_delta', 0.025), /rejected the request/);
  assert.ok(Date.now() - start < 500, `${Date.now() - start} ms: no timeout waited`);
  assert.deepEqual(
    dev.received.slice(t0).map((f) => hex(f).toUpperCase()),
    [hex(P.encodeWrite(0x00a4, 25)).toUpperCase()],
  );
  driver.dispose();
});

test('driver: an exception reply to the switch read leaves the settings readable', async () => {
  const { device, driver } = await driverPair();
  replayDevice(device, { ...capturedReplies(), '204:5': P.withCrc([P.D2_ADDRESS, P.FN.READ | 0x80, 0x02]) });
  assert.ok(await driver.probe({ timeout: 400 }));
  const values = await driver.readSettings();
  assert.equal(values['balance.start_voltage'], 3.2);
  assert.equal(values['system.sleep_delay'], 65535);
  assert.equal('switch.balance' in values, false);
  driver.dispose();
});

test('poll: lost switch replies pause the switch block, a stale switch is not shown, the block is read again', async () => {
  const { device, driver } = await driverPair();
  let dropSwitch = 0;
  const sim = createDalyBalancerSimulator(device, {
    stepMs: 0,
    answerDelayMs: 5,
    ignoreRead: (start, count) => {
      if (start !== 0x00cc || count !== 5 || dropSwitch <= 0) return false;
      dropSwitch--;
      return true;
    },
  });
  assert.ok(await driver.probe({ timeout: 400 }));
  driver.timing = { timeout: 200, gap: 0 };
  const switchReads = () => sim.received.filter((f) => hex(f).toUpperCase() === byId('bal-tx-read-00cc-5').hex).length;
  const polls = async (/** @type {number} */ n) => {
    for (let i = 0; i < n; i++) await driver.poll();
  };
  await polls(1);
  assert.deepEqual(driver.lastSnapshot?.switches, { balance: true });
  dropSwitch = 3;
  await polls(1);
  assert.deepEqual(driver.lastSnapshot?.switches, { balance: true }, 'one lost read: the state of the previous poll');
  await polls(1);
  assert.equal(driver.lastSnapshot?.switches, undefined, 'two lost reads: the block is paused, no stale switch');
  const reads = switchReads();
  await polls(15);
  assert.equal(switchReads(), reads, 'skipped for 15 polls');
  assert.equal(driver.lastSnapshot?.switches, undefined);
  assert.equal(typeof driver.lastSnapshot?.balanceCurrent, 'number', 'the balance block is still read');
  await polls(1);
  assert.equal(switchReads(), reads + 1, 'tried again after the pause');
  await polls(15);
  assert.equal(switchReads(), reads + 1, 'lost again: the next pause starts at once');
  // Meanwhile the Daly app on the second UART switched balancing off.
  sim.registers[0x00cf] = 0;
  await polls(1);
  assert.equal(switchReads(), reads + 2);
  assert.deepEqual(driver.lastSnapshot?.switches, { balance: false });
  sim.stop();
  driver.dispose();
});

test('session: Bluetooth auto detection in the combined registry picks the balancer, a D2 BMS stays with daly-modbus', async () => {
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(combined), log, pollIntervalMs: 200 });
    const handle = fakeBleHandle(log, { attach: (device) => createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5 }) });
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'daly-balancer');
      assert.deepEqual(handle.profiles, ['daly-balancer-fff0'], 'found on the first candidate');
    } finally {
      await session.disconnect();
      handle.sims.forEach((s) => s.stop());
    }
  }
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(combined), log, pollIntervalMs: 200 });
    const handle = fakeBleHandle(log, { attach: (device) => createDalyModbusSimulator(device, { tickMs: 0 }) });
    await session.connect({ kind: 'ble', handle, selection: 'family:daly' });
    try {
      assert.equal(session.definition?.id, 'daly-modbus');
      assert.deepEqual(handle.profiles.slice(0, 2), ['daly-balancer-fff0', 'daly-modbus-fff0']);
      assert.deepEqual(
        handle.sims[0].received.map((/** @type {Uint8Array} */ f) => hex(f).toUpperCase()),
        [byId('bal-tx-read-status62').hex],
        'the BMS paid one status read',
      );
    } finally {
      await session.disconnect();
      handle.sims.forEach((s) => s.stop());
    }
  }
});

test('session: serial auto detection finds the balancer first and a classic Daly BMS after it', async () => {
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(combined), log, pollIntervalMs: 200 });
    const port = fakeSerialPort(log, (device) => createDalyBalancerSimulator(device, { stepMs: 0, answerDelayMs: 5 }));
    /** @type {any[]} */
    const snaps = [];
    session.on('snapshot', (s) => snaps.push(s));
    await session.connect({ kind: 'serial', handle: port, selection: 'family:daly' });
    try {
      assert.equal(session.definition?.id, 'daly-balancer');
      assert.equal(port.sims.length, 1);
      assert.equal(/** @type {any} */ (session.driver).serial, true);
      // The poll reads 80 status registers on the UART, which cover the balance block (spec 4.2).
      await waitFor(() => snaps.length >= 2);
      const reads = port.sims[0].received.filter((/** @type {Uint8Array} */ f) => f[1] === P.FN.READ).map((/** @type {Uint8Array} */ f) => hex(f).toUpperCase());
      assert.ok(reads.includes(byId('bal-tx-read-status80').hex), 'the 80 register status read');
      assert.equal(reads.includes(byId('bal-tx-read-block003e').hex), false, 'no separate balance block read');
      assert.equal(reads.filter((/** @type {string} */ h) => h === byId('bal-tx-read-status62').hex).length, 1, 'the 62 register read only in the probe');
      assert.ok(reads.includes(byId('bal-tx-read-00cc-5').hex), 'the switch block');
      assert.equal(typeof snaps.at(-1).balanceCurrent, 'number', 'balance current from the 80 register read');
      assert.equal(snaps.at(-1).switches.balance, true);
    } finally {
      await session.disconnect();
      port.sims.forEach((s) => s.stop());
    }
  }
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(combined), log, pollIntervalMs: 200, probeTimeoutMs: 400 });
    const port = fakeSerialPort(log, (device) => createDalySimulator(device, { tickMs: 0 }));
    await session.connect({ kind: 'serial', handle: port, selection: 'family:daly' });
    try {
      assert.equal(session.definition?.id, 'daly');
      // The classic device ignores D2 (spec 11.4): the balancer and daly-modbus time out, then the
      // classic driver finds it on the third link.
      assert.equal(port.sims.length, 3);
      assert.deepEqual(
        port.sims.map((/** @type {any} */ s) => s.received.length),
        [0, 0, port.sims[2].received.length],
        'the classic simulator sees no D2 request as a frame',
      );
      assert.ok(port.sims[2].received.length > 0);
    } finally {
      await session.disconnect();
      port.sims.forEach((s) => s.stop());
    }
  }
});

test('demo: the simulator connects like the app demo and shows balancing', async () => {
  const demo = dalyBalancerDefinition.demo;
  assert.ok(demo);
  assert.match(demo.name, /\(demo\)$/);
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: demo.chunkSize ?? 0 });
  await device.open();
  const sim = demo.create(device);
  const session = new BmsSession({ registry: new DriverRegistry(combined), log, pollIntervalMs: 1000 });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'link', link: host, selection: 'daly-balancer' });
  try {
    await waitFor(() => snapshots.length >= 1);
    assert.equal(snapshots[0].balancingActive, true);
    assert.ok(snapshots[0].cellStats.delta >= 0.02);
  } finally {
    await session.disconnect();
    sim.stop?.();
  }
});

// ---------------------------------------------------------------------------------------------
// Definition, driver contract, registry
// ---------------------------------------------------------------------------------------------

test('definition: Daly family, balancer type, one FFF0 profile, Daly advertising data, UART 9600', () => {
  const d = dalyBalancerDefinition;
  assert.deepEqual(dalyBalancerDrivers, [d]);
  assert.equal(d.id, 'daly-balancer');
  assert.equal(d.family, 'daly');
  assert.equal(d.vendor, 'Daly BMS', 'the vendor of the Daly BMS definitions');
  assert.equal(d.vendor, dalyModbusDefinition.vendor);
  assert.equal(d.protocol, 'Daly balancer (Modbus D2)');
  assert.equal(d.deviceType, 'balancer');
  assert.ok(d.description && !d.description.includes(EM_DASH));
  const ble = /** @type {import('@ubms/bms-core/driver').BleRequirements} */ (d.links.ble);
  assert.deepEqual(ble.profiles, [
    { id: 'daly-balancer-fff0', label: 'FFF0 (FFF1/FFF2)', service: 0xfff0, notify: 0xfff1, write: 0xfff2, writeMode: 'prefer-without-response', chunkSize: 20 },
  ]);
  for (const key of /** @type {const} */ (['namePrefixes', 'manufacturerIds'])) {
    assert.deepEqual(ble[key], dalyModbusDefinition.links.ble?.[key], key);
    assert.deepEqual(ble[key], dalyDefinition.links.ble?.[key], key);
  }
  assert.deepEqual(ble.namePatterns?.map(String), dalyModbusDefinition.links.ble?.namePatterns?.map(String));
  assert.equal(ble.advertisedServices, undefined, 'no FFF0 service filter: too many foreign devices use FFF0');
  const serial = d.links.serial;
  assert.deepEqual(serial?.profiles, [{ id: 'daly-balancer-uart-9600', label: 'UART 9600 8N1', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' }]);
  assert.ok(serial?.note);
});

test('driver contract: BaseDriver subclass with every method, read only probe, clean dispose', async () => {
  const { device, driver } = await driverPair();
  silentDevice(device);
  assert.ok(driver instanceof BaseDriver);
  assert.ok(driver instanceof DalyBalancerDriver);
  for (const m of ['probe', 'start', 'poll', 'stop', 'readInfo', 'getSettingsSchema', 'readSettings', 'writeSetting', 'runAction', 'dispose']) {
    assert.equal(typeof (/** @type {any} */ (driver)[m]), 'function', m);
  }
  const caps = driver.capabilities;
  assert.equal(caps.settings, true);
  assert.equal(caps.writeSettings, true);
  assert.equal(caps.streaming, false);
  assert.ok(caps.pollIntervalMs >= (caps.minPollIntervalMs ?? 0));
  assert.equal(driver.getSettingsSchema(), driver.getSettingsSchema(), 'stable schema object');
  assert.equal(await driver.probe({ timeout: 400 }), null, 'no answer: null, no exception');
  driver.timing = { timeout: 200, gap: 0 };
  await assert.rejects(driver.poll(), /No answer from the balancer/);
  await assert.rejects(driver.readSettings(), /No answer from the balancer/);
  const info = await driver.readInfo();
  assert.equal(info?.vendor, 'Daly BMS', 'device info without an answer still names the vendor');
  driver.dispose();
});

test('registry: the family combined with the existing drivers', () => {
  const registry = new DriverRegistry(combined);
  assert.equal(new Set(combined.map((d) => d.id)).size, combined.length, 'unique ids');
  const daly = registry.select('family:daly').map((d) => d.id);
  assert.deepEqual(daly.slice(0, 3), ['daly-balancer', 'daly-modbus', 'daly']);
  assert.equal(registry.families().find((f) => f.id === 'daly')?.vendor, 'Daly BMS', 'the type selector label does not change');
  assert.equal(combined.find((d) => d.demo)?.id, 'jk-ble', 'the default demo of the app stays the JK BMS');
  for (const name of ['DL-401804013AEF', 'JHB-123456']) {
    const top = registry.bleCandidates({ name, services: [canonicalUuid(0xfff0)] }).slice(0, 3);
    assert.deepEqual(
      top.map((c) => [c.definition.id, c.profile.id, c.score]),
      [
        ['daly-balancer', 'daly-balancer-fff0', 10],
        ['daly-modbus', 'daly-modbus-fff0', 10],
        ['daly', 'daly-fff0', 10],
      ],
      name,
    );
  }
  // A JBD BMS (FF00 only) never gets a balancer candidate.
  const ff00 = registry.bleCandidates({ name: 'DL-401804013AEF', services: [canonicalUuid(0xff00)] }).map((c) => c.definition.id);
  assert.ok(!ff00.includes('daly-balancer'));
  assert.deepEqual(
    registry.serialCandidates({ selection: 'family:daly' }).map((c) => c.definition.id),
    ['daly-balancer', 'daly-modbus', 'daly'],
  );
  const req = registry.bleRequest({ selection: 'daly-balancer' });
  assert.equal(req.filterable, true);
  const filters = req.request.filters ?? [];
  assert.ok(filters.some((f) => f.namePrefix === 'DL-'));
  assert.ok(filters.some((f) => f.namePrefix === 'JHB-'));
  assert.ok(filters.some((f) => f.manufacturerData?.[0].companyIdentifier === 0x0102));
  assert.ok(req.request.optionalServices.includes(canonicalUuid(0xfff0)));
  const auto = registry.bleRequest({ selection: 'auto' }).request.optionalServices;
  assert.ok(auto.includes(canonicalUuid(0xfff0)));
});

test('files of this family contain no em dash', () => {
  const files = [
    '../src/daly-balancer/protocol.js',
    '../src/daly-balancer/settings.js',
    '../src/daly-balancer/driver.js',
    '../src/daly-balancer/simulator.js',
    '../src/daly-balancer/index.js',
    './vectors/dalybal.json',
    '../../../docs/protocols/daly-balancer.md',
    './dalybal.test.js',
  ];
  for (const f of files) assert.ok(!readFileSync(new URL(f, import.meta.url), 'utf8').includes(EM_DASH), f);
});
