import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProtocolLog, concat, createLinkPair, fromHex, hex, sleep, sum8, u32le } from '@ubms/transport';
import { BmsSession, DriverRegistry, fieldMap, validateValue } from '@ubms/bms-core';
import * as P from '../src/jk/protocol.js';
import * as B from '../src/jk/balancer-protocol.js';
import { bleWriteFrame } from '../src/jk/settings.js';
import {
  balancerRs485Snapshot,
  balancingFlags,
  buildJk04BalancerSchema,
  buildJkBalancerRs485Schema,
  jk04BalancerSnapshot,
  jkBalancerBleDefinition,
  jkBalancerRs485Definition,
} from '../src/jk/balancer.js';
import { createJkBalancerRs485Simulator } from '../src/jk/balancer-simulator.js';
import { createJkSimulator, jkDrivers } from '../src/jk/index.js';
import { drivers } from '../src/index.js';

/** @type {Array<{ id: string, variant: string, link: string, direction: string, hex: string, expected: Record<string, any> }>} */
const vectors = JSON.parse(readFileSync(new URL('./vectors/jk-balancer.json', import.meta.url), 'utf8'));
const byId = (/** @type {string} */ id) => {
  const v = vectors.find((x) => x.id === id);
  assert.ok(v, `vector ${id}`);
  return /** @type {NonNullable<typeof v>} */ (v);
};
const rs485 = vectors.filter((v) => v.variant === 'JK_BALANCER_RS485');
const jk04 = vectors.filter((v) => v.variant === 'JK04');

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
 * Deep comparison of numbers. A whole number must match exactly (1e-9 for double arithmetic);
 * other numbers within half a unit in the last written decimal of the expected number (the
 * vectors round to 3 or 4 decimals), at least 1e-6 and at most 5e-4, so a value with one or two
 * written decimals cannot hide an offset or a scale error.
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

/** @param {number[]} xs */
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Fake BLE device handle: every channel is a new link pair with a device attached.
 * @param {ProtocolLog} log
 * @param {{ name?: string, attach: (device: import('@ubms/transport').MemoryLink) => any }} opts
 */
function fakeBleHandle(log, { name = 'BMS', attach }) {
  /** @type {any[]} */
  const sims = [];
  return {
    name,
    connected: false,
    sims,
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
      const { host, device } = createLinkPair({ log, deviceChunkSize: profile.chunkSize ?? 20 });
      await host.open();
      await device.open();
      sims.push(attach(device));
      return host;
    },
  };
}

/**
 * Fake serial port: every probe opens a new link pair; the device answers only at 9600 baud.
 * @param {ProtocolLog} log
 * @param {(device: import('@ubms/transport').MemoryLink) => any} attach
 */
function fakeSerialPort(log, attach) {
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
      const { host, device } = createLinkPair({ log, deviceChunkSize: 32 });
      await host.open();
      await device.open();
      if (opts.baudRate === 9600) sims.push(attach(device));
      return host;
    },
  };
}

/**
 * Replay of a captured JK-B2A16S hw 3.0 sw 3.3.0 (jk-balancer.json): device info on 0x97;
 * settings frame, ACK and two cell info frames on 0x96; the ACK after every write. A write
 * changes the settings copy at register + 6, the offset rule of spec 3.1, so the read-back
 * shows it like on the device.
 * @param {import('@ubms/transport').MemoryLink} device
 */
function b2a16sDevice(device) {
  const info = fromHex(byId('bal-jk04-rx-device-info-b2a16s').hex);
  const settings = Uint8Array.from(fromHex(byId('bal-jk04-rx-settings-b2a16s-power-off-2v7').hex));
  const cells = [fromHex(byId('bal-jk04-rx-cell-info-b2a16s-discharging').hex), fromHex(byId('bal-jk04-rx-cell-info-b2a16s-charging').hex)];
  const known = new Set(P.JK04_SETTINGS_LAYOUT.map((s) => s.offset));
  /** @type {Uint8Array[]} */
  const received = [];
  const asm = P.createCommandAssembler({
    onFrame: (f) => {
      received.push(f);
      if (f[4] === P.CMD.DEVICE_INFO) {
        tx(device, info);
        tx(device, P.ackFrame());
      } else if (f[4] === P.CMD.SETTINGS) {
        tx(device, settings.slice());
        tx(device, P.ackFrame());
        tx(device, cells[0]);
        setTimeout(() => tx(device, cells[1]), 50).unref?.();
      } else {
        const offset = f[4] + 6;
        if (known.has(offset) && [1, 2, 4].includes(f[5])) {
          settings.set(f.subarray(6, 6 + f[5]), offset);
          settings[299] = sum8(settings, 0, 299);
        }
        tx(device, P.ackFrame());
      }
    },
  });
  device.on('data', (c) => asm.push(c));
  return { received, settings, stop() {} };
}

/**
 * Parsed JK04 vector value. Fields that protocol.js does not decode (unknown meaning, spec 6.1,
 * 6.2) are read from the raw bytes, `bytes66to298Zero` with the balancer helper.
 * @type {Record<string, (frame: Uint8Array, parsed: Record<string, any>) => any>}
 */
