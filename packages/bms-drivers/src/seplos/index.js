import { seplosV2BleDefinition, seplosV2Definition, seplosV3Definition } from './driver.js';

/**
 * Driver definitions of this family, in detection order (docs/protocols/seplos.md 11.4):
 * `seplos-v3`, `seplos-v2-ble`, `seplos-v2`. Every probe only reads, and each generation ignores
 * the other one's probe: a V3 board takes the first byte of a frame as its Modbus address and
 * drops the V2 frame `~20...`, a V2 board waits for `~` and drops Modbus frames (spec 11.3). On a
 * serial port the trial order is therefore seplos-v3 at 19200, seplos-v2 at 19200, seplos-v2 at
 * 9600.
 *
 * Registration: after Daly (and after JBD) and before Atorch, as in
 * `drivers = [...jkDrivers, ...antDrivers, jbdDefinition, ...dalyDrivers, jbdUpRs485Definition,
 * ...seplosDrivers, ...atorchDrivers]` (the JBD order is the one of src/jbd/index.js).
 * seplos-v3 shares the FFF0 / FFF1 / FFF2 profile and seplos-v2-ble the FF00 / FF01 / FF02
 * profile with the two Daly profiles and with JBD (FF00 is the JBD default, FFF0 the JBD-DH04SC02
 * layout). Seplos names (BPxx, SPxxB..., XZH...) rank first by name, so only a renamed device
 * gets the JBD and Daly probes first: a few seconds more before the Seplos probe, no false match
 * (a JBD answers only DD frames, a Daly only its own; both ignore the Seplos frames, tested in
 * seplos.test.js). On serial, the JBD and JBD UP probes (DD A5 ..., function 0x78) are ignored
 * by both Seplos generations. Seplos does not use FFE0, so Atorch can stay last as its comment
 * requires.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const seplosDrivers = [seplosV3Definition, seplosV2BleDefinition, seplosV2Definition];

export {
  seplosV3Definition,
  seplosV2BleDefinition,
  seplosV2Definition,
  SeplosV3Driver,
  SeplosV2BleDriver,
  SeplosV2AsciiDriver,
  SEPLOS_VENDOR,
  VARIANT,
  V2_BLE_NAME,
  V3_NAME_PATTERNS,
  plausiblePia,
  plausibleSingle,
  plausibleTelemetry,
  v2AsciiSnapshot,
  v2BleSnapshot,
  v3Snapshot,
} from './driver.js';
export { createSeplosV2Simulator, createSeplosV2BleSimulator, createSeplosV3Simulator, defaultParamBlock } from './simulator.js';
