# @ubms/bms-drivers

Protocol drivers, one folder per brand family:

| Folder | Definitions | Specification |
| --- | --- | --- |
| `jk/` | `jk-ble` (JK02 24S/32S, JK04), `jk-pb-rs485` (JK-PB, Modbus trigger), `jk-uart` (JK-B, "4E 57") | [docs/protocols/jk.md](../../docs/protocols/jk.md) |
| `ant/` | `ant` (2021+ protocol), `ant-legacy` (legacy protocol) | [docs/protocols/ant.md](../../docs/protocols/ant.md) |
| `daly/` | `daly-modbus` (D2 and 0x81 flavours), `daly` (classic A5) | [docs/protocols/daly.md](../../docs/protocols/daly.md) |

Each family folder follows the same layout:

- `protocol.js`: pure framing, encoders, parsers and log descriptions;
- `settings.js`: settings schema and value conversion;
- `driver.js`: driver classes and definitions;
- `simulator.js`: device side of the protocol for demo mode and tests;
- `index.js`: exported definitions in detection order.

Shared helpers live in `common/` (battery simulation model, alarm bit mapping).
Test vectors (real captured frames with sources and expected values) are in `test/vectors/`.
