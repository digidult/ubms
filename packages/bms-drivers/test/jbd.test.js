import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ProtocolLog, createLinkPair, fromHex, hex, canonicalUuid } from '@ubms/transport';
import { BaseDriver, BmsSession, DriverRegistry, fieldMap, validateAll, validateValue, warnAll } from '@ubms/bms-core';
import {
  CONTROL,
  REG,
  STATUS,
  VARIANT,
  basicProblem,
  createJbdAssembler,
  ddChecksum,
  describe,
  encodeAppKey,
  encodeBmsPassword,
  encodeControl,
  encodeDd,
  encodeEnterFactory,
  encodeExitFactory,
  encodeFfaa,
  encodeMos,
  encodeRandomRequest,
  encodeRead,
  encodeRootPassword,
  encodeUserPassword,
  encodeWriteU16,
  isValidDd,
  parseAnswer,
  parseBasic,
  parseFfaa,
  parseMac,
  parseRequest,
  passwordCipher,
} from '../src/jbd/protocol.js';
import { createUpAssembler, describeUp, encodeUpStatusRequest, parseUpFrame, upStatusProblem } from '../src/jbd/up.js';
import { upAlarms } from '../src/jbd/up-driver.js';
import { buildJbdSchema, decodeJbdSettings, encodeFieldValue, normaliseLocal } from '../src/jbd/settings.js';
import {
  JbdDriver,
  JbdUpDriver,
  basicSnapshot,
  createJbdSimulator,
  createJbdUpSimulator,
  jbdDefinition,
  jbdDrivers,
  jbdUpRs485Definition,
  upSnapshot,
} from '../src/jbd/index.js';
import { drivers } from '../src/index.js';
import { createDalySimulator } from '../src/daly/index.js';

/** @typedef {{ id: string, variant: string, link: string, direction: 'tx'|'rx', hex: string, description: string, expected: Record<string, any> }} Vector */

/** @type {Vector[]} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/jbd.json', import.meta.url), 'utf8'));
const byId = new Map(vectors.map((v) => [v.id, v]));
/** @param {string} id */
const vec = (id) => {
  const v = byId.get(id);
  assert.ok(v, `vector ${id}`);
  return /** @type {Vector} */ (v);
};

/**
 * Deep comparison of the expected keys with a tolerance for numbers.
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
  if (expected === null || typeof expected !== 'object') {
    assert.equal(actual, expected, path);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${path}: expected an array, got ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((e, i) => near(actual[i], e, `${path}[${i}]`));
    return;
  }
  assert.ok(actual && typeof actual === 'object', `${path}: expected an object, got ${JSON.stringify(actual)}`);
  for (const k of Object.keys(expected)) near(actual[k], expected[k], `${path}.${k}`);
}

/** Keys of `expected` that describe the capture, not the decoded frame. */
const META_KEYS = new Set(['notifications', 'cipher', 'discardedBytes', 'frames', 'frame']);

/** @param {Record<string, any>} e */
const decodedPart = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !META_KEYS.has(k)));

/** @param {Uint8Array} bytes */
function assemble(bytes, chunk = 20) {
  /** @type {Uint8Array[]} */
  const frames = [];
  /** @type {Array<[Uint8Array, string]>} */
  const discarded = [];
  const asm = createJbdAssembler({ onFrame: (f) => frames.push(f), onDiscard: (b, reason) => discarded.push([b, reason]) });
  for (let i = 0; i < bytes.length; i += chunk) asm.push(bytes.subarray(i, i + chunk));
  return { frames, discarded };
}

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

test('vectors: the file has the documented variants and every frame checks out', () => {
  assert.equal(vectors.length, 242);
  assert.deepEqual([...new Set(vectors.map((v) => v.variant))].sort(), ['DAREN', 'JBD', 'JBD_AUTH', 'JBD_UP']);
  assert.equal(new Set(vectors.map((v) => v.id)).size, vectors.length, 'unique ids');
  assert.equal(new Set(vectors.map((v) => v.hex)).size, vectors.length, 'no duplicate frames');
  const dash = String.fromCharCode(0x2014);
  for (const v of vectors) assert.ok(!JSON.stringify(v).includes(dash), `${v.id}: em dash`);
});

test('vectors: every DD answer decodes to its expected values', () => {
  let n = 0;
  for (const v of vectors) {
    if (v.direction !== 'rx' || v.variant === 'JBD_UP' || v.variant === 'JBD_AUTH' || v.id.includes('stream')) continue;
    const f = fromHex(v.hex);
    assert.ok(isValidDd(f), `${v.id}: framing and checksum`);
    near(parseAnswer(f), decodedPart(v.expected), v.id);
    assert.ok(describe(f)?.name, `${v.id}: log name`);
    n++;
  }
  assert.equal(n, 117);
});

test('vectors: every DD request decodes to its expected values', () => {
  let n = 0;
  for (const v of vectors) {
    if (v.direction !== 'tx' || v.variant !== 'JBD') continue;
    const f = fromHex(v.hex);
    assert.ok(isValidDd(f), `${v.id}: framing and checksum`);
    near(parseRequest(f), decodedPart(v.expected), v.id);
    assert.match(describe(f)?.name ?? '', / (read|write)$|factory mode/i, v.id);
    n++;
  }
  assert.equal(n, 101);
});

test('vectors: FF AA module frames and UP frames decode to their expected values', () => {
  for (const v of vectors.filter((x) => x.variant === 'JBD_AUTH')) {
    const f = fromHex(v.hex);
    near(parseFfaa(f), decodedPart(v.expected), v.id);
    assert.ok(v.expected.checksumValid, v.id);
    assert.match(describe(f)?.name ?? '', /^Module /, v.id);
  }
  for (const v of vectors.filter((x) => x.variant === 'JBD_UP')) {
    const f = fromHex(v.hex);
    near(parseUpFrame(f), v.expected, v.id);
    assert.match(describeUp(f)?.name ?? '', /^UP /, v.id);
  }
});

test('vectors: requests equal the encoder output', () => {
  /** @param {string} id @param {Uint8Array} bytes */
  const same = (id, bytes) => assert.equal(hex(bytes), vec(id).hex, id);
  // Plain reads of every register vector (0x03, 0x04, 0x05, 0xAA, EEPROM registers, FB, F6).
  for (const v of vectors) {
    if (v.direction === 'tx' && v.variant === 'JBD' && v.expected.operation === 'read' && v.expected.dataLength === 0) same(v.id, encodeRead(v.expected.register));
  }
  same('btmodule-uart-tx-enter-factory', encodeEnterFactory());
  same('btmodule-uart-tx-exit-factory-discard', encodeExitFactory(false));
  same('tx-exit-factory-save', encodeExitFactory(true));
  same('vendor-v4-tx-mos-discharge-off', encodeMos({ chargeOff: false, dischargeOff: true }));
  same('app-ble-tx-mos-charge-off', encodeMos({ chargeOff: true, dischargeOff: false }));
  same('app-ble-tx-mos-both-on', encodeMos({ chargeOff: false, dischargeOff: false }));
  same('syssi-tx-mos-both-off', encodeMos({ chargeOff: true, dischargeOff: true }));
  same('vendor-v11-tx-0a-reset-capacity', encodeControl(CONTROL.RESET_CAPACITY));
  same('tx-control-0a-0200', encodeControl(CONTROL.CLEAR_HISTORY));
  same('tx-control-0a-0300', encodeControl(CONTROL.RESTART));
  same('tx-control-0a-0400', encodeControl(CONTROL.CLEAR_PROTECTION));
  same('tx-control-0a-0700', encodeControl(CONTROL.AUTO_BALANCE));
  same('vendor-v11-tx-password-pairing', encodeBmsPassword('765828', 'digits'));
  same('btmodule-uart-tx-password-zero', encodeBmsPassword('000000', 'digits'));
  assert.equal(hex(encodeBmsPassword('123456')), 'DD5A060706313233343536FEB877');
  // Register writes of the vectors from the register value.
  for (const v of vectors) {
    if (v.direction === 'tx' && v.expected.operation === 'write' && v.expected.dataLength === 2 && typeof v.expected.raw === 'number') same(v.id, encodeWriteU16(v.expected.register, v.expected.raw));
  }
  // FF AA module frames.
  same('auth-ble-tx-app-key', encodeAppKey());
  same('auth-ble-tx-get-random', encodeRandomRequest());
  same('overkill-ble-tx-rename-module', encodeFfaa(0x07, [0x58, 0x59, 0x5a]));
  same('auth-ble-tx-change-password', encodeFfaa(0x16, [...'123123'].map((c) => c.charCodeAt(0))));
  for (const id of ['auth-ble-tx-password-000000', 'auth-ble-tx-password-123412']) {
    const c = vec(id).expected.cipher;
    same(id, encodeUserPassword(/** @type {Uint8Array} */ (parseMac(c.mac)), c.password, c.random));
  }
  const root = vec('auth-ble-tx-root-37').expected.cipher;
  assert.equal(root.password, 'JBDbtpwd!@#2023');
  same('auth-ble-tx-root-37', encodeRootPassword(/** @type {Uint8Array} */ (parseMac(root.mac)), root.random));
  // UP status requests.
  same('up16s-rs485-tx-status-addr1', encodeUpStatusRequest(1));
  same('up16s-rs485-tx-status-addr2', encodeUpStatusRequest(2));
});

