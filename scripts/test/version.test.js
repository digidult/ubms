import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARGO_TOML, LOCKFILE, PACKAGE_FILES, TAURI_CONFIG, readVersions, setVersion } from '../set-version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('the version is the same in every package, the lockfile, the Tauri config and Cargo.toml', () => {
  const found = readVersions();
  const root = found[0].version;
  assert.match(String(root), /^\d+\.\d+\.\d+$/);
  const differing = found.filter((f) => f.version !== root).map((f) => `${f.file}: ${f.version}`);
  assert.deepEqual(differing, [], `expected ${root} everywhere (node scripts/set-version.mjs <version>)`);
  assert.ok(found.length >= 10, `${found.length} places checked`);
});

test('the internal @ubms dependencies are checked too', () => {
  const found = readVersions().map((f) => f.file);
  assert.ok(found.includes('apps/web/package.json dependencies @ubms/bms-core'), found.join('\n'));
  assert.ok(found.includes(`${LOCKFILE} (packages/bms-drivers) dependencies @ubms/transport`), found.join('\n'));
});

test('set-version moves the versions and the internal @ubms dependencies together', () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'ubms-version-'));
  try {
    for (const rel of [...PACKAGE_FILES, TAURI_CONFIG, CARGO_TOML, LOCKFILE]) {
      cpSync(path.join(root, rel), path.join(copy, rel), { recursive: true });
    }
    setVersion('9.8.7', copy);
    const differing = readVersions(copy).filter((f) => f.version !== '9.8.7').map((f) => `${f.file}: ${f.version}`);
    assert.deepEqual(differing, []);
    const web = JSON.parse(readFileSync(path.join(copy, 'apps/web/package.json'), 'utf8'));
    assert.equal(web.dependencies['@ubms/bms-core'], '9.8.7');
    assert.equal(web.dependencies.lit, JSON.parse(readFileSync(path.join(root, 'apps/web/package.json'), 'utf8')).dependencies.lit);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
