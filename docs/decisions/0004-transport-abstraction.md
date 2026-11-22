# 0004. Transport abstraction: providers, device handles and byte Links

Status: accepted, 2026-11-18

Note, 2026-11-22: the Tauri bridge mentioned below as the next stage is implemented
(`packages/transport/src/tauri.js`, `apps/desktop`); see [tauri.md](../tauri.md).

## Context

Devices are reached over Web Bluetooth, Web Serial and, in the next stage, native Bluetooth and
serial through Tauri. Protocol drivers must not depend on any of these APIs. Web Bluetooth also
needs to know every GATT service in advance, and detection may need to open several GATT profiles
or serial settings on the same device.

## Decision

Three levels:

1. **Provider** (per technology and backend): availability check and device selection
   (`request()` with the browser chooser, `known()` for already granted devices, `scan()` or
   `list()` for native backends).
2. **Device handle**: a selected device. BLE handles connect, discover services and open
   channels on a notify/write characteristic pair; serial handles open a Link with given serial
   options.
3. **Link**: an open byte channel with `write()`, `data`, `state` and `close` events. Writes are
   serialized and chunked (BLE MTU); every read and write goes to the protocol log.

Drivers only see a Link. Framing (`FrameAssembler`) and request/response helpers (`FrameChannel`)
are generic and live in the transport package.

## Consequences

- Tauri providers implement the same handle and Link interfaces (docs/tauri.md).
- In-memory links make the full stack testable in Node and power the demo mode.
- Detection can try several drivers on one device by opening and closing Links.
