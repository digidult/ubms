# Desktop plugins

A plugin adds drivers for devices that ubms does not support yet, without a new build of the app.
One `.js` file in a folder named `plugins` next to the desktop app is one plugin. Plugins work in
the desktop app only; `ubms.html` in a browser has none.

> **Security.** A plugin runs with the full rights of the app. It can talk to every connected
> device and change BMS settings, read and delete the chart history, save files, and reach the
> network. The app does not sandbox, sign or review plugins. Install only plugins you trust, from
> people you trust, and read the code when you can.

## Where the folder is

The app reads the folder once at the start; restart it after adding, changing or removing a file.
More, Plugins shows the folders of the running app, what was loaded and what failed and why.

| System | Folder |
| --- | --- |
| Windows, installed per user (setup exe) | `%LOCALAPPDATA%\ubms\plugins` (the folder of `ubms.exe`) |
| Windows, installed per machine (MSI or setup) | `C:\Program Files\ubms\plugins`, needs administrator rights to write |
| Windows, portable exe | `plugins` next to the exe |
| Linux, AppImage | `plugins` next to the `.AppImage` file (the executable itself runs from a temporary mount) |
| Linux, `.deb` and `.rpm` | `plugins` in the folder of the executable (`/usr/bin/plugins`), needs root rights |
| macOS | `plugins` next to `ubms.app` (for example `/Applications/plugins`), and `ubms.app/Contents/MacOS/plugins` inside the bundle |

The rule: Windows and Linux use `<folder of the executable>/plugins`, an AppImage
`<folder of the AppImage file>/plugins`. On macOS both folders are read, the one inside the bundle
first; the folder next to the bundle is the one users can reach without opening the bundle (a
change inside the bundle also breaks a code signature). A missing folder is not an error: then
there are no plugins.

Which files are read:

- every file whose name ends in `.js`, in any case (`acme.js`, `ACME.JS`), that is a regular file
  or a link to one; subfolders are not read;
- at most 1 MiB per file, UTF-8 text (a byte order mark is removed); other files are listed as
  not loaded;
- in file name order, case-insensitively, so a prefix such as `10-acme.js` sets the order;
- a file name that was already read from an earlier folder (macOS) is skipped.

## Loading

1. The built-in drivers are registered first, then the drivers of the plugins in file name order,
   and within a plugin in the order of its list. Detection tries candidates in registration order
   among equal ranks (Bluetooth candidates whose name matches rank first), so a plugin never
   delays the detection of a built-in device type with the same name rank.
2. All plugins are imported at the same time. Each one has 3 seconds to load and to return from
   `register(api)`; a plugin that takes longer is reported and ignored. The first screen appears
   when every plugin is done or has timed out.
3. Every driver definition is checked (see below). A bad definition is reported and skipped; the
   other definitions of the same plugin are still registered.
4. Problems never stop the app. They are listed in More, Plugins and written to the protocol log
   (source `plugins`), together with a line per loaded plugin.

Registered plugin drivers behave like built-in ones: they appear in the device type list of the
Connect screen (grouped by `family` and `vendor`), take part in automatic detection, and a driver
with a `demo` appears in the demo list. Choices that name a plugin driver are remembered like all
others.

## File format

A plugin is one ES module. Its default export is a function `register(api)`. It must not import
anything: the app loads the text from a Blob URL, where relative and package imports do not
resolve. Everything a driver needs comes from `api`.

`register(api)` returns (or resolves to) either `{ name, version, drivers }` or just the array of
driver definitions. `name` and `version` are optional strings shown in the Plugins view; without
a name the file name is shown.

```js
export default function register(api) {
  const { BaseDriver, msg } = api.core;
  const { FrameChannel, FrameAssembler, crc16Modbus } = api.transport;

  class AcmeDriver extends BaseDriver {
    // probe(), poll(), readInfo(), settings: see below and examples/plugins/example-bms.js
  }

  const definition = {
    id: 'acme-ble',
    family: 'acme',
    vendor: 'Acme',
    protocol: msg('Acme (Bluetooth)'),
    deviceType: 'bms',
    links: {
      ble: {
        profiles: [{ id: 'acme', service: 0xfff0, notify: 0xfff1, write: 0xfff2 }],
        namePrefixes: ['ACME-'],
      },
    },
    create: (ctx) => new AcmeDriver(definition, ctx),
  };

  return { name: 'Acme BMS', version: '1.0.0', drivers: [definition] };
}
```

