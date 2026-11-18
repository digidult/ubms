import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, createLinkPair, fromHex, hex, concat } from '@ubms/transport';
import { BmsSession, DriverRegistry, SETTING_GROUPS, fieldMap, validateAll } from '@ubms/bms-core';
import {
  CMD,
  HOST,
  asciiField,
  assembleCells,
  assembleTemperatures,
  assembleText,
  balancingFlags,
  boardHostAddress,
  createClassicAssembler,
  createModbusAssembler,
  createModbusRequestAssembler,
  decodeModbusResponse,
  describe,
  encodeBatteryCodeWrite,
  encodeClassic,
  encodeClassicRead,
  encodeClassicWrite,
  encodeModbusRead,
  encodeModbusReadResponse,
  encodeModbusWrite,
  encodeModbusWriteMulti,
  encodeMosfet,
  encodeReset,
  encodeSetSoc,
  failureAlarms,
  modbusCrcOk,
  modbusData,
  modbusRegisters,
  p81Alarms,
  parseClassic,
  parseD2Status,
  parseModbusRequest,
  parseModbusResponse,
  parseP81Realtime2,
  validateClassic,
  withCrc,
} from '../src/daly/protocol.js';
import { buildClassicSchema, buildD2Schema, buildP81Schema, decodeClassicSettings, setGroupValue } from '../src/daly/settings.js';
import { dalyDrivers, createDalySimulator, createDalyModbusSimulator, CurrentSign, d2Snapshot } from '../src/daly/index.js';
import { drivers } from '../src/index.js';

/** @type {Array<{ id: string, variant: string, link: string, direction: 'tx'|'rx', hex: string, expected?: Record<string, any> }>} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/daly.json', import.meta.url), 'utf8'));

const EM_DASH = String.fromCharCode(0x2014);

/**
 * Deep comparison with a tolerance for numbers.
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
  assert.deepEqual(actual, expected, path);
}

/**
 * Start register of the request each Modbus read response answers (responses do not carry it).
 * @type {Array<[RegExp, number]>}
 */
const RX_START = [
  [/^d2-rx-status/, 0x0000],
  [/^d2-rx-mos-info/, 0x003e],
  [/^d2-rx-version/, 0x00a9],
  [/^d2-rx-settings/, 0x0080],
  [/^d2-rx-password/, 0x00c9],
  [/^d2-rx-balancer-switch/, 0x00cf],
  [/^d2-rx-0063/, 0x0063],
  [/^d2-rx-00cc/, 0x00cc],
  [/^d2-rx-00df/, 0x00df],
  [/^d2-rx-0057/, 0x0057],
  [/^d2-rx-00d7/, 0x00d7],
  [/^p81-rx-rt1/, 0x0000],
  [/^p81-rx-rt2/, 0x0041],
  [/^p81-rx-version/, 0x0178],
  [/^p81-rx-00a4/, 0x00a4],
  [/^p81-rx-settings1/, 0x0100],
  [/^p81-rx-settings2/, 0x0151],
  [/^p81-rx-settings3/, 0x01c3],
  [/^p81-rx-settings4/, 0x0220],
  [/^p81-rx-settings5/, 0x024b],
  [/^p81-rx-00cf/, 0x00cf],
];

/**
 * Parsed object of a Modbus read response plus the generic views the vectors use:
 * `register0xNNNN`, `<name>0xNNNN` (raw register, register group or ASCII text at that address),
 * `allFF`, hex register lists and the version string concatenations of aiobmsble and syssi.
 * @param {{ id: string, hex: string, expected: Record<string, any> }} v
 */
function modbusView(v) {
  const frame = fromHex(v.hex);
  if (frame[1] !== 0x03) return parseModbusResponse(frame);
  const start = RX_START.find(([re]) => re.test(v.id))?.[1];
  assert.notEqual(start, undefined, `${v.id}: no start register known`);
  /** @type {Record<string, any>} */
  const o = decodeModbusResponse(frame, start);
  const regs = modbusRegisters(frame);
  const data = modbusData(frame);
  o.allFF = Array.from(data).every((b) => b === 0xff);
  for (const [key, e] of Object.entries(v.expected)) {
    const m = /0x([0-9A-F]{4})$/i.exec(key);
    if (m) {
      const i = parseInt(m[1], 16) - /** @type {number} */ (start);
      if (Array.isArray(e)) o[key] = regs.slice(i, i + e.length);
      else if (typeof e === 'string') o[key] = asciiField(data, 2 * i, e.length);
      else o[key] = regs[i];
    }
    if (key === 'registers' && typeof e[0] === 'string') o[key] = regs.map((r) => `0x${r.toString(16).toUpperCase().padStart(4, '0')}`);
  }
  if (o.field0 !== undefined) {
    o.aiobmsbleSwVersion = o.syssiSoftwareVersion = o.field0 + o.field1;
    o.aiobmsbleHwVersion = o.syssiHardwareVersion = o.field2;
    o.aiobmsbleSerialNumber = o.field3;
  }
  return o;
}

