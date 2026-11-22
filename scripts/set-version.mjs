/**
 * Set the app version everywhere it is written down:
 *
 *   node scripts/set-version.mjs 0.1.1
 *
 * Updates the root and workspace package.json files, package-lock.json, the Tauri config and
 * Cargo.toml of the desktop app. The workspace packages depend on each other by exact version,
 * so the `@ubms/*` dependency values are set as well: a stale one no longer matches the
 * workspace package, and npm would then look for it on the public registry. Releases are
 * numbered 0.1.x, x growing by one per release (docs/development.md, "Releases"). Without an
 * argument it prints the current version. scripts/test/version.test.js checks that all of
 * these agree.
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

/** @param {string} base @param {string} rel */
const read = (base, rel) => readFileSync(path.join(base, rel), 'utf8');
/** @param {string} base @param {string} rel @param {string} text */
const write = (base, rel, text) => writeFileSync(path.join(base, rel), text);

/** Version line of the [package] section of a Cargo.toml. */
const CARGO_VERSION = /^(\[package\][^[]*?^version\s*=\s*")([^"]+)(")/m;

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Keys of package-lock.json "packages" that describe a workspace package. @param {string} key */
const isWorkspaceKey = (key) => key === '' || key.startsWith('apps/') || key.startsWith('packages/');

/**
 * The internal (`@ubms/*`) dependencies of a manifest or a lockfile entry.
 * @param {any} json
 * @returns {Array<{ field: string, name: string }>}
 */
function internalDependencies(json) {
  return DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(json?.[field] ?? {})
      .filter((name) => name.startsWith('@ubms/'))
      .map((name) => ({ field, name })),
  );
}

/**
 * Every place that carries the version, with the value found there, including the `@ubms/*`
 * dependency values of the workspace manifests and lockfile entries.
 * @param {string} [base] repository root (a copy in tests)
 */
export function readVersions(base = root) {
  /** @type {Array<{ file: string, version: string | undefined }>} */
  const out = [];
  /** @param {string} file @param {any} json */
  const addPackage = (file, json) => {
    out.push({ file, version: json.version });
    for (const { field, name } of internalDependencies(json)) {
      out.push({ file: `${file} ${field} ${name}`, version: json[field][name] });
    }
  };
  for (const file of PACKAGE_FILES) addPackage(file, JSON.parse(read(base, file)));
  out.push({ file: TAURI_CONFIG, version: JSON.parse(read(base, TAURI_CONFIG)).version });
  out.push({ file: CARGO_TOML, version: read(base, CARGO_TOML).match(CARGO_VERSION)?.[2] });
  const lock = JSON.parse(read(base, LOCKFILE));
  out.push({ file: `${LOCKFILE} (root)`, version: lock.version });
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (isWorkspaceKey(key)) addPackage(`${LOCKFILE} (${key || 'root package'})`, entry);
  }
  return out;
}

/** @param {string} version @param {string} [base] repository root (a copy in tests) */
export function setVersion(version, base = root) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a version: "${version}" (expected for example 0.1.1)`);
  /** @param {string} rel @param {(json: any) => void} change */
  const editJson = (rel, change) => {
    const text = read(base, rel);
    const json = JSON.parse(text);
    change(json);
    write(base, rel, `${JSON.stringify(json, null, 2)}\n`);
  };
  /** @param {any} json */
  const setPackage = (json) => {
    json.version = version;
    for (const { field, name } of internalDependencies(json)) json[field][name] = version;
  };
  for (const file of PACKAGE_FILES) editJson(file, setPackage);
  editJson(TAURI_CONFIG, (j) => (j.version = version));
  editJson(LOCKFILE, (j) => {
    j.version = version;
    for (const [key, entry] of Object.entries(j.packages ?? {})) {
      if (isWorkspaceKey(key)) setPackage(entry);
    }
  });
  const cargo = read(base, CARGO_TOML);
  if (!CARGO_VERSION.test(cargo)) throw new Error(`No [package] version in ${CARGO_TOML}`);
  write(base, CARGO_TOML, cargo.replace(CARGO_VERSION, `$1${version}$3`));
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
