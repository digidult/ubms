# Desktop app with Tauri

## Goal

A desktop app (Windows, macOS, Linux) that reuses the web app unchanged and adds what browsers
cannot do: native Bluetooth scanning without the browser chooser, Bluetooth on Firefox-like
platforms where Web Bluetooth is missing, full serial port lists with names and paths, and
background operation.

## Status

Implemented in `apps/desktop` (Tauri 2, [bluest](https://github.com/alexmoon/bluest) for
Bluetooth LE, [serialport](https://github.com/serialport/serialport-rs) 4 for serial ports):

- `src-tauri/src/ble.rs`: adapter state with reasons, scan with name prefix, service and
  manufacturer filters, connect by device id (no scan needed) with timeout and cancel, service
  discovery, notifications, writes, disconnect events.
- `src-tauri/src/serial.rs`: port list with USB ids, open with all serial options and output
  signals, one reader thread per port, writes, close.
- `src-tauri/Info.plist`: the macOS Bluetooth usage description.
- The web app shows an in-app scan list and a port list instead of the browser choosers when it
  runs inside Tauri (`AppController.nativeBle`, `nativeSerial`).
- The JavaScript side of the bridge is covered by the headless smoke test with an imitation of
  the bridge (`scripts/tauri-mock.js`) that feeds the real protocol simulators and mirrors the
  bridge's behaviour (see the mock's header). The Rust side is built and unit tested on Windows
  and Linux by `.github/workflows/desktop.yml` (macOS on manual runs).

Build locally (needs Rust and the Tauri prerequisites of your platform, see
https://v2.tauri.app/start/prerequisites/):

```
npm install
npm run build              # web app into dist/
npm run desktop:build      # desktop binary (add -- --no-bundle to skip installers)
npm run dev                # in one terminal: Vite dev server
npm run desktop:dev        # in another terminal: desktop window on the dev server
```

Not done yet: installers and code signing, Android and iOS targets, and the hardware checks
listed under "Open points".

## Approach

- `apps/web` is loaded in the Tauri webview as is (the single-file build or the Vite dev server).
- Only the transport providers change. `@ubms/transport` contains `TauriBleProvider` and
  `TauriSerialProvider` (`packages/transport/src/tauri.js`). They are selected automatically when
  `window.__TAURI__` exists (`withGlobalTauri: true`).
- Device handles and Links expose the same interface as the Web Bluetooth and Web Serial ones, so
  sessions, drivers, logs and views need no changes.
- The Rust side implements the command and event contract below and stays protocol agnostic:
  it moves bytes, all BMS protocol logic lives in the JavaScript drivers.

## Command and event contract

All UUIDs are canonical 128-bit lowercase strings. Byte arrays are JSON arrays of numbers.
Commands that fail reject with an error text (a string); `tauri.js` turns it into an `Error`.

### Bluetooth

| Command | Arguments | Result |
| --- | --- | --- |
| `ble_adapter_state` | | `{ state, reason, detail }`, see below |
| `ble_scan_start` | `{ filters: { namePrefixes: string[], services: string[], manufacturerIds: number[] }, timeoutMs }` | `null` once the scan runs; devices arrive as `ble://device` events |
| `ble_scan_stop` | | `null` |
| `ble_connect` | `{ id, timeoutMs }` | services: `[{ uuid, characteristics: [{ uuid, properties: { read, write, writeWithoutResponse, notify, indicate } }] }]` |
| `ble_services` | `{ id }` | same as above |
| `ble_subscribe` | `{ id, service, characteristic }` | `null` once notifications are enabled; data arrives as `ble://notify` events |
| `ble_unsubscribe` | `{ id, service, characteristic }` | `null` |
| `ble_write` | `{ id, service, characteristic, data, withResponse }` | `null` |
| `ble_disconnect` | `{ id }` | `null` |

| Event | Payload |
| --- | --- |
| `ble://adapter` | `{ state, reason, detail }` when the adapter is switched on or off |
| `ble://device` | `{ id, name, rssi, services: string[], manufacturerData: { [companyId]: number[] } }` |
| `ble://notify` | `{ id, service, characteristic, data }` |
| `ble://disconnected` | `{ id }` |

Adapter state: `state` is `on`, `off`, `unauthorized`, `unavailable` or `unknown`. `reason` is
null when on, otherwise a code the Connect screen turns into a text (`no-adapter`,
`powered-off`, `permission-denied`, `permission-restricted`, `permission-pending`,
`permission-unknown`, `error`); `detail` is the system's error text or null. For `error` the
web app shows `detail`. Only `on` counts as available.

Semantics the JavaScript side relies on:

- Device ids are stable strings: the WinRT device id on Windows
  (`BluetoothLE#BluetoothLE<adapter>-<device>`), the peripheral UUID on macOS (stable per Mac),
  the address `AA:BB:CC:DD:EE:FF` on Linux. `ble_connect` opens a remembered id without a scan.
  Ids remembered by builds before bluest (another format) fail with "Device not found, scan
  again".
- `ble_connect` and `ble_services` list every characteristic separately, duplicates included: a
  new JK module shows two FFE1 entries in FFE0, one with write and write without response, one
  with read and notify.
- Characteristics resolve exactly like the Web Bluetooth transport: the first service with the
  UUID, in it the characteristic with the UUID that has a wanted property, else the first one
  with the UUID. Subscribe wants notify or indicate, write wants write or write without response.
  The choice is made once per connection and kept.
- `withResponse: true` uses a write request when the characteristic supports it, otherwise a
  write command; `false` the other way round. `tauri.js` sends `false` for the write modes
  `without-response` and `prefer-without-response`.
- `ble_connect` is idempotent for a connected device. It ends after `timeoutMs` (default 20 s)
  and is cancelled by `ble_disconnect` for the same id. A failed, timed out or cancelled connect
  leaves no link behind. `tauri.js` makes two attempts, like the web transport.
- `ble://disconnected` is sent once when the device or the system ends a connection. A local
  `ble_disconnect` sends no event. `ble_disconnect` also releases a device the bridge does not
  track any more (for example a connect that failed earlier).
- A scan merges the packets of one device (advertisement and scan response): `ble://device` comes
  when a device is new or its name, services or manufacturer data change, otherwise at most once
  per second. Starting a scan stops a running one; a scan ends after `timeoutMs` (default 15 s).
  On Linux, devices that BlueZ only remembers (no RSSI, not advertising) are not reported.
- Scan commands run one at a time in the order they arrive, and `ble_scan_stop` ends whatever scan
  runs. `tauri.js` therefore sends it only for its newest scan: the stop of a scan that a newer
  `ble_scan_start` replaced only removes its listener, because it would run after that start and
  end the new scan.
- Notifications are forwarded one by one, in order and without merging, exactly like Web
  Bluetooth delivers them; the JavaScript framers handle reassembly.

### Serial

| Command | Arguments | Result |
| --- | --- | --- |
| `serial_list` | | `[{ path, name, usbVendorId?, usbProductId?, serialNumber?, manufacturer?, product? }]` |
| `serial_open` | `{ path, baudRate, dataBits, stopBits, parity, flowControl, signals? }` | `{ handle, warnings: string[] }` |
| `serial_write` | `{ handle, data }` | `null` |
| `serial_close` | `{ handle }` | `null` |

| Event | Payload |
| --- | --- |
| `serial://data` | `{ handle, data }` |
| `serial://closed` | `{ handle, reason }` |

Semantics:

- The reader thread forwards bytes as soon as they arrive (10 ms read timeout) and starts before
  `serial_open` returns, so `tauri.js` listens first and keeps the events of the opening phase
  until it knows its handle.
- DTR and RTS are raised after opening unless `signals` says otherwise, as Web Serial and Unix
  do (Windows opens ports with both low). With hardware flow control RTS is left to the driver.
  A signal the adapter refuses is reported in `warnings` (the protocol log shows it) and does not
  fail the open.
- `serial://closed` means a read error (adapter unplugged, driver error); the bridge has
  forgotten the handle already. `serial_close` of an unknown handle is not an error. It returns
  after the reader thread has ended, so the port can be opened again at once.
- On macOS only the `/dev/cu.*` device of each port is listed (its `/dev/tty.*` twin waits for
  carrier detect).

### Reload and exit

When the webview starts loading a page (also a reload) and when the app exits, the bridge stops
the scan, cancels pending connects, disconnects every Bluetooth device and closes every serial
port. Exit waits at most 4 s.

## Rust side outline

```
src-tauri/
  src/lib.rs         register commands and state, cleanup on page load and exit
  src/ble.rs         bluest: adapter state, scan (Linux: bluer), connect, discover,
                     subscribe (one notification task per characteristic), write, disconnect
                     watcher; pure helpers with unit tests
  src/serial.rs      serialport: list, open (one reader thread per port), write, close
  Info.plist         NSBluetoothAlwaysUsageDescription (merged into the macOS bundle)
  tauri.conf.json    withGlobalTauri: true, frontendDist: ../../../dist, macOS minimum 10.15
```

Libraries and shims:

- bluest is pinned to commit `11df9e9e1114b97b4b864b9add730ab3e3f2701c` (main, Cargo version
  0.6.10, not on crates.io yet) with the feature `serde`, which turns a device id string back into
  a `DeviceId`. The release 0.6.9 depends on bluer 0.16.1, which does not compile with Rust 1.100.
  Replace the git dependency with the crates.io release once 0.6.10 exists.
- bluest keeps one object per native characteristic on every platform (btleplug, used before,
  keyed characteristics by UUID and lost one of two FFE1 characteristics).
- Linux scan: bluer 0.17.4 (`discover_devices_with_changes`) directly, because the bluest Linux
  scan has no RSSI, lists remembered devices and never updates. A connect that fails because
  BlueZ dropped the device object discovers the device for up to 10 s and tries once more.
- macOS permission: `+[CBManager authorization]` through objc2-core-bluetooth, because bluest
  reports every state other than PoweredOn only as unavailable.
- `rust-version` is 1.90 (tauri 2.12.7 and tauri-build 2.7.6). There is no Cargo.lock, so CI
  resolves the newest versions; recheck when tauri updates.

Platform notes:

- Windows 10 or later. The system connects on the first GATT call and closes the link when every
  object of the connection is dropped; the bridge keeps them together per connection.
- macOS 10.15 or later (`bundle.macOS.minimumSystemVersion`): the adapter reads the Bluetooth
  permission, which needs 10.15, and macOS ends an app without the usage description in
  Info.plist as soon as it touches Bluetooth. The first start shows the permission prompt.
- Linux: building needs `libdbus-1-dev`, `pkg-config` and (for serialport) `libudev-dev`; running
  needs BlueZ (tested upstream with 5.60) and permission to use `org.bluez` on the system bus
  (the default on desktop distributions). BlueZ keeps a link made over D-Bus after the app ends,
  which is why the bridge disconnects on exit.
- The state lock is never held across an await, and every serial port has its own lock, so one
  slow device never delays another.

## Open points

- Hardware checks (no device was available while writing the bridge): a new JK module (two FFE1)
  on Windows, macOS and Linux; an old JK module and an ANT or Daly device; power-cycling the BMS
  and reconnecting from Recent devices; connecting to a device that is off (no pending connection
  may remain afterwards); the macOS permission prompt and the denied state; the Linux scan shows
  RSSI and hides out-of-range devices.
- The macOS handling of duplicate characteristic UUIDs rests on reading the CoreBluetooth and
  bluest sources, not on a hardware run.
- Windows keeps a link alive only while the app holds GATT objects; with an active subscription
  this is expected to be stable, not yet observed on hardware.
