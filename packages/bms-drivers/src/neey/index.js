import { neeyBleDefinition } from './driver.js';

/**
 * Driver definitions of this family in detection order: one Bluetooth definition, `neey-ble`, for
 * the NEEY_V1 and NEEY_V2 variants (docs/protocols/neey.md, "spec" below). There is no serial
 * definition, no usable wired port is known (spec 2.2).
 *
 * Detection (spec 11.2): listen 0.3 s, then one read request, the device info request
 * `AA 55 11 01 01 00 14 00 .. 26 FF`, with one retry, then once its xor8 form `.. FA FF` of the
 * old NEEY app (GW SW-1.1.0, spec 3.4). A unit is accepted only on a 100-byte answer
 * `55 AA 11 01 01 00 64 00` with a valid sum8, the end marker, a printable model and either a
 * hardware version "HW-..." or a model "GW-..." / "EK-...". Answers of JK (`55 AA EB 90`), ANT
 * (`7E A1`, `AA 55 AA FF`) and Atorch
 * (`FF 55`) devices fail that envelope, so a foreign device is rejected without looking at its
 * name (spec 11.4). The settings request that follows decides the variant by its length
 * (100 bytes NEEY_V1, 150 bytes NEEY_V2, spec 11.5) and starts the cell info stream.
 *
 * Registration (spec 11.6): register this family after the JK drivers and before ANT, that is
 * `drivers = [...jkDrivers, ...neeyDrivers, ...antDrivers, ...dalyDrivers, ...atorchDrivers]` in
 * packages/bms-drivers/src/index.js, giving the Bluetooth order jk-balancer-ble, jk-ble, neey-ble,
 * ant, ant-legacy, daly-modbus, daly, atorch. Candidates are ranked by name first, so a unit with
 * a default name (GW-..., EK-...) is probed as NEEY first anyway; the order only matters for
 * renamed or unnamed FFE0 devices:
 * - JK BMS are the most common FFE0 devices and their names are user defined, so the two JK
 *   probes stay first: a renamed NEEY waits for two quick JK timeouts instead of every renamed JK
 *   BMS waiting for the NEEY probe (0.3 s listen plus up to 2 x 1.5 s for the sum8 attempts and
 *   1 s for the xor8 attempt).
 * - ANT names keep the "ANT-BLE" form and rank the ANT drivers first, so NEEY before ANT costs
 *   ANT devices nothing and saves renamed NEEY units two ANT probes.
 * - Daly drivers use other GATT services; Atorch stays last as its index.js explains (passive
 *   listener, the default demo stays `jk-ble`, which comes before this family's demo).
 * The order does not affect safety: the NEEY probe is a read request, and the foreign probes a
 * NEEY unit can receive on FFE1 (JK 0x97, ANT `7E A1`, ANT legacy `DB DB 00 00 00 00`) fail the
 * NEEY address, length, checksum and end marker checks and cannot look like a write (function
 * 0x00 with command 0x05). That a NEEY unit ignores them is inferred from EK firmware dropping
 * malformed requests silently; no source tested it on hardware (unverified, spec 11.3).
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const neeyDrivers = [neeyBleDefinition];

export {
  neeyBleDefinition,
  NeeyBleDriver,
  NEEY_VENDOR,
  NAME_PATTERN,
  NAME_PREFIXES,
  balancerStateText,
  balancingFlags,
  neeyDeviceInfo,
  neeySnapshot,
} from './driver.js';
export { createNeeySimulator } from './simulator.js';
export { BATTERY_TYPES, BUZZER_MODES, buildNeeySchema, decodeNeeySettings, encodeSettingWrite } from './settings.js';
