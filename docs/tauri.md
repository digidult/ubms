# Desktop app with Tauri (next stage)

## Goal

A desktop app (Windows, macOS, Linux) that reuses the web app unchanged and adds what browsers
cannot do: native Bluetooth scanning without the browser chooser, Bluetooth on Firefox-like
platforms where Web Bluetooth is missing, full serial port lists with names and paths, and
background operation.

## Approach

- `apps/web` is loaded in the Tauri webview as is (the single-file build or the Vite dev server).
- Only the transport providers change. `@ubms/transport` already contains `TauriBleProvider` and
  `TauriSerialProvider` (`packages/transport/src/tauri.js`). They are selected automatically when
  `window.__TAURI__` exists (`withGlobalTauri: true`).
- Device handles and Links expose the same interface as the Web Bluetooth and Web Serial ones, so
  sessions, drivers, logs and views need no changes.
- The Rust side implements the command and event contract below with
  [btleplug](https://github.com/deviceplug/btleplug) and
  [serialport](https://github.com/serialport/serialport-rs).

What changes in the UI: with Tauri the Bluetooth chooser is replaced by an in-app scan list
(`TauriBleProvider.capabilities.scan === true`), and the serial chooser by a port list
(`TauriSerialProvider.list()`). These two small components are the remaining UI work.

## Command and event contract

All UUIDs are canonical 128-bit lowercase strings. Byte arrays are JSON arrays of numbers.

### Bluetooth

| Command | Arguments | Result |
| --- | --- | --- |
| `ble_adapter_state` | | `"on"`, `"off"` or `"unavailable"` |
| `ble_scan_start` | `{ filters: { namePrefixes: string[], services: string[] }, timeoutMs }` | `null`; devices arrive as `ble://device` events |
| `ble_scan_stop` | | `null` |
| `ble_connect` | `{ id, timeoutMs }` | services: `[{ uuid, characteristics: [{ uuid, properties: { read, write, writeWithoutResponse, notify, indicate } }] }]` |
| `ble_services` | `{ id }` | same as above |
| `ble_subscribe` | `{ id, service, characteristic }` | `null`; data arrives as `ble://notify` events |
| `ble_unsubscribe` | `{ id, service, characteristic }` | `null` |
| `ble_write` | `{ id, service, characteristic, data, withResponse }` | `null` |
| `ble_disconnect` | `{ id }` | `null` |

| Event | Payload |
| --- | --- |
| `ble://device` | `{ id, name, rssi, services: string[], manufacturerData: { [companyId]: number[] } }` |
| `ble://notify` | `{ id, characteristic, data }` |
| `ble://disconnected` | `{ id }` |

### Serial

| Command | Arguments | Result |
| --- | --- | --- |
| `serial_list` | | `[{ path, name, usbVendorId?, usbProductId?, serialNumber?, manufacturer?, product? }]` |
| `serial_open` | `{ path, baudRate, dataBits, stopBits, parity, flowControl, signals? }` | handle id (string) |
| `serial_write` | `{ handle, data }` | `null` |
| `serial_close` | `{ handle }` | `null` |

| Event | Payload |
| --- | --- |
| `serial://data` | `{ handle, data }` |
| `serial://closed` | `{ handle, reason }` |

## Rust side outline

```
src-tauri/
  src/main.rs        register commands, manage state (adapter, peripherals, open ports)
  src/ble.rs         btleplug: scan, connect, discover, subscribe, write; notification task
                     forwards to app.emit("ble://notify", ...)
  src/serial.rs      serialport: list, open (one reader thread per port), write, close
  tauri.conf.json    withGlobalTauri: true, frontendDist: ../dist
```

Notes:

- Notifications must be forwarded in order and without merging, exactly like Web Bluetooth
  delivers them; the JavaScript framers handle reassembly.
- Several characteristics may share one UUID within a service (JK BMS modules have a write-only
  FFE1 and a notify FFE1). `ble_subscribe` must pick the one with notify or indicate, `ble_write`
  the one with write or write without response, as the web transport does.
- Serial reads should be forwarded as soon as bytes arrive (short read timeout, for example 10 ms).
- Keep the Rust side protocol agnostic. All protocol logic stays in JavaScript drivers, so the
  web and desktop apps behave identically and share one protocol log format.
