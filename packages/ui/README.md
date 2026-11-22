# @ubms/ui

Generic UI kit for device web apps, built on Lit web components. Mobile first, light and dark
themes, offline friendly (no fonts or assets from the network). It contains nothing specific to
battery management systems and is meant to move to its own repository.

## Contents

| Module | Purpose |
| --- | --- |
| `theme.js` | Design tokens as CSS custom properties, `applyGlobalStyles()`, `applyTheme('auto'|'light'|'dark')`, `sharedStyles` (buttons, inputs, cards, chips). |
| `element.js` | `UiElement` base class (re-renders on locale change, `fire()` helper) and `define()`. |
| `i18n.js` | Translation runtime with English source keys, plurals (`Intl.PluralRules`), interpolation, context keys, number and date formatting, `negotiateLocale()`, `msg()` to mark texts translated later. |
| `store.js` | `Store` (observable state) and `StoreController` (re-render on selected slice changes). |
| `router.js` | `HashRouter` with optional parameters and query strings. |
| `storage.js` | Namespaced, guarded `localStorage` JSON wrapper with in-memory fallback. |
| `files.js` | `downloadFile()`, `pickFile()`, `copyText()`, `setFileSaver()` (a native save dialog, for example in a desktop shell). |
| `timeseries.js` | `createSeriesStore()` with the backends `indexedDbBackend(name)`, `tauriFileBackend()`, `memoryBackend()` and `fallbackBackend()`; `downsampleMinMax()`, `csvEscape()`, `toCsv()`. |
| `icons.js` | Inline SVG stroke icons: `icon('bluetooth')`. |
| `components/nav.js` | `<ui-nav>`: bottom tab bar on phones, side rail on wide screens (`brand`, optional `brand-icon`, `label`). |
| `components/widgets.js` | `<ui-stat>`, `<ui-ring>`, `<ui-sparkline>`, `<ui-switch>`, `<ui-segmented>`, `<ui-empty>`, `<ui-list-row>`. |
| `components/overlays.js` | `<ui-dialog>` (bottom sheet on phones), `confirmDialog()`, `toast()`, `<ui-hexview>`. |
| `components/chart.js` | `<ui-chart>`: canvas time series chart with crosshair, gaps and image export (`drawTo()`); `niceTicks()`, `timeTicks()`, `estimateInterval()`, `splitSegments()`, `nearestPoint()`. |

Translations of the kit's own strings live in `locales/<lang>.json`.

## Notes

- Reactive properties are declared in `static properties` and initialised in constructors.
- Importing the package registers the components (the package has side effects on purpose).
- Tokens are declared on `:root`, so they reach every shadow root; override them to restyle.
