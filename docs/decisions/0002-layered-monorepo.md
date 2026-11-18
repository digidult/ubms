# 0002. Layered monorepo with a generic device web app base

Status: accepted, 2026-11-18

## Context

The BMS app needs Web Bluetooth and Web Serial plumbing, logging and a mobile friendly UI kit.
These parts are useful for other device apps and will move to a separate repository. BMS logic
must be shared by every BMS type and later by a desktop app.

## Decision

Use npm workspaces with four packages and one app:

- `@ubms/transport`: generic device link layer (no BMS knowledge).
- `@ubms/ui`: generic UI kit (no BMS knowledge).
- `@ubms/bms-core`: BMS domain core (model, catalogs, driver contract, registry, session).
- `@ubms/bms-drivers`: protocol drivers and simulators.
- `apps/web`: the application.

Dependencies only point downwards (see docs/architecture.md). Generic packages contain no BMS
strings and no imports from BMS packages.

## Consequences

- Extracting `transport` and `ui` later means moving two folders and renaming the scope.
- Packages expose source files through `exports`; there is no per-package build.
- Cross-package changes stay atomic in one repository until the split.
