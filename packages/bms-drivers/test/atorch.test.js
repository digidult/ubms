import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, createLinkPair, fromHex, hex, concat } from '@ubms/transport';
import { BmsSession, DriverRegistry, fieldMap } from '@ubms/bms-core';
import * as P from '../src/atorch/protocol.js';
import { buildAtorchSchema, meterRawValue, reportShows } from '../src/atorch/settings.js';
import {
  atorchDrivers,
  atorchDefinition,
  createAtorchSimulator,
  formatDuration,
  isAtorchName,
  isLoadName,
  isPx100Name,
  maxLoadCurrent,
  modelFromName,
  NAME_PATTERN,
  reportSnapshot,
} from '../src/atorch/index.js';

const vectors = JSON.parse(readFileSync(new URL('./vectors/atorch.json', import.meta.url), 'utf8'));
/** @param {string} id */
const vector = (id) => {
  const v = vectors.find((/** @type {any} */ x) => x.id === id);
  assert.ok(v, `vector ${id} exists`);
  return v;
};
/** @param {string} id */
const bytesOf = (id) => fromHex(vector(id).hex);

/** Vector values are exact; allow binary noise only. @param {any} a @param {any} b */
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b);

/**
 * @param {Record<string, any>} actual
 * @param {Record<string, any>} expected
 * @param {string} id
 */