const JK04_RAW = {
  unknown6: (f) => P.f32le(f, 6),
  unknown102: (f) => P.f32le(f, 102),
  unknown221: (f) => f[221],
  unknown237: (f) => u32le(f, 237),
  unknown290: (f) => P.f32le(f, 290),
  unknown294: (f) => P.f32le(f, 294),
  bytes66to298Zero: (f) => B.deviceInfoTailEmpty(f),
};

// ---------------------------------------------------------------------------------------------
// RS485 vectors
// ---------------------------------------------------------------------------------------------

test('RS485 request vectors equal the encoder output', () => {
  const requests = rs485.filter((v) => v.direction === 'tx');
  assert.ok(requests.length >= 12, `${requests.length} requests`);
  for (const v of requests) {
    const e = v.expected;
    assert.equal(hex(B.encodeBalancerRequest(e.address, e.function, e.value)), v.hex, v.id);
    const parsed = B.parseBalancerRequest(fromHex(v.hex));
    assertClose(parsed, e, v.id);
    assert.ok(parsed.checksumValid && B.isBalancerRequest(fromHex(v.hex)), `${v.id} checksum`);
  }
  assert.equal(hex(B.balancerStatusRequest()), byId('bal-rs485-tx-read-status-addr1').hex);
  assert.equal(hex(B.balancerStatusRequest(15)), byId('bal-rs485-tx-read-status-addr15').hex);
  assert.throws(() => B.encodeBalancerRequest(1, B.BAL_CMD.MAX_CURRENT, 70000), RangeError);
});

test('RS485 status and write answers decode to the documented values', () => {
  const answers = rs485.filter((v) => v.direction === 'rx');
  assert.equal(answers.length, 10);
  for (const v of answers) {
    const frame = fromHex(v.hex);
    assert.equal(frame.length, B.BAL_ANSWER_LENGTH, v.id);
    assert.ok(B.isBalancerAnswer(frame), `${v.id} header and checksum`);
    if (v.expected.function === B.BAL_CMD.STATUS) {
      const st = B.parseBalancerStatus(frame);
      assertClose(st, v.expected, v.id);
      assert.equal(B.balancerStatusProblem(st, { strict: true }), null, `${v.id} plausible`);
      assert.equal(B.describeBalancer(frame)?.name, 'Balancer status (0xFF)');
    } else {
      assertClose(B.parseBalancerWriteAnswer(frame), v.expected, v.id);
      assert.equal(hex(B.encodeBalancerWriteAnswer(v.expected.address, v.expected.function, v.expected.value)), v.hex, `${v.id} encoder`);
      assert.match(B.describeBalancer(frame)?.name ?? '', /^Balancer write answer /);
    }
  }
  // The captured answers re-encode byte for byte (their unused voltage slots are 0, spec 6.5).
  for (const v of answers.filter((x) => x.id.includes('-dz11-'))) {
    assert.equal(hex(B.encodeBalancerStatus(B.parseBalancerStatus(fromHex(v.hex)))), v.hex, `${v.id} round trip`);
  }
  // Temperature: 0.1 degrees C like the captured unit (spec 12 item 4); implausible values are absent.
  const bad = Uint8Array.from(fromHex(byId('bal-rs485-rx-status-dz11-17s-a').hex));
  bad[71] = 0x7f;
  bad[72] = 0xff;
  bad[73] = sum8(bad, 0, 73);
  assert.equal(B.parseBalancerStatus(bad).temperature, null);
  assert.equal(B.describeBalancer(B.balancerStatusRequest())?.name, 'Balancer status request (0xFF)');
  assert.equal(B.describeBalancer(fromHex(byId('bal-rs485-tx-set-trigger-10mv').hex))?.name, 'Balancer write balance trigger voltage (0xF2)');
});

test('RS485 assembler: split answers, adapter echo, junk and a bad checksum', () => {
  const status = fromHex(byId('bal-rs485-rx-status-dz11-20s-a').hex);
  const write = fromHex(byId('bal-rs485-rx-write-answer-balancer-on').hex);
  const corrupt = Uint8Array.from(status);
  corrupt[30] ^= 0x01;
  const stream = concat(B.balancerStatusRequest(), Uint8Array.from([0x00, 0xeb, 0x13]), corrupt, status, write);
  for (const sizes of [[1], [5, 32, 7], [stream.length]]) {
    /** @type {Uint8Array[]} */
    const frames = [];
    const asm = B.createBalancerAssembler({ onFrame: (f) => frames.push(f) });
    for (let o = 0, k = 0; o < stream.length; k++) {
      const n = sizes[k % sizes.length];
      asm.push(stream.subarray(o, o + n));
      o += n;
    }
    assert.deepEqual(
      frames.map((f) => hex(f)),
      [hex(status), hex(write)],
      `chunks ${sizes.join(',')}`,
    );
  }
});

