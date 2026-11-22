# Desktop app with Tauri

## Goal

A desktop app (Windows, macOS, Linux) that reuses the web app unchanged and adds what browsers
cannot do: native Bluetooth scanning without the browser chooser, Bluetooth on Firefox-like
platforms where Web Bluetooth is missing, full serial port lists with names and paths, chart
history in files (next to a portable app or in the user profile), and background operation.

## Status

Implemented in `apps/desktop` (Tauri 2, [bluest](https://github.com/alexmoon/bluest) for
Bluetooth LE, [serialport](https://github.com/serialport/serialport-rs) 4 for serial ports):

- `src-tauri/src/ble.rs`: adapter state with reasons, scan with name prefix, service and
  manufacturer filters, connect by device id (no scan needed) with timeout and cancel, service
  discovery, notifications, writes, disconnect events.
- `src-tauri/src/serial.rs`: port list with USB ids, open with all serial options and output
  signals, one reader thread per port, writes, close.
- `src-tauri/src/history.rs`: the chart history (one NDJSON file per device plus a meta file, in
  a folder next to a portable app or in the user profile) and saving exports into Downloads.
- `src-tauri/src/plugins.rs`: reads the plugin files (`*.js`) of the `plugins` folder next to the
  app; the web app loads them ([plugins.md](plugins.md)).
- `src-tauri/Info.plist`: the macOS Bluetooth usage description.
- The web app shows an in-app scan list and a port list instead of the browser choosers when it
  runs inside Tauri (`AppController.nativeBle`, `nativeSerial`).
- The JavaScript side of the bridge is covered by the headless smoke test with an imitation of
  the bridge (`scripts/tauri-mock.js`) that feeds the real protocol simulators and mirrors the
  bridge's behaviour (see the mock's header). The Rust side is built and unit tested on Windows,
  Linux and macOS by `.github/workflows/desktop.yml`.

Build locally (needs Rust and the Tauri prerequisites of your platform, see
https://v2.tauri.app/start/prerequisites/):

```
npm install
npm run build              # web app into dist/
npm run desktop:build      # desktop binary (add -- --no-bundle to skip installers)
npm run dev                # in one terminal: Vite dev server
npm run desktop:dev        # in another terminal: desktop window on the dev server
```

The installers (NSIS, MSI, portable exe, deb, rpm, AppImage, dmg) are built by
`.github/workflows/desktop.yml` and published by `.github/workflows/release.yml`. Not done yet:
code signing, Android and iOS targets, and the hardware checks listed under "Open points".

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
web app shows `detail`. Only `on` counts as available. `tauri.js` listens to `ble://adapter`
(`TauriBleProvider.onAvailabilityChange`) and the web app then asks `ble_adapter_state` again,
so the Connect screen follows the adapter without waiting for a window focus.

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

### History storage

The Charts view keeps the values it reads in files (`tauriFileBackend` in
`packages/ui/src/timeseries.js`). The bridge knows nothing about batteries: a key is an opaque
string and a record is one JSON object per line.

| Command | Arguments | Result |
| --- | --- | --- |
| `history_info` | | `{ dir, portable, reason }`: the history folder, whether it is next to the app, and which rule chose it (English, for the app and for bug reports) |
| `history_append` | `{ key, lines: string[] }` | `null` |
| `history_read` | `{ key, from?, to? }` | `string[]`: the records with `from <= t <= to`, a missing bound is open |
| `history_write_meta` | `{ key, meta: string }` | `null` |
| `history_list` | | `[{ key, meta: string \| null, bytes, modified, last: number \| null }]`, most recently changed first |
| `history_remove` | `{ key }` | `null` |
| `history_prune` | `{ key, before }` | the number of removed lines |
| `save_file` | `{ name, data }` (`data` in base64) | the absolute path of the saved file |

Files:

- `<dir>/<encoded key>.ndjson` holds the records, one per line, in the order the app appends
  them. A line is a record when it starts with `{"t":<integer>` followed by `,` or `}` and ends
  with `}`; `JSON.stringify` of the app's records puts `t` first. Other lines (a line cut short
  by a crash) are skipped by `history_read` and dropped by `history_prune`, which counts them as
  removed.
- `<dir>/<encoded key>.meta.json` holds the meta string as given.
- Key encoding: `[A-Za-z0-9._-]` stays, every other UTF-8 byte becomes `~HH` (uppercase hex), so
  `sn:jk:ABC` is stored as `sn~3Ajk~3AABC` and no key can leave the folder. A name that Windows
  reads as a device (`CON`, `NUL`, `COM1` and so on) also gets its first character escaped
  (`~43ON`), so a portable folder works on every system. Empty keys and keys longer than 180
  encoded characters are refused. `history_list` decodes the file names and ignores files that
  are not encoded keys (temporary files, files copied in by hand).
- Keys that differ only in case share a file on Windows and macOS. The web app's keys come from
  serial numbers, device ids and names, where this does not happen in practice.

Semantics:

- `history_append` refuses the whole call when a line contains CR or LF (`History line <n>
  contains a line break`), skips empty lines, creates the folders it needs, and first ends the
  last line when the file does not end with a line break (a write cut short earlier), so the new
  record starts on a line of its own.
- `history_read` of a missing file returns `[]`. `from`, `to` and `before` are numbers (epoch
  milliseconds) compared with the integer `t`.
- `history_write_meta` and `history_prune` write a temporary file next to the target
  (`<name>.tmp-<pid>`), flush it to disk and rename it over the target, so a crash leaves the old
  or the new file. On Windows a rename that fails with access denied or a sharing violation (os
  error 5, 32 or 33: antivirus, the search indexer or a sync client such as OneDrive holds the
  target open) is tried again up to 5 times, after 50, 100, 150, 200 and 250 ms. `history_prune`
  rewrites nothing when nothing is removed; it runs when a device connects, if a retention is set.
- `history_remove` removes both files; missing files are fine.
- `history_list`: `bytes` is the size of the record file (0 when only the meta file exists).
  `modified` is the last change of the record file in epoch milliseconds, or of the meta file when
  there is no record file (the app rewrites the meta on every connect, so a connection without
  readings must not move it). `last` is the newest `t` among the complete record lines in the last
  16 KB of the record file, `null` without one; the Charts view ends a stored device's range there.
  Size and times come from the files themselves, not from the directory listing.
- All file work runs on the blocking thread pool, every key has its own lock (a long read of one
  device never delays the recorder of another), and errors are the system's text as a string,
  for example `Access is denied. (os error 5)`.
- `save_file` decodes the base64 data (standard or URL-safe alphabet, padding optional), reduces
  the name to a file name every system accepts (the last path component, no `<>:"/\|?*` or
  control characters, no leading or trailing dots and spaces, not a device name, at most 120
  characters with the extension kept) and writes the file into the Downloads folder
  (`download_dir()`). When there is no Downloads folder or writing there fails, it uses `exports`
  in the data folder (see below). A taken name gets ` (2)`, ` (3)` and so on before the
  extension. The web app saves exports through it (`setFileSaver` in `packages/ui/src/files.js`),
  because blob downloads do not work in every webview, and shows the returned path.

Data folder, chosen once per run by the first rule that applies:

1. `UBMS_DATA_DIR` is set (tests): history in `<UBMS_DATA_DIR>/history`, exports in
   `<UBMS_DATA_DIR>/exports`, `portable: false`.
2. A file named `portable` or `ubms.portable` is next to the executable (next to the AppImage
   file for an AppImage): portable, wherever the app is.
3. An AppImage (Linux) is portable in the folder of the AppImage file when that folder is
   writable, otherwise installed. The executable itself runs from a temporary mount. The app
   counts as an AppImage when `APPIMAGE` is set and the executable lies inside `APPDIR` (both
   made canonical, compared by whole components): the AppImage runtime sets both variables for
   its whole process tree, so a ubms from a .deb or a development build started from another
   AppImage (a terminal, an IDE) inherits them and must not use that AppImage's folder. The
   rule is `own_appimage` in lib.rs, shared with the plugin folders.
4. An executable in an install location is installed:
   - Windows: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%ProgramW6432%`, `%ProgramData%` and the
     whole of `%LOCALAPPDATA%`: the Tauri NSIS setup installs per user into
     `%LOCALAPPDATA%\ubms` (per machine into `%ProgramFiles%\ubms`), other setups use
     `%LOCALAPPDATA%\Programs`, and an exe started from inside a zip file runs from
     `%LOCALAPPDATA%\Temp`, where its data would get lost. A folder with the NSIS
     `uninstall.exe` next to the executable is an install location too (custom install folder).
   - macOS: any path inside a `.app` bundle, and `/Applications`.
   - Linux: `/usr`, `/opt`, `/snap`, and a Flatpak (`FLATPAK_ID` set).

   Paths compare by whole components (`/usrlocal` is not in `/usr`), case-insensitively on
   Windows, with the `\\?\` prefix removed. On Windows the executable and the install folders
   are compared both in the form Windows reports and in their long, resolved form
   (`fs::canonicalize`), and any match counts: `%TEMP%` is often in the short 8.3 form
   (`C:\Users\ALEXAN~1\...`) while `%LOCALAPPDATA%` is long.
5. Anywhere else the app is portable when its folder is writable (probed by creating and
   deleting a file), otherwise installed.

Portable: `<app folder>/ubms-data/history`, exports fallback `<app folder>/ubms-data/exports`.
Installed: `<app data folder>/history`, exports fallback `<app data folder>/exports`, where the
app data folder is Tauri's `app_local_data_dir()`: `%LOCALAPPDATA%\io.github.ubms.desktop` on
Windows (not the roaming `%APPDATA%`, which Windows copies at every logon and logoff of a roaming
profile), `~/Library/Application Support/io.github.ubms.desktop` on macOS,
`~/.local/share/io.github.ubms.desktop` on Linux. A development build runs from
`target/debug`, which is portable by these rules, so its data lands in
`target/debug/ubms-data`.

The history commands are app commands like the Bluetooth and serial ones: Tauri allows an app's
own commands in every window while the app defines no permissions for them.
`capabilities/default.json` holds `core:default` and `core:window:allow-destroy` (see "Closing
the window"). `scripts/tauri-mock.js` implements the same commands in memory for the headless
smoke test (data folder `C:/ubms-mock/history`, portable; a reload of the page keeps the data,
like files).

### Plugins

Plugins add drivers to the desktop app ([plugins.md](plugins.md)). The bridge only finds and
reads the files; `apps/web/src/plugins.js` evaluates them and checks their driver definitions.

| Command | Arguments | Result |
| --- | --- | --- |
| `plugins_list` | | `{ dirs: string[], plugins: [{ file, source }], errors: [{ file, error }] }` |

Semantics:

- `dirs` are the plugin folders in reading order, also missing ones (the Plugins view shows them),
  resolved once per run from the path of the executable: Windows and Linux
  `<folder of the executable>/plugins`; a Linux AppImage (`APPIMAGE` set and the executable
  inside `APPDIR`, the same rule as for the data folder) `<folder of the AppImage file>/plugins`;
  macOS `<name>.app/Contents/MacOS/plugins`, then
  `<folder that contains the .app>/plugins` (only when the executable is in a bundle). The rule
  is a pure function with unit tests (`plugin_dirs` in plugins.rs).
- `plugins`: every file whose name ends in `.js` in any case, that is a regular file or a link to
  one, directly in a folder (not in subfolders); `file` is the file name, `source` the UTF-8 text
  without a byte order mark. Sorted by file name, case-insensitively (ties by bytes).
- `errors`: a file larger than 1 MiB (`The file is larger than 1 MiB`), a file that is not UTF-8
  (`The file is not valid UTF-8 text`), a name already read from an earlier folder (`A plugin with
  this file name was already read from an earlier folder`), or a read error with the system's
  text. A folder that exists but cannot be listed gives an entry whose `file` is the folder path
  (`Could not read the plugin folder: ...`). A missing folder is no error.
- Read only, on the blocking thread pool; the command itself fails only when the path of the
  executable is unknown. `scripts/tauri-mock.js` imitates it for the smoke test with the files in
  `window.__tauriMockPlugins` (folder `C:/ubms-mock/plugins`).

### Closing the window

The web app writes chart readings in batches every 10 s. A write started on `pagehide` may not
reach the bridge while the webview is destroyed, so the app registers
`getCurrentWindow().onCloseRequested()` (global API, `withGlobalTauri`): the handler writes the
buffered readings (waiting at most 1.5 s), then Tauri's JavaScript API destroys the window, which
needs the `core:window:allow-destroy` permission. Without that permission the window could not
be closed. Not yet checked with the real app: whether readings were lost on close before, and
that closing still works on every platform (see Open points).

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
  src/history.rs     chart history files (NDJSON per key, meta, portable rule), save_file;
                     pure helpers with unit tests
  src/plugins.rs     plugins_list: plugin folders (pure rule with unit tests), plugin files
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
- The portable rule is covered by unit tests on paths; it has not been tried yet with the real
  NSIS and MSI installs, an AppImage, a .deb package and a macOS bundle. Not tried either: a
  .deb build started from another AppImage, and an exe started from an archive under a profile
  whose `%TEMP%` is in the 8.3 form.
- Closing the window: whether readings of the last 10 s were lost on close before the close
  handler, and that the window still closes (permission `core:window:allow-destroy`) on Windows,
  macOS and Linux. Check: connect, wait 3 s after a write, close, count the lines of the record
  file.
- Reading "All" of a week (about 300 000 lines, about 85 MB of JSON lines) through `history_read`
  is not measured in the app yet (only IndexedDB was). If it is slow or needs too much memory, the
  JavaScript side can read it in day-sized `[from, to]` windows with the same command.
