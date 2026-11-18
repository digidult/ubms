import { dalyDefinition, dalyModbusDefinition } from './driver.js';

/**
 * Driver definitions of this family, in detection order. The Modbus protocol is probed first, as
 * in the safe probe sequence of the specification (docs/protocols/daly.md 11.2): a classic-only
 * module ignores Modbus reads, and newer boards that speak both get the richer Modbus data.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const dalyDrivers = [dalyModbusDefinition, dalyDefinition];

export {
  dalyDefinition,
  dalyModbusDefinition,
  DalyClassicDriver,
  DalyModbusDriver,
  CurrentSign,
  classicSnapshot,
  d2Snapshot,
  p81Snapshot,
  VARIANT,
  DALY_VENDOR,
} from './driver.js';
export { createDalySimulator, createDalyModbusSimulator } from './simulator.js';