test('vectors: register writes equal the settings encoder for the documented values', () => {
  const schema = fieldMap(buildJbdSchema());
  const cases = [
    ['tx-write-reg-24-example', 'cell.ovp'],
    ['tx-write-reg-25-example', 'cell.ovpr'],
    ['tx-write-reg-26-example', 'cell.uvp'],
    ['tx-write-reg-20-example', 'pack.ovp'],
    ['tx-write-reg-18-example', 'charge.otp'],
    ['tx-write-reg-1a-example', 'charge.utp'],
    ['tx-write-reg-1e-example', 'discharge.utp'],
    ['tx-write-reg-28-example', 'charge.ocp'],
    ['tx-write-reg-29-example', 'discharge.ocp'],
    ['tx-write-reg-2a-example', 'balance.start_voltage'],
    ['tx-write-reg-2b-example', 'balance.trigger_delta'],
    ['tx-write-reg-10-example', 'capacity.nominal'],
  ];
  for (const [id, field] of cases) {
    const v = vec(id);
    const f = schema.get(field);
    assert.ok(f, field);
    assert.equal(f.meta.register, v.expected.register, id);
    const raw = encodeFieldValue(f, v.expected.value, undefined);
    assert.equal(hex(encodeWriteU16(f.meta.register, raw)), v.hex, id);
  }
  // Byte pair 0x3D and the balancer bit of 0x2D are merged into the current word.
  const pairVec = vec('tx-write-reg-3d-example');
  const uv = /** @type {any} */ (schema.get('cell.uvp_delay'));
  assert.equal(encodeFieldValue(uv, pairVec.expected.values['cell.uvp_delay'], Uint8Array.of(0x05, 0x02)), pairVec.expected.raw);
  const bal = /** @type {any} */ (schema.get('balance.enabled'));
  assert.equal(hex(encodeWriteU16(0x2d, encodeFieldValue(bal, false, Uint8Array.of(0x00, 0x06)))), vec('app-ble-tx-balancer-off').hex);
  assert.equal(hex(encodeWriteU16(0x2d, encodeFieldValue(bal, true, Uint8Array.of(0x00, 0x02)))), vec('app-ble-tx-balancer-on').hex);
  // Unknown bits stay unchanged (spec 7.3: bit 12 survives a balancer write).
  assert.equal(encodeFieldValue(bal, false, Uint8Array.of(0x10, 0x06)), 0x1002);
});

test('vectors: split notifications reassemble into one frame, leading noise is dropped', () => {
  for (const v of vectors.filter((x) => x.expected.notifications)) {
    /** @type {Uint8Array[]} */
    const frames = [];
    const asm = createJbdAssembler({ onFrame: (f) => frames.push(f) });
    for (const piece of v.expected.notifications) asm.push(fromHex(piece));
    assert.deepEqual(frames.map((f) => hex(f)), [v.hex], v.id);
  }
  const stream = vec('jbdtool-uart-stream-cells-leading-noise');
  const { frames, discarded } = assemble(fromHex(stream.hex), 5);
  assert.deepEqual(frames.map((f) => hex(f)), stream.expected.frames);
  assert.equal(discarded.reduce((n, [b]) => n + b.length, 0), stream.expected.discardedBytes);
  near(parseAnswer(frames[0]), stream.expected.frame, stream.id);
});

// ---------------------------------------------------------------------------------------------
// Framing and encoders
// ---------------------------------------------------------------------------------------------

test('assembler: 0x77 inside data, bad checksums, FF AA frames only at a chunk start', () => {
  // 0x77 in the data must not end the frame (spec 12 item 2).
  const withEnd = encodeDd(REG.CELLS, STATUS.OK, [0x0d, 0x77, 0x0d, 0x77]);
  assert.deepEqual(assemble(withEnd, 3).frames.map((f) => hex(f)), [hex(withEnd)]);
  // A corrupted frame is dropped; the next valid one is found.
  const good = fromHex(vec('sp04s034-uart-rx-cells').hex);
  const bad = Uint8Array.from(good);
  bad[6] ^= 0x01;
  const r = assemble(Uint8Array.of(...bad, ...good), 64);
  assert.deepEqual(r.frames.map((f) => hex(f)), [hex(good)]);
  assert.ok(r.discarded.some(([, reason]) => reason === 'checksum mismatch'));
  // A module frame at the start of a notification, and one glued to a DD frame.
  const key = fromHex(vec('auth-ble-rx-app-key-password-required').hex);
  const both = assemble(Uint8Array.of(...key, ...good), 64).frames.map((f) => hex(f));
  assert.deepEqual(both, [hex(key), hex(good)]);
  // FF AA bytes inside a pending DD frame are data, not a module frame.
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = createJbdAssembler({ onFrame: (f) => frames.push(f) });
  const data = encodeDd(REG.CELLS, STATUS.OK, [0x0c, 0xff, 0xaa, 0x01, 0x00, 0x16, 0x0c, 0xff]);
  asm.push(data.subarray(0, 5));
  asm.push(data.subarray(5));
  assert.deepEqual(frames.map((f) => hex(f)), [hex(data)]);
});

test('checksum and value helpers', () => {
  assert.equal(ddChecksum(fromHex('DDA50300'), 2, 4), 0xfffd);
  assert.equal(ddChecksum(fromHex('DD000000'), 2, 4), 0x0000, 'acknowledgements carry 0x0000');
  assert.equal(hex(passwordCipher(fromHex('A4C137042DBE'), '000000', 0x62)), 'F65369967FF0');
  assert.deepEqual(Array.from(/** @type {Uint8Array} */ (parseMac('a4-c1-37-04-2d-be'))), [0xa4, 0xc1, 0x37, 0x04, 0x2d, 0xbe]);
  assert.equal(parseMac('A4:C1:37'), null);
  assert.equal(parseMac(7), null);
  assert.equal(normaliseLocal('address', 'a4c137042dbe'), 'A4:C1:37:04:2D:BE');
  assert.throws(() => normaliseLocal('address', 'nope'), /hexadecimal/);
  assert.equal(normaliseLocal('password', 'abc123'), 'abc123');
  assert.throws(() => normaliseLocal('password', 'abc'), /six letters or digits/);
  assert.throws(() => normaliseLocal('bmsPassword', '12345'), /six characters/);
  assert.throws(() => encodeBmsPassword('12a456', 'digits'), RangeError);
});

// ---------------------------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------------------------

/** @param {Vector} v */
const dataOf = (v) => {
  const f = fromHex(v.hex);
  return f.subarray(4, 4 + f[3]);
};

test('detection: every captured 0x03 answer passes the plausibility rules, broken ones do not', () => {
  for (const v of vectors) {
    if (v.direction === 'rx' && v.expected.register === REG.BASIC && v.expected.status === 0) assert.equal(basicProblem(dataOf(v)), null, v.id);
  }
  const d = Uint8Array.from(dataOf(vec('sp04s034-uart-rx-basic')));
  /** @param {(x: Uint8Array) => void} change */
  const broken = (change) => {
    const x = Uint8Array.from(d);
    change(x);
    return basicProblem(x);
  };
  assert.match(String(broken((x) => (x[21] = 0))), /cell count/);
  assert.match(String(broken((x) => (x[21] = 33))), /cell count/);
  assert.match(String(broken((x) => (x[22] = 17))), /NTC count/);
  assert.match(String(broken((x) => (x[22] = 5))), /does not fit/);
  assert.match(String(broken((x) => (x[19] = 101))), /SOC/);
  assert.match(String(broken((x) => ((x[23] = 0x13), (x[24] = 0x00)))), /temperature/);
  assert.match(String(basicProblem(d.subarray(0, 22))), /data length/);
  // Polling checks the structure only: an open NTC (raw 0) is no reason to drop the answer.
  const openNtc = Uint8Array.from(d);
  openNtc[23] = 0;
  openNtc[24] = 0;
  assert.match(String(basicProblem(openNtc)), /temperature/);
  assert.equal(basicProblem(openNtc, { strict: false }), null);
  assert.match(String(basicProblem(Uint8Array.from(d, (v, i) => (i === 21 ? 0 : v)), { strict: false })), /cell count/);
});

/** Hex strings of every frame in the vector files of the other families. */
function foreignFrames() {
  const dir = new URL('./vectors/', import.meta.url);
  /** @type {Array<{ family: string, id: string, bytes: Uint8Array }>} */
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file === 'jbd.json') continue;
    const list = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    for (const v of Array.isArray(list) ? list : (list.vectors ?? [])) {
      const h = v.hex ?? v.frame;
      if (typeof h === 'string' && /^[0-9a-fA-F\s]+$/.test(h) && h.replace(/\s/g, '').length % 2 === 0) out.push({ family: file, id: v.id, bytes: fromHex(h) });
    }
  }
  return out;
}