test('RS485 plausibility: the probe is strict, polling keeps a cell sense fault visible', () => {
  const st = B.parseBalancerStatus(fromHex(byId('bal-rs485-rx-status-dz11-17s-a').hex));
  assert.match(B.balancerStatusProblem({ ...st, totalVoltage: st.totalVoltage + 0.5 }, { strict: true }) ?? '', /total voltage/);
  assert.match(B.balancerStatusProblem({ ...st, cellVoltageAverage: 3.4 }, { strict: true }) ?? '', /average/);
  assert.match(B.balancerStatusProblem({ ...st, cellCount: 25 }) ?? '', /cell count/);
  assert.match(B.balancerStatusProblem({ ...st, cellCountDetected: 30 }) ?? '', /detected/);
  assert.match(B.balancerStatusProblem({ ...st, function: 0xf2 }) ?? '', /command/);
  // A cell near 0 V (open sense lead, or more cells configured than wired) passes both checks, so
  // the balancer stays reachable on a new connection to show it and to correct the cell count
  // (spec 11.2 step 2). Total and average follow the cells, as the balancer reports them.
  const openCells = st.cellVoltages.map((/** @type {number} */ v, /** @type {number} */ i) => (i === 3 ? 0 : v));
  const openSum = openCells.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0);
  const open = { ...st, cellVoltages: openCells, totalVoltage: Math.round(openSum * 100) / 100, cellVoltageAverage: Math.round((openSum / openCells.length) * 1000) / 1000 };
  assert.equal(B.balancerStatusProblem(open, { strict: true }), null);
  assert.equal(B.balancerStatusProblem(open), null);
  assert.match(B.balancerStatusProblem({ ...st, cellVoltages: [...st.cellVoltages.slice(0, 16), 6.5] }) ?? '', /above 5 V/);
});

test('RS485 snapshot: balancer fields, signed current, derived flags and alarms', () => {
  const st = B.parseBalancerStatus(fromHex(byId('bal-rs485-rx-status-dz11-17s-a').hex));
  const s = balancerRs485Snapshot(st);
  assert.equal(s.voltage, 56.49);
  assert.equal(s.cells?.length, 17);
  assert.deepEqual(s.balancing, Array(17).fill(false));
  assert.equal(s.balancingActive, false);
  assert.equal(s.balanceCurrent, 0);
  assert.deepEqual(s.temperatures, [{ id: 't1', label: 'Temperature', value: 16.3, kind: 'other' }]);
  assert.deepEqual(s.switches, { balance: true });
  assert.deepEqual(s.alarms, [], 'alarm bit 0 alone is not a cell count alarm (spec 9.2)');
  assert.equal(s.extra?.balancer.value, 'Idle');
  assert.equal(s.extra?.triggerDelta.value, 0.011);
  assert.equal(s.extra?.maxBalanceCurrent.value, 2);
  assert.equal(s.extra?.cellCount.value, 17);
  assert.equal(s.extra?.cellCountDetected.value, 17);
  assert.equal(s.current, undefined);
  assert.equal(s.soc, undefined);

  // Out of the highest cell: negative current, flag on the device's max index (byte 9 = 14).
  const out = balancerRs485Snapshot({ ...st, balanceStatus: 0x02, balanceCurrent: 1.5 });
  assert.equal(out.balanceCurrent, -1.5);
  assert.equal(out.balancingActive, true);
  assert.deepEqual(
    out.balancing?.flatMap((b, i) => (b ? [i] : [])),
    [14],
  );
  assert.equal(out.extra?.balancer.value, 'Discharging balancer');
  const into = balancerRs485Snapshot({ ...st, balanceStatus: 0x01, balanceCurrent: 1.5 });
  assert.equal(into.balanceCurrent, 1.5);
  assert.deepEqual(
    into.balancing?.flatMap((b, i) => (b ? [i] : [])),
    [0],
  );

  // Hand edited bytes, not from the encoder: the 17 cell capture with byte 11 = 02 (out of the
  // highest cell) and bytes 15..16 = 05 DC (1500 mA), sum8 corrected. Every capture has 0 in
  // both fields (spec 6.5), so this pins their offsets against the delta at 13..14.
  const balancingFrame = fromHex(
    'EB9001FF' + '1611' + '0CFB' + '11' + '0E' + '00' + '02' + '01' + '0003' + '05DC' + '000B' + '07D0' + '01' + '11' +
      '0CF90CFB0CFB0CFB0CFB0CFC0CFB0CFB0CFB0CFC0CFB0CFB0CFB0CFB0CFC0CFB0CFB' +
      '00'.repeat(14) +
      '00A3' +
      'BE',
  );
  assert.ok(B.isBalancerAnswer(balancingFrame), 'hand edited answer: length, header and sum8');
  const live = B.parseBalancerStatus(balancingFrame);
  assert.equal(live.balanceStatus, 2);
  assert.equal(live.balanceCurrent, 1.5);
  assert.equal(live.cellVoltageDelta, 0.003);
  assert.equal(live.balanceTriggerVoltage, 0.011);
  assert.equal(live.maxBalanceCurrent, 2);
  const liveSnapshot = balancerRs485Snapshot(live);
  assert.equal(liveSnapshot.balanceCurrent, -1.5);
  assert.equal(liveSnapshot.balancingActive, true);
  assert.deepEqual(
    liveSnapshot.balancing?.flatMap((b, i) => (b ? [i] : [])),
    [14],
  );
  const off = balancerRs485Snapshot({ ...st, balancerSwitch: false });
  assert.equal(off.extra?.balancer.value, 'Off');
  assert.deepEqual(off.switches, { balance: false });

  const alarms = balancerRs485Snapshot({ ...st, cellCountDetected: 16, alarmBitmask: 0x07 }).alarms ?? [];
  assert.deepEqual(
    alarms.map((a) => [a.id, a.severity]),
    [
      ['cell_count_mismatch', 'fault'],
      ['wire_resistance', 'warning'],
      ['pack_overvoltage', 'warning'],
    ],
  );
  // An index outside the cell list falls back to the extremes of the voltages.
  assert.deepEqual(balancingFlags([3.3, 3.35, 3.2], { charging: true, discharging: false, minIndex: 9 }), [false, false, true]);
  assert.deepEqual(balancingFlags([3.3, 3.35, 3.2], { charging: false, discharging: true, maxIndex: -1 }), [false, true, false]);
  assert.deepEqual(balancingFlags([], { charging: true, discharging: true }), []);
});