function assertFields(actual, expected, id) {
  for (const [k, v] of Object.entries(expected)) {
    if (k === 'notifications') continue;
    assert.ok(k in actual, `${id}: ${k} decoded`);
    assert.ok(same(actual[k], v), `${id}: ${k} = ${actual[k]}, expected ${v}`);
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

/** Frames out of a host assembler. @param {Partial<Parameters<typeof P.createHostAssembler>[0]>} [opts] */
function hostAssembler(opts = {}) {
  /** @type {Uint8Array[]} */
  const frames = [];
  /** @type {string[]} */
  const discards = [];
  const a = P.createHostAssembler({ onFrame: (f) => frames.push(f), onDiscard: (_b, reason) => discards.push(reason), ...opts });
  return { a, frames, discards };
}

/** Rebuild a report with a new runtime second and a checksum by rule. @param {Uint8Array} frame @param {number} second @param {'valid'|'from3'|'invalid'} rule */
function variantOf(frame, second, rule) {
  const r = P.parseReport(frame);
  const f = Uint8Array.from(frame);
  f[r.deviceType === P.DEVICE.USB ? 26 : 29] = second % 60;
  const std = P.atorchChecksum(f, 2, 35);
  f[35] = rule === 'valid' ? std : rule === 'from3' ? P.atorchChecksum(f, 3, 35) : std ^ 0x80;
  return f;
}

// ---------------------------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------------------------

/** Query that each PX100 answer vector belongs to (the answer itself carries no command). */
const PX100_REPLY_QUERY = /** @type {Record<string, number>} */ ({
  'px100-reply-load-off': P.PX100.Q_LOAD,
  'px100-reply-current-setting-1.50a': P.PX100.Q_CURRENT_SETTING,
});

test('vectors: every received frame decodes to its expected values', () => {
  const rx = vectors.filter((/** @type {any} */ v) => v.direction === 'rx');
  assert.ok(rx.length >= 30);
  for (const v of rx) {
    const f = fromHex(v.hex);
    if (P.isReportFrame(f)) {
      const r = P.parseReport(f);
      assertFields(r, v.expected, v.id);
      assert.equal(r.variant, v.variant, `${v.id}: variant`);
      // Every report of the research passes the plausibility checks (spec 11.2 step 4).
      assert.equal(P.reportProblem(f), null, `${v.id}: plausible`);
    } else if (P.isReplyFrame(f)) {
      assertFields(P.parseReply(f), v.expected, v.id);
    } else if (P.isPx100Ack(f)) {
      assert.deepEqual(v.expected, { frame: 'px100-ack' });
    } else if (P.isPx100Reply(f)) {
      assertFields(P.parsePx100Reply(f, PX100_REPLY_QUERY[v.id]), v.expected, v.id);
    } else {
      assert.fail(`${v.id}: unclassified frame`);
    }
    assert.ok(P.describe(f)?.name, `${v.id}: described for the log`);
  }
});

test('vectors: every transmitted frame equals the encoder output', () => {
  const tx = vectors.filter((/** @type {any} */ v) => v.direction === 'tx');
  assert.ok(tx.length >= 40);
  for (const v of tx) {
    const f = fromHex(v.hex);
    const e = v.expected;
    if (P.isCommandFrame(f)) {
      assert.equal(hex(P.encodeCommand(e.deviceType, e.command, e.value)), v.hex, `${v.id}: encodeCommand`);
      assertFields(P.parseCommand(f), e, v.id);
      assert.equal(P.parseCommand(f).checksumValid, true, `${v.id}: checksum`);
      if (e.command === P.OP.SET_BACKLIGHT) assert.equal(hex(P.backlightCommand(e.deviceType, e.value)), v.hex);
      if (e.command === P.OP.SET_PRICE) assert.equal(hex(P.priceCommand(e.deviceType, e.value / 100)), v.hex);
    } else if (P.isPx100Request(f)) {
      const enc = {
        [P.PX100.LOAD]: () => P.px100Load(e.loadOn),
        [P.PX100.SET_CURRENT]: () => P.px100SetCurrent(e.current),
        [P.PX100.SET_CUTOFF]: () => P.px100SetCutoff(e.cutoffVoltage),
        [P.PX100.SET_TIMER]: () => P.px100SetTimer(e.timer),
        [P.PX100.RESET]: () => P.px100Request(P.PX100.RESET),
      }[e.command] ?? (() => P.px100Query(e.command));
      assert.equal(hex(enc()), v.hex, `${v.id}: PX100 encoder`);
      assertFields(P.parsePx100Request(f), e, v.id);
    } else {
      assert.fail(`${v.id}: unclassified frame`);
    }
  }
  // Price 1.25 is raw 125 and the [NL] checksum example.
  assert.equal(hex(P.priceCommand(1, 1.25)), 'FF551101220000007DF5');
  assert.equal(hex(P.encodeCommand(3, P.OP.SETUP)), 'FF551103310000000001');
  assert.throws(() => P.backlightCommand(2, 61), RangeError);
  assert.throws(() => P.priceCommand(2, 0), RangeError);
  assert.throws(() => P.priceCommand(2, 10000), RangeError);
});

test('vectors: split notifications reassemble into one frame', () => {
  const split = vectors.filter((/** @type {any} */ v) => v.expected?.notifications);
  assert.ok(split.length >= 5);
  for (const v of split) {
    const { a, frames } = hostAssembler();
    const pieces = v.expected.notifications.map((/** @type {string} */ h) => fromHex(h));
    assert.equal(hex(concat(...pieces)), v.hex, `${v.id}: pieces`);
    for (const p of pieces) a.push(p);
    assert.deepEqual(
      frames.map((f) => hex(f)),
      [v.hex],
      `${v.id}: one frame`,
    );
  }
});

test('reports: the encoder reproduces the report vectors', () => {
  for (const v of vectors.filter((/** @type {any} */ x) => x.direction === 'rx' && x.hex.length === 72)) {
    const f = fromHex(v.hex);
    const r = P.parseReport(f);
    // The J7 family fills bytes 28..34 of USB reports with unknown constants (spec 6.3).
    if (r.deviceType === P.DEVICE.USB && f.subarray(28, 35).some((b) => b !== 0)) continue;
    const checksum = r.checksumValid ? 'valid' : r.checksumFrom3Valid ? 'from3' : f[35];
    assert.equal(hex(P.encodeReport(r, { checksum })), v.hex, `${v.id}: round trip`);
  }
});

// ---------------------------------------------------------------------------------------------
// Assembler, checksum policy, detection
// ---------------------------------------------------------------------------------------------

test('assembler: mid frame start, reply between reports, injected text, random chunking', () => {
  const r1 = bytesOf('dc-dl24-report-syssi-1');
  const r2 = bytesOf('dc-dl24-report-syssi-2');
  const ok = bytesOf('reply-ok');
  const text = new TextEncoder().encode('AT+BDUD18_SPP\r\n');
  const stream = concat(r1.subarray(13), r1, ok, text, r2, ok, r1);
  // Every chunking gives the same frames.
  for (const size of [1, 3, 7, 16, 20, 36, 244]) {
    const { a, frames } = hostAssembler();
    for (let i = 0; i < stream.length; i += size) a.push(stream.subarray(i, i + size));
    assert.deepEqual(
      frames.map((f) => hex(f)),
      [r1, ok, r2, ok, r1].map((f) => hex(f)),
      `chunk size ${size}`,
    );
  }
});

test('assembler: a false FF 55 start is skipped and the search restarts at the next byte', () => {
  const real = bytesOf('dc-dl24-report-syssi-1');
  // A truncated report start: the 36 bytes from here fail the checksum and the zero checks.
  const garbage = Uint8Array.from([0xff, 0x55, 0x01, 0x02, 0xff, 0xff]);
  const { a, frames, discards } = hostAssembler();
  a.push(concat(garbage, real));
  assert.deepEqual(
    frames.map((f) => hex(f)),
    [hex(real)],
  );
  assert.ok(discards.length > 0);
  // Unknown message types and other device types are not frame starts.
  const other = hostAssembler();
  other.a.push(concat(Uint8Array.from([0xff, 0x55, 0x07, 0x00]), real));
  assert.equal(other.frames.length, 1);
  const type4 = Uint8Array.from(real);
  type4[3] = 4;
  type4[35] = P.atorchChecksum(type4);
  const rejected = hostAssembler();
  rejected.a.push(type4);
  assert.equal(rejected.frames.length, 0);
});

test('assembler: PX100 answers only while a PX100 request of that kind is in flight', () => {
  const ack = Uint8Array.of(P.PX100_ACK);
  const answer = bytesOf('px100-reply-current-setting-1.50a');
  /** @type {'set'|'query'|null} */
  let pending = null;
  const { a, frames } = hostAssembler({ px100: () => pending });
  a.push(ack);
  a.push(answer);
  assert.equal(frames.length, 0, 'ignored without a pending request');
  pending = 'set';
  a.push(answer);
  assert.equal(frames.length, 0, 'a query answer needs a pending query');
  a.push(ack);
  assert.deepEqual(frames.map((f) => hex(f)), ['6F']);
  pending = 'query';
  a.push(answer);
  assert.equal(hex(frames[1]), hex(answer));
  // A 6F byte inside a report is part of the report.
  pending = 'set';
  const r = P.encodeReport({ deviceType: 2, voltage: 11.1, current: 0.111, energy: 0, capacity: 0, price: 1, temperature: 0x6f, runtime: 0, backlight: 60 });
  assert.ok([...r].includes(0x6f));
  a.push(r.subarray(0, 20));
  a.push(r.subarray(20));
  assert.equal(hex(frames[2]), hex(r));
  assert.equal(frames.length, 3);
});

test('checksum policy: learns the standard rule after five reports, then rejects bad checksums', () => {
  const base = bytesOf('dc-dl24-report-syssi-1');
  const policy = new P.ChecksumPolicy();
  const { a, frames } = hostAssembler({ policy });
  // Before a rule is learned, a plausible report without a valid checksum passes.
  a.push(variantOf(base, 1, 'invalid'));
  assert.equal(frames.length, 1);
  for (let s = 2; s <= 6; s++) a.push(variantOf(base, s, 'valid'));
  assert.equal(policy.rule, 'standard');
  assert.equal(frames.length, 6);
  a.push(variantOf(base, 7, 'invalid'));
  assert.equal(frames.length, 6, 'rejected once the rule is learned');
  a.push(variantOf(base, 8, 'valid'));
  assert.equal(frames.length, 7, 'the stream resyncs after the rejected report');
});

test('checksum policy: learns the byte 3 variant of a J7-C, never a rule from random bytes', () => {
  const j7 = bytesOf('usb-j7c-dallanwagz-checksum-from-byte3');
  const policy = new P.ChecksumPolicy();
  for (let s = 0; s < 5; s++) policy.observe(variantOf(j7, s, 'from3'));
  assert.equal(policy.rule, 'from3');
  assert.equal(policy.accepts(variantOf(j7, 9, 'from3')), true);
  assert.equal(policy.accepts(variantOf(j7, 9, 'valid')), false);
  // DL24M firmware 2.0: a different last byte every second (spec 3.2).
  const dl24m = new P.ChecksumPolicy();
  const a = bytesOf('dc-dl24m-fw2.0-report-random-checksum-a');
  const b = bytesOf('dc-dl24m-fw2.0-report-random-checksum-b');
  for (let i = 0; i < 20; i++) {
    const f = i % 2 ? a : b;
    assert.equal(dl24m.accepts(f), true);
    dl24m.observe(f);
  }
  assert.equal(dl24m.rule, null);
  // A broken checksum and a failed plausibility check together are rejected.
  const bad = Uint8Array.from(a);
  bad[28] = 61;
  assert.equal(dl24m.accepts(bad), false);
});

test('detector: high confidence on a valid checksum, lower on two plausible reports 0.5 to 2 s apart', () => {
  const valid = bytesOf('ac-at3010-report-1');
  const d1 = new P.ReportDetector();
  assert.deepEqual(d1.push(valid, 0), { deviceType: 1, variant: 'AC_METER', confidence: 0.9, checksum: true });

  const noSum = bytesOf('dc-dt24tw-300a-report-checksum-constant');
  const d2 = new P.ReportDetector();
  assert.equal(d2.push(noSum, 1000), null);
  assert.equal(d2.push(noSum, 1300), null, 'too close');
  const result = d2.push(noSum, 2100);
  assert.equal(result?.variant, 'DC_METER');
  assert.equal(result?.checksum, false);
  assert.ok(/** @type {number} */ (result?.confidence) < 0.9);
  assert.equal(new P.ReportDetector({ nameMatch: true }).push(noSum, 0), null);

  const d3 = new P.ReportDetector();
  d3.push(noSum, 0);
  assert.equal(d3.push(noSum, 2600), null, 'too far apart');
  const usbNoSum = bytesOf('usb-j7c-syssi-checksum-invalid');
  const d4 = new P.ReportDetector();
  d4.push(noSum, 0);
  assert.equal(d4.push(usbNoSum, 1000), null, 'different device types do not pair');
  // Implausible reports never count.
  const implausible = Uint8Array.from(noSum);
  implausible[30] = 99;
  const d5 = new P.ReportDetector();
  d5.push(implausible, 0);
  assert.equal(d5.push(implausible, 1000), null);
  // Frames of other protocols on FFE1 are ignored.
  const d6 = new P.ReportDetector();
  assert.equal(d6.push(fromHex('55AAEB900200'), 0), null);
});

// ---------------------------------------------------------------------------------------------
// Names, definition, settings schema, snapshot
// ---------------------------------------------------------------------------------------------

test('names: model, load family and ranking pattern', () => {
  assert.equal(modelFromName('DL24M_BLE'), 'DL24M');
  assert.equal(modelFromName('DL24-BLE'), 'DL24');
  assert.equal(modelFromName('DL24-BLE (demo)'), 'DL24');
  assert.equal(modelFromName('AT3010-BLE'), 'AT3010');
  assert.equal(modelFromName('UC96_BLE'), 'J7-C');
  assert.equal(modelFromName('UD18'), 'UD18');
  assert.equal(modelFromName('JDY-19'), undefined);
  assert.equal(modelFromName('Memory link'), undefined);
  for (const n of ['DL24_BLE', 'DL24-BLE', 'DL24M_BLE', 'DT24PW_BLE', 'AT3010-BLE', 'UD18_BLE', 'UD18-BLE', 'AT24-BLE', 'UC96_BLE', 'S1BP_BLE', 'S1WP_BLE', 'DL24P_BLE', 'UD24-BLE']) {
    assert.ok(NAME_PATTERN.test(n), `${n} matches`);
    assert.ok(isAtorchName(n));
  }
  for (const n of ['JK-B2A24S15P', 'JK_PB2A16S20P', 'ANT-BLE16ZMUB', 'BMS-NEEY', 'GW-24S4EB', 'JDY-19', 'DL24_SPP']) assert.ok(!NAME_PATTERN.test(n), `${n} does not match`);
  assert.ok(isLoadName('DL24M_BLE') && isLoadName('DL24-BLE') && !isLoadName('DT24PW_BLE'));
  assert.ok(isPx100Name('DL24_BLE') && isPx100Name('DL24P_BLE') && !isPx100Name('DL24M_BLE'));
  assert.equal(maxLoadCurrent('DL24P_BLE'), 25);
  assert.equal(maxLoadCurrent('DL24_BLE'), 20);
  assert.equal(formatDuration(9206), '2:33:26');
  assert.equal(formatDuration(713468), '198:11:08');
});

test('definition: meter family on FFE0 / FFE1, ranked by name ahead of other families', () => {
  assert.deepEqual(atorchDrivers, [atorchDefinition]);
  const d = atorchDefinition;
  assert.deepEqual([d.id, d.family, d.vendor, d.deviceType, d.experimental], ['atorch', 'atorch', 'Atorch', 'meter', true]);
  assert.equal(d.protocol, 'Atorch FF 55 (Bluetooth)');
  const ble = /** @type {any} */ (d.links.ble);
  assert.equal(ble.profiles.length, 1);
  const p = ble.profiles[0];
  assert.deepEqual([p.service, p.notify, p.write, p.writeMode], [0xffe0, 0xffe1, 0xffe1, 'auto']);
  // FFE2 is never required (missing on the J7-H): no number and no UUID string may name it.
  /** @param {unknown} v @returns {boolean} */
  const namesFfe2 = (v) => v === 0xffe2 || (typeof v === 'string' && v.toLowerCase().includes('ffe2')) || (!!v && typeof v === 'object' && Object.values(v).some(namesFfe2));
  assert.ok(namesFfe2({ profiles: [{ write: 0xffe2 }] }) && namesFfe2(['0000ffe2-0000-1000-8000-00805f9b34fb']), 'the check sees numbers and UUID strings');
  assert.ok(!namesFfe2(ble));
  assert.deepEqual(ble.namePrefixes, ['DL24', 'DT24', 'DT3010', 'AT24', 'AT3010', 'UD18', 'UD24', 'UC96', 'S1BP', 'S1WP', 'J7']);
  assert.equal(d.links.serial, undefined);
  assert.equal(d.demo?.name, 'DL24-BLE (demo)');
  const fake = { id: 'other', family: 'other', vendor: 'Other', protocol: 'x', deviceType: /** @type {const} */ ('bms'), links: { ble: { profiles: [{ id: 'o', service: 0xffe0, notify: 0xffe1, write: 0xffe1 }], namePrefixes: ['JK-'] } }, create: () => /** @type {any} */ (null) };
  const registry = new DriverRegistry([fake, atorchDefinition]);
  assert.equal(registry.bleCandidates({ name: 'DL24M_BLE' })[0].definition.id, 'atorch');
  assert.equal(registry.bleCandidates({ name: 'JK-B2A24S15P' })[0].definition.id, 'other');
  const request = registry.bleRequest({ selection: 'atorch' }).request;
  assert.ok(request.optionalServices.includes('0000ffe0-0000-1000-8000-00805f9b34fb'));
  assert.ok(!namesFfe2(request.optionalServices));
});

test('settings schema: writable only where the spec confirms it', () => {
  /** @param {Parameters<typeof buildAtorchSchema>[0]} o */
  const ids = (o) => [...fieldMap(buildAtorchSchema(o)).values()].map((f) => `${f.id}${f.readOnly ? ' ro' : ''}${f.writeOnly ? ' wo' : ''}${f.danger ? ' !' : ''}`);
  // AC meter: no reset capacity (it toggles the S1-B relay).
  const ac = ids({ deviceType: 1 });
  assert.ok(ac.includes('atorch.backlight') && ac.includes('atorch.price'));
  assert.ok(!ac.some((x) => x.startsWith('atorch.reset_capacity')));
  assert.ok(!ac.some((x) => x.startsWith('atorch.load')));
  // USB meter: everything read only, no price.
  const usb = ids({ deviceType: 3 });
  assert.ok(usb.includes('atorch.backlight ro'));
  assert.ok(!usb.some((x) => x.startsWith('atorch.price')));
  assert.ok(usb.includes('atorch.reset_capacity !'));
  // DL24 before a PX100 answer: derived, read only load state; DL24M likewise.
  for (const px100Capable of [true, false]) {
    const before = ids({ deviceType: 2, load: true, px100Capable, px100: 'unanswered' });
    assert.ok(before.includes('atorch.load ro'));
    assert.ok(!before.some((x) => x.startsWith('atorch.load_current')));
    // The menu keys reach the load settings, so every key press is confirmed as dangerous.
    assert.ok(['atorch.key_setup !', 'atorch.key_enter !', 'atorch.key_plus !', 'atorch.key_minus !'].every((x) => before.includes(x)));
  }
  // A meter without a load: plain key presses.
  for (const deviceType of [1, 2, 3]) {
    const keys = ids({ deviceType }).filter((x) => x.startsWith('atorch.key_'));
    assert.deepEqual(keys, ['atorch.key_setup', 'atorch.key_enter', 'atorch.key_plus', 'atorch.key_minus'], `type ${deviceType}`);
  }
  // After a PX100 answer: experimental, danger confirmed fields with limits.
  const schema = buildAtorchSchema({ deviceType: 2, load: true, px100Capable: true, px100: 'available', maxLoadCurrent: 25, unreadable: new Set(['atorch.timer']) });
  const f = fieldMap(schema);
  assert.deepEqual(
    ['atorch.load', 'atorch.load_current', 'atorch.cutoff_voltage', 'atorch.timer'].map((id) => [f.get(id)?.readOnly, f.get(id)?.danger]),
    [
      [false, true],
      [false, true],
      [false, true],
      [false, true],
    ],
  );
  assert.equal(f.get('atorch.load_current')?.max, 25);
  assert.equal(f.get('atorch.timer')?.step, 60);
  assert.equal(f.get('atorch.timer')?.writeOnly, true);
  assert.equal(f.get('atorch.timer')?.validate?.({ 'atorch.timer': 90 }), 'The timer is set in whole minutes');
  assert.equal(f.get('atorch.key_enter')?.danger, true);
  assert.equal(f.get('atorch.key_plus')?.meta.opcode, 0x33);
  assert.equal(f.get('atorch.key_minus')?.meta.opcode, 0x34);
  assert.ok([...f.values()].filter((x) => x.group === 'atorch_keys').every((x) => x.advanced && x.type === 'action'));
  assert.deepEqual(
    schema.groups.map((g) => g.id),
    ['atorch_load', 'atorch_meter', 'atorch_counters', 'atorch_keys'],
  );
  // A failed PX100 write locks every load field.
  const failed = fieldMap(buildAtorchSchema({ deviceType: 2, load: true, px100Capable: true, px100: 'failed' }));
  assert.ok(['atorch.load', 'atorch.load_current', 'atorch.cutoff_voltage', 'atorch.timer'].every((id) => failed.get(id)?.readOnly));
  // A failed meter write locks that field.
  assert.equal(fieldMap(buildAtorchSchema({ deviceType: 2, readOnly: new Set(['atorch.price']) })).get('atorch.price')?.readOnly, true);
  // Raw values.
  assert.equal(meterRawValue('atorch.price', 1.25), 125);
  assert.equal(meterRawValue('atorch.backlight', 30), 30);
  assert.throws(() => meterRawValue('atorch.backlight', 61), RangeError);
  assert.ok(reportShows('atorch.price', P.parseReport(bytesOf('ac-at3010-report-1')), 430));
});

test('snapshot: magnitude current, power per device class, one internal temperature', () => {
  const dc = reportSnapshot(P.parseReport(bytesOf('dc-dl24-report-syssi-1')), { load: true, loadRunning: true, px100: { current: 20, cutoffVoltage: 2.5, timer: 0 } });
  assert.deepEqual([dc.voltage, dc.current, dc.power], [3.2, 20, 64]);
  assert.deepEqual(dc.temperatures, [{ id: 'internal', label: 'MOSFET temperature', value: 37, kind: 'mos' }]);
  assert.equal(dc.extra?.energy.value, 170);
  assert.equal(dc.extra?.capacity.value, 51.14);
  assert.equal(dc.extra?.duration.value, '2:33:26');
  assert.equal(dc.extra?.loadRunning.value, true);
  assert.equal(dc.extra?.loadCurrentSetting.value, 20);
  assert.equal(dc.extra?.backlight.value, 'Always on');
  assert.equal(dc.extra?.checksumValid.value, true);
  const ac = reportSnapshot(P.parseReport(bytesOf('ac-at3010-report-1')));
  assert.equal(ac.power, 551);
  assert.equal(ac.temperatures?.[0].kind, 'board');
  assert.deepEqual([ac.extra?.frequency.value, ac.extra?.powerFactor.value, ac.extra?.price.value], [49.9, 0.947, 4.3]);
  assert.equal(ac.extra?.capacity, undefined);
  assert.equal(ac.extra?.loadRunning, undefined);
  const usb = reportSnapshot(P.parseReport(bytesOf('usb-qc2-9v-bukys')), { showTemperature: false });
  assert.equal(usb.temperatures, undefined);
  assert.deepEqual([usb.extra?.dataMinus.value, usb.extra?.dataPlus.value], [0.75, 3.27]);
  assert.equal(usb.extra?.backlight.value, 30);
  assert.equal(usb.extra?.energy.decimals, 2);
});

// ---------------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------------

test('simulator: reports, replies and PX100 answers round trip', async () => {
  const { host, device } = createLinkPair({ deviceChunkSize: 20 });
  await host.open();
  await device.open();
  const sim = createAtorchSimulator(device, { load: true, intervalMs: 0, loadCurrent: 2, cutoffVoltage: 11 });
  /** @type {Uint8Array[]} */
  const frames = [];
  /** @type {'set'|'query'|null} */
  let pending = null;
  const a = P.createHostAssembler({ onFrame: (f) => frames.push(f), px100: () => pending });
  host.on('data', (/** @type {Uint8Array} */ c) => a.push(c));
  /** Write (or push a report) and return the first frame that arrives after it. @param {Uint8Array | null} bytes */
  const exchange = async (bytes) => {
    const n = frames.length;
    if (bytes) await host.write(bytes);
    else sim.push();
    await until(() => frames.length > n);
    return frames[n];
  };
  try {
    sim.tick(10);
    const r = P.parseReport(await exchange(null));
    assert.equal(r.variant, 'DC_METER');
    assert.equal(r.checksumValid, true);
    assert.equal(r.current, 2);
    assert.ok(r.voltage > 12 && r.voltage < 14);
    assert.equal(P.parseReply(await exchange(P.backlightCommand(2, 20))).status, P.STATUS.OK);
    assert.equal(sim.state.backlight, 20);
    assert.equal(P.parseReply(await exchange(P.encodeCommand(1, P.OP.RESET_ENERGY))).status, P.STATUS.FAILED, 'wrong device type');
    assert.equal(P.parseReply(await exchange(P.encodeCommand(2, 0x99))).status, P.STATUS.UNSUPPORTED);
    await exchange(P.encodeCommand(2, P.OP.RESET_ALL));
    assert.deepEqual([Math.round(sim.state.energy), sim.state.capacity, sim.state.runtime], [0, 0, 0]);
    pending = 'set';
    assert.equal(hex(await exchange(P.px100Load(false))), '6F');
    assert.equal(sim.state.load.on, false);
    await exchange(P.px100SetTimer(3630));
    assert.equal(sim.state.load.timer, 3600, 'whole minutes');
    pending = 'query';
    assert.equal(P.parsePx100Reply(await exchange(P.px100Query(P.PX100.Q_CUTOFF_SETTING)), P.PX100.Q_CUTOFF_SETTING).cutoffVoltage, 11);
    assert.equal(P.parsePx100Reply(await exchange(P.px100Query(P.PX100.Q_TIMER_SETTING)), P.PX100.Q_TIMER_SETTING).timer, 3600);
    assert.equal(P.parsePx100Reply(await exchange(P.px100Query(P.PX100.Q_LOAD)), P.PX100.Q_LOAD).loadOn, false);
    // The load stops at the cutoff voltage.
    sim.state.load.on = true;
    sim.state.load.cutoff = 20;
    sim.tick(1);
    assert.equal(sim.state.load.on, false);
    // Other device classes and checksum modes.
    for (const [type, deviceType] of /** @type {const} */ ([
      ['AC_METER', 1],
      ['USB_METER', 3],
      ['DC_METER', 2],
    ])) {
      const s = createAtorchSimulator(device, { type, intervalMs: 0, checksum: 'invalid' });
      s.tick(5);
      const f = s.report();
      const p = P.parseReport(f);
      assert.deepEqual([p.deviceType, p.checksumValid, P.isReportPlausible(f)], [deviceType, false, true]);
      assert.ok(p.voltage > 0 && p.current > 0, `${type} measures`);
      s.stop();
    }
  } finally {
    sim.stop();
    await host.close();
    await device.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} name advertised name of the link
 * @param {Parameters<typeof createAtorchSimulator>[1]} simOpts
 */
async function startSession(name, simOpts) {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(atorchDrivers), log, probeTimeoutMs: 1000 });
  const { host, device } = createLinkPair({ log, name, deviceChunkSize: 20 });
  await device.open();
  const sim = createAtorchSimulator(device, { intervalMs: 100, ...simOpts });
  const close = async () => {
    await session.disconnect();
    sim.stop();
    await device.close();
  };
  return { log, session, host, device, sim, close };
}

test('session: DL24 load end to end (passive detection, snapshots, settings, PX100, reset)', async () => {
  const s = await startSession('DL24-BLE', { load: true, loadCurrent: 1.5, cutoffVoltage: 10.5 });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    assert.equal(session.state, 'connected');
    assert.equal(session.variant, 'DC_METER');
    assert.equal(sim.received.length, 0, 'detection never writes');

    const snap = await until(() => session.snapshot);
    assert.equal(snap.current, 1.5);
    assert.ok(/** @type {number} */ (snap.power) > 15);
    assert.equal(snap.state, undefined, 'no charging state from an unsigned current');
    assert.equal(snap.timeToFull, undefined);
    assert.deepEqual(snap.temperatures?.map((t) => [t.id, t.kind]), [['internal', 'mos']]);
    assert.equal(snap.extra?.loadRunning.value, true);
    assert.equal(snap.extra?.checksumValid.value, true);
    assert.equal(snap.cells, undefined);

    const info = await until(() => session.info?.model && session.info);
    assert.deepEqual([info.vendor, info.model, info.protocol], ['Atorch', 'DL24', 'Atorch FF 55 (Bluetooth)']);
    assert.equal(info.extra?.deviceClass.value, 'DC meter or electronic load');
    assert.equal(info.softwareVersion, undefined);

    const settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.deepEqual(settings.values, {
      'atorch.backlight': 60,
      'atorch.price': 1,
      'atorch.load': true,
      'atorch.load_current': 1.5,
      'atorch.cutoff_voltage': 10.5,
      'atorch.timer': 0,
    });
    const fields = fieldMap(settings.schema);
    assert.equal(fields.get('atorch.load_current')?.readOnly, false, 'PX100 answered on this connection');

    let r = await session.writeSettings([{ id: 'atorch.backlight', value: 30 }]);
    assert.deepEqual(r, [{ id: 'atorch.backlight', ok: true, actual: 30, verified: true }]);
    assert.equal(sim.state.backlight, 30);

    r = await session.writeSettings([{ id: 'atorch.load_current', value: 2.25 }]);
    assert.deepEqual(r, [{ id: 'atorch.load_current', ok: true, actual: 2.25, verified: true }]);
    assert.equal(sim.state.load.current, 2.25);

    r = await session.writeSettings([{ id: 'atorch.load', value: false }]);
    assert.equal(r[0].verified, true);
    assert.equal(sim.state.load.on, false);

    r = await session.writeSettings([{ id: 'atorch.timer', value: 90 }]);
    assert.equal(r[0].ok, false, 'whole minutes only');

    await session.runAction('atorch.reset_energy');
    assert.equal(Math.round(sim.state.energy), 0);
    await assert.rejects(session.runAction('atorch.backlight'), /Unknown action/);

    // Every command carried the device type of the reports, one at a time, 300 ms apart.
    const commands = sim.received.filter((x) => x.messageType === P.MSG.COMMAND);
    assert.deepEqual(
      commands.map((c) => [c.deviceType, c.name]),
      [
        [2, 'setBacklight'],
        [2, 'resetEnergy'],
      ],
    );
    const gaps = sim.received.slice(1).map((x, i) => x.at - sim.received[i].at);
    assert.ok(Math.min(...gaps) >= 290, `spacing ${Math.min(...gaps)} ms`);
    assert.ok(!sim.received.some((x) => x.command === P.OP.PLUS || x.command === P.OP.MINUS), 'never 0x11 / 0x12');
  } finally {
    await s.close();
  }
});

test('session: USB meter is read only and hides the missing temperature', async () => {
  const s = await startSession('UD18_BLE', { type: 'USB_METER' });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    assert.equal(session.variant, 'USB_METER');
    const snap = await until(() => session.snapshot);
    assert.equal(snap.temperatures, undefined, 'a UD18 reports 0 degC without a sensor');
    assert.ok(/** @type {number} */ (snap.extra?.dataPlus.value) > 3);
    const settings = await session.loadSettings();
    const f = fieldMap(settings.schema);
    assert.equal(f.get('atorch.backlight')?.readOnly, true);
    assert.equal(f.get('atorch.price'), undefined);
    const r = await session.writeSettings([{ id: 'atorch.backlight', value: 10 }]);
    assert.equal(r[0].ok, false);
    assert.equal(sim.received.length, 0);
    await session.runAction('atorch.reset_capacity');
    assert.equal(sim.received[0].deviceType, 3);
    assert.equal(sim.state.capacity, 0);
  } finally {
    await s.close();
  }
});

