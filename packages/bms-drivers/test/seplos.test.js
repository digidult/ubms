import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ProtocolLog, canonicalUuid, createLinkPair, fromHex, hex, sleep } from '@ubms/transport';
import { BaseDriver, BmsSession, DriverRegistry, SETTING_GROUPS, ALARMS, SETTINGS, fieldMap, validateAll, warnAll } from '@ubms/bms-core';
import * as V2 from '../src/seplos/protocol-v2.js';
import * as V3 from '../src/seplos/protocol-v3.js';
import { FUNCTIONS_GROUP, PROTECTION_SWITCH, V2_INT_IDS, V2_BYTE_IDS, V2_SWITCHES, buildV2Schema, buildV3Schema, decodeV2Settings, decodeV3Settings } from '../src/seplos/settings.js';
import {
  seplosDrivers,
  seplosV2Definition,
  seplosV2BleDefinition,
  seplosV3Definition,
  createSeplosV2Simulator,
  createSeplosV2BleSimulator,
  createSeplosV3Simulator,
  defaultParamBlock,
  plausiblePia,
  plausibleTelemetry,
  v2AsciiSnapshot,
  v2BleSnapshot,
  v3Snapshot,
} from '../src/seplos/index.js';
import { createDalySimulator, createDalyModbusSimulator, dalyDrivers } from '../src/daly/index.js';
import { createJbdSimulator, jbdDrivers } from '../src/jbd/index.js';
import { drivers } from '../src/index.js';

/** @type {Array<{ id: string, variant: string, link: string, direction: 'tx'|'rx', hex: string, description: string, expected: Record<string, any>, expectedComputed?: boolean }>} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/seplos.json', import.meta.url), 'utf8'));
/** @param {string} id */
const byId = (id) => {
  const v = vectors.find((x) => x.id === id);
  if (!v) throw new Error(`no vector ${id}`);
  return v;
};
/** @param {string} id */
const bytesOf = (id) => fromHex(byId(id).hex);

const EM_DASH = String.fromCharCode(0x2014);

/**
 * Deep comparison with a tolerance for numbers; only the keys of `expected` are compared.
 * @param {any} actual
 * @param {any} expected
 * @param {string} path
 */
