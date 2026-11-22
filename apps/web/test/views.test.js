import { test } from 'node:test';
import assert from 'node:assert/strict';
import { i18n } from '@ubms/ui';
import { duration, hoursDuration } from '../src/format.js';
import { entryMatches } from '../src/views/log.js';
import { numberInputMode, parseActionArgument } from '../src/views/settings.js';

test('a duration of zero is shown, not an empty text', () => {
  i18n.setLocale('en');
  for (const v of [0, 0.4]) assert.notEqual(duration(v), '', `duration(${v})`);
  assert.notEqual(hoursDuration(0), '');
  assert.notEqual(duration(65), '');
});

test('the log filter searches bytes only for a hex query, byte by byte', () => {
  const entry = (/** @type {number[]} */ bytes, extra = {}) => ({ id: 1, t: 0, kind: 'rx', bytes: Uint8Array.from(bytes), ...extra });
  const e = entry([0x4e, 0x57, 0x01, 0x13]);
  assert.equal(entryMatches(e, ''), true);
  assert.equal(entryMatches(e, '4E 57'), true);
  assert.equal(entryMatches(e, '4e57'), true);
  assert.equal(entryMatches(e, '0x57, 0x01'), true);
  assert.equal(entryMatches(e, '13'), true);
  assert.equal(entryMatches(e, 'E5'), false, 'across a byte border');
  const words = entry([0x0e, 0xad, 0xfa, 0xe0, 0xce, 0x30]);
  for (const q of ['read', 'frame', 'cell 3', 'cell']) assert.equal(entryMatches(words, q), false, q);
  assert.equal(entryMatches(entry([1], { text: 'read settings' }), 'read'), true);
  assert.equal(entryMatches(entry([1], { name: 'Cell info' }), 'cell'), true);
});

test('an emptied action argument is not a number', () => {
  assert.ok(Number.isNaN(parseActionArgument('')));
  assert.ok(Number.isNaN(parseActionArgument('   ')));
  assert.ok(Number.isNaN(parseActionArgument('abc')));
  assert.equal(parseActionArgument(' 42,5 '), 42.5);
  assert.equal(parseActionArgument('0'), 0);
});

test('a number field that can be negative does not get the decimal keypad', () => {
  assert.equal(numberInputMode(0), 'decimal');
  assert.equal(numberInputMode(1.2), 'decimal');
  assert.equal(numberInputMode(-45), 'text');
  assert.equal(numberInputMode(undefined), 'text');
});
