import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hex,
  fromHex,
  concat,
  u16le,
  i16le,
  u32le,
  i32be,
  ascii,
  ByteReader,
  canonicalUuid,
  shortUuid,
  sum8,
  xor8,
  crc16Modbus,
  crc16CcittFalse,
  FrameAssembler,
  ProtocolLog,
  createLinkPair,
  FrameChannel,
  hexdump,
} from '../src/index.js';

test('hex round trip and tolerant parsing', () => {
  const b = fromHex('0x55 aa:EB,90\n01');
  assert.equal(hex(b), '55AAEB9001');
  assert.equal(hex(b, ' '), '55 AA EB 90 01');
  assert.throws(() => fromHex('ABC'));
});

test('integer readers and range checks', () => {
  const b = fromHex('3412FEFF78563412FFFFFFFE');
  assert.equal(u16le(b, 0), 0x1234);
  assert.equal(i16le(b, 2), -2);
  assert.equal(u32le(b, 4), 0x12345678);
  assert.equal(i32be(b, 8), -2);
  assert.throws(() => u32le(b, 10), RangeError);
});

test('ascii stops at NUL and trims', () => {
  const b = Uint8Array.from([0x20, 0x4a, 0x4b, 0x00, 0x41]);
  assert.equal(ascii(b, 0, 5), 'JK');
});

test('ByteReader walks sequentially', () => {
  const r = new ByteReader(fromHex('01 0200 03000000 41 42'));
  assert.equal(r.u8(), 1);
  assert.equal(r.u16le(), 2);
  assert.equal(r.u32le(), 3);
  assert.equal(r.ascii(2), 'AB');
  assert.equal(r.remaining, 0);
});

test('Bluetooth UUID helpers', () => {
  assert.equal(canonicalUuid(0xffe0), '0000ffe0-0000-1000-8000-00805f9b34fb');
  assert.equal(canonicalUuid('FFE1'), '0000ffe1-0000-1000-8000-00805f9b34fb');
  assert.equal(shortUuid('0000fff0-0000-1000-8000-00805f9b34fb'), 'fff0');
});

test('checksums match reference values', () => {
  const ascii9 = new TextEncoder().encode('123456789');
  assert.equal(crc16Modbus(ascii9), 0x4b37);
  assert.equal(crc16CcittFalse(ascii9), 0x29b1);
  assert.equal(sum8([0xff, 0x02]), 0x01);
  assert.equal(xor8([0x0f, 0xf0, 0x01]), 0xfe);
});

function makeAssembler(frames, discards) {
  // Toy protocol: A5 5A <len> payload... <sum8 of all previous bytes>
  return new FrameAssembler({
    sync: [[0xa5, 0x5a]],
    length: (buf) => (buf.length < 3 ? 0 : buf[2] + 4),
    validate: (f) => sum8(f, 0, f.length - 1) === f[f.length - 1],
    onFrame: (f) => frames.push(hex(f)),
    onDiscard: (b, reason) => discards.push([hex(b), reason]),
    staleMs: 0,
  });
}

function toyFrame(payloadHex) {
  const payload = fromHex(payloadHex);
  const head = concat([0xa5, 0x5a, payload.length], payload);
  return concat(head, [sum8(head)]);
}

test('FrameAssembler reassembles chunked and concatenated frames', () => {
  const frames = [];
  const discards = [];
  const a = makeAssembler(frames, discards);
  const f1 = toyFrame('010203');
  const f2 = toyFrame('AABB');
  const stream = concat([0x00, 0x11], f1, f2);
  for (let i = 0; i < stream.length; i += 3) a.push(stream.subarray(i, i + 3));
  assert.deepEqual(frames, [hex(f1), hex(f2)]);
  assert.equal(discards.length, 1);
  assert.equal(discards[0][0], '0011');
});

test('FrameAssembler resyncs after a corrupted frame', () => {
  const frames = [];
  const discards = [];
  const a = makeAssembler(frames, discards);
  const bad = toyFrame('0102030405');
  bad[bad.length - 1] ^= 0xff;
  const good = toyFrame('09');
  // a truncated frame followed immediately by a good one
  a.push(concat(bad.subarray(0, 4), good));
  assert.deepEqual(frames, [hex(good)]);
  a.push(bad);
  assert.deepEqual(frames, [hex(good)]);
  assert.ok(discards.some(([, r]) => r === 'checksum mismatch'));
});

test('FrameAssembler keeps a partial sync at the end of a chunk', () => {
  const frames = [];
  const a = makeAssembler(frames, []);
  const f = toyFrame('7788');
  a.push(concat([0x01, 0x02], f.subarray(0, 1)));
  a.push(f.subarray(1));
  assert.deepEqual(frames, [hex(f)]);
});

