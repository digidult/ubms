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
 *
 * window.__tauriMock.dropBle(id) and .dropSerial(handle) simulate a remote close.
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

  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
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
  };
})();
