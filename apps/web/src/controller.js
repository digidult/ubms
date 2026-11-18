import {
  ProtocolLog,
  WebBluetoothProvider,
  WebSerialProvider,
  TauriBleProvider,
  TauriSerialProvider,
  createLinkPair,
  detectEnvironment,
  isTauri,
} from '@ubms/transport';
import { BmsSession, DriverRegistry, fieldMap, coerce } from '@ubms/bms-core';
import { drivers } from '@ubms/bms-drivers';
import { Store, createStorage, i18n, negotiateLocale, applyTheme, toast, t, downloadFile } from '@ubms/ui';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'uk', name: 'Українська' },
  { code: 'ru', name: 'Русский' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
];

/**
 * @typedef {Object} Prefs
 * @property {string} lang
 * @property {'auto'|'light'|'dark'} theme
 * @property {number} pollMs
 * @property {boolean} keepAwake
 * @property {boolean} showAdvanced
 * @property {number} logCapacity
 * @property {boolean} logRaw show raw rx chunks in the log view
 * @property {'ble'|'serial'|'demo'} transport
 * @property {string} selection driver selection ('auto', family or driver id)
 * @property {string} demoDriver
 * @property {boolean} showAllBle
 * @property {boolean} adaptersOnly
 * @property {string} serialAddress RS485 device address or board number, empty for the protocol default
 *
 * @typedef {{ id: string, name: string, kind: 'ble'|'serial', driverId?: string, at: number }} RecentDevice
 *
 * @typedef {Object} AppState
 * @property {Prefs} prefs
 * @property {ReturnType<typeof detectEnvironment>} env
 * @property {{ ble: { available: boolean, reason?: string }, serial: { available: boolean, reason?: string } }} availability
 * @property {import('@ubms/bms-core/session').SessionState} state
 * @property {string | null} error
 * @property {{ index: number, total: number, protocol: string } | null} detect
 * @property {{ driverId: string, vendor: string, protocol: string, variant?: string, deviceName: string, linkKind: string, deviceType: string } | null} device
 * @property {import('@ubms/bms-core/model').BmsSnapshot | null} snapshot
 * @property {import('@ubms/bms-core/model').DeviceInfo | null} info
 * @property {import('@ubms/bms-core/session').SettingsState} settings
 * @property {number} historyRev
 * @property {RecentDevice[]} recent
 * @property {{ active: boolean, devices: ScannedDevice[] }} scan native Bluetooth scan (desktop app)
 * @property {{ loading: boolean, list: Array<{ path: string, name?: string, usbVendorId?: number, usbProductId?: number }> }} ports native port list (desktop app)
 *
 * @typedef {{ id: string, name: string, rssi?: number, services?: string[] }} ScannedDevice
 */

const DEFAULT_PREFS = /** @type {Prefs} */ ({
  lang: '',
  theme: 'auto',
  pollMs: 1000,
  keepAwake: true,
  showAdvanced: false,
  logCapacity: 5000,
  logRaw: false,
  transport: 'ble',
  selection: 'auto',
  demoDriver: '',
  showAllBle: false,
  adaptersOnly: false,
  serialAddress: '',
});

