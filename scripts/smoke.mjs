#!/usr/bin/env node
/**
 * Headless smoke test of the built single-file app.
 *
 * Starts a Chromium-based browser in headless mode (no window, separate temporary profile),
 * opens dist/index.html from disk, runs scenarios (connect screen, demo sessions of every driver,
 * all main views, mobile and desktop sizes), collects console errors and uncaught exceptions, and
 * saves screenshots.
 *
 * Usage: node scripts/smoke.mjs [--out .smoke] [--browser <path>] [--only <scenario substring>]
 * Exit code 1 when a page reported errors.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const outDir = path.resolve(root, arg('--out', '.smoke'));
const only = arg('--only', '');
const page = path.join(root, 'dist', 'index.html');
if (!existsSync(page)) {
  console.error('dist/index.html not found, run "npm run build" first');
  process.exit(2);
}

const candidates = [
  arg('--browser'),
  process.env.UBMS_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('No Chromium-based browser found. Pass --browser <path> or set UBMS_BROWSER.');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(tmpdir(), 'ubms-smoke-'));

// Headless only: never start a visible browser window.
const browser = spawn(
  exe,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--mute-audio',
    '--lang=en-US',
    '--accept-lang=en-US,en',
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--allow-file-access-from-files',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
);

browser.stderr.resume();
browser.on('error', () => {});

// The launcher process may hand over to a child and exit, so read the port from the profile.
const port = await (async () => {
  const file = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(file)) {
      const [p] = readFileSync(file, 'utf8').split('\n');
      if (p && Number(p) > 0) return Number(p);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Browser did not start (no DevToolsActivePort)');
})();

/** Close the whole headless browser through CDP (works even when the launcher already exited). */
async function closeBrowser() {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    /* fall back to killing the spawned process */
  }
  browser.kill();
}

/** Minimal CDP client for one page target. */
async function openPage() {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  return {
    send,
    on: (fn) => listeners.add(fn),
    close: async () => {
      ws.close();
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const baseUrl = pathToFileURL(page).href;

/**
 * @param {string} name
 * @param {{ hash: string, width: number, height: number, mobile: boolean, wait?: number, steps?: Array<{ hash?: string, eval?: string, wait?: number, shot?: string }>, dark?: boolean }} sc
 */
async function scenario(name, sc) {
  const p = await openPage();
  const errors = [];
  p.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'assert')) {
      errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url ?? '')) errors.push(m.params.entry.text);
  });
  await p.send('Runtime.enable');
  await p.send('Log.enable');
  await p.send('Page.enable');
  await p.send('Emulation.setDeviceMetricsOverride', { width: sc.width, height: sc.height, deviceScaleFactor: 1, mobile: sc.mobile });
  if (sc.dark) await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await p.send('Page.navigate', { url: `${baseUrl}#${sc.hash}` });
  await sleep(sc.wait ?? 1500);
  const shots = [];
  for (const step of sc.steps ?? [{ shot: name }]) {
    if (step.eval) {
      const r = await p.send('Runtime.evaluate', { expression: step.eval, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) errors.push(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      else if (r.result?.value === false) errors.push(`check failed: ${step.eval.slice(0, 120)}`);
    }
    if (step.hash) {
      await p.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(step.hash)}` });
    }
    await sleep(step.wait ?? 700);
    if (step.shot) {
      const { data } = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(outDir, `${step.shot}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      shots.push(path.relative(root, file));
    }
  }
  await p.close();
  return { name, errors, shots };
}

// mobile:false keeps screenshots stable in headless mode; layout depends only on the width.
const phone = { width: 390, height: 844, mobile: false };
const desktop = { width: 1366, height: 860, mobile: false };

/** Text that must appear somewhere in the app (walks shadow roots). */
const hasText = (s) =>
  `(() => { const walk = (n) => { if (n.shadowRoot && walk(n.shadowRoot)) return true; for (const c of n.children ?? []) if (walk(c)) return true; return (n.textContent ?? '').includes(${JSON.stringify(s)}); }; return walk(document.querySelector('ubms-app')); })()`;

/** Write one plain number setting through the app controller, check the read-back, restore it. */
const writeCheck = `(async () => {
  const c = window.ubms;
  const s = c.session;
  if (!s.driver?.capabilities.writeSettings) return true;
  const schema = s.driver.getSettingsSchema();
  const values = s.settings.values ?? {};
  for (const g of schema.groups) for (const f of g.fields) {
    if (f.type !== 'number' || f.readOnly || f.danger || f.advanced || f.validate) continue;
    const v = values[f.id];
    if (typeof v !== 'number') continue;
    const step = f.step ?? 1;
    let nv = Math.round((v + step) / step) * step;
    if (f.max !== undefined && nv > f.max) nv = Math.round((v - step) / step) * step;
    const res = await c.writeSettings([{ id: f.id, value: nv }], { quiet: true });
    const ok = res[0]?.ok && res[0]?.verified !== false;
    await c.writeSettings([{ id: f.id, value: v }], { quiet: true });
    if (!ok) console.error('write check failed for ' + f.id + ': ' + JSON.stringify(res[0]));
    return !!ok;
  }
  return true;
})()`;