/** Alarm each D2 alarm vector describes (id and severity). */
const D2_ALARMS = {
  'd2-rx-status62-alarm-warn-charging-temp-high': ['charge_overtemperature', 'warning'],
  'd2-rx-status62-alarm-warn-cell-voltage-high': ['cell_overvoltage', 'warning'],
  'd2-rx-status62-alarm-afe-failure': ['afe_fault', 'fault'],
};

test('vectors: every expected value parses', async (t) => {
  assert.equal(vectors.length, 252);
  for (const v of vectors) {
    if (!v.expected) continue;
    await t.test(v.id, () => {
      const frame = fromHex(v.hex);
      if (v.variant === 'DALY_CLASSIC') {
        assert.ok(validateClassic(frame), 'checksum');
        const o = parseClassic(frame);
        for (const [k, e] of Object.entries(v.expected)) near(o[k], e, k);
        return;
      }
      if (v.expected.crcValid === false) {
        assert.equal(parseModbusResponse(frame).crcValid, false);
        return;
      }
      assert.ok(modbusCrcOk(frame), 'CRC');
      if (v.direction === 'tx') {
        const o = parseModbusRequest(frame);
        for (const [k, e] of Object.entries(v.expected)) near(o[k], e, k);
        return;
      }
      const o = modbusView(/** @type {any} */ (v));
      for (const [k, e] of Object.entries(v.expected)) {
        if (k === 'activeAlarm') {
          const [id, severity] = /** @type {Record<string, string[]>} */ (D2_ALARMS)[v.id];
          assert.deepEqual(
            failureAlarms(parseD2Status(frame).faultBytes).map((a) => [a.id, a.severity]),
            [[id, severity]],
          );
          continue;
        }
        near(o[k], e, k);
      }
    });
  }
});

test('vectors: the frame with a wrong CRC is rejected by the assembler', () => {
  const bad = vectors.filter((v) => v.expected?.crcValid === false);
  assert.equal(bad.length, 1);
  const frames = [];
  const asm = createModbusAssembler({ onFrame: (f) => frames.push(f), addresses: [0xd2] });
  asm.push(fromHex(bad[0].hex));
  assert.equal(frames.length, 0);
  // The correct echo that followed (snoop record 251) is accepted.
  asm.push(encodeModbusWrite(0xd2, 0x00cf, 1));
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), 'D20600CF00016B96');
});

test('vectors: classic requests equal the encoder output', () => {
  let checked = 0;
  for (const v of vectors.filter((x) => x.variant === 'DALY_CLASSIC' && x.direction === 'tx')) {
    const f = fromHex(v.hex);
    const [address, cmd] = [f[1], f[2]];
    let out;
    if (cmd === CMD.CHARGE_MOS) out = encodeMosfet(address, 'charge', f[4] === 1);
    else if (cmd === CMD.DISCHARGE_MOS) out = encodeMosfet(address, 'discharge', f[4] === 1);
    else if (cmd >= 0x50 || cmd === 0x02) out = encodeClassicRead(address, cmd, f[4]);
    else if (cmd === CMD.RESET) out = encodeReset(address);
    else if (cmd === CMD.SET_SOC) {
      const rtc = /** @type {string | undefined} */ (v.expected?.rtc);
      const m = rtc && /^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+)$/.exec(rtc);
      const date = m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
      out = encodeSetSoc(address, v.expected?.soc, date);
    } else if (cmd === CMD.BATTERY_CODE - 0x40) {
      out = encodeBatteryCodeWrite(address, '20200306')[f[4] - 1];
    } else {
      // Configuration group writes: decode every schema field of the group and encode it back
      // into the captured bytes; undefined bytes stay as captured (spec 5.3).
      const schema = buildClassicSchema();
      const readCmd = cmd + 0x40;
      const data = f.slice(4, 12);
      const values = decodeClassicSettings(schema, new Map([[readCmd, data]]));
      const copy = Uint8Array.from(data);
      for (const fld of fieldMap(schema).values()) {
        if (fld.meta?.kind === 'group' && fld.meta.cmd === readCmd && values[fld.id] !== undefined) setGroupValue(fld.meta, values[fld.id], copy);
      }
      out = encodeClassicWrite(address, readCmd, copy);
    }
    assert.equal(hex(out), v.hex, v.id);
    checked++;
  }
  assert.ok(checked >= 80, `${checked} classic requests checked`);
  assert.equal(hex(encodeClassicRead(boardHostAddress(2), CMD.SOC)), 'A541900800000000000000007E');
});

