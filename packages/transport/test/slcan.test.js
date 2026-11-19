import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SLCAN_BITRATES,
  slcanCommand,
  slcanBitrateCommand,
  formatSlcanFrame,
  encodeSlcanFrame,
  parseSlcanLine,
  SlcanDecoder,
  fromHex,
  hex,
} from '../src/index.js';

const text = (/** @type {Uint8Array} */ b) => String.fromCharCode(...b);
const bytes = (/** @type {string} */ s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

test('slcan: commands end with CR, bit rates map to S0..S8', () => {
  assert.equal(text(slcanCommand('O')), 'O\r');
  assert.equal(text(slcanCommand('C')), 'C\r');
  assert.equal(text(slcanBitrateCommand(500000)), 'S6\r');
  assert.equal(text(slcanBitrateCommand(250000)), 'S5\r');
  assert.equal(Object.keys(SLCAN_BITRATES).length, 9);
  assert.throws(() => slcanBitrateCommand(333333), /bit rate/);
  assert.throws(() => slcanCommand('O\r'), /Invalid/);
});

test('slcan: frames are formatted with upper case hex, padded ids and the DLC', () => {
  assert.equal(formatSlcanFrame({ id: 0x351, data: fromHex('48020000FC08E001') }), 't351848020000FC08E001');
  assert.equal(formatSlcanFrame({ id: 0x5, data: [0xab] }), 't0051AB');
  assert.equal(formatSlcanFrame({ id: 0x7ff, data: [] }), 't7FF0');
  assert.equal(formatSlcanFrame({ id: 0x18a2ff80, extended: true, data: [1] }), 'T18A2FF80101');
  assert.equal(formatSlcanFrame({ id: 0x123, remote: true, dlc: 2 }), 'r1232');
  assert.equal(formatSlcanFrame({ id: 0x1fffffff, extended: true, remote: true, dlc: 8 }), 'R1FFFFFFF8');
  assert.equal(text(encodeSlcanFrame({ id: 0x305, data: new Uint8Array(8) })), 't30580000000000000000\r');
});

test('slcan: out of range frames are refused', () => {
  assert.throws(() => formatSlcanFrame({ id: 0x800, data: [] }), /id out of range/);
  assert.throws(() => formatSlcanFrame({ id: 0x20000000, extended: true, data: [] }), /id out of range/);
  assert.throws(() => formatSlcanFrame({ id: -1, data: [] }), /id out of range/);
  assert.throws(() => formatSlcanFrame({ id: 1, data: new Uint8Array(9) }), /length/);
  assert.throws(() => formatSlcanFrame({ id: 1, remote: true, dlc: 9 }), /length/);
  assert.throws(() => formatSlcanFrame({ id: 1, data: [256] }), /0\.\.255/);
});

test('slcan: received lines are parsed into frames and replies', () => {
  const m = parseSlcanLine('t351848020000FC08E001');
  assert.equal(m.type, 'frame');
  if (m.type !== 'frame') return;
  assert.equal(m.frame.id, 0x351);
  assert.equal(m.frame.extended, false);
  assert.equal(m.frame.remote, false);
  assert.equal(m.frame.dlc, 8);
  assert.equal(hex(m.frame.data), '48020000FC08E001');
  assert.equal(m.frame.timestamp, undefined);

  const stamped = parseSlcanLine('t3518E6140000E6000000EA5F');
  assert.equal(stamped.type === 'frame' && stamped.frame.timestamp, 0xea5f);
  const ext = parseSlcanLine('T18A2FF80101');
  assert.deepEqual(ext.type === 'frame' && [ext.frame.id, ext.frame.extended, hex(ext.frame.data)], [0x18a2ff80, true, '01']);
  const lower = parseSlcanLine('t35c8c000000000000000');
  assert.equal(lower.type === 'frame' && lower.frame.id, 0x35c);
  const rtr = parseSlcanLine('r1232');
  assert.deepEqual(rtr.type === 'frame' && [rtr.frame.remote, rtr.frame.dlc, rtr.frame.data.length], [true, 2, 0]);

  assert.deepEqual(parseSlcanLine(''), { type: 'ok' });
  assert.deepEqual(parseSlcanLine('z'), { type: 'sent', extended: false });
  assert.deepEqual(parseSlcanLine('Z'), { type: 'sent', extended: true });
  assert.deepEqual(parseSlcanLine('V1013'), { type: 'version', value: '1013' });
  assert.deepEqual(parseSlcanLine('NA123'), { type: 'serial', value: 'A123' });
  assert.deepEqual(parseSlcanLine('F00'), { type: 'status', value: '00' });

  for (const bad of ['t35', 't3519000000000000000000', 't351800', 't35180000000000000000000', 'tXYZ0', 't8001AB', 'T200000000', 'x', 'S6']) {
    assert.equal(parseSlcanLine(bad).type, 'unknown', bad);
  }
});

test('slcan: the decoder reassembles lines across chunks and reports noise', () => {
  /** @type {import('../src/slcan.js').CanFrame[]} */
  const frames = [];
  /** @type {string[]} */
  const kinds = [];
  /** @type {string[]} */
  const discarded = [];
  const d = new SlcanDecoder({
    onFrame: (f) => frames.push(f),
    onMessage: (m) => kinds.push(m.type),
    onDiscard: (b, reason) => discarded.push(`${reason}:${text(b)}`),
  });
  const stream = bytes('\r\rt351848020000FC08E001\r\nt35580000000000000000\x07T18A2FF80101\rz\r');
  for (let i = 0; i < stream.length; i += 3) d.push(stream.subarray(i, i + 3));
  assert.deepEqual(frames.map((f) => f.id), [0x351, 0x18a2ff80]);
  assert.deepEqual(kinds, ['ok', 'ok', 'frame', 'error', 'frame', 'sent']);
  assert.deepEqual(discarded, ['text before BEL:t35580000000000000000']);

  discarded.length = 0;
  d.push(Uint8Array.of(0xaa, 0x55, 0x01, 0x01, 0x00, 0x00, 0x20, 0x0d, 0x0a));
  d.push(bytes('t2508FA0070FE0000E600\r'));
  assert.equal(discarded.length, 1);
  assert.match(discarded[0], /^invalid line/);
  assert.equal(frames.at(-1)?.id, 0x250);

  // A long stream without terminators is reported in batches, memory stays bounded.
  discarded.length = 0;
  d.push(new Uint8Array(2000).fill(0x41));
  assert.ok(discarded.length >= 7);
  d.push(bytes('\rt1101AB\r'));
  assert.equal(frames.at(-1)?.id, 0x110);

  d.push(bytes('t11'));
  discarded.length = 0;
  d.reset();
  assert.deepEqual(discarded, ['reset:t11']);
});

test('slcan: encode and decode round trip for standard, extended and remote frames', () => {
  /** @type {Array<{ id: number, extended: boolean, remote: boolean, dlc: number }>} */
  const got = [];
  const d = new SlcanDecoder({ onFrame: (f) => got.push({ id: f.id, extended: f.extended, remote: f.remote, dlc: f.dlc }) });
  /** @type {Array<{ id: number, extended: boolean, remote: boolean, dlc: number, data: Uint8Array }>} */
  const sent = [];
  let seed = 7;
  const rnd = (/** @type {number} */ n) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
  for (let i = 0; i < 200; i++) {
    const extended = rnd(2) === 1;
    const remote = rnd(5) === 0;
    const dlc = rnd(9);
    const id = rnd(extended ? 0x20000000 : 0x800);
    const data = remote ? new Uint8Array(0) : Uint8Array.from({ length: dlc }, () => rnd(256));
    sent.push({ id, extended, remote, dlc, data });
    d.push(encodeSlcanFrame({ id, extended, remote, dlc, data }));
  }
  assert.deepEqual(got, sent.map(({ id, extended, remote, dlc }) => ({ id, extended, remote, dlc })));
});

test('slcan: the codec stays free of device specific knowledge', () => {
  const source = readFileSync(new URL('../src/slcan.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(bms|battery|batteries|deye|inverter)\b/i);
  assert.equal(source.includes(String.fromCharCode(0x2014)), false);
});