test('detection: frames of the other families never look like a JBD 0x03 or app key answer', () => {
  const foreign = foreignFrames();
  assert.ok(foreign.length > 300, `foreign vectors: ${foreign.length}`);
  for (const { family, id, bytes } of foreign) {
    for (const chunk of [20, 64, 1000]) {
      for (const f of assemble(bytes, chunk).frames) {
        const accepted = f[0] === 0xdd && f[1] === REG.BASIC && f[2] === STATUS.OK && basicProblem(f.subarray(4, 4 + f[3])) === null;
        assert.ok(!accepted, `${family} ${id}: taken for a JBD 0x03 answer`);
        assert.ok(!(f[0] === 0xff && f[2] === 0x15), `${family} ${id}: taken for an app key answer`);
      }
    }
  }
  // The UP probe rejects the DD answers and the UP master answer for another address.
  const status = fromHex(vec('up16s-rs485-rx-status-addr1').hex);
  assert.equal(upStatusProblem(status, 1), null);
  assert.match(String(upStatusProblem(status, 2)), /address/);
  /** @type {Uint8Array[]} */
  const upFrames = [];
  const upAsm = createUpAssembler({ address: 1, onFrame: (f) => upFrames.push(f) });
  for (const v of vectors.filter((x) => x.variant === 'JBD')) upAsm.push(fromHex(v.hex));
  for (const { bytes } of foreign) upAsm.push(bytes);
  assert.ok(upFrames.every((f) => upStatusProblem(f, 1) !== null), 'no foreign UP status answer');
});

// ---------------------------------------------------------------------------------------------
// Settings schema
// ---------------------------------------------------------------------------------------------

/** @param {import('@ubms/bms-core/settings').SettingsSchema} schema */
function census(schema) {
  const all = [...fieldMap(schema).values()];
  return {
    writable: all.filter((f) => f.type !== 'action' && !f.readOnly).map((f) => f.id),
    readOnly: all.filter((f) => f.readOnly).map((f) => f.id),
    actions: all.filter((f) => f.type === 'action').map((f) => f.id),
  };
}

test('settings schema: census, safety flags, unit mode, hidden registers and locked module', () => {
  // 56 device values (54 EEPROM fields and the two MOSFET switches) plus the values kept in the
  // app: module password and address (Bluetooth only) and the BMS password.
  const ble = census(buildJbdSchema({ ble: true }));
  assert.deepEqual([ble.writable.length, ble.readOnly.length, ble.actions.length], [59, 26, 2]);
  const serial = census(buildJbdSchema({ ble: false }));
  assert.deepEqual([serial.writable.length, serial.readOnly.length, serial.actions.length], [57, 26, 2]);
  assert.ok(!serial.writable.includes('jbd.module_password'));
  assert.deepEqual(ble.actions, ['jbd.reset_capacity', 'jbd.clear_protection']);
  for (const id of ['cell.ovp', 'cell.uvpr', 'pack.ovp', 'charge.ocp', 'discharge.ocp', 'charge.ocp_delay', 'discharge.ocp_recovery', 'charge.otp', 'discharge.utpr', 'balance.enabled', 'balance.charge_only', 'balance.start_voltage', 'balance.trigger_delta', 'capacity.nominal', 'capacity.cycle', 'charge.soc100_voltage', 'jbd.soc90_voltage', 'charge.soc0_voltage', 'switch.charge', 'switch.discharge', 'system.cell_count', 'jbd.ntc_enable_1', 'jbd.cell_ovp_hw', 'jbd.led_enable']) {
    assert.ok(ble.writable.includes(id), `${id} writable`);
  }
  // Unverified per the spec: delay pairs with identical captured bytes, AFE encodings, disputed
  // registers, factory strings, the unit flag and the 100 % table copy.
  for (const id of ['cell.ovp_delay', 'cell.uvp_delay', 'jbd.pack_ovp_delay', 'jbd.charge_otp_delay', 'jbd.discharge_utp_delay', 'scp.delay', 'scp.recovery', 'discharge.ocp2_delay', 'jbd.sc_threshold', 'jbd.self_discharge_rate', 'jbd.switch_time', 'jbd.led_time', 'jbd.shunt_resistance', 'jbd.unit_100ma', 'jbd.function_config', 'jbd.soc100_voltage_table', 'jbd.manufacturer', 'jbd.model', 'jbd.barcode', 'jbd.serial_number', 'jbd.production_date']) {
    assert.ok(ble.readOnly.includes(id), `${id} read only`);
  }
  const f = fieldMap(buildJbdSchema({ ble: true }));
  // Danger: switches, cell count, hardware levels, actions, and the bits that switch temperature
  // protection off (NTC enable) or make the output follow an external switch.
  for (const id of ['switch.charge', 'switch.discharge', 'system.cell_count', 'jbd.cell_ovp_hw', 'jbd.cell_uvp_hw', 'jbd.reset_capacity', 'jbd.clear_protection', 'jbd.ntc_enable_1', 'jbd.ntc_enable_8', 'jbd.switch_input']) {
    assert.equal(f.get(id)?.danger, true, `${id} danger`);
  }
  assert.match(String(f.get('jbd.ntc_enable_3')?.description), /temperature protection off/);
  assert.match(String(f.get('jbd.switch_input')?.description), /output can stay off/);
  for (const f2 of f.values()) {
    if (f2.readOnly) assert.ok(f2.description, `${f2.id}: read only fields say why`);
  }
  // 0 A would trip on any current.
  assert.equal(f.get('charge.ocp')?.min, 1);
  assert.equal(f.get('discharge.ocp')?.min, 1);
  assert.ok(validateValue(/** @type {any} */ (f.get('charge.ocp')), 0));
  // Daren clones: nothing to read or write (no source documents factory mode on them); a locked
  // module still shows its login fields.
  assert.equal(fieldMap(buildJbdSchema({ ble: true, variant: VARIANT.DAREN })).size, 0);
  assert.deepEqual([...fieldMap(buildJbdSchema({ ble: true, locked: true, variant: VARIANT.DAREN })).keys()], ['jbd.module_password', 'jbd.module_address']);
  // 100 mA units: capacities and currents read only, ten times the range.
  const u = fieldMap(buildJbdSchema({ unit100: true }));
  for (const id of ['capacity.nominal', 'capacity.cycle', 'charge.ocp', 'discharge.ocp']) assert.equal(u.get(id)?.readOnly, true, id);
  assert.equal(u.get('charge.ocp')?.max, 3276.7);
  // Refused registers disappear, a locked module shows only the login fields.
  const m = fieldMap(buildJbdSchema({ missing: new Set([0x42, 0x47, 0x31]) }));
  assert.ok(!m.has('jbd.soc90_voltage') && !m.has('jbd.soc100_voltage_table') && !m.has('jbd.led_time') && m.has('jbd.soc80_voltage'));
  assert.deepEqual([...fieldMap(buildJbdSchema({ ble: true, locked: true })).keys()], ['jbd.module_password', 'jbd.module_address']);
});

test('settings schema: validators and warnings', () => {
  const schema = buildJbdSchema();
  const ok = { 'cell.ovp': 3.65, 'cell.ovpr': 3.55, 'cell.uvp': 2.5, 'cell.uvpr': 2.7, 'charge.otp': 65, 'charge.otpr': 55, 'charge.utp': -10, 'charge.utpr': 0 };
  assert.deepEqual(validateAll(schema, ok), {});
  assert.ok(validateAll(schema, { ...ok, 'cell.ovpr': 3.7 })['cell.ovpr']);
  assert.ok(validateAll(schema, { ...ok, 'cell.uvpr': 2.4 })['cell.uvpr']);
  assert.ok(validateAll(schema, { ...ok, 'charge.utpr': -20 })['charge.utpr']);
  // Pack limits, balancing start against the overvoltage, temperature windows (both sides).
  const pack = validateAll(schema, { 'pack.ovp': 40, 'pack.ovpr': 39, 'pack.uvp': 45, 'pack.uvpr': 46 });
  assert.ok(pack['pack.ovp'] && pack['pack.uvp']);
  assert.deepEqual(validateAll(schema, { 'pack.ovp': 58.4, 'pack.ovpr': 56.8, 'pack.uvp': 40, 'pack.uvpr': 43.2 }), {});
  const bal = validateAll(schema, { ...ok, 'balance.start_voltage': 3.7 });
  assert.ok(bal['balance.start_voltage'] && bal['cell.ovp']);
  assert.deepEqual(validateAll(schema, { ...ok, 'balance.start_voltage': 3.4 }), {});
  const temp = validateAll(schema, { 'charge.otp': 5, 'charge.utp': 10, 'discharge.otp': 5, 'discharge.utp': 10 });
  assert.ok(temp['charge.otp'] && temp['charge.utp'] && temp['discharge.otp'] && temp['discharge.utp']);
  // Every NTC disabled: a warning on the first enable bit.
  const ntcOff = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`jbd.ntc_enable_${i + 1}`, false]));
  assert.match(String(warnAll(schema, ntcOff)['jbd.ntc_enable_1']), /temperature protection is off/);
  assert.equal(warnAll(schema, { ...ntcOff, 'jbd.ntc_enable_4': true })['jbd.ntc_enable_1'], undefined);
  const warn = warnAll(schema, { 'pack.ovp': 70, 'cell.ovp': 3.65, 'system.cell_count': 16, 'jbd.cell_ovp_hw': 3.6, 'charge.soc0_voltage': 2.8, 'jbd.soc10_voltage': 3.1, 'jbd.soc20_voltage': 3.2 });
  assert.ok(warn['pack.ovp'] && warn['jbd.cell_ovp_hw'] && warn['charge.soc100_voltage'] === undefined);
  assert.equal(warnAll(schema, { 'pack.ovp': 58.4, 'cell.ovp': 3.65, 'system.cell_count': 16 })['pack.ovp'], undefined);
  assert.ok(warnAll(schema, { 'charge.soc0_voltage': 2.8, 'jbd.soc20_voltage': 3.3, 'jbd.soc10_voltage': 3.4, 'charge.soc100_voltage': 3.5 })['charge.soc100_voltage']);
});

