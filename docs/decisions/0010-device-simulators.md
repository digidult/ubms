# 0010. Protocol level device simulators for demo mode and tests

Status: accepted, 2026-11-18

## Context

Most contributors and users do not have every BMS at hand. The UI, detection and logging should
be testable without hardware, and users should be able to try the app before connecting a device.

## Decision

Each driver can ship a simulator that speaks the real protocol on the device side of an
in-memory link: it parses commands and answers with frames encoded exactly like the device
(including BLE sized fragmentation). The demo mode connects through the normal session path, so
every screen and the protocol log work.

## Consequences

- Simulators double as encoders for round trip tests. Because a simulator and a parser written
  from the same understanding can share a mistake, drivers are also tested against real captured
  frames (`packages/bms-drivers/test/vectors/*.json`).
- Simulators are part of the single-file build (a few KB each).
