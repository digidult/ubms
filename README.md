# ubms

Universal BMS viewer and configurator that runs in the browser. It connects to battery management
systems and active balancers over **Bluetooth** (Web Bluetooth) or a **serial port** (Web Serial:
UART and RS485 through USB adapters), shows live data and reads and writes the device settings.

- Works offline: the whole app is one HTML file. Copy it to a phone or laptop and open it.
- Phone friendly: bottom navigation, large touch targets, light and dark themes.
- One core for all devices: a unified data model and a settings schema; device specific
  parameters appear automatically.
- Automatic device type detection, or an explicit choice of brand and protocol.
- Protocol log down to single bytes, with decoded frames, filters and export.
- Languages: English, Ukrainian, Russian, German, French.
- Demo mode with simulated devices that speak the real protocols.

Supported devices (first stage): **JK BMS** (Jikong), **ANT BMS**, **Daly BMS**.

| Driver | Devices and protocol | Links | Settings (writable / read only / actions) |
| --- | --- | --- | --- |
| `jk-ble` | JK BMS JK02 (24S and 32S, hardware and firmware 11+ incl. JK-PB) and JK04 | Bluetooth | 32S: 64 / 30 / 9, 24S: 32 / 19 / 0, JK04: 7 / 0 / 0 |
| `jk-pb-rs485` | JK-PB inverter BMS, frame triggers and Modbus writes | RS485 | 47 / 45 / 0 |
| `jk-uart` | JK-B series, "4E 57" protocol on the GPS/UART port | UART, RS485 | 3 / 35 / 0 |
| `ant` | ANT BMS from about 2021 (7E A1 frames) | Bluetooth, UART | 49 + switches / 36 / 14 |
| `ant-legacy` | ANT BMS up to about 2020 (140-byte status) | Bluetooth, UART | switches / 34 / 1 |
| `daly-modbus` | Daly BMS with the newer Modbus protocol (D2 and 0x81 flavours) | Bluetooth, UART, RS485 | D2: 35 / 5 / 3, 0x81: 7 / 50 / 0 |
| `daly` | Daly BMS, classic 13-byte A5 protocol | Bluetooth, UART, RS485 | 37 / 14 / 1 |

Parameters whose encoding is not confirmed by captures or vendor documents are shown read only.
Every driver ships a simulator, so the demo mode shows each protocol without hardware. See
[docs/protocols](docs/protocols/) for the details and sources.

## Use

1. Get `ubms.html` (or build it: `npm install && npm run build`, file `dist/index.html`).
2. Open it in Chrome, Edge or another Chromium browser on a computer or an Android phone.
   On iPhone and iPad use a browser with Web Bluetooth support such as Bluefy.
3. Choose Bluetooth or Serial, optionally the BMS type, and connect.

Browser support for device access:

| Platform | Bluetooth | Serial |
| --- | --- | --- |
| Chrome, Edge, Opera on Windows, macOS, Linux, ChromeOS | yes | yes |
| Chrome on Android | yes | recent versions |
| Safari, Firefox | no | no |
| iOS with Bluefy | yes | no |

Device access needs a secure context: `https://`, `http://localhost` or a local file.

> Changing BMS settings is at your own risk. Wrong values can damage cells, the BMS or connected
> equipment.

## Desktop app

`apps/desktop` wraps the same app in Tauri 2 with native Bluetooth (btleplug) and serial ports
(serialport): devices are found by an in-app scan and a port list, no browser needed. Binaries
for Windows, Linux and macOS are built by GitHub Actions (workflow "Desktop"); see
[docs/tauri.md](docs/tauri.md) to build locally.

## Develop

```
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests
npm run build      # dist/index.html, single file
npm run smoke      # headless smoke test with screenshots
```

Read [AGENTS.md](AGENTS.md) and [docs/development.md](docs/development.md) before contributing.

## Documentation

- [Architecture](docs/architecture.md) and [decision records](docs/decisions/)
- [UI structure and navigation](docs/ui.md)
- [Protocols](docs/protocols/)
- [Translations](docs/i18n.md)
- [Desktop app plan (Tauri)](docs/tauri.md)

## Repository layout

```
apps/web               the application
apps/desktop           Tauri 2 desktop shell (Rust: btleplug, serialport)
packages/transport     device link layer: Web Bluetooth, Web Serial, Tauri bridge, framing, log
packages/ui            UI kit: Lit components, theme, i18n, router, store
packages/bms-core      BMS model, catalogs, driver contract, detection, session
packages/bms-drivers   JK, ANT and Daly drivers with simulators and test vectors
docs                   documentation
scripts                smoke test and checks
```

`packages/transport` and `packages/ui` contain nothing BMS specific and are meant to become a
separate base for other device web apps.

## License

[MIT](LICENSE). The protocol specifications in `docs/protocols` describe public facts from the
sources listed in each document; no third-party source code is copied into this repository.