test('session: AC meter, a reply 03 makes the setting read only, no capacity reset', async () => {
  const s = await startSession('AT3010-BLE', { type: 'AC_METER', unsupported: [P.OP.SET_BACKLIGHT] });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    assert.equal(session.variant, 'AC_METER');
    const snap = await until(() => session.snapshot);
    assert.ok(/** @type {number} */ (snap.power) > 0);
    assert.equal(snap.temperatures?.[0].kind, 'board');
    await session.loadSettings();
    const r = await session.writeSettings([{ id: 'atorch.backlight', value: 20 }]);
    assert.equal(r[0].ok, false);
    assert.match(String(r[0].error), /does not support/);
    assert.equal(fieldMap((await session.loadSettings()).schema).get('atorch.backlight')?.readOnly, true);
    await assert.rejects(session.runAction('atorch.reset_capacity'), /Unknown action/);
    const ok = await session.writeSettings([{ id: 'atorch.price', value: 0.25 }]);
    assert.equal(ok[0].verified, true);
    assert.equal(sim.state.price, 0.25);
    assert.ok(sim.received.every((x) => x.deviceType === 1 && x.command !== P.OP.RESET_CAPACITY));
  } finally {
    await s.close();
  }
});

test('session: a write the reports never show makes the setting read only', async () => {
  const s = await startSession('DT24PW_BLE', { applySettings: false });
  const { session } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    await session.loadSettings();
    const fields = fieldMap(session.settings.schema);
    assert.equal(fields.get('atorch.load'), undefined, 'a DC meter is not a load');
    const r = await session.writeSettings([{ id: 'atorch.price', value: 2.5 }]);
    assert.equal(r[0].ok, false);
    assert.match(String(r[0].error), /do not show the new value/);
    assert.equal(fieldMap((await session.loadSettings()).schema).get('atorch.price')?.readOnly, true);
  } finally {
    await s.close();
  }
});