test('vectors: Modbus requests equal the encoder output', () => {
  let checked = 0;
  for (const v of vectors.filter((x) => x.variant === 'DALY_MODBUS' && x.direction === 'tx')) {
    const e = /** @type {Record<string, any>} */ (v.expected);
    let out;
    if (e.function === 3) out = encodeModbusRead(e.address, e.start, e.count);
    else if (e.function === 6) out = encodeModbusWrite(e.address, e.register, e.value);
    else {
      let values = e.values;
      if (e.rtc) {
        const [d, t] = e.rtc.split(' ');
        const [y, mo, da] = d.split('-').map(Number);
        const [h, mi, s] = t.split(':').map(Number);
        values = [((y - 2000) << 8) | mo, (da << 8) | h, (mi << 8) | s];
      }
      out = encodeModbusWriteMulti(e.address, e.register, values);
    }
    assert.equal(hex(out), v.hex, v.id);
    checked++;
  }
  assert.ok(checked >= 50, `${checked} Modbus requests checked`);
});

test('settings decoding of captured classic groups', () => {
  const schema = buildClassicSchema();
  const groups = new Map();
  for (const id of ['classic-rx-50-forum', 'classic-rx-59-forum', 'classic-rx-5b-forum', 'classic-rx-5c-forum', 'classic-rx-5e-forum', 'classic-rx-53-forum', 'classic-rx-51-forum']) {
    const f = fromHex(/** @type {any} */ (vectors.find((v) => v.id === id)).hex);
    groups.set(f[2], f.slice(4, 12));
  }
  const values = decodeClassicSettings(schema, groups);
  assert.equal(values['capacity.nominal'], 40);
  assert.equal(values['daly.cell_nominal_voltage'], 3.7);
  assert.equal(values['cell.ov_alarm'], 4.15);
  assert.equal(values['cell.ovp'], 4.1);
  assert.equal(values['charge.oc_alarm'], 240);
  assert.equal(values['charge.ocp'], 150);
  assert.equal(values['discharge.oc_alarm'], 240);
  assert.equal(values['discharge.ocp'], 75);
  assert.equal(values['charge.otp'], 65);
  assert.equal(values['discharge.utp'], -40);
  assert.equal(values['temp.diff_alarm'], 10);
  assert.equal(values['system.sleep_delay'], 65535);
  assert.equal(values['system.cell_count'], 14);
  assert.equal(values['system.temp_sensor_count'], 1);
  assert.equal(values['daly.production_date'], '2021-03-06');
});

test('classic assembler: fragments, several frames per chunk, garbage and bad checksums', () => {
  const frames = [];
  const discarded = [];
  const asm = createClassicAssembler({ onFrame: (f) => frames.push(hex(f)), onDiscard: (b, reason) => discarded.push(reason) });
  const a = fromHex('A501900802100000753001F4EA');
  const b = fromHex('A50191080EC8050E9C0901F4C2');
  for (const byte of a) asm.push(Uint8Array.of(byte));
  assert.deepEqual(frames, [hex(a)]);
  // AT text of the BLE module, a frame with a broken checksum, then two frames in one chunk.
  const broken = Uint8Array.from(b);
  broken[12] ^= 0xff;
  asm.push(concat(new TextEncoder().encode('AT+PRODUCTINFO=NoPID'), broken.subarray(0, 7)));
  asm.push(concat(broken.subarray(7), a, b));
  assert.deepEqual(frames, [hex(a), hex(a), hex(b)]);
  assert.ok(discarded.length > 0);
  // A stray A5 inside a frame does not hide the frame that follows.
  asm.push(concat(fromHex('A5A5'), a));
  assert.equal(frames.at(-1), hex(a));
});

