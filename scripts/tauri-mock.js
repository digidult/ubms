/*
 * Browser-side imitation of the Tauri bridge (docs/tauri.md) for the headless smoke test.
 * Injected before the app loads, it implements the same commands and events as the Rust side
 * (apps/desktop/src-tauri) and connects them to the app's own protocol simulators, so the desktop
 * code path (TauriBleProvider, TauriSerialProvider, the scan and port list UI) runs end to end
 * without Rust. It mirrors the behaviour of the real bridge that the JavaScript side relies on:
 *
 * - ble_adapter_state returns { state, reason, detail }. Errors are strings, as Tauri delivers them.
 * - Device ids are stable strings, and ble_connect opens a known id without a scan.
 * - Every characteristic is listed, duplicates included: the JK device has a write-only FFE1 and a
 *   notify FFE1 in one service, like new JK modules. Subscribe and write pick the characteristic
 *   by service, UUID and properties and fail when the picked one lacks the property.
 * - Advertisements are merged per device; a new scan stops the previous one.
 * - ble_disconnect sends no event; ble://disconnected follows only a remote close.
 * - serial_open returns { handle, warnings }; a port opens only once at a time (as on Windows);
 *   a read error forgets the port and sends serial://closed; closing a forgotten handle is fine.
 * - history_* keep the files of history.rs in memory (also in sessionStorage, so a reload finds
 *   them like files): the data folder is C:/ubms-mock/history and portable. Lines with a line
 *   break are refused, history_read returns the lines whose leading {"t":<integer> is in
 *   [from, to], history_prune drops older records and lines that are not records, history_list
 *   returns { key, meta, bytes, modified, last } newest first (modified changes with the records
 *   only, as the record file's time; last is the newest record time). save_file decodes the
 *   base64 data and returns a path in C:/Users/mock/Downloads, adding " (2)" and so on for a
 *   taken name.
 * - window.getCurrentWindow().onCloseRequested(handler) registers a close handler; like Tauri, the
 *   window is destroyed after the handler unless it called preventDefault().
 * - Arguments of the wrong type fail like Tauri's argument check ("invalid args `x` for command").
 *
 * window.__tauriMock.dropBle(id) and .dropSerial(handle) simulate a remote close, .requestClose()
 * a click on the window's close button (resolves with { handlers, destroyed }). .calls counts the
 * invoke calls per command; .historyKeys, .historyLines(key), .historyMeta(key) and .savedFiles
 * show what the app stored and saved.
 */
