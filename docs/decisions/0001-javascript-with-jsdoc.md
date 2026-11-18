# 0001. JavaScript modules with JSDoc types

Status: accepted, 2026-11-18

## Context

The project starts as an HTML/JS application. Protocol code benefits from types (byte offsets,
units, optional fields), but a mandatory compile step slows down experiments with real devices
and makes the code harder to drop into other environments.

## Decision

Write standard ES2022 modules in plain JavaScript. Describe shapes and signatures with JSDoc
(`@typedef`, `@param`, `@returns`). Editors type-check JSDoc out of the box; a `tsc --checkJs`
step can be added later without changing the sources.

## Consequences

- Source files run unchanged in browsers, Node (tests) and Tauri webviews.
- Lit reactive properties are declared with `static properties` and initialised in constructors
  (no decorators, no class fields for reactive properties).
- Type errors are not caught at build time until a checkJs step is introduced.