test('settings decoding of the captured SP04S034 EEPROM read', () => {
  /** @type {Map<number, Uint8Array>} */
  const regs = new Map();
  for (const v of vectors) {
    if (v.id.startsWith('sp04s034-ble-rx-reg-') || v.id === 'app-ble-rx-func-config' || v.id === 'app-ble-rx-ntc-config') regs.set(v.expected.register, dataOf(v));
  }
  const values = decodeJbdSettings(buildJbdSchema(), regs);
  near(values, {
    'capacity.nominal': 280,
    'capacity.cycle': 224,
    'cell.ovp': 3.65,
    'cell.ovpr': 3.55,
    'cell.uvp': 2.5,
    'cell.uvpr': 2.7,
    'pack.ovp': 14.6,
    'charge.ocp': 230,
    'discharge.ocp': 230,
    'charge.otp': 75,
    'charge.utp': -10,
    'balance.start_voltage': 3.2,
    'balance.trigger_delta': 0.03,
    'balance.enabled': true,
    'balance.charge_only': false,
    'jbd.load_detect': true,
    'cell.ovp_delay': 2,
    'charge.ocp_delay': 10,
    'charge.ocp_recovery': 30,
    'jbd.shunt_resistance': 0.1,
    'system.cell_count': 4,
    'jbd.ntc_enable_3': true,
    'jbd.ntc_enable_4': false,
    'scp.recovery': 100,
    'jbd.sc_threshold': 155,
    'scp.delay': 100,
    'discharge.ocp2_delay': 320,
    'jbd.function_config': '0x0006',
    'jbd.model': 'JBD-SP04S034-L4S-200A-B-U',
    'jbd.production_date': '2022-03-28',
    'jbd.self_discharge_rate': 2,
  }, 'values');
});

// ---------------------------------------------------------------------------------------------
// Snapshot mapping
// ---------------------------------------------------------------------------------------------

test('snapshot: cells, balancing flags, temperatures, switches, alarms and the V11 tail', () => {
  const b = parseBasic(dataOf(vec('clrd-8s-uart-rx-basic-balancing')));
  const cells = parseAnswer(fromHex(vec('clrd-8s-uart-rx-cells').hex)).cellVoltages;
  const s = basicSnapshot(b, { cells, balanceSwitch: true });
  assert.equal(s.cells?.length, 8);
  assert.deepEqual(s.balancing?.map((x, i) => (x ? i : -1)).filter((i) => i >= 0), b.balancingCells);
  assert.equal(s.balancingActive, true);
  assert.deepEqual(s.switches, { charge: true, discharge: true, balance: true });
  assert.deepEqual(s.temperatures?.map((t) => t.id), b.temperatures.map((/** @type {number} */ _, /** @type {number} */ i) => `t${i + 1}`));
  // Software lock (bit 12) is an info alarm, the FET byte is kept as an extra.
  const lock = basicSnapshot(parseBasic(dataOf(vec('readme-uart-rx-basic-mos-lock'))));
  assert.deepEqual(lock.alarms?.map((a) => [a.id, a.severity]), [['jbd.mos_software_lock', 'info']]);
  assert.deepEqual(lock.switches, { charge: false, discharge: true });
  assert.equal(lock.extra?.fetStatus.value, '0x02');
  // V11 tail: full charge capacity; Fogstar unit flag: ten times the raw values.
  const dp = basicSnapshot(parseBasic(dataOf(vec('dp04s007-ble-rx-basic-extended'))));
  assert.equal(dp.capacityFull, 200);
  const fog = basicSnapshot(parseBasic(dataOf(vec('fogstar-ble-rx-basic-100ma-units'))));
  assert.deepEqual([fog.current, fog.capacityRemaining, fog.capacityNominal], [-5.8, 471.9, 628]);
  assert.ok(fog.extra?.unit);
  // Tail alarm bits are warnings; a protection with the same meaning wins.
  const d = Uint8Array.from(dataOf(vec('dp04s007-ble-rx-basic-extended')));
  d[16] = 0x00;
  d[17] = 0x01; // protection: cell overvoltage
  d[23 + 2 + 1] = 0x04;
  d[23 + 2 + 2] = 0x01 | 0x04 | 0x08; // tail: cell overvoltage, pack overvoltage... bits 0, 2, 3 and 10
  const both = basicSnapshot(parseBasic(d));
  assert.deepEqual(both.alarms?.map((a) => [a.id, a.severity]), [
    ['cell_overvoltage', 'protection'],
    ['pack_overvoltage', 'warning'],
    ['pack_undervoltage', 'warning'],
    ['cell_voltage_difference', 'warning'],
  ]);
  // Mismatched cell counts raise the alarm only when the driver asks for it.
  assert.ok(basicSnapshot(b, { cells: cells.slice(0, 7), cellCountMismatch: true }).alarms?.some((a) => a.id === 'cell_count_mismatch'));
  // An open NTC (raw 0 = -273.1 °C) is left out and reported as a sensor fault.
  const open = Uint8Array.from(dataOf(vec('ap21s001-uart-rx-basic-extended-16s')));
  open[25] = 0;
  open[26] = 0;
  const so = basicSnapshot(parseBasic(open));
  assert.deepEqual(so.temperatures?.map((t) => t.id), ['t1', 't3']);
  assert.deepEqual(so.alarms?.map((a) => [a.id, a.severity, a.source]), [['temperature_sensor_fault', 'fault', 'NTC 2']]);
});

test('parser: a V11 tail needs the copy of d4, Daren tails stay raw, the unit bit of 0x2D scales 0x03', () => {
  // Constructed Daren extended frame ([AIO] daren_bms.py offsets): the MOSFET and ambient
  // temperature bytes must not become tail alarm bits or a full charge capacity.
  const daren = parseBasic(dataOf(vec('daren-ble-rx-basic-16s-extended')));
  assert.equal(daren.extension, undefined);
  assert.equal(daren.extraBytes, '0B870B9464000000034904B00000FFAF');
  const ds = basicSnapshot(daren);
  assert.deepEqual(ds.alarms, []);
  assert.equal(ds.capacityFull, undefined);
  assert.deepEqual([ds.current, ds.capacityRemaining, ds.capacityNominal], [-8.07, 84.12, 120]);
  // A real V11 tail (1 NTC: tail at d25, the copy of d4 at d30): decoded, but never for a Daren
  // clone, and not when the copy does not match.
  const dp = dataOf(vec('dp04s007-ble-rx-basic-extended'));
  assert.ok(parseBasic(dp).extension);
  const asDaren = parseBasic(dp, { variant: VARIANT.DAREN });
  assert.equal(asDaren.extension, undefined);
  assert.equal(typeof asDaren.extraBytes, 'string');
  const broken = Uint8Array.from(dp);
  broken[30] ^= 0x01;
  broken[26] = 0xff; // would be tail alarm bits
  const bb = parseBasic(broken);
  assert.equal(bb.extension, undefined);
  assert.deepEqual(basicSnapshot(bb).alarms, []);
  assert.equal(basicSnapshot(bb).capacityFull, undefined);
  // Bit 12 of 0x2D, once read: 100 mA / 100 mAh units without an in-frame flag ([V11]).
  const plain = dataOf(vec('sp04s034-uart-rx-basic'));
  const p1 = parseBasic(plain);
  const p10 = parseBasic(plain, { unit100: true });
  assert.deepEqual([p1.unit100mA, p10.unit100mA], [false, true]);
  assert.ok(Math.abs(p10.nominalCapacity - p1.nominalCapacity * 10) < 1e-6);
  assert.ok(Math.abs(p10.remainingCapacity - p1.remainingCapacity * 10) < 1e-6);
});

test('UP alarms: protection bits are protections or faults, [DSB] bit 27 and alarm bit 18', () => {
  const a = upAlarms({ protectionBits: 2 ** 13 + 2 ** 17 + 2 ** 19 + 2 ** 24 + 2 ** 27, alarmBits: 2 ** 15 + 2 ** 18 });
  assert.deepEqual(
    a.map((x) => [x.id, x.severity]),
    [
      ['ambient_overtemperature', 'protection'],
      ['soc_low', 'protection'],
      ['cell_wire_open', 'fault'],
      ['jbd.up_aerosol_fault', 'fault'],
      ['jbd.up_reverse_protection', 'protection'],
      ['jbd.up_full_charge', 'warning'],
    ],
  );
  assert.equal(a.find((x) => x.id === 'jbd.up_reverse_protection')?.label, 'Reverse protection');
  assert.equal(a.find((x) => x.id === 'jbd.up_full_charge')?.label, 'Full charge protection');
});

test('UP snapshot: captured master pack', () => {
  const st = parseUpFrame(fromHex(vec('up16s-rs485-rx-status-addr1').hex)).status;
  const s = upSnapshot(st);
  assert.equal(s.cells?.length, 16);
  assert.equal(s.voltage, 53.17);
  assert.equal(s.soc, 60.95);
  assert.equal(s.capacityNominal, 100);
  assert.deepEqual(s.temperatures?.map((t) => t.id), ['mos', 'ambient', 't1', 't2', 't3', 't4']);
  assert.deepEqual(s.switches, { discharge: true, charge: true, precharge: false, heater: false });
  assert.deepEqual(s.alarms, []);
  assert.equal(s.extra?.chargeCurrentLimit.value, 200);
});