// ---------------------------------------------------------------------------------------------
// JK04 vectors
// ---------------------------------------------------------------------------------------------

test('JK04 command vectors: app and ESPHome writes equal the jk-ble encoders and the balancer schema', () => {
  const commands = jk04.filter((v) => v.direction === 'tx');
  assert.ok(commands.length >= 35, `${commands.length} commands`);
  const schema = buildJk04BalancerSchema({ maxCurrent: 5 });
  /** @type {Map<number, import('@ubms/bms-core/settings').SettingField>} */
  const byRegister = new Map();
  for (const f of fieldMap(schema).values()) if (f.meta?.write) byRegister.set(f.meta.write.register, f);
  let viaSchema = 0;
  for (const v of commands) {
    const bytes = fromHex(v.hex);
    const e = v.expected;
    const parsed = P.parseCommandFrame(bytes);
    assert.ok(parsed.checksumValid, `${v.id} checksum`);
    assert.equal(parsed.checksum, e.checksum, `${v.id} checksum value`);
    assert.equal(parsed.register, e.register, `${v.id} register`);
    assert.equal(parsed.length, e.length, `${v.id} length`);
    /** @type {Uint8Array} */
    let encoded;
    if (e.length === 0) encoded = P.encodeCommand(e.register);
    else if (e.effectOnJk04 === false) encoded = P.encodeWrite(e.register, e.length, e.value); // a JK02 integer write
    else encoded = P.encodeJk04Write(e.register, e.length, e.value);
    const n = 6 + e.length;
    // The app computes some floats from a pack voltage (calibration): the 6 decimals of the
    // vector do not always give the same float32, so those values are compared as numbers.
    const float = e.length === 4 && e.effectOnJk04 !== false;
    const exact = !float || Math.fround(e.value) === P.f32le(bytes, 6);
    /** @param {Uint8Array} frame @param {string} what */
    const same = (frame, what) => {
      // The app sends random filler after the value (spec 3.1): the command bytes must match.
      if (exact) assert.equal(hex(frame.subarray(0, n)), hex(bytes.subarray(0, n)), what);
      else {
        assert.equal(hex(frame.subarray(0, 6)), hex(bytes.subarray(0, 6)), what);
        assertClose(P.f32le(frame, 6), e.value, what);
        assertClose(P.f32le(bytes, 6), e.value, `${what} captured`);
      }
    };
    same(encoded, v.id);
    if (bytes.subarray(n, 19).every((b) => b === 0)) assert.equal(hex(encoded), v.hex, `${v.id} zero filler`);
    const f = byRegister.get(e.register);
    if (f && e.length > 0 && e.effectOnJk04 !== false) {
      same(bleWriteFrame(f, f.type === 'boolean' ? e.value === 1 : e.value), `${v.id} via ${f.id}`);
      viaSchema++;
    }
  }
  // 32 app writes in the captures: 5 requests and 27 values, every value register is in the schema.
  assert.equal(viaSchema, 27, `${viaSchema} app writes through the schema`);
  // No captured write uses the start voltage register of ESPHome (0x58) or the offset rule (0x5C).
  assert.ok(!commands.some((v) => v.expected.register === 0x58 || v.expected.register === 0x5c));
});

test('JK04 data vectors decode with the jk-ble parsers', () => {
  let checked = 0;
  for (const v of jk04.filter((x) => x.direction === 'rx')) {
    const frame = fromHex(v.hex);
    if (frame.length === P.COMMAND_FRAME_LENGTH) {
      assert.ok(P.isAckFrame(frame), v.id);
      assertClose(P.parseCommandFrame(frame), { register: v.expected.register, length: v.expected.length, rawValue: v.expected.value, checksum: v.expected.checksum }, v.id);
      continue;
    }
    assert.equal(frame.length, P.DATA_FRAME_LENGTH, v.id);
    assert.ok(P.isDataFrame(frame), `${v.id} checksum`);
    /** @type {Record<string, any>} */
    let parsed;
    if (frame[4] === P.FRAME_TYPE.DEVICE_INFO) {
      parsed = P.parseDeviceInfo(frame);
      assert.ok(B.looksLikeJk04BalancerInfo(frame), `${v.id} balancer device info`);
    } else if (frame[4] === P.FRAME_TYPE.SETTINGS) {
      parsed = P.parseJk04Settings(frame);
    } else {
      parsed = P.parseJk04CellInfo(frame);
      assert.ok(P.looksLikeJk04CellInfo(frame), `${v.id} JK04 cell info`);
    }
    for (const [k, e] of Object.entries(v.expected)) {
      if (k === 'cellVoltageAverageDerived' || k === 'cellVoltageDeltaDerived') {
        // Derived values: the vectors use the raw floats, protocol.js rounds the cells to 6
        // decimals first, so the 4th decimal can differ by one.
        const actual = k === 'cellVoltageAverageDerived' ? mean(parsed.cellVoltages) : parsed[k];
        assert.ok(Math.abs(actual - e) <= 1e-4 + 1e-12, `${v.id}.${k}: got ${actual}, expected ${e}`);
        continue;
      }
      assertClose(JK04_RAW[k] ? JK04_RAW[k](frame, parsed) : parsed[k], e, `${v.id}.${k}`);
    }
    checked++;
  }
  assert.equal(checked, 13);
  assert.equal(B.balancerRating('JK-B2A16S'), 2);
  assert.equal(B.balancerRating('JK-B5A24S'), 5);
  assert.equal(B.balancerRating('JK_B1A24S'), 1);
  assert.equal(B.balancerRating('BMS'), undefined);
  assert.ok(B.JK04_BALANCER_MODEL.test('JK-B2A24S'));
  assert.ok(!B.JK04_BALANCER_MODEL.test('JK-B2A24S15P') && !B.JK04_BALANCER_MODEL.test('JK_BD4A24S4P') && !B.JK04_BALANCER_MODEL.test('JK_PB2A16S15P'));
});

