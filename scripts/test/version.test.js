import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVersions } from '../set-version.mjs';

test('the version is the same in every package, the lockfile, the Tauri config and Cargo.toml', () => {
  const found = readVersions();
  const root = found[0].version;
  assert.match(String(root), /^\d+\.\d+\.\d+$/);
  const differing = found.filter((f) => f.version !== root).map((f) => `${f.file}: ${f.version}`);
  assert.deepEqual(differing, [], `expected ${root} everywhere (node scripts/set-version.mjs <version>)`);
  assert.ok(found.length >= 10, `${found.length} places checked`);
});