// ---------------------------------------------------------------------------------------------
// Driver contract and definitions
// ---------------------------------------------------------------------------------------------

test('definitions: family, links, chooser filters, ranking and demo', () => {
  assert.deepEqual(jbdDrivers.map((d) => d.id), ['jbd', 'jbd-up-rs485']);
  for (const d of jbdDrivers) {
    assert.equal(d.family, 'jbd');
    assert.equal(d.vendor, 'JBD (Jiabaida)');
    assert.equal(d.deviceType, 'bms');
    assert.equal(typeof d.create, 'function');
    assert.match(d.demo?.name ?? '', /^JBD-.* \(demo\)$/);
  }
  assert.equal(jbdDefinition.protocol, 'JBD DD A5 (Bluetooth, UART, RS485)');
  assert.equal(jbdUpRs485Definition.protocol, 'JBD UP series (RS485)');
  assert.equal(jbdUpRs485Definition.experimental, true);
  assert.equal(jbdUpRs485Definition.links.ble, undefined);
  const ble = /** @type {any} */ (jbdDefinition.links.ble);
  assert.deepEqual(
    ble.profiles.map((/** @type {any} */ p) => [p.id, p.service, p.notify, p.write, p.writeMode]),
    [
      ['jbd-ff00', 0xff00, 0xff01, 0xff02, 'prefer-without-response'],
      ['jbd-fff0', 0xfff0, 0xfff1, 0xfff2, 'prefer-without-response'],
    ],
  );
  assert.deepEqual(ble.namePrefixes, ['JBD-', 'xiaoxiang', 'SBL-', 'LSG-', 'OGR-', 'SX1', 'SX60', 'TITAN-', 'TZ-H', 'ECO-LFP', '@KsM:']);
  assert.equal(ble.manufacturerIds, undefined);
  for (const d of jbdDrivers) {
    const p = d.links.serial?.profiles[0];
    assert.deepEqual([p?.baudRate, p?.dataBits, p?.stopBits, p?.parity], [9600, 8, 1, 'none']);
  }
  const registry = new DriverRegistry(jbdDrivers);
  const { request } = registry.bleRequest({ selection: 'family:jbd' });
  assert.ok(request.filters?.some((f) => f.namePrefix === 'xiaoxiang'));
  assert.ok(request.filters?.some((f) => JSON.stringify(f.services) === JSON.stringify([0xff00])));
  assert.ok(!request.filters?.some((f) => f.namePrefix === 'SP' || f.namePrefix === 'LT'));
  assert.deepEqual(request.optionalServices.sort(), [canonicalUuid(0xff00), canonicalUuid(0xfff0)].sort());
  const ranked = (/** @type {string} */ name) => registry.bleCandidates({ name, services: [canonicalUuid(0xff00)] })[0]?.score;
  for (const name of ['JBD-SP04S034-L4S-200A-B-U', 'xiaoxiang BMS', 'SP04S034L4S200A', 'DP04S007L4S100A', 'SBL-12330BLH1-242055', 'TITAN-12V-120AHBH-0201', 'ECO-LFP48100-3U-8EC7', '12100BL1234', 'J-12345Y01']) assert.equal(ranked(name), 10, name);
  for (const name of ['DL-401710015C9B', 'LT40AH', 'BMS', 'SP-1']) assert.equal(ranked(name), 0, name);
});

test('driver contract: BaseDriver subclass, capabilities, schema and no browser APIs', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, name: 'silent' });
  await host.open();
  await device.open();
  const driver = jbdDefinition.create({ link: host, log, profileId: 'jbd-ff00', options: {} });
  const up = jbdUpRs485Definition.create({ link: host, log, profileId: 'jbd-up-9600', options: { address: 300 } });
  try {
    assert.ok(driver instanceof BaseDriver && driver instanceof JbdDriver);
    assert.ok(up instanceof BaseDriver && up instanceof JbdUpDriver);
    assert.equal(/** @type {JbdUpDriver} */ (up).address, 1, 'invalid address falls back to 1');
    assert.deepEqual(driver.capabilities, { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 });
    assert.deepEqual(up.capabilities, { settings: false, writeSettings: false, streaming: false, pollIntervalMs: 2000, minPollIntervalMs: 1000 });
    assert.ok(/** @type {any} */ (driver.getSettingsSchema()).groups.length > 5);
    assert.equal(up.getSettingsSchema(), null);
    for (const m of ['probe', 'start', 'poll', 'stop', 'readInfo', 'readSettings', 'writeSetting', 'runAction', 'dispose']) {
      assert.equal(typeof (/** @type {any} */ (driver)[m]), 'function', m);
    }
    await assert.rejects(driver.writeSetting('nope', 1), /Unknown setting/);
    await assert.rejects(driver.writeSetting('jbd.model', 'x'), /read only/);
    await assert.rejects(driver.runAction('nope'), /Unknown action/);
    await assert.rejects(up.readSettings(), /not supported/);
  } finally {
    driver.dispose();
    up.dispose();
    await host.close();
    await device.close();
  }
  const dir = new URL('../src/jbd/', import.meta.url);
  const files = [...readdirSync(dir).map((f) => new URL(f, dir)), new URL('../test/jbd.test.js', import.meta.url), new URL('../../../docs/protocols/jbd.md', import.meta.url), new URL('./vectors/jbd.json', import.meta.url)];
  const dash = String.fromCharCode(0x2014);
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.equal(text.includes(dash), false, `${f.pathname}: em dash`);
    if (f.pathname.includes('/src/jbd/')) assert.doesNotMatch(text, /\b(navigator|window|document|localStorage)\./, f.pathname);
  }
});

// ---------------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------------

test('simulator: protocol level answers, factory mode, writes, MOSFETs and control codes', async () => {
  const { host, device } = createLinkPair({ deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = createJbdSimulator(device, { tickMs: 0 });
  /** @type {Uint8Array[]} */
  const frames = [];
  const asm = createJbdAssembler({ onFrame: (f) => frames.push(f) });
  host.on('data', (c) => asm.push(c));
  /** @param {Uint8Array} bytes */
  const ask = async (bytes) => {
    frames.length = 0;
    await host.write(bytes);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(frames.length, 1, `one answer to ${hex(bytes)}`);
    return parseAnswer(frames[0]);
  };
  const basic = await ask(encodeRead(REG.BASIC));
  assert.equal(basic.cellCount, 16);
  assert.equal(basicProblem(fromHex(hex(frames[0])).subarray(4, 4 + frames[0][3])), null);
  assert.ok(basic.extension, 'V11 tail');
  assert.equal((await ask(encodeRead(REG.CELLS))).cellVoltages.length, 16);
  assert.equal((await ask(encodeRead(REG.VERSION))).hardwareVersion, 'JBD-SP25S003-L16S-100A-100A-B');
  assert.equal((await ask(encodeRead(REG.ERROR_COUNTS))).restartCount, 5);
  assert.equal((await ask(encodeRead(0x24))).status, STATUS.INVALID, 'EEPROM outside factory mode');
  assert.equal((await ask(encodeEnterFactory())).status, STATUS.OK);
  assert.equal((await ask(encodeRead(0x24))).value, 3.65);
  assert.equal((await ask(encodeWriteU16(0x24, 3600))).status, STATUS.OK);
  assert.equal((await ask(encodeRead(0x24))).value, 3.6);
  assert.equal((await ask(encodeRead(0xa1))).text, 'JBD-SP25S003-L16S-100A-100A-B');
  assert.equal((await ask(encodeRead(0x40))).status, STATUS.ERROR, 'unknown register');
  assert.equal((await ask(encodeExitFactory(true))).status, STATUS.OK);
  assert.equal(sim.saved().get(0x24), 3600);
  assert.equal((await ask(encodeMos({ chargeOff: true, dischargeOff: false }))).status, STATUS.OK);
  const locked = await ask(encodeRead(REG.BASIC));
  assert.deepEqual([locked.chargeMos, locked.dischargeMos, locked.alarms], [false, true, ['jbd.mos_software_lock']]);
  assert.equal((await ask(encodeControl(CONTROL.RESET_CAPACITY))).status, STATUS.OK);
  assert.equal((await ask(encodeControl(CONTROL.RESTART))).status, STATUS.ERROR);
  sim.stop();
  await host.close();
  await device.close();
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * @param {import('@ubms/bms-core').DriverRegistry} registry
 * @param {{ probeTimeoutMs?: number }} [opts]
 */
function makeSession(registry, { probeTimeoutMs = 1000 } = {}) {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs, autoReconnect: false });
  return { log, session };
}

/** @param {BmsSession} session */
const nextSnapshot = (session) => /** @type {Promise<any>} */ (new Promise((resolve) => session.once('snapshot', resolve)));

/**
 * Session with a JBD simulator on a direct link.
 * @param {Parameters<typeof createJbdSimulator>[1]} simOpts
 * @param {{ kind?: string, name?: string, options?: Record<string, any>, selection?: string }} [opts]
 */
async function connectSim(simOpts, { kind = 'memory', name = 'Memory link', options = {}, selection = 'jbd' } = {}) {
  const { log, session } = makeSession(new DriverRegistry(jbdDrivers));
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20, kind, name });
  await device.open();
  const sim = createJbdSimulator(device, { tickMs: 0, ...simOpts });
  const first = nextSnapshot(session);
  await session.connect({ kind: 'link', link: host, selection, options });
  return { log, session, sim, host, device, first };
}

