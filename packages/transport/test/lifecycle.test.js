import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameChannel, Link, ProtocolLog, sleep, WebBleDevice, WebBluetoothProvider, WebSerialProvider } from '../src/index.js';

/** Run `fn` with a stand-in for `navigator` (Node defines a read-only one). */
async function withNavigator(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved);
    else delete globalThis.navigator;
  }
}

class ProbeLink extends Link {
  constructor({ failOpen = false, closeDelayMs = 0, closeError = null } = {}) {
    super({ kind: 'probe' });
    Object.assign(this, { failOpen, closeDelayMs, closeError, closes: 0, acquired: false });
  }

  async _open() {
    this.acquired = true;
    if (this.failOpen) throw new Error('open failed');
  }

  async _close() {
    await sleep(this.closeDelayMs);
    this.closes++;
    this.acquired = false;
    if (this.closeError) throw this.closeError;
  }

  async _write() {}
}

test('Link releases the transport once after a remote close, and close() waits for it', async () => {
  const link = new ProbeLink({ closeDelayMs: 20 });
  await link.open();
  const events = [];
  link.on('close', (e) => events.push(e));
  link._remoteClosed('gone');
  assert.equal(link.state, 'closed');
  await link.close();
  assert.equal(link.closes, 1);
  assert.equal(link.acquired, false);
  await link.close();
  assert.equal(link.closes, 1);
  assert.deepEqual(events, [{ reason: 'gone', remote: true }]);
  await link.open();
  await link.close();
  assert.equal(link.closes, 2);

  // Nobody calls close(): the cleanup still runs, and its failure stays inside the link.
  const unattended = new ProbeLink({ closeError: new Error('already gone') });
  await unattended.open();
  unattended._remoteClosed('gone');
  await sleep(5);
  assert.equal(unattended.closes, 1);
});

test('A failed Link.open() releases what _open() acquired and keeps the original error', async () => {
  const link = new ProbeLink({ failOpen: true, closeError: new Error('close failed') });
  await assert.rejects(link.open(), /open failed/);
  assert.equal(link.closes, 1);
  assert.equal(link.acquired, false);
  assert.equal(link.state, 'closed');
});