test('JK04 balancer snapshot: balancing flags from the action, configuration, no BMS fields', () => {
  const settings = P.parseJk04Settings(fromHex(byId('bal-jk04-rx-settings-b2a16s-power-off-2v7').hex));
  const dis = P.parseJk04CellInfo(fromHex(byId('bal-jk04-rx-cell-info-b2a16s-discharging').hex));
  const s = jk04BalancerSnapshot(dis, { settings });
  assert.equal(s.cells?.length, 16);
  assert.ok(Math.abs(/** @type {number} */ (s.voltage) - 54.324) < 0.002, 'the cell sum (spec 12 item 15)');
  assert.equal(s.balanceCurrent, -2.051);
  assert.equal(s.balancingActive, true);
  assert.deepEqual(
    s.balancing?.flatMap((b, i) => (b ? [i] : [])),
    [dis.cellVoltageMaxIndex],
  );
  assert.ok(Math.abs(/** @type {number} */ (s.cellResistances?.[0]) - 130) < 0.05, 'lead resistance in milliohm');
  assert.equal(s.extra?.balancer.value, 'Discharging balancer');
  assertClose(
    Object.fromEntries(Object.entries(s.extra ?? {}).map(([k, x]) => [k, x.value])),
    { triggerDelta: 0.005, maxBalanceCurrent: 1, startVoltage: 4.25, cellCount: 16 },
    'extra',
  );
  assert.deepEqual(s.switches, { balance: true });
  for (const k of ['current', 'soc', 'temperatures', 'alarms']) assert.equal(/** @type {any} */ (s)[k], undefined, k);

  const chg = P.parseJk04CellInfo(fromHex(byId('bal-jk04-rx-cell-info-b2a16s-charging').hex));
  const c = jk04BalancerSnapshot(chg, { settings });
  assert.ok(/** @type {number} */ (c.balanceCurrent) > 0);
  assert.deepEqual(
    c.balancing?.flatMap((b, i) => (b ? [i] : [])),
    [chg.cellVoltageMinIndex],
  );
  const offSettings = P.parseJk04Settings(fromHex(byId('bal-jk04-rx-settings-b5a24s-balancer-off').hex));
  const off = jk04BalancerSnapshot(P.parseJk04CellInfo(fromHex(byId('bal-jk04-rx-cell-info-b5a24s-balancer-off').hex)), { settings: offSettings });
  assert.equal(off.balancingActive, false);
  assert.ok(off.balancing?.every((b) => !b));
  assert.equal(off.extra?.balancer.value, 'Off');
  assert.deepEqual(off.switches, { balance: false });
  assert.equal(jk04BalancerSnapshot(chg).extra?.balancer.value, 'Charging balancer');
});

test('schemas: confirmed settings writable, start voltage and address read only', () => {
  const s04 = fieldMap(buildJk04BalancerSchema({ maxCurrent: 2 }));
  assert.deepEqual(
    [...s04.values()].filter((f) => !f.readOnly).map((f) => [f.id, f.meta.write.register]),
    [
      ['cell.power_off_voltage', 0x20],
      ['balance.trigger_delta', 0x64],
      ['balance.max_current', 0x68],
      ['switch.balance', 0x6c],
      ['system.cell_count', 0x1c],
      ['jk.voltage_reference', 0x44],
    ],
  );
  const start = /** @type {any} */ (s04.get('balance.start_voltage'));
  assert.equal(start.readOnly, true);
  assert.equal(start.meta.write, undefined, 'the start voltage register is not confirmed (spec 12 item 1)');
  assert.equal(s04.get('balance.max_current')?.max, 2);
  assert.equal(fieldMap(buildJk04BalancerSchema()).get('balance.max_current')?.max, 10);
  assert.equal(s04.get('system.cell_count')?.danger, true);
  assert.ok(validateValue(/** @type {any} */ (s04.get('balance.trigger_delta')), 0.001));

  const s485 = fieldMap(buildJkBalancerRs485Schema());
  assert.deepEqual(
    [...s485.values()].filter((f) => !f.readOnly).map((f) => [f.id, f.meta.write.command]),
    [
      ['balance.trigger_delta', 0xf2],
      ['balance.max_current', 0xf4],
      ['switch.balance', 0xf6],
      ['system.cell_count', 0xf0],
    ],
  );
  assert.equal(s485.get('system.address')?.readOnly, true);
  assert.equal(s485.get('balance.trigger_delta')?.min, 0.002);
  assert.equal(s485.get('balance.trigger_delta')?.max, 1);
  assert.equal(s485.get('balance.max_current')?.min, 0.03);
  assert.equal(s485.get('balance.max_current')?.max, 1, 'vendor range; writes above 1 A are unverified (spec 5.3)');
});