test('session: monitoring, device info, settings read, writes with read-back, switches and actions', async () => {
  const { session, sim, first } = await connectSim({});
  assert.equal(session.definition?.id, 'jbd');
  assert.equal(session.variant, VARIANT.JBD);
  const s = await first;
  assert.equal(s.cells.length, 16);
  assert.ok(Math.abs(s.voltage - s.cellStats.sum) < 0.02, 'pack voltage matches the cells');
  assert.equal(s.soc, 71);
  assert.deepEqual(s.temperatures.map((/** @type {any} */ t) => t.id), ['t1', 't2', 't3']);
  assert.deepEqual(s.switches, { charge: true, discharge: true });
  assert.equal(s.capacityNominal, 100);
  assert.equal(s.capacityFull, 100);
  await session.refreshInfo();
  assert.equal(session.info?.model, 'JBD-SP25S003-L16S-100A-100A-B');
  assert.equal(session.info?.softwareVersion, '2.4');
  assert.equal(session.info?.manufactureDate, '2024-05-17');
  assert.equal(session.info?.extra?.['count.restarts']?.value, 5);

  const settings = await session.loadSettings();
  assert.equal(settings.error, null);
  const values = /** @type {Record<string, any>} */ (settings.values);
  near(values, { 'cell.ovp': 3.65, 'discharge.ocp': 150, 'charge.ocp': 100, 'capacity.nominal': 100, 'balance.enabled': true, 'system.cell_count': 16, 'jbd.soc90_voltage': 3.375, 'switch.charge': true, 'jbd.manufacturer': 'DGJBD', 'jbd.module_address': '' }, 'settings');
  assert.equal(sim.state.factory, false, 'factory mode left after reading');
  assert.equal(sim.state.exits.at(-1), 'exit', 'read session exits with 00 00');
  assert.ok(!sim.received.some((f) => f[1] === 0x5a && f[2] >= 0x10 && f[2] <= 0xa2), 'reading writes no register');
  assert.equal(session.info?.serialNumber, '1234');

  const results = await session.writeSettings([
    { id: 'cell.ovp', value: 3.6 },
    { id: 'discharge.ocp', value: 120 },
    { id: 'charge.otp', value: 60 },
    { id: 'balance.enabled', value: false },
    { id: 'charge.ocp_delay', value: 5 },
  ]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.verified]),
    [
      ['cell.ovp', true, true],
      ['discharge.ocp', true, true],
      ['charge.otp', true, true],
      ['balance.enabled', true, true],
      ['charge.ocp_delay', true, true],
    ],
  );
  assert.equal(sim.saved().get(0x24), 3600, 'saved with exit 28 28');
  assert.equal(sim.saved().get(0x29), 0x10000 - 12000);
  assert.equal(sim.saved().get(0x2d), 0x0002, 'bit 2 cleared, bit 1 kept');
  assert.equal(sim.saved().get(0x3e), 0x051e, 'release byte kept');
  assert.equal(sim.state.saves, 5);
  const ro = await session.writeSettings([{ id: 'cell.ovp_delay', value: 5 }]);
  assert.equal(ro[0].ok, false);

  const sw = await session.writeSettings([{ id: 'switch.charge', value: false }]);
  assert.deepEqual(sw.map((r) => [r.ok, r.verified, r.actual]), [[true, true, false]]);
  assert.deepEqual(sim.state.mosCommand, { chargeOff: true, dischargeOff: false });
  const sw2 = await session.writeSettings([{ id: 'switch.discharge', value: false }]);
  assert.deepEqual(sw2.map((r) => [r.ok, r.verified]), [[true, true]]);
  assert.deepEqual(sim.state.mosCommand, { chargeOff: true, dischargeOff: true }, 'the other bit keeps its command');
  await session.writeSettings([
    { id: 'switch.charge', value: true },
    { id: 'switch.discharge', value: true },
  ]);
  assert.deepEqual(sim.state.mosCommand, { chargeOff: false, dischargeOff: false });

  await session.runAction('jbd.reset_capacity');
  await session.runAction('jbd.clear_protection');
  assert.deepEqual(sim.state.controls, [CONTROL.RESET_CAPACITY, CONTROL.CLEAR_PROTECTION]);
  await session.disconnect();
  sim.stop();
});

test('session: refused optional registers are hidden, 100 mA units make capacities read only', async () => {
  const { session, sim, first } = await connectSim({ socTable: false, unit100: true });
  const s = await first;
  assert.equal(s.capacityNominal, 100, '100 mAh units read through the tail flag');
  const settings = await session.loadSettings();
  const f = fieldMap(settings.schema);
  assert.ok(!f.has('jbd.soc90_voltage') && !f.has('jbd.soc100_voltage_table') && f.has('jbd.soc80_voltage'));
  assert.equal(f.get('capacity.nominal')?.readOnly, true);
  assert.equal(settings.values?.['capacity.nominal'], 100);
  assert.equal(settings.values?.['charge.ocp'], 100);
  assert.equal(settings.values?.['jbd.unit_100ma'], true);
  const r = await session.writeSettings([{ id: 'capacity.nominal', value: 120 }]);
  assert.equal(r[0].ok, false);
  await session.disconnect();
  sim.stop();
});

test('session: BMS password after a 0x81 refusal of factory mode', async () => {
  const { session, sim } = await connectSim({ bmsPassword: '765828' });
  const before = await session.loadSettings();
  assert.match(String(before.error), /refused factory mode/);
  const r = await session.writeSettings([{ id: 'jbd.bms_password', value: '765828' }], { reload: false });
  assert.equal(r[0].ok, true);
  const after = await session.loadSettings();
  assert.equal(after.error, null);
  assert.equal(after.values?.['cell.ovp'], 3.65);
  assert.equal(after.values?.['jbd.bms_password'], undefined, 'passwords are never returned');
  const sent = sim.received.filter((f) => f[1] === 0x5a && f[2] === REG.PASSWORD).map((f) => parseRequest(f).password.text);
  assert.deepEqual(sent, ['765828'], 'ASCII first, accepted');
  await session.disconnect();
  sim.stop();
});

/**
 * Value byte of every 0xE1 write the simulator received.
 * @param {{ received: Uint8Array[] }} sim
 */
const mosWrites = (sim) => sim.received.filter((f) => f[0] === 0xdd && f[1] === 0x5a && f[2] === REG.MOS).map((f) => f[5]);

test('session: a MOSFET switch keeps the other MOSFET as the BMS reports it now', async () => {
  /** @type {Record<string, any>} */
  const options = {};
  const { session, sim, first, log } = await connectSim({}, { options });
  await first;
  const sw = async (/** @type {string} */ id, /** @type {boolean} */ value) => (await session.writeSettings([{ id, value }], { reload: false }))[0];
  assert.equal((await sw('switch.discharge', false)).ok, true);
  assert.deepEqual(options['jbd.mosCommand'], { chargeOff: false, dischargeOff: true }, 'kept for the next connection');
  // Another app (or a BMS restart) releases the switch behind the driver's back.
  sim.setMosCommand({ chargeOff: false, dischargeOff: false });
  assert.equal((await sw('switch.charge', false)).ok, true);
  assert.equal(mosWrites(sim).at(-1), 0x01, 'charge off only');
  assert.deepEqual(sim.state.mosCommand, { chargeOff: true, dischargeOff: false }, 'the load keeps its power');
  assert.equal((await sw('switch.charge', true)).ok, true);
  assert.equal(mosWrites(sim).at(-1), 0x00);
  // A MOSFET held off by a protection (bit 9) while bit 12 is clear is not attributed to 0xE1.
  sim.state.protectionBits = 0x0200;
  sim.battery.switches.discharge = false;
  await sw('switch.charge', false);
  assert.equal(mosWrites(sim).at(-1), 0x01);
  // Bit 12 and another protection bit without a saved command: ambiguous, kept off and logged.
  delete options['jbd.mosCommand'];
  sim.battery.switches.discharge = false;
  await sw('switch.charge', true);
  assert.equal(mosWrites(sim).at(-1), 0x02);
  assert.ok(log.list.some((e) => /no saved command: kept off/.test(e.text ?? '')));
  await session.disconnect();
  sim.stop();
});

test('session: factory mode is left after lost answers, a save without acknowledgement is an error', async () => {
  /** @type {Record<string, any>} */
  const options = {};
  const { session, sim, first } = await connectSim({ dropAnswers: { [REG.FACTORY_ENTER]: 2 } }, { kind: 'serial', options });
  await first;
  // Both answers to the enter request are lost while the BMS did enter: 00 00 anyway ([BM]).
  const r = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }], { reload: false });
  assert.deepEqual([r[0].ok, r[0].error], [false, 'The BMS did not answer the factory mode request']);
  assert.equal(sim.state.factory, false, 'factory mode left');
  assert.deepEqual(sim.state.exits, ['exit']);
  assert.equal(options['jbd.factoryOpen'], undefined);
  // Both answers to the exit are lost after a settings read: the next poll closes the transaction.
  sim.state.dropAnswers[REG.FACTORY_EXIT] = 2;
  const read = await session.loadSettings();
  assert.equal(read.error, null);
  assert.equal(options['jbd.factoryOpen'], true);
  const exits = sim.state.exits.length;
  await nextSnapshot(session);
  assert.equal(sim.state.exits.length, exits + 1);
  assert.equal(options['jbd.factoryOpen'], undefined);
  // A save whose 28 28 is not acknowledged is reported, although the value was written.
  sim.state.dropAnswers[REG.FACTORY_EXIT] = 2;
  const w = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }], { reload: false });
  assert.deepEqual([w[0].ok, w[0].error], [false, 'The value was written but the BMS did not confirm saving it']);
  assert.equal(sim.eeprom.get(0x24), 3600);
  assert.equal(options['jbd.factoryOpen'], true);
  await session.disconnect();
  sim.stop();
  // A new connection with the same options closes it at the first poll, never in the probe.
  const again = await connectSim({}, { kind: 'serial', options });
  await again.first;
  assert.deepEqual(again.sim.received.slice(0, 2).map((f) => hex(f)), [vec('vendor-v4-tx-read-basic').hex, vec('btmodule-uart-tx-exit-factory-discard').hex]);
  assert.equal(options['jbd.factoryOpen'], undefined);
  await again.session.disconnect();
  again.sim.stop();
});