## Driver definitions

Definitions follow the driver contract of the built-in drivers
(`packages/bms-core/src/driver.js`, see [architecture.md](architecture.md), "Driver contract").
The app checks each one:

| Field | Rule |
| --- | --- |
| `id` | required, 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit. Not `auto`, not the id of a built-in driver, of a driver of an earlier plugin, or of an existing device family (`jk`, `daly` and so on). |
| `family` | required, same characters as `id`. A new family gets its own group in the type list; an existing family (`jk`) adds the driver to that brand. |
| `vendor` | required, the brand name shown in the type list. |
| `protocol` | required, English protocol label, for example `Acme (Bluetooth)`. |
| `deviceType` | `bms`, `balancer` or `meter` (power meters and electronic loads). |
| `description` | optional English text shown when the driver is chosen. |
| `experimental` | optional boolean. |
| `links` | at least one of `ble` and `serial`. |
| `links.ble.profiles` | non-empty list of `{ id, label?, service, notify, write, writeMode?, chunkSize?, chunkDelayMs? }`. UUIDs as 16 or 32 bit numbers (`0xffe0`), short hex texts (`'ffe0'`) or full UUIDs. `writeMode`: `auto`, `with-response`, `without-response` or `prefer-without-response`; `chunkSize` 1 to 512 (default 20). |
| `links.ble.namePrefixes`, `namePatterns`, `advertisedServices`, `manufacturerIds`, `optionalServices` | optional lists: texts, regular expressions, UUIDs, company ids (0 to 65535), UUIDs. Prefixes and advertised services filter the device scan; a name match ranks the driver first in detection. |
| `links.serial.profiles` | non-empty list of `{ id, label?, baudRate, dataBits?, stopBits?, parity?, flowControl?, bufferSize?, signals? }`: `dataBits` 7 or 8, `stopBits` 1 or 2, `parity` `none`, `even` or `odd`, `flowControl` `none` or `hardware`. Most likely profile first. |
| `links.serial.note` | optional English wiring hint. |
| `links.serial.autoDetect` | optional; `false` keeps the driver out of automatic serial detection (it runs only when chosen), for protocols whose probe would disturb other devices. |
| `create(ctx)` | required function that returns a driver instance (a `BaseDriver` subclass) bound to `ctx.link`. |
| `demo` | optional simulator: `{ name, chunkSize?, create(link) }`. `create` gets the device end of an in-memory link and returns `{ stop() }`; `chunkSize` splits its answers like Bluetooth notifications. |

`ctx` holds `link` (an open link), `log` (the protocol log), `profileId` and `options` (for
example the RS485 address entered on the Connect screen as `options.address`).

## Driver instances

A driver extends `api.core.BaseDriver` and implements, as needed:

- `probe({ timeout })`: identify the device and return `{ variant?, confidence?, info? }`, or
  `null` when it does not answer this protocol. Return `null` on a timeout or a garbled answer.
- `start()`, `poll()`: `poll()` requests fresh data and calls `this.publish(snapshot)`.
- `readInfo()`: device identity through `this.publishInfo(info)`.
- `getSettingsSchema()`, `readSettings()`, `writeSetting(id, value)`, `runAction(id, arg)`.
- `capabilities`: `{ settings, writeSettings, streaming, pollIntervalMs, minPollIntervalMs? }`.
- `dispose()`: stop the frame channel and timers, then call `super.dispose()`.

Snapshots and device information use the unified model of `packages/bms-core/src/model.js`:
pack voltage, current, power, SOC, capacities, cycles, cell voltages, temperatures with ids and
kinds, switch states, alarms (`api.core.alarm(id)`) and `extra` values. The app derives cell
statistics, the charge state and time estimates itself.

A `FrameChannel` with a `FrameAssembler` handles framing, logging and request and answer
matching, so drivers never see partial frames:

