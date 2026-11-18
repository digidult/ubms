import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EM_DASH = String.fromCharCode(0x2014);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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
    if (!/\.(js|mjs|json|md|html|css|txt|yml|yaml|toml)$/.test(f)) continue;
    let text;
    try {
      text = readFileSync(path.join(root, f), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line.includes(EM_DASH)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `Em dash found in:\n${offenders.join('\n')}`);
});
