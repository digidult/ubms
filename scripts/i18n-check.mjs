#!/usr/bin/env node
/**
 * Translation checker.
 *
 * English source strings are the translation keys. This script extracts every literal passed to
 * `t('...')` or `msg('...')`, then compares the result with each locale catalog:
 * missing keys, unused keys, placeholder mismatches and plural shape problems.
 *
 * Two domains are checked separately so the UI kit can move to its own repository:
 * - kit: packages/ui/src            -> packages/ui/locales/<lang>.json
 * - app: apps/web/src, packages/bms-core/src, packages/bms-drivers/src, packages/transport/src
 *                                   -> apps/web/src/locales/<lang>.json
 *
 * Usage:
 *   node scripts/i18n-check.mjs                 report
 *   node scripts/i18n-check.mjs --strict        exit 1 on missing keys or placeholder errors
 *   node scripts/i18n-check.mjs --write-template  write <locales>/_template.json (all keys, English values)
 *   node scripts/i18n-check.mjs --keys app      print the key list of a domain as JSON
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['uk', 'ru', 'de', 'fr'];
const DOMAINS = {
  kit: { sources: ['packages/ui/src'], locales: 'packages/ui/locales' },
  app: {
    sources: ['apps/web/src', 'packages/bms-core/src', 'packages/bms-drivers/src', 'packages/transport/src'],
    locales: 'apps/web/src/locales',
  },
};

const args = process.argv.slice(2);
const strict = args.includes('--strict');

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs)) {
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...walk(path.relative(root, p)));
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const CALL = /\b(?:t|msg)\(\s*(['"])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** @param {string} raw */
function unescape(raw) {
  return raw.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

/** @param {string[]} dirs */
function extract(dirs) {
  /** @type {Map<string, string[]>} */
  const keys = new Map();
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      // Ignore block comments and whole-line comments (JSDoc examples are not UI strings);
      // replacements keep line numbers stable.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\r\n]/g, ' '))
        .replace(/^\s*\/\/.*$/gm, (c) => ' '.repeat(c.length));
      for (const m of text.matchAll(CALL)) {
        const key = unescape(m[2]);
        if (!key.trim()) continue;
        const where = `${path.relative(root, file).replace(/\\/g, '/')}:${text.slice(0, m.index).split('\n').length}`;
        if (!keys.has(key)) keys.set(key, []);
        keys.get(key)?.push(where);
      }
    }
  }
  return keys;
}

/** @param {string} s */
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** @param {string} file */
function loadJson(file) {
  const p = path.join(root, file);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

let problems = 0;
for (const [domain, cfg] of Object.entries(DOMAINS)) {
  const keys = extract(cfg.sources);
  if (args.includes('--keys') && args[args.indexOf('--keys') + 1] === domain) {
    console.log(JSON.stringify([...keys.keys()].sort(), null, 2));
    continue;
  }
  if (args.includes('--write-template')) {
    const tpl = Object.fromEntries([...keys.keys()].sort((a, b) => a.localeCompare(b)).map((k) => [k, k.includes('|') ? k.slice(k.indexOf('|') + 1) : k]));
    writeFileSync(path.join(root, cfg.locales, '_template.json'), JSON.stringify(tpl, null, 2) + '\n');
    console.log(`${domain}: wrote ${cfg.locales}/_template.json (${keys.size} keys)`);
    continue;
  }
  const en = loadJson(`${cfg.locales}/en.json`);
  console.log(`\n== ${domain}: ${keys.size} keys`);
  for (const lang of LANGS) {
    const cat = loadJson(`${cfg.locales}/${lang}.json`);
    const missing = [...keys.keys()].filter((k) => cat[k] === undefined || cat[k] === '');
    const unused = Object.keys(cat).filter((k) => !keys.has(k));
    const badPlaceholders = [];
    const badPlural = [];
    for (const [k, v] of Object.entries(cat)) {
      if (!keys.has(k)) continue;
      const pluralKey = typeof en[k] === 'object';
      if (pluralKey && typeof v !== 'object') badPlural.push(k);
      const values = typeof v === 'object' ? Object.values(v) : [v];
      for (const s of values) {
        if (typeof s !== 'string') continue;
        // Plural forms may omit {count} (for example "one" written as a word), every other placeholder must match.
        const want = placeholders(k.includes('|') ? k.slice(k.indexOf('|') + 1) : k);
        const have = placeholders(s);
        const norm = (x) => x.split(',').filter((p) => p && !(typeof v === 'object' && p === 'count')).join(',');
        if (norm(want) !== norm(have)) badPlaceholders.push(`${k}  =>  ${s}`);
      }
    }
    const pct = keys.size ? Math.round(((keys.size - missing.length) / keys.size) * 100) : 100;
    console.log(`${lang}: ${pct}% translated, ${missing.length} missing, ${unused.length} unused, ${badPlaceholders.length} placeholder errors, ${badPlural.length} plural shape errors`);
    if (args.includes('--verbose')) {
      for (const k of missing) console.log(`   missing: ${k}`);
      for (const k of unused) console.log(`   unused:  ${k}`);
    }
    for (const k of badPlaceholders) console.log(`   placeholder: ${k}`);
    for (const k of badPlural) console.log(`   plural: ${k}`);
    problems += badPlaceholders.length + badPlural.length + (strict ? missing.length : 0);
  }
}
if (strict && problems) {
  console.error(`\n${problems} problem(s)`);
  process.exit(1);
}
