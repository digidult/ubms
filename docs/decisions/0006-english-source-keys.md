# 0006. English source strings as translation keys

Status: accepted, 2026-11-18

## Context

All development and documentation are in English; the app must be available in Ukrainian,
Russian, German, French and more. Drivers declare many labels (settings, alarms) far from the UI.

## Decision

Use gettext style keys: the English text is the key and the fallback. The UI translates with
`t()`. Domain packages mark strings with the identity function `msg()` so they can be extracted
without depending on the UI. Catalogs are JSON per language; plurals use `Intl.PluralRules`
categories; numbers and dates use `Intl`. A checker script reports missing and unused keys,
placeholder mismatches and plural shape errors.

## Consequences

- Code stays readable and any missing translation degrades to correct English.
- Changing an English string orphans its translations; the checker shows them as unused and
  missing so they can be moved.
- Ambiguous words use a `context|text` key.
