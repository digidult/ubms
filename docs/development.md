# Development

## Requirements

- Node.js 20.19 or newer (22 or 24 recommended), npm 10 or newer.
- A Chromium based browser (Chrome, Edge, Opera, Brave) for Web Bluetooth and Web Serial.

## Commands

```
npm install          # install dependencies and link the workspace packages
npm run dev          # Vite dev server on http://localhost:5173 (secure context for device APIs)
npm run build        # single-file production build: dist/index.html
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
docs/                     architecture, decisions, protocols, UI, i18n, Tauri plan
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

## Conventions

- English only in code, comments, docs, logs and source strings. Translations live in catalogs.
- Never use the em dash character anywhere (a test enforces it). Use commas, colons, parentheses.
- Values in the model and in settings are engineering units (V, A, W, Ah, degrees C, %, s).
- Current is positive while charging, negative while discharging.
- Indices in the model are zero based; the UI shows cells and sensors starting from 1.
- Probes must not change device state. Writes go through the settings schema so they are
  validated, confirmed by the user, logged and verified.

## Testing with hardware

- Bluetooth: open the dev server or the built file in Chrome or Edge, choose Bluetooth, pick the
  BMS. Close the vendor app first; most BMS accept one connection at a time.
- Serial: connect a USB-UART or USB-RS485 adapter. Check the BMS port voltage level (3.3 V TTL,
  5 V TTL or RS485) before wiring.
- Export the protocol log (Log, Export) and attach it to bug reports. The log contains the raw
  bytes, so new frames can be added to the test vectors.