test('FrameAssembler drops stale partial frames', () => {
  let t = 0;
  const frames = [];
  const discards = [];
  const a = new FrameAssembler({
    sync: [[0xa5, 0x5a]],
    length: (buf) => (buf.length < 3 ? 0 : buf[2] + 4),
    onFrame: (f) => frames.push(hex(f)),
    onDiscard: (b, r) => discards.push(r),
    staleMs: 100,
    now: () => t,
  });
  a.push(fromHex('A55A05010203'));
  t = 500;
  const f = toyFrame('01');
  a.push(f);
  assert.deepEqual(frames, [hex(f)]);
  assert.ok(discards.includes('stale partial frame'));
});

test('ProtocolLog bounds, decodes lazily and exports', () => {
  const log = new ProtocolLog({ capacity: 10 });
  for (let i = 0; i < 30; i++) log.tx(Uint8Array.of(i), { name: 'cmd' });
  assert.ok(log.size <= 11);
  const e = log.frame(fromHex('0102'), { name: 'Test', decode: () => ({ a: 1 }) });
  assert.deepEqual(ProtocolLog.decoded(e), { a: 1 });
  const json = log.export({ includeDecoded: true });
  const parsed = ProtocolLog.parseExport(JSON.stringify(json));
  const last = parsed.entries.at(-1);
  assert.equal(hex(last.bytes), '0102');
  assert.deepEqual(last.fields, { a: 1 });
  assert.match(ProtocolLog.formatLine(e), /FRAME \[Test\] \(2 B\) 01 02/);
  assert.match(hexdump(fromHex('41424344')), /^0000  41 42 43 44 +ABCD$/);
  assert.equal(hexdump(fromHex('41424344'), 4), '0000  41 42 43 44  ABCD');
});

test('FrameChannel request/response over a memory link with fragmentation', async () => {
  const log = new ProtocolLog();
  const { host, device } = createLinkPair({ log, deviceChunkSize: 2 });
  await host.open();
  await device.open();
  // device echoes a toy frame carrying the first request byte
  device.on('data', (bytes) => device.write(toyFrame(hex(bytes.subarray(0, 1)))));
  const frames = [];
  const discards = [];
  const channel = new FrameChannel(host, {
    createAssembler: ({ onFrame, onDiscard }) =>
      new FrameAssembler({
        sync: [[0xa5, 0x5a]],
        length: (buf) => (buf.length < 3 ? 0 : buf[2] + 4),
        validate: (f) => sum8(f, 0, f.length - 1) === f[f.length - 1],
        onFrame,
        onDiscard,
      }),
    describe: () => ({ name: 'Toy', decode: () => ({}) }),
  }).start();
  channel.on('frame', (f) => frames.push(f));
  const [r1, r2] = await Promise.all([
    channel.request(Uint8Array.of(0x42), { match: (f) => f[3] === 0x42, timeout: 500, name: 'ask 42' }),
    channel.request(Uint8Array.of(0x43), { match: (f) => f[3] === 0x43, timeout: 500, name: 'ask 43' }),
  ]);
  assert.equal(r1[3], 0x42);
  assert.equal(r2[3], 0x43);
  assert.equal(frames.length, 2);
  assert.equal(discards.length, 0);
  await assert.rejects(channel.request(Uint8Array.of(0x01), { match: () => false, timeout: 50 }), /No response/);
  const kinds = new Set(log.entries().map((e) => e.kind));
  assert.ok(kinds.has('tx') && kinds.has('rx') && kinds.has('frame'));
  channel.stop();
  await host.close();
});

test('FrameChannel.requestMany collects multi-frame answers', async () => {
  const { host, device } = createLinkPair();
  await host.open();
  await device.open();
  device.on('data', () => {
    device.write(concat(toyFrame('01'), toyFrame('02'), toyFrame('03')));
  });
  const channel = new FrameChannel(host, {
    createAssembler: ({ onFrame }) =>
      new FrameAssembler({ sync: [[0xa5, 0x5a]], length: (buf) => (buf.length < 3 ? 0 : buf[2] + 4), onFrame }),
  }).start();
  const frames = await channel.requestMany(Uint8Array.of(0), { match: () => true, until: (fs) => fs.length === 3, timeout: 300 });
  assert.deepEqual(frames.map((f) => f[3]), [1, 2, 3]);
  const partial = await channel.requestMany(Uint8Array.of(0), { match: () => true, until: (fs) => fs.length === 5, timeout: 100 });
  assert.equal(partial.length, 3);
  channel.stop();
});
