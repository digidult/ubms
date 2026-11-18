# @ubms/bms-core

Domain core shared by every BMS and balancer driver.

| Module | Purpose |
| --- | --- |
| `model.js` | `BmsSnapshot`, `DeviceInfo` and friends; `cellStats()`, `deriveSnapshot()`. |
| `catalog.js` | Setting groups, canonical settings (`cell.ovp`, `charge.ocp`, ...) and alarms (`short_circuit`, ...). |
| `settings.js` | Declarative settings schema: `field()`, `buildSchema()`, validation, coercion, `relation()`. |
| `driver.js` | Driver definition and instance contract, `BaseDriver`. |
| `registry.js` | `DriverRegistry`: brand and protocol selection, Web Bluetooth chooser filters, candidate ranking. |
| `session.js` | `BmsSession`: connect, detect, poll, reconnect, settings read and verified write, actions. |
| `history.js` | Ring buffer of key values for trend charts. |
| `msg.js` | Translation marker for English strings. |

See [docs/architecture.md](../../docs/architecture.md) for the data flow and the session
lifecycle.