test('Modbus assembler: several replies per notification, fragments, byte count check', () => {
  const frames = [];
  let expected;
  const asm = createModbusAssembler({ onFrame: (f) => frames.push(f), addresses: [0xd2, 0x51], expectedByteCount: () => expected });
  const status = fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'd2-rx-status62-8s')).hex);
  const pwd = fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'd2-rx-password')).hex);
  const echo = encodeModbusWrite(0xd2, 0x00a5, 1);
  // Three replies in one notification (snoop records 209 and 212).
  asm.push(concat(pwd, echo, pwd));
  assert.deepEqual(frames.map((f) => f.length), [11, 8, 11]);
  // A 129 byte reply in 20 byte fragments with AT text in front.
  frames.length = 0;
  asm.push(new TextEncoder().encode('9600'));
  for (let i = 0; i < status.length; i += 20) asm.push(status.subarray(i, i + 20));
  assert.equal(frames.length, 1);
  assert.equal(parseD2Status(frames[0]).cellCount, 8);
  // With an outstanding read of 3 registers, a header with another byte count is not trusted.
  frames.length = 0;
  expected = 6;
  asm.push(concat(status.subarray(100), pwd));
  assert.equal(frames.length, 1);
  assert.equal(hex(frames[0]), hex(pwd));
  // 0x81 map replies come from 0x51; exception answers are 5 bytes.
  expected = undefined;
  frames.length = 0;
  asm.push(fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'p81-rx-00cf-ess')).hex));
  asm.push(withCrc([0x51, 0x83, 0x02]));
  assert.deepEqual(
    frames.map((f) => f.length),
    [7, 5],
  );
  assert.equal(parseModbusResponse(frames[1]).exceptionCode, 2);
  // A read response encoded by the simulator side parses back.
  assert.deepEqual(modbusRegisters(encodeModbusReadResponse(0xd2, [1, 0xffff])), [1, 0xffff]);

  // Device side: 0x10 without byte count (vendor example and snoop).
  const requests = [];
  const dev = createModbusRequestAssembler({ onFrame: (f) => requests.push(hex(f)), addresses: [0xd2] });
  dev.push(fromHex('D21000D40003180B0709341CF7D8D2030000003ED7B9'));
  assert.deepEqual(requests, ['D21000D40003180B0709341CF7D8', 'D2030000003ED7B9']);
});

test('multi-frame helpers: cells, temperatures, text, balancing', () => {
  const cell = (n, a, b, c) => encodeClassic(1, CMD.CELLS, [n, a >> 8, a & 0xff, b >> 8, b & 0xff, c >> 8, c & 0xff, 0x40]);
  const f1 = cell(1, 3300, 3301, 3302);
  const f2 = cell(2, 3303, 0, 0);
  assert.deepEqual(assembleCells([f2, f1, cell(3, 0, 0, 0)], 4), [3.3, 3.301, 3.302, 3.303]);
  assert.equal(assembleCells([f1], 4), null, 'missing frame');
  assert.equal(assembleCells([f1, f1, f2], 4), null, 'duplicate frame');
  const t = encodeClassic(1, CMD.TEMPERATURES, [1, 61, 62, 0, 0, 0, 0, 0]);
  assert.deepEqual(assembleTemperatures([t, encodeClassic(1, CMD.TEMPERATURES, [2])], 2), [21, 22]);
  const code = encodeBatteryCodeWrite(1, 'ABC').map((f) => encodeClassic(1, CMD.BATTERY_CODE, f.subarray(4, 12)));
  assert.equal(assembleText(code, 5), 'ABC');
  assert.deepEqual(balancingFlags([0b101, 0x80], 9), [true, false, true, false, false, false, false, false, false]);
});

test('P81 alarm codes and D2 fault bytes', () => {
  const rt2 = parseP81Realtime2(fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'p81-rx-rt2-aiobmsble')).hex));
  assert.deepEqual(
    p81Alarms(rt2.type2Bytes).map((a) => [a.id, a.severity]),
    [
      ['soc_low', 'protection'],
      ['temperature_sensor_fault', 'fault'],
    ],
  );
  // The ESS pack sets code 6 bit 7 (parallel communication, meaning unverified): not reported.
  const ess = parseP81Realtime2(fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'p81-rx-rt2-ess')).hex));
  assert.deepEqual(p81Alarms(ess.type2Bytes), []);
  // Level 1 and level 2 of the same alarm collapse into the more severe one.
  assert.deepEqual(
    failureAlarms([0x03, 0, 0, 0, 0, 0, 0, 0]).map((a) => [a.id, a.severity]),
    [['cell_overvoltage', 'protection']],
  );
});

test('protocol log descriptions', () => {
  assert.match(describe(encodeClassicRead(HOST.BLUETOOTH, CMD.CELLS))?.name ?? '', /Cell voltages \(0x95\) request/);
  assert.match(describe(fromHex('A5401908103610040AF00BB81D'))?.name ?? '', /Write cell voltage thresholds/);
  assert.match(describe(encodeModbusRead(0xd2, 0x80, 41), { direction: 'tx' })?.name ?? '', /D2 read settings/);
  const status = fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'd2-rx-status62-8s')).hex);
  const d = describe(status, { start: 0 });
  assert.match(d?.name ?? '', /D2 status \(62 registers\)/);
  assert.equal(d?.decode?.().cellCount, 8);
});

