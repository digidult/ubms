import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../i18n-check.mjs');
const LANGS = ['uk', 'ru', 'de', 'fr'];

/**
 * A tree with one app source file and the given catalogs (the same for every language).
 * @param {Record<string, unknown>} catalog
 * @param {Record<string, unknown>} [en]
 */
function tree(catalog, en = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ubms-i18n-'));
  mkdirSync(path.join(dir, 'apps/web/src/locales'), { recursive: true });
  writeFileSync(path.join(dir, 'apps/web/src/app.js'), "t('Hello {name}');\nt('{count} cell(s)', { count });\n");
  writeFileSync(path.join(dir, 'apps/web/src/locales/en.json'), JSON.stringify(en));
  for (const lang of LANGS) writeFileSync(path.join(dir, `apps/web/src/locales/${lang}.json`), JSON.stringify(catalog));
  return dir;
}

/** @param {string} dir @param {string[]} [extra] */
const run = (dir, extra = []) =>
  spawnSync(process.execPath, [script, '--root', dir, ...extra], { encoding: 'utf8', windowsHide: true });

const PLURAL = { one: '{count} cell', other: '{count} cells' };

test('a clean tree passes', () => {
  const dir = tree({ 'Hello {name}': 'Pryvit {name}', '{count} cell(s)': PLURAL }, { '{count} cell(s)': PLURAL });
  try {
    const r = run(dir, ['--strict']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a placeholder error fails the check without --strict', () => {
  const dir = tree({ 'Hello {name}': 'Pryvit {nmae}', '{count} cell(s)': PLURAL }, { '{count} cell(s)': PLURAL });
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /placeholder: Hello \{name\}/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plural key translated as a plain string fails the check', () => {
  const dir = tree({ 'Hello {name}': 'Pryvit {name}', '{count} cell(s)': '{count} x' }, { '{count} cell(s)': PLURAL });
  try {
    assert.equal(run(dir).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plural forms in a translation without English forms fail the check', () => {
  const dir = tree({ 'Hello {name}': 'Pryvit {name}', '{count} cell(s)': PLURAL });
  try {
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /no plural forms in en\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('en.json is checked for placeholders, and for orphaned keys with --strict', () => {
  const broken = tree({ 'Hello {name}': 'Pryvit {name}', '{count} cell(s)': PLURAL }, { '{count} cell(s)': { one: 'a {list}', other: '{count} cells' } });
  const orphan = tree({ 'Hello {name}': 'Pryvit {name}', '{count} cell(s)': PLURAL }, { '{count} cell(s)': PLURAL, '{count} row(s)': PLURAL });
  try {
    assert.equal(run(broken).status, 1);
    assert.equal(run(orphan).status, 0, 'an unused key alone is only reported');
    assert.equal(run(orphan, ['--strict']).status, 1);
  } finally {
    rmSync(broken, { recursive: true, force: true });
    rmSync(orphan, { recursive: true, force: true });
  }
});

test('missing translations fail only with --strict', () => {
  const dir = tree({ 'Hello {name}': 'Pryvit {name}' }, { '{count} cell(s)': PLURAL });
  try {
    assert.equal(run(dir).status, 0);
    assert.equal(run(dir, ['--strict']).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