test('session: PX100 without 6F leaves the load settings read only', async () => {
  const s = await startSession('DL24_BLE', { load: true, px100Ack: false });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    await session.loadSettings();
    assert.equal(fieldMap(session.settings.schema).get('atorch.cutoff_voltage')?.readOnly, false);
    const r = await session.writeSettings([{ id: 'atorch.cutoff_voltage', value: 11 }]);
    assert.equal(r[0].ok, false);
    assert.match(String(r[0].error), /did not acknowledge/);
    assert.equal(sim.state.load.cutoff, 11, 'the frame went out once');
    const f = fieldMap((await session.loadSettings()).schema);
    assert.ok(['atorch.load', 'atorch.load_current', 'atorch.cutoff_voltage', 'atorch.timer'].every((id) => f.get(id)?.readOnly));
    assert.equal(sim.received.filter((x) => x.frame === 'px100' && x.command === P.PX100.SET_CUTOFF).length, 1, 'no retry');
  } finally {
    await s.close();
  }
});

test('session: DL24M without checksum, lower confidence detection, derived load state', async () => {
  const s = await startSession('DL24M_BLE', { load: true, checksum: 'invalid', px100: false });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    assert.equal(session.variant, 'DC_METER');
    const snap = await until(() => session.snapshot);
    assert.equal(snap.extra?.checksumValid.value, false);
    assert.equal(snap.extra?.loadRunning.value, true);
    const settings = await session.loadSettings();
    const f = fieldMap(settings.schema);
    assert.equal(f.get('atorch.load')?.readOnly, true);
    assert.equal(f.get('atorch.load_current'), undefined);
    assert.equal(settings.values?.['atorch.load'], true);
    assert.equal(sim.received.length, 0, 'no PX100 query to a DL24M');
    assert.equal(session.info?.model, 'DL24M');
  } finally {
    await s.close();
  }
});

