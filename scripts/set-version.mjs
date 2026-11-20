/**
 * Set the app version everywhere it is written down:
 *
 *   node scripts/set-version.mjs 0.1.1
 *
 * Updates the root and workspace package.json files, package-lock.json, the Tauri config and
 * Cargo.toml of the desktop app. Releases are numbered 0.1.x, x growing by one per release
 * (docs/development.md, "Releases"). Without an argument it prints the current version.
 * scripts/test/version.test.js checks that all of these agree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Files with a JSON "version" field, relative to the repository root. */
export const PACKAGE_FILES = [
  'package.json',
  'apps/web/package.json',
  'apps/desktop/package.json',
  'packages/bms-core/package.json',
  'packages/bms-drivers/package.json',
  'packages/transport/package.json',
  'packages/ui/package.json',
];
export const TAURI_CONFIG = 'apps/desktop/src-tauri/tauri.conf.json';
export const CARGO_TOML = 'apps/desktop/src-tauri/Cargo.toml';
export const LOCKFILE = 'package-lock.json';

/** @param {string} rel */
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
/** @param {string} rel @param {string} text */
const write = (rel, text) => writeFileSync(path.join(root, rel), text);

/** Version line of the [package] section of a Cargo.toml. */
const CARGO_VERSION = /^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m;

/** Every place that carries the version, with the value found there. */
export function readVersions() {
  /** @type {Array<{ file: string, version: string | undefined }>} */
  const out = PACKAGE_FILES.map((file) => ({ file, version: JSON.parse(read(file)).version }));
  out.push({ file: TAURI_CONFIG, version: JSON.parse(read(TAURI_CONFIG)).version });
  out.push({ file: CARGO_TOML, version: read(CARGO_TOML).match(CARGO_VERSION)?.[2] });
  const lock = JSON.parse(read(LOCKFILE));
  out.push({ file: `${LOCKFILE} (root)`, version: lock.version });
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '' || key.startsWith('apps/') || key.startsWith('packages/')) {
      out.push({ file: `${LOCKFILE} (${key || 'root package'})`, version: /** @type {any} */ (entry).version });
    }
  }
  return out;
}

/** @param {string} version */
export function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: "${version}" (expected for example 0.1.1)`);
  /** @param {string} rel @param {(json: any) => void} change */
  const editJson = (rel, change) => {
    const text = read(rel);
    const json = JSON.parse(text);
    change(json);
    write(rel, `${JSON.stringify(json, null, 2)}\n`);
  };
  for (const file of PACKAGE_FILES) editJson(file, (j) => (j.version = version));
  editJson(TAURI_CONFIG, (j) => (j.version = version));
  editJson(LOCKFILE, (j) => {
    j.version = version;
    for (const [key, entry] of Object.entries(j.packages ?? {})) {
      if (key === '' || key.startsWith('apps/') || key.startsWith('packages/')) /** @type {any} */ (entry).version = version;
    }
  });
  const cargo = read(CARGO_TOML);
  if (!CARGO_VERSION.test(cargo)) throw new Error(`No [package] version in ${CARGO_TOML}`);
  write(CARGO_TOML, cargo.replace(CARGO_VERSION, `$1${version}$3`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wanted = process.argv[2];
  if (!wanted) {
    for (const { file, version } of readVersions()) console.log(`${version ?? '(none)'}  ${file}`);
  } else {
    setVersion(wanted);
    console.log(`Version set to ${wanted}`);
  }
}