// ---------------------------------------------------------------------------------------------
// Definitions and detection order
// ---------------------------------------------------------------------------------------------

test('definitions: balancer device type, detection order and demo', () => {
  assert.deepEqual(
    jkDrivers.map((d) => d.id),
    ['jk-balancer-ble', 'jk-ble', 'jk-pb-rs485', 'jk-uart', 'jk-balancer-rs485'],
  );
  for (const d of [jkBalancerBleDefinition, jkBalancerRs485Definition]) {
    assert.equal(d.deviceType, 'balancer');
    assert.equal(d.family, 'jk');
    assert.equal(d.vendor, 'JK BMS');
  }
  assert.equal(drivers.find((d) => d.demo)?.id, 'jk-ble', 'the default demo of the app stays the JK BMS');
  assert.match(jkBalancerRs485Definition.demo?.name ?? '', /\(demo\)$/);
  assert.equal(jkBalancerBleDefinition.demo, undefined);
  assert.equal(jkBalancerRs485Definition.links.serial?.profiles[0].baudRate, 9600);
  assert.equal(jkBalancerBleDefinition.links.ble?.profiles[0].service, 0xffe0);

  const registry = new DriverRegistry(drivers);
  assert.equal(registry.bleCandidates({ name: 'BMS' })[0].definition.id, 'jk-balancer-ble');
  // Balancer names are user defined: every name that ranks jk-ble ranks the balancer driver
  // equally, so its probe runs first and jk-ble never takes a balancer as a JK04 BMS.
  for (const name of ['JK-B5A24S', 'JK_B2A8S20P', 'JK-Garage', 'JK_B2A16S balancer']) {
    assert.deepEqual(
      registry
        .bleCandidates({ name })
        .slice(0, 2)
        .map((c) => [c.definition.id, c.score]),
      [
        ['jk-balancer-ble', 10],
        ['jk-ble', 10],
      ],
      name,
    );
  }
  assert.equal(registry.bleCandidates({ name: '506036N46002293-00' })[0].definition.id, 'jk-ble');
  assert.deepEqual(
    registry.serialCandidates({ selection: 'family:jk' }).map((c) => c.definition.id),
    ['jk-pb-rs485', 'jk-uart', 'jk-balancer-rs485'],
  );
  const balancerFilters = registry.bleRequest({ selection: 'jk-balancer-ble' }).request.filters ?? [];
  assert.ok(balancerFilters.some((f) => f.services?.[0] === 0xffe0));
  assert.ok(balancerFilters.some((f) => f.namePrefix === 'JK-'));
  assert.match(jkBalancerBleDefinition.description ?? '', /show all devices/);
});

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

test('session: JK04 balancer over Bluetooth with automatic detection, settings and writes (captured frames)', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 200 });
  const handle = fakeBleHandle(log, { name: 'BMS', attach: b2a16sDevice });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'ble', handle, selection: 'auto' });
  try {
    assert.equal(session.definition?.id, 'jk-balancer-ble');
    assert.equal(session.definition?.deviceType, 'balancer');
    assert.equal(session.variant, 'JK04');
    assert.equal(session.info?.model, 'JK-B2A16S');
    assert.equal(session.info?.powerOnCount, 19);
    assert.equal(session.driver?.capabilities.writeSettings, true);
    await waitFor(() => snapshots.length >= 1);
    const s = snapshots.at(-1);
    assert.equal(s.cells.length, 16);
    assert.equal(s.balancing.filter(Boolean).length, 1);
    assert.equal(s.extra.triggerDelta.value, 0.005);
    assert.equal(s.cellStats.count, 16);
    assert.equal(s.temperatures, undefined);
    assert.equal(s.state, undefined, 'no current, so no charge state');

    const settings = await session.loadSettings();
    assertClose(
      settings.values,
      {
        'balance.trigger_delta': 0.005,
        'balance.max_current': 1,
        'balance.start_voltage': 4.25,
        'cell.power_off_voltage': 2.7,
        'system.cell_count': 16,
        'switch.balance': true,
        'jk.voltage_reference': 3.015481,
      },
      'settings',
    );
    assert.equal(fieldMap(settings.schema).get('balance.max_current')?.max, 2, 'JK-B2A16S rating');

    const results = await session.writeSettings([
      { id: 'balance.trigger_delta', value: 0.008 },
      { id: 'balance.start_voltage', value: 3.5 },
      { id: 'balance.max_current', value: 2.5 },
    ]);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].verified, true, 'read back from the settings frame');
    assert.equal(results[1].ok, false, 'start voltage is read only');
    assert.equal(results[2].ok, false, 'above the rating');
    const sim = handle.sims.at(-1);
    const frames = sim.received.map((/** @type {Uint8Array} */ f) => hex(f));
    // ESPHome test BalanceTrigger8mV (spec 5.2), the zero filler form of the app write.
    assert.ok(frames.includes('AA5590EB6404' + '6F12033C' + '000000000000000000A2'));
    assert.ok(!sim.received.some((/** @type {Uint8Array} */ f) => f[4] === 0x58 || f[4] === 0x5c || f[4] === 0x68));

    const sw = await session.writeSettings([{ id: 'switch.balance', value: false }]);
    assert.equal(sw[0].verified, true);
    assert.ok(frames.length < sim.received.length);
    assert.equal(hex(sim.received.findLast((/** @type {Uint8Array} */ f) => f[4] === 0x6c)), 'AA5590EB6C0100000000000000000000000000E7');
  } finally {
    await session.disconnect();
  }
});