test('current sign: majority default, state cross-check, user override', () => {
  const classic = new CurrentSign(true);
  // Classic raw below 30000 decodes negative and means charging.
  assert.equal(classic.apply(-12.3, 1).current, 12.3);
  const odd = new CurrentSign(true);
  const results = [1, 2, 3].map(() => odd.apply(5, 1));
  assert.deepEqual(
    results.map((r) => r.flipped),
    [false, false, true],
  );
  assert.equal(odd.apply(5, 1).current, 5);
  odd.user = true;
  assert.equal(odd.apply(5, 1).current, -5);
  const modbus = new CurrentSign(false);
  assert.equal(modbus.apply(6.5, 1).current, 6.5);
  assert.equal(modbus.apply(0, 0).current, 0);
});

test('settings schemas: groups, safety flags and counts', () => {
  const groupIds = new Set(Object.keys(SETTING_GROUPS));
  for (const [name, schema] of [
    ['classic', buildClassicSchema()],
    ['d2', buildD2Schema({ balancerSwitch: true })],
    ['p81', buildP81Schema()],
  ]) {
    const fields = [...fieldMap(/** @type {any} */ (schema)).values()];
    for (const f of fields) {
      assert.ok(groupIds.has(f.group), `${name} ${f.id}: group ${f.group}`);
      assert.ok(f.meta?.kind, `${name} ${f.id}: meta`);
      if (f.readOnly) assert.ok(f.description, `${name} ${f.id}: read-only fields explain why`);
      if (f.type === 'action') assert.equal(f.group, 'actions', `${name} ${f.id}`);
      if (f.id.startsWith('daly.') && f.id !== 'daly.invert_current') assert.notEqual(f.label, f.id, `${name} ${f.id}: label`);
      for (const text of [f.label, f.description ?? '']) assert.ok(!text.includes(EM_DASH));
    }
    assert.equal(fields.filter((f) => f.id === 'daly.invert_current' && f.group === 'system' && f.advanced && f.type === 'boolean').length, 1, name);
  }
  const p81 = [...fieldMap(buildP81Schema()).values()];
  const writable = p81.filter((f) => !f.readOnly && f.type !== 'action').map((f) => f.id).sort();
  assert.deepEqual(writable, ['daly.force_fan', 'daly.invert_current', 'soc.value', 'switch.charge', 'switch.discharge', 'switch.heater', 'system.sleep_delay']);
  const classic = fieldMap(buildClassicSchema());
  assert.equal(classic.get('temp.diff_alarm')?.readOnly, true, 'classic temperature difference offset is unverified');
  assert.equal(classic.get('daly.current_sampling_resistance')?.readOnly, true);
  assert.equal(classic.get('system.battery_type')?.readOnly, true, 'classic battery type table is unverified');
  // Cross-field checks: high above low, level 2 beyond level 1 for temperatures.
  const errors = validateAll(buildClassicSchema(), { 'charge.otp': 40, 'daly.charge_ot_alarm': 50, 'charge.utp': 0, 'daly.charge_ut_alarm': 5 });
  assert.ok(errors['charge.otp']);
  assert.equal(buildD2Schema().groups.flatMap((g) => g.fields).some((f) => f.id === 'switch.balance'), false);
});

test('registry: definitions, chooser filters and demo entries', () => {
  assert.deepEqual(
    dalyDrivers.map((d) => d.id),
    ['daly-modbus', 'daly'],
  );
  assert.ok(drivers.some((d) => d.id === 'daly'));
  const registry = new DriverRegistry(dalyDrivers);
  const { request } = registry.bleRequest({ selection: 'daly-modbus' });
  assert.ok(request.filters?.some((f) => f.namePrefix === 'DL-'));
  assert.ok(request.filters?.some((f) => f.namePrefix === 'JHB-'));
  assert.ok(request.filters?.some((f) => f.manufacturerData?.[0].companyIdentifier === 0x0302));
  assert.ok(request.optionalServices.includes('0000fff0-0000-1000-8000-00805f9b34fb'));
  assert.ok(request.optionalServices.includes('0000ff00-0000-1000-8000-00805f9b34fb'));
  const ranked = registry.bleCandidates({ name: 'DL-401710015C9B', services: ['0000fff0-0000-1000-8000-00805f9b34fb'] });
  assert.deepEqual(
    ranked.map((c) => [c.definition.id, c.profile.id, c.score]),
    [
      ['daly-modbus', 'daly-modbus-fff0', 10],
      ['daly', 'daly-fff0', 10],
    ],
  );
  for (const d of dalyDrivers) {
    assert.match(d.demo?.name ?? '', /^DL-[0-9A-F]{12} \(demo\)$/);
    assert.equal(d.demo?.chunkSize, 20);
    assert.equal(d.links.serial?.profiles[0].baudRate, 9600);
  }
});