test('session: a device without FF 55 reports is not detected and nothing is written', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(atorchDrivers), log, probeTimeoutMs: 500 });
  const { host, device } = createLinkPair({ log, name: 'JK-B2A24S15P' });
  await device.open();
  /** @type {Uint8Array[]} */
  const written = [];
  device.on('data', (/** @type {Uint8Array} */ c) => written.push(c));
  const started = Date.now();
  try {
    await assert.rejects(session.connect({ kind: 'link', link: host, selection: 'atorch' }), /no valid answer/);
    assert.ok(Date.now() - started >= P.LISTEN_MS - 50, 'listens for the whole window');
    assert.equal(written.length, 0);
  } finally {
    await session.disconnect();
    await device.close();
  }
});

test('session: JK and ANT frames streaming on FFE1 are not taken for Atorch reports', async () => {
  // A JK02 style frame (55 AA EB 90, 300 bytes) and an ANT 2021 style frame (7E A1 ... AA 55),
  // each with an FF 55 01 start inside that does not continue as a plausible report.
  const jk = new Uint8Array(300);
  for (let i = 0; i < jk.length; i++) jk[i] = (i * 7) & 0xff;
  jk.set([0x55, 0xaa, 0xeb, 0x90, 0x02, 0x05]);
  jk.set([0xff, 0x55, 0x01, 0x02], 120);
  const ant = new Uint8Array(150);
  for (let i = 0; i < ant.length; i++) ant[i] = (i * 13) & 0xff;
  ant.set([0x7e, 0xa1, 0x11, 0x00, 0x00, 0x8c]);
  ant.set([0xff, 0x55, 0x01, 0x03], 40);
  ant.set([0xaa, 0x55], 148);
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(atorchDrivers), log, probeTimeoutMs: 500 });
  const { host, device } = createLinkPair({ log, name: 'JK-B2A24S15P', deviceChunkSize: 20 });
  await device.open();
  /** @type {Uint8Array[]} */
  const written = [];
  device.on('data', (/** @type {Uint8Array} */ c) => written.push(c));
  const stream = setInterval(() => {
    void device.write(jk);
    void device.write(ant);
  }, 200);
  const started = Date.now();
  try {
    await assert.rejects(session.connect({ kind: 'link', link: host, selection: 'atorch' }), /no valid answer/);
    assert.ok(Date.now() - started >= P.LISTEN_MS - 50, 'listens for the whole window');
    assert.equal(written.length, 0);
  } finally {
    clearInterval(stream);
    await session.disconnect();
    await device.close();
  }
});

