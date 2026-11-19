import { jkDrivers } from './jk/index.js';
import { antDrivers } from './ant/index.js';
import { dalyDrivers } from './daly/index.js';
import { atorchDrivers } from './atorch/index.js';

/**
 * @typedef {{ name: string, chunkSize?: number, create: (link: import('@ubms/transport').Link) => { stop?: () => void } }} DemoDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition & { demo?: DemoDefinition }} DriverDefinitionWithDemo
 */

/**
 * All driver definitions, in detection order. Each family keeps its definitions in its own
 * folder; a definition may carry a `demo` entry with a device simulator that speaks the real
 * protocol over an in-memory link.
 *
 * Bluetooth candidates are ranked by name first (registry.js), so this order only decides among
 * equal ranks. Atorch meters only listen during detection (docs/protocols/atorch.md), and they
 * share the FFE0 / FFE1 profile with JK and ANT; they come last so that the default demo stays
 * `jk-ble` and an FFE0 device with an unknown name gets the quick JK and ANT probes before the
 * three second Atorch listen window. Atorch names (UD18, DL24, J7-C and so on) rank first anyway.
 * @type {DriverDefinitionWithDemo[]}
 */
export const drivers = [...jkDrivers, ...antDrivers, ...dalyDrivers, ...atorchDrivers];

export { SimBattery } from './common/sim-battery.js';
