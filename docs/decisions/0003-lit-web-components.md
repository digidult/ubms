# 0003. Lit web components for the UI

Status: accepted, 2026-11-18

## Context

The UI must update in real time (cells, currents, alarms), run offline from a single file, work
on phones, and the UI kit should be reusable outside this app and inside a Tauri webview.
Options considered: plain DOM code, Preact with htm, Lit, Svelte or Vue (compilers).

## Decision

Use Lit 3: standard custom elements, tagged template literals (no compiler), efficient updates of
changed bindings only, about 6 KB gzipped. Components use shadow DOM; design tokens are CSS custom
properties declared on `:root`, which pass into every shadow root, so theming stays global.

## Consequences

- Components work in any framework or plain HTML, which matters for the extracted UI kit.
- State lives in small observable stores; a `StoreController` re-renders a component only when
  its selected slice changes.
- Styles are per component plus a shared stylesheet (`sharedStyles`).
- The UI kit package must keep side effects (component registration) enabled, otherwise the
  bundler drops components that are only used by tag name.
