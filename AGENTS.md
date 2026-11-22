# Guidance for contributors and coding agents

## Project

ubms: a browser app and a Tauri desktop app that monitor and configure battery management
systems, balancers and meters over Bluetooth LE and serial ports (Web Bluetooth and Web Serial in
the browser, native in the desktop app). Start with
[docs/architecture.md](docs/architecture.md), then [docs/development.md](docs/development.md).

## Language and style

- Everything in the repository is English: code, comments, docs, commit messages, log texts and
  UI source strings. Other languages exist only as translation catalogs
  (`apps/web/src/locales/*.json`, `packages/ui/locales/*.json`), see [docs/i18n.md](docs/i18n.md).
- Never use the em dash character (U+2014) in any file. `scripts/test/text.test.js` fails on it.
  The en dash is fine for numeric ranges only (3.0–3.65 V). Prefer commas, colons, parentheses or
  two sentences. When code must detect the character, build it with `String.fromCharCode(0x2014)`.

## Architecture rules

- Dependencies point downwards: `apps/web` -> `bms-drivers` -> `bms-core` -> `transport`;
  `ui` is independent. `transport` and `ui` must stay free of BMS knowledge and BMS strings,
  because they will move to their own repository.
- Drivers never touch browser APIs. They receive an open `Link` and use `FrameAssembler` and
  `FrameChannel` from `@ubms/transport`.
- Every user visible string goes through `t()` (UI) or `msg()` (domain code). Keep the argument a
  literal so `npm run i18n:check` can extract it.
- Settings are declarative (`packages/bms-core/src/settings.js`). Use canonical ids from
  `packages/bms-core/src/catalog.js` when the meaning matches; otherwise prefix the id with the
  driver family (`jk.`, `ant.`, `daly.`).
- Protocol facts belong in `docs/protocols/<name>.md` with sources. Do not guess offsets or
  registers: when something is unverified, say so in the spec and in a code comment.

## Before you finish

```
npm test
npm run build
npm run smoke        # headless, no visible windows
npm run i18n:check
```

Tests and checks must not open visible windows. Browser checks run headless with a temporary
profile (see `scripts/smoke.mjs`); never start a browser executable without `--headless`.
