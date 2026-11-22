# Development

## Requirements

- Node.js 22.12 or newer (24 recommended), npm 10 or newer. `npm test` passes glob patterns to
  `node --test` and the smoke test uses the global `WebSocket`; Node.js 20 has neither.
- A Chromium based browser (Chrome, Edge, Opera, Brave) for Web Bluetooth and Web Serial.

## Commands

```
npm install          # install dependencies and link the workspace packages
npm run dev          # Vite dev server on http://localhost:5173 (secure context for device APIs)
npm run build        # single-file production build: dist/index.html, also as dist/ubms.html
npm run preview      # serve the production build
npm test             # unit tests (node:test) for all packages, style checks
npm run smoke        # headless browser smoke test of dist/index.html, screenshots in .smoke/
npm run i18n:check   # translation coverage and consistency
```

`npm run smoke` starts Edge or Chrome in headless mode with a temporary profile; no browser
window appears. It opens the built file, runs the demo mode for every driver with a simulator,
visits every screen at phone and desktop sizes, and fails on console errors.

## Repository layout

```
apps/web/                 the application (views, controller, translations, Vite config)
packages/transport/       generic device link layer (to be extracted)
packages/ui/              generic UI kit (to be extracted)
packages/bms-core/        BMS domain core
packages/bms-drivers/     protocol drivers, simulators, test vectors
docs/                     architecture, decisions, protocols, UI, i18n, Tauri app, plugins
examples/plugins/         example plugin for the desktop app (docs/plugins.md)
scripts/                  smoke test, i18n checker, repository checks
```

## Adding a driver

1. Write or extend the protocol specification in `docs/protocols/<name>.md` (frame formats,
   offsets, settings registers, test frames with sources).
2. Add captured frames to `packages/bms-drivers/test/vectors/<name>.json`.
3. Create `packages/bms-drivers/src/<name>/`:
   - `protocol.js`: pure functions. Frame assembler factory, command encoders, parsers that turn
     frames into plain objects, `describe(frame)` for the log.
   - `settings.js`: the settings schema (use catalog ids from `@ubms/bms-core` where the meaning
     matches) and raw/engineering conversion.
   - `driver.js`: a `BaseDriver` subclass (probe, start, poll, readInfo, readSettings,
     writeSetting, runAction) and the definition (`id`, `family`, `vendor`, `protocol`,
     `links.ble`, `links.serial`, `create`, `demo`).
   - `simulator.js`: the device side of the protocol for demo mode and tests.
4. Register the definition in `packages/bms-drivers/src/index.js`.
5. Tests in `packages/bms-drivers/test/<name>.test.js`: parse every vector, round trip through
   the simulator, session level test over an in-memory link.
6. Mark every user facing string with `msg()`; run `npm run i18n:check` and add translations.

The desktop app also loads drivers from plugins without a new build: one `.js` file in the
`plugins` folder next to the app, see [plugins.md](plugins.md) and
`examples/plugins/example-bms.js`. The same definition and driver rules apply.

## Conventions

- English only in code, comments, docs, logs and source strings. Translations live in catalogs.
- Never use the em dash character anywhere (a test enforces it). Use commas, colons, parentheses.
- Values in the model and in settings are engineering units (V, A, W, Ah, degrees C, %, s).
- Current is positive while charging, negative while discharging.
- Indices in the model are zero based; the UI shows cells and sensors starting from 1.
- Probes must not change device state. Writes go through the settings schema so they are
  validated, confirmed by the user, logged and verified.

## Versions and releases

- Versions are numbered 0.1.x; x grows by one for every release. The version is written in every
  package.json, package-lock.json, the Tauri config and Cargo.toml; `node scripts/set-version.mjs`
  prints them, `node scripts/set-version.mjs 0.1.1` sets them all, and
  `scripts/test/version.test.js` fails when they differ.
- Every build shows its version, commit and date under More, About (the commit links to GitHub;
  a build from uncommitted changes shows the short hash with `-dirty`). Protocol log exports carry
  the same data.
- Releases and tags are made only on request. Steps:
  1. `node scripts/set-version.mjs 0.1.N`, commit "Release 0.1.N", push to main and wait for green
     CI and Desktop runs.
  2. `git tag v0.1.N && git push origin v0.1.N`.
  3. The workflow "Release" checks that the tag matches the version, runs the tests and the smoke
     test, builds `ubms.html` and the installers (Windows NSIS, MSI and portable exe; Linux deb, rpm
     and AppImage; macOS universal dmg) and publishes the
     GitHub release with generated notes. While the major version is 0 the release is marked as a
     pre-release (alpha). The workflow can rebuild an existing tag from the Actions tab; for a
     release that already exists it replaces the files and keeps the text.
- Without a release, the workflows "CI" (ubms.html) and "Desktop" (installers) keep the files of
  every push to main as artifacts for 90 days.
- The web app is deployed from `main` by Vercel (project `ubms-html`, output `dist`) to
  https://ubms-html.vercel.app. The service worker loads the page from the network first, so a new
  deployment shows on the next load; it falls back to the cached copy offline.

## Testing with hardware

- Bluetooth: open the dev server or the built file in Chrome or Edge, choose Bluetooth, pick the
  BMS. Close the vendor app first; most BMS accept one connection at a time.
- Serial: connect a USB-UART or USB-RS485 adapter. Check the BMS port voltage level (3.3 V TTL,
  5 V TTL or RS485) before wiring.
- Export the protocol log (Log, Export) and attach it to bug reports. The log contains the raw
  bytes, so new frames can be added to the test vectors. Decoded frames mask passwords and the
  export leaves password settings out, but the raw hex bytes of an entry still carry what was
  sent and received. A login frame (ANT 0x23, old ANT F1..F4, JBD 0x06) holds the BMS password
  in clear text: change the password before you publish a log. Masking these bytes in the
  ProtocolLog export is a separate task in `packages/transport`.