test('session: JK BMSes are left to jk-ble after one device info request', async () => {
  for (const [variant, name] of /** @type {const} */ ([
    ['JK02_32S', 'JK_B2A8S20P'],
    ['JK02_24S', 'Garage'],
  ])) {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 200 });
    const handle = fakeBleHandle(log, { name, attach: (device) => createJkSimulator(device, { variant, streamMs: 200 }) });
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'jk-ble', variant);
      assert.equal(session.variant, variant);
      const first = handle.sims[0];
      assert.ok(first.received.length >= 1 && first.received.every((/** @type {Uint8Array} */ f) => f[4] === P.CMD.DEVICE_INFO), `${variant}: only 0x97 from the balancer probe`);
    } finally {
      await session.disconnect();
    }
  }
});

test('session: a balancer with a user defined JK name is not taken by jk-ble', async () => {
  for (const name of ['JK-Garage', 'JK_B2A16S balancer']) {
    const log = new ProtocolLog();
    const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 200 });
    const handle = fakeBleHandle(log, { name, attach: b2a16sDevice });
    await session.connect({ kind: 'ble', handle, selection: 'auto' });
    try {
      assert.equal(session.definition?.id, 'jk-balancer-ble', name);
      assert.equal(session.definition?.deviceType, 'balancer');
      assert.equal(session.variant, 'JK04');
      const start = fieldMap(/** @type {any} */ (session.driver).getSettingsSchema()).get('balance.start_voltage');
      assert.equal(start?.readOnly, true, `${name}: the start voltage register is not confirmed (spec 12 item 1)`);
    } finally {
      await session.disconnect();
    }
  }
});

test('session: JK balancer over RS485 found after the JK BMS serial protocols, settings and echo check', async () => {
  const log = new ProtocolLog();
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 200, probeTimeoutMs: 600 });
  const port = fakeSerialPort(log, (device) => createJkBalancerRs485Simulator(device, { stepMs: 0, maxCurrentLimitMa: 900 }));
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  await session.connect({ kind: 'serial', handle: port, selection: 'family:jk' });
  try {
    assert.deepEqual(port.baudRates, [115200, 115200, 9600]);
    assert.equal(session.definition?.id, 'jk-balancer-rs485');
    assert.equal(session.definition?.deviceType, 'balancer');
    assert.equal(session.variant, 'JK_BALANCER_RS485');
    assert.equal(session.info?.extra?.address.value, 1);
    const sim = port.sims.at(-1);
    sim.step(1);
    assert.equal(sim.state.action, 2, 'the simulated pack is out of balance');
    const n = snapshots.length;
    await waitFor(() => snapshots.length > n);
    const s = snapshots.at(-1);
    assert.equal(s.cells.length, 16);
    assert.equal(s.balancingActive, true);
    assert.ok(s.balanceCurrent < 0, 'out of the highest cell');
    assert.deepEqual(
      s.balancing.flatMap((/** @type {boolean} */ b, /** @type {number} */ i) => (b ? [i] : [])),
      [sim.state.maxIndex],
    );
    assert.ok(Math.abs(s.temperatures[0].value - 21) < 3);
    assert.deepEqual(s.alarms, []);

    const settings = await session.loadSettings();
    assertClose(
      settings.values,
      { 'balance.trigger_delta': 0.005, 'balance.max_current': 2, 'system.cell_count': 16, 'switch.balance': true, 'system.address': 1 },
      'settings',
    );
    const results = await session.writeSettings([
      { id: 'balance.trigger_delta', value: 0.012 },
      { id: 'balance.max_current', value: 1 },
      { id: 'system.address', value: 2 },
    ]);
    assert.equal(results[0].verified, true);
    assert.equal(sim.state.triggerMv, 12);
    // The simulated unit accepts at most 900 mA: it answers with the old value.
    assert.equal(results[1].ok, false, 'refused: the answer carries the old value');
    assert.match(results[1].error ?? '', /not applied/);
    assert.equal(sim.state.maxCurrentMa, 2000);
    assert.equal(results[2].ok, false, 'no write command for the address');
    // 2 A is read and shown, but writes stay within the vendor range 0.03..1 A (spec 5.3).
    const above = await session.writeSettings([{ id: 'balance.max_current', value: 1.5 }]);
    assert.equal(above[0].ok, false, 'above the vendor range');
    assert.doesNotMatch(above[0].error ?? '', /not applied/);
    const sent = sim.received.map((/** @type {Uint8Array} */ f) => hex(f));
    assert.ok(sent.includes(hex(B.encodeBalancerRequest(1, B.BAL_CMD.TRIGGER, 12))));
    assert.ok(sent.includes(hex(B.encodeBalancerRequest(1, B.BAL_CMD.MAX_CURRENT, 1000))));
    assert.ok(!sent.includes(hex(B.encodeBalancerRequest(1, B.BAL_CMD.MAX_CURRENT, 1500))), 'never sent');
    const current = await session.writeSettings([{ id: 'balance.max_current', value: 0.8 }]);
    assert.equal(current[0].verified, true);
    assert.equal(sim.state.maxCurrentMa, 800);

    const sw = await session.writeSettings([
      { id: 'switch.balance', value: false },
      { id: 'system.cell_count', value: 15 },
    ]);
    assert.ok(
      sw.every((r) => r.verified),
      JSON.stringify(sw),
    );
    assert.equal(sim.state.switchOn, false);
    assert.ok(sim.received.some((/** @type {Uint8Array} */ f) => hex(f) === byId('bal-rs485-tx-balancer-off').hex));
    sim.step(1);
    assert.equal(sim.state.action, 0, 'switched off');
    const m = snapshots.length;
    await waitFor(() => snapshots.length > m);
    const after = snapshots.at(-1);
    assert.equal(after.extra.balancer.value, 'Off');
    assert.deepEqual(
      after.alarms.map((/** @type {any} */ a) => a.id),
      ['cell_count_mismatch'],
    );
    assert.equal(after.cells.length, 15);
  } finally {
    await session.disconnect();
  }
});

