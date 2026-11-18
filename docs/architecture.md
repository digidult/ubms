# Architecture

ubms is a browser application that talks to battery management systems (BMS) and active
balancers directly from the page: over Bluetooth Low Energy (Web Bluetooth) or a serial port
(Web Serial: UART, RS485 through USB adapters). It shows live data and reads and writes device
settings. The production build is a single self-contained HTML file that works offline.

The code is split into layers with strict dependency rules, so the generic parts can move to their
own repository and the same drivers and UI can run inside a Tauri desktop app later.

## Layers

```
                 +-------------------------------------------------------------+
  apps/web       |  ubms web app: views, controller, formatting, translations   |
                 +---------------------------+---------------------------------+
                                             |
            +--------------------------------+----------------------------+
            |                                |                            |
+-----------v-----------+      +-------------v------------+   +-----------v-----------+
| @ubms/bms-drivers     |----->| @ubms/bms-core            |   | @ubms/ui (generic)    |
| JK, ANT, Daly drivers |      | model, catalogs, driver   |   | Lit components, theme |
| + device simulators   |      | contract, registry,       |   | i18n, router, store   |
+-----------+-----------+      | session, settings schema  |   +-----------------------+
            |                  +-------------+-------------+
            |                                |
+-----------v--------------------------------v-------------+
| @ubms/transport (generic)                                 |
| Link, Web Bluetooth, Web Serial, Tauri bridge, memory     |
| links, framing, request/response channel, checksums, log  |
+-----------------------------------------------------------+
```

Dependency rules (enforced by review, see AGENTS.md):

| Package | May import | Must not import |
| --- | --- | --- |
| `@ubms/transport` | nothing | anything BMS or UI related |
| `@ubms/ui` | `lit` | transport, BMS packages |
| `@ubms/bms-core` | transport | UI, drivers |
| `@ubms/bms-drivers` | transport, bms-core | UI |
| `apps/web` | everything | |

`@ubms/transport` and `@ubms/ui` are the "device web app base" that will be extracted into a
separate repository. They contain no BMS knowledge and no BMS strings.

## Data flow

```
 device ── BLE notify / serial read ──> Link ──'data'──> FrameAssembler ──frame──> FrameChannel
                                         │                                           │
                                         └── ProtocolLog (tx, rx, frame, events) <───┘
                                                                                     │
                                         Driver (protocol parser) <──────────────────┘
                                           │  publish(snapshot), publishInfo(info)
                                           v
                                         BmsSession ──events──> AppController ──> Store ──> views
```

1. A **Link** delivers raw byte chunks exactly as the platform returns them (BLE notifications of
   20 to 244 bytes, serial reads of any size). Every chunk is logged as `rx`, every write as `tx`.
2. The driver's **FrameAssembler** finds frame starts (sync patterns), determines the length from
   the header, checks the checksum and emits complete frames. Garbage, stale partial frames and
   checksum failures are logged as `debug` entries. A bad frame only drops one byte, so a frame
   that starts inside a truncated one is still found.
3. The **FrameChannel** logs each frame with a lazy decoder (decoded only when someone looks at it
   in the log view or exports it), resolves pending requests and emits the frame to the driver.
   All sends are serialized, so polling never interleaves with a settings write on the wire.
4. The **driver** turns frames into a unified `BmsSnapshot` and `DeviceInfo`, and converts
   settings between engineering units and raw protocol values.
5. The **BmsSession** owns detection, the poll loop, reconnects, the latest snapshot, a short
   history buffer and the settings state. It emits events.
6. The **AppController** (apps/web) maps session events into an observable store; views subscribe
   to the slices they need and re-render only when those change.

## Unified model

`packages/bms-core/src/model.js` defines the shapes every driver produces:

- `BmsSnapshot`: pack voltage, current (positive while charging), power, SOC, SOH, capacities,
  cycles, per-cell voltages, per-cell resistance, per-cell balancing flags, temperatures with
  stable ids and kinds, switch states (charge, discharge, balance, heater, precharge), active
  alarms, and `extra` for driver specific values. Derived values (cell statistics, state, time to
  full or empty) are added by `deriveSnapshot()`.
- `DeviceInfo`: vendor, model, versions, serial number, manufacture date, uptime, extras.

Views render only what is present. A balancer without a current sensor simply has no current tile;
there are no device specific views for common data.

## Catalogs

`packages/bms-core/src/catalog.js` holds the shared vocabulary:

- `SETTING_GROUPS`: groups shown on the settings screen (cell voltage, pack voltage, charging,
  current, temperature, balancing, capacity, switches, system, identity, calibration, wire
  resistance, advanced, maintenance).
- `SETTINGS`: canonical setting ids (`cell.ovp`, `charge.ocp`, `balance.start_voltage`, ...) with
  English label, unit, decimals and group.
- `ALARMS`: canonical alarm ids with English label and default severity
  (`info`, `warning`, `protection`, `fault`).

Drivers reference catalog ids wherever the meaning matches, so the same concept looks and
translates identically on every BMS. Device specific parameters use a driver prefix
(`jk.smart_sleep_hours`) and bring their own label.

## Settings schema

