import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drivers } from '../../packages/bms-drivers/src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (/** @type {string} */ rel) => readFileSync(path.join(root, rel), 'utf8');

/** Driver ids in the first column of a Markdown table, in the order of the rows. @param {string} text */
const tableIds = (text) => [...text.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);

test('the driver table of docs/protocols/README.md follows the detection (registration) order', () => {
  assert.deepEqual(tableIds(read('docs/protocols/README.md')), drivers.map((d) => d.id));
});

test('README.md lists every driver and names the ones without a simulator', () => {
  const readme = read('README.md');
  assert.deepEqual([...tableIds(readme)].sort(), drivers.map((d) => d.id).sort());
  const sentence = readme.match(/Most drivers ship a simulator[^]*?\)\./)?.[0] ?? '';
  const named = [...sentence.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(named, drivers.filter((d) => !d.demo).map((d) => d.id).sort());
});
