/*
 * Browser-side imitation of the Tauri bridge (docs/tauri.md) for the headless smoke test.
 * Injected before the app loads, it implements the same commands and events as the Rust side,
 * and connects them to the app's own protocol simulators, so the desktop code path
 * (TauriBleProvider, TauriSerialProvider, the scan and port list UI) runs end to end without Rust.
 *
 * Bluetooth: two devices are "advertised"; the JK one exposes two FFE1 characteristics like real
 * JK modules (write-only first, notify second). Serial: one CH340 port with a Daly classic BMS.
 */
(() => {
  /** @type {Map<string, Set<(e: { event: string, payload: any }) => void>>} */
  const listeners = new Map();
  const emit = (event, payload) => {
    for (const h of [...(listeners.get(event) ?? [])]) h({ event, payload });
  };
  const FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';
  const FFE1 = '0000ffe1-0000-1000-8000-00805f9b34fb';
  const DEVICES = [
    { id: 'mock-jk', name: 'JK_PB2A16S20P', rssi: -58, services: [], manufacturerData: {}, driver: 'jk-ble' },
    { id: 'mock-ant', name: 'ANT-BLE16ZMUB', rssi: -71, services: [], manufacturerData: {}, driver: 'ant' },
  ];
  /** @type {Map<string, any>} */
  const ble = new Map();
  /** @type {Map<string, any>} */
  const serial = new Map();
  let seq = 0;

  const transport = () => window.ubmsDebug.transport;

  async function simulator(driverId) {
    const def = window.ubms.registry.get(driverId);
    const { host, device } = transport().createLinkPair({ deviceChunkSize: 20 });
    await host.open();
    await device.open();
    const sim = def.demo.create(device);
    return { host, device, sim, off: () => {} };
  }

  async function bleEntry(id) {
    if (!ble.has(id)) {
      const dev = DEVICES.find((d) => d.id === id);
      if (!dev) throw new Error('Unknown device');
      ble.set(id, await simulator(dev.driver));
    }
    return ble.get(id);
  }

  window.__TAURI__ = {
    core: {
      async invoke(cmd, args = {}) {
        switch (cmd) {
          case 'ble_adapter_state':
            return 'on';
          case 'ble_scan_start':
            DEVICES.forEach((d, i) => setTimeout(() => emit('ble://device', d), 120 * (i + 1)));
            return null;
          case 'ble_scan_stop':
            return null;
          case 'ble_connect':
          case 'ble_services':
            return [
              {
                uuid: FFE0,
                characteristics: [
                  { uuid: FFE1, properties: { read: false, write: true, writeWithoutResponse: true, notify: false, indicate: false } },
                  { uuid: FFE1, properties: { read: true, write: false, writeWithoutResponse: false, notify: true, indicate: false } },
                ],
              },
            ];
          case 'ble_subscribe': {
            const e = await bleEntry(args.id);
            e.off();
            e.off = e.host.on('data', (b) => emit('ble://notify', { id: args.id, characteristic: FFE1, data: Array.from(b) }));
            return null;
          }
          case 'ble_unsubscribe':
            ble.get(args.id)?.off();
            return null;
          case 'ble_write': {
            const e = await bleEntry(args.id);
            await e.host.write(Uint8Array.from(args.data));
            return null;
          }
          case 'ble_disconnect': {
            const e = ble.get(args.id);
            e?.off();
            e?.sim?.stop?.();
            ble.delete(args.id);
            setTimeout(() => emit('ble://disconnected', { id: args.id }), 10);
            return null;
          }
          case 'serial_list':
            return [{ path: 'COM7', name: 'USB-SERIAL CH340 (COM7)', usbVendorId: 0x1a86, usbProductId: 0x7523 }];
          case 'serial_open': {
            const handle = `h${++seq}`;
            const e = await simulator('daly');
            e.off = e.host.on('data', (b) => emit('serial://data', { handle, data: Array.from(b) }));
            serial.set(handle, e);
            return handle;
          }
          case 'serial_write': {
            const e = serial.get(args.handle);
            if (!e) throw new Error('Port is not open');
            await e.host.write(Uint8Array.from(args.data));
            return null;
          }
          case 'serial_close': {
            const e = serial.get(args.handle);
            e?.off();
            e?.sim?.stop?.();
            serial.delete(args.handle);
            return null;
          }
          default:
            throw new Error(`Unknown command ${cmd}`);
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
})();