export class AppController {
  constructor() {
    this.storage = createStorage('ubms');
    const saved = this.storage.get('prefs', {});
    /** @type {Prefs} */
    const prefs = { ...DEFAULT_PREFS, ...saved };
    if (!prefs.lang) {
      prefs.lang = negotiateLocale(
        LANGUAGES.map((l) => l.code),
        typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [],
      );
    }
    this.log = new ProtocolLog({ capacity: prefs.logCapacity });
    this.registry = new DriverRegistry(drivers);
    if (!prefs.demoDriver || !this.registry.get(prefs.demoDriver)) prefs.demoDriver = drivers.find((d) => d.demo)?.id ?? '';
    this.session = new BmsSession({ registry: this.registry, log: this.log, pollIntervalMs: prefs.pollMs });
    const tauri = isTauri();
    this.providers = {
      ble: tauri ? new TauriBleProvider({ log: this.log }) : new WebBluetoothProvider({ log: this.log }),
      serial: tauri ? new TauriSerialProvider({ log: this.log }) : new WebSerialProvider({ log: this.log }),
    };
    /** @type {any} */
    this.wakeLock = null;
    /** @type {(() => void) | null} */
    this.stopDemo = null;

    /** @type {Store<AppState>} */
    this.store = new Store(
      /** @type {AppState} */ ({
        prefs,
        env: detectEnvironment(),
        availability: { ble: { available: false }, serial: { available: false } },
        state: 'idle',
        error: null,
        detect: null,
        device: null,
        snapshot: null,
        info: null,
        settings: { schema: null, values: null, loading: false, error: null },
        historyRev: 0,
        recent: this.storage.get('recent', []),
        scan: { active: false, devices: [] },
        ports: { loading: false, list: [] },
      }),
    );
    /** @type {(() => Promise<void>) | null} */
    this.stopScanFn = null;

    i18n.setLocale(prefs.lang);
    applyTheme(prefs.theme);
    this.#wireSession();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.#updateWakeLock();
      });
    }
  }

  get state() {
    return this.store.get();
  }

  async init() {
    const [ble, serial] = await Promise.all([this.providers.ble.availability(), this.providers.serial.availability()]);
    this.store.set({ availability: { ble, serial } });
  }

  #wireSession() {
    const s = this.session;
    s.on('state', ({ state, error }) => {
      /** @type {Partial<AppState>} */
      const patch = { state, error: error ? error.message : null };
      if (state === 'connected') {
        const def = /** @type {any} */ (s.definition);
        patch.detect = null;
        patch.device = {
          driverId: def.id,
          vendor: def.vendor,
          protocol: def.protocol,
          variant: s.variant,
          deviceName: s.link?.name ?? '',
          linkKind: s.link?.kind ?? '',
          deviceType: def.deviceType,
        };
        this.#rememberDevice();
      }
      if (state === 'idle' || state === 'error') {
        patch.detect = null;
        if (state === 'idle') {
          patch.device = null;
          patch.snapshot = null;
          patch.info = null;
          patch.settings = { schema: null, values: null, loading: false, error: null };
        }
      }
      this.store.set(patch);
      this.#updateWakeLock();
    });
    s.on('detect', (d) => this.store.set({ detect: d }));
    s.on('snapshot', (snap) => this.store.set((st) => ({ snapshot: snap, historyRev: st.historyRev + 1 })));
    s.on('info', (info) => this.store.set({ info: { ...info } }));
    s.on('settings', (settings) => this.store.set({ settings: { ...settings } }));
    s.on('variant', (variant) => this.store.set((st) => ({ device: st.device ? { ...st.device, variant } : st.device })));
  }

  /**
   * @template {keyof Prefs} K
   * @param {K} key
   * @param {Prefs[K]} value
   */
  setPref(key, value) {
    const prefs = { ...this.state.prefs, [key]: value };
    this.storage.set('prefs', prefs);
    this.store.set({ prefs });
    if (key === 'lang') i18n.setLocale(/** @type {string} */ (value));
    if (key === 'theme') applyTheme(/** @type {any} */ (value));
    if (key === 'pollMs') this.session.setPollInterval(/** @type {number} */ (value));
    if (key === 'logCapacity') this.log.capacity = /** @type {number} */ (value);
    if (key === 'keepAwake') this.#updateWakeLock();
  }

  resetPrefs() {
    this.storage.remove('prefs');
    const prefs = { ...DEFAULT_PREFS, lang: this.state.prefs.lang };
    this.store.set({ prefs });
    applyTheme(prefs.theme);
    this.session.setPollInterval(prefs.pollMs);
  }

  /** Is the current selection filterable in the Bluetooth chooser? */
  bleFilterInfo() {
    const { selection, showAllBle } = this.state.prefs;
    return this.registry.bleRequest({ selection, showAll: showAllBle });
  }

  async connectBle() {
    const { selection } = this.state.prefs;
    const { request } = this.bleFilterInfo();
    let device;
    try {
      device = await /** @type {WebBluetoothProvider} */ (this.providers.ble).request(request);
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'NotFoundError') return; // chooser cancelled
      throw err;
    }
    await this.#connect({ kind: 'ble', handle: device, selection });
  }

  async connectSerial() {
    const { selection, adaptersOnly } = this.state.prefs;
    let port;
    try {
      port = await /** @type {WebSerialProvider} */ (this.providers.serial).request({ adaptersOnly });
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'NotFoundError') return;
      throw err;
    }
    const address = Number.parseInt(this.state.prefs.serialAddress, 10);
    const options = Number.isFinite(address) ? { address, board: address } : {};
    await this.#connect({ kind: 'serial', handle: port, selection, options });
  }

  /** True when Bluetooth devices are found by an in-app scan (desktop app) instead of a browser chooser. */
  get nativeBle() {
    return !!(/** @type {any} */ (this.providers.ble).capabilities?.scan);
  }

  /** True when serial ports are listed by the app (desktop app) instead of a browser chooser. */
  get nativeSerial() {
    return !!(/** @type {any} */ (this.providers.serial).capabilities?.list);
  }

  /** Start an in-app Bluetooth scan (desktop app). Results go to `state.scan.devices`. */
  async startBleScan() {
    await this.stopBleScan();
    const { selection, showAllBle } = this.state.prefs;
    const defs = this.registry.select(selection, 'ble');
    const filters = showAllBle
      ? {}
      : {
          namePrefixes: [...new Set(defs.flatMap((d) => d.links.ble?.namePrefixes ?? []))],
          services: [...new Set(defs.flatMap((d) => d.links.ble?.advertisedServices ?? []))],
          manufacturerIds: [...new Set(defs.flatMap((d) => d.links.ble?.manufacturerIds ?? []))],
        };
    this.store.set({ scan: { active: true, devices: [] } });
    const provider = /** @type {any} */ (this.providers.ble);
    try {
      this.stopScanFn = await provider.scan({ ...filters, timeoutMs: 20000 }, (/** @type {ScannedDevice} */ d) => {
        const devices = [...this.state.scan.devices];
        const i = devices.findIndex((x) => x.id === d.id);
        const entry = { id: d.id, name: d.name || t('Unnamed device'), rssi: d.rssi, services: d.services };
        if (i >= 0) devices[i] = { ...devices[i], ...entry };
        else devices.push(entry);
        this.store.set({ scan: { active: this.state.scan.active, devices } });
      });
      setTimeout(() => {
        if (this.state.scan.active) this.stopBleScan();
      }, 20000);
    } catch (err) {
      this.store.set({ scan: { active: false, devices: this.state.scan.devices } });
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  async stopBleScan() {
    const stop = this.stopScanFn;
    this.stopScanFn = null;
    if (stop) await stop().catch(() => {});
    if (this.state.scan.active) this.store.set({ scan: { active: false, devices: this.state.scan.devices } });
  }

  /** @param {ScannedDevice} device */
  async connectScannedDevice(device) {
    await this.stopBleScan();
    const handle = /** @type {any} */ (this.providers.ble).get(device);
    await this.#connect({ kind: 'ble', handle, selection: this.state.prefs.selection });
  }

  /** Refresh the serial port list (desktop app). */
  async listSerialPorts() {
    this.store.set({ ports: { loading: true, list: this.state.ports.list } });
    try {
      const ports = await /** @type {any} */ (this.providers.serial).list();
      this.serialHandles = ports;
      this.store.set({ ports: { loading: false, list: ports.map((/** @type {any} */ p) => ({ ...p.info })) } });
    } catch (err) {
      this.store.set({ ports: { loading: false, list: [] } });
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  /** @param {{ path: string }} port */
  async connectSerialPort(port) {
    const handle = (this.serialHandles ?? []).find((/** @type {any} */ h) => h.info.path === port.path);
    if (!handle) return;
    const { selection } = this.state.prefs;
    const address = Number.parseInt(this.state.prefs.serialAddress, 10);
    const options = Number.isFinite(address) ? { address, board: address } : {};
    await this.#connect({ kind: 'serial', handle, selection, options });
  }

  /** @param {RecentDevice} recent */
  async connectRecent(recent) {
    const provider = recent.kind === 'ble' ? this.providers.ble : this.providers.serial;
    const known = await provider.known();
    const handle = known.find((h) => h.id === recent.id);
    if (!handle) {
      toast(t('The browser needs your permission again. Pick the device in the list.'), { tone: 'info' });
      if (recent.kind === 'ble') return this.connectBle();
      return this.connectSerial();
    }
    await this.#connect({ kind: recent.kind, handle, selection: recent.driverId ?? 'auto' });
  }

  /** @param {string} [driverId] */
  async connectDemo(driverId = this.state.prefs.demoDriver) {
    const def = this.registry.get(driverId);
    if (!def?.demo) throw new Error(`No demo for ${driverId}`);
    const { host, device } = createLinkPair({
      log: this.log,
      name: def.demo.name,
      kind: 'demo',
      latencyMs: 15,
      deviceChunkSize: def.demo.chunkSize ?? 0,
    });
    await device.open();
    const sim = def.demo.create(device);
    this.stopDemo = () => {
      sim.stop?.();
      device.close();
    };
    host.once('close', () => {
      this.stopDemo?.();
      this.stopDemo = null;
    });
    await this.#connect({ kind: 'link', link: host, selection: def.id });
  }

  /** @param {import('@ubms/bms-core/session').ConnectTarget} target */
  async #connect(target) {
    try {
      await this.session.connect(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/** @type {any} */ (err)?.code !== 'cancelled') toast(t(message), { tone: 'danger', timeout: 7000 });
    }
  }

  async cancel() {
    await this.session.disconnect();
  }

  async disconnect() {
    await this.session.disconnect();
  }

  async reconnect() {
    try {
      await this.session.reconnect();
    } catch (err) {
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  #rememberDevice() {
    const target = this.session.target;
    if (!target || (target.kind !== 'ble' && target.kind !== 'serial')) return;
    const handle = target.handle;
    /** @type {RecentDevice} */
    const entry = { id: handle.id, name: handle.name, kind: target.kind, driverId: this.session.definition?.id, at: Date.now() };
    const recent = [entry, ...this.state.recent.filter((r) => !(r.id === entry.id && r.kind === entry.kind))].slice(0, 8);
    this.storage.set('recent', recent);
    this.store.set({ recent });
  }

  /** @param {RecentDevice} r */
  forgetRecent(r) {
    const recent = this.state.recent.filter((x) => !(x.id === r.id && x.kind === r.kind));
    this.storage.set('recent', recent);
    this.store.set({ recent });
  }

  async #updateWakeLock() {
    const want = this.state.prefs.keepAwake && this.state.state === 'connected' && document.visibilityState === 'visible';
    const wl = /** @type {any} */ (navigator).wakeLock;
    try {
      if (want && !this.wakeLock && wl) {
        this.wakeLock = await wl.request('screen');
        this.wakeLock.addEventListener?.('release', () => (this.wakeLock = null));
      } else if (!want && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      this.wakeLock = null;
    }
  }

  // ---------- settings ----------

  async loadSettings() {
    try {
      await this.session.loadSettings();
      const err = this.session.settings.error;
      if (err) toast(t('Could not read settings: {error}', { error: t(err) }), { tone: 'danger' });
    } catch (err) {
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  /**
   * @param {Array<{ id: string, value: any }>} changes
   * @param {{ reload?: boolean, quiet?: boolean }} [opts]
   */
  async writeSettings(changes, { reload = true, quiet = false } = {}) {
    const results = await this.session.writeSettings(changes, { reload });
    const failed = results.filter((r) => !r.ok);
    const unverified = results.filter((r) => r.ok && r.verified === false);
    if (failed.length) {
      toast(t('{count} setting(s) failed: {list}', { count: failed.length, list: failed.map((r) => `${r.id} (${t(r.error ?? '')})`).join(', ') }), {
        tone: 'danger',
        timeout: 9000,
      });
    } else if (unverified.length) {
      toast(t('Written, but the device reports a different value for: {list}', { list: unverified.map((r) => r.id).join(', ') }), { tone: 'warn', timeout: 9000 });
    } else if (!quiet) {
      toast(t('{count} setting(s) written', { count: results.length }), { tone: 'ok' });
    }
    return results;
  }

  /** @param {string} id @param {any} [arg] */
  async runAction(id, arg) {
    try {
      await this.session.runAction(id, arg);
      toast(t('Done'), { tone: 'ok' });
    } catch (err) {
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  }

  /** Export the current settings to a JSON file. */
  exportSettings() {
    const { settings, device, info } = this.state;
    if (!settings.values || !device) return;
    const data = {
      format: 'ubms-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      driver: device.driverId,
      protocol: device.protocol,
      variant: device.variant,
      device: info,
      values: settings.values,
    };
    const name = `${(info?.name || device.deviceName || device.driverId).replace(/[^\w.-]+/g, '_')}-settings-${new Date().toISOString().slice(0, 10)}.json`;
    downloadFile(name, JSON.stringify(data, null, 2));
  }

  /**
   * Compare a settings export with the current values. Returns writable changes.
   * @param {string} text
   */
  parseSettingsImport(text) {
    const data = JSON.parse(text);
    if (data?.format !== 'ubms-settings') throw new Error('Not a ubms settings file');
    const { settings, device } = this.state;
    const fields = fieldMap(settings.schema);
    /** @type {Array<{ id: string, value: any, from: any }>} */
    const changes = [];
    const skipped = [];
    for (const [id, raw] of Object.entries(data.values ?? {})) {
      const f = fields.get(id);
      if (!f || f.readOnly || f.type === 'action') {
        skipped.push(id);
        continue;
      }
      const value = coerce(f, raw);
      if (value === undefined) {
        skipped.push(id);
        continue;
      }
      const current = settings.values?.[id];
      if (current !== undefined && String(current) === String(value)) continue;
      changes.push({ id, value, from: current });
    }
    return { changes, skipped, sameDriver: data.driver === device?.driverId };
  }

  exportLog({ includeDecoded = true } = {}) {
    const { device, info, snapshot, settings } = this.state;
    const data = this.log.export({
      includeDecoded,
      meta: {
        app: 'ubms',
        version: __APP_VERSION__,
        revision: __APP_REVISION__,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        device,
        info,
        snapshot,
        settings: settings.values,
      },
    });
    downloadFile(`ubms-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`, JSON.stringify(data, null, 1));
  }

  exportLogText() {
    const entries = this.log.entries();
    const t0 = entries[0]?.t;
    const text = entries.map((e) => ProtocolLog.formatLine(e, t0)).join('\n');
    downloadFile(`ubms-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`, text, 'text/plain');
  }
}