Settings are declarative (`packages/bms-core/src/settings.js`). A driver returns a
`SettingsSchema` (groups of fields) and implements `readSettings()`, `writeSetting(id, value)` and
`runAction(id)`. A field has a type (`number`, `boolean`, `enum`, `text`, `action`), unit, limits,
step, options, read-only and danger flags, an `advanced` flag, help text and an optional
cross-field validator (for example "recovery must be below protection") and an optional
non-blocking warning check (for example "pack limit does not match cell limit times cell count"),
which is shown next to pending edits and repeated in the write confirmation. Driver private data such
as the register address and scaling lives in `meta`.

The settings screen is generated from the schema: no device specific UI code is needed for new
parameters. Writes go through `BmsSession.writeSettings()`, which validates, writes one value at a
time, reads everything back and reports per field whether the device really took the value.

## Driver contract

`packages/bms-core/src/driver.js`. A **definition** is static metadata plus a factory:

- `id`, `family` (brand: `jk`, `ant`, `daly`), `vendor`, `protocol` label, `deviceType`
  (`bms` or `balancer`).
- `links.ble`: GATT profiles (service, notify and write characteristics, write mode, chunk size),
  advertised name prefixes and patterns, advertised services, manufacturer ids.
- `links.serial`: serial profiles to try (baud rate, framing), most likely first.
- `create(ctx)`: returns a driver instance bound to an open Link.
- `demo` (optional): a device simulator that speaks the real protocol, used by the demo mode and
  by tests.

A driver **instance** (subclass of `BaseDriver`) implements `probe()` (identify without changing
device state, return the variant), `start()`, `poll()`, `readInfo()`, the settings methods, and
reports `capabilities` (settings, writeSettings, streaming, recommended poll interval).

## Device selection and auto-detection

Selection in the UI is `auto`, a whole brand (`family:jk`) or one protocol (`jk-ble`). The
`family:` prefix matters when a driver id equals its family id (`ant`, `daly`). Serial targets
may carry options such as the RS485 device address or board number (`options.address`,
`options.board`); the same options object is shared by every driver instance created for that
target, so drivers can keep app-local values (for example a password) across reconnects.

**Bluetooth.** `DriverRegistry.bleRequest()` builds the chooser request: name prefix and
service filters of the selected drivers, plus every GATT service any candidate might use as
`optionalServices` (Web Bluetooth only exposes listed services). When the selection cannot be
filtered, the UI says so and the chooser lists all devices; the user can also force "show all".
After connecting, the session lists the available services, ranks candidates
(`bleCandidates()`: name matches first, then registration order) and probes them one by one on
their GATT profile. The first driver whose probe returns a result wins.

**Serial.** Browsers cannot see what is behind a USB-UART adapter, so the chooser cannot filter by
BMS type (the UI states this). The session opens the port with each candidate profile (protocol
and baud rate) and probes. Choosing the type in the UI only shortens the list.

**Demo and replay.** A direct Link (in-memory pair with a simulator on the other side) is attached
with an explicit driver id.

## Session lifecycle

```
idle ──connect──> connecting ──> detecting ──> connected ──link lost──> reconnecting ──> connected
  ^                   │              │             │                         │
  └──── disconnect ───┴──── error <──┴─────────────┴──────── gave up ────────┘
```

- The poll loop calls `driver.poll()` every `pollIntervalMs` (default 1 s, at least the driver's
  `minPollIntervalMs`), inside the session mutex shared with settings writes and actions.
- BLE links reconnect automatically with exponential backoff (up to 6 attempts), re-probing the
  device with the same driver and profile.
- Each connect increments a generation counter, so late results of a cancelled connect or an old
  poll never touch the new state.

## Protocol log

`ProtocolLog` (generic, in transport) keeps a bounded list of entries: `tx`, `rx`, `frame`,
`event`, `warn`, `error`, `debug`. Frame entries carry a lazy decoder, so the log costs almost
nothing until someone expands an entry. The log view filters by kind and text or hex, pauses,
expands entries into a hex dump plus decoded fields, exports JSON (raw bytes as hex plus decoded
frames) or text, and opens saved logs for offline analysis.

## UI structure

See [ui.md](ui.md). The app is split by mode (not connected, connected) and by purpose
(overview, cells, settings, log, more). Phones get a bottom tab bar with at most five items;
wide screens get a side rail. Settings are grouped: a group list, then one group per screen on
phones, master and detail side by side on desktop. Device specific settings appear as extra
fields or groups from the driver schema.

## Internationalization

English source strings are the translation keys (`t('Cell overvoltage protection')`). Domain
code marks strings with `msg()` and the UI translates them when rendering. Catalogs are separate
JSON files per language; missing entries fall back to English. See [i18n.md](i18n.md).

## Persistence

Only preferences (language, theme, poll interval, log size, last selections) and the list of
recent devices are stored, in `localStorage` under the `ubms:` namespace, through a guarded
wrapper that falls back to memory when storage is blocked. Nothing leaves the device.

## Build

Vite builds one HTML file with all scripts, styles, icons and translations inlined
(`vite-plugin-singlefile`). Hash routing keeps it working from `file://`, from any static host
and in a Tauri webview. See [decisions/0005-single-file-build.md](decisions/0005-single-file-build.md).

## Desktop (next stage)

The Tauri app will reuse `apps/web` unchanged. Only the transport providers differ:
`TauriBleProvider` and `TauriSerialProvider` implement the same device handle and Link interfaces
on top of Rust commands (btleplug, serialport). The command and event contract is in
[tauri.md](tauri.md).
