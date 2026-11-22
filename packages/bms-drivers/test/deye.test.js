import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { ProtocolLog, SlcanDecoder, canonicalUuid, createLinkPair, formatSlcanFrame, fromHex, hex, sleep } from '@ubms/transport';
import { ALARMS, BmsSession, DriverRegistry } from '@ubms/bms-core';
import { aes128CbcDecrypt, aes128CbcEncrypt, aes128DecryptBlock, aes128EncryptBlock, pkcs7Unpad, sha256, sha256Hex } from '../src/common/crypto.js';
import * as P from '../src/deye/protocol.js';
import * as CAN from '../src/deye/can.js';
import {
  deyeDrivers,
  deyeRs485Definition,
  deyeBleDefinition,
  deyeCanDefinition,
  aa55Info,
  aa55Snapshot,
  serialFromName,
  createDeyeRs485Simulator,
  createDeyeBleSimulator,
  createDeyeCanSimulator,
  DEMO_BLE_NAME,
} from '../src/deye/index.js';
import { createSeplosV2Simulator, seplosDrivers, seplosV2Definition } from '../src/seplos/index.js';
import { createJbdSimulator } from '../src/jbd/index.js';
import { drivers } from '../src/index.js';
import * as SeplosV2 from '../src/seplos/protocol-v2.js';

/** @type {Array<{ id: string, variant: string, link: string, direction: 'tx'|'rx', hex: string, description: string, source: string, expected: Record<string, any>, expectedComputed?: boolean }>} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/deye.json', import.meta.url), 'utf8'));
/** @type {Array<{ id: string, variant: string, link: string, direction: string, hex: string }>} */
const seplosVectors = JSON.parse(readFileSync(new URL('./vectors/seplos.json', import.meta.url), 'utf8'));
/** @type {Array<{ id: string, hex: string }>} */
const neeyVectors = JSON.parse(readFileSync(new URL('./vectors/neey.json', import.meta.url), 'utf8'));

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

/** @param {string} s */
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/** @param {Uint8Array} b */
const text = (b) => String.fromCharCode(...b);

/**
 * CAN frames of SLCAN line bytes (the `hex` of a CAN vector).
 * @param {Uint8Array} bytes
 */
