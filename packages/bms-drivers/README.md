# @ubms/bms-drivers

Protocol drivers, one folder per brand family:

| Folder | Definitions | Specification |
| --- | --- | --- |
| `jk/` | JK BMS: JK02 and JK04 over Bluetooth, JK-PB over RS485 (Modbus trigger), JK-B over UART ("4E 57") | [docs/protocols/jk.md](../../docs/protocols/jk.md) |
| `ant/` | ANT BMS: 2021+ protocol and legacy protocol | [docs/protocols/ant.md](../../docs/protocols/ant.md) |
| `daly/` | Daly BMS: classic protocol and Modbus style protocol | [docs/protocols/daly.md](../../docs/protocols/daly.md) |

Each family folder follows the same layout:

- `protocol.js`: pure framing, encoders, parsers and log descriptions;
- `settings.js`: settings schema and value conversion;
- `driver.js`: driver classes and definitions;
- `simulator.js`: device side of the protocol for demo mode and tests;
- `index.js`: exported definitions in detection order.

Shared helpers live in `common/` (battery simulation model, alarm bit mapping).
Test vectors (real captured frames with sources and expected values) are in `test/vectors/`.
