# Protocols

Implementation-ready specifications of every supported protocol, with sources and real frames.
Each specification is the reference for its driver in `packages/bms-drivers/src/<family>/`, and
the frames in `packages/bms-drivers/test/vectors/<family>.json` are the reference for its tests.

| Family | Specification | Variants | Links |
| --- | --- | --- | --- |
| JK BMS (Jikong) | [jk.md](jk.md) | JK02 24S and 32S (BLE), JK04 (BLE), JK-PB RS485 Modbus, JK-B UART "4E 57" | BLE, RS485, UART |
| ANT BMS | [ant.md](ant.md) | 2021+ protocol (7E A1 frames), legacy protocol (AA 55 AA FF status) | BLE, UART |
| Daly BMS | [daly.md](daly.md) | classic 13-byte protocol, newer Modbus style protocol | BLE, UART, RS485 |

## Drivers

| Driver id | Family | Specification sections | Detection |
| --- | --- | --- | --- |
| `jk-ble` | JK | JK02 24S and 32S, JK04 | device info request 0x97, variant from the software version and the first cell frame |
| `jk-pb-rs485` | JK | JK-PB RS485 | FC 0x10 frame trigger to the configured address |
| `jk-uart` | JK | 4E 57 UART | read-all command |
| `ant` | ANT | 2021+ protocol | status request 7E A1 01 |
| `ant-legacy` | ANT | legacy protocol | status request DB DB 00 00 00 00 (BLE) or 5A 5A 00 00 01 01 (UART) |
| `daly-modbus` | Daly | Modbus D2 and 0x81 | status register read (D2 first, then the 0x81 map) |
| `daly` | Daly | classic A5 | 0x90 request (twice, Daly modules sleep) then 0x94 |

Within a family the order above is also the detection order.

## Common notes

- **Byte order and units.** Each table states the byte order and scaling. Drivers convert to the
  unified model: volts, amperes, watts, ampere hours, degrees Celsius, percent, seconds. Current
  is positive while charging in the model, whatever the device convention is.
- **Shared Bluetooth UUIDs.** JK BMS and ANT BMS both use service `FFE0` with characteristic
  `FFE1`. Detection therefore always validates the answer (preamble, length, checksum, function)
  instead of trusting UUIDs or names.
- **Fragmentation.** BLE notifications carry 20 bytes unless a larger MTU was negotiated, and
  devices may split or merge frames arbitrarily. Every driver uses a `FrameAssembler` that finds
  the frame start, reads the length and validates the checksum (see
  [architecture](../architecture.md#data-flow)).
- **Safety.** Settings whose encoding is not confirmed by at least one capture or by the vendor
  documentation are shown read-only. Writes are always validated, confirmed by the user, logged
  and verified by reading back.
- **Status markers.** `unverified` in a specification means no capture or vendor document
  confirms the item; implementations treat such items conservatively.

## Adding captures

Export a protocol log from the app (Log, Export), find the frames of interest and add them to the
vector file with a short description and the decoded values you expect. Mention the device
model, hardware and firmware version.