function near(actual, expected, path) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path}: expected a number, got ${JSON.stringify(actual)}`);
    assert.ok(Math.abs(actual - expected) < 1e-9, `${path}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => near(actual[i], e, `${path}[${i}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    for (const k of Object.keys(expected)) near(actual?.[k], expected[k], `${path}.${k}`);
    return;
  }
  assert.equal(actual, expected, path);
}

/** @param {() => boolean} cond */
async function waitFor(cond, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(10);
  }
  assert.fail('condition not met in time');
}

// ---------------------------------------------------------------------------------------------
// Vector decoding
// ---------------------------------------------------------------------------------------------

/** Keys of `expected` that describe the vector rather than a decoded field; checked separately. */
const META = new Set(['changed', 'infoEqualsRx', 'contentOf', 'action', 'unverified', 'rejected', 'repaired', 'accepted', 'protocolVersion', 'device', 'bit', 'state']);

/** @param {Record<string, any>} e */
const fieldsOf = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !META.has(k)));

/** Start register of the request a V3 answer belongs to (answers do not carry it). */
const V3_START = /** @type {Array<[RegExp, number]>} */ ([
  [/-pia-/, 0x1000],
  [/-pib-/, 0x1100],
  [/-pic-/, 0x1200],
  [/-spa1-/, 0x1300],
  [/-spa2-/, 0x1335],
  [/-sfa-/, 0x1400],
  [/-via-/, 0x1700],
  [/-pct-/, 0x1800],
  [/-eia-/, 0x2000],
  [/-eib-/, 0x2100],
  [/-eic-/, 0x2200],
]);

/** @param {typeof vectors[number]} v */
function decodeAsciiVector(v) {
  const f = V2.parseAscii(fromHex(v.hex));
  assert.ok(f, `${v.id}: frame checks`);
  /** @type {Record<string, any>} */
  const out = { text: f.text, ver: f.ver, adr: f.adr, cid1: f.cid1, length: f.length, lenid: f.lenid, chksum: f.chksum };
  if (v.direction === 'tx') {
    Object.assign(out, { cid2: f.cid2, info: hex(f.info) });
    if (f.cid2 === V2.ASCII_CMD.WRITE_PARAMS) Object.assign(out, V2.parseParamBlock(f.info));
    return { frame: f, out };
  }
  out.rtn = f.cid2;
  if (/-42-/.test(v.id)) Object.assign(out, V2.parseTelemetry(f.info));
  else if (/-44-/.test(v.id)) Object.assign(out, V2.parseAlarmInfo(f.info));
  else if (/-47-/.test(v.id)) Object.assign(out, V2.parseParamBlock(f.info));
  else if (/-51-/.test(v.id)) Object.assign(out, V2.parseAsciiInfo(f.info));
  return { frame: f, out };
}

/** @param {typeof vectors[number]} v */
function decodeBleVector(v) {
  const bytes = fromHex(v.hex);
  const f = V2.parseBleFrame(bytes);
  assert.ok(f, v.id);
  /** @type {Record<string, any>} */
  const out = { ver: f.ver, adr: f.adr, length: f.length, crc: f.crc, crcValid: f.crcValid, endMarkerValid: f.eoiValid };
  if (v.direction === 'tx') {
    Object.assign(out, { cid1: f.b3, cid2: f.b4, data: hex(f.data) });
    if (f.b4 === V2.BLE_CMD.WRITE_PARAMS) Object.assign(out, V2.parseParamBlock(f.data));
    if (f.b4 === V2.BLE_CMD.CAN_PROTOCOL || f.b4 === V2.BLE_CMD.RS485_PROTOCOL) out.value = f.data[0];
    if (f.b4 === V2.BLE_CMD.GROUP) Object.assign(out, { group: f.data[0], device: f.data[1] });
    if (f.b4 === V2.BLE_CMD.SWITCH) Object.assign(out, { bit: f.data[0], state: f.data[1] });
    return { frame: f, out };
  }
  Object.assign(out, { cid: f.b3, rtn: f.b4 });
  if (!f.crcValid) return { frame: f, out };
  if (V2.isParamBlockShape(f.data)) Object.assign(out, V2.parseParamBlock(f.data));
  else if (f.b3 === V2.BLE_CMD.SINGLE) Object.assign(out, V2.parseBleSingle(f.data));
  else if (f.b3 === V2.BLE_CMD.PARALLEL) Object.assign(out, V2.parseBleParallel(f.data));
  else if (f.b3 === V2.BLE_CMD.INFO) Object.assign(out, V2.parseBleInfo(f.data));
  return { frame: f, out };
}

/** @param {typeof vectors[number]} v */
function decodeModbusVector(v) {
  const bytes = fromHex(v.hex);
  if (v.direction === 'tx') {
    const r = V3.parseRequest(bytes);
    assert.ok(r && r.crcValid, `${v.id}: CRC`);
    /** @type {Record<string, any>} */
    const out = { ...r };
    if (r.values) Object.assign(out, { values: hex(r.values), register: r.start, value: (r.values[0] << 8) | r.values[1] });
    return { out };
  }
  const r = V3.parseResponse(bytes);
  assert.ok(r && r.crcValid, `${v.id}: CRC`);
  /** @type {Record<string, any>} */
  const out = { ...r };
  const start = V3_START.find(([re]) => re.test(v.id))?.[1];
  if (r.data) {
    const regs = V3.registers(r.data);
    if (start === 0x1000) Object.assign(out, V3.parsePia(regs));
    else if (start === 0x1100) Object.assign(out, V3.parsePib(regs));
    else if (start === 0x1200 || start === 0x1400 || start === 0x2200) out.bytes = [...r.data];
    else if (start === 0x1700) Object.assign(out, V3.parseVia(r.data));
    else if (start === 0x1800) Object.assign(out, V3.parsePct(r.data));
    else if (start === 0x2000) Object.assign(out, V3.parseEia(regs));
    else if (start === 0x2100) Object.assign(out, V3.parseEib(regs));
    else if (start === 0x1300 || start === 0x1335) Object.assign(out, { start, registers: regs });
  }
  return { out };
}

test('vectors: the file holds 118 frames of the three protocols', () => {
  assert.equal(vectors.length, 118);
  const count = (/** @type {string} */ variant) => vectors.filter((v) => v.variant === variant).length;
  assert.equal(count('SEPLOS_V2_ASCII'), 24);
  assert.equal(count('SEPLOS_V2_BLE'), 35);
  assert.equal(count('SEPLOS_V3_MODBUS'), 59);
  assert.equal(new Set(vectors.map((v) => v.id)).size, vectors.length);
});

test('vectors: every frame decodes to its expected values', async (t) => {
  for (const v of vectors) {
    await t.test(v.id, () => {
      const { out } = v.variant === 'SEPLOS_V2_ASCII' ? decodeAsciiVector(v) : v.variant === 'SEPLOS_V2_BLE' ? decodeBleVector(v) : decodeModbusVector(v);
      near(out, fieldsOf(v.expected), v.id);
    });
  }
});

test('vectors: meta keys (written changes, late answers, unverified commands, empty answers)', () => {
  // The two captured writes are the 0x47 block with only the rated capacity changed (spec 7.1).
  const read = /** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-rx-47-za11')));
  for (const id of ['v2a-tx-a1-rated-170', 'v2a-tx-a1-rated-160']) {
    const v = byId(id);
    const changed = V2.setBlockParam(read.info, 'ratedCapacityAh', v.expected.changed.ratedCapacityAh);
    assert.equal(hex(V2.encodeAscii({ adr: 0, cid2: V2.ASCII_CMD.WRITE_PARAMS, info: changed })), v.hex, id);
  }
  assert.equal(hex(/** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-tx-a1-rated-160'))).info), hex(read.info), 'infoEqualsRx');
  // 0x4F and 0xA1 answers are the same bytes: RTN 0, empty INFO, VER 2.0.
  assert.equal(byId('v2a-rx-4f-empty').hex, byId('v2a-rx-a1-ack').hex);
  const ack = /** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-rx-a1-ack')));
  assert.equal(`${ack.ver >> 4}.${ack.ver & 15}`, byId('v2a-rx-4f-empty').expected.protocolVersion);
  assert.equal(ack.cid2 === V2.RTN.OK, byId('v2a-rx-a1-ack').expected.accepted);
  // A 0x61 answer that carries the parameter block (contentOf 0x47).
  const late = /** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-61-carrying-47')));
  assert.equal(late.b3, V2.BLE_CMD.SINGLE);
  assert.equal(V2.isParamBlockShape(late.data), true);
  assert.equal(byId('v2b-rx-61-carrying-47').expected.contentOf, V2.BLE_CMD.PARAMS);
  // The BLE write example is the document's own 0x47 block sent back.
  assert.equal(hex(V2.encodeBle({ cid: V2.BLE_CMD.WRITE_PARAMS, data: /** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-47-doc'))).data })), byId('v2b-tx-a1-doc').hex);
  // Only the syssi switch command is unverified; it is never part of a driver.
  assert.deepEqual(
    vectors.filter((v) => v.expected.unverified).map((v) => v.id),
    ['v2b-tx-aa-dsg-off', 'v2b-tx-aa-dsg-on'],
  );
  // The repaired frames are valid only with the repair.
  for (const v of vectors.filter((x) => x.expected.repaired)) assert.ok(V3.crcOk(fromHex(v.hex)), v.id);
});

test('encoders: every request vector equals the encoder output', () => {
  for (const v of vectors.filter((x) => x.direction === 'tx')) {
    const e = v.expected;
    if (v.variant === 'SEPLOS_V2_ASCII') {
      if (e.cid2 === V2.ASCII_CMD.WRITE_PARAMS) continue; // checked with the block above
      const info = fromHex(e.info);
      assert.equal(hex(V2.encodeAscii({ adr: e.adr, cid2: e.cid2, info })), v.hex, v.id);
      assert.equal(V2.encodeAscii({ adr: e.adr, cid2: e.cid2, info }).length, v.hex.length / 2);
      if (!/group01|info00/.test(v.id)) assert.equal(hex(V2.encodeAsciiRequest(e.cid2, e.adr)), v.hex, `${v.id} (driver request)`);
    } else if (v.variant === 'SEPLOS_V2_BLE') {
      const bytes = V2.encodeBle({ cid: e.cid2, data: fromHex(e.data) });
      assert.equal(hex(bytes), v.hex, v.id);
      if (e.cid2 === V2.BLE_CMD.INFO || e.cid2 === V2.BLE_CMD.PARALLEL || (e.length === 1 && (e.cid2 === V2.BLE_CMD.SINGLE || e.cid2 === V2.BLE_CMD.PARAMS))) {
        assert.equal(hex(V2.encodeBleRead(e.cid2)), v.hex, `${v.id} (driver request)`);
      }
    } else {
      const bytes = e.function === V3.FN.WRITE_REGISTERS ? V3.encodeWriteRegisters(e.address, e.start, [e.value]) : V3.encodeRead(e.address, e.function, e.start, e.count);
      assert.equal(hex(bytes), v.hex, v.id);
    }
  }
  // Worked examples of the documents (spec 3.1, 3.2).
  assert.equal(V2.lchksum(0x012), 0xd);
  assert.equal(V2.lchksum(2), 0xe);
  // The V2.0 document prints `~1203400456ABCEFEFC72` with the sum 0x038E; its characters sum to
  // 0x038F (CHKSUM 0xFC71), the sum 0x038E belongs to `1203400456ABCDEF` (spec 3.1).
  const ascii = (/** @type {string} */ s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  assert.equal(V2.asciiChecksum(ascii('1203400456ABCEFE')), 0xfc71);
  assert.equal(V2.asciiChecksum(ascii('1203400456ABCDEF')), 0xfc72);
  assert.equal(V2.crcXmodem([0x10, 0x00, 0x46, 0x51, 0x00, 0x00]), 0x3a7f);
  // Blocks of the driver (spec 5.3).
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.PIA)), byId('v3-tx-pia-18').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.PIB)), byId('v3-tx-pib').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.PIC)), byId('v3-tx-pic').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.SFA)), byId('v3-tx-sfa').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.SPA)), byId('v3-tx-spa-full').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.VIA_NAME)), byId('v3-tx-via-10').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.EIB)), byId('v3-tx-eib-22').hex);
  assert.equal(hex(V3.encodeBlockRead(0, V3.BLOCK.CALENDAR)), byId('v3-tx-calendar').hex);
  // MOSFET commands (spec 8.3).
  assert.equal(hex(V3.encodeWriteRegisters(0, V3.SCA.DISCHARGE, [V3.SCA_VALUE.SET])), byId('v3-tx-dsg-off').hex);
  assert.equal(hex(V3.encodeWriteRegisters(0, V3.SCA.DISCHARGE, [V3.SCA_VALUE.CANCEL])), byId('v3-tx-dsg-on').hex);
  assert.equal(hex(V3.encodeWriteRegisters(0, V3.SCA.CHARGE_OFF, [V3.SCA_VALUE.SET])), byId('v3-tx-chg-off').hex);
  assert.equal(hex(V3.encodeWriteRegisters(0, V3.SCA.CHARGE_ON, [V3.SCA_VALUE.CANCEL])), byId('v3-tx-chg-on').hex);
  // Coil write of one SFA byte: 8 coils, byte count 1.
  const coils = V3.parseRequest(V3.encodeWriteCoils(0xe0, 0x1438, 8, [0x0e]));
  assert.deepEqual([coils?.address, coils?.function, coils?.start, coils?.count, coils?.byteCount, coils?.values?.[0], coils?.crcValid], [0xe0, 0x0f, 0x1438, 8, 1, 0x0e, true]);
  // Calendar registers: year low, year high, month, day, hour, minute, second, reserved.
  assert.deepEqual(V3.calendarRegisters(new Date(2026, 10, 19, 13, 5, 9)), [(0xea << 8) | 0x07, (11 << 8) | 19, (13 << 8) | 5, 9 << 8]);
  assert.equal(V3.parseCalendar(Uint8Array.from([0xea, 0x07, 11, 19, 13, 5, 9, 0])).text, '2026-11-19 13:05:09');
});

// ---------------------------------------------------------------------------------------------
// Assemblers
// ---------------------------------------------------------------------------------------------

/** @param {Uint8Array} bytes @param {number[]} sizes */
function chunks(bytes, sizes) {
  const out = [];
  let o = 0;
  for (let i = 0; o < bytes.length; i++) {
    const n = sizes[i % sizes.length];
    out.push(bytes.subarray(o, o + n));
    o += n;
  }
  return out;
}

test('ASCII assembler: chunks, garbage, a restart at a new ~ and a bad checksum', () => {
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = V2.createAsciiAssembler({ onFrame: (f) => frames.push(f) });
  const a = bytesOf('v2a-rx-42-readme-16s');
  const b = bytesOf('v2a-rx-44-za11');
  const broken = Uint8Array.from(a);
  broken[40] = broken[40] === 0x30 ? 0x31 : 0x30;
  const stream = Uint8Array.from([0x00, 0x41, ...a.subarray(0, 50), ...b, 0x0a, ...broken, ...a]);
  for (const c of chunks(stream, [7, 64, 3, 129])) asm.push(c);
  assert.deepEqual(
    frames.map((f) => hex(f)),
    [hex(b), hex(a)],
  );
});

test('BLE assembler: split notifications, a corrupted answer, resynchronisation', () => {
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = V2.createBleAssembler({ onFrame: (f) => frames.push(f) });
  const info = bytesOf('v2b-rx-51-sp76');
  asm.push(info.subarray(0, 35));
  asm.push(info.subarray(35));
  assert.equal(frames.length, 1, 'the 0x51 answer as 35 + 11 bytes (spec 3.2)');
  assert.equal(V2.validBleFrame(bytesOf('v2b-rx-61-corrupted')), false);
  const good = bytesOf('v2b-rx-61-sp76');
  for (const c of chunks(Uint8Array.from([...bytesOf('v2b-rx-61-corrupted'), ...good]), [20])) asm.push(c);
  assert.deepEqual(
    frames.slice(1).map((f) => hex(f)),
    [hex(good)],
  );
});

test('Modbus assembler: echoed request skipped by the byte count check, exception, fragments', () => {
  /** @type {Uint8Array[]} */
  const frames = [];
  let expected = /** @type {number | undefined} */ (36);
  const asm = V3.createModbusAssembler({ onFrame: (f) => frames.push(f), addresses: [0, 1, 0xe0], expectedByteCount: () => expected });
  const echo = bytesOf('v3-tx-pia-18');
  const answer = bytesOf('v3-rx-pia-xzh');
  for (const c of chunks(Uint8Array.from([...echo, ...answer]), [5, 11, 2])) asm.push(c);
  assert.deepEqual(
    frames.map((f) => hex(f)),
    [hex(answer)],
  );
  expected = undefined;
  asm.push(bytesOf('v3-rx-eib-exception'));
  asm.push(bytesOf('v3-rx-write-ack'));
  assert.equal(frames.length, 3);
});

test('assemblers: frames of the other families are never taken for Seplos frames', () => {
  const families = ['daly', 'dalybal', 'jk', 'jk-balancer', 'ant', 'atorch', 'jbd', 'neey'].filter((name) => existsSync(new URL(`./vectors/${name}.json`, import.meta.url)));
  assert.ok(families.length >= 4);
  for (const name of families) {
    /** @type {Array<{ hex: string, direction: string }>} */
    const foreign = JSON.parse(readFileSync(new URL(`./vectors/${name}.json`, import.meta.url), 'utf8'));
    /** @type {Uint8Array[]} */
    const got = [];
    const asms = [
      V2.createAsciiAssembler({ onFrame: (f) => got.push(f) }),
      V2.createBleAssembler({ onFrame: (f) => got.push(f) }),
      // The addresses the driver reads from: 0 and 0xE0 (a configured RS485 address is the user's choice).
      V3.createModbusAssembler({ onFrame: (f) => got.push(f), addresses: [0, 0xe0] }),
    ];
    for (const v of foreign) {
      const bytes = fromHex(v.hex);
      for (const asm of asms) {
        asm.push(bytes);
        asm.reset();
      }
    }
    assert.deepEqual(
      got.map((f) => hex(f)),
      [],
      `${name}: ${foreign.length} frames`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/** @param {import('@ubms/bms-core/settings').SettingsSchema} schema */
function census(schema) {
  const fields = [...fieldMap(schema).values()];
  return {
    fields,
    writable: fields.filter((f) => !f.readOnly && f.type !== 'action'),
    readOnly: fields.filter((f) => f.readOnly),
    actions: fields.filter((f) => f.type === 'action'),
  };
}

/** @param {import('@ubms/bms-core/settings').SettingsSchema} schema @param {string} name */
function checkSchemaShape(schema, name) {
  const groups = new Set([...Object.keys(SETTING_GROUPS), FUNCTIONS_GROUP]);
  for (const g of schema.groups) assert.ok(groups.has(g.id), `${name}: group ${g.id}`);
  const ids = new Set();
  for (const f of census(schema).fields) {
    assert.ok(!ids.has(f.id), `${name}: ${f.id} twice`);
    ids.add(f.id);
    assert.ok(f.meta?.kind, `${name} ${f.id}: meta`);
    if (f.readOnly) assert.ok(f.description, `${name} ${f.id}: read only fields explain why`);
    if (f.type === 'action') assert.equal(f.group, 'actions', `${name} ${f.id}`);
    assert.ok(f.id.startsWith('seplos.') || SETTINGS[f.id], `${name} ${f.id}: canonical id or seplos. prefix`);
    if (f.id.startsWith('seplos.')) assert.notEqual(f.label, f.id, `${name} ${f.id}: label`);
    if (f.type === 'number') {
      assert.ok(Number.isFinite(f.min) && Number.isFinite(f.max) && /** @type {number} */ (f.min) <= /** @type {number} */ (f.max), `${name} ${f.id}: limits`);
      assert.ok(f.step && f.decimals !== undefined, `${name} ${f.id}: step`);
    }
    for (const text of [f.label, f.description ?? '']) assert.ok(!text.includes(EM_DASH), `${name} ${f.id}`);
  }
}

test('settings schema census: V2 parameter block, every parameter, writable through 0xA1', () => {
  const s = buildV2Schema();
  checkSchemaShape(s, 'v2');
  const c = census(s);
  assert.equal(c.fields.length, 60 + 27 + 64);
  assert.equal(c.writable.length, 150);
  assert.deepEqual(
    c.readOnly.map((f) => f.id),
    ['seplos.fn_bluetooth'],
  );
  assert.equal(c.actions.length, 0);
  assert.equal(Object.keys(V2_INT_IDS).length, 60);
  assert.equal(Object.keys(V2_BYTE_IDS).length, 27);
  assert.equal(V2_SWITCHES.length, 64);
  const f = fieldMap(s);
  assert.equal(f.get('system.cell_count')?.danger, true);
  assert.equal(f.get('system.sleep_delay')?.unit, 'h');
  assert.equal(f.get('discharge.ocp2_delay')?.unit, 'ms');
  assert.equal(f.get('balance.enabled')?.group, 'balancing');
  assert.equal(f.get('seplos.fn_event2_1')?.label, 'Cell overvoltage protection');
  assert.equal(f.get('seplos.fn_event2_1')?.group, FUNCTIONS_GROUP);
  // Every enable bit of an alarm, protection, lockout or failure check needs a confirmation
  // (spec 7.2): bytes 1 to 6 except the heating (4.6), the top-up charge (6.1) and soft start (6.7).
  const danger = c.writable.filter((x) => x.type === 'boolean' && x.danger).map((x) => x.id);
  assert.equal(danger.length, 45);
  for (const id of ['seplos.fn_event1_0', 'seplos.fn_event2_1', 'seplos.fn_event2_3', 'seplos.fn_event5_3', 'seplos.fn_event5_5', 'seplos.fn_event6_0', 'seplos.fn_event6_4']) {
    assert.ok(danger.includes(id), id);
    assert.equal(f.get(id)?.description, PROTECTION_SWITCH, id);
  }
  for (const id of ['seplos.fn_event4_6', 'seplos.fn_top_up', 'seplos.fn_soft_start', 'balance.enabled', 'seplos.fn_lcd']) assert.ok(!danger.includes(id), id);
  // Byte 6 bit 1 enables the intermittent (top-up) charge, not an event ([BSX] bit_para).
  assert.equal(f.has('seplos.fn_event6_1'), false);
  assert.deepEqual([f.get('seplos.fn_top_up')?.label, f.get('seplos.fn_top_up')?.meta], ['Top-up charge', { kind: 'switch', byte: 6, bit: 1 }]);
  // Limits from the meaning: 8 to 16 cells, cell positions up to 16, currents never negative.
  assert.deepEqual([f.get('system.cell_count')?.min, f.get('system.cell_count')?.max], [8, 16]);
  for (const id of ['seplos.comp1_cell', 'seplos.comp2_cell']) assert.deepEqual([f.get(id)?.min, f.get(id)?.max], [0, 16], id);
  const amps = c.writable.filter((x) => x.unit === 'A');
  assert.ok(amps.length >= 7);
  for (const x of amps) assert.ok(/** @type {number} */ (x.min) >= 0 && /** @type {number} */ (x.max) <= 1000, x.id);
  // Another block layout makes everything read only.
  const ro = census(buildV2Schema({ writable: false }));
  assert.equal(ro.writable.length, 0);
  assert.ok(ro.readOnly.every((x) => x.description));
});

test('settings schema census: V3 SPA, SFA, MOSFET switches and actions', () => {
  const s = buildV3Schema();
  checkSchemaShape(s, 'v3');
  const c = census(s);
  assert.equal(c.fields.length, 106 + 70 + 2 + 2);
  assert.deepEqual(
    c.readOnly.map((f) => f.meta.reg ?? 0x2000).sort((a, b) => a - b),
    [0x1328, 0x1329, 0x132a, 0x1360, 0x1362, 0x1368, 0x1369, 0x2000],
  );
  assert.equal(c.readOnly.at(-1)?.id ?? '', c.readOnly.find((f) => !f.meta.reg)?.id);
  assert.deepEqual(
    c.readOnly.filter((f) => !f.meta.reg).map((f) => f.id),
    ['seplos.fn_bluetooth'],
  );
  assert.equal(c.writable.length, 106 - 7 + 70 - 1 + 2);
  assert.deepEqual(
    c.actions.map((f) => f.id),
    ['seplos.restart', 'seplos.sync_clock'],
  );
  const f = fieldMap(s);
  assert.equal(f.get('system.cell_count')?.danger, true);
  assert.equal(f.get('system.temp_sensor_count')?.danger, true);
  assert.equal(f.get('switch.discharge')?.danger, true);
  assert.equal(f.get('seplos.restart')?.danger, true);
  assert.equal(f.get('scp.delay')?.unit, 'µs');
  assert.equal(f.get('charge.ocp_delay')?.decimals, 1);
  assert.equal(f.get('switch.buzzer')?.description, 'Buzzer and indicator lights');
  // SFA enables of alarms, protections, lockouts and failure detections need a confirmation
  // (spec 7.4): bytes 0, 1, 2 (not bit 6, heating), 4, 5, 9 and the low SOC alarm and protection.
  const danger = c.writable.filter((x) => x.meta.kind === 'sfa' && x.danger).map((x) => x.id);
  assert.equal(danger.length, 8 + 8 + 7 + 7 + 4 + 8 + 2);
  for (const id of ['seplos.fn_v1', 'seplos.fn_ct3', 'seplos.fn_at7', 'seplos.fn_c1_6', 'seplos.fn_c2_0', 'seplos.fn_fd2', 'seplos.fn_soc_protection']) {
    assert.ok(danger.includes(id), id);
    assert.equal(f.get(id)?.description, PROTECTION_SWITCH, id);
  }
  for (const id of ['seplos.fn_at6', 'seplos.fn_top_up', 'seplos.fn_history', 'balance.enabled', 'seplos.fn_fan']) assert.ok(!danger.includes(id), id);
  // Limits from the meaning: currents 0..1000 A (no negative charge threshold, no 32768 A), cell
  // positions up to 16, at least one cell temperature sensor.
  const amps = c.writable.filter((x) => x.unit === 'A');
  assert.equal(amps.length, 12);
  for (const x of amps) assert.deepEqual([x.min, x.max], [0, 1000], x.id);
  for (const id of ['seplos.comp1_cell', 'seplos.comp2_cell']) assert.deepEqual([f.get(id)?.min, f.get(id)?.max], [0, 16], id);
  assert.deepEqual([f.get('system.temp_sensor_count')?.min, f.get('system.temp_sensor_count')?.max], [1, 4]);
  assert.deepEqual([f.get('system.cell_count')?.min, f.get('system.cell_count')?.max], [1, 16]);
  // The MOSFET switches cancel the off command only; no claim about protections (spec 8.3).
  for (const id of ['switch.charge', 'switch.discharge']) assert.match(String(f.get(id)?.description), /only cancels/, id);
  // Serial link at address 0 (broadcast): nothing writable, no actions.
  const ro = census(buildV3Schema({ writable: false }));
  assert.equal(ro.writable.length, 0);
  assert.equal(ro.actions.length, 0);
  // Two register writes (spec 7.5): the neighbour is never 0x135A, a read only or a missing register.
  assert.equal(V3.spaPairStart(0x130d), 0x130d);
  assert.equal(V3.spaPairStart(0x1359), 0x1358);
  assert.equal(V3.spaPairStart(0x135a), 0x135a);
  assert.equal(V3.spaPairStart(0x1367), 0x1366);
  assert.equal(V3.spaPairStart(0x1327), 0x1326);
  assert.equal(V3.spaPairStart(0x132b), 0x132b);
  for (const r of V3.SPA_REGISTERS) {
    if (r.write === 'no') continue;
    const start = V3.spaPairStart(r.reg);
    assert.ok(start >= V3.SPA_FIRST && start + 1 <= V3.SPA_LAST && (start === r.reg || start + 1 === r.reg), `0x${r.reg.toString(16)}`);
    const other = start === r.reg ? start + 1 : start;
    if (r.reg !== 0x1361) assert.ok(V3.SPA_BY_REG.get(other)?.write !== 'no', `0x${r.reg.toString(16)} neighbour`);
    assert.notEqual(other, 0x135a);
  }
});

test('settings decoding of captured parameter blocks', () => {
  const schema = buildV2Schema();
  const za11 = V2.parseParamBlock(/** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-rx-47-za11'))).info);
  assert.equal(za11.standard, true);
  const v = decodeV2Settings(za11, schema);
  near(
    v,
    {
      'cell.ovp': 3.65,
      'cell.uvp': 2.7,
      'pack.ovp': 57.6,
      'charge.utp': -10,
      'discharge.ocp': 160,
      'discharge.oc_alarm': 155,
      'discharge.ocp2': 300,
      'charge.ocp': 160,
      'capacity.nominal': 160,
      'system.cell_count': 16,
      'seplos.connection_fault_resistance': 10,
      'balance.trigger_delta': 0.03,
      'balance.enabled': true,
      'seplos.fn_static_balance': true,
      'seplos.fn_auto_charge_activation': false,
      'seplos.fn_bluetooth': true,
      'seplos.fn_soft_start': true,
    },
    'za11',
  );
  assert.deepEqual(validateAll(schema, v), {});
  for (const id of ['v2b-rx-47-sp76', 'v2b-rx-47-doc']) {
    const block = V2.parseParamBlock(/** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf(id))).data);
    assert.deepEqual(validateAll(schema, decodeV2Settings(block, schema)), {}, id);
  }
  // A changed field goes back with the sign it is stored with.
  const f = /** @type {any} */ (fieldMap(schema).get('discharge.ocp'));
  const next = V2.setBlockParam(za11.raw, f.meta.key, -170);
  assert.equal(V2.parseParamBlock(next).params.dischargeOcp, -170);
  assert.equal(hex(next.subarray(0, 110)), hex(za11.raw.subarray(0, 110)));

  const spa = new Map();
  for (const [id, start] of [
    ['v3-rx-spa1-sg', 0x1300],
    ['v3-rx-spa2-sg', 0x1335],
  ]) {
    const r = V3.parseResponse(bytesOf(/** @type {string} */ (id)));
    V3.registers(/** @type {Uint8Array} */ (r?.data)).forEach((x, i) => spa.set(/** @type {number} */ (start) + i, x));
  }
  const v3schema = buildV3Schema();
  const sfa = [...(V3.parseResponse(bytesOf('v3-rx-sfa-sp05b-repaired'))?.data ?? [])];
  const values = decodeV3Settings(v3schema, { spa, sfa, fet: 3 }, (reg, raw) => V3.spaValue(/** @type {any} */ (V3.SPA_BY_REG.get(reg)), raw));
  near(
    values,
    {
      'system.cell_count': 16,
      'system.temp_sensor_count': 4,
      'cell.ovp': 3.65,
      'pack.ovp': 57.6,
      'charge.ocp': 210,
      'charge.ocp_delay': 10,
      'discharge.ocp': 210,
      'discharge.ocp2': 350,
      'scp.current': 300,
      'scp.delay': 106,
      'charge.otp': 55,
      'charge.utp': 0,
      'discharge.utp': -3,
      'mos.otp': 110,
      'capacity.nominal': 330,
      'capacity.remaining': 274.56,
      'seplos.discharge_request_current': 180,
      'seplos.inverter_protocol': 0,
      'seplos.current_correction': 8,
      'balance.enabled': true,
      'switch.buzzer': true,
      'seplos.fn_history': true,
      'seplos.fn_bluetooth': true,
      'switch.charge': true,
      'switch.discharge': true,
    },
    'spa',
  );
  assert.deepEqual(validateAll(v3schema, values), {});
  // Round trip of every register through the engineering value.
  for (const r of V3.SPA_REGISTERS) assert.equal(V3.spaRaw(r, V3.spaValue(r, /** @type {number} */ (spa.get(r.reg)))), spa.get(r.reg), `0x${r.reg.toString(16)}`);
});

test('cross-field checks: both sides of every relation, alarms before protections, warnings', () => {
  const v2 = buildV2Schema();
  // A broken pair is reported on both of its fields.
  const errors = validateAll(v2, { 'cell.ovp': 3.6, 'cell.ovpr': 3.65, 'charge.utp': 0, 'charge.utpr': -5, 'seplos.heating_start': 10, 'seplos.heating_stop': 5 });
  assert.deepEqual(Object.keys(errors).sort(), ['cell.ovp', 'cell.ovpr', 'charge.utp', 'charge.utpr', 'seplos.heating_start', 'seplos.heating_stop']);
  assert.equal(errors['cell.ovp'], 'The protection must be above its recovery value');
  assert.equal(errors['cell.ovpr'], 'Recovery must be below protection');

  // The settings view blocks Apply only for an error on the edited field, so an edit of the
  // threshold side must be caught on that field (values: the simulator block and the captured
  // SG16S200A SPA, both free of errors).
  const base2 = decodeV2Settings(V2.parseParamBlock(defaultParamBlock()), v2);
  assert.deepEqual(validateAll(v2, base2), {});
  /** @param {any} schema @param {Record<string, any>} base @param {string} id @param {number} value */
  const errorOf = (schema, base, id, value) => validateAll(schema, { ...base, [id]: value })[id];
  for (const [id, value, message] of [
    ['cell.ovp', 3.55, 'The protection must be above its recovery value'],
    ['cell.uvp', 2.7, 'The protection must be below its recovery value'],
    ['cell.ov_alarm', 3.66, 'The alarm must be below the protection value'],
    ['cell.ovp', 3.63, 'The protection must be above the alarm value'],
    ['cell.uv_alarm', 2.4, 'The alarm must be above the protection value'],
    ['discharge.utp', -5, 'The protection must be below the alarm value'],
    ['charge.ocp', 199, 'The protection must be above the alarm value'],
    ['discharge.ocp2', 200, 'Must be above the level 1 protection'],
    ['seplos.heating_start', 20, 'Heating start temperature must be below the stop temperature'],
    ['seplos.balance_stop_delta', 0.02, 'Stop difference must be below the start difference'],
    ['seplos.low_voltage_charge_forbid', 2.6, 'Must be below the cell undervoltage protection'],
    ['seplos.soc_low_protection', 20, 'The protection must be below the alarm value'],
    ['soc.low_alarm', 4, 'The alarm must be above the protection value'],
    ['seplos.discharge_oc_alarm_recovery', 206, 'Recovery must be below the alarm value'],
    ['discharge.oc_alarm', 202, 'The alarm must be above its recovery value'],
  ]) assert.equal(errorOf(v2, base2, /** @type {string} */ (id), /** @type {number} */ (value)), message, `${id} = ${value}`);

  const v3 = buildV3Schema();
  const spa = new Map();
  for (const [id, start] of [
    ['v3-rx-spa1-sg', 0x1300],
    ['v3-rx-spa2-sg', 0x1335],
  ]) V3.registers(/** @type {Uint8Array} */ (V3.parseResponse(bytesOf(/** @type {string} */ (id)))?.data)).forEach((x, i) => spa.set(/** @type {number} */ (start) + i, x));
  const base3 = decodeV3Settings(v3, { spa }, (reg, raw) => V3.spaValue(/** @type {any} */ (V3.SPA_BY_REG.get(reg)), raw));
  assert.deepEqual(validateAll(v3, base3), {});
  for (const [id, value, message] of [
    ['cell.ovp', 3.3, 'The protection must be above its recovery value'],
    ['seplos.heating_start', 20, 'Heating start temperature must be below the stop temperature'],
    ['seplos.balance_stop_delta', 0.1, 'Stop difference must be below the start difference'],
    ['balance.trigger_delta', 0.02, 'Start difference must be above the stop difference'],
    ['seplos.charge_oc_recovery', 206, 'Recovery must be below the alarm value'],
    ['seplos.discharge_oc_recovery', 206, 'Recovery must be below the alarm value'],
    ['charge.oc_alarm', 202, 'The alarm must be above its recovery value'],
    ['seplos.charge_ocp2', 200, 'Must be above the level 1 protection'],
    ['charge.ocp', 301, 'Must be below the level 2 protection'],
    ['seplos.cell_uv_failure', 2.8, 'The failure voltage must be below the undervoltage protection'],
    ['cell.uvp', 1.9, 'The undervoltage protection must be above the failure voltage'],
    ['cell.uvp', 3.7, 'The protection must be below its recovery value'],
    ['cell.diff_alarm', 1.2, 'The alarm must be below the protection value'],
    ['seplos.mos_ot_alarm', 120, 'The alarm must be below the protection value'],
  ]) assert.equal(errorOf(v3, base3, /** @type {string} */ (id), /** @type {number} */ (value)), message, `${id} = ${value}`);
  // The captured board holds level 2 discharge (350 A) above the short circuit (300 A): no relation.
  assert.deepEqual(validateAll(v3, { ...base3, 'scp.current': 280 }), {});
  // The firmware limits the remaining capacity to the full capacity: a warning, not an error.
  assert.deepEqual(validateAll(v3, { ...base3, 'seplos.full_capacity': 200 }), {});
  assert.deepEqual(Object.keys(warnAll(v3, { ...base3, 'seplos.full_capacity': 200 })).sort(), ['capacity.remaining', 'seplos.full_capacity']);
  // Pack limits against cell limit times cell count (non-blocking).
  assert.deepEqual(warnAll(v2, base2), {});
  assert.deepEqual(Object.keys(warnAll(v2, { ...base2, 'pack.ovp': 50 })), ['pack.ovp']);
  assert.deepEqual(Object.keys(warnAll(v3, { ...base3, 'pack.uvp': 30 })), ['pack.uvp']);
  // Read only schemas carry no checks.
  assert.deepEqual(validateAll(buildV2Schema({ writable: false }), { 'cell.ovp': 3, 'cell.ovpr': 3.5 }), {});
});

// ---------------------------------------------------------------------------------------------
// Snapshots from captured frames
// ---------------------------------------------------------------------------------------------

test('snapshot: V2 ASCII telemetry with the alarm answer', () => {
  const t = V2.parseTelemetry(/** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-rx-42-za11-idle'))).info);
  const a = V2.parseAlarmInfo(/** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-rx-44-za11'))).info);
  const s = v2AsciiSnapshot(t, a);
  assert.equal(s.cells?.length, 16);
  assert.equal(s.voltage, 53.26);
  assert.equal(s.soc, 46.4);
  assert.equal(s.capacityFull, 160);
  assert.equal(s.capacityNominal, 160);
  assert.deepEqual(
    s.temperatures?.map((x) => [x.id, x.kind]),
    [
      ['t1', 'cell'],
      ['t2', 'cell'],
      ['t3', 'cell'],
      ['t4', 'cell'],
      ['ambient', 'ambient'],
      ['mos', 'mos'],
    ],
  );
  assert.deepEqual(s.switches, { charge: true, discharge: true, heater: false });
  assert.deepEqual(s.alarms, []);
  assert.equal(s.extra?.systemState.value, 'Standby');
  assert.equal(s.extra?.portVoltage.value, 53.26);
  assert.equal(s.balancingActive, false);
  assert.equal(plausibleTelemetry(t, 150), true);
  // The readme frame discharges.
  const r = V2.parseTelemetry(/** @type {V2.AsciiFrame} */ (V2.parseAscii(bytesOf('v2a-rx-42-readme-16s'))).info);
  assert.equal(v2AsciiSnapshot(r, null).current, -6.76);
});

test('snapshot: V2 BLE single machine data, balancing, faults of the vendor example', () => {
  const d = V2.parseBleSingle(/** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-61-aio'))).data);
  const s = v2BleSnapshot(d);
  assert.equal(s.current, 11.8);
  assert.deepEqual(
    s.balancing?.flatMap((b, i) => (b ? [i + 1] : [])),
    [10],
  );
  assert.equal(s.balancingActive, true);
  const faults = V2.parseBleSingle(/** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-61-doc-faults'))).data);
  const f = v2BleSnapshot(faults);
  // Events 12 8A 08 00 00 10 00 00 (spec 9.2).
  assert.deepEqual(
    f.alarms?.map((x) => [x.id, x.severity]).sort(),
    [
      ['cell_overvoltage', 'protection'],
      ['cell_undervoltage', 'protection'],
      ['cell_voltage_difference', 'fault'],
      ['charge_undertemperature', 'protection'],
      ['pack_undervoltage', 'protection'],
      ['seplos.low_voltage_charge_forbidden', 'protection'],
      ['temperature_sensor_fault', 'fault'],
    ],
  );
  const uv = f.alarms?.find((x) => x.id === 'cell_undervoltage');
  assert.match(uv?.source ?? '', /cells 1, 2, 3/);
  assert.match(f.alarms?.find((x) => x.id === 'cell_overvoltage')?.source ?? '', /cells 16$/);
  assert.match(f.alarms?.find((x) => x.id === 'charge_undertemperature')?.source ?? '', /sensors 1, 2, 3, 4$/);
  assert.equal(f.extra?.systemState.value, 'Shut down');
  for (const a of f.alarms ?? []) assert.ok(ALARMS[a.id] || a.id.startsWith('seplos.'), a.id);
  // Bank values of a master (0x62).
  const bank = V2.parseBleParallel(/** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-62-sp76'))).data);
  const m = v2BleSnapshot(V2.parseBleSingle(/** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-61-sp76'))).data), bank, 2);
  assert.equal(m.extra?.bankCurrent.value, 55.3);
  assert.equal(m.extra?.packCount.value, 2);
  assert.equal(m.current, 27.56);
  // The extension answer (P = 0) carries no bank values.
  const ext = V2.parseBleParallel(/** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-62-extension'))).data);
  assert.equal(v2BleSnapshot(d, ext, 2).extra?.bankVoltage, undefined);
});

test('snapshot: V3 pack blocks, cell and sensor counts, FET state, bank values', () => {
  const regs = (/** @type {string} */ id) => V3.registers(/** @type {Uint8Array} */ (V3.parseResponse(bytesOf(id))?.data));
  const pia = V3.parsePia(regs('v3-rx-pia-p1-sg'));
  const pib = V3.parsePib(regs('v3-rx-pib-p1-sg'));
  const pic = V3.parsePic(/** @type {Uint8Array} */ (V3.parseResponse(bytesOf('v3-rx-pic-p1-sp05b'))?.data));
  const eia = V3.parseEia(regs('v3-rx-eia-aio'));
  const s = v3Snapshot({ pia, pib, pic, cellCount: 16, ntcCount: 4, ratedAh: 330, eia });
  assert.equal(s.current, -1.37);
  assert.equal(s.capacityNominal, 330);
  assert.equal(s.cells?.length, 16);
  assert.equal(s.temperatures?.length, 6);
  assert.deepEqual(s.switches, { discharge: true, charge: true, heater: false });
  assert.equal(s.extra?.systemState.value, 'Standby');
  assert.deepEqual(s.alarms, []);
  assert.equal(s.extra?.packCount.value, 2);
  assert.equal(s.extra?.bankCurrent.value, -6.7);
  // Fewer cells and sensors than slots.
  const small = v3Snapshot({ pia, pib, pic: null, cellCount: 8, ntcCount: 2 });
  assert.equal(small.cells?.length, 8);
  assert.deepEqual(
    small.temperatures?.map((t) => t.id),
    ['t1', 't2', 'ambient', 'mos'],
  );
  // Event bits with the cells named by the per cell flags (spec 9.9).
  const bits = new Uint8Array(18);
  bits[2] = 0x04; // cell 3 high
  bits[9] = 0x02; // cell overvoltage protection
  bits[12] = 0x24; // charge OCP level 2, discharge OCP level 2
  bits[17] = 0x20; // open wire
  const alarms = V3.v3Alarms(V3.parsePic(bits).state, { cellHigh: V3.parsePic(bits).cellHigh });
  assert.deepEqual(
    alarms.map((a) => [a.id, a.severity, a.label]).sort(),
    [
      ['cell_overvoltage', 'protection', 'Cell overvoltage'],
      ['cell_wire_open', 'fault', 'Cell sense wire disconnected'],
      ['charge_overcurrent', 'protection', 'Charge overcurrent protection, level 2'],
      ['discharge_overcurrent', 'protection', 'Discharge overcurrent protection, level 2'],
    ],
  );
  assert.match(alarms.find((a) => a.id === 'cell_overvoltage')?.source ?? '', /cells 3$/);
  // Current unit by board rating (spec 12).
  assert.equal(V3.currentScaleFromName('SG16S200A-SP57B-A').scale, 0.01);
  assert.equal(V3.currentScaleFromName('BMS16S300A-X').scale, 0.1);
  assert.equal(V3.currentScaleFromName('').scale, 0.01);
  assert.equal(V3.parsePia(regs('v3-rx-pia-p1-sg'), { currentScale: 0.1 }).current, -13.7);
  assert.equal(plausiblePia(pia), true);
  assert.equal(plausiblePia({ ...pia, voltage: 0 }), false);
});

test('protocol log descriptions', () => {
  assert.match(V2.describeAscii(bytesOf('v2a-tx-42-adr00'))?.name ?? '', /telemetry request \(address 0\)/);
  assert.match(V2.describeAscii(bytesOf('v2a-rx-44-za11'), { command: 0x44 })?.name ?? '', /alarms and states answer/);
  assert.equal(V2.describeAscii(bytesOf('v2a-rx-42-readme-16s'), { command: 0x42 })?.decode?.().cellCount, 16);
  assert.match(V2.describeBle(bytesOf('v2b-tx-61'))?.name ?? '', /single machine data request/);
  assert.equal(V2.describeBle(bytesOf('v2b-rx-61-carrying-47'))?.decode?.().intCount, 60);
  assert.match(V3.describeModbus(bytesOf('v3-tx-pib'), { direction: 'tx' })?.name ?? '', /PIB read/);
  assert.equal(V3.describeModbus(bytesOf('v3-rx-via-sg'), { start: 0x1700 })?.decode?.().deviceName, 'SG16S200A-SP57B-A');
  assert.match(V3.describeModbus(bytesOf('v3-rx-eib-exception'))?.name ?? '', /exception 2/);
});

// ---------------------------------------------------------------------------------------------
// Simulators at protocol level
// ---------------------------------------------------------------------------------------------

/**
 * @param {(device: import('@ubms/transport').MemoryLink) => any} attach
 * @param {(onFrame: (f: Uint8Array) => void) => { push: (c: Uint8Array) => void }} assembler
 */
async function deviceHarness(attach, assembler) {
  const { host, device } = createLinkPair({ deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = attach(device);
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = assembler((f) => frames.push(f));
  host.on('data', (/** @type {Uint8Array} */ c) => asm.push(c));
  /** @param {Uint8Array} bytes */
  const ask = async (bytes) => {
    frames.length = 0;
    await host.write(bytes);
    await sleep(20);
    return frames.slice();
  };
  return { sim, ask };
}

test('V3 simulator: block limits, wrong lengths of syssi, writes, MOSFET commands, calendar rule', async () => {
  const { sim, ask } = await deviceHarness(
    (d) => createSeplosV3Simulator(d, { tickMs: 0 }),
    (onFrame) => V3.createModbusAssembler({ onFrame, addresses: [0, 1, 0xe0] }),
  );
  // syssi's lengths get exception 0x02, as captured.
  for (const [tx, rx] of [
    ['v3-tx-eib-26', 'v3-rx-eib-exception'],
    ['v3-tx-sfa-wrong', 'v3-rx-sfa-exception'],
    ['v3-tx-pic-wrong', 'v3-rx-pic-exception'],
  ]) {
    assert.ok(byId(tx).expected.rejected);
    const [f] = await ask(bytesOf(tx));
    assert.equal(hex(f), byId(rx).hex, tx);
  }
  const [via] = await ask(bytesOf('v3-tx-via'));
  assert.equal(V3.parseVia(/** @type {Uint8Array} */ (V3.parseResponse(via)?.data)).manufacturer, 'XZH-ElecTech Co.,Ltd');
  const [spa] = await ask(bytesOf('v3-tx-spa-full'));
  assert.equal(V3.parseResponse(spa)?.byteCount, 212);
  // Two register write saved, one register applied only.
  const [ack] = await ask(V3.encodeWriteRegisters(0xe0, 0x130c, [3400, 3600]));
  assert.deepEqual([V3.parseResponse(ack)?.start, V3.parseResponse(ack)?.count], [0x130c, 2]);
  assert.equal(sim.spa[0x0d], 3600);
  assert.equal(sim.state.saved, 1);
  // MOSFET commands.
  await ask(bytesOf('v3-tx-dsg-off'));
  assert.equal(sim.battery.switches.discharge, false);
  await ask(bytesOf('v3-tx-dsg-on'));
  assert.equal(sim.battery.switches.discharge, true);
  await ask(bytesOf('v3-tx-chg-off'));
  assert.equal(sim.battery.switches.charge, false);
  await ask(bytesOf('v3-tx-chg-on'));
  assert.equal(sim.battery.switches.charge, true);
  // 0x1511 = 0xAA55 cancels the charge off command ([SO] REG_CHG_FET_OFF clears bits 2 and 7).
  await ask(bytesOf('v3-tx-chg-off'));
  const [cancel] = await ask(V3.encodeWriteRegisters(0, V3.SCA.CHARGE_OFF, [V3.SCA_VALUE.CANCEL]));
  assert.deepEqual([V3.parseResponse(cancel)?.start, sim.battery.switches.charge], [V3.SCA.CHARGE_OFF, true]);
  // Other command values: exception 0x03 as in the firmware; more than one register: 0x02.
  const [badValue] = await ask(V3.encodeWriteRegisters(0, V3.SCA.DISCHARGE, [0x1234]));
  assert.equal(V3.parseResponse(badValue)?.exception, 3);
  const [twoRegs] = await ask(V3.encodeWriteRegisters(0, V3.SCA.DISCHARGE, [0x55aa, 0x55aa]));
  assert.equal(V3.parseResponse(twoRegs)?.exception, 2);
  assert.equal(sim.battery.switches.discharge, true);
  // A request with a bad CRC gets exception 0x03 ([SO] Rtu_SlaveRequestCheck, spec 12).
  const corrupted = Uint8Array.from(bytesOf('v3-tx-pia-18'));
  corrupted[7] ^= 0xff;
  const [crcRefused] = await ask(corrupted);
  assert.deepEqual([crcRefused[0], crcRefused[1], V3.parseResponse(crcRefused)?.exception], [0, 0x84, 3]);
  assert.equal(sim.state.badCrc, 1);
  // Busy: the next SPA write gets exception 0x06 once, then the write goes through.
  sim.faults.busyWrites = 1;
  const [busy] = await ask(V3.encodeWriteRegisters(0xe0, 0x130c, [3400, 3610]));
  assert.equal(V3.parseResponse(busy)?.exception, 6);
  assert.equal(sim.spa[0x0d], 3600);
  const [ok] = await ask(V3.encodeWriteRegisters(0xe0, 0x130c, [3400, 3610]));
  assert.equal(V3.parseResponse(ok)?.count, 2);
  assert.equal(sim.spa[0x0d], 3610);
  // The calendar needs history recording (SFA byte 6 bit 4).
  sim.sfa[6] &= ~0x10;
  const [refused] = await ask(bytesOf('v3-tx-calendar'));
  assert.equal(V3.parseResponse(refused)?.exception, 1);
  sim.sfa[6] |= 0x10;
  const [cal] = await ask(bytesOf('v3-tx-calendar'));
  assert.equal(V3.parseResponse(cal)?.byteCount, 8);
  // The Seplos example write of 0x1800, answered like the constructed acknowledgement.
  const [w] = await ask(bytesOf('v3-tx-write-1800'));
  assert.equal(hex(w), byId('v3-rx-write-ack').hex);
  // V2 frames are not Modbus requests: no answer.
  assert.deepEqual(await ask(V2.encodeAsciiRequest(V2.ASCII_CMD.INFO, 0)), []);
  sim.stop();
});

test('V2 simulators: ASCII and BLE answers follow the documented layouts', async () => {
  {
    const { sim, ask } = await deviceHarness(
      (d) => createSeplosV2Simulator(d, { tickMs: 0 }),
      (onFrame) => V2.createAsciiAssembler({ onFrame }),
    );
    const [info] = await ask(V2.encodeAsciiRequest(V2.ASCII_CMD.INFO, 0));
    const p = /** @type {V2.AsciiFrame} */ (V2.parseAscii(info));
    assert.equal(p.lenid, 64);
    assert.equal(V2.plausibleAsciiInfo(p.info), true);
    const [tel] = await ask(V2.encodeAsciiRequest(V2.ASCII_CMD.TELEMETRY, 0));
    const tp = /** @type {V2.AsciiFrame} */ (V2.parseAscii(tel));
    assert.equal(tp.lenid, 150, 'same size as the 16 cell, 6 sensor captures');
    assert.equal(plausibleTelemetry(V2.parseTelemetry(tp.info), tp.lenid), true);
    const [al] = await ask(V2.encodeAsciiRequest(V2.ASCII_CMD.ALARMS, 0));
    assert.equal(/** @type {V2.AsciiFrame} */ (V2.parseAscii(al)).lenid, 98);
    // Another address and Modbus frames are ignored.
    assert.deepEqual(await ask(V2.encodeAsciiRequest(V2.ASCII_CMD.INFO, 3)), []);
    assert.deepEqual(await ask(bytesOf('v3-tx-via-10')), []);
    // An unknown command gets RTN 0x04.
    const [bad] = await ask(V2.encodeAscii({ adr: 0, cid2: 0x45, info: [0, 0] }));
    assert.equal(/** @type {V2.AsciiFrame} */ (V2.parseAscii(bad)).cid2, 0x04);
    // On RS485 COMMAND_GROUP of 0x42 and 0x44 must be the address ([V2PDF] 4.1.1); the refusal
    // code is the simulator's choice.
    for (const cid2 of [V2.ASCII_CMD.TELEMETRY, V2.ASCII_CMD.ALARMS]) {
      const [refused] = await ask(V2.encodeAsciiRequest(cid2, 0, 1));
      assert.equal(/** @type {V2.AsciiFrame} */ (V2.parseAscii(refused)).cid2, 0x05);
    }
    sim.stop();
  }
  {
    // Firmware that does not check the group ([FL] sends group 1 to address 0).
    const { sim, ask } = await deviceHarness(
      (d) => createSeplosV2Simulator(d, { tickMs: 0, checkGroup: false }),
      (onFrame) => V2.createAsciiAssembler({ onFrame }),
    );
    const [tel] = await ask(bytesOf('v2a-tx-42-adr00-group01'));
    assert.equal(/** @type {V2.AsciiFrame} */ (V2.parseAscii(tel)).cid2, 0x00);
    sim.stop();
  }
  {
    const { sim, ask } = await deviceHarness(
      (d) => createSeplosV2BleSimulator(d, { tickMs: 0, slaves: 1 }),
      (onFrame) => V2.createBleAssembler({ onFrame }),
    );
    const [info] = await ask(bytesOf('v2b-tx-51'));
    assert.equal(V2.parseBleFrame(info)?.length, 36);
    const [single] = await ask(bytesOf('v2b-tx-61'));
    assert.equal(V2.parseBleFrame(single)?.length, 106, 'the 16 cell, 6 sensor length of the captures');
    const [bank] = await ask(bytesOf('v2b-tx-62'));
    assert.equal(V2.parseBleFrame(bank)?.length, 48);
    const [block] = await ask(bytesOf('v2b-tx-47'));
    assert.equal(V2.parseBleFrame(block)?.length, 169);
    const [ack] = await ask(V2.encodeBle({ cid: 0xa1, data: /** @type {V2.BleFrame} */ (V2.parseBleFrame(block)).data }));
    assert.deepEqual([V2.parseBleFrame(ack)?.b3, V2.parseBleFrame(ack)?.b4, V2.parseBleFrame(ack)?.length], [0xa1, 0, 0]);
    sim.stop();
  }
  assert.equal(V2.parseParamBlock(defaultParamBlock()).standard, true);
});

// ---------------------------------------------------------------------------------------------
// Definitions and driver contract
// ---------------------------------------------------------------------------------------------

test('definitions: family, links, name patterns, detection order and demo entries', () => {
  assert.deepEqual(
    seplosDrivers.map((d) => d.id),
    ['seplos-v3', 'seplos-v2-ble', 'seplos-v2'],
  );
  for (const d of seplosDrivers) {
    assert.equal(d.family, 'seplos');
    assert.equal(d.vendor, 'Seplos');
    assert.equal(d.deviceType, 'bms');
    assert.ok(d.protocol && d.description);
    assert.equal(typeof d.create, 'function');
    assert.ok(d.demo?.name.endsWith('(demo)'));
    assert.equal(typeof d.demo?.create, 'function');
    for (const text of [d.protocol, d.description ?? '', d.links.serial?.note ?? '']) assert.ok(!text.includes(EM_DASH));
  }
  const v3 = seplosV3Definition.links;
  assert.deepEqual(
    [v3.ble?.profiles[0].service, v3.ble?.profiles[0].notify, v3.ble?.profiles[0].write],
    [0xfff0, 0xfff1, 0xfff2],
  );
  assert.deepEqual(
    v3.serial?.profiles.map((p) => p.baudRate),
    [19200],
  );
  const v2b = seplosV2BleDefinition.links;
  assert.deepEqual(
    [v2b.ble?.profiles[0].service, v2b.ble?.profiles[0].notify, v2b.ble?.profiles[0].write, v2b.serial],
    [0xff00, 0xff01, 0xff02, undefined],
  );
  assert.equal(seplosV2Definition.links.ble, undefined);
  assert.deepEqual(
    seplosV2Definition.links.serial?.profiles.map((p) => p.baudRate),
    [19200, 9600],
  );
  const registry = new DriverRegistry(seplosDrivers);
  const rank = (/** @type {string} */ name, /** @type {number} */ service) =>
    registry.bleCandidates({ name, services: [canonicalUuid(service)] }).map((c) => [c.definition.id, c.score]);
  assert.deepEqual(rank('BP00', 0xff00), [['seplos-v2-ble', 10]]);
  assert.deepEqual(rank('SP05B2312190075', 0xfff0), [['seplos-v3', 10]]);
  assert.deepEqual(rank('SP57B-A2506120022', 0xfff0), [['seplos-v3', 10]]);
  assert.deepEqual(rank('XZH_B40_0123456789ABCD', 0xfff0), [['seplos-v3', 10]]);
  assert.deepEqual(rank('STxyz', 0xfff0), [['seplos-v3', 0]], 'ST is not a name filter');
  assert.deepEqual(
    registry.serialCandidates().map((c) => `${c.definition.id}@${c.profile.baudRate}`),
    ['seplos-v3@19200', 'seplos-v2@19200', 'seplos-v2@9600'],
  );
  const { request } = registry.bleRequest({ selection: 'family:seplos' });
  for (const prefix of ['BP0', 'BP1', 'SP0', 'SP5', 'XZH', 'CSY']) assert.ok(request.filters?.some((f) => f.namePrefix === prefix), prefix);
  assert.ok(!request.filters?.some((f) => f.namePrefix === 'ST'));
  assert.ok(request.optionalServices.includes(canonicalUuid(0xfff0)));
  assert.ok(request.optionalServices.includes(canonicalUuid(0xff00)));
});

test('driver contract: instances, capabilities, silent links give no probe result', async () => {
  for (const def of seplosDrivers) {
    const log = new ProtocolLog();
    const { host, device } = createLinkPair({ log, kind: def.links.ble ? 'memory' : 'serial' });
    await host.open();
    await device.open();
    /** @type {Uint8Array[]} */
    const sent = [];
    device.on('data', (/** @type {Uint8Array} */ c) => sent.push(c));
    const driver = def.create({ link: host, log, profileId: 'direct', options: {} });
    assert.ok(driver instanceof BaseDriver, def.id);
    for (const m of ['probe', 'start', 'poll', 'readInfo', 'readSettings', 'writeSetting', 'runAction', 'getSettingsSchema', 'dispose']) assert.equal(typeof (/** @type {any} */ (driver)[m]), 'function', `${def.id}.${m}`);
    const caps = driver.capabilities;
    assert.equal(caps.settings, true);
    assert.equal(caps.streaming, false);
    assert.ok(caps.pollIntervalMs >= 1000);
    const t0 = Date.now();
    assert.equal(await driver.probe({ timeout: 600 }), null, def.id);
    assert.ok(Date.now() - t0 < 3000, `${def.id}: the probe gives up in time`);
    assert.ok(sent.length > 0, `${def.id}: it asked`);
    await assert.rejects(driver.writeSetting('nope', 1));
    await assert.rejects(driver.runAction('nope'));
    driver.dispose();
    await host.close();
  }
});

/**
 * Commands the probes sent to a simulator, as protocol level names.
 * @param {any} sim
 */
const sentCommands = (sim) => sim.state.received.map((/** @type {any} */ r) => (typeof r === 'number' ? r : (r.function ?? r.cid2)));

test('detection: probes only read and accept their own device', async () => {
  // V3: VIA then nothing else; never function 0x10 or 0x0F.
  {
    const { host, device } = createLinkPair({ deviceChunkSize: 20 });
    await host.open();
    await device.open();
    const sim = createSeplosV3Simulator(device, { tickMs: 0 });
    const d = seplosV3Definition.create({ link: host, log: new ProtocolLog(), profileId: 'direct', options: {} });
    const r = await d.probe({ timeout: 1500 });
    assert.equal(r?.variant, 'SEPLOS_V3_MODBUS');
    assert.equal(r?.confidence, 0.95);
    assert.deepEqual(sentCommands(sim), [0x04]);
    assert.equal(sim.state.received[0].start, 0x1700);
    d.dispose();
    sim.stop();
  }
  // V3 with another manufacturer string: plausible PIA gives 0.7.
  {
    const { host, device } = createLinkPair({ deviceChunkSize: 20 });
    await host.open();
    await device.open();
    const sim = createSeplosV3Simulator(device, { tickMs: 0, manufacturer: 'OEM Battery Co' });
    const d = seplosV3Definition.create({ link: host, log: new ProtocolLog(), profileId: 'direct', options: {} });
    assert.equal((await d.probe({ timeout: 1500 }))?.confidence, 0.7);
    d.dispose();
    sim.stop();
  }
  // V2 BLE: 0x51 then 0x61.
  {
    const { host, device } = createLinkPair({ deviceChunkSize: 20 });
    await host.open();
    await device.open();
    const sim = createSeplosV2BleSimulator(device, { tickMs: 0 });
    const d = seplosV2BleDefinition.create({ link: host, log: new ProtocolLog(), profileId: 'direct', options: {} });
    const r = await d.probe({ timeout: 1500 });
    assert.deepEqual([r?.variant, r?.confidence, r?.info?.model], ['SEPLOS_V2_BLE', 0.95, '1101-SP76']);
    assert.deepEqual(sentCommands(sim), [0x51, 0x61]);
    d.dispose();
    sim.stop();
  }
  // V2 ASCII: 0x51 then 0x42 to the configured address; another address answers nothing.
  for (const address of [0, 5]) {
    const { host, device } = createLinkPair({ kind: 'serial' });
    await host.open();
    await device.open();
    const sim = createSeplosV2Simulator(device, { tickMs: 0, address });
    const d = seplosV2Definition.create({ link: host, log: new ProtocolLog(), profileId: 'direct', options: { address } });
    const r = await d.probe({ timeout: 1500 });
    assert.deepEqual([r?.variant, r?.confidence, r?.info?.model, r?.info?.softwareVersion], ['SEPLOS_V2_ASCII', 0.95, '1101-SP76', '16.4']);
    assert.deepEqual(sentCommands(sim), [0x51, 0x42]);
    assert.deepEqual(
      sim.state.received.map((/** @type {any} */ x) => [x.adr, hex(x.info)]),
      [
        [address, ''],
        [address, hex([address])],
      ],
    );
    d.dispose();
    sim.stop();
  }
});

test('detection: look-alike batteries and the other generation are rejected', async () => {
  /**
   * @param {any} def
   * @param {(device: any) => any} attach
   * @param {string} [kind]
   */
  const probeWith = async (def, attach, kind = 'memory') => {
    const { host, device } = createLinkPair({ deviceChunkSize: 20, kind });
    await host.open();
    await device.open();
    const sim = attach(device);
    const d = def.create({ link: host, log: new ProtocolLog(), profileId: 'direct', options: {} });
    const r = await d.probe({ timeout: 900 });
    d.dispose();
    sim.stop?.();
    await host.close();
    return { r, sim };
  };
  // Boqiang VER 0x26 and Pylontech P = 4 with the same framing.
  assert.equal((await probeWith(seplosV2Definition, (dv) => createSeplosV2Simulator(dv, { tickMs: 0, ver: 0x26 }), 'serial')).r, null);
  assert.equal((await probeWith(seplosV2Definition, (dv) => createSeplosV2Simulator(dv, { tickMs: 0, customCount: 4 }), 'serial')).r, null);
  // The two generations ignore each other's probes (spec 11.3).
  const v3onV2 = await probeWith(seplosV3Definition, (dv) => createSeplosV2Simulator(dv, { tickMs: 0 }), 'serial');
  assert.equal(v3onV2.r, null);
  assert.deepEqual(v3onV2.sim.state.received, [], 'the V2 pack saw no frame of its protocol');
  const v2onV3 = await probeWith(seplosV2Definition, (dv) => createSeplosV3Simulator(dv, { tickMs: 0, addresses: [0x00, 0xe0] }), 'serial');
  assert.equal(v2onV3.r, null);
  assert.deepEqual(v2onV3.sim.state.received, [], 'the V3 pack saw no Modbus request');
  // Daly modules on the shared Bluetooth profiles never pass a Seplos probe, and the other way round.
  assert.equal((await probeWith(seplosV3Definition, (dv) => createDalyModbusSimulator(dv, { tickMs: 0 }))).r, null);
  assert.equal((await probeWith(seplosV3Definition, (dv) => createDalySimulator(dv, { tickMs: 0 }))).r, null);
  assert.equal((await probeWith(seplosV2BleDefinition, (dv) => createDalySimulator(dv, { tickMs: 0 }))).r, null);
  assert.equal((await probeWith(seplosV2BleDefinition, (dv) => createDalyModbusSimulator(dv, { tickMs: 0 }))).r, null);
  for (const daly of dalyDrivers) {
    assert.equal((await probeWith(daly, (dv) => createSeplosV3Simulator(dv, { tickMs: 0 }))).r, null, `${daly.id} on Seplos V3`);
    assert.equal((await probeWith(daly, (dv) => createSeplosV2BleSimulator(dv, { tickMs: 0 }))).r, null, `${daly.id} on Seplos V2 BLE`);
  }
  // JBD shares both Bluetooth profiles too (FF00 is its default, FFF0 the JBD-DH04SC02 layout).
  assert.equal((await probeWith(seplosV2BleDefinition, (dv) => createJbdSimulator(dv, { tickMs: 0 }))).r, null);
  assert.equal((await probeWith(seplosV3Definition, (dv) => createJbdSimulator(dv, { tickMs: 0 }))).r, null);
  const jbd = /** @type {any} */ (jbdDrivers.find((d) => d.id === 'jbd'));
  const jbdOnV3 = await probeWith(jbd, (dv) => createSeplosV3Simulator(dv, { tickMs: 0 }));
  assert.equal(jbdOnV3.r, null, 'jbd on Seplos V3');
  assert.deepEqual(jbdOnV3.sim.state.received, [], 'the V3 pack saw no Modbus request in the JBD frames');
  const jbdOnV2 = await probeWith(jbd, (dv) => createSeplosV2BleSimulator(dv, { tickMs: 0 }));
  assert.equal(jbdOnV2.r, null, 'jbd on Seplos V2 BLE');
  assert.deepEqual(jbdOnV2.sim.state.received, [], 'the V2 module saw no Seplos frame');
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} selection
 * @param {(device: any) => any} attach
 * @param {{ kind?: string, options?: Record<string, any>, drivers?: any[] }} [opts]
 */
async function connect(selection, attach, { kind = 'memory', options, drivers: list = seplosDrivers } = {}) {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(list), log, pollIntervalMs: 1000, probeTimeoutMs: 1500 });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20, kind });
  await device.open();
  const sim = attach(device);
  const first = new Promise((resolve) => session.once('snapshot', resolve));
  await session.connect({ kind: 'link', link: host, selection, options });
  /** @type {any} */
  const snap = await first;
  return { session, sim, snap, log };
}

test('session: V3 over Bluetooth, snapshot, settings, two register write, switch, actions', async () => {
  const { session, sim, snap } = await connect('seplos-v3', (d) => createSeplosV3Simulator(d, { tickMs: 0 }));
  try {
    sim.battery.current = 0;
    assert.equal(session.variant, 'SEPLOS_V3_MODBUS');
    assert.equal(snap.cells.length, 16);
    assert.ok(Math.abs(snap.voltage - snap.cellStats.sum) < 0.05);
    assert.equal(snap.capacityNominal, 280);
    assert.deepEqual(snap.switches, { discharge: true, charge: true, heater: false });
    assert.equal(snap.temperatures.length, 6);
    await waitFor(() => !!session.info?.serialNumber);
    assert.equal(session.info?.serialNumber, 'SP05B2312190075');
    assert.equal(session.info?.model, 'BMS16S200A-SP05B');
    assert.equal(session.info?.extra?.inverterProtocol.value, 'Victron Can Protocol');
    assert.ok(session.info?.extra?.clock.value);

    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    const values = /** @type {Record<string, any>} */ (settings.values);
    assert.equal(values['cell.ovp'], 3.65);
    assert.equal(values['discharge.ocp'], 210);
    assert.equal(values['balance.enabled'], true);
    assert.equal(values['switch.discharge'], true);
    assert.deepEqual(validateAll(/** @type {any} */ (settings.schema), values), {});

    sim.state.received.length = 0;
    const results = await session.writeSettings([
      { id: 'cell.ovp', value: 3.62 },
      { id: 'discharge.ocp', value: 208 },
      { id: 'charge.otp', value: 52.5 },
      { id: 'balance.enabled', value: false },
    ]);
    assert.deepEqual(
      results.map((r) => [r.id, r.ok, r.verified]),
      [
        ['cell.ovp', true, true],
        ['discharge.ocp', true, true],
        ['charge.otp', true, true],
        ['balance.enabled', true, true],
      ],
    );
    assert.equal(sim.spa[0x0d], 3620);
    assert.equal(sim.spa[0x1d], (-208) & 0xffff, 'discharge current stored negative');
    assert.equal(sim.spa[0x32], 2731 + 525);
    assert.equal(sim.sfa[7] & 1, 0);
    const writes = sim.state.received.filter((/** @type {any} */ r) => r.function === 0x10 || r.function === 0x0f);
    assert.ok(writes.every((/** @type {any} */ r) => r.address === 0xe0 && (r.function === 0x0f ? r.count === 8 : r.count === 2)), 'two registers or a whole coil byte');
    assert.equal(sim.state.unsaved, 0);

    const sw = await session.writeSettings([{ id: 'switch.charge', value: false }]);
    assert.deepEqual([sw[0].ok, sw[0].verified], [true, true]);
    assert.equal(sim.forced.chargeOff, true);
    const on = await session.writeSettings([{ id: 'switch.charge', value: true }]);
    assert.equal(on[0].verified, true);
    assert.equal(sim.forced.chargeOff, false);
    // On cancels the off command (0x1511 = 0xAA55, spec 8.3); 0x1515 (command bit 7, effect
    // unverified) is never sent.
    const scaWrites = sim.state.received.filter((/** @type {any} */ r) => r.function === 0x10 && r.start >= 0x1510 && r.start <= 0x1515);
    assert.deepEqual(
      scaWrites.map((/** @type {any} */ r) => [r.start, hex(r.values)]),
      [
        [0x1511, '55AA'],
        [0x1511, 'AA55'],
      ],
    );

    await session.runAction('seplos.restart');
    assert.equal(sim.state.restarts, 1);
    await session.runAction('seplos.sync_clock');
    assert.equal(sim.state.clock?.[0] | (sim.state.clock?.[1] << 8), new Date().getFullYear());
    sim.sfa[6] &= ~0x10;
    await assert.rejects(session.runAction('seplos.sync_clock'), /history recording/);
    // Never a reserved or destructive control register.
    assert.ok(!sim.state.received.some((/** @type {any} */ r) => r.function === 0x10 && [0x1516, 0x1517, 0x1519, 0x151a, 0x151b, 0x151c, 0x151d].includes(r.start)));
    // Read only fields are refused before anything is sent.
    const ro = await session.writeSettings([{ id: 'seplos.inverter_protocol', value: 1 }]);
    assert.equal(ro[0].ok, false);
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: V3 on RS485, broadcast address read only, PC port address writable', async () => {
  {
    const { session, sim } = await connect('seplos-v3', (d) => createSeplosV3Simulator(d, { tickMs: 0, addresses: [0x00] }), { kind: 'serial' });
    try {
      assert.equal(session.driver?.capabilities.writeSettings, false);
      const settings = await session.loadSettings();
      assert.equal(/** @type {any} */ (settings.values)['cell.ovp'], 3.65);
      assert.ok(census(/** @type {any} */ (settings.schema)).writable.length === 0);
      await assert.rejects(session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]));
      assert.ok(!sim.state.received.some((/** @type {any} */ r) => r.function === 0x10 || r.function === 0x0f), 'nothing written to address 0');
    } finally {
      await session.disconnect();
      sim.stop();
    }
  }
  {
    // PC / display port: only 0xE0 answers; the probe tries 0 first, then 0xE0.
    const { session, sim } = await connect('seplos-v3', (d) => createSeplosV3Simulator(d, { tickMs: 0, addresses: [0xe0] }), { kind: 'serial' });
    try {
      assert.deepEqual(
        sim.state.received.slice(0, 1).map((/** @type {any} */ r) => r.address),
        [0xe0],
      );
      assert.equal(session.driver?.capabilities.writeSettings, true);
      const r = await session.writeSettings([{ id: 'cell.uvp', value: 2.75 }]);
      assert.equal(r[0].verified, true);
      assert.equal(sim.spa[0x11], 2750);
    } finally {
      await session.disconnect();
      sim.stop();
    }
  }
  {
    // A configured pack address on the pack link.
    const { session, sim } = await connect('seplos-v3', (d) => createSeplosV3Simulator(d, { tickMs: 0, addresses: [0x03] }), { kind: 'serial', options: { address: 3 } });
    try {
      const r = await session.writeSettings([{ id: 'seplos.static_balance_time', value: 8 }]);
      assert.equal(r[0].verified, true);
      assert.ok(sim.state.received.every((/** @type {any} */ x) => x.address === 3));
    } finally {
      await session.disconnect();
      sim.stop();
    }
  }
});

test('session: V2 over Bluetooth, master with a slave, late parameter answer skipped, block write', async () => {
  const { session, sim, snap } = await connect('seplos-v2-ble', (d) => createSeplosV2BleSimulator(d, { tickMs: 0, slaves: 1, staleParams: true }));
  try {
    assert.equal(session.variant, 'SEPLOS_V2_BLE');
    assert.equal(snap.cells.length, 16);
    assert.equal(snap.temperatures.length, 6);
    assert.equal(snap.extra.packCount.value, 2);
    assert.ok(snap.extra.bankVoltage);
    await waitFor(() => !!session.info?.extra?.canProtocol);
    assert.equal(session.info?.extra?.canProtocol.value, 'Victron');
    assert.equal(session.info?.extra?.batteryType.value, 'Lithium iron phosphate (LFP)');
    const settings = await session.loadSettings();
    const values = /** @type {Record<string, any>} */ (settings.values);
    assert.equal(values['cell.ovp'], 3.65);
    assert.equal(values['discharge.ocp'], 210);
    const results = await session.writeSettings([
      { id: 'pack.ovp', value: 57.6 },
      { id: 'discharge.oc_alarm', value: 204 },
      { id: 'seplos.fn_lcd', value: false },
    ]);
    assert.deepEqual(
      results.map((r) => [r.ok, r.verified]),
      [
        [true, true],
        [true, true],
        [true, true],
      ],
    );
    assert.equal(sim.state.writes, 3);
    const last = V2.parseParamBlock(sim.state.writeData.at(-1));
    assert.equal(last.params.dischargeOcAlarm, -204);
    assert.equal(last.params.packOvp, 57.6);
    const ro = await session.writeSettings([{ id: 'seplos.fn_bluetooth', value: false }]);
    assert.equal(ro[0].ok, false);
    assert.ok(!sim.state.received.some((/** @type {number} */ c) => [0x63, 0x64, 0x65, 0xaa].includes(c)), 'never a protocol, group or switch command');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('V3 driver: busy write retried, corrupted read retried, bank size found later, assumed current unit', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = createSeplosV3Simulator(device, { tickMs: 0, packs: 2, deviceName: 'B-48200-C' });
  const d = /** @type {any} */ (seplosV3Definition.create({ link: host, log, profileId: 'direct', options: {} }));
  try {
    assert.ok(await d.probe({ timeout: 1500 }));
    // EIA lost at the start: the bank size stays unknown instead of "one pack".
    sim.faults.dropEia = 1;
    await d.start();
    assert.equal(d.packCount, undefined);
    assert.ok(log.entries().some((e) => e.kind === 'warn' && /current unit 0\.01 A assumed/.test(e.text ?? '')), 'assumed current unit logged');
    /** @type {any} */
    let snap = null;
    d.on('snapshot', (/** @type {any} */ x) => (snap = x));
    for (let i = 0; i < 30; i++) await d.poll();
    assert.equal(d.packCount, 2, 'EIA asked again while the bank size is unknown');
    assert.equal(snap?.extra?.packCount?.value, 2);
    const eiaReads = sim.state.received.filter((/** @type {any} */ r) => r.start === 0x2000).length;
    assert.equal(eiaReads, 2, 'once at the start, once after 30 polls');
    await d.poll();
    assert.ok(snap?.extra?.bankVoltage, 'bank values on every poll in a bank');
    const info = await d.readInfo();
    assert.match(String(info.extra?.currentUnit?.value), /assumed/);
    // A read refused with exception 0x03 (bad CRC on the line) is sent once more.
    sim.faults.crcErrors = 1;
    const before = sim.state.received.length;
    await d.poll();
    assert.equal(sim.state.badCrc, 1);
    assert.equal(sim.state.received[before].start, sim.state.received[before + 1].start, 'the refused read was repeated');
    // A busy SPA write (exception 0x06) is retried once after a second.
    await d.readSettings();
    sim.faults.busyWrites = 1;
    await d.writeSetting('seplos.static_balance_time', 9);
    assert.equal(sim.spa[0x4f], 9);
    const spaWrites = sim.state.received.filter((/** @type {any} */ r) => r.function === 0x10 && r.start >= 0x1300 && r.start < 0x1370);
    assert.equal(spaWrites.length, 2, 'refused once, then written');
  } finally {
    d.dispose();
    sim.stop();
  }
});

test('V2 BLE driver: a parameter block with another layout is shown read only', async () => {
  // 59 two byte parameters instead of 60 (the remaining capacity left out): 167 bytes.
  const std = defaultParamBlock();
  const block = new Uint8Array(std.length - 2);
  block.set(std.subarray(0, 2 + 2 * 59), 0);
  block.set(std.subarray(2 + 2 * 60), 2 + 2 * 59);
  block[1] = 59;
  assert.equal(V2.isParamBlockLayout(block), true);
  assert.equal(V2.isParamBlockShape(block), false);
  assert.equal(V2.parseParamBlock(block).standard, false);
  const { session, sim } = await connect('seplos-v2-ble', (d) => createSeplosV2BleSimulator(d, { tickMs: 0, paramBlock: block }));
  try {
    const t0 = Date.now();
    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.ok(Date.now() - t0 < 3000, 'answered, not timed out');
    const values = /** @type {Record<string, any>} */ (settings.values);
    assert.equal(values['cell.ovp'], 3.65);
    assert.equal(values['capacity.nominal'], 302);
    assert.equal(values['capacity.remaining'], undefined);
    assert.equal(census(/** @type {any} */ (settings.schema)).writable.length, 0);
    const r = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
    assert.equal(r[0].ok, false);
    assert.equal(sim.state.writes, 0);
  } finally {
    await session.disconnect();
    sim.stop();
  }
  // A 0x61 answer never passes the layout check.
  const single = /** @type {V2.BleFrame} */ (V2.parseBleFrame(bytesOf('v2b-rx-61-sp76'))).data;
  assert.equal(V2.isParamBlockLayout(single), false);
});

test('session: V2 ASCII on RS485, telemetry and alarms, block write with the fresh remaining capacity', async () => {
  const { session, sim, snap } = await connect('seplos-v2', (d) => createSeplosV2Simulator(d, { tickMs: 0, address: 2 }), { kind: 'serial', options: { address: 2 } });
  try {
    assert.equal(session.variant, 'SEPLOS_V2_ASCII');
    assert.equal(snap.cells.length, 16);
    assert.ok(snap.extra.systemState);
    // Cell 4 above the alarm and protection thresholds (event 2 bits 0 and 1, byte alarm 0x02).
    sim.overrides.events = [0, 0x03, 0, 0, 0, 0, 0, 0];
    sim.overrides.cellAlarms = [0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const n = await new Promise((resolve) => session.once('snapshot', resolve));
    const ov = /** @type {any} */ (n).alarms.filter((/** @type {any} */ a) => a.id === 'cell_overvoltage');
    assert.deepEqual(
      ov.map((/** @type {any} */ a) => [a.severity, a.source]),
      [['protection', 'event 2 bit 1, cells 4']],
    );
    sim.overrides.events = null;
    sim.overrides.cellAlarms = null;
    await waitFor(() => session.info?.extra?.protocolVersion?.value === '2.0');
    const settings = await session.loadSettings();
    assert.equal(/** @type {any} */ (settings.values)['system.cell_count'], 16);
    const remaining = Math.round(sim.battery.remainingAh * 100) / 100;
    const r = await session.writeSettings([
      { id: 'capacity.nominal', value: 280 },
      { id: 'seplos.heating_stop', value: 12 },
    ]);
    assert.deepEqual(
      r.map((x) => x.verified),
      [true, true],
    );
    const block = V2.parseParamBlock(sim.block);
    assert.equal(block.params.ratedCapacityAh, 280);
    assert.equal(block.params.remainingCapacityAh, remaining, 'the live value was sent back');
    assert.equal(block.model, '1101-SP76 ');
    assert.ok(sim.state.received.every((/** @type {any} */ x) => x.adr === 2));
    assert.ok(!sim.state.received.some((/** @type {any} */ x) => x.cid2 === 0x45 || x.cid2 === 0x4e), 'no telecontrol or time write');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

/**
 * Fake serial port: every open gets a link pair with a simulator at the matching baud rate.
 * @param {ProtocolLog} log
 * @param {number} baud
 * @param {(device: any) => any} attach
 */
function fakeSerialPort(log, baud, attach) {
  /** @type {any[]} */
  const sims = [];
  /** @type {number[]} */
  const baudRates = [];
  return {
    sims,
    baudRates,
    /** @param {{ baudRate: number }} opts */
    async openLink(opts) {
      baudRates.push(opts.baudRate);
      const { host, device } = createLinkPair({ log, kind: 'serial' });
      await host.open();
      await device.open();
      if (opts.baudRate === baud) sims.push(attach(device));
      return host;
    },
  };
}

/** @param {ProtocolLog} log @param {string} name @param {number[]} services @param {(device: any) => any} attach */
function fakeBleHandle(log, name, services, attach) {
  /** @type {string[]} */
  const profiles = [];
  /** @type {any[]} */
  const sims = [];
  return {
    name,
    profiles,
    sims,
    connected: false,
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

/** The existing drivers with this family after Daly and before Atorch (spec 11.4). */
function combinedDrivers() {
  // Works before and after the family is registered in src/index.js.
  const others = drivers.filter((d) => d.family !== 'seplos');
  const at = others.findIndex((d) => d.family === 'atorch');
  const cut = at < 0 ? others.length : at;
  return [...others.slice(0, cut), ...seplosDrivers, ...others.slice(cut)];
}

test('registry: this family together with the existing drivers', async () => {
  const list = combinedDrivers();
  const registry = new DriverRegistry(list);
  assert.equal(new Set(list.map((d) => d.id)).size, list.length, 'unique ids');
  const ids = list.map((d) => d.id);
  assert.ok(ids.indexOf('seplos-v3') > ids.lastIndexOf('daly'), 'after Daly');
  if (ids.includes('atorch')) assert.ok(ids.indexOf('seplos-v2') < ids.indexOf('atorch'), 'before Atorch');
  // Names decide among the shared profiles.
  const ff00 = registry.bleCandidates({ name: 'BP00', services: [canonicalUuid(0xff00)] });
  assert.equal(ff00[0].definition.id, 'seplos-v2-ble');
  const fff0 = registry.bleCandidates({ name: 'SP05B2312190075', services: [canonicalUuid(0xfff0)] });
  assert.equal(fff0[0].definition.id, 'seplos-v3');
  const daly = registry.bleCandidates({ name: 'DL-401710015C9B', services: [canonicalUuid(0xfff0)] });
  assert.equal(daly[0].definition.family, 'daly');
  assert.ok(daly.findIndex((c) => c.definition.id === 'seplos-v3') > daly.findIndex((c) => c.definition.family === 'daly'));
  // Serial: the Seplos profiles in their trial order, after the Daly ones.
  const serial = registry.serialCandidates().map((c) => `${c.definition.id}@${c.profile.baudRate}`);
  const seplos = serial.filter((s) => s.startsWith('seplos'));
  assert.deepEqual(seplos, ['seplos-v3@19200', 'seplos-v2@19200', 'seplos-v2@9600']);
  // The family selector and the chooser.
  assert.deepEqual(
    registry.families().find((f) => f.id === 'seplos')?.drivers.map((d) => d.id),
    ['seplos-v3', 'seplos-v2-ble', 'seplos-v2'],
  );
  const req = registry.bleRequest({ selection: 'auto' }).request;
  assert.ok(req.filters?.some((f) => f.namePrefix === 'BP0'));
  // With JBD in its recommended place (src/jbd/index.js: jbd before Daly, jbd-up-rs485 after it),
  // which shares FF00 and FFF0 too: names still decide, a renamed device gets the JBD probe first.
  const withJbd = (() => {
    if (list.some((d) => d.family === 'jbd')) return list;
    const out = [...list];
    out.splice(
      out.findIndex((d) => d.family === 'daly'),
      0,
      /** @type {any} */ (jbdDrivers.find((d) => d.id === 'jbd')),
    );
    out.splice(out.map((d) => d.family).lastIndexOf('daly') + 1, 0, /** @type {any} */ (jbdDrivers.find((d) => d.id !== 'jbd')));
    return out;
  })();
  const reg2 = new DriverRegistry(withJbd);
  assert.equal(reg2.bleCandidates({ name: 'BP00', services: [canonicalUuid(0xff00)] })[0].definition.id, 'seplos-v2-ble');
  assert.equal(reg2.bleCandidates({ name: 'SP05B2312190075', services: [canonicalUuid(0xfff0)] })[0].definition.id, 'seplos-v3');
  assert.equal(reg2.bleCandidates({ name: 'SP04S034L4S200A', services: [canonicalUuid(0xff00)] })[0].definition.id, 'jbd', 'JBD model code names are not Seplos names');
  const renamed = reg2.bleCandidates({ name: 'Battery', services: [canonicalUuid(0xff00)] }).map((c) => c.definition.id);
  assert.ok(renamed.includes('seplos-v2-ble') && renamed.indexOf('jbd') < renamed.indexOf('seplos-v2-ble'), renamed.join(', '));

  // Automatic detection over Bluetooth with every driver registered.
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs: 1000 });
    const handle = fakeBleHandle(log, 'BP00', [0xff00, 0x180a], (d) => createSeplosV2BleSimulator(d, { tickMs: 0 }));
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'seplos-v2-ble');
      assert.equal(handle.profiles[0], 'seplos-v2-ff00', 'probed first by name');
    } finally {
      await session.disconnect();
    }
  }
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs: 1000 });
    const handle = fakeBleHandle(log, 'SP05B2312190075', [0xfff0], (d) => createSeplosV3Simulator(d, { tickMs: 0 }));
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'seplos-v3');
      assert.equal(handle.profiles[0], 'seplos-v3-fff0');
    } finally {
      await session.disconnect();
    }
  }
  // A Daly module is still found by the Daly drivers.
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs: 1000 });
    const handle = fakeBleHandle(log, 'DL-40D63C3223A2', [0xfff0], (d) => createDalyModbusSimulator(d, { tickMs: 0 }));
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.family, 'daly');
    } finally {
      await session.disconnect();
    }
  }
  // Serial within the family: V2 at 9600 after the V3 and V2 tries at 19200.
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs: 800 });
    const port = fakeSerialPort(log, 9600, (d) => createSeplosV2Simulator(d, { tickMs: 0 }));
    await session.connect({ kind: 'serial', handle: port, selection: 'family:seplos' });
    try {
      assert.deepEqual(port.baudRates, [19200, 19200, 9600]);
      assert.equal(session.definition?.id, 'seplos-v2');
    } finally {
      await session.disconnect();
    }
  }
});

test('demo entries connect like the app demo', async () => {
  for (const def of seplosDrivers) {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(seplosDrivers), log, pollIntervalMs: 1000, probeTimeoutMs: 1500 });
    const { host, device } = createLinkPair({ log, name: def.demo?.name, kind: 'demo', latencyMs: 2, deviceChunkSize: def.demo?.chunkSize ?? 0 });
    await device.open();
    const sim = /** @type {any} */ (def.demo).create(device);
    const first = new Promise((resolve) => session.once('snapshot', resolve));
    await session.connect({ kind: 'link', link: host, selection: def.id });
    try {
      /** @type {any} */
      const s = await first;
      assert.equal(s.cells.length, 16, def.id);
      const settings = await session.loadSettings();
      assert.equal(settings.error, null, def.id);
    } finally {
      await session.disconnect();
      sim.stop();
      await device.close();
    }
  }
});
