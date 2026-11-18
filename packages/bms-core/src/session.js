import { Emitter, sleep } from '@ubms/transport';
import { HistoryBuffer } from './history.js';
import { fieldMap, validateValue } from './settings.js';
import { msg } from './msg.js';

/**
 * A session owns one device connection: protocol detection, the active driver, the poll loop,
 * reconnects, the latest snapshot, device info, settings and a short history.
 *
 * Events:
 * - `state`    ({ state, error? })
 * - `detect`   ({ index, total, driverId, protocol, profileId }) progress of auto-detection
 * - `snapshot` (BmsSnapshot)
 * - `info`     (DeviceInfo)
 * - `settings` (SettingsState)
 * - `variant`  (string)
 *
 * @typedef {'idle'|'connecting'|'detecting'|'connected'|'reconnecting'|'disconnecting'|'error'} SessionState
 *
 * @typedef {Object} ConnectTarget
 * @property {'ble'|'serial'|'link'} kind
 * @property {any} [handle] BLE device handle or serial port handle from a transport provider
 * @property {import('@ubms/transport').Link} [link] already open link (demo, replay, tests)
 * @property {string} [selection] 'auto', a family id ('jk') or a driver id ('jk-ble')
 * @property {Record<string, any>} [options] driver options
 *
 * @typedef {Object} SettingsState
 * @property {import('./settings.js').SettingsSchema | null} schema
 * @property {Record<string, any> | null} values
 * @property {number} [readAt]
 * @property {boolean} loading
 * @property {string | null} error
 *
 * @typedef {Object} WriteResult
 * @property {string} id
 * @property {boolean} ok the write command was accepted
 * @property {string} [error] English message
 * @property {boolean} [verified] read-back matched the requested value
 * @property {any} [actual] value read back from the device
 */

export class SessionError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class BmsSession extends Emitter {
  /**
   * @param {Object} opts
   * @param {import('./registry.js').DriverRegistry} opts.registry
   * @param {import('@ubms/transport').ProtocolLog} opts.log
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.historySize]
   * @param {boolean} [opts.autoReconnect]
   * @param {number} [opts.probeTimeoutMs]
   */
  constructor({ registry, log, pollIntervalMs = 1000, historySize = 3600, autoReconnect = true, probeTimeoutMs = 2500 }) {
    super();
    this.registry = registry;
    this.log = log;
    this.pollIntervalMs = pollIntervalMs;
    this.autoReconnect = autoReconnect;
    this.probeTimeoutMs = probeTimeoutMs;
    this.history = new HistoryBuffer(historySize);
    /** @type {SessionState} */
    this.state = 'idle';
    /** @type {Error | null} */
    this.error = null;
    /** @type {ConnectTarget | null} */
    this.target = null;
    /** @type {import('./driver.js').DriverDefinition | null} */
    this.definition = null;
    /** @type {import('./driver.js').BaseDriver | null} */
    this.driver = null;
    /** @type {import('@ubms/transport').Link | null} */
    this.link = null;
    /** @type {any} */
    this.profile = null;
    /** @type {string | undefined} */
    this.variant = undefined;
    /** @type {import('./model.js').BmsSnapshot | null} */
    this.snapshot = null;
    /** @type {import('./model.js').DeviceInfo | null} */
    this.info = null;
    /** @type {SettingsState} */
    this.settings = { schema: null, values: null, loading: false, error: null };
    this.lastDataAt = 0;
    this.pollErrors = 0;
    this.generation = 0;
    /** @type {Promise<any>} */
    this.lock = Promise.resolve();
    /** @type {Set<() => void>} */
    this.wakers = new Set();
    /** @type {Array<() => void>} */
    this.unbind = [];
  }

  get connected() {
    return this.state === 'connected';
  }

