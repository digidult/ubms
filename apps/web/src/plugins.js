import {
  BaseDriver,
  msg,
  field,
  buildSchema,
  relation,
  fieldMap,
  alarm,
  cellStats,
  SETTINGS,
  SETTING_GROUPS,
  ALARMS,
} from '@ubms/bms-core';
import {
  FrameAssembler,
  FrameChannel,
  fixedLengthAssembler,
  toBytes,
  hex,
  fromHex,
  concat,
  equals,
  startsWith,
  indexOf,
  u8,
  i8,
  u16le,
  u16be,
  i16le,
  i16be,
  u32le,
  u32be,
  i32le,
  i32be,
  ascii,
  asciiBytes,
  setU16le,
  setU16be,
  setU32le,
  setU32be,
  ByteReader,
  sum8,
  sum16,
  xor8,
  crc16Modbus,
  crc16CcittFalse,
  canonicalUuid,
  shortUuid,
  sleep,
  withTimeout,
} from '@ubms/transport';
import { SimBattery } from '@ubms/bms-drivers';

/**
 * Desktop plugins (docs/plugins.md): one ES module per `.js` file in a `plugins` folder next to
 * the app. The Rust side (`plugins_list`, apps/desktop/src-tauri/src/plugins.rs) reads the files;
 * this module evaluates them, calls `register(api)`, checks every driver definition and registers
 * the valid ones after the built-in drivers. A failing plugin is reported and never stops the
 * app. Everything except `importFromBlob` and `loadDesktopPlugins` runs in Node too, so the tests
 * use the same path as the app.
 *
 * @typedef {import('@ubms/bms-drivers').DriverDefinitionWithDemo} DriverDefinitionWithDemo
 *
 * @typedef {Object} PluginFile
 * @property {string} file file name
 * @property {string} source module text
 *
 * @typedef {Object} PluginListing result of `plugins_list`
 * @property {string[]} dirs folders that are read (also missing ones)
 * @property {PluginFile[]} plugins
 * @property {Array<{ file: string, error: string }>} errors files the bridge did not read
 *
 * @typedef {Object} LoadedPlugin
 * @property {string} file
 * @property {string} name from register(), else the file name without `.js`
 * @property {string} version from register(), may be empty
 * @property {string[]} drivers ids of the registered drivers
 *
 * @typedef {Object} PluginFailure
 * @property {string} file file name, the folder path, or '' when the list could not be read
 * @property {string} message English text (msg() literal or a text of the bridge or the plugin)
 * @property {Record<string, any>} params placeholder values of `message`
 *
 * @typedef {Object} PluginReport
 * @property {string[]} dirs
 * @property {LoadedPlugin[]} plugins
 * @property {PluginFailure[]} failures
 */

/** Version of the object passed to `register(api)`; raised when it changes incompatibly. */
export const PLUGIN_API_VERSION = 1;

/** Longest wait for the plugin list, and for one plugin to load and register. */
export const PLUGIN_TIMEOUT_MS = 3000;

/** Source tag of plugin entries in the protocol log. */
const LOG_SOURCE = 'plugins';

/** Texts of the Rust bridge (plugins.rs), listed here so they are translated. */
export const BRIDGE_ERRORS = [
  msg('The file is larger than 1 MiB'),
  msg('The file is not valid UTF-8 text'),
  msg('A plugin with this file name was already read from an earlier folder'),
];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Selection value of the type selector (registry.js select()) that a driver id must not take. */
const RESERVED_IDS = new Set(['auto']);
const DEVICE_TYPES = ['bms', 'balancer', 'meter'];
const WRITE_MODES = ['auto', 'with-response', 'without-response', 'prefer-without-response'];
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The object every plugin receives in `register(api)`. Frozen, so a plugin cannot change what
 * other plugins get. See docs/plugins.md for the meaning of each entry.
 * @param {{ appVersion: string }} opts
 */
export function createPluginApi({ appVersion }) {
  return Object.freeze({
    version: PLUGIN_API_VERSION,
    core: Object.freeze({ BaseDriver, msg, field, buildSchema, relation, fieldMap, alarm, cellStats, SETTINGS, SETTING_GROUPS, ALARMS }),
    transport: Object.freeze({
      FrameAssembler,
      FrameChannel,
      fixedLengthAssembler,
      toBytes,
      hex,
      fromHex,
      concat,
      equals,
      startsWith,
      indexOf,
      u8,
      i8,
      u16le,
      u16be,
      i16le,
      i16be,
      u32le,
      u32be,
      i32le,
      i32be,
      ascii,
      asciiBytes,
      setU16le,
      setU16be,
      setU32le,
      setU32be,
      ByteReader,
      sum8,
      sum16,
      xor8,
      crc16Modbus,
      crc16CcittFalse,
      canonicalUuid,
      shortUuid,
      sleep,
      withTimeout,
    }),
    drivers: Object.freeze({ SimBattery }),
    app: Object.freeze({ version: appVersion }),
  });
}