```js
const channel = new FrameChannel(ctx.link, {
  createAssembler: ({ onFrame, onDiscard }) =>
    new FrameAssembler({ sync: [[0xeb, 0x90]], length: (buf) => (buf.length < 4 ? 0 : buf[3] + 6), validate, onFrame, onDiscard }),
  describe: (frame) => ({ name: 'Status answer', decode: () => parse(frame) }),
  log: ctx.log,
  source: definition.id,
}).start();
const frame = await channel.request(command, { match: (f) => f[2] === 0x81, timeout: 1000, retries: 1, name: 'Status request' });
```

## The api object

`api.version` is `1`. It goes up only when something changes incompatibly; a plugin can check it
and refuse to load (`throw` in `register`) when it needs another version.

| Entry | Contents |
| --- | --- |
| `api.core` | `BaseDriver`; `msg` (marks an English text as user visible); settings: `field(id, overrides)` (a canonical id brings label, unit, decimals and group), `buildSchema(fields, extraGroups)`, `relation(selfId, op, otherId, message)` (cross-field check), `fieldMap(schema)`; `alarm(id, extra)`; `cellStats(cells)`; the catalogs `SETTINGS`, `SETTING_GROUPS` and `ALARMS`. |
| `api.transport` | framing: `FrameAssembler`, `FrameChannel`, `fixedLengthAssembler`; bytes: `toBytes`, `hex`, `fromHex`, `concat`, `equals`, `startsWith`, `indexOf`, `u8`, `i8`, `u16le`, `u16be`, `i16le`, `i16be`, `u32le`, `u32be`, `i32le`, `i32be`, `ascii`, `asciiBytes`, `setU16le`, `setU16be`, `setU32le`, `setU32be`, `ByteReader`; checksums: `sum8`, `sum16`, `xor8`, `crc16Modbus`, `crc16CcittFalse`; Bluetooth UUIDs: `canonicalUuid`, `shortUuid`; time: `sleep`, `withTimeout`. |
| `api.drivers` | `SimBattery`, the battery model of the built-in simulators (cells, SOC, current profile, temperatures, balancing), for a `demo`. |
| `api.app` | `version`: the version of the app. |

The objects are frozen. The protocol log reaches a driver as `ctx.log`.

## Rules

- **English.** Labels, protocol names, descriptions, notes and error texts are English. Mark user
  visible texts with `api.core.msg()`. The app translates texts it knows (catalog labels such as
  `Cell overvoltage protection` or `Temperature 1`) and shows the others in English; plugins
  cannot bring translations yet.
- **Units and signs.** Values are engineering units: V, A, W, Ah, degrees Celsius, %, seconds.
  **Current is positive while charging** and negative while discharging; power has the same sign.
  Convert in the driver when a device counts the other way.
- **Probes must not change device state.** A probe only reads: no writes, no switching, no
  "enter setup mode" commands. During automatic detection the probe of every candidate runs on
  devices of other brands.
- **Settings** go through the schema, so the app validates, confirms, writes one value at a time
  and reads back. Use canonical ids from the catalog when the meaning matches; otherwise prefix
  the id with the family (`acme.sleep_minutes`). Show unverified parameters read only.
- **Keep the app responsive.** A plugin runs on the same thread as the user interface: no busy
  loops, no long synchronous work in `register`. Stop every timer in `dispose()` and in the
  simulator's `stop()`.
- **Protocol facts.** Describe frames, offsets and registers with their sources in the plugin;
  say in a comment when something is not verified.

## Example

[`examples/plugins/example-bms.js`](../examples/plugins/example-bms.js) is a complete plugin for a
made up protocol ("EXB1", no real device speaks it): framing with a CRC, a status, info and
settings protocol, a driver with probe, poll, device information, seven settings (canonical and
one of its own), the current sign conversion, and a simulator with a demo. Copy it into the
plugins folder and restart the app: More, Plugins lists it, and Connect, Demo offers "Example,
EXB1 example protocol".

`apps/web/test/plugins.test.js` loads the example through the same loader as the app and runs its
simulator in a session; a plugin of your own can be tested the same way with Node.
