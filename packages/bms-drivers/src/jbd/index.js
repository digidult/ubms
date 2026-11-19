import { jbdDefinition } from './driver.js';
import { jbdUpRs485Definition } from './up-driver.js';

/**
 * Driver definitions of the JBD (Jiabaida) family in detection order (docs/protocols/jbd.md):
 * - `jbd`: the DD A5 protocol over Bluetooth (FF00, or FFF0 on the JBD-DH04SC02) and UART /
 *   RS485. Its probe is one read-only 7 byte request `DD A5 03 00 FF FD 77`, repeated once for a
 *   sleeping BMS, accepted only for a plausible 0x03 answer (spec 11.2, 11.3). On the Bluetooth
 *   FF00 layout, silence is followed by one app key frame `FF AA 15 ...`; a locked 2024 module is accepted with
 *   `locked: true` in the probe result and asks for its login data through the settings.
 * - `jbd-up-rs485`: experimental, read only UP series rack BMS on RS485 (spec 11.5).
 *
 * Registration (spec 11.1, 11.4): JBD shares GATT services only with Daly (FF00 is the JBD
 * default and the Daly fallback layout; FFF0 is the Daly default and the rare JBD-DH04SC02
 * layout); it does not overlap with JK, ANT, the JK balancers or Atorch (all FFE0). Recommended
 * order in packages/bms-drivers/src/index.js:
 *
 *   [...jkDrivers, ...antDrivers, jbdDefinition, ...dalyDrivers, jbdUpRs485Definition, ...atorchDrivers]
 *
 * that is `jbd` before `daly-modbus` and `daly`: a JBD answers the probe in about 0.25 s, and an
 * FF00 device without a recognisable name is far more often a JBD than a Daly; on serial the JBD
 * read is also the cheapest probe and is ignored by Daly, JK UART and ANT. A Daly device costs
 * the two unanswered JBD reads and, on FF00 only, one app key frame: about 3.75 s on FF00 and
 * 2.5 s on FFF0 over Bluetooth with the default probe timeout of 2.5 s (1.25 s per attempt), and
 * 1 s on serial. `jbd-up-rs485` goes after the Daly drivers (rare device, serial
 * only, address based). Name ranking still puts Daly first for DL- / JHB- names and JBD first for
 * JBD- / xiaoxiang / model code names.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const jbdDrivers = [jbdDefinition, jbdUpRs485Definition];

export {
  JBD_BLE_PROFILES,
  JBD_NAME_PATTERNS,
  JBD_NAME_PREFIXES,
  JBD_VENDOR,
  JbdDriver,
  JbdStatusError,
  basicAlarms,
  basicInfo,
  basicSnapshot,
  counterExtras,
  jbdDefinition,
} from './driver.js';
export { JbdUpDriver, jbdUpRs485Definition, upAlarms, upInfo, upSnapshot } from './up-driver.js';
export { createJbdSimulator, createJbdUpSimulator } from './simulator.js';
export { buildJbdSchema } from './settings.js';