test('session: late answers to the factory mode request do not confuse the next transaction', async () => {
  const { session, sim, first } = await connectSim({ lateAnswers: { [REG.FACTORY_ENTER]: 2300 } }, { kind: 'serial' });
  await first;
  const r = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }], { reload: false });
  assert.equal(r[0].ok, false);
  assert.equal(sim.state.factory, false, 'left with 00 00 after the unanswered enter');
  delete sim.state.lateAnswers[REG.FACTORY_ENTER];
  const again = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }], { reload: false });
  assert.deepEqual([again[0].ok, sim.saved().get(0x24)], [true, 3600]);
  await session.disconnect();
  sim.stop();
});

test('session: a stray acknowledgement does not answer a read (unit bit of 0x2D)', async () => {
  const { session, sim, host, device, first } = await connectSim({});
  await first;
  sim.eeprom.set(0x2d, (sim.eeprom.get(0x2d) ?? 0) | 0x1000); // the board uses 100 mA units
  let armed = true;
  const write = host.write.bind(host);
  host.write = async (/** @type {Uint8Array} */ bytes, /** @type {any} */ meta) => {
    if (armed && bytes[0] === 0xdd && bytes[1] === 0xa5 && bytes[2] === 0x2d) {
      armed = false;
      await device.write(encodeDd(0x2d, STATUS.OK, [])); // late acknowledgement of an earlier write
    }
    return write(bytes, meta);
  };
  const r = await session.writeSettings([{ id: 'charge.ocp', value: 100 }], { reload: false });
  assert.equal(armed, false, 'the stray acknowledgement was sent');
  assert.deepEqual([r[0].ok, r[0].error], [false, 'This value is read only']);
  assert.equal(sim.eeprom.get(0x28), 10000, 'nothing written');
  await session.disconnect();
  sim.stop();
});

test('session: an open NTC does not stop the monitoring', async () => {
  const { session, sim, first } = await connectSim({});
  await first;
  sim.battery.temps[1] = -273.1; // raw 0
  let s = await nextSnapshot(session);
  for (let i = 0; i < 3 && !s.alarms.some((/** @type {any} */ a) => a.id === 'temperature_sensor_fault'); i++) s = await nextSnapshot(session);
  assert.deepEqual(s.temperatures.map((/** @type {any} */ t) => t.id), ['t1', 't3']);
  assert.ok(s.alarms.some((/** @type {any} */ a) => a.id === 'temperature_sensor_fault' && a.source === 'NTC 2'));
  assert.equal(s.cells.length, 16);
  await session.disconnect();
  sim.stop();
});

test('session: an unanswered login step is retried, not taken for a wrong password', async () => {
  const { session, sim, first } = await connectSim(
    { module: 'locked', modulePassword: 'ab12cd', dropModuleAnswers: { 0x17: 2 } },
    { options: { password: 'ab12cd', address: 'A4:C1:37:04:2D:BE' } },
  );
  const s = await first;
  assert.deepEqual(s.alarms.map((/** @type {any} */ a) => [a.id, a.label]), [['jbd.module_locked', 'Bluetooth module did not answer the login, retrying']]);
  let live = s;
  for (let i = 0; i < 6 && !live.cells; i++) live = await nextSnapshot(session);
  assert.equal(live.cells?.length, 16, 'logged in by a later poll');
  assert.equal(sim.state.loggedIn, true);
  await session.disconnect();
  sim.stop();
});

test('session: a sleeping BMS answers the repeated probe; the probe only reads', async () => {
  const { session, sim, first } = await connectSim({ dropFirst: 1 }, { kind: 'serial' });
  await first;
  assert.equal(session.definition?.id, 'jbd');
  const probe = sim.received.slice(0, 2).map((f) => hex(f));
  assert.deepEqual(probe, [vec('vendor-v4-tx-read-basic').hex, vec('vendor-v4-tx-read-basic').hex]);
  await session.disconnect();
  sim.stop();
});

test('session: Daren clones are recognised by name and by the refused 0x05', async () => {
  const byName = await connectSim({}, { name: 'DWF12345' });
  assert.equal(byName.session.variant, VARIANT.DAREN);
  // Monitoring only: no source documents factory mode, 0xE1 or 0x0A on Daren clones.
  const driver = /** @type {any} */ (byName.session.driver);
  assert.deepEqual([driver.capabilities.settings, driver.capabilities.writeSettings], [false, false]);
  await assert.rejects(byName.session.loadSettings(), /does not expose settings/);
  await assert.rejects(byName.session.runAction('jbd.reset_capacity'), /Daren clones/);
  await assert.rejects(driver.writeSetting('switch.charge', false), /Daren clones/);
  await byName.session.disconnect();
  byName.sim.stop();
  const byAnswer = await connectSim({ daren: true });
  const s = await byAnswer.first;
  assert.equal(s.temperatures.length, 3, 'the Daren tail is not decoded as temperatures');
  await byAnswer.session.refreshInfo();
  assert.equal(byAnswer.session.variant, VARIANT.DAREN);
  assert.equal(byAnswer.session.info?.model, 'Memory link', 'the name stands in for the refused model');
  assert.equal(byAnswer.session.info?.manufactureDate, undefined);
  assert.equal(/** @type {any} */ (byAnswer.session.driver).capabilities.writeSettings, false);
  await byAnswer.session.disconnect();
  byAnswer.sim.stop();
  // Extended Daren frame ([AIO] offsets): no tail alarms, no full charge capacity, recognised by
  // its tail and the refused 0x05; nothing is ever written.
  const ext = await connectSim({ daren: 'extended' });
  const se = await ext.first;
  assert.deepEqual(se.alarms, []);
  assert.equal(se.capacityFull, undefined);
  assert.equal(se.capacityNominal, 100);
  await ext.session.refreshInfo();
  assert.equal(ext.session.variant, VARIANT.DAREN);
  assert.ok(!ext.sim.received.some((f) => f[0] === 0xdd && f[1] === 0x5a), 'no write request');
  await ext.session.disconnect();
  ext.sim.stop();
});

test('session: locked Bluetooth module, login through the settings, then live data', async () => {
  const { session, sim, first } = await connectSim({ module: 'locked', modulePassword: 'ab12cd', mac: 'A4:C1:37:04:2D:BE' });
  assert.equal(session.definition?.id, 'jbd');
  const s = await first;
  assert.deepEqual(s.alarms.map((/** @type {any} */ a) => [a.id, a.severity]), [['jbd.module_locked', 'fault']]);
  // The probe sent two reads and one app key, nothing else.
  assert.deepEqual(sim.received.map((f) => hex(f)), [vec('vendor-v4-tx-read-basic').hex, vec('vendor-v4-tx-read-basic').hex, vec('auth-ble-tx-app-key').hex]);
  const locked = await session.loadSettings();
  assert.deepEqual([...fieldMap(locked.schema).keys()], ['jbd.module_password', 'jbd.module_address']);
  // A wrong password is reported, the right one unlocks the module.
  const wrong = await session.writeSettings([
    { id: 'jbd.module_password', value: 'xx12cd' },
    { id: 'jbd.module_address', value: 'a4c137042dbe' },
  ]);
  assert.deepEqual(wrong.map((r) => r.ok), [true, false]);
  const right = await session.writeSettings([{ id: 'jbd.module_password', value: 'ab12cd' }]);
  assert.equal(right[0].ok, true);
  assert.equal(sim.state.loggedIn, true);
  const settings = session.settings;
  assert.equal(settings.values?.['cell.ovp'], 3.65, 'full settings after the login');
  assert.equal(settings.values?.['jbd.module_address'], 'A4:C1:37:04:2D:BE');
  const live = await nextSnapshot(session);
  assert.equal(live.cells.length, 16);
  await session.disconnect();
  sim.stop();
});

test('session: a locked module with known login data logs in during the probe', async () => {
  const { session, sim, first } = await connectSim({ module: 'locked', modulePassword: 'ab12cd' }, { options: { password: 'ab12cd', address: 'A4:C1:37:04:2D:BE' } });
  const s = await first;
  assert.equal(s.cells.length, 16);
  assert.ok(sim.received.some((f) => f[0] === 0xff && f[2] === 0x1d), 'root password sent');
  await session.disconnect();
  sim.stop();
});

