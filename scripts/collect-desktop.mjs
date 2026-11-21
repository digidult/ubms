/**
 * Copy the desktop build results into one folder with versioned names, for CI artifacts and
 * releases:
 *
 *   node scripts/collect-desktop.mjs <out dir>
 *
 * Windows: the NSIS setup, the MSI and the portable exe (ubms_<version>_x64_portable.exe, which
 * keeps its data in ubms-data next to itself). Linux: the deb, rpm and AppImage packages. macOS:
 * the universal dmg. Fails when nothing was found, so a broken bundle step cannot go unnoticed.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? 'desktop-out');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const target = path.join(root, 'apps/desktop/src-tauri/target');
const release = path.join(target, 'release');
/** Bundle folders: the host build, and the macOS universal build (--target universal-apple-darwin). */
const bundles = [path.join(release, 'bundle'), path.join(target, 'universal-apple-darwin/release/bundle')];

mkdirSync(out, { recursive: true });
/** @type {string[]} */
const copied = [];

/** @param {string} from @param {string} [name] */
function take(from, name = path.basename(from)) {
  copyFileSync(from, path.join(out, name));
  copied.push(`${name} (${(statSync(from).size / 1048576).toFixed(1)} MB)`);
}

const kinds = { nsis: /\.exe$/i, msi: /\.msi$/i, deb: /\.deb$/i, rpm: /\.rpm$/i, appimage: /\.AppImage$/, dmg: /\.dmg$/i };
for (const bundle of bundles) {
  for (const [dir, pattern] of Object.entries(kinds)) {
    const folder = path.join(bundle, dir);
    if (!existsSync(folder)) continue;
    for (const f of readdirSync(folder)) if (pattern.test(f)) take(path.join(folder, f));
  }
}

const exe = path.join(release, 'ubms-desktop.exe');
if (existsSync(exe)) take(exe, `ubms_${version}_x64_portable.exe`);

if (!copied.length) {
  console.error(`No desktop build results found under ${release}`);
  process.exit(1);
}
console.log(`Collected into ${out}:\n  ${copied.join('\n  ')}`);