// ---------------------------------------------------------------------------------------------
// Simulators and sessions
// ---------------------------------------------------------------------------------------------

/**
 * @param {Object} [opts]
 * @param {string} [opts.kind]
 * @param {number} [opts.probeTimeoutMs]
 */
function setup({ kind = 'memory', probeTimeoutMs = 1000 } = {}) {
  const log = new ProtocolLog();
  const registry = new DriverRegistry(dalyDrivers);
  const session = new BmsSession({ registry, log, pollIntervalMs: 1000, probeTimeoutMs });
  const { host, device } = createLinkPair({ log, deviceChunkSize: 20, kind });
  return { log, session, host, device };
}

/** @param {BmsSession} session */
const nextSnapshot = (session) => new Promise((resolve) => session.once('snapshot', resolve));

test('classic simulator round trip at protocol level', async () => {
  const { host, device } = createLinkPair({ deviceChunkSize: 13 });
  await host.open();
  await device.open();
  const sim = createDalySimulator(device, { tickMs: 0 });
  const frames = [];
  const asm = createClassicAssembler({ onFrame: (f) => frames.push(f) });
  host.on('data', (c) => asm.push(c));
  const ask = async (bytes, wait = 30) => {
    frames.length = 0;
    await host.write(bytes);
    await new Promise((r) => setTimeout(r, wait));
    return frames.map((f) => parseClassic(f));
  };
  // Host 0x80 gets all 16 cell frames, host 0x40 only the needed six (spec 4.2).
  assert.equal((await ask(encodeClassicRead(HOST.BLUETOOTH, CMD.CELLS))).length, 16);
  assert.equal((await ask(encodeClassicRead(HOST.PC, CMD.CELLS))).length, 6);
  const [cfg] = await ask(encodeClassicRead(HOST.PC, CMD.CELL_LIMITS));
  assert.equal(cfg.cellHighL2, 3.65);
  const data = Uint8Array.from(cfg.data);
  data[3] = 0x10; // 3.600 V -> 0x0E10
  data[2] = 0x0e;
  const [ack] = await ask(encodeClassicWrite(HOST.PC, CMD.CELL_LIMITS, data));
  assert.equal(ack.command, 0x19);
  assert.equal(ack.data0, 1);
  assert.equal((await ask(encodeClassicRead(HOST.PC, CMD.CELL_LIMITS)))[0].cellHighL2, 3.6);
  const [mos] = await ask(encodeMosfet(HOST.PC, 'charge', false));
  assert.equal(mos.data0, 0);
  assert.equal(sim.battery.switches.charge, false);
  const [soc] = await ask(encodeSetSoc(HOST.PC, 80.5, new Date()));
  assert.equal(soc.data0, 1);
  assert.equal(sim.battery.soc, 80.5);
  // Requests to another board are ignored.
  assert.equal((await ask(encodeClassicRead(boardHostAddress(3), CMD.SOC))).length, 0);
  sim.stop();
});