test('session: an open module (no password) and a module that needs pairing', async () => {
  // A module that drops the first two reads (asleep) but answers the app key with 0x02.
  const open = await connectSim({ module: 'open', dropFirst: 2 });
  const s = await open.first;
  assert.equal(s.cells.length, 16);
  await open.session.disconnect();
  open.sim.stop();
  // The echo counts only for JBD, Liontron and serial number names: the one report ([SY] issue
  // 245) was a LIONTRON module advertising "0521150067".
  const pairing = await connectSim({ module: 'pairing' }, { name: '0521150067' });
  const p = await pairing.first;
  assert.match(p.alarms[0].label, /pairing/);
  await pairing.session.disconnect();
  pairing.sim.stop();
  const { log, session } = makeSession(new DriverRegistry(jbdDrivers));
  const other = createLinkPair({ log, deviceChunkSize: 20, name: 'UART bridge' });
  await other.device.open();
  const echo = createJbdSimulator(other.device, { tickMs: 0, module: 'pairing' });
  await assert.rejects(session.connect({ kind: 'link', link: other.host, selection: 'jbd' }), /no valid answer/);
  echo.stop();
});

test('session: a silent or foreign device is not detected and gets no write', async () => {
  const { log, session } = makeSession(new DriverRegistry(jbdDrivers));
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20 });
  await device.open();
  const daly = createDalySimulator(device, { tickMs: 0 });
  /** @type {Uint8Array[]} */
  const seen = [];
  device.on('data', (c) => seen.push(c));
  await assert.rejects(session.connect({ kind: 'link', link: host, selection: 'jbd' }), /no valid answer/);
  const sent = seen.map((c) => hex(c));
  assert.deepEqual(sent, [vec('vendor-v4-tx-read-basic').hex, vec('vendor-v4-tx-read-basic').hex, vec('auth-ble-tx-app-key').hex]);
  daly.stop();
  // On a serial link there is no app key.
  const s2 = makeSession(new DriverRegistry(jbdDrivers));
  const pair = createLinkPair({ log: s2.log, kind: 'serial' });
  await pair.device.open();
  /** @type {string[]} */
  const seen2 = [];
  pair.device.on('data', (c) => seen2.push(hex(c)));
  await assert.rejects(s2.session.connect({ kind: 'link', link: pair.host, selection: 'jbd' }), /no valid answer/);
  assert.deepEqual(seen2, [vec('vendor-v4-tx-read-basic').hex, vec('vendor-v4-tx-read-basic').hex]);
  // Nor on the FFF0 layout, the Daly default.
  const fff0 = createLinkPair({ kind: 'ble' });
  await fff0.host.open();
  await fff0.device.open();
  /** @type {string[]} */
  const seen3 = [];
  fff0.device.on('data', (c) => seen3.push(hex(c)));
  const driver = jbdDefinition.create({ link: fff0.host, log: new ProtocolLog(), profileId: 'jbd-fff0', options: {} });
  assert.equal(await driver.probe({ timeout: 1000 }), null);
  assert.deepEqual(seen3, [vec('vendor-v4-tx-read-basic').hex, vec('vendor-v4-tx-read-basic').hex]);
  driver.dispose();
});

test('session: UP series pack over RS485 (experimental, read only)', async () => {
  const { log, session } = makeSession(new DriverRegistry(jbdDrivers));
  const { host, device } = createLinkPair({ log, deviceChunkSize: 32, kind: 'serial' });
  await device.open();
  const sim = createJbdUpSimulator(device, { address: 2, tickMs: 0 });
  const first = nextSnapshot(session);
  await session.connect({ kind: 'link', link: host, selection: 'jbd-up-rs485', options: { address: 2 } });
  assert.equal(session.variant, VARIANT.UP);
  const s = await first;
  assert.equal(s.cells.length, 16);
  assert.equal(s.temperatures.length, 6);
  assert.equal(session.info?.model, 'JBD48100000');
  assert.deepEqual(sim.received.map((f) => hex(f))[0], hex(encodeUpStatusRequest(2)));
  await assert.rejects(session.loadSettings(), /does not expose settings/);
  await session.disconnect();
  sim.stop();
  // Address 1 gets no answer from the pack at address 2.
  const s2 = makeSession(new DriverRegistry(jbdDrivers));
  const pair = createLinkPair({ log: s2.log, kind: 'serial' });
  await pair.device.open();
  const sim2 = createJbdUpSimulator(pair.device, { address: 2, tickMs: 0 });
  await assert.rejects(s2.session.connect({ kind: 'link', link: pair.host, selection: 'jbd-up-rs485', options: { address: 1 } }), /no valid answer/);
  sim2.stop();
});

// ---------------------------------------------------------------------------------------------
// Temporary registry with the existing drivers
// ---------------------------------------------------------------------------------------------

/** Registration order recommended in src/jbd/index.js. */
/** The registered driver list (packages/bms-drivers/src/index.js), which includes the JBD family. */
function combinedDrivers() {
  return drivers;
}

/**
 * Fake Bluetooth handle: every opened channel gets a fresh device simulator.
 * @param {string} name
 * @param {number[]} services
 * @param {(device: import('@ubms/transport').MemoryLink) => { stop: () => void }} attach
 */
function fakeBleHandle(name, services, attach) {
  /** @type {Array<{ stop: () => void }>} */
  const sims = [];
  /** @type {string[]} */
  const opened = [];
  return {
    sims,
    opened,
    handle: {
      id: name,
      name,
      connected: true,
      async connect() {},
      async disconnect() {},
      async discover() {
        return services.map((s) => ({ uuid: canonicalUuid(s), characteristics: [] }));
      },
      /** @param {any} profile */
      async openChannel(profile) {
        opened.push(profile.id);
        const { host, device } = createLinkPair({ deviceChunkSize: 20, kind: 'ble', name });
        await device.open();
        await host.open();
        sims.push(attach(device));
        return host;
      },
    },
  };
}

test('registry: JBD together with the existing drivers', async () => {
  const list = combinedDrivers();
  const registry = new DriverRegistry(list);
  assert.equal(new Set(list.map((d) => d.id)).size, list.length, 'unique ids');
  assert.ok(registry.families().some((f) => f.id === 'jbd' && f.drivers.length === 2));
  const ids = list.map((d) => d.id);
  assert.ok(ids.indexOf('jbd') < ids.indexOf('daly-modbus') && ids.indexOf('daly') < ids.indexOf('jbd-up-rs485'));
  assert.equal(list.find((d) => d.demo)?.id, 'jk-ble', 'the default demo stays jk-ble');
  const { request } = registry.bleRequest();
  assert.ok(request.filters?.some((f) => f.namePrefix === 'JBD-') && request.filters?.some((f) => f.namePrefix === 'DL-'));
  assert.ok(request.optionalServices.includes(canonicalUuid(0xff00)) && request.optionalServices.includes(canonicalUuid(0xffe0)));
  const top = (/** @type {string} */ name) => registry.bleCandidates({ name, services: [canonicalUuid(0xff00), canonicalUuid(0xfff0)] }).map((c) => `${c.definition.id}/${c.profile.id}`);
  assert.deepEqual(top('xiaoxiang BMS').slice(0, 2), ['jbd/jbd-ff00', 'jbd/jbd-fff0']);
  assert.equal(top('DL-401710015C9B')[0].startsWith('daly'), true);
  assert.equal(top('BMS')[0], 'jbd/jbd-ff00');
  assert.ok(!top('BMS').some((c) => c.startsWith('jk') || c.startsWith('ant') || c.startsWith('atorch')), 'FFE0 drivers are not probed on FF00');
  const serial = registry.serialCandidates().map((c) => c.definition.id);
  assert.ok(serial.indexOf('jbd') < serial.indexOf('daly-modbus') && serial.indexOf('jbd-up-rs485') > serial.indexOf('daly'));

  // Bluetooth auto-detection: a JBD on FF00, then a Daly with an unknown name on FF00.
  const jbd = fakeBleHandle('xiaoxiang BMS', [0xff00, 0x180a], (device) => createJbdSimulator(device, { tickMs: 0 }));
  const a = makeSession(registry);
  const first = nextSnapshot(a.session);
  await a.session.connect({ kind: 'ble', handle: jbd.handle });
  assert.equal(a.session.definition?.id, 'jbd');
  assert.deepEqual(jbd.opened, ['jbd-ff00']);
  assert.equal((await first).cells.length, 16);
  await a.session.disconnect();
  jbd.sims.forEach((s) => s.stop());

  const daly = fakeBleHandle('BMS', [0xff00], (device) => createDalySimulator(device, { tickMs: 0 }));
  const b = makeSession(registry);
  await b.session.connect({ kind: 'ble', handle: daly.handle });
  assert.equal(b.session.definition?.family, 'daly');
  assert.equal(daly.opened[0], 'jbd-ff00', 'the JBD probe ran first and gave way');
  await b.session.disconnect();
  daly.sims.forEach((s) => s.stop());
});

test('demo: the simulators connect like the app demo', async () => {
  for (const def of jbdDrivers) {
    const { log, session } = makeSession(new DriverRegistry([def]));
    const { host, device } = createLinkPair({ log, deviceChunkSize: def.demo?.chunkSize ?? 0 });
    await device.open();
    const sim = /** @type {any} */ (def.demo?.create(device));
    const first = nextSnapshot(session);
    await session.connect({ kind: 'link', link: host, selection: def.id });
    const s = await first;
    assert.ok(s.cells.length >= 4, def.id);
    await session.disconnect();
    sim.stop();
  }
});
