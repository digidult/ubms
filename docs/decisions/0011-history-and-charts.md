# 0011. Reading history and charts

Status: accepted, 2026-11-19

## Context

Users want charts of the values the app reads in real time, with CSV and image export, and the
data must survive app restarts and reconnects. It has to work in the single-file browser app
(opened from disk or a static host) and in the Tauri desktop app, where a portable copy keeps its
data next to the executable and an installed copy keeps it in the user profile. Ranges from
5 minutes to "all time" are needed, so a week of readings every 2 s (about 300 000 records) must
stay usable.

## Decision

### Layers

- `@ubms/bms-core` (`history.js`) knows what a record is: `historyRecord(snapshot)`, the chart
  series (`HISTORY_GROUPS`, `HISTORY_SERIES`, `cellSeries()`, `temperatureSeries()`,
  `availableSeries()`), the device meta (`historyDeviceMeta()`) and the device key
  (`deviceHistoryKey()`).
- `@ubms/ui` stays free of BMS knowledge: a generic time series store (`timeseries.js`:
  `createSeriesStore()` with IndexedDB, Tauri file and memory backends, min/max downsampling, CSV
  helpers), the `ui-chart` canvas component and `setFileSaver()`.
- The desktop bridge (`history.rs`) stores opaque keys and JSON lines; it knows nothing about
  batteries.
- `apps/web` wires it together: `HistoryRecorder` (`src/history/recorder.js`) and the Charts view
  (`src/views/charts.js`).

### Record format

One compact JSON object per reading, `t` (epoch ms, integer) always first, so a serialized record
starts with `{"t":<integer>` and the file backend can filter lines by time without parsing them:

```
{"t":1795107626604,"u":53.234,"i":-0.1,"p":-5.3,"soc":72,"cmin":3.326,"cmax":3.328,"cavg":3.327,
 "cdel":0.002,"c":[3.328,3.327,...],"tc":[24,21,21.6],"bi":0,"cap":201.6}
```

Values are rounded to their display precision (V 3 decimals, A 3, W 1, % 1, cell difference V 4,
°C 1, Ah 2). Absent values are omitted. In the cell (`c`) and temperature (`tc`) arrays a missing
value is `null`, so positions stay correct. About 250 bytes per record for 16 cells.

### Device key

- `sn:<family>:<serial number>` when the device reports a usable serial number (not empty, not
  `0`, not all zeros);
- otherwise `<link kind>:<link id>` when the link id is stable: a Bluetooth device id (Web
  Bluetooth per origin, the desktop bridge per system) or a desktop serial port path (`COM7`);
- otherwise `name:<driver id>:<device name>`. Web Serial ports have no stable identity (only USB
  ids of the adapter), so they use this rule. For a serial link the device name is the device's
  own name or model when it reports one, and the adapter name (`CH340 (1a86:7523)`) only
  otherwise, so batteries behind identical adapters do not share a history.

Several devices can share one serial link (packs on one RS485 bus). When the Connect screen sets
an RS485 address or board number, the link and name rules end with `#<address>`:
`serial:COM7#1` and `serial:COM7#2` are two histories. The meta stores the address, and the
device picker shows it when two stored devices have the same name and no serial number. A serial
number identifies a device by itself, so it gets no address.

After `connected` the recorder waits up to 5 s for a serial number and buffers the readings of
that time. Without one it uses the next rule; a disconnect before that resolves the key at once,
so no reading is lost.

### Storage per platform

| Platform | Store | Where |
| --- | --- | --- |
| Browser | IndexedDB database `ubms-history`: store `records` (key path `[key, t]`), store `meta` (key path `key`) | the browser profile, per origin |
| Desktop | `<encoded key>.ndjson` (one record per line) and `<encoded key>.meta.json` through the `history_*` commands | portable: `<app folder>/ubms-data/history`; installed: `<local app data dir>/history` (Windows `%LOCALAPPDATA%`, not the roaming profile) |
| No IndexedDB, or it cannot be opened (site data blocked, broken profile) | memory (`fallbackBackend`) | lost when the page closes; the Charts view and the Preferences say so |
| Demo sessions | a separate memory store | never persisted, also on the desktop |