function canFramesOf(bytes) {
  /** @type {any[]} */
  const out = [];
  new SlcanDecoder({ onFrame: (f) => out.push(f) }).push(bytes);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

test('vectors: the file holds 74 frames of the three links and the Pylontech observation', () => {
  assert.equal(vectors.length, 74);
  const count = (/** @type {string} */ variant) => vectors.filter((v) => v.variant === variant).length;
  assert.equal(count('DEYE_RS485'), 25);
  assert.equal(count('PYLON_ASCII_OBSERVED'), 2);
  assert.equal(count('DEYE_BLE'), 10);
  assert.equal(count('DEYE_PCS_CAN'), 37);
  assert.equal(new Set(vectors.map((v) => v.id)).size, vectors.length, 'unique ids');
  for (const v of vectors) {
    assert.ok(['rs485', 'ble', 'can'].includes(v.link), v.id);
    assert.equal(v.expectedComputed, false, `${v.id}: every payload is a capture`);
    assert.ok(v.source.startsWith('https://'), v.id);
  }
});

/**
 * Decode one AA 55 frame into the keys of the vectors.
 * @param {Uint8Array} f
 */
function decodeAa55(f) {
  const p = P.parseFrame(f);
  assert.ok(p, 'AA 55 frame');
  /** @type {Record<string, any>} */
  const out = { address: p.address, command: p.command, length: p.length, crc: p.crc };
  assert.equal(p.crcValid, true, 'CRC');
  if (!p.length) return out;
  if (p.command === P.CMD.MAIN) Object.assign(out, P.parseMain(p.data));
  if (p.command === P.CMD.ALARMS) Object.assign(out, P.parseAlarmBlock(p.data));
  if (p.command === P.CMD.TEMPERATURES) Object.assign(out, P.parseTemperatures(p.data));
  if (p.command === P.CMD.CELLS) Object.assign(out, P.parseCells(p.data));
  if (p.command === P.CMD.EXTENDED) out.extendedBytes = hex(p.data);
  return out;
}

/**
 * The 0x04 vectors list the first 16 of the 32 cell slots.
 * @param {Record<string, any>} decoded
 * @param {Record<string, any>} expected
 */
function sliceCells(decoded, expected) {
  if (Array.isArray(expected.cellVoltages)) {
    assert.equal(decoded.cellVoltages.length, expected.cellSlots, 'cell slots');
    return { ...decoded, cellVoltages: decoded.cellVoltages.slice(0, expected.cellVoltages.length) };
  }
  return decoded;
}

test('vectors: every frame decodes to its expected values', async (t) => {
  for (const v of vectors) {
    await t.test(v.id, () => {
      const bytes = fromHex(v.hex);
      const e = v.expected;
      if (v.variant === 'DEYE_RS485') {
        near(sliceCells(decodeAa55(bytes), e), e, v.id);
        assert.equal(P.isAnswer(bytes), v.direction === 'rx');
      } else if (v.variant === 'PYLON_ASCII_OBSERVED') {
        const f = SeplosV2.parseAscii(bytes);
        assert.ok(f, 'Pylontech framing with valid checksum');
        near({ text: f.text, ver: f.ver, adr: f.adr, cid1: f.cid1, cid2: f.cid2, lenid: f.lenid, info: hex(f.info), chksum: f.chksum }, e, v.id);
      } else if (v.variant === 'DEYE_BLE') {
        const h = P.parseHandshake(bytes);
        if (e.tag) {
          assert.ok(h, 'handshake message');
          assert.equal(h.trailerValid, true, 'trailer');
          near(h, { tag: e.tag, trailer: e.trailer, ...(e.randomStr && e.tag === 'random' ? { randomStr: e.randomStr } : {}), ...(e.block ? { block: e.block } : {}), ...(e.status !== undefined ? { status: e.status } : {}) }, v.id);
          if (e.key) assert.equal(P.sessionKey(e.name, e.randomStr), e.key);
          if (e.block) assert.equal(hex(P.cipherBlock(e.key, e.randomStr)), e.block, 'block recomputed from name and random string');
          return;
        }
        assert.equal(h, null);
        if (e.randomStr) assert.equal(P.sessionKey(e.name, e.randomStr), e.key);
        if (v.direction === 'tx') {
          const plain = P.decryptRequest(e.key, bytes);
          assert.ok(plain);
          assert.equal(hex(plain), e.plain);
          assert.equal(hex(plain).toLowerCase(), e.plainText);
          near(decodeAa55(plain), { address: e.address, command: e.command, length: e.length, crc: e.crc }, v.id);
        } else {
          const plain = P.decryptAnswer(e.key, bytes);
          assert.ok(plain, 'valid padding and AA 55 frame');
          assert.equal(hex(plain), e.plain);
          const { name: _n, key: _k, plain: _p, randomStr: _r, ...rest } = e;
          near(sliceCells(decodeAa55(plain), rest), rest, v.id);
        }
      } else {
        assert.equal(v.variant, 'DEYE_PCS_CAN');
        assert.equal(text(bytes), `${e.slcan}\r`);
        const frames = canFramesOf(bytes);
        assert.equal(frames.length, 1);
        const f = frames[0];
        near({ canId: f.id, extended: f.extended, dlc: f.dlc, data: hex(f.data) }, { canId: e.canId, extended: e.extended, dlc: e.dlc, data: e.data }, v.id);
        const d = CAN.decodeCanFrame(f, { profile: e.profile });
        assert.ok(d, 'known identifier');
        assert.equal(d.problem, undefined, 'passes the range checks');
        const { canId: _c, extended: _x, dlc: _d, data: _a, slcan: _s, profile: _p, ...fields } = e;
        near(d.fields, fields, v.id);
      }
    });
  }
});

test('encoders: every request and handshake vector equals the encoder output', () => {
  for (const v of vectors.filter((x) => x.variant === 'DEYE_RS485' && x.direction === 'tx')) {
    const e = v.expected;
    assert.equal(hex(P.encodeFrame(e.address, e.command)), v.hex, v.id);
    if (P.READ_COMMANDS.includes(e.command)) assert.equal(hex(P.encodeRequest(e.command, e.address)), v.hex, v.id);
  }
  // Only 0x01..0x04 are ever sent (spec 5.1, 11.2).
  assert.deepEqual([...P.READ_COMMANDS], [1, 2, 3, 4]);
  for (const cmd of [0x00, 0x05, 0x06, 0x60, 0xff]) assert.throws(() => P.encodeRequest(cmd), /never sent/);
  // Answers built by the simulator encoder equal the captures.
  for (const v of vectors.filter((x) => x.variant === 'DEYE_RS485' && x.direction === 'rx')) {
    const p = /** @type {any} */ (P.parseFrame(fromHex(v.hex)));
    assert.equal(hex(P.encodeFrame(p.address, p.command, p.data)), v.hex, v.id);
  }
  for (const n of [1, 2, 3]) {
    const r = byId(`ble-tx-random-${n}`);
    assert.equal(hex(P.encodeRandom(r.expected.randomStr)), r.hex);
    const c = byId(`ble-rx-cipher-${n}`);
    assert.equal(hex(P.encodeCipher(P.cipherBlock(c.expected.key, c.expected.randomStr))), c.hex);
  }
  assert.equal(hex(P.encodeResult(1)), byId('ble-tx-result').hex);
  // CBC with the fixed IV is deterministic: requests and answers encrypt to the captured bytes.
  const tx = byId('ble-tx-02-encrypted');
  assert.equal(hex(P.encryptRequest(tx.expected.key, fromHex(tx.expected.plain))), tx.hex);
  for (const id of ['ble-rx-02-encrypted', 'ble-rx-04-encrypted']) {
    const v = byId(id);
    assert.equal(hex(P.encryptAnswer(v.expected.key, fromHex(v.expected.plain))), v.hex, id);
  }
  for (const v of vectors.filter((x) => x.variant === 'DEYE_PCS_CAN')) {
    assert.equal(formatSlcanFrame({ id: v.expected.canId, data: fromHex(v.expected.data) }), v.expected.slcan, v.id);
  }
  // Random strings: 16 upper case hex characters.
  for (let i = 0; i < 20; i++) assert.match(P.randomString(), /^[0-9A-F]{16}$/);
  assert.equal(P.randomString(() => 0.999), 'FFFFFFFFFFFFFFFF');
});

test('crypto helpers: SHA-256 and AES-128 agree with node:crypto', () => {
  assert.equal(sha256Hex([]), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex(ascii('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (let n = 0; n < 160; n += 7) {
    const d = randomBytes(n);
    assert.equal(hex(sha256(d)).toLowerCase(), createHash('sha256').update(d).digest('hex'), `sha256 of ${n} bytes`);
  }
  // FIPS 197 appendix C.1.
  const key = fromHex('000102030405060708090a0b0c0d0e0f');
  const pt = fromHex('00112233445566778899aabbccddeeff');
  assert.equal(hex(aes128EncryptBlock(key, pt)), '69C4E0D86A7B0430D8CDB78070B4C55A');
  assert.equal(hex(aes128DecryptBlock(key, fromHex('69C4E0D86A7B0430D8CDB78070B4C55A'))), hex(pt));
  for (let n = 0; n < 70; n += 5) {
    const k = randomBytes(16);
    const iv = randomBytes(16);
    const d = randomBytes(n);
    const c = createCipheriv('aes-128-cbc', k, iv);
    const expected = Buffer.concat([c.update(d), c.final()]);
    assert.equal(hex(aes128CbcEncrypt(k, iv, d)), hex(expected), `encrypt ${n}`);
    assert.equal(hex(/** @type {Uint8Array} */ (aes128CbcDecrypt(k, iv, expected))), hex(d), `decrypt ${n}`);
    const dc = createDecipheriv('aes-128-cbc', k, iv);
    assert.equal(hex(Buffer.concat([dc.update(aes128CbcEncrypt(k, iv, d)), dc.final()])), hex(d));
  }
  assert.equal(pkcs7Unpad(new Uint8Array(16)), null, 'zero padding is invalid');
  assert.equal(aes128CbcDecrypt(key, pt, new Uint8Array(15)), null, 'partial block');
  assert.throws(() => aes128CbcEncrypt(key, pt, new Uint8Array(5), { padding: false }), /whole blocks/);
});

// ---------------------------------------------------------------------------------------------
// Assemblers
// ---------------------------------------------------------------------------------------------

/** @param {(h: any) => { push: (c: Uint8Array) => void }} make */
function collect(make) {
  /** @type {Uint8Array[]} */
  const frames = [];
  /** @type {string[]} */
  const discarded = [];
  const asm = make({ onFrame: (/** @type {Uint8Array} */ f) => frames.push(f), onDiscard: (/** @type {Uint8Array} */ _b, /** @type {string} */ reason) => discarded.push(reason) });
  return { asm, frames, discarded };
}

test('AA 55 assembler: chunks, garbage, CR LF inside the data, bad CRC and resynchronisation', () => {
  const main = bytesOf('rs485-rx-01-se-g51-1');
  const cells = bytesOf('rs485-rx-04-se-g51-1');
  // 0x0D30 / 0x0D31 cell values hold 0x0D: frames are found by length and CRC only.
  assert.ok(hex(cells).includes('0D31'));
  const { asm, frames, discarded } = collect((h) => P.createAa55Assembler(h));
  const stream = new Uint8Array([0x00, 0xaa, 0x13, ...main, 0x55, ...cells]);
  for (let i = 0; i < stream.length; i += 7) asm.push(stream.subarray(i, i + 7));
  assert.deepEqual(frames.map((f) => f[3]), [1, 4]);
  assert.ok(discarded.length > 0);
  // A corrupted frame drops one byte; the next frame is still found.
  const broken = Uint8Array.from(main);
  broken[20] ^= 0xff;
  frames.length = 0;
  asm.push(new Uint8Array([...broken, ...bytesOf('rs485-rx-03-se-g51-1')]));
  assert.deepEqual(frames.map((f) => f[3]), [3]);
});

test('assemblers: frames of other protocols are never taken for Deye frames', () => {
  const { asm, frames } = collect((h) => P.createAa55Assembler(h));
  // Seplos V2 ASCII and Pylontech '~' frames, Seplos V3 Modbus and V2 BLE frames.
  for (const v of seplosVectors) asm.push(fromHex(v.hex));
  // NEEY balancer frames start with AA 55 11 (spec 12).
  for (const v of neeyVectors) asm.push(fromHex(v.hex));
  // CH340 USB-CAN analyzer frames 'AA 55 01 01 01 <id> ...' ([PSR] Can bus analysis.txt).
  asm.push(fromHex('AA5501010156030000000800000000000000000000000000'));
  asm.push(fromHex('AA550101015103000000080048020000FC08E00100CB'));
  for (const id of ['pylon-tx-42-adr02', 'pylon-rx-empty-adr02']) asm.push(bytesOf(id));
  assert.equal(frames.length, 0, frames.map((f) => hex(f)).join(' '));
  // The Seplos V2 assembler ignores the AA 55 frames in turn.
  const s = collect((h) => SeplosV2.createAsciiAssembler(h));
  for (const v of vectors.filter((x) => x.variant === 'DEYE_RS485')) s.asm.push(fromHex(v.hex));
  assert.equal(s.frames.length, 0);
});

test('BLE assembler: split notifications, handshake, keyless data, resynchronisation', () => {
  const v = byId('ble-rx-04-encrypted');
  /** @type {string | null} */
  let key = null;
  const { asm, frames, discarded } = collect((h) => P.createBleAssembler({ ...h, getKey: () => key }));
  // Encrypted data before the handshake has no key: discarded.
  asm.push(fromHex(v.hex));
  assert.equal(frames.length, 0);
  assert.deepEqual(discarded, ['data before the session key']);
  // The cipher message, split 20 + 6.
  const cipher = bytesOf('ble-rx-cipher-1');
  asm.push(cipher.subarray(0, 20));
  asm.push(cipher.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal(P.parseHandshake(frames[0])?.tag, 'cipher');
  // A 96 byte answer in 20 byte notifications: 80 bytes do not yet decrypt.
  key = v.expected.key;
  const bytes = fromHex(v.hex);
  for (let i = 0; i < bytes.length; i += 20) asm.push(bytes.subarray(i, i + 20));
  assert.equal(frames.length, 2);
  assert.equal(hex(frames[1]), v.expected.plain);
  // Junk, then a whole answer in one notification: the answer wins.
  discarded.length = 0;
  asm.push(fromHex('00112233445566778899AABBCCDDEEFF0011'));
  const two = byId('ble-rx-02-encrypted');
  key = two.expected.key;
  asm.push(fromHex(two.hex));
  assert.equal(frames.length, 3);
  assert.equal(hex(frames[2]), two.expected.plain);
  assert.deepEqual(discarded, ['undecodable message']);
  // A wrong key never yields a frame.
  key = '0000000000000000';
  asm.push(fromHex(two.hex));
  assert.equal(frames.length, 3);
});

// ---------------------------------------------------------------------------------------------
// Snapshot mapping
// ---------------------------------------------------------------------------------------------

/** @param {string} id */
const dataOf = (id) => /** @type {any} */ (P.parseFrame(bytesOf(id))).data;

test('snapshot: SE-G5.1 Pro (LVESS02) answers', () => {
  const main = P.parseMain(dataOf('rs485-rx-01-se-g51-7'));
  const temps = P.parseTemperatures(dataOf('rs485-rx-03-se-g51-1'));
  const cells = P.parseCells(dataOf('rs485-rx-04-se-g51-7'));
  const alarmBlock = P.parseAlarmBlock(dataOf('rs485-rx-02-se-g51-1'));
  const s = aa55Snapshot({ main, temps, cells, alarmBlock });
  assert.equal(s.voltage, 54);
  assert.equal(s.current, 6.9, 'positive while charging (vendor tool: Charge)');
  assert.equal(s.soc, 93.9);
  assert.equal(s.soh, 100);
  assert.equal(s.cycles, 5);
  assert.equal(s.capacityNominal, 100, 'battery type 3: EVE 100 Ah cells, 16S1P');
  assert.equal(s.cells?.length, 16);
  assert.equal(s.cells?.[7], 3.376);
  assert.deepEqual(
    s.temperatures?.map((x) => `${x.id}:${x.kind}:${x.value}`),
    ['t1:cell:16', 't2:cell:16', 't3:cell:16', 't4:cell:16', 't5:cell:16', 't6:cell:16', 'mos:mos:17', 'board:board:20'],
    'heater -40 means no sensor',
  );
  assert.deepEqual(s.switches, { charge: true, discharge: true });
  assert.deepEqual(s.alarms, []);
  assert.equal(s.extra?.chargeCurrentLimit.value, 40);
  assert.equal(s.extra?.dischargeCurrentLimit.value, 100);
  assert.equal(s.extra?.mosState.value, '0x03');
  assert.equal(s.extra?.subState.value, '0x0F');
  assert.equal(s.extra?.socAh, undefined, 'both SOC values equal');
  const info = aa55Info(main, { protocol: 'x' });
  assert.equal(info.vendor, 'Deye');
  assert.equal(info.model, 'LVESS02_V1');
  assert.equal(info.softwareVersion, 'LVESS0223526N03');
  assert.equal(info.extra?.batteryType.value, '3 (EVE 100 Ah)');
  assert.equal(info.extra?.currentEncoding.value, 'Offset 3000 (confirmed)');
  assert.equal(info.serialNumber, undefined, 'RS485 has no serial number');
});

test('snapshot: LVESS15 pack, presumed current offset, alarm bytes, unknown MOSFET order', () => {
  const main = P.parseMain(dataOf('rs485-rx-01-lvess15'));
  assert.equal(main.currentOffset, 30000);
  assert.equal(main.current, 24);
  const s = aa55Snapshot({ main, temps: P.parseTemperatures(dataOf('rs485-rx-03-lvess15')), cells: P.parseCells(dataOf('rs485-rx-04-lvess15')), alarmBlock: null });
  assert.equal(s.current, 24);
  assert.deepEqual(s.temperatures?.map((x) => x.id), ['t1', 't2', 't3', 't4', 't5', 't6', 'mos'], 'board and heater read -40: no sensors');
  assert.equal(s.extra?.chargeRequest.value, '0x01');
  assert.equal(s.capacityNominal, undefined, 'type 27 is in no list');
  assert.equal(aa55Info(main, { protocol: 'x' }).extra?.currentEncoding.value, 'Offset 30000 (not confirmed)');
  assert.equal(aa55Info(main, { protocol: 'x' }).extra?.batteryType.value, '27');
  // Code 0 was never set: a translatable text, not the vendor tool word "undefined".
  assert.equal(aa55Info({ ...main, batteryType: 0 }, { protocol: 'x' }).extra?.batteryType.value, 'Not set');
  assert.equal(P.batteryTypeText(0), 'Not set');
  // Current decoding: both ranges, rejected values.
  assert.deepEqual(P.decodeCurrent(3000), { offset: 3000, current: 0 });
  assert.deepEqual(P.decodeCurrent(2000), { offset: 3000, current: -100 });
  assert.deepEqual(P.decodeCurrent(14999), { offset: 3000, current: undefined });
  assert.deepEqual(P.decodeCurrent(29000), { offset: 30000, current: -100 });
  assert.deepEqual(P.decodeCurrent(15000), { offset: 30000, current: undefined });
  assert.deepEqual(P.decodeCurrent(65535), { offset: 30000, current: undefined });
  const bad = aa55Snapshot({ main: { ...main, current: undefined, currentRaw: 50000 } });
  assert.equal(bad.current, undefined);
  assert.equal(bad.extra?.currentRaw.value, 50000);
  // A non-zero 0x02 byte becomes one raw alarm.
  const raw = aa55Snapshot({ main, alarmBlock: P.parseAlarmBlock(Uint8Array.of(0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 1)) });
  assert.equal(raw.alarms?.length, 1);
  assert.equal(raw.alarms?.[0].id, 'deye.alarm_raw');
  assert.equal(raw.alarms?.[0].severity, 'warning');
  assert.equal(raw.alarms?.[0].source, '0x02 000004000000000000000001');
  // Only one of the two MOSFET bits: the order is unverified, no switch state.
  assert.equal(aa55Snapshot({ main: { ...main, mosState: 0x01 } }).switches, undefined);
  assert.deepEqual(aa55Snapshot({ main: { ...main, mosState: 0x00 } }).switches, { charge: false, discharge: false });
  // Second SOC value only when it differs.
  assert.equal(aa55Snapshot({ main: { ...main, socAh: 80 } }).extra?.socAh.value, 80);
  // Serial numbers from advertised names.
  assert.equal(serialFromName('BAT00000000000001'), '00000000000001');
  assert.equal(serialFromName('BATTERY'), undefined);
  assert.equal(serialFromName(DEMO_BLE_NAME), undefined);
});

test('detection checks of the 0x01 answer', () => {
  const good = dataOf('rs485-rx-01-se-g51-1');
  assert.equal(P.mainProblem(good), null);
  assert.equal(P.mainProblem(dataOf('rs485-rx-01-lvess15')), null);
  /** @param {(d: Uint8Array) => void} change */
  const variant = (change) => {
    const d = Uint8Array.from(good);
    change(d);
    return P.mainProblem(d);
  };
  assert.match(String(variant((d) => (d[29] = 0))), /cell count/);
  assert.match(String(variant((d) => (d[29] = 33))), /cell count/);
  assert.match(String(variant((d) => (d[28] = 9))), /sensor count/);
  assert.match(String(variant((d) => (d[19] = 0x03))), /voltage/);
  assert.match(String(variant((d) => (d[23] = 0x04))), /SOC/);
  assert.match(String(variant((d) => (d[31] = 0x01))), /printable/);
  assert.match(String(variant((d) => d.fill(0, 30, 60))), /no version/);
  assert.match(String(P.mainProblem(good.subarray(0, 60))), /length/);
  // The 65 byte form of the SE-F16-C app.
  const long = new Uint8Array([...good, 2, 3, 4, 5]);
  assert.equal(P.mainProblem(long), null);
  assert.deepEqual([P.parseMain(long).boardNumber, P.parseMain(long).pcsProtocol, P.parseMain(long).heatingStrategy, P.parseMain(long).buzzer], [2, 3, 4, 5]);
});

test('CAN: fault tables, alarm mapping and severities', () => {
  assert.equal(CAN.FAULT_TABLES.length, 7);
  for (const t of CAN.FAULT_TABLES) assert.equal(t.length, 8);
  for (const t of CAN.FAULT_TABLES) {
    for (const b of t) assert.ok(ALARMS[b.id] || b.id in CAN.DEYE_ALARM_LABELS, `${b.id} is a catalog id or has a label`);
  }
  const a = CAN.faultAlarms([{ origin: 'bank', tables: [0x01, 0, 0, 0x40, 0x01, 0, 0] }]);
  assert.deepEqual(
    a.map((x) => `${x.id}:${x.severity}:${x.source}`),
    ['cell_overvoltage:protection:bank table 1 bit 0', 'deye.pcs_communication:warning:bank table 4 bit 6'],
    'the warning of table 5 bit 0 merges into the protection',
  );
  assert.equal(a[1].label, 'Inverter (PCS) communication failure');
  const afe = CAN.faultAlarms([{ origin: 'pack 2', tables: [0, 0x40, 0x10, 0, 0, 0xc0, 0x21] }]);
  assert.deepEqual(
    afe.map((x) => `${x.id}:${x.severity}`),
    ['discharge_overcurrent:protection', 'short_circuit:protection', 'heater_fault:fault', 'deye.connector_overtemperature:protection', 'cell_wire_open:fault'],
  );
  assert.equal(afe[0].source, 'pack 2 table 2 bit 6 (AFE-OCD1)');
  assert.deepEqual(CAN.faultAlarms([{ origin: 'bank', tables: [0, 0, 0, 0, 0, 0, 0] }]), []);
});

test('CAN: range checks drop frames of the shifted firmware and broken frames', () => {
  /** @param {number} id @param {string} data */
  const dec = (id, data) => CAN.decodeCanFrame({ id, data: fromHex(data) });
  assert.match(String(dec(0x351, '0000000000000000')?.problem), /voltage limits/, 'all zero 0x351 = shifted 0x750 of pack 2');
  assert.equal(dec(0x351, '48020000FC08E001')?.problem, undefined);
  // Shifted 0x550 arriving as 0x150, 0x600 as 0x200, 0x650 as 0x250 (spec 12).
  assert.ok(dec(0x150, '2E18000035020000')?.problem);
  assert.ok(dec(0x200, '53414D504C453030')?.problem);
  assert.ok(dec(0x250, '53414D504C453031')?.problem);
  assert.ok(dec(0x355, '6500640000000000')?.problem, 'SOC 101 %');
  assert.ok(dec(0x400, '0300000000000000')?.problem, 'mode 3');
  // SOH 0: the zero counters of a shifted 0x750 on 0x355, energy counters on 0x150 (spec 12).
  assert.ok(dec(0x355, '0000000000000000')?.problem, 'SOH 0 on 0x355');
  assert.ok(dec(0x150, 'F40100002C010000')?.problem, '0.5 kWh charged, 0.3 kWh discharged: 50 V, SOC 30 %, SOH 0');
  // 35..65 V for the bank and pack voltages ([VP]).
  assert.ok(dec(0x356, 'A40D0000FA000000')?.problem, '34.92 V');
  assert.equal(dec(0x356, '6C140000FA000000')?.problem, undefined, '52.28 V');
  assert.ok(dec(0x150, 'A2020000E803E803')?.problem, '67.4 V');
  assert.equal(dec(0x150, '1102000014032003')?.problem, undefined, '52.9 V, SOC 78.8 %, SOH 80.0 %');
  // Identifiers outside the protocol, extended and short frames.
  assert.equal(dec(0x0a0, '0000000000000000'), null);
  assert.equal(dec(0x110 + 32, '0000000000000000'), null, 'beyond 32 packs');
  assert.equal(CAN.decodeCanFrame({ id: 0x351, extended: true, data: fromHex('48020000FC08E001') }), null);
  assert.equal(CAN.decodeCanFrame({ id: 0x351, data: fromHex('480200') }), null);
  assert.deepEqual(CAN.packOf(0x151), { base: 0x150, pack: 2 });
  assert.deepEqual(CAN.packOf(0x76f), { base: 0x750, pack: 32 });
  const st = new CAN.DeyeCanState();
  st.ingest({ id: 0x351, extended: false, remote: false, dlc: 8, data: new Uint8Array(8) });
  assert.equal(st.rejected, 1);
  assert.equal(st.bank.limits, undefined);
});

/** @param {number} id @param {ArrayLike<number>} data */
const canFrame = (id, data) => ({ id, extended: false, remote: false, dlc: 8, data: Uint8Array.from(data) });
/** @param {number} v */
const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
/** @param {number} v */
const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

test('CAN: the shifted identifier layout is proven, undone, and its collisions are caught', () => {
  const t0 = 1_000_000;
  const version = [0xf0, 0x02, 0xaa, ...ascii('V1.0F')];
  const status = [1, 0, 5, 0, 0, 0, 0x0f, 0];
  const summary = [...le16(529), ...le16(0), ...le16(788), ...le16(1000)];

  // Documented layout: a frame at 0x400 or above, and nothing is ever remapped.
  {
    const st = new CAN.DeyeCanState();
    st.ingest(canFrame(0x400, status), t0);
    for (const id of [0x100, 0x101]) st.ingest(canFrame(id, version), t0);
    assert.equal(st.layout.documented, true);
    assert.equal(st.layout.active, false);
    assert.equal(st.ingest(canFrame(0x000, status), t0), null, '0x000 is no Deye identifier');
  }

  // Shifted: two evidence frames activate the layout.
  const st = new CAN.DeyeCanState();
  st.ingest(canFrame(0x100, version), t0);
  assert.equal(st.layout.active, false, 'one frame is not enough');
  const serial = st.ingest(canFrame(0x200, ascii('DEMO0000')), t0);
  assert.equal(st.layout.active, true);
  assert.deepEqual([serial?.name, serial?.pack, serial?.shiftedFrom], ['serial1', 1, 0x200], 'the second evidence frame is remapped');
  // Sixteen packs with fault, summary and status frames.
  for (let n = 1; n <= 16; n++) {
    st.ingest(canFrame(0x110 + n - 1, [0, 0, 0, 0, 0, 0, 0, 0x31]), t0);
    assert.equal(st.ingest(canFrame(0x150 + n - 1, summary), t0)?.name, 'summary');
    assert.equal(st.ingest(canFrame(0x000 + n - 1, status), t0)?.name, 'status');
  }
  assert.equal(st.packs.size, 16);
  assert.equal(st.packs.get(16)?.status.fields.cycles, 5);
  assert.equal(st.ingest(canFrame(0x101, version), t0)?.name, 'software');
  assert.equal(st.ingest(canFrame(0x250, ascii('PACK0001')), t0)?.name, 'serial2');
  assert.equal(st.serialNumber(1), 'DEMO0000PACK0001');
  // 0x510 of pack 17 lands on 0x110 (the fault frame of pack 1): the version shape tells them apart.
  assert.equal(st.ingest(canFrame(0x110, version), t0)?.name, 'software');
  assert.deepEqual(st.packs.get(1)?.faults.fields.tables, [0, 0, 0, 0, 0, 0, 0]);

  // Energy counters on 0x150: out of the summary ranges, or continuing the previous counters.
  const e1 = st.ingest(canFrame(0x150, [...le32(340), ...le32(65536 + 500)]), t0);
  assert.equal(e1?.name, 'energy', '34.0 V is no summary');
  const e2 = st.ingest(canFrame(0x150, [...le32(360), ...le32(65536 + 505)]), t0 + 5300);
  assert.deepEqual([e2?.name, e2?.fields.chargedEnergy, e2?.fields.dischargedEnergy], ['energy', 0.36, 66.041], 'summary shaped, but it continues the counters');
  assert.equal(st.ingest(canFrame(0x150, summary), t0 + 5400)?.name, 'summary');

  // Counter frames on identifiers no bank frame uses are remapped.
  assert.equal(st.ingest(canFrame(0x300, [2, 0, 26, 0, 0, 0, 0, 0]), t0)?.name, 'counts1');
  for (const id of [0x350, 0x352, 0x353, 0x354, 0x357]) {
    const d = st.ingest(canFrame(id, [2, 0, 1, 0, 0, 0, 0, 0]), t0);
    assert.deepEqual([d?.name, d?.pack], ['counts2', id - 0x350 + 1], `0x${id.toString(16)}`);
  }

  // 0x305..0x307: counter frames of packs 6..8 every 5.3 s, the inverter every second.
  assert.equal(st.ingest(canFrame(0x306, [2, 0, 26, 0, 0, 0, 0, 0]), t0)?.name, 'counts1');
  assert.equal(st.ingest(canFrame(0x306, [2, 0, 26, 0, 0, 0, 0, 0]), t0 + 5300)?.name, 'counts1');
  assert.equal(st.inverterAt, 0, 'no inverter without a once per second sender');
  st.ingest(canFrame(0x305, new Uint8Array(8)), t0 + 6000);
  assert.equal(st.ingest(canFrame(0x305, new Uint8Array(8)), t0 + 7000)?.scope, 'inverter');
  assert.equal(st.inverterAt, t0 + 7000);

  // Bank frames that share an identifier with the 0x750 frame of an existing pack.
  const t = t0 + 8000;
  const counts2 = [2, 0, 1, 0, 0, 0, 0, 0];
  const rejected = (/** @type {number} */ id, /** @type {ArrayLike<number>} */ data, at = t) => st.ingest(canFrame(id, data), at)?.problem;
  assert.ok(rejected(0x351, counts2), 'pack 2: range checks');
  assert.match(String(rejected(0x355, counts2)), /SOC 2 % disagrees/, 'pack 6: SOC 2 %, SOH 1 %');
  assert.equal(rejected(0x355, [79, 0, 100, 0, 0, 0, 0, 0]), undefined, 'the bank SOC agrees with the packs');
  assert.ok(rejected(0x356, counts2), 'pack 7: range checks');
  assert.equal(rejected(0x356, [...le16(5228), 0, 0, 250, 0, 0, 0]), undefined);
  assert.match(String(rejected(0x359, counts2)), /fault bits/, 'pack 10: an over-current count is no cell undervoltage');
  assert.equal(rejected(0x359, new Uint8Array(8)), undefined, 'the union of the pack fault tables');
  assert.match(String(rejected(0x35e, counts2)), /no battery identity|foreign identity/, 'pack 15');
  assert.ok(rejected(0x35f, counts2), 'pack 16: no DY suffix');
  // 0x35C (pack 13) has no per-pack counterpart: it must repeat within one bank cycle.
  const flags = [0xc0, 0, 0, 0, 0, 0, 0, 0];
  assert.ok(rejected(0x35c, flags, t), 'first frame: nothing to compare with');
  assert.equal(rejected(0x35c, flags, t + 1000), undefined);
  assert.ok(rejected(0x35c, counts2, t + 1500));
  assert.ok(rejected(0x35c, flags, t + 2000), 'differs from the counter frame before it');
  assert.equal(rejected(0x35c, flags, t + 3000), undefined);
  assert.equal(st.bank.flags.fields.chargeEnable, true);
  const s = CAN.canSnapshot(st, t + 3000);
  assert.equal(s.soc, 79);
  assert.deepEqual(s.alarms, []);
  assert.ok(st.layout.remapped > 0);

  // A documented frame later ends the remapping.
  st.ingest(canFrame(0x400, status), t + 3100);
  assert.equal(st.layout.active, false);
  assert.equal(st.ingest(canFrame(0x000, status), t + 3200), null);
});

test('CAN: state, profiles, detection rules and the bank snapshot from the vectors', () => {
  const st = new CAN.DeyeCanState();
  const now = Date.now();
  const native = vectors.filter((v) => v.variant === 'DEYE_PCS_CAN' && v.expected.profile === 'deye');
  for (const v of native) for (const f of canFramesOf(fromHex(v.hex))) st.ingest(f, now);
  assert.equal(st.profile, 'deye');
  assert.deepEqual(st.detection(), { confidence: 0.95, profile: 'deye' });
  assert.equal(st.serialNumber(1), 'SAMPLE00SAMPLE01');
  const s = CAN.canSnapshot(st, now);
  assert.ok(s.voltage !== undefined && s.voltage > 53 && s.voltage < 54);
  assert.equal(s.soc, 99.8, 'single pack: SOC of 0x150 in 0.1 %');
  assert.equal(s.capacityNominal, 230);
  assert.equal(s.cells, undefined, 'no individual cells on CAN');
  assert.deepEqual(s.switches, { charge: true, discharge: true, precharge: false, heater: false });
  assert.equal(s.extra?.chargeVoltageLimit.value, 58.4);
  assert.equal(s.extra?.chargedEnergy.value, 6.19);
  assert.equal(s.extra?.mode.value, 'Charging');
  assert.ok(s.temperatures?.some((x) => x.id === 'mos' && x.value === 27));
  assert.ok(!s.temperatures?.some((x) => x.id === 'heater'), '-40 means no heater sensor');
  assert.deepEqual(s.alarms, []);
  const info = CAN.canInfo(st, 'Deye PCS CAN');
  assert.equal(info.serialNumber, 'SAMPLE00SAMPLE01');
  assert.equal(info.softwareVersion, 'F005');
  assert.equal(info.hardwareVersion, 'F002');
  assert.equal(info.extra?.bootVersion.value, 'V1.0F');
  assert.equal(info.extra?.profile.value, 'Deye native');

  // victronCAN: 0x35E PYLON plus 0x35F DY; the 0x356 sign is inverted.
  const vic = new CAN.DeyeCanState();
  for (const id of ['can-35e-pylon', 'can-35f-victron', 'can-356-charge-victron']) for (const f of canFramesOf(bytesOf(id))) vic.ingest(f, now);
  assert.equal(vic.profile, 'victron');
  assert.equal(vic.detection()?.confidence, 0.95);
  assert.equal(CAN.canSnapshot(vic, now).current, 0.6);
  // Deye native charge: wire -0.6 A, model +0.6 A.
  const nat = new CAN.DeyeCanState();
  for (const id of ['can-35e-dy', 'can-356-charge-native']) for (const f of canFramesOf(bytesOf(id))) nat.ingest(f, now);
  assert.equal(CAN.canSnapshot(nat, now).current, 0.6);

  // 0.6 rule: 0x351, 0x355, 0x356 and a Deye per-pack frame, no identity yet.
  const partial = new CAN.DeyeCanState();
  for (const id of ['can-351-ccl0', 'can-355', 'can-356-idle']) for (const f of canFramesOf(bytesOf(id))) partial.ingest(f, now);
  assert.equal(partial.detection(), null, 'Pylontech-like frames alone are not enough');
  for (const f of canFramesOf(bytesOf('can-150-pack1'))) partial.ingest(f, now);
  assert.deepEqual(partial.detection(), { confidence: 0.6, profile: undefined });
  // Identity of another battery without Deye frames.
  const pylon = new CAN.DeyeCanState();
  for (const id of ['can-351-ccl0', 'can-355', 'can-356-idle']) for (const f of canFramesOf(bytesOf(id))) pylon.ingest(f, now);
  pylon.ingest({ id: 0x35e, extended: false, remote: false, dlc: 8, data: ascii('PYLON   ') }, now);
  assert.equal(pylon.detection(), null);
  // With the standard per-pack identifiers too: the 0.6 rule needs the absence of an identity
  // (spec 11.2 steps 4 and 5), and a Pylontech identity alone keeps the native current sign.
  for (const f of canFramesOf(bytesOf('can-150-pack1'))) pylon.ingest(f, now);
  assert.equal(pylon.detection(), null, 'a Pylontech identity with 0x110 / 0x150 is still another battery');
  assert.equal(pylon.profile, undefined, 'PYLON without 0x35F "DY" does not select victronCAN');
  assert.equal(pylon.pylonIdentity, true);
  for (const f of canFramesOf(bytesOf('can-35f-victron'))) pylon.ingest(f, now);
  assert.equal(pylon.profile, 'victron');
  assert.equal(pylon.detection()?.confidence, 0.95);
  // A foreign identity does not replace a Deye identity seen in the last seconds.
  const kept = new CAN.DeyeCanState();
  for (const f of canFramesOf(bytesOf('can-35e-dy'))) kept.ingest(f, now);
  assert.ok(kept.ingest({ id: 0x35e, extended: false, remote: false, dlc: 8, data: Uint8Array.of(2, 0, 1, 0, 0, 0, 0, 0) }, now + 500)?.problem);
  assert.equal(kept.bank.identity.fields.manufacturer, 'DY');
  // Stale values are not shown.
  assert.equal(CAN.canSnapshot(st, now + CAN.STALE_MS + 1).voltage, undefined);
});

test('protocol log descriptions', () => {
  assert.equal(P.describeAa55(bytesOf('rs485-tx-01'))?.name, 'Deye Main information request');
  assert.equal(P.describeAa55(bytesOf('rs485-rx-04-se-g51-1'))?.name, 'Deye Cell voltages answer');
  assert.equal(P.describeAa55(bytesOf('rs485-rx-01-se-g51-1'))?.decode().softwareVersion, 'LVESS0223526N03');
  assert.equal(P.describeAa55(bytesOf('rs485-rx-05-se-g51-1'))?.decode().data.length, 128);
  assert.equal(P.describeBle(bytesOf('ble-rx-cipher-1'))?.name, 'Deye handshake cipher');
  assert.equal(CAN.describeSlcan(bytesOf('can-351-ccl0')).name, 'Deye CAN 0x351 limits');
  assert.equal(CAN.describeSlcan(bytesOf('can-150-pack1')).name, 'Deye CAN 0x150 summary, pack 1');
  assert.equal(CAN.describeSlcan(Uint8Array.of(0x0d)).name, 'SLCAN OK');
  assert.equal(CAN.describeSlcan(Uint8Array.of(0x07)).name, 'SLCAN refused (BEL)');
  assert.equal(CAN.describeSlcan(ascii('T18A2FF80101\r')).name, 'CAN 0x18A2FF80 (29-bit)');
  assert.match(CAN.describeSlcan(ascii('t35180000000000000000\r')).name, /ignored/);
});

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

/**
 * @param {any} def
 * @param {(device: any) => any} [attach]
 * @param {{ kind?: string, name?: string, options?: Record<string, any>, deviceChunkSize?: number }} [opts]
 */
async function probeWith(def, attach, { kind = 'memory', name, options = {}, deviceChunkSize = 0 } = {}) {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, kind, name, deviceChunkSize });
  await host.open();
  await device.open();
  const sim = attach?.(device);
  const driver = def.create({ link: host, log, profileId: 'direct', options });
  return { driver, sim, log, host, device };
}

test('detection: the RS485 probe reads 0x01 and 0x04 only and accepts its own pack', async () => {
  {
    const { driver, sim } = await probeWith(deyeRs485Definition, (d) => createDeyeRs485Simulator(d, { tickMs: 0 }), { kind: 'serial' });
    const r = await driver.probe({ timeout: 1000 });
    assert.equal(r?.variant, 'DEYE_RS485');
    assert.equal(r?.confidence, 0.95);
    assert.equal(r?.info?.softwareVersion, 'LVESS0223526N03');
    assert.deepEqual(sim.state.received.map((/** @type {any} */ x) => x.command), [1, 4]);
    driver.dispose();
    sim.stop();
  }
  // Another firmware text: 0.8. An address from the options is used.
  {
    const { driver, sim } = await probeWith(deyeRs485Definition, (d) => createDeyeRs485Simulator(d, { tickMs: 0, address: 3, software: 'BMS-X 1.0' }), { options: { address: 3 } });
    const r = await driver.probe({ timeout: 1000 });
    assert.equal(r?.confidence, 0.8);
    assert.ok(sim.state.received.every((/** @type {any} */ x) => x.address === 3));
    driver.dispose();
    sim.stop();
  }
  // The pack does not answer another address.
  {
    const { driver, sim } = await probeWith(deyeRs485Definition, (d) => createDeyeRs485Simulator(d, { tickMs: 0, address: 2 }));
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    driver.dispose();
    sim.stop();
  }
  // Silence.
  {
    const { driver } = await probeWith(deyeRs485Definition);
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    driver.dispose();
  }
});

test('detection: implausible answers and other batteries are rejected', async () => {
  // A pack whose 0x01 answer fails the checks (cell count 0).
  {
    const bat = { soc: 50, mosTemp: 20, ambient: 20, cycles: 0, voltage: 52, current: 0, switches: { charge: true, discharge: true }, cellCount: 0, temps: [20], cellVoltages: () => [], step() {} };
    const { driver, sim, log } = await probeWith(deyeRs485Definition, (d) => createDeyeRs485Simulator(d, { tickMs: 0, battery: /** @type {any} */ (bat) }));
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    assert.ok(log.entries().some((e) => /cell count 0/.test(e.text ?? '')));
    driver.dispose();
    sim.stop();
  }
  // A Seplos V2 pack waits for '~' and ignores the AA 55 probe; it is still found by its own driver.
  for (const baud of [9600, 19200]) {
    const { driver, sim } = await probeWith(deyeRs485Definition, (d) => createSeplosV2Simulator(d, { tickMs: 0 }), { kind: `serial-${baud}` });
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    assert.equal(sim.state.received.length, 0, 'no ~ frame was seen');
    driver.dispose();
    sim.stop();
  }
  // The Deye pack ignores the Seplos V2 probe (0x51, 0x42) and the JBD read.
  {
    const { driver, sim } = await probeWith(seplosV2Definition, (d) => createDeyeRs485Simulator(d, { tickMs: 0 }));
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    assert.equal(sim.state.received.length, 0);
    driver.dispose();
    sim.stop();
  }
  {
    const { driver, sim } = await probeWith(deyeRs485Definition, (d) => createJbdSimulator(d, { tickMs: 0 }));
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    driver.dispose();
    sim.stop?.();
  }
  // Captured Seplos V2 answers and the Pylontech empty answer on the link never pass.
  {
    const { driver, device } = await probeWith(deyeRs485Definition);
    const answers = [...seplosVectors.filter((v) => v.variant === 'SEPLOS_V2_ASCII' && v.direction === 'rx').map((v) => v.hex), byId('pylon-rx-empty-adr02').hex];
    const off = device.on('data', () => {
      for (const h of answers) void device.write(fromHex(h));
    });
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    off();
    driver.dispose();
  }
});

test('detection: the Bluetooth probe checks the cipher block and reads 0x01', async () => {
  const name = 'BAT2312345678901';
  {
    const { driver, sim } = await probeWith(deyeBleDefinition, (d) => createDeyeBleSimulator(d, { tickMs: 0, name }), { name, deviceChunkSize: 20 });
    const r = await driver.probe({ timeout: 2000 });
    assert.equal(r?.variant, 'DEYE_BLE');
    assert.equal(r?.confidence, 0.98);
    assert.equal(r?.info?.serialNumber, '2312345678901');
    assert.equal(sim.state.handshakes, 1);
    assert.deepEqual(sim.state.received.map((/** @type {any} */ x) => x.command), [1]);
    // Writes: random (26 bytes), result (11), one encrypted request (32): nothing else.
    assert.deepEqual(sim.state.writes.map((/** @type {Uint8Array} */ w) => w.length), [26, 11, 32]);
    assert.equal(sim.state.ignored, 0);
    driver.dispose();
    sim.stop();
  }
  // The vector session: random string of battery 1, recomputed key and block.
  {
    const v = byId('ble-tx-random-1').expected;
    const { driver, sim } = await probeWith(deyeBleDefinition, (d) => createDeyeBleSimulator(d, { tickMs: 0, name: v.name }), { name: v.name });
    /** @type {any} */ (driver).random = () => v.randomStr;
    const r = await driver.probe({ timeout: 2000 });
    assert.equal(r?.confidence, 0.98);
    assert.equal(hex(sim.state.writes[0]), byId('ble-tx-random-1').hex);
    assert.equal(/** @type {any} */ (driver).key, v.key);
    driver.dispose();
    sim.stop();
  }
  // A name that differs from the one the battery uses: the block does not match.
  {
    const { driver, sim, log } = await probeWith(deyeBleDefinition, (d) => createDeyeBleSimulator(d, { tickMs: 0, name: 'BAT0000000000009' }), { name });
    assert.equal(await driver.probe({ timeout: 2000 }), null);
    assert.ok(log.entries().some((e) => /does not match/.test(e.text ?? '')));
    assert.equal(sim.state.key, null, 'no result was sent');
    driver.dispose();
    sim.stop();
  }
  // Silence and a device that answers with a valid trailer but a foreign block.
  {
    const { driver } = await probeWith(deyeBleDefinition, undefined, { name });
    assert.equal(await driver.probe({ timeout: 1500 }), null);
    driver.dispose();
  }
  {
    const { driver, device } = await probeWith(deyeBleDefinition, undefined, { name });
    device.on('data', () => void device.write(bytesOf('ble-rx-cipher-2')));
    assert.equal(await driver.probe({ timeout: 1500 }), null);
    driver.dispose();
  }
  // Handshake accepted but no encrypted answer: 0.9.
  {
    const { driver, sim } = await probeWith(deyeBleDefinition, (d) => createDeyeBleSimulator(d, { tickMs: 0, name, address: 7 }), { name });
    const r = await driver.probe({ timeout: 1500 });
    assert.equal(r?.confidence, 0.9);
    driver.dispose();
    sim.stop();
  }
});

test('Bluetooth: a session the battery dropped is renewed after two polls without an answer', async () => {
  const name = 'BAT2312345678901';
  const { driver, sim, log } = await probeWith(deyeBleDefinition, (d) => createDeyeBleSimulator(d, { tickMs: 0, name }), { name, deviceChunkSize: 20 });
  const d = /** @type {any} */ (driver);
  try {
    assert.ok(await driver.probe({ timeout: 2000 }));
    d.answerTimeout = 150;
    await driver.poll();
    assert.equal(sim.state.handshakes, 1);
    // The module forgets the session while GATT stays up: requests with the old key are ignored.
    sim.dropSession();
    await assert.rejects(driver.poll(), /No answer/);
    await assert.rejects(driver.poll(), /No answer/);
    assert.equal(d.mainTimeouts, 2);
    assert.equal(sim.state.handshakes, 1, 'no new handshake before the second failed poll');
    /** @type {any} */
    let snap = null;
    driver.on('snapshot', (/** @type {any} */ s) => (snap = s));
    await driver.poll();
    assert.equal(sim.state.handshakes, 2);
    assert.equal(d.mainTimeouts, 0);
    assert.equal(snap?.cells.length, 16);
    assert.ok(log.entries().some((e) => /renewing the session/.test(e.text ?? '')));
    // A refused renewal (the block does not match the name) fails the poll with no answer.
    sim.dropSession();
    d.deviceName = 'BAT0000000000009';
    d.mainTimeouts = 2;
    await assert.rejects(driver.poll(), /No answer/);
    assert.equal(d.key, null);
  } finally {
    driver.dispose();
    sim.stop();
  }
});

test('AA 55: shorter 0x03 and 0x04 answers of the app configuration are accepted', () => {
  // [SX] app configuration: 0x03 with 13 bytes, 0x04 with 40 (16 cells); captures: 21 and 72.
  const temps = P.encodeFrame(1, 3, [56, 6, 56, 1, 0, 56, 56, 56, 56, 56, 56, 0, 0]);
  assert.equal(P.isAnswer(temps), true);
  const t = P.parseTemperatures(/** @type {any} */ (P.parseFrame(temps)).data);
  assert.deepEqual([t.maxTemp, t.temperatures.slice(0, 6), t.padding], [16, [16, 16, 16, 16, 16, 16], 0]);
  const cellData = [0x0d, 0x34, 15, 0x0d, 0x30, 8, 0, 4, ...Array.from({ length: 16 }, () => [0x0d, 0x31]).flat()];
  const cells = P.encodeFrame(1, 4, cellData);
  assert.equal(P.isAnswer(cells), true);
  const c = P.parseCells(/** @type {any} */ (P.parseFrame(cells)).data);
  assert.equal(c.cellSlots, 16);
  assert.equal(c.cellVoltages.length, 16);
  assert.equal(c.cellVoltages[15], 3.377);
  const main = P.parseMain(dataOf('rs485-rx-01-se-g51-1'));
  assert.equal(aa55Snapshot({ main, cells: c }).cells?.length, 16);
  // Too short, an odd cell array, and the other commands keep their captured lengths.
  assert.equal(P.isAnswer(P.encodeFrame(1, 3, new Uint8Array(12))), false);
  assert.equal(P.isAnswer(P.encodeFrame(1, 4, new Uint8Array(38))), false);
  assert.equal(P.isAnswer(P.encodeFrame(1, 4, new Uint8Array(41))), false);
  assert.equal(P.isAnswer(P.encodeFrame(1, 1, new Uint8Array(62))), false);
  assert.equal(P.isAnswer(P.encodeFrame(1, 2, new Uint8Array(13))), false);
  assert.throws(() => P.parseCells(new Uint8Array(38)), /too short/);
});

/**
 * @param {import('../src/deye/simulator.js').CanSimOptions} simOpts
 * @param {number} [listenMs]
 * @param {number} [listenOnlyMs]
 */
async function probeCan(simOpts, listenMs = 3000, listenOnlyMs = 500) {
  const { driver, sim, log, device } = await probeWith(deyeCanDefinition, (d) => createDeyeCanSimulator(d, { tickMs: 0, intervalMs: 200, ...simOpts }), { kind: 'serial' });
  /** @type {any} */ (driver).listenMs = listenMs;
  /** @type {any} */ (driver).listenOnlyMs = listenOnlyMs;
  const started = Date.now();
  const r = await driver.probe({ timeout: 1000 });
  return { r, sim, log, driver, device, ms: Date.now() - started };
}

test('detection: the CAN probe opens listen only, normal mode only for a lone battery', async () => {
  // A lone battery: nothing completes in listen only mode, then the adapter acknowledges.
  for (const closedCloseReply of /** @type {const} */ (['bel', 'cr', 'none'])) {
    const { r, sim, driver, ms, log } = await probeCan({ closedCloseReply });
    assert.equal(r?.variant, 'DEYE_PCS_CAN');
    assert.equal(r?.confidence, 0.95);
    assert.ok(ms < 1500, `${ms} ms: the identity frame ends the listen window`);
    assert.deepEqual(sim.state.commands, ['C', 'S6', 'L', 'C', 'O']);
    assert.equal(sim.state.mode, 'normal', 'acknowledging mode for a lone battery');
    assert.equal(/** @type {any} */ (driver).mode, 'normal');
    assert.ok(log.entries().some((e) => /normal mode, lone battery/.test(e.text ?? '')));
    assert.deepEqual(sim.state.transmitted, [], 'never a CAN frame');
    await driver.stop();
    await sleep(10);
    assert.equal(sim.state.open, false, 'closed with C');
    driver.dispose();
    sim.stop();
  }
  // An inverter acknowledges: the adapter stays listen only.
  {
    const { r, sim, driver, ms, log } = await probeCan({ heartbeat: true });
    assert.equal(r?.confidence, 0.95);
    assert.ok(ms < 1000, `${ms} ms`);
    assert.deepEqual(sim.state.commands, ['C', 'S6', 'L']);
    assert.equal(sim.state.mode, 'listen');
    assert.ok(log.entries().some((e) => /listen only mode \(another node/.test(e.text ?? '')));
    driver.dispose();
    await sleep(10);
    assert.equal(sim.state.open, false, 'dispose closes the channel too');
    sim.stop();
  }
  // victronCAN profile.
  {
    const { r, driver, sim } = await probeCan({ profile: 'victron', otherNode: true });
    assert.equal(r?.confidence, 0.95);
    assert.equal(r?.info?.extra?.profile.value, 'victronCAN (Pylontech identity)');
    driver.dispose();
    sim.stop();
  }
});

test('detection: an SLCAN channel never stays open after the driver lets go', async () => {
  // A successful probe released without stop() (the session drops it after Cancel).
  {
    const { r, sim, driver } = await probeCan({});
    assert.ok(r);
    assert.equal(sim.state.open, true);
    driver.dispose();
    await sleep(10);
    assert.equal(sim.state.open, false);
    sim.stop();
  }
  // The open command times out although the adapter opened: a best effort C follows.
  {
    const { driver, device } = await probeWith(deyeCanDefinition);
    /** @type {string[]} */
    const got = [];
    device.on('data', (/** @type {Uint8Array} */ c) => {
      const line = text(c).replace(/\r$/, '');
      got.push(line);
      if (line !== 'L') void device.write(Uint8Array.of(0x0d));
    });
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    await sleep(10);
    assert.deepEqual(got, ['C', 'S6', 'L', 'C']);
    driver.dispose();
  }
  // An adapter without listen only mode (BEL to L) is opened normally; closed again without frames.
  {
    const { driver, device, log } = await probeWith(deyeCanDefinition);
    /** @type {any} */ (driver).listenMs = 300;
    /** @type {string[]} */
    const got = [];
    device.on('data', (/** @type {Uint8Array} */ c) => {
      const line = text(c).replace(/\r$/, '');
      got.push(line);
      void device.write(Uint8Array.of(line === 'L' ? 0x07 : 0x0d));
    });
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    await sleep(10);
    assert.deepEqual(got, ['C', 'S6', 'L', 'O', 'C']);
    assert.ok(log.entries().some((e) => /refused listen only mode/.test(e.text ?? '')));
    driver.dispose();
  }
  // Cancelled while listening: no further adapter command except the closing C.
  {
    const { driver, device } = await probeWith(deyeCanDefinition);
    /** @type {string[]} */
    const got = [];
    device.on('data', (/** @type {Uint8Array} */ c) => {
      got.push(text(c).replace(/\r$/, ''));
      void device.write(Uint8Array.of(0x0d));
    });
    const pending = driver.probe({ timeout: 1000 });
    await sleep(100);
    driver.dispose();
    assert.equal(await pending, null);
    await sleep(10);
    assert.deepEqual(got, ['C', 'S6', 'L', 'C']);
  }
});

test('detection: the CAN probe rejects other buses and other adapters', async () => {
  for (const bus of /** @type {const} */ (['pylontech', 'intercan', 'silent'])) {
    const { r, sim, log, driver } = await probeCan({ bus }, 700, 300);
    assert.equal(r, null, bus);
    assert.deepEqual(sim.state.transmitted, []);
    assert.equal(sim.state.open, false, `${bus}: channel closed again`);
    const why = log.entries().filter((e) => /Deye CAN/.test(e.text ?? '')).map((e) => e.text).join(' ');
    // InterCAN runs at 250 kbit/s: at S6 the adapter sees nothing (spec 2.2).
    if (bus === 'intercan' || bus === 'silent') assert.match(why, /no CAN frames/);
    if (bus === 'pylontech') assert.match(why, /another battery: PYLON/);
    driver.dispose();
    sim.stop();
  }
  // Only 29-bit frames at 500 kbit/s (a high voltage control box, spec 6.5).
  {
    const st = new CAN.DeyeCanState();
    st.ingest({ id: 0x4210, extended: true, remote: false, dlc: 8, data: new Uint8Array(8) });
    assert.match(st.detectionProblem(), /29-bit/);
  }
  // A wrong bit rate on the adapter side: no frames.
  {
    const { r, driver, sim } = await probeCan({ bitrate: 250000 }, 700);
    assert.equal(r, null);
    driver.dispose();
    sim.stop();
  }
  // No SLCAN adapter: no CR or BEL.
  {
    const { driver, log } = await probeWith(deyeCanDefinition);
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    assert.ok(log.entries().some((e) => /no SLCAN reply/.test(e.text ?? '')));
    driver.dispose();
  }
  // An adapter that refuses the bit rate (BEL): stop sending.
  {
    const { driver, device, log } = await probeWith(deyeCanDefinition);
    /** @type {string[]} */
    const got = [];
    device.on('data', (/** @type {Uint8Array} */ c) => {
      got.push(text(c));
      void device.write(Uint8Array.of(c[0] === 0x43 ? 0x0d : 0x07));
    });
    assert.equal(await driver.probe({ timeout: 1000 }), null);
    assert.deepEqual(got, ['C\r', 'S6\r']);
    assert.ok(log.entries().some((e) => /refused the bit rate/.test(e.text ?? '')));
    driver.dispose();
  }
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} selection
 * @param {(device: any) => any} attach
 * @param {{ kind?: string, name?: string, deviceChunkSize?: number, list?: any[] }} [opts]
 */
async function connect(selection, attach, { kind = 'memory', name = 'link', deviceChunkSize = 0, list = deyeDrivers } = {}) {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(list), log, pollIntervalMs: 1000, probeTimeoutMs: 1500 });
  const { host, device } = createLinkPair({ log, kind, name, deviceChunkSize });
  await device.open();
  const sim = attach(device);
  const first = new Promise((resolve) => session.once('snapshot', resolve));
  await session.connect({ kind: 'link', link: host, selection });
  /** @type {any} */
  const snap = await first;
  return { session, sim, snap, log, device };
}

test('session: RS485 pack end to end, alarms, info, read only', async () => {
  const { session, sim, snap } = await connect('deye-rs485', (d) => createDeyeRs485Simulator(d, { tickMs: 0 }), { kind: 'serial' });
  try {
    assert.equal(session.variant, 'DEYE_RS485');
    assert.equal(snap.cells.length, 16);
    assert.equal(snap.temperatures.filter((/** @type {any} */ t) => t.kind === 'cell').length, 6);
    assert.ok(snap.cellStats.count === 16);
    assert.ok(snap.voltage > 40 && snap.voltage < 60);
    assert.deepEqual(snap.alarms, []);
    assert.equal(session.driver?.capabilities.settings, false);
    assert.equal(session.driver?.capabilities.writeSettings, false);
    assert.equal(session.driver?.getSettingsSchema(), null);
    await assert.rejects(session.loadSettings(), /does not expose settings/);
    await assert.rejects(session.runAction('anything'), /not supported/);
    // Info arrives after the first poll.
    await sleep(50);
    assert.equal(session.info?.model, 'LVESS02_V1');
    // A non-zero alarm byte shows up in the next poll.
    sim.overrides.alarmBytes = [0, 0, 0, 0x10, 0, 0, 0, 0, 0, 0, 0, 0];
    const next = await new Promise((resolve) => session.once('snapshot', resolve));
    assert.equal(/** @type {any} */ (next).alarms[0].id, 'deye.alarm_raw');
    // Polls send 0x01..0x04 only, never 0x05.
    assert.ok(sim.state.received.every((/** @type {any} */ x) => [1, 2, 3, 4].includes(x.command)));
    assert.ok([1, 2, 3, 4].every((c) => sim.state.received.some((/** @type {any} */ x) => x.command === c)));
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: Bluetooth pack end to end through the encrypted session', async () => {
  const name = 'BAT2312345678901';
  const { session, sim, snap } = await connect('deye-ble', (d) => createDeyeBleSimulator(d, { tickMs: 0, name }), { name, deviceChunkSize: 20 });
  try {
    assert.equal(session.variant, 'DEYE_BLE');
    assert.equal(snap.cells.length, 16);
    assert.ok(snap.soc > 0);
    assert.equal(session.info?.serialNumber, '2312345678901');
    assert.equal(session.info?.model, 'LVESS15MOS');
    assert.equal(sim.state.handshakes, 1);
    assert.equal(sim.state.ignored, 0);
    sim.battery.current = -12.3;
    const next = /** @type {any} */ (await new Promise((resolve) => session.once('snapshot', resolve)));
    assert.equal(next.current, -12.3, 'offset 30000 in the simulated LVESS15 pack');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: CAN bank of two packs, alarms, profile, stall detection', async () => {
  const { session, sim, snap } = await connect('deye-can', (d) => createDeyeCanSimulator(d, { tickMs: 0, intervalMs: 300, packs: 2 }), { kind: 'serial' });
  try {
    assert.equal(session.variant, 'DEYE_PCS_CAN');
    assert.equal(snap.cells, undefined);
    assert.equal(snap.extra.packCount.value, 2);
    assert.ok(snap.extra.pack1 && snap.extra.pack2, 'one summary per pack');
    assert.equal(snap.capacityNominal, 460);
    assert.equal(snap.switches, undefined, 'MOSFET states are per pack in a bank');
    sim.overrides.packTables[2] = [0, 0, 0, 0x40, 0, 0, 0];
    await sleep(700);
    const next = /** @type {any} */ (await new Promise((resolve) => session.once('snapshot', resolve)));
    assert.deepEqual(next.alarms.map((/** @type {any} */ a) => `${a.id}:${a.source}`), ['deye.pcs_communication:pack 2 table 4 bit 6']);
    await sleep(300);
    assert.equal(session.info?.serialNumber, 'DEMO0000PACK0001');
    assert.deepEqual(sim.state.transmitted, []);
    // The adapter stops delivering frames: the poll reports it.
    sim.stop();
    const errors = [];
    for (let i = 0; i < 8 && !errors.length; i++) {
      await sleep(1000);
      errors.push(...session.log.entries().filter((e) => /No CAN frames/.test(e.text ?? '')));
    }
    assert.ok(errors.length > 0);
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: CAN victronCAN profile, single pack values', async () => {
  const { session, sim, snap } = await connect('deye-can', (d) => createDeyeCanSimulator(d, { tickMs: 0, intervalMs: 300, profile: 'victron', otherNode: true }), { kind: 'serial' });
  try {
    sim.battery.current = 8.4;
    await sleep(400);
    const next = /** @type {any} */ (await new Promise((resolve) => session.once('snapshot', resolve)));
    assert.equal(next.current, 8.4, 'charge positive in the model with the inverted 0x356');
    assert.ok(snap.switches && 'charge' in snap.switches);
    assert.equal(session.info?.extra?.profile.value, 'victronCAN (Pylontech identity)');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: CAN bank with the shifted per-pack identifiers keeps plausible values', async () => {
  // Bit 10 cleared: 0x550 arrives as 0x150, 0x600 as 0x200, 0x650 as 0x250 and pack 2's 0x750 on
  // 0x351 (spec 12). The layout is undone, the colliding 0x351 fails its range checks.
  const { session, sim } = await connect('deye-can', (d) => createDeyeCanSimulator(d, { tickMs: 0, intervalMs: 400, packs: 2, shifted: true }), { kind: 'serial' });
  try {
    for (let i = 0; i < 3; i++) {
      const s = /** @type {any} */ (await new Promise((resolve) => session.once('snapshot', resolve)));
      assert.equal(s.extra.chargeVoltageLimit.value, 58.4);
      assert.ok(s.voltage > 40 && s.voltage < 60);
      for (const k of ['pack1', 'pack2']) {
        assert.match(s.extra[k].value, /^5\d\.\d V, -?\d+\.\d A, \d+\.\d %, \d\.\d{3}\.\.\d\.\d{3} V, -?\d+\.\d\.\.-?\d+\.\d °C$/, s.extra[k].value);
      }
    }
    const st = /** @type {any} */ (session.driver).state;
    assert.ok(st.rejected > 0, 'colliding frames were rejected');
    assert.equal(st.layout.active, true);
    assert.equal(st.layout.documented, false);
    assert.ok(st.layout.remapped > 0);
    assert.equal(st.packs.get(2).status.fields.cycles, sim.batteries[1].cycles, 'remapped 0x401');
    assert.equal(session.info?.serialNumber, 'DEMO0000PACK0001');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: CAN bank of ten packs with shifted identifiers: no false alarms, no SOC drops', async () => {
  // Pack 6's counters arrive on 0x355, pack 7's on 0x356, pack 9's on 0x358, pack 10's on 0x359
  // and packs 6..8's 0x705..0x707 on 0x305..0x307 (spec 12). A cycle of 600 ms keeps the counter
  // frames (every fifth cycle) more than REPEAT_MS apart, as on the battery (5.3 s).
  const { session, sim } = await connect('deye-can', (d) => createDeyeCanSimulator(d, { tickMs: 0, intervalMs: 600, packs: 10, shifted: true, otherNode: true }), { kind: 'serial' });
  try {
    const started = Date.now();
    /** @type {any[]} */
    const snaps = [];
    while (Date.now() - started < 4000) snaps.push(await new Promise((resolve) => session.once('snapshot', resolve)));
    assert.ok(sim.state.cycles >= 6, `${sim.state.cycles} cycles: the counter frames came twice`);
    for (const s of snaps) {
      assert.ok(s.soc > 40 && s.soc < 90, `SOC ${s.soc}`);
      assert.ok(s.soh > 90, `SOH ${s.soh}`);
      assert.deepEqual(s.alarms, [], 'an over-current count is no cell undervoltage');
      assert.equal(s.extra.inverter, undefined, 'the counters of packs 6..8 are no inverter frames');
      assert.equal(s.extra.packCount.value, 10);
      assert.ok(s.voltage > 40 && s.voltage < 60);
    }
    const st = /** @type {any} */ (session.driver).state;
    assert.equal(st.layout.active, true);
    for (let n = 1; n <= 10; n++) {
      const p = st.packs.get(n);
      assert.ok(p.status && p.energy && p.counts1, `pack ${n}: remapped status, energy and counters`);
      // 0x750 + n - 1 lands on a bank identifier for packs 2, 6, 7, 9 and 10: dropped there.
      if ([1, 3, 4, 5, 8].includes(n)) assert.equal(p.counts2?.fields.chargeOvercurrentCount, 2, `pack ${n}`);
      else assert.equal(p.counts2, undefined, `pack ${n}`);
    }
    assert.equal(session.info?.softwareVersion, 'F002');
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('session: CAN listen only mode falls back to normal mode when the inverter leaves', async () => {
  const { session, sim, log } = await connect('deye-can', (d) => createDeyeCanSimulator(d, { tickMs: 0, intervalMs: 300, heartbeat: true }), { kind: 'serial' });
  try {
    assert.equal(sim.state.mode, 'listen');
    sim.setOtherNode(false);
    let resumed = false;
    for (let i = 0; i < 12 && !resumed; i++) {
      await sleep(1000);
      resumed = sim.state.mode === 'normal';
    }
    assert.ok(resumed, 'reopened with C, O');
    assert.ok(log.entries().some((e) => /the adapter now acknowledges \(normal mode\)/.test(e.text ?? '')));
    const at = Date.now();
    const s = /** @type {any} */ (await new Promise((resolve) => session.once('snapshot', resolve)));
    assert.ok(Number.isFinite(s.voltage));
    assert.ok(/** @type {any} */ (session.driver).state.lastBatteryAt >= at - 1000, 'frames arrive again');
    assert.deepEqual(sim.state.transmitted, []);
  } finally {
    await session.disconnect();
    sim.stop();
  }
});

test('CAN simulator: a lone battery delivers nothing in listen only mode, another node completes the frames', async () => {
  for (const otherNode of [false, true]) {
    const { host, device } = createLinkPair({ kind: 'serial' });
    await host.open();
    await device.open();
    const sim = createDeyeCanSimulator(device, { tickMs: 0, intervalMs: 50, otherNode });
    /** @type {number[]} */
    const ids = [];
    const dec = new SlcanDecoder({ onFrame: (f) => ids.push(f.id) });
    host.on('data', (/** @type {Uint8Array} */ c) => dec.push(c));
    await host.write(ascii('S6\rL\r'));
    await sleep(200);
    if (otherNode) assert.ok(ids.includes(0x351) && ids.includes(0x35e), 'the whole cycle');
    else assert.deepEqual(ids, [], 'no acknowledge: every attempt ends in an error, no frame arrives');
    sim.stop();
  }
});

test('demo entries connect like the app demo', async () => {
  for (const def of deyeDrivers) {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(deyeDrivers), log, pollIntervalMs: 1000, probeTimeoutMs: 1500 });
    const { host, device } = createLinkPair({ log, name: def.demo?.name, kind: 'demo', latencyMs: 2, deviceChunkSize: def.demo?.chunkSize ?? 0 });
    await device.open();
    const sim = /** @type {any} */ (def.demo).create(device);
    const first = new Promise((resolve) => session.once('snapshot', resolve));
    await session.connect({ kind: 'link', link: host, selection: def.id });
    try {
      /** @type {any} */
      const s = await first;
      assert.ok(Number.isFinite(s.voltage), def.id);
      assert.ok(Number.isFinite(s.soc), def.id);
      if (def.id !== 'deye-can') assert.equal(s.cells.length, 16, def.id);
    } finally {
      await session.disconnect();
      sim.stop();
      await device.close();
    }
  }
});

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/** The existing drivers with this family in the recommended places (spec 11.4). */
function combinedDrivers() {
  // Works before and after the family is registered in src/index.js.
  const others = drivers.filter((d) => d.family !== 'deye');
  const out = [...others];
  const up = out.findIndex((d) => d.id === 'jbd-up-rs485');
  out.splice(up + 1, 0, deyeRs485Definition);
  const atorch = out.findIndex((d) => d.family === 'atorch');
  out.splice(atorch < 0 ? out.length : atorch, 0, deyeBleDefinition);
  out.push(deyeCanDefinition);
  return out;
}

test('registry: deye-can only for its own id, never in automatic or family serial detection', () => {
  // DriverRegistry.serialCandidates() honours links.serial.autoDetect: false (spec 11.4).
  const registry = new DriverRegistry(combinedDrivers());
  const ids = (/** @type {string} */ selection) => registry.serialCandidates({ selection }).map((c) => `${c.definition.id}@${c.profile.baudRate}`);
  assert.ok(!ids('auto').some((s) => s.startsWith('deye-can')), 'never in automatic detection');
  assert.deepEqual(ids('family:deye'), ['deye-rs485@9600']);
  assert.deepEqual(ids('deye'), ['deye-rs485@9600'], 'a bare family id');
  assert.deepEqual(ids('deye-can'), ['deye-can@115200'], 'the explicit id');
  // The Deye family alone, as registered by the family list.
  const own = new DriverRegistry(deyeDrivers);
  assert.deepEqual(own.serialCandidates({ selection: 'auto' }).map((c) => c.definition.id), ['deye-rs485']);
  assert.deepEqual(own.serialCandidates({ selection: 'deye-can' }).map((c) => c.definition.id), ['deye-can']);
});

test('definitions: family, links, read only capabilities, demos', () => {
  assert.deepEqual(deyeDrivers.map((d) => d.id), ['deye-rs485', 'deye-ble', 'deye-can']);
  for (const d of deyeDrivers) {
    assert.equal(d.family, 'deye');
    assert.equal(d.vendor, 'Deye');
    assert.equal(d.deviceType, 'bms');
    assert.ok(d.demo?.create);
  }
  assert.equal(deyeRs485Definition.links.serial?.profiles[0].baudRate, 9600);
  assert.equal(deyeRs485Definition.links.ble, undefined);
  assert.equal(deyeCanDefinition.links.serial.profiles[0].baudRate, 115200);
  assert.equal(deyeCanDefinition.links.serial.autoDetect, false);
  const ble = /** @type {any} */ (deyeBleDefinition.links.ble);
  assert.equal(canonicalUuid(ble.profiles[0].service), canonicalUuid(0xfff1));
  assert.equal(ble.profiles[0].notify, 0xfff2);
  assert.equal(ble.profiles[0].write, 0xfff2);
  assert.ok(ble.profiles[0].chunkSize >= 32, 'one message per GATT write');
  assert.deepEqual(ble.namePrefixes, ['BAT']);
  assert.ok(ble.namePatterns[0].test('BAT00000000000001'));
  assert.ok(!ble.namePatterns[0].test('BATTERY-1'));
});

test('registry: this family together with the existing drivers', async () => {
  const list = combinedDrivers();
  const registry = new DriverRegistry(list);
  assert.equal(new Set(list.map((d) => d.id)).size, list.length, 'unique ids');
  const ids = list.map((d) => d.id);
  assert.equal(ids.indexOf('deye-rs485'), ids.indexOf('jbd-up-rs485') + 1);
  assert.ok(ids.indexOf('deye-rs485') < ids.indexOf('seplos-v3'));
  assert.ok(ids.indexOf('deye-ble') > ids.indexOf('seplos-v2'));
  if (ids.includes('atorch')) assert.ok(ids.indexOf('deye-ble') < ids.indexOf('atorch'));

  // Bluetooth: FFF1 is used by no other family; the BAT name ranks it first.
  const fff1 = registry.bleCandidates({ name: 'BAT2312345678901', services: [canonicalUuid(0xfff1)] });
  assert.deepEqual(fff1.map((c) => c.definition.id), ['deye-ble']);
  const renamed = registry.bleCandidates({ name: 'My battery', services: [canonicalUuid(0xfff1)] });
  assert.deepEqual(renamed.map((c) => c.definition.id), ['deye-ble']);
  assert.ok(!registry.bleCandidates({ name: 'BAT2312345678901', services: [canonicalUuid(0xfff0)] }).some((c) => c.definition.id === 'deye-ble'));
  const req = registry.bleRequest({ selection: 'auto' }).request;
  assert.ok(req.filters?.some((f) => f.namePrefix === 'BAT'));
  assert.ok(req.optionalServices.includes(canonicalUuid(0xfff1)));
  const family = registry.bleRequest({ selection: 'family:deye' });
  assert.equal(family.filterable, true);
  assert.deepEqual(family.request.filters, [{ namePrefix: 'BAT' }]);

  // Serial: deye-rs485 right after jbd-up-rs485, before the Seplos trials (the exclusion of
  // deye-can is tested above).
  const serial = registry.serialCandidates({ selection: 'auto' }).map((c) => `${c.definition.id}@${c.profile.baudRate}`);
  assert.equal(serial.indexOf('deye-rs485@9600'), serial.indexOf('jbd-up-rs485@9600') + 1);
  assert.deepEqual(registry.families().find((f) => f.id === 'deye')?.drivers.map((d) => d.id), ['deye-rs485', 'deye-ble', 'deye-can']);

  // Automatic detection over Bluetooth with every driver registered.
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs: 1500 });
    const name = 'BAT2312345678901';
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
        return [0xfff1, 0x180a].map((s) => ({ uuid: canonicalUuid(s), characteristics: [] }));
      },
      /** @param {{ chunkSize?: number }} profile */
      async openChannel(profile) {
        const { host, device } = createLinkPair({ log, name, deviceChunkSize: 20 });
        assert.ok((profile.chunkSize ?? 0) >= 32);
        await host.open();
        await device.open();
        sims.push(createDeyeBleSimulator(device, { tickMs: 0, name }));
        return host;
      },
    };
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'deye-ble');
    } finally {
      await session.disconnect();
      for (const s of sims) s.stop();
    }
  }

  // Automatic serial detection with every driver registered: every earlier probe is ignored by
  // the Deye pack, which is found before the Seplos trials.
  {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs: 600 });
    /** @type {number[]} */
    const bauds = [];
    /** @type {any[]} */
    const sims = [];
    const port = {
      /** @param {{ baudRate: number }} opts */
      async openLink(opts) {
        bauds.push(opts.baudRate);
        const { host, device } = createLinkPair({ log, kind: 'serial' });
        await host.open();
        await device.open();
        if (opts.baudRate === 9600) sims.push(createDeyeRs485Simulator(device, { tickMs: 0 }));
        return host;
      },
    };
    await session.connect({ kind: 'serial', handle: port, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'deye-rs485');
      assert.equal(bauds.at(-1), 9600);
      assert.ok(!log.entries().some((e) => /Probing Seplos/.test(e.text ?? '')), 'found before the Seplos trials');
      // The pack only ever saw its own reads: the foreign probes did not parse as AA 55 frames.
      for (const s of sims) assert.ok(s.state.received.every((/** @type {any} */ x) => x.address === 1 && x.command >= 1 && x.command <= 4));
    } finally {
      await session.disconnect();
      for (const s of sims) s.stop();
    }
  }
});

test('style: no em dash and no Deye knowledge in the generic packages', () => {
  const dir = new URL('../src/deye/', import.meta.url);
  for (const f of readdirSync(dir)) assert.equal(readFileSync(new URL(f, dir), 'utf8').includes(EM_DASH), false, f);
  for (const f of ['../src/common/crypto.js', './deye.test.js', '../../../docs/protocols/deye.md']) {
    assert.equal(readFileSync(new URL(f, import.meta.url), 'utf8').includes(EM_DASH), false, f);
  }
  for (const f of ['../../transport/src/slcan.js', '../../transport/src/index.js']) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /deye/i, f);
  }
  // Seplos stays untouched by this family.
  assert.ok(seplosDrivers.every((d) => d.family === 'seplos'));
});