test('session: a load that stops answering PX100 gets its state from the reports again', async () => {
  const s = await startSession('DL24_BLE', { load: true, loadOn: false, loadCurrent: 1.5 });
  const { session, sim } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    let settings = await session.loadSettings();
    assert.equal(settings.values?.['atorch.load'], false, 'PX100 answered 0x10 with off');
    const driver = /** @type {any} */ (session.driver);
    // The load starts from the front panel, and PX100 queries stay unanswered from now on.
    sim.setPx100(false);
    sim.state.load.on = true;
    await until(() => session.snapshot?.current === 1.5);
    driver.px100.loadAt -= 60000;
    settings = await session.loadSettings();
    assert.equal(settings.error, null);
    assert.ok(Date.now() - driver.px100.loadAt >= 60000, 'the 0x10 query got no answer');
    assert.equal(settings.values?.['atorch.load'], true, 'an old PX100 answer does not override the reports');
    assert.equal(session.snapshot?.extra?.loadRunning.value, true);
    // Mirror case: an old "on" answer while no current flows and the duration stands still.
    driver.px100.load = true;
    sim.state.load.on = false;
    await until(() => session.snapshot?.current === 0);
    settings = await session.loadSettings();
    assert.equal(settings.values?.['atorch.load'], false);
    assert.equal(session.snapshot?.extra?.loadRunning.value, false);
  } finally {
    await s.close();
  }
});