(() => {
  /** @type {Map<string, Set<(e: { event: string, payload: any }) => void>>} */
  const listeners = new Map();
  const emit = (event, payload) => {
    for (const h of [...(listeners.get(event) ?? [])]) h({ event, payload });
  };
  const FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';
  const FFE1 = '0000ffe1-0000-1000-8000-00805f9b34fb';
  /** GATT property bits (0x02 read, 0x04 write without response, 0x08 write, 0x10 notify, 0x20 indicate). */
  const props = (bits) => ({
    read: !!(bits & 0x02),
    write: !!(bits & 0x08),
    writeWithoutResponse: !!(bits & 0x04),
    notify: !!(bits & 0x10),
    indicate: !!(bits & 0x20),
  });
  const DEVICES = [
    {
      id: 'C8:47:8C:10:20:30',
      name: 'JK_PB2A16S20P',
      rssi: -58,
      driver: 'jk-ble',
      // JK "new" module (docs/protocols/jk.md): FFE1 0x0C (write) and FFE1 0x12 (notify).
      gatt: [{ uuid: FFE0, characteristics: [{ uuid: FFE1, bits: 0x0c }, { uuid: FFE1, bits: 0x12 }] }],
    },
    {
      id: 'C8:47:8C:40:50:60',
      name: 'ANT-BLE16ZMUB',
      rssi: -71,
      driver: 'ant',
      gatt: [{ uuid: FFE0, characteristics: [{ uuid: FFE1, bits: 0x1c }] }],
    },
  ];
  /** @type {Map<string, any>} connected devices by id */
  const ble = new Map();
  /** @type {Map<string, any>} open ports by handle */
  const serial = new Map();
  let seq = 0;
  /** @type {ReturnType<typeof setTimeout>[]} */
  let scanTimers = [];

  const transport = () => window.ubmsDebug.transport;

  async function simulator(driverId) {
    const def = window.ubms.registry.get(driverId);
    const { host, device } = transport().createLinkPair({ deviceChunkSize: 20 });
    await host.open();
    await device.open();
    const sim = def.demo.create(device);
    return { host, device, sim, off: () => {} };
  }

  const services = (dev) =>
    dev.gatt.map((s) => ({ uuid: s.uuid, characteristics: s.characteristics.map((c) => ({ uuid: c.uuid, properties: props(c.bits) })) }));

  /** The bridge's rule: first service with the UUID, then the characteristic with a wanted property, else the first. */
  function pick(dev, service, uuid, want) {
    const list = dev.gatt.find((s) => s.uuid === service)?.characteristics.filter((c) => c.uuid === uuid) ?? [];
    const c = list.find((x) => want(props(x.bits))) ?? list[0];
    if (!c) throw `Characteristic ${uuid} not found in service ${service}`;
    return c;
  }

  function connection(id) {
    const e = ble.get(id);
    if (!e) throw 'Bluetooth device is not connected';
    return e;
  }

  function stopScan() {
    for (const t of scanTimers) clearTimeout(t);
    scanTimers = [];
  }

  function forgetBle(id) {
    const e = ble.get(id);
    e?.off();
    e?.sim?.stop?.();
    ble.delete(id);
  }

  function forgetSerial(handle) {
    const e = serial.get(handle);
    e?.off();
    e?.sim?.stop?.();
    serial.delete(handle);
  }

  // ----- History storage and saving (history.rs) -----

  const HISTORY_DIR = 'C:/ubms-mock/history';
  const DOWNLOADS_DIR = 'C:/Users/mock/Downloads';
  const HISTORY_SESSION_KEY = '__tauriMockHistory';
  /** Longest encoded key (MAX_STEM in history.rs). */
  const MAX_STEM = 180;
  const MAX_NAME_CHARS = 120;
  /** @type {Record<string, number>} invoke calls per command */
  const calls = {};
  /** @type {Map<string, { lines: string[], meta: string | null, modified: number }>} */
  const history = new Map();
  /** @type {{ name: string, path: string, bytes: number, data: string }[]} */
  const saved = [];
  const utf8 = new TextEncoder();

  try {
    const stored = JSON.parse(sessionStorage.getItem(HISTORY_SESSION_KEY) ?? '[]');
    for (const [key, entry] of stored) history.set(key, entry);
  } catch {
    // No sessionStorage (or garbage in it): start empty, like a new data folder.
  }

  function persistHistory() {
    try {
      sessionStorage.setItem(HISTORY_SESSION_KEY, JSON.stringify([...history]));
    } catch {
      // Storage full or unavailable: the in-memory copy still serves this page.
    }
  }

  /** Tauri's own argument check, before the command runs. */
  function need(cmd, args, name, type, optional = false) {
    const value = args[name];
    if (value === undefined || value === null) {
      if (optional) return null;
      throw `invalid args \`${name}\` for command \`${cmd}\`: command ${cmd} missing required key ${name}`;
    }
    const ok = type === 'string[]' ? Array.isArray(value) && value.every((v) => typeof v === 'string') : typeof value === type;
    if (!ok) throw `invalid args \`${name}\` for command \`${cmd}\`: invalid type, expected ${type === 'number' ? 'f64' : type}`;
    return value;
  }

  /** The file name stem of history.rs: [A-Za-z0-9._-] stays, other UTF-8 bytes become ~HH. */
  function encodedLength(key) {
    let n = 0;
    for (const b of utf8.encode(key)) n += /[A-Za-z0-9._-]/.test(String.fromCharCode(b)) ? 1 : 3;
    return n;
  }

  function historyKey(key) {
    if (key === '') throw 'History key is empty';
    if (encodedLength(key) > MAX_STEM) throw 'History key is too long';
    return key;
  }

  /** Same rule as line_time in history.rs: {"t":<integer> then , or }, and a closing }. */
  function lineTime(line) {
    const m = /^\{"t":(-?\d+)[,}]/.exec(line);
    return m && line.endsWith('}') ? Number(m[1]) : null;
  }

  const inRange = (t, from, to) => (from === null || t >= from) && (to === null || t <= to);
  /** last_record_time of history.rs: the newest record time (the mock looks at every line). */
  const lastTime = (lines) => lines.reduce((max, line) => {
    const t = lineTime(line);
    return t !== null && (max === null || t > max) ? t : max;
  }, null);
  const fileBytes = (lines) => lines.reduce((sum, line) => sum + utf8.encode(line).length + 1, 0);

  function historyEntry(key) {
    let entry = history.get(key);
    if (!entry) {
      entry = { lines: [], meta: null, modified: Date.now() };
      history.set(key, entry);
    }
    return entry;
  }

  /** safe_file_name of history.rs. */
  function safeFileName(name) {
    const trim = (s) => s.replace(/^[ .]+|[ .]+$/g, '');
    const base = name.split(/[\\/]/).pop() ?? '';
    let out = trim(base.replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '_'));
    const chars = [...out];
    if (chars.length > MAX_NAME_CHARS) {
      const dot = out.lastIndexOf('.');
      let ext = dot > 0 ? out.slice(dot) : '';
      if ([...ext].length > 16) ext = '';
      const stem = ext ? out.slice(0, out.length - ext.length) : out;
      out = trim([...stem].slice(0, MAX_NAME_CHARS - [...ext].length).join('') + ext);
    }
    if (!out) out = 'export';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(out.split('.')[0])) out = `_${out}`;
    return out;
  }

  function decodeBase64(data) {
    try {
      return atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    } catch {
      throw 'The file data is not valid base64';
    }
  }

  function saveFile(name, data) {
    const bytes = decodeBase64(data).length;
    const safe = safeFileName(name);
    const dot = safe.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ''];
    for (let n = 1; ; n++) {
      const path = `${DOWNLOADS_DIR}/${n === 1 ? safe : `${stem} (${n})${ext}`}`;
      if (!saved.some((f) => f.path === path)) {
        saved.push({ name: path.slice(DOWNLOADS_DIR.length + 1), path, bytes, data });
        return path;
      }
    }
  }

  async function historyCommand(cmd, args) {
    switch (cmd) {
      case 'history_info':
        return { dir: HISTORY_DIR, portable: true, reason: 'A file named portable or ubms.portable is next to the app' };
      case 'history_append': {
        const key = need(cmd, args, 'key', 'string');
        const lines = need(cmd, args, 'lines', 'string[]');
        const bad = lines.findIndex((line) => /[\r\n]/.test(line));
        if (bad >= 0) throw `History line ${bad + 1} contains a line break`;
        historyKey(key);
        const add = lines.filter((line) => line !== '');
        if (add.length) {
          const entry = historyEntry(key);
          entry.lines.push(...add);
          entry.modified = Date.now();
          persistHistory();
        }
        return null;
      }
      case 'history_read': {
        // Tauri checks every argument before the command runs; the key rule comes after.
        const key = need(cmd, args, 'key', 'string');
        const from = need(cmd, args, 'from', 'number', true);
        const to = need(cmd, args, 'to', 'number', true);
        historyKey(key);
        return (history.get(key)?.lines ?? []).filter((line) => {
          const t = lineTime(line);
          return t !== null && inRange(t, from, to);
        });
      }
      case 'history_write_meta': {
        const key = need(cmd, args, 'key', 'string');
        const meta = need(cmd, args, 'meta', 'string');
        historyKey(key);
        const entry = historyEntry(key);
        entry.meta = meta;
        // The meta file's time counts only while there is no record file (history.rs list_keys).
        if (!entry.lines.length) entry.modified = Date.now();
        persistHistory();
        return null;
      }
      case 'history_list':
        return [...history]
          .map(([key, e]) => ({ key, meta: e.meta, bytes: fileBytes(e.lines), modified: e.modified, last: lastTime(e.lines) }))
          .sort((a, b) => b.modified - a.modified || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      case 'history_remove': {
        const key = historyKey(need(cmd, args, 'key', 'string'));
        if (history.delete(key)) persistHistory();
        return null;
      }
      case 'history_prune': {
        const key = need(cmd, args, 'key', 'string');
        const before = need(cmd, args, 'before', 'number');
        historyKey(key);
        const entry = history.get(key);
        if (!entry) return 0;
        const kept = entry.lines.filter((line) => {
          const t = lineTime(line);
          return t !== null && t >= before;
        });
        const removed = entry.lines.length - kept.length;
        if (removed > 0) {
          entry.lines = kept;
          entry.modified = Date.now();
          persistHistory();
        }
        return removed;
      }
      case 'save_file':
        return saveFile(need(cmd, args, 'name', 'string'), need(cmd, args, 'data', 'string'));
      default:
        throw `Unknown command ${cmd}`;
    }
  }

  /** Close handlers registered through window.getCurrentWindow().onCloseRequested(). */
  const closeHandlers = new Set();
  let destroyed = 0;
  const currentWindow = {
    label: 'main',
    async onCloseRequested(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  };

  window.__TAURI__ = {
    window: {
      getCurrentWindow: () => currentWindow,
    },
    core: {
      async invoke(cmd, args = {}) {
        calls[cmd] = (calls[cmd] ?? 0) + 1;
        if (cmd.startsWith('history_') || cmd === 'save_file') return historyCommand(cmd, args ?? {});
        switch (cmd) {
          case 'ble_adapter_state':
            return { state: 'on', reason: null, detail: null };
          case 'ble_scan_start': {
            stopScan();
            DEVICES.forEach((d, i) => {
              const found = { id: d.id, name: d.name, rssi: d.rssi, services: [], manufacturerData: {} };
              // The advertisement first, then the same device with a new RSSI (merged per id).
              scanTimers.push(setTimeout(() => emit('ble://device', found), 120 * (i + 1)));
              scanTimers.push(setTimeout(() => emit('ble://device', { ...found, rssi: d.rssi - 2 }), 1100 + 120 * (i + 1)));
            });
            scanTimers.push(setTimeout(stopScan, args.timeoutMs ?? 15000));
            return null;
          }
          case 'ble_scan_stop':
            stopScan();
            return null;
          case 'ble_connect': {
            // Like bluest's open_device: a known id opens without a scan.
            const dev = DEVICES.find((d) => d.id === args.id);
            if (!dev) throw 'Device not found, scan again';
            if (!ble.has(args.id)) ble.set(args.id, { dev, subscribed: null, ...(await simulator(dev.driver)) });
            return services(dev);
          }
          case 'ble_services':
            return services(connection(args.id).dev);
          case 'ble_subscribe': {
            const e = connection(args.id);
            const c = pick(e.dev, args.service, args.characteristic, (p) => p.notify || p.indicate);
            const p = props(c.bits);
            if (!p.notify && !p.indicate) throw 'not supported: characteristic does not support indications or notifications';
            if (e.subscribed === c) return null; // one notify stream per characteristic
            e.off();
            e.subscribed = c;
            e.off = e.host.on('data', (b) => emit('ble://notify', { id: args.id, service: args.service, characteristic: c.uuid, data: Array.from(b) }));
            return null;
          }
          case 'ble_unsubscribe': {
            const e = ble.get(args.id);
            if (e) {
              e.off();
              e.off = () => {};
              e.subscribed = null;
            }
            return null;
          }
          case 'ble_write': {
            const e = connection(args.id);
            const c = pick(e.dev, args.service, args.characteristic, (p) => p.write || p.writeWithoutResponse);
            const p = props(c.bits);
            if (!p.write && !p.writeWithoutResponse) throw 'not supported: the characteristic cannot be written';
            await e.host.write(Uint8Array.from(args.data));
            return null;
          }
          case 'ble_disconnect':
            // Local disconnect: the bridge stops its watcher first, so no ble://disconnected.
            forgetBle(args.id);
            return null;
          case 'serial_list':
            return [{ path: 'COM7', name: 'USB-SERIAL CH340 (COM7)', usbVendorId: 0x1a86, usbProductId: 0x7523 }];
          case 'serial_open': {
            if (args.path !== 'COM7') throw 'The system cannot find the file specified.';
            if ([...serial.values()].some((e) => e.path === args.path)) throw 'Access is denied.';
            const handle = `serial-${++seq}`;
            const e = await simulator('daly');
            e.path = args.path;
            e.off = e.host.on('data', (b) => emit('serial://data', { handle, data: Array.from(b) }));
            serial.set(handle, e);
            return { handle, warnings: [] };
          }
          case 'serial_write': {
            const e = serial.get(args.handle);
            if (!e) throw 'Serial port is not open';
            await e.host.write(Uint8Array.from(args.data));
            return null;
          }
          case 'serial_close':
            forgetSerial(args.handle);
            return null;
          default:
            throw `Unknown command ${cmd}`;
        }
      },
    },
    event: {
      async listen(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return () => listeners.get(event)?.delete(handler);
      },
    },
  };

  window.__tauriMock = {
    /** The device dropped the link: the bridge forgets the connection, then reports it. */
    dropBle(id) {
      if (!ble.has(id)) return false;
      forgetBle(id);
      emit('ble://disconnected', { id });
      return true;
    },
    /** A read error (adapter unplugged): the bridge forgets the port, then reports it. */
    dropSerial(handle, reason = 'The device was unplugged') {
      if (!serial.has(handle)) return false;
      forgetSerial(handle);
      emit('serial://closed', { handle, reason });
      return true;
    },
    get connectedBle() {
      return [...ble.keys()];
    },
    get openSerial() {
      return [...serial.keys()];
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    /** The user closes the window: run the close handlers like Tauri, then "destroy" the window. */
    async requestClose() {
      let prevented = false;
      const event = { preventDefault: () => (prevented = true), isPreventDefault: () => prevented };
      for (const handler of [...closeHandlers]) await handler(event);
      if (!prevented) destroyed++;
      return { handlers: closeHandlers.size, destroyed };
    },
    /** Invoke calls per command, for example calls.history_append. */
    get calls() {
      return { ...calls };
    },
    get historyKeys() {
      return [...history.keys()];
    },
    historyLines(key) {
      return [...(history.get(key)?.lines ?? [])];
    },
    historyMeta(key) {
      return history.get(key)?.meta ?? null;
    },
    /** Files written by save_file: { name, path, bytes, data (the base64 text as sent) }. */
    get savedFiles() {
      return saved.map((f) => ({ ...f }));
    },
  };
})();