test('FrameChannel.request times the response after a slow write, without unhandled rejections', async () => {
  const unhandled = [];
  const onUnhandled = (/** @type {unknown} */ err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    class SlowLink extends Link {
      constructor() {
        super({ kind: 'slow' });
      }

      async _write(/** @type {Uint8Array} */ bytes) {
        await sleep(60);
        if (bytes[0] === 0x42) queueMicrotask(() => this._receive(Uint8Array.of(0x42)));
      }
    }
    const link = new SlowLink();
    await link.open();
    const channel = new FrameChannel(link, { createAssembler: ({ onFrame }) => ({ push: onFrame, reset() {} }) }).start();
    const frame = await channel.request(Uint8Array.of(0x42), { match: (f) => f[0] === 0x42, timeout: 20 });
    assert.equal(frame[0], 0x42);
    await assert.rejects(channel.request(Uint8Array.of(0x01), { match: () => false, timeout: 20, retries: 1 }), /No response/);
    await sleep(10);
    assert.deepEqual(unhandled, []);
    assert.equal(channel.waiters.size, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

/** Characteristic stand-in; startNotifications() fails once when asked to. */
function mockCharacteristic({ failStart = false } = {}) {
  return Object.assign(new EventTarget(), {
    uuid: '0000ffe1-0000-1000-8000-00805f9b34fb',
    properties: { notify: true, write: true },
    async startNotifications() {
      if (failStart) {
        failStart = false;
        throw new Error('GATT operation failed for unknown reason.');
      }
    },
    async stopNotifications() {},
    async writeValueWithResponse() {},
  });
}

/** BluetoothDevice stand-in that advertises shortly after watchAdvertisements(). */
function mockBleDevice(characteristic = mockCharacteristic()) {
  const service = { getCharacteristics: async () => [characteristic], getCharacteristic: async () => characteristic };
  const device = Object.assign(new EventTarget(), { id: 'dev-1', name: 'BMS', calls: [], watchAborted: false });
  device.gatt = {
    connected: false,
    async connect() {
      device.calls.push('connect');
      device.gatt.connected = true;
      return device.gatt;
    },
    disconnect() {
      device.gatt.connected = false;
    },
    getPrimaryService: async () => service,
  };
  device.watchAdvertisements = async ({ signal }) => {
    device.calls.push('watch');
    signal.addEventListener('abort', () => (device.watchAborted = true));
    setTimeout(() => {
      device.calls.push('advertisement');
      device.dispatchEvent(new Event('advertisementreceived'));
    }, 5);
  };
  return device;
}

test('A failed WebBleLink open removes its notification listener', async () => {
  const characteristic = mockCharacteristic({ failStart: true });
  const device = mockBleDevice(characteristic);
  device.gatt.connected = true;
  const log = new ProtocolLog();
  const handle = new WebBleDevice(device, log);
  const profile = { service: 0xffe0, notify: 0xffe1, write: 0xffe1 };
  await assert.rejects(handle.openChannel(profile), /GATT operation failed/);
  const link = await handle.openChannel(profile);
  characteristic.value = new DataView(Uint8Array.of(1, 2, 3).buffer);
  characteristic.dispatchEvent(new Event('characteristicvaluechanged'));
  const sources = log
    .entries()
    .filter((e) => e.kind === 'rx')
    .map((e) => e.source);
  assert.deepEqual(sources, [link.id]);
  await link.close();
});

test('WebBluetoothProvider keeps one handle per device and waits for an advertisement from granted devices', async () => {
  const device = mockBleDevice();
  const bluetooth = { requestDevice: async () => device, getDevices: async () => [device] };
  await withNavigator({ bluetooth }, async () => {
    const log = new ProtocolLog();
    const provider = new WebBluetoothProvider({ log });
    const [granted] = await provider.known();
    assert.equal((await provider.known())[0], granted);
    assert.equal(await provider.request({ acceptAllDevices: true }), granted);
    device.dispatchEvent(new Event('gattserverdisconnected'));
    assert.equal(log.entries().filter((e) => e.kind === 'warn' && /disconnected/.test(e.text)).length, 1);
    await granted.connect({ attempts: 1, timeoutMs: 1000 });
    assert.deepEqual(device.calls, ['watch', 'advertisement', 'connect']);
    assert.equal(device.watchAborted, true);
    // Once connected, the browser knows the device: later connects do not wait.
    await granted.disconnect();
    await granted.connect({ attempts: 1, timeoutMs: 1000 });
    assert.deepEqual(device.calls.slice(3), ['connect']);
  });

  // A device that never advertises (or a watch that never starts) only delays the connect attempt.
  const silent = mockBleDevice();
  silent.watchAdvertisements = () => new Promise(() => {});
  await withNavigator({ bluetooth: { getDevices: async () => [silent] } }, async () => {
    const log = new ProtocolLog();
    const [handle] = await new WebBluetoothProvider({ log }).known();
    await handle.connect({ attempts: 1, timeoutMs: 30 });
    assert.deepEqual(silent.calls, ['connect']);
    assert.ok(log.entries().some((e) => e.kind === 'warn' && /No advertisement/.test(e.text)));
  });
});

/** SerialPort stand-in; open() creates a readable stream that a test can end with an error. */
function mockSerialPort(info = { usbVendorId: 0x1a86, usbProductId: 0x7523 }) {
  const port = {
    opened: false,
    closes: 0,
    /** @type {ReadableStream | null} */
    readable: null,
    writable: null,
    /** @type {ReadableStreamDefaultController | null} */
    controller: null,
    getInfo: () => info,
    async open() {
      if (port.opened) throw new Error('The port is already open.');
      port.opened = true;
      port.readable = new ReadableStream({ start: (c) => void (port.controller = c) });
    },
    async close() {
      if (!port.opened) throw new Error('The port is already closed.');
      port.opened = false;
      port.readable = null;
      port.closes++;
    },
  };
  return port;
}

/** navigator.serial stand-in that counts its 'disconnect' listeners. */
function mockSerial(/** @type {any[]} */ ports) {
  const listeners = new Set();
  return {
    listeners,
    granted: ports,
    requestPort: async () => ports[0],
    async getPorts() {
      return this.granted;
    },
    addEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => type === 'disconnect' && listeners.add(fn),
    removeEventListener: (/** @type {string} */ type, /** @type {any} */ fn) => type === 'disconnect' && listeners.delete(fn),
  };
}

test('WebSerialLink closes the port after the stream ends, so it can be opened again', async () => {
  const port = mockSerialPort();
  const serial = mockSerial([port]);
  await withNavigator({ serial }, async () => {
    const handle = await new WebSerialProvider().request();
    const link = await handle.openLink({ baudRate: 9600 });
    assert.equal(serial.listeners.size, 1);
    const closed = new Promise((resolve) => link.on('close', resolve));
    // A fatal read error: the browser drops `readable` and errors the stream.
    port.readable = null;
    port.controller?.error(new Error('The device has been lost.'));
    assert.deepEqual(await closed, { reason: 'Serial stream ended', remote: true });
    await link.close();
    assert.equal(port.closes, 1);
    assert.equal(serial.listeners.size, 0);
    const again = await handle.openLink({ baudRate: 9600 });
    await again.close();
    assert.equal(port.closes, 2);
    // A link whose open fails must not close the port another link holds open.
    const holder = await handle.openLink({ baudRate: 9600 });
    await assert.rejects(handle.openLink({ baudRate: 9600 }), /already open/);
    assert.equal(port.opened, true);
    await holder.close();
  });
});

test('WebSerialPort ids follow the SerialPort and never pick another adapter after a reload', async () => {
  const a = mockSerialPort();
  const b = mockSerialPort();
  const serial = mockSerial([a]);
  await withNavigator({ serial }, async () => {
    const provider = new WebSerialProvider();
    const picked = await provider.request();
    // The only granted CH340: the id does not depend on the wrapper or the page.
    assert.equal(picked.id, 'usb-1a86-7523');
    const [known] = await provider.known();
    assert.equal(known, picked);
    // Two identical adapters: ids that only hold for this page.
    serial.granted = [a, b];
    const ids = (await provider.known()).map((h) => h.id);
    assert.notEqual(ids[0], ids[1]);
    assert.ok(ids.every((id) => id.startsWith('usb-1a86-7523-')));
    assert.deepEqual((await provider.known()).map((h) => h.id), ids);
    // A reload (fresh module) never hands out an id remembered for an ambiguous port.
    const reloaded = await import(`../src/web-serial.js?reload=${Date.now()}`);
    const after = (await new reloaded.WebSerialProvider().known()).map((/** @type {any} */ h) => h.id);
    assert.ok(after.every((/** @type {string} */ id) => !ids.includes(id)));
    serial.granted = [b];
    assert.equal((await new reloaded.WebSerialProvider().known())[0].id, 'usb-1a86-7523');
    // Without USB ids a port has nothing to identify it by.
    serial.granted = [mockSerialPort({})];
    assert.match((await provider.known())[0].id, /^serial-\w+-\d+$/);
  });
});