test('session: classic driver with the simulator (snapshot, settings, write, switch)', async () => {
  const { session, host, device } = setup();
  await device.open();
  const sim = createDalySimulator(device, { tickMs: 0 });
  sim.battery.current = 12.3; // charging
  const first = nextSnapshot(session);
  await session.connect({ kind: 'link', link: host, selection: 'daly' });
  assert.equal(session.definition?.id, 'daly');
  assert.equal(session.variant, 'DALY_CLASSIC');
  /** @type {any} */
  const s = await first;
  assert.equal(s.cells.length, 16);
  assert.ok(s.cells.every((/** @type {number} */ v) => v > 2.5 && v < 3.7));
  assert.ok(Math.abs(s.voltage - s.cellStats.sum) < 0.1, 'pack voltage matches the cells');
  assert.equal(s.current, 12.3, 'positive while charging');
  assert.ok(s.power > 0);
  assert.equal(s.state, 'charging');
  assert.equal(s.soc, 64);
  assert.deepEqual(
    s.temperatures.map((/** @type {any} */ t) => t.id),
    ['t1', 't2'],
  );
  assert.deepEqual(s.switches, { charge: true, discharge: true });
  assert.equal(s.balancing.length, 16);
  assert.equal(s.extra.chargerConnected.value, true);
  assert.ok(Math.abs(s.capacityRemaining - 96) < 0.01);

  const settings = await session.loadSettings();
  assert.equal(settings.error, null);
  const values = /** @type {Record<string, any>} */ (settings.values);
  assert.equal(values['cell.ovp'], 3.65);
  assert.equal(values['charge.ocp'], 150);
  assert.equal(values['discharge.ocp'], 200);
  assert.equal(values['capacity.nominal'], 150);
  assert.equal(values['daly.battery_code'], 'UBMS DEMO 16S 150AH');
  assert.equal(values['system.cell_count'], 16);
  assert.equal(values['switch.charge'], true);
  assert.equal(values['daly.invert_current'], true, 'classic majority rule: raw below 30000 is charging');

  const results = await session.writeSettings([{ id: 'cell.ovp', value: 3.6 }]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.verified]),
    [['cell.ovp', true, true]],
  );
  assert.equal(sim.groups.get(CMD.CELL_LIMITS)?.[2], 0x0e);
  assert.equal(sim.groups.get(CMD.CELL_LIMITS)?.[3], 0x10);

  const sw = await session.writeSettings([{ id: 'switch.charge', value: false }]);
  assert.deepEqual(
    sw.map((r) => [r.ok, r.verified]),
    [[true, true]],
  );
  assert.equal(sim.battery.switches.charge, false);

  const code = await session.writeSettings([{ id: 'daly.battery_code', value: 'PACK 7' }]);
  assert.deepEqual(
    code.map((r) => [r.ok, r.verified]),
    [[true, true]],
  );
  assert.equal(sim.texts[CMD.BATTERY_CODE].trim(), 'PACK 7');

  const soc = await session.writeSettings([{ id: 'soc.value', value: 75.5 }]);
  assert.deepEqual(
    soc.map((r) => [r.ok, r.verified]),
    [[true, true]],
  );
  await session.runAction('daly.reset');
  assert.equal(sim.state.resets, 1);
  assert.ok(session.info?.softwareVersion === '20230815-1.12T');
  await session.disconnect();
  sim.stop();
});

test('session: classic driver on a serial link, sleeping module and 0x40-only module', async () => {
  // Serial: host 0x40, only the needed frames, first request lost (asleep).
  {
    const { session, host, device } = setup({ kind: 'serial', probeTimeoutMs: 2000 });
    await device.open();
    const sim = createDalySimulator(device, { tickMs: 0, dropFirst: 1 });
    const first = nextSnapshot(session);
    await session.connect({ kind: 'link', link: host, selection: 'daly' });
    /** @type {any} */
    const s = await first;
    assert.equal(s.cells.length, 16);
    assert.equal(sim.received[0][1], 0x40);
    await session.disconnect();
    sim.stop();
  }
  // A Bluetooth module that answers only the PC address (batmon-ha issue #416).
  {
    const { session, host, device } = setup();
    await device.open();
    const sim = createDalySimulator(device, { tickMs: 0, hosts: [HOST.PC] });
    const first = nextSnapshot(session);
    await session.connect({ kind: 'link', link: host, selection: 'daly' });
    /** @type {any} */
    const s = await first;
    assert.equal(s.cells.length, 16);
    assert.equal(sim.received.at(-1)?.[1], HOST.PC);
    await session.disconnect();
    sim.stop();
  }
});

test('session: Modbus D2 driver with the simulator', async () => {
  const { session, host, device } = setup();
  await device.open();
  const sim = createDalyModbusSimulator(device, { tickMs: 0 });
  sim.battery.current = -8.4; // discharging
  const first = nextSnapshot(session);
  await session.connect({ kind: 'link', link: host, selection: 'daly-modbus' });
  assert.equal(session.variant, 'DALY_MODBUS_D2');
  /** @type {any} */
  const s = await first;
  assert.equal(s.cells.length, 16);
  assert.equal(s.current, -8.4);
  assert.ok(s.power < 0);
  assert.ok(s.temperatures.some((/** @type {any} */ t) => t.id === 'mos'));
  assert.equal(s.switches.balance, undefined, 'a BMS has no balancer switch');

  const settings = await session.loadSettings();
  const values = /** @type {Record<string, any>} */ (settings.values);
  assert.equal(values['cell.ovp'], 3.65);
  assert.equal(values['charge.oc_alarm'], 100);
  assert.equal(values['discharge.ocp'], 200);
  assert.equal(values['mos.otp'], 85);
  assert.equal(values['system.battery_type'], 0);
  assert.equal(values['identity.password'], '123456');
  assert.equal(values['daly.invert_current'], false);
  assert.equal(
    settings.schema?.groups.flatMap((g) => g.fields).some((f) => f.id === 'switch.balance'),
    false,
  );

  const results = await session.writeSettings([
    { id: 'cell.ovp', value: 3.62 },
    { id: 'charge.ocp', value: 120 },
    { id: 'switch.discharge', value: false },
  ]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.verified]),
    [
      ['cell.ovp', true, true],
      ['charge.ocp', true, true],
      ['switch.discharge', true, true],
    ],
  );
  assert.equal(sim.registers[0x8c], 3620);
  assert.equal(sim.registers[0x94], 28800);
  assert.equal(sim.battery.switches.discharge, false);
  await session.runAction('daly.current_zero');
  assert.equal(sim.state.currentZeroed, 1);
  assert.equal(session.info?.softwareVersion, 'T00K_240315_12');
  await session.disconnect();
  sim.stop();
});