/** A rich synthetic snapshot rendered without any driver, to check layouts of every widget. */
const fixture = `(() => {
  const c = window.ubms;
  const cells = Array.from({ length: 16 }, (_, i) => 3.30 + Math.sin(i) * 0.012 + (i === 6 ? 0.025 : 0));
  const snap = {
    timestamp: Date.now(), voltage: 52.95, current: -23.4, power: -1239.0, soc: 64, soh: 98,
    capacityRemaining: 179.2, capacityFull: 280, capacityNominal: 280, cycles: 112, cycleCapacity: 31360,
    uptime: 912345, cells, cellResistances: cells.map((_, i) => 0.9 + (i % 4) * 0.12),
    balancing: cells.map((_, i) => i === 6), balancingActive: true, balanceCurrent: 0.42,
    temperatures: [
      { id: 'mos', label: 'MOSFET', value: 31.5, kind: 'mos' },
      { id: 't1', label: 'Sensor 1', value: 24.1, kind: 'cell' },
      { id: 't2', label: 'Sensor 2', value: 47.9, kind: 'cell' },
    ],
    switches: { charge: true, discharge: true, balance: true, heater: false },
    alarms: [
      { id: 'cell_voltage_difference', label: 'Cell voltage difference too high', severity: 'warning', source: 'bit 2' },
      { id: 'charge_overtemperature', label: 'Charge overtemperature', severity: 'protection' },
    ],
    extra: { state: { label: 'System state', value: 'Discharging' }, rt: { label: 'Remaining time', value: 7.6, unit: 'h', decimals: 1 } },
    cellStats: { count: 16, min: Math.min(...cells), max: Math.max(...cells), avg: cells.reduce((a, b) => a + b) / 16, delta: Math.max(...cells) - Math.min(...cells), sum: cells.reduce((a, b) => a + b), minIndex: cells.indexOf(Math.min(...cells)), maxIndex: cells.indexOf(Math.max(...cells)) },
    state: 'discharging', timeToEmpty: 7.66,
  };
  c.session.lastDataAt = Date.now() + 3600e3;
  c.store.set({ state: 'connected', snapshot: snap, device: { driverId: 'fixture', vendor: 'Fixture BMS', protocol: 'Fixture protocol', deviceName: 'FIX-16S', linkKind: 'demo', deviceType: 'bms' } });
  return true;
})()`;

const scenarios = [
  ['connect-phone', { ...phone, hash: '/connect', steps: [{ eval: hasText('ubms'), shot: 'connect-phone' }] }],
  ['connect-desktop-dark', { ...desktop, dark: true, hash: '/connect', steps: [{ shot: 'connect-desktop-dark' }] }],
  ['prefs-phone', { ...phone, hash: '/prefs', steps: [{ shot: 'prefs-phone' }] }],
  [
    'fixture-phone',
    { ...phone, hash: '/connect', steps: [{ eval: fixture, hash: '/overview', shot: 'fixture-overview-phone' }, { hash: '/cells', shot: 'fixture-cells-phone' }] },
  ],
  [
    'i18n-uk-phone',
    {
      ...phone,
      hash: '/connect',
      steps: [
        { eval: `(window.ubms.setPref('lang', 'uk'), true)`, shot: 'i18n-uk-connect-phone' },
        { eval: fixture, hash: '/overview', shot: 'i18n-uk-overview-phone' },
        { eval: `(window.ubms.setPref('lang', 'en'), true)` },
      ],
    },
  ],
  [
    'fixture-desktop',
    { ...desktop, hash: '/connect', steps: [{ eval: fixture, hash: '/overview', shot: 'fixture-overview-desktop' }, { hash: '/cells', shot: 'fixture-cells-desktop' }] },
  ],
];

// Demo sessions for every driver that ships a simulator.
const demoIds = await (async () => {
  const p = await openPage();
  await p.send('Runtime.enable');
  await p.send('Page.navigate', { url: `${baseUrl}#/connect` });
  await sleep(1200);
  const r = await p.send('Runtime.evaluate', { expression: 'window.ubms.registry.list().filter((d) => d.demo).map((d) => d.id)', returnByValue: true });
  await p.close();
  return r.result?.value ?? [];
})();

for (const id of demoIds) {
  scenarios.push([
    `demo-${id}-phone`,
    {
      ...phone,
      hash: `/connect?demo=${id}`,
      wait: 3500,
      steps: [
        { eval: `window.ubms.state.state === 'connected'`, shot: `demo-${id}-overview-phone` },
        { hash: '/cells', shot: `demo-${id}-cells-phone` },
        { hash: '/settings', wait: 2500, shot: `demo-${id}-settings-phone` },
        { eval: `window.ubms.state.settings.values !== null` },
        { eval: writeCheck, wait: 300 },
        { hash: `/settings/${'cell_voltage'}`, shot: `demo-${id}-settings-group-phone` },
        { hash: '/settings/controls', shot: `demo-${id}-settings-controls-phone` },
        { hash: '/settings/actions', shot: `demo-${id}-settings-actions-phone` },
        { hash: '/info', shot: `demo-${id}-info-phone` },
        { hash: '/log', shot: `demo-${id}-log-phone` },
      ],
    },
  ]);
  scenarios.push([
    `demo-${id}-desktop`,
    {
      ...desktop,
      hash: `/connect?demo=${id}`,
      wait: 3500,
      steps: [{ shot: `demo-${id}-overview-desktop` }, { hash: '/settings', wait: 2500, shot: `demo-${id}-settings-desktop` }],
    },
  ]);
}

let failed = 0;
try {
  for (const [name, sc] of scenarios) {
    if (only && !name.includes(only)) continue;
    const r = await scenario(name, sc);
    const status = r.errors.length ? 'FAIL' : 'ok';
    if (r.errors.length) failed++;
    console.log(`${status.padEnd(4)} ${name}  ${r.shots.join(', ')}`);
    for (const e of r.errors) console.log(`     ${String(e).split('\n')[0]}`);
  }
} finally {
  await closeBrowser();
  await sleep(500);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* the browser may still hold a lock for a moment */
  }
}
console.log(failed ? `${failed} scenario(s) with errors` : 'All scenarios passed');
process.exit(failed ? 1 : 0);
