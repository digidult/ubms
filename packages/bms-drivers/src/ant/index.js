import { antDefinition, antLegacyDefinition } from './driver.js';

/**
 * Driver definitions of this family, in detection order: the 2021+ protocol first, because most
 * new boards also answer the old status request (spec 11.2).
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const antDrivers = [antDefinition, antLegacyDefinition];

export { antDefinition, antLegacyDefinition, AntDriver, AntLegacyDriver, newStatusSnapshot, oldStatusSnapshot } from './driver.js';
export { createAntSimulator, createAntLegacySimulator } from './simulator.js';