test('RS485 driver: configured address on a shared bus, no answer means no device', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 16 });
  await host.open();
  await device.open();
  const one = createJkBalancerRs485Simulator(device, { stepMs: 0, address: 1 });
  const two = createJkBalancerRs485Simulator(device, { stepMs: 0, address: 2, answerDelayMs: 5 });
  const driver = jkBalancerRs485Definition.create({ link: host, log, options: { address: 2 } });
  const d = /** @type {any} */ (driver);
  try {
    const probe = await driver.probe({ timeout: 600 });
    assert.equal(probe?.variant, 'JK_BALANCER_RS485');
    assert.equal(d.status.address, 2);
    assert.equal(one.state.statusAnswers, 0);
    assert.equal(two.state.statusAnswers, 1);
    const far = jkBalancerRs485Definition.create({ link: host, log, options: { address: 7 } });
    const t0 = Date.now();
    assert.equal(await far.probe({ timeout: 600 }), null);
    assert.ok(Date.now() - t0 >= 1900, 'two attempts of at least 1 s (spec 11.2)');
    far.dispose();
    const zero = jkBalancerRs485Definition.create({ link: host, log, options: { address: 0 } });
    assert.equal(/** @type {any} */ (zero).address, 1, 'address 0 falls back to 1');
    zero.dispose();
  } finally {
    driver.dispose();
    one.stop();
    two.stop();
  }
});

test('RS485 driver: more cells configured than wired, the balancer is still found on a new connection', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 16 });
  await host.open();
  await device.open();
  const sim = createJkBalancerRs485Simulator(device, { stepMs: 0, answerDelayMs: 5 });
  const first = jkBalancerRs485Definition.create({ link: host, log, options: {} });
  const again = jkBalancerRs485Definition.create({ link: host, log, options: {} });
  try {
    assert.equal((await first.probe({ timeout: 600 }))?.variant, 'JK_BALANCER_RS485');
    await first.writeSetting('system.cell_count', 17);
    assert.equal(sim.state.cellCount, 17, '16 cells wired');
    first.dispose();
    // Serial links do not reconnect by themselves: the probe of a new connection must accept the
    // 0 V slot, or the cell count could never be corrected (spec 11.2 step 2).
    assert.equal((await again.probe({ timeout: 600 }))?.variant, 'JK_BALANCER_RS485');
    const st = /** @type {any} */ (again).status;
    assert.equal(st.cellVoltages.length, 17);
    assert.equal(st.cellVoltages.at(-1), 0);
    assert.deepEqual(
      (balancerRs485Snapshot(st).alarms ?? []).map((a) => a.id),
      ['cell_count_mismatch'],
    );
    await again.writeSetting('system.cell_count', 16);
    assert.equal(sim.state.cellCount, 16);
  } finally {
    first.dispose();
    again.dispose();
    sim.stop();
  }
});

test('demo: the RS485 balancer simulator connects like the app demo', async () => {
  const log = new ProtocolLog();
  const def = jkBalancerRs485Definition;
  const { host, device } = createLinkPair({ log, name: def.demo?.name, kind: 'demo', latencyMs: 15, deviceChunkSize: def.demo?.chunkSize ?? 0 });
  await device.open();
  const sim = /** @type {any} */ (def.demo?.create(device));
  const session = new BmsSession({ registry: new DriverRegistry(drivers), log, pollIntervalMs: 200 });
  /** @type {any[]} */
  const snapshots = [];
  session.on('snapshot', (s) => snapshots.push(s));
  try {
    await session.connect({ kind: 'link', link: host, selection: def.id });
    assert.equal(session.state, 'connected');
    await waitFor(() => snapshots.length >= 1);
    assert.equal(snapshots[0].cells.length, 16);
    assert.ok(snapshots[0].voltage > 50 && snapshots[0].voltage < 56);
  } finally {
    await session.disconnect();
    sim.stop();
  }
});
