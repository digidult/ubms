import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EM_DASH = String.fromCharCode(0x2014);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Binary formats in the repository; every other file is read as text (Rust, SVG, plist, LICENSE and so on). */
const BINARY = /\.(png|ico|icns|jpe?g|gif|webp|pdf|woff2?|ttf|otf|zip|gz)$/i;

/** Whether a repository path is checked for the em dash. @param {string} file */
const isText = (file) => !BINARY.test(file);

/**
 * House style: the em dash (U+2014) is not used anywhere in this repository, neither in code,
 * comments, docs nor translations. Use commas, colons, parentheses or separate sentences.
 */
test('no em dash in tracked text files', () => {
  let files = [];
  try {
    files = execSync('git ls-files --cached --others --exclude-standard', { cwd: root }).toString().split('\n').filter(Boolean);
  } catch {
    return; // not a git checkout
  }
  const offenders = [];
  for (const f of files) {
    if (!isText(f)) continue;
    let text;
    try {
      text = readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) continue; // a binary file without a known extension
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.includes(EM_DASH)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `Em dash found in:\n${offenders.join('\n')}`);
});

test('the em dash check covers every text file, not only some extensions', () => {
  const text = ['apps/desktop/src-tauri/src/ble.rs', 'apps/desktop/src-tauri/Info.plist', 'apps/web/public/icon.svg', 'apps/web/public/manifest.webmanifest', 'LICENSE', '.editorconfig', '.gitignore'];
  for (const f of text) assert.ok(isText(f), f);
  for (const f of ['apps/web/public/icon.png', 'apps/desktop/src-tauri/icons/icon.ico', 'apps/desktop/src-tauri/icons/icon.icns']) {
    assert.ok(!isText(f), f);
  }
});
