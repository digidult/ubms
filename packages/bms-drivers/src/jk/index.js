import { jkBleDefinition, jkPbDefinition, jkUartDefinition } from './driver.js';
import { jkBalancerBleDefinition, jkBalancerRs485Definition } from './balancer.js';

/**
 * Driver definitions of this family, in detection order.
 *
 * Bluetooth: the JK04 balancer driver comes before `jk-ble`, because `jk-ble` also accepts a JK04
 * balancer (as a BMS). Balancer names are user defined ("BMS" on a JK-B2A16S, "JK-B5A24S",
 * "Power Wall 1"), so the balancer driver ranks equally with `jk-ble` for every "JK-" or "JK_"
 * name, and the registration order runs its probe first for those names and for names no driver
 * ranks. The balancer probe rejects a JK BMS after its device info frame (software 11 or later,
 * or a BMS model with the data of a JK02_24S frame), so a BMS usually pays one extra request.
 * JK-PB serial number names rank `jk-ble` alone. A balancer still reaches `jk-ble` when the
 * balancer probe sees no JK04 data in time or when `jk-ble` is chosen explicitly.
 *
 * Serial: the JK-PB Modbus triggers and the JK-B 4E57 port at 115200 baud, then the balancer RS485
 * port at 9600 baud (balancers are rarer; the baud rates differ, so no JK device answers another
 * one's probe). The balancer demo is on the RS485 definition: the first definition with a demo
 * is the default demo of the app, and that stays `jk-ble`.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const jkDrivers = [jkBalancerBleDefinition, jkBleDefinition, jkPbDefinition, jkUartDefinition, jkBalancerRs485Definition];

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