test('session: Modbus D2 active balancer exposes its switch', async () => {
  const { session, host, device } = setup();
  await device.open();
  const sim = createDalyModbusSimulator(device, { tickMs: 0, balancer: true });
  await session.connect({ kind: 'link', link: host, selection: 'daly-modbus' });
  const settings = await session.loadSettings();
  assert.equal(settings.values?.['switch.balance'], true);
  const results = await session.writeSettings([{ id: 'switch.balance', value: false }]);
  assert.deepEqual(
    results.map((r) => [r.ok, r.verified]),
    [[true, true]],
  );
  assert.equal(sim.registers[0xcf], 0);
  await session.disconnect();
  sim.stop();
});

test('session: Modbus 0x81 map (probe falls back from D2)', async () => {
  const { session, host, device } = setup({ probeTimeoutMs: 800 });
  await device.open();
  const sim = createDalyModbusSimulator(device, { tickMs: 0, flavour: 'p81' });
  sim.battery.current = 20;
  const first = nextSnapshot(session);
  await session.connect({ kind: 'link', link: host, selection: 'daly-modbus' });
  assert.equal(session.variant, 'DALY_MODBUS_81');
  assert.ok(sim.received.some((f) => f[0] === 0xd2) === false, 'the 0x81 device only sees its own frames');
  /** @type {any} */
  const s = await first;
  assert.equal(s.cells.length, 16);
  assert.equal(s.current, 20);
  assert.ok(s.temperatures.some((/** @type {any} */ t) => t.id === 'board'));
  assert.deepEqual(Object.keys(s.switches).sort(), ['charge', 'discharge', 'heater', 'precharge']);

  const settings = await session.loadSettings();
  const values = /** @type {Record<string, any>} */ (settings.values);
  assert.equal(values['cell.ovp'], 3.55);
  assert.equal(values['capacity.nominal'], 314);
  assert.equal(values['system.address'], 1);
  assert.equal(values['system.sleep_delay'], 655350);
  assert.equal(values['daly.allowed_charge_current'], 150);
  const fields = fieldMap(settings.schema);
  assert.equal(fields.get('cell.ovp')?.readOnly, true);

  const results = await session.writeSettings([
    { id: 'system.sleep_delay', value: 3600 },
    { id: 'switch.charge', value: false },
    { id: 'cell.ovp', value: 3.5 },
  ]);
  assert.deepEqual(
    results.map((r) => [r.id, r.ok, r.verified ?? null]),
    [
      ['system.sleep_delay', true, true],
      ['switch.charge', true, true],
      ['cell.ovp', false, null],
    ],
  );
  assert.equal(sim.registers[0x115], 360);
  assert.equal(sim.battery.switches.charge, false);
  assert.equal(session.info?.model, 'DL_HKMS_3.2.E');
  await session.disconnect();
  sim.stop();
});

test('D2 snapshot from captured frames', () => {
  const st = parseD2Status(fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'd2-rx-status62-4s-charging-uart')).hex));
  const s = d2Snapshot(st, { current: new CurrentSign(false).apply(st.current, st.chargeDischargeState).current });
  assert.equal(s.current, 6.5);
  assert.equal(s.power, 84);
  assert.equal(s.cells?.length, 4);
  const blue = parseD2Status(fromHex(/** @type {any} */ (vectors.find((v) => v.id === 'd2-rx-status80-blue-series')).hex));
  const b = d2Snapshot(blue, { current: blue.current });
  assert.equal(b.current, -3.1);
  assert.equal(b.power, -162);
  assert.deepEqual(
    b.temperatures?.map((t) => t.id),
    ['t1', 't2', 't3', 't4', 'mos'],
  );
});