  /** @param {SessionState} state @param {unknown} [error] */
  #setState(state, error) {
    this.state = state;
    this.error = error ? (error instanceof Error ? error : new Error(String(error))) : null;
    this.emit('state', { state, error: this.error });
  }

  /**
   * Run a task with exclusive access to the driver (poll, settings and actions never overlap).
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  exclusive(task) {
    const p = this.lock.then(task, task);
    this.lock = p.catch(() => {});
    return p;
  }

  /**
   * Connect, detect the protocol and start polling.
   * @param {ConnectTarget} target
   */
  async connect(target) {
    if (this.state !== 'idle' && this.state !== 'error') await this.disconnect();
    const gen = ++this.generation;
    // One options object per target, shared by every driver instance created for it (probe
    // candidates and reconnects), so drivers can keep local values such as passwords there.
    if (!target.options) target.options = {};
    this.target = target;
    this.history.clear();
    this.snapshot = null;
    this.info = null;
    this.settings = { schema: null, values: null, loading: false, error: null };
    this.#setState('connecting');
    try {
      const found =
        target.kind === 'ble' ? await this.#detectBle(target, gen) : target.kind === 'serial' ? await this.#detectSerial(target, gen) : await this.#attachLink(target);
      if (gen !== this.generation) {
        await this.#release(found);
        throw new SessionError('cancelled', msg('Connection cancelled'));
      }
      await this.#activate(found, gen);
    } catch (err) {
      if (gen === this.generation) {
        this.log.error(err instanceof Error ? err : String(err));
        await this.#teardown();
        this.#setState('error', err);
      }
      throw err;
    }
  }

  /**
   * @param {ConnectTarget} target
   * @param {number} gen
   */
  async #detectBle(target, gen) {
    const handle = target.handle;
    await handle.connect();
    this.#setState('detecting');
    /** @type {string[] | undefined} */
    let services;
    try {
      services = (await handle.discover()).map((/** @type {{ uuid: string }} */ s) => s.uuid);
    } catch (err) {
      this.log.warn(`Service discovery failed: ${err instanceof Error ? err.message : err}`);
    }
    const candidates = this.registry.bleCandidates({ name: handle.name, services: services?.length ? services : undefined, selection: target.selection });
    if (!candidates.length) {
      throw new SessionError('no-candidates', msg('The device exposes none of the Bluetooth services used by the selected BMS type'));
    }
    for (let i = 0; i < candidates.length; i++) {
      if (gen !== this.generation) throw new SessionError('cancelled', msg('Connection cancelled'));
      const { definition, profile } = candidates[i];
      this.emit('detect', { index: i, total: candidates.length, driverId: definition.id, protocol: definition.protocol, profileId: profile.id });
      this.log.event(`Probing ${definition.protocol} on ${profile.label ?? profile.id}`);
      /** @type {any} */
      let link = null;
      /** @type {any} */
      let driver = null;
      try {
        if (!handle.connected) await handle.connect();
        link = await handle.openChannel(profile);
        driver = definition.create({ link, log: this.log, profileId: profile.id, options: target.options });
        const probe = await driver.probe({ timeout: this.probeTimeoutMs });
        if (probe) return { definition, profile, driver, link, probe };
        this.log.event(`${definition.protocol}: no valid answer`);
      } catch (err) {
        this.log.warn(`${definition.protocol}: ${err instanceof Error ? err.message : err}`);
      }
      driver?.dispose();
      try {
        await link?.close();
      } catch {
        /* ignore */
      }
    }
    throw new SessionError('not-detected', msg('No supported BMS protocol answered on this device'));
  }

  /**
   * @param {ConnectTarget} target
   * @param {number} gen
   */
  async #detectSerial(target, gen) {
    const port = target.handle;
    this.#setState('detecting');
    const candidates = this.registry.serialCandidates({ selection: target.selection });
    if (!candidates.length) throw new SessionError('no-candidates', msg('The selected BMS type has no serial protocol'));
    for (let i = 0; i < candidates.length; i++) {
      if (gen !== this.generation) throw new SessionError('cancelled', msg('Connection cancelled'));
      const { definition, profile } = candidates[i];
      this.emit('detect', { index: i, total: candidates.length, driverId: definition.id, protocol: definition.protocol, profileId: profile.id });
      this.log.event(`Probing ${definition.protocol} at ${profile.baudRate} baud`);
      const { id: _id, label: _label, ...serialOptions } = profile;
      /** @type {any} */
      let link = null;
      /** @type {any} */
      let driver = null;
      try {
        link = await port.openLink(serialOptions);
        driver = definition.create({ link, log: this.log, profileId: profile.id, options: target.options });
        const probe = await driver.probe({ timeout: this.probeTimeoutMs });
        if (probe) return { definition, profile, driver, link, probe };
        this.log.event(`${definition.protocol}: no valid answer`);
      } catch (err) {
        this.log.warn(`${definition.protocol}: ${err instanceof Error ? err.message : err}`);
      }
      driver?.dispose();
      try {
        await link?.close();
      } catch {
        /* ignore */
      }
      await sleep(150);
    }
    throw new SessionError('not-detected', msg('No supported BMS protocol answered on this port'));
  }

  /** @param {ConnectTarget} target */
  async #attachLink(target) {
    const definition = target.selection ? this.registry.get(target.selection) : undefined;
    if (!definition) throw new SessionError('no-driver', msg('A driver id is required for direct links'));
    const link = /** @type {import('@ubms/transport').Link} */ (target.link);
    if (!link.isOpen) await link.open();
    this.#setState('detecting');
    const driver = definition.create({ link, log: this.log, profileId: 'direct', options: target.options });
    const probe = await driver.probe({ timeout: this.probeTimeoutMs });
    if (!probe) {
      driver.dispose();
      throw new SessionError('not-detected', `${definition.protocol}: no valid answer`);
    }
    return { definition, profile: { id: 'direct' }, driver, link, probe };
  }

  /** @param {any} found */
  async #release(found) {
    found.driver?.dispose();
    try {
      await found.link?.close();
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {{ definition: any, profile: any, driver: any, link: any, probe: import('./driver.js').ProbeResult }} found
   * @param {number} gen
   */
  async #activate(found, gen) {
    const { definition, profile, driver, link, probe } = found;
    this.definition = definition;
    this.profile = profile;
    this.driver = driver;
    this.link = link;
    this.variant = probe.variant ?? driver.variant;
    this.unbind = [
      driver.on('snapshot', (/** @type {any} */ s) => this.#onSnapshot(s)),
      driver.on('info', (/** @type {any} */ info) => {
        this.info = { ...(this.info ?? {}), ...info };
        this.emit('info', this.info);
      }),
      driver.on('variant', (/** @type {string} */ v) => {
        this.variant = v;
        this.emit('variant', v);
      }),
      link.on('close', (/** @type {{ reason: string, remote: boolean }} */ e) => {
        if (e.remote) this.#onLinkLost(e.reason, gen);
      }),
    ];
    if (probe.info) {
      this.info = { ...(this.info ?? {}), ...probe.info };
      this.emit('info', this.info);
    }
    this.log.meta = { driver: definition.id, protocol: definition.protocol, variant: this.variant, device: link.describe() };
    this.log.event(`Connected: ${definition.vendor}, ${definition.protocol}${this.variant ? ` (${this.variant})` : ''}`);
    this.#setState('connected');
    await driver.start();
    this.#loop(gen);
    this.exclusive(() => driver.readInfo())
      .then((info) => {
        if (info && gen === this.generation) {
          this.info = { ...(this.info ?? {}), ...info };
          this.emit('info', this.info);
        }
      })
      .catch((err) => this.log.warn(`Device info: ${err instanceof Error ? err.message : err}`));
  }

  /** @param {import('./model.js').BmsSnapshot} s */
  #onSnapshot(s) {
    this.snapshot = s;
    this.lastDataAt = Date.now();
    this.history.push(s);
    this.emit('snapshot', s);
  }

  /** @param {number} gen */
  async #loop(gen) {
    while (gen === this.generation && this.state === 'connected') {
      const started = Date.now();
      const driver = /** @type {import('./driver.js').BaseDriver} */ (this.driver);
      try {
        await this.exclusive(() => driver.poll());
        this.pollErrors = 0;
      } catch (err) {
        this.pollErrors++;
        if (gen === this.generation) this.log.warn(`Poll failed (${this.pollErrors}): ${err instanceof Error ? err.message : err}`);
      }
      const caps = driver.capabilities;
      const interval = Math.max(caps.minPollIntervalMs ?? 200, this.pollIntervalMs);
      await this.#sleep(Math.max(50, interval - (Date.now() - started)), gen);
    }
  }

  /** Interruptible sleep: resolves early on disconnect or poll interval change. @param {number} ms @param {number} gen */
  #sleep(ms, gen) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve(undefined);
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
      if (gen !== this.generation) done();
    });
  }

  #wakeAll() {
    for (const w of [...this.wakers]) w();
  }

  /** @param {number} ms */
  setPollInterval(ms) {
    this.pollIntervalMs = Math.max(200, ms);
    this.#wakeAll();
  }

  /**
   * @param {string} reason
   * @param {number} gen
   */
  async #onLinkLost(reason, gen) {
    if (gen !== this.generation || this.state !== 'connected') return;
    const myGen = ++this.generation;
    this.#wakeAll();
    const { definition, profile, target } = this;
    const variant = this.variant;
    await this.#teardown({ keepTarget: true });
    if (!this.autoReconnect || target?.kind !== 'ble' || !definition) {
      this.#setState('error', new SessionError('link-lost', reason));
      return;
    }
    this.#setState('reconnecting');
    for (let attempt = 1; attempt <= 6 && myGen === this.generation; attempt++) {
      await sleep(Math.min(1000 * 2 ** (attempt - 1), 15000));
      if (myGen !== this.generation) return;
      this.log.event(`Reconnecting (attempt ${attempt})`);
      /** @type {any} */
      let link = null;
      /** @type {any} */
      let driver = null;
      try {
        await target.handle.connect();
        link = await target.handle.openChannel(profile);
        driver = definition.create({ link, log: this.log, profileId: profile.id, options: target.options });
        if (variant) driver.variant = variant;
        const probe = await driver.probe({ timeout: this.probeTimeoutMs });
        if (!probe) throw new Error(msg('The device did not answer'));
        if (myGen !== this.generation) {
          await this.#release({ driver, link });
          return;
        }
        await this.#activate({ definition, profile, driver, link, probe }, myGen);
        return;
      } catch (err) {
        this.log.warn(`Reconnect attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
        await this.#release({ driver, link });
      }
    }
    if (myGen === this.generation) this.#setState('error', new SessionError('link-lost', `Connection lost: ${reason}`));
  }

  /** @param {{ keepTarget?: boolean }} [opts] */
  async #teardown({ keepTarget = true } = {}) {
    for (const u of this.unbind) u();
    this.unbind = [];
    const driver = this.driver;
    const link = this.link;
    this.driver = null;
    this.link = null;
    try {
      await driver?.stop();
    } catch {
      /* ignore */
    }
    driver?.dispose();
    try {
      await link?.close();
    } catch {
      /* ignore */
    }
    if (!keepTarget) this.target = null;
  }

  /** Disconnect and return to idle. The last target is kept for a quick reconnect. */
  async disconnect() {
    this.generation++;
    this.#wakeAll();
    if (this.state === 'idle') return;
    this.#setState('disconnecting');
    const target = this.target;
    await this.#teardown();
    if (target?.kind === 'ble') {
      try {
        await target.handle.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.definition = null;
    this.profile = null;
    this.variant = undefined;
    this.log.event('Disconnected');
    this.#setState('idle');
  }

  /** Reconnect to the last target (no chooser needed for already granted devices). */
  async reconnect() {
    if (!this.target) throw new SessionError('no-target', msg('Nothing to reconnect to'));
    const sel = this.definition?.id ?? this.target.selection;
    await this.connect({ ...this.target, selection: sel });
  }

  #requireDriver() {
    if (!this.driver || this.state !== 'connected') throw new SessionError('not-connected', msg('Not connected'));
    return this.driver;
  }

  async refreshInfo() {
    const driver = this.#requireDriver();
    const info = await this.exclusive(() => driver.readInfo());
    if (info) {
      this.info = { ...(this.info ?? {}), ...info };
      this.emit('info', this.info);
    }
    return this.info;
  }

  /** Read all settings from the device. */
  async loadSettings() {
    const driver = this.#requireDriver();
    if (!driver.capabilities.settings) throw new SessionError('unsupported', msg('This device does not expose settings'));
    this.settings = { ...this.settings, schema: driver.getSettingsSchema(), loading: true, error: null };
    this.emit('settings', this.settings);
    try {
      const values = await this.exclusive(() => driver.readSettings());
      this.settings = { schema: driver.getSettingsSchema(), values, readAt: Date.now(), loading: false, error: null };
    } catch (err) {
      this.settings = { ...this.settings, loading: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.emit('settings', this.settings);
    return this.settings;
  }

  /**
   * Write several settings one by one, then read them back and verify.
   * @param {Array<{ id: string, value: any }>} changes
   * @param {{ reload?: boolean }} [opts] reload=false skips the read-back (for quick switches)
   * @returns {Promise<WriteResult[]>}
   */
  async writeSettings(changes, { reload = true } = {}) {
    const driver = this.#requireDriver();
    if (!driver.capabilities.writeSettings) throw new SessionError('unsupported', msg('This device does not support writing settings'));
    const fields = fieldMap(driver.getSettingsSchema());
    /** @type {WriteResult[]} */
    const results = [];
    for (const { id, value } of changes) {
      const f = fields.get(id);
      const problem = f ? validateValue(f, value) : { message: msg('Unknown setting') };
      if (problem) {
        results.push({ id, ok: false, error: problem.message });
        continue;
      }
      try {
        await this.exclusive(() => driver.writeSetting(id, value));
        this.log.event(`Setting written: ${id} = ${value}`);
        results.push({ id, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(`Setting ${id}: ${message}`);
        results.push({ id, ok: false, error: message });
      }
    }
    if (reload && driver.capabilities.settings && results.some((r) => r.ok)) {
      await this.loadSettings();
      const values = this.settings.values ?? {};
      for (const r of results) {
        if (!r.ok || !(r.id in values)) continue;
        const requested = changes.find((c) => c.id === r.id)?.value;
        const f = fields.get(r.id);
        r.actual = values[r.id];
        r.verified = sameValue(requested, r.actual, f);
      }
    }
    return results;
  }

  /**
   * @param {string} id
   * @param {any} [arg]
   */
  async runAction(id, arg) {
    const driver = this.#requireDriver();
    await this.exclusive(() => driver.runAction(id, arg));
    this.log.event(`Action executed: ${id}`);
  }
}

/**
 * @param {any} a
 * @param {any} b
 * @param {import('./settings.js').SettingField} [f]
 */
function sameValue(a, b, f) {
  if (typeof a === 'number' && typeof b === 'number') {
    const tol = f?.step ? f.step / 2 + 1e-9 : Math.max(1e-6, Math.abs(a) * 1e-6);
    return Math.abs(a - b) <= tol;
  }
  return String(a) === String(b);
}