/** An English message with placeholder values, thrown or returned by the checks below. */
export class PluginProblem extends Error {
  /** @param {string} message @param {Record<string, any>} [params] */
  constructor(message, params = {}) {
    super(message);
    this.params = params;
  }
}

/** @param {string} message @param {Record<string, any>} [params] */
const problem = (message, params = {}) => new PluginProblem(message, params);

/** English text with placeholders filled, for the protocol log. @param {string} text @param {Record<string, any>} params */
function fill(text, params) {
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** @param {unknown} err */
const errorText = (err) => (err instanceof Error ? err.message : String(err));

/** @param {any} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {any} v */
const isText = (v) => typeof v === 'string' && v.trim() !== '';
/** @param {any} v @param {number} min @param {number} max */
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
/** A 16 or 32 bit number, a short hex text ("ffe0") or a full UUID. @param {any} v */
const isUuid = (v) => isInt(v, 0, 0xffffffff) || (typeof v === 'string' && FULL_UUID.test(canonicalUuid(v)));
/** Undefined or an array whose every element passes. @param {any} v @param {(x: any) => boolean} each */
const isListOf = (v, each) => v === undefined || (Array.isArray(v) && v.every(each));

/**
 * @param {string} id
 * @param {string} name field path, for example 'links.ble.profiles[0].service'
 */
const invalid = (id, name) => problem(msg('Driver {id}: {field} is not valid'), { id, field: name });

/** @param {string} id @param {any} ble */
function bleProblem(id, ble) {
  if (!isObject(ble)) return invalid(id, 'links.ble');
  if (!Array.isArray(ble.profiles) || !ble.profiles.length) return invalid(id, 'links.ble.profiles');
  for (const [i, p] of ble.profiles.entries()) {
    const at = `links.ble.profiles[${i}]`;
    if (!isObject(p)) return invalid(id, at);
    if (!isText(p.id)) return invalid(id, `${at}.id`);
    for (const key of ['service', 'notify', 'write']) if (!isUuid(p[key])) return invalid(id, `${at}.${key}`);
    if (p.label !== undefined && typeof p.label !== 'string') return invalid(id, `${at}.label`);
    if (p.writeMode !== undefined && !WRITE_MODES.includes(p.writeMode)) return invalid(id, `${at}.writeMode`);
    if (p.chunkSize !== undefined && !isInt(p.chunkSize, 1, 512)) return invalid(id, `${at}.chunkSize`);
    if (p.chunkDelayMs !== undefined && !isInt(p.chunkDelayMs, 0, 10000)) return invalid(id, `${at}.chunkDelayMs`);
  }
  /** @type {Record<string, (x: any) => boolean>} */
  const lists = {
    namePrefixes: (x) => typeof x === 'string' && x !== '',
    namePatterns: (x) => x instanceof RegExp,
    advertisedServices: isUuid,
    manufacturerIds: (x) => isInt(x, 0, 0xffff),
    optionalServices: isUuid,
  };
  for (const [key, each] of Object.entries(lists)) if (!isListOf(ble[key], each)) return invalid(id, `links.ble.${key}`);
  return null;
}

/** @param {string} id @param {any} serial */
function serialProblem(id, serial) {
  if (!isObject(serial)) return invalid(id, 'links.serial');
  if (!Array.isArray(serial.profiles) || !serial.profiles.length) return invalid(id, 'links.serial.profiles');
  for (const [i, p] of serial.profiles.entries()) {
    const at = `links.serial.profiles[${i}]`;
    if (!isObject(p)) return invalid(id, at);
    if (!isText(p.id)) return invalid(id, `${at}.id`);
    if (p.label !== undefined && typeof p.label !== 'string') return invalid(id, `${at}.label`);
    if (!isInt(p.baudRate, 1, 10_000_000)) return invalid(id, `${at}.baudRate`);
    if (p.dataBits !== undefined && p.dataBits !== 7 && p.dataBits !== 8) return invalid(id, `${at}.dataBits`);
    if (p.stopBits !== undefined && p.stopBits !== 1 && p.stopBits !== 2) return invalid(id, `${at}.stopBits`);
    if (p.parity !== undefined && !['none', 'even', 'odd'].includes(p.parity)) return invalid(id, `${at}.parity`);
    if (p.flowControl !== undefined && !['none', 'hardware'].includes(p.flowControl)) return invalid(id, `${at}.flowControl`);
    if (p.bufferSize !== undefined && !isInt(p.bufferSize, 1, 16 * 1024 * 1024)) return invalid(id, `${at}.bufferSize`);
    if (p.signals !== undefined && !isObject(p.signals)) return invalid(id, `${at}.signals`);
  }
  if (serial.note !== undefined && typeof serial.note !== 'string') return invalid(id, 'links.serial.note');
  if (serial.autoDetect !== undefined && typeof serial.autoDetect !== 'boolean') return invalid(id, 'links.serial.autoDetect');
  return null;
}

/** @param {string} id @param {any} demo */
function demoProblem(id, demo) {
  if (!isObject(demo)) return invalid(id, 'demo');
  if (!isText(demo.name)) return invalid(id, 'demo.name');
  if (typeof demo.create !== 'function') return problem(msg('Driver {id}: {field} must be a function'), { id, field: 'demo.create' });
  if (demo.chunkSize !== undefined && !isInt(demo.chunkSize, 0, 65536)) return invalid(id, 'demo.chunkSize');
  return null;
}

/**
 * Check one driver definition against the contract of packages/bms-core/src/driver.js.
 * @param {any} def
 * @param {Map<string, string>} [taken] ids in use: '' for a built-in driver, else the plugin file
 * @param {Set<string>} [families] family ids in use: a driver with such an id would take over the
 *   selection of the whole family by its bare id (registry.js select())
 * @returns {PluginProblem | null}
 */
export function validateDefinition(def, taken = new Map(), families = new Set()) {
  if (!isObject(def)) return problem(msg('A driver definition is not an object'));
  const id = def.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return problem(msg('Invalid driver id {id}: use 1 to 64 letters, digits, dots, dashes or underscores'), { id: String(id) });
  }
  if (RESERVED_IDS.has(id.toLowerCase())) return problem(msg('The driver id {id} is reserved'), { id });
  if (taken.has(id)) {
    const owner = taken.get(id);
    return owner ? problem(msg('The driver id {id} is already used by {file}'), { id, file: owner }) : problem(msg('The driver id {id} is already used by a built-in driver'), { id });
  }
  if (families.has(id)) return problem(msg('The driver id {id} is already the id of a device family'), { id });
  for (const key of ['family', 'vendor', 'protocol']) {
    if (!isText(def[key])) return problem(msg('Driver {id}: {field} must be a non-empty string'), { id, field: key });
  }
  if (!ID_PATTERN.test(def.family)) return invalid(id, 'family');
  if (!DEVICE_TYPES.includes(def.deviceType)) return problem(msg('Driver {id}: deviceType must be bms, balancer or meter'), { id });
  if (def.description !== undefined && typeof def.description !== 'string') return invalid(id, 'description');
  if (def.experimental !== undefined && typeof def.experimental !== 'boolean') return invalid(id, 'experimental');
  if (typeof def.create !== 'function') return problem(msg('Driver {id}: {field} must be a function'), { id, field: 'create' });
  const links = def.links;
  if (!isObject(links) || (links.ble === undefined && links.serial === undefined)) return problem(msg('Driver {id}: links needs ble or serial'), { id });
  return (
    (links.ble !== undefined ? bleProblem(id, links.ble) : null) ??
    (links.serial !== undefined ? serialProblem(id, links.serial) : null) ??
    (def.demo !== undefined ? demoProblem(id, def.demo) : null)
  );
}

