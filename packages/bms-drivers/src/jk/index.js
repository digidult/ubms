import { jkBleDefinition, jkPbDefinition, jkUartDefinition } from './driver.js';

/**
 * Driver definitions of this family, in detection order: Bluetooth first, then the two serial
 * protocols (JK-PB Modbus triggers at 115200 baud, then the JK-B 4E57 port at 115200 baud).
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const jkDrivers = [jkBleDefinition, jkPbDefinition, jkUartDefinition];

export {
  jkBleDefinition,
  jkPbDefinition,
  jkUartDefinition,
  JkBleDriver,
  JkPbDriver,
  JkUartDriver,
  jk02Snapshot,
  jk04Snapshot,
  uartSnapshot,
  deviceInfoModel,
  uartDeviceInfo,
} from './driver.js';
export { createJkSimulator } from './simulator.js';
