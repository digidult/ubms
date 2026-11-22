import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_ERRORS } from '../../packages/transport/src/tauri.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rust = ['ble.rs', 'serial.rs'].map((f) => readFileSync(path.join(root, 'apps/desktop/src-tauri/src', f), 'utf8')).join('\n');

/**
 * The desktop bridge reports its errors as English strings, and tauri.js lists them so the
 * translation checker extracts them. Both lists must change together.
 */
test('every BRIDGE_ERRORS text is a string literal of the Rust bridge', () => {
  for (const text of BRIDGE_ERRORS) assert.ok(rust.includes(JSON.stringify(text)), `"${text}" not found in ble.rs or serial.rs`);
});
