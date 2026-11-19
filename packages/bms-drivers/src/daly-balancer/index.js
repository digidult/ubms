import { dalyBalancerDefinition } from './driver.js';

/**
 * Driver definitions of the Daly active balancers (docs/protocols/daly-balancer.md), in detection
 * order. They belong to the family `daly`, so "Daly, any protocol" (`family:daly`) covers them,
 * but the code lives in its own folder and shares nothing with `../daly/`.
 *
 * Detection (spec 11.3) is read only: the 62 register status read `D2 03 00 00 00 3E`, accepted
 * only with the balancer signature (current 30000, SOC, capacity, cycles, charge state and both
 * MOSFET flags 0), then the settings read `D2 03 00 80 00 29`: all four current limits at 30000
 * give confidence 1, any other limit returns null (a Daly BMS), no reply gives confidence 0.7.
 *
 * Registration (spec 11.5): register these definitions first inside the Daly family, before
 * `daly-modbus` and `daly`. In packages/bms-drivers/src/index.js:
 * `[...jkDrivers, ...antDrivers, ...dalyBalancerDrivers, ...dalyDrivers, ...atorchDrivers]`.
 * - `daly-modbus` accepts a balancer (its D2 probe checks only the frame and the cell
 *   plausibility), and the balancer uses the same Daly advertising data, so with equal name rank
 *   the registration order decides; this mirrors `jk-balancer-ble` before `jk-ble`.
 * - `daly` (classic A5) must come after the balancer on serial: balancers answer A5 0x90 and 0x94
 *   on the UART, so `daly` would take them and then stall on 0x93.
 * - Cost: a Daly D2 BMS pays one extra 62 register read (63 to 501 ms on BLE); a classic-only Daly
 *   device or an 0x81 pack pays up to two balancer timeouts (about 3 s on BLE, 2.4 s on serial)
 *   before `daly-modbus` starts. Alternative if that delay matters: the balancer after
 *   `daly-modbus` but before `daly`, plus a `daly-modbus` probe that returns null for the balancer
 *   status signature (`statusSignature` in ./protocol.js) in automatic detection.
 * - The first registered definition of a family names the family in the type selector: this
 *   definition uses the vendor `Daly BMS` of the Daly BMS definitions, so the label stays the same
 *   with the balancer first. The demo of this definition does not change the default demo as long
 *   as the JK family stays first.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const dalyBalancerDrivers = [dalyBalancerDefinition];

export { dalyBalancerDefinition, DalyBalancerDriver, DALY_BALANCER_VENDOR, balancerInfo, balancerSnapshot } from './driver.js';
export { createDalyBalancerSimulator } from './simulator.js';
export { buildDalyBalancerSchema, decodeBalancerSettings, rawSettingValue, settingWriteFrame } from './settings.js';
export { VARIANT as DALY_BALANCER_VARIANT, statusSignature as dalyBalancerStatusSignature } from './protocol.js';
