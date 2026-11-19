import { atorchDefinition } from './driver.js';

/**
 * Driver definitions of this family. Detection only listens (spec 11.2), so the app should probe
 * this family before the drivers that write a probe request on the shared FFE0 / FFE1 profile
 * (JK 0x97, ANT, NEEY), see spec 11.2 step 7. Whether an Atorch meter ignores those foreign
 * probe frames on FFE1 is not documented (unverified).
 *
 * Registering this family first has two costs to decide on where the families are registered:
 * the app takes the first definition with a demo as its default demo (which must stay `jk-ble`),
 * and every FFE0 device whose name no driver ranks, such as a JK balancer with a user defined
 * name, waits the whole listen window (LISTEN_MS, 3 s, never shortened by the session probe
 * timeout) before the next probe. Registering it last instead lets an unranked Atorch name such as
 * `JDY-19` (J7-H) receive the JK and ANT write probes first.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const atorchDrivers = [atorchDefinition];

export {
  atorchDefinition,
  AtorchDriver,
  ATORCH_VENDOR,
  NAME_PATTERN,
  NAME_PREFIXES,
  formatDuration,
  isAtorchName,
  isLoadName,
  isPx100Name,
  maxLoadCurrent,
  modelFromName,
  reportSnapshot,
} from './driver.js';
export { createAtorchSimulator } from './simulator.js';
