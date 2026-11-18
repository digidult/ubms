# 0007. Declarative settings schema and shared catalogs

Status: accepted, 2026-11-18

## Context

Every BMS has dozens of parameters with different registers, scaling and limits, and some
parameters exist on one brand only. The UI must present them uniformly, validate input, and stay
manageable on a phone.

## Decision

Drivers describe settings as data: groups of fields with type, unit, limits, options, help,
danger and advanced flags, optional cross-field validators, and driver private `meta`. Common
parameters use canonical ids from `SETTINGS` (bms-core catalog) so labels, units and translations
are shared. Values in the schema are engineering units; drivers convert to raw values.

## Consequences

- New parameters need no UI code.
- Settings can be exported, imported and compared generically (JSON by field id).
- Truly custom interactions (for example a calibration wizard) need an extension point later;
  for now they are modelled as `action` fields or number fields with a write-only meaning.