test('session: load current and cutoff beyond the model limits never reach the load', async () => {
  for (const [name, max] of /** @type {const} */ ([
    ['DL24_BLE', 20],
    ['DL24P_BLE', 25],
  ])) {
    const s = await startSession(name, { load: true });
    const { session, sim } = s;
    try {
      await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
      const f = fieldMap((await session.loadSettings()).schema);
      assert.equal(f.get('atorch.load_current')?.max, max, name);
      for (const [id, value] of /** @type {const} */ ([
        ['atorch.load_current', max + 1],
        ['atorch.load_current', 0.1],
        ['atorch.cutoff_voltage', 201],
        ['atorch.cutoff_voltage', -1],
      ])) {
        const r = await session.writeSettings([{ id, value }]);
        assert.equal(r[0].ok, false, `${name}: ${id} = ${value}`);
      }
      // The driver keeps the limits as well when a caller skips the session validation.
      const driver = /** @type {any} */ (session.driver);
      await assert.rejects(driver.writeSetting('atorch.load_current', max + 1), /Invalid value/);
      await assert.rejects(driver.writeSetting('atorch.cutoff_voltage', 201), /Invalid value/);
      const sets = sim.received.filter((x) => x.frame === 'px100' && (x.command === P.PX100.SET_CURRENT || x.command === P.PX100.SET_CUTOFF));
      assert.deepEqual(sets, [], `${name}: no PX100 set frame went out`);
      assert.equal(sim.state.load.current, 1.5);
      // The limit itself is a valid setting.
      const ok = await session.writeSettings([{ id: 'atorch.load_current', value: max }]);
      assert.equal(ok[0].verified, true, name);
      assert.equal(sim.state.load.current, max);
    } finally {
      await s.close();
    }
  }
});