Portable or installed is decided once per run by the bridge (details in [tauri.md](../tauri.md),
"Data folder"): `UBMS_DATA_DIR` for tests; a file `portable` or `ubms.portable` next to the
executable; an AppImage is portable in the folder of the AppImage file when that folder is
writable; an executable in an install location is installed (Windows `%ProgramFiles%`,
`%ProgramFiles(x86)%`, `%ProgramW6432%`, `%ProgramData%` and the whole of `%LOCALAPPDATA%`, because
the Tauri NSIS per-user setup installs into `%LOCALAPPDATA%\ubms` and an exe started from inside a
zip runs from `%LOCALAPPDATA%\Temp`; a folder with the NSIS `uninstall.exe`; macOS `.app` bundles
and `/Applications`; Linux `/usr`, `/opt`, `/snap` and Flatpak); anywhere else the app is portable
when its folder is writable. `history_info().reason` names the rule, the Preferences show it as a
tooltip.

### Recording

- At most one record per `historyIntervalMs` (default 2 s; 1, 2, 5, 10, 30 or 60 s), with 10 %
  tolerance for poll jitter.
- Records are written in batches: every 10 s, on disconnect, on `pagehide` and when the page
  becomes hidden. A crash loses at most the last 10 s. The desktop app also writes them when its
  window is closed, before the window goes (`onCloseRequested`, see [tauri.md](../tauri.md)).
- In the browser the app asks once, when the first readings of a device are stored, for persistent
  storage (`navigator.storage.persist()`), so the browser does not delete weeks of history under
  storage pressure. Chromium and Safari decide without asking the user, Firefox may ask. When it
  is not granted, the Preferences and the Charts footer say that the browser may delete it.
- The meta (name, vendor, protocol, driver, model, serial number, cell count, temperature labels)
  is written when the key is known and again when it changes.
- A live tail of the last 2 hours of the connected device (including what the store held from
  earlier connections) feeds the charts, so a live chart never reads the store.
- `historyEnabled` off: nothing is written, the charts still show the current connection.
- Retention `historyRetentionDays` (0 keeps everything; 7, 30, 90, 365): the records of a device
  older than that are deleted when the device connects.

### Charts view

- Data is read once per device or range change: a live range up to 2 hours comes from the live
  tail, "All" reads the store and appends the unwritten tail, a stored device reads the range
  that ends at its last record (the desktop bridge reads that time from the end of the record
  file; the change time of the files would move with every connect, because the meta is written
  again).
- All cards get the same time window (for "All" from the first record) and the same width left
  of the plot (the widest y labels of all cards), so their time axes and the crosshair line up,
  on screen and in the PNG.
- After a disconnect the view stays on that device. When nothing of it was stored (history off,
  nothing written), it says so instead of showing another device.
- Clearing the history of the connected device first drops the readings that are not written
  yet, then removes the stored ones: a write during the removal (seconds in IndexedDB) is queued
  behind it and holds only newer readings.
- Above 20 000 records the points are aggregated while they are built (first, lowest, highest and
  last value of 4 000 time slots), so a week does not turn into millions of point objects; the
  chart downsamples the same way to its pixel width, so peaks stay visible.
- CSV: the records of the visible range, one row per record: local time in ISO 8601 with offset,
  unix ms, then every series with data (each cell, each temperature by its label), comma
  separated, dot decimal, CRLF, UTF-8 with a byte order mark (the headers contain °C).
- PNG: all visible chart cards drawn with `ui-chart.drawTo()` into one canvas at 2x, with a header
  (device, range, export time), in the current theme.
- The desktop app saves exports through `save_file` (Downloads, else `exports` in the data folder)
  because blob downloads do not work in every webview, and shows the path.

## Consequences

- One code path for every driver: new drivers get charts without changes, as long as they fill
  the snapshot.
- Browser and desktop keep separate histories. Moving data between them is a CSV export only.
- A device whose serial number arrives later than 5 s after connecting is stored under its link
  or name key for that connection and under its serial number key on the next one; the two
  histories are not merged.
- Measured in headless Edge with 302 400 records of 16 cells: listing the stored devices takes
  about 0.9 s (counting records), reading "All" about 3.5 s, building the chart data about
  0.3 s, about 250 MB of JavaScript heap while the week is shown. A 2 hour range of the same
  device takes about 0.1 s. Deleting the history of such a device takes about 13 s in IndexedDB;
  the view shows that it is busy.
- On the desktop "All" of a week (about 300 000 lines over the bridge) is not measured yet. The
  file backend frees each line once it is parsed; if it is still too slow, it can read day-sized
  windows with the same command (see [tauri.md](../tauri.md), Open points).
- The portable rule is unit tested on paths only; real installers still need a check (see
  [tauri.md](../tauri.md), Open points).