/**
 * Name, version and definitions from the value `register(api)` returned.
 * @param {any} result
 * @param {string} file
 */
export function readRegistration(result, file) {
  const r = Array.isArray(result) ? { drivers: result } : result;
  if (!isObject(r) || !Array.isArray(r.drivers)) throw problem(msg('register(api) must return { drivers: [...] } or an array of driver definitions'));
  return {
    name: isText(r.name) ? r.name.trim() : file.replace(/\.js$/i, ''),
    version: isText(r.version) ? r.version.trim() : '',
    /** @type {any[]} */
    definitions: r.drivers,
  };
}

/**
 * Evaluate a module text in the page: a Blob URL and a dynamic import. The comment names the file
 * in stack traces and the developer tools.
 * @param {string} source
 * @param {string} file
 */
export async function importFromBlob(source, file) {
  const name = file.replace(/[^\w.-]/g, '_');
  const url = URL.createObjectURL(new Blob([`${source}\n//# sourceURL=ubms-plugins/${name}\n`], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Import one plugin and call its `register(api)`.
 * @param {PluginFile} entry
 * @param {ReturnType<typeof createPluginApi>} api
 * @param {(source: string, file: string) => Promise<any>} importModule
 */
async function evaluate(entry, api, importModule) {
  let mod;
  try {
    mod = await importModule(entry.source, entry.file);
  } catch (err) {
    throw problem(msg('The plugin could not be loaded: {error}'), { error: errorText(err) });
  }
  const register = mod?.default;
  if (typeof register !== 'function') throw problem(msg('The plugin has no default export register(api)'));
  let result;
  try {
    result = await register(api);
  } catch (err) {
    throw problem(msg('register(api) failed: {error}'), { error: errorText(err) });
  }
  return readRegistration(result, entry.file);
}

/**
 * Load every plugin of a listing: import them all at once (each within `timeoutMs`), then check
 * and register their drivers in file order, after the drivers already in the registry. Never
 * throws; everything that goes wrong ends up in `failures` and in the protocol log.
 * @param {Object} opts
 * @param {() => Promise<PluginListing>} opts.list the bridge's `plugins_list`
 * @param {import('@ubms/bms-core').DriverRegistry} opts.registry
 * @param {import('@ubms/transport').ProtocolLog} [opts.log]
 * @param {ReturnType<typeof createPluginApi>} opts.api
 * @param {(source: string, file: string) => Promise<any>} [opts.importModule]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<PluginReport>}
 */
export async function loadPlugins({ list, registry, log, api, importModule = importFromBlob, timeoutMs = PLUGIN_TIMEOUT_MS }) {
  /** @type {PluginReport} */
  const report = { dirs: [], plugins: [], failures: [] };
  /** @param {string} file @param {string} message @param {Record<string, any>} [params] */
  const fail = (file, message, params = {}) => {
    report.failures.push({ file, message, params });
    log?.warn(`Plugin ${file || 'list'}: ${fill(message, params)}`, { source: LOG_SOURCE });
  };
  /** @type {any} */
  let listing;
  try {
    listing = await withTimeout(Promise.resolve().then(list), timeoutMs, msg('No answer from the desktop app'));
  } catch (err) {
    fail('', msg('The plugin list could not be read: {error}'), { error: errorText(err) });
    return report;
  }
  report.dirs = Array.isArray(listing?.dirs) ? listing.dirs.map(String) : [];
  for (const e of Array.isArray(listing?.errors) ? listing.errors : []) fail(String(e?.file ?? ''), String(e?.error ?? ''));
  /** @type {PluginFile[]} */
  const files = (Array.isArray(listing?.plugins) ? listing.plugins : []).filter((p) => typeof p?.file === 'string' && typeof p?.source === 'string');
  const settled = await Promise.all(
    files.map((entry) =>
      withTimeout(evaluate(entry, api, importModule), timeoutMs, 'Timed out').then(
        (value) => ({ entry, value, error: null }),
        (error) => ({ entry, value: null, error }),
      ),
    ),
  );
  /** @type {Map<string, string>} */
  const taken = new Map(registry.list().map((d) => [d.id, '']));
  const families = new Set(registry.list().map((d) => d.family));
  for (const { entry, value, error } of settled) {
    if (!value) {
      if (error?.code === 'TIMEOUT') fail(entry.file, msg('The plugin did not load within {seconds} s'), { seconds: timeoutMs / 1000 });
      else if (error instanceof PluginProblem) fail(entry.file, error.message, error.params);
      else fail(entry.file, msg('The plugin could not be loaded: {error}'), { error: errorText(error) });
      continue;
    }
    if (!value.definitions.length) {
      fail(entry.file, msg('The plugin registers no drivers'));
      continue;
    }
    /** @type {string[]} */
    const ids = [];
    for (const def of value.definitions) {
      try {
        const bad = validateDefinition(def, taken, families);
        if (bad) {
          fail(entry.file, bad.message, bad.params);
          continue;
        }
        registry.register(def);
      } catch (err) {
        fail(entry.file, msg('The plugin could not be loaded: {error}'), { error: errorText(err) });
        continue;
      }
      taken.set(def.id, entry.file);
      families.add(def.family);
      ids.push(def.id);
    }
    if (!ids.length) continue;
    report.plugins.push({ file: entry.file, name: value.name, version: value.version, drivers: ids });
    log?.event(`Plugin ${entry.file} loaded: ${value.name}${value.version ? ` ${value.version}` : ''}, drivers ${ids.join(', ')}`, { source: LOG_SOURCE });
  }
  if (files.length || report.failures.length) {
    log?.event(`Plugins: ${report.plugins.length} loaded, ${report.failures.length} problem(s); folders: ${report.dirs.join(', ') || 'none'}`, { source: LOG_SOURCE });
  }
  return report;
}

/**
 * Desktop app start: read the plugin folders through the bridge, load the plugins into the
 * controller's registry and hand the report to the controller (Plugins view, saved choices).
 * @param {import('./controller.js').AppController} ctrl
 * @param {{ appVersion: string, timeoutMs?: number }} opts
 */
export async function loadDesktopPlugins(ctrl, { appVersion, timeoutMs }) {
  const invoke = /** @type {any} */ (window).__TAURI__.core.invoke;
  const report = await loadPlugins({
    list: () => invoke('plugins_list'),
    registry: ctrl.registry,
    log: ctrl.log,
    api: createPluginApi({ appVersion }),
    timeoutMs,
  });
  ctrl.setPlugins(report);
  return report;
}
