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

Supported devices (first stage): **JK BMS** (Jikong), **ANT BMS**, **Daly BMS**. See
[docs/protocols](docs/protocols/) for the protocol variants and their status.

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
packages/transport     device link layer: Web Bluetooth, Web Serial, Tauri bridge, framing, log
packages/ui            UI kit: Lit components, theme, i18n, router, store
packages/bms-core      BMS model, catalogs, driver contract, detection, session
packages/bms-drivers   JK, ANT and Daly drivers with simulators and test vectors
docs                   documentation
scripts                smoke test and checks
```

`packages/transport` and `packages/ui` contain nothing BMS specific and are meant to become a
separate base for other device web apps.
