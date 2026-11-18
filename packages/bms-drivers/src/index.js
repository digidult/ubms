import { jkDrivers } from './jk/index.js';
import { antDrivers } from './ant/index.js';
import { dalyDrivers } from './daly/index.js';

/**
 * @typedef {{ name: string, chunkSize?: number, create: (link: import('@ubms/transport').Link) => { stop?: () => void } }} DemoDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition & { demo?: DemoDefinition }} DriverDefinitionWithDemo
 */

/**
 * All driver definitions, in detection order. Each family keeps its definitions in its own
 * folder; a definition may carry a `demo` entry with a device simulator that speaks the real
 * protocol over an in-memory link.
 * @type {DriverDefinitionWithDemo[]}
 */
export const drivers = [...jkDrivers, ...antDrivers, ...dalyDrivers];

export { SimBattery } from './common/sim-battery.js';