test('session: reports of another device type after detection are ignored', async () => {
  const s = await startSession('DL24_BLE', { load: true });
  const { session, log } = s;
  try {
    await session.connect({ kind: 'link', link: s.host, selection: 'atorch' });
    await until(() => session.snapshot?.current === 1.5);
    // Valid USB meter and AC meter reports in the middle of the DL24 stream.
    await s.device.write(bytesOf('usb-ud18-lispnik-capture'));
    await s.device.write(bytesOf('ac-at3010-report-1'));
    const ignored = () => log.entries().filter((e) => e.kind === 'warn' && /report of device type [13] ignored/.test(e.text ?? '')).length;
    await until(() => ignored() === 2);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(session.variant, 'DC_METER');
    assert.equal(/** @type {any} */ (session.driver).report.deviceType, 2);
    const snap = /** @type {any} */ (session.snapshot);
    assert.equal(snap.current, 1.5);
    assert.equal(snap.extra?.dataPlus, undefined, 'no USB meter values');
    assert.ok(snap.voltage > 10 && snap.voltage < 15, `voltage ${snap.voltage} of the DL24 source`);
  } finally {
    await s.close();
  }
});

test('session: command echoes on the notify path are not taken for replies', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(atorchDrivers), log, probeTimeoutMs: 1000 });
  const { host, device } = createLinkPair({ log, name: 'DT24PW_BLE', deviceChunkSize: 20 });
  await device.open();
  // A bridge that echoes every command back; registered before the simulator, so the echo
  // arrives ahead of the reply.
  let echoed = 0;
  device.on('data', (/** @type {Uint8Array} */ c) => {
    if (c[0] === 0xff && c[1] === 0x55 && c[2] === P.MSG.COMMAND) {
      echoed++;
      void device.write(c);
    }
  });
  const sim = createAtorchSimulator(device, { intervalMs: 100 });
  try {
    await session.connect({ kind: 'link', link: host, selection: 'atorch' });
    await until(() => session.snapshot);
    await session.runAction('atorch.reset_energy');
    const r = await session.writeSettings([{ id: 'atorch.backlight', value: 30 }]);
    assert.deepEqual(r, [{ id: 'atorch.backlight', ok: true, actual: 30, verified: true }]);
    assert.equal(sim.state.backlight, 30);
    assert.equal(echoed, 2);
    assert.ok(!log.entries().some((e) => e.kind === 'warn' && /no reply/.test(e.text ?? '')));
  } finally {
    await session.disconnect();
    sim.stop();
    await device.close();
  }
});
