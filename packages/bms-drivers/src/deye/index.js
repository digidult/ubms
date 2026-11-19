import { deyeBleDefinition, deyeCanDefinition, deyeRs485Definition } from './driver.js';

/**
 * Driver definitions of the Deye family (docs/protocols/deye.md 1.3, 11):
 *
 * - `deye-rs485`: the AA 55 protocol on the RS485 pins of the PCS port, 9600 8N1. Its probe is
 *   one 9 byte read `AA 55 01 01 00 00 20 0D 0A`, answered in about 80 ms and accepted only for a
 *   0x01 answer with a valid CRC, CR LF and plausible values (spec 11.2). Seplos V2 and Pylontech
 *   packs wait for '~', Modbus devices see address 0xAA, JBD waits for 0xDD and Daly for 0xA5, so
 *   they stay silent; foreign AA 55 sequences (NEEY requests, CH340 USB-CAN analyzers) fail the
 *   length and CRC rule.
 * - `deye-ble`: the same frames in the AES encrypted session on service FFF1 (characteristic FFF2,
 *   names `BAT...`). The probe writes the `random` handshake message and accepts only the cipher
 *   block that the Deye BMS computes from the advertised name; no other family uses FFF1.
 * - `deye-can`: the PCS CAN broadcast through an SLCAN USB-CAN adapter. It must NOT take part in
 *   automatic serial detection: the definition carries `links.serial.autoDetect: false`, which
 *   `DriverRegistry.serialCandidates()` honours for 'auto' and family selections, so that the
 *   driver runs only when the user selects 'deye-can' explicitly (spec 11.4). Its probe writes
 *   the adapter commands C, S6 and L (plus C and O when no other node acknowledges, a lone
 *   battery) and then only listens; it never transmits a CAN frame.
 *
 * Registration (spec 11.4) in packages/bms-drivers/src/index.js:
 *
 *   [...jkDrivers, ...neeyDrivers, ...antDrivers, jbdDefinition, ...dalyBalancerDrivers,
 *    ...dalyDrivers, jbdUpRs485Definition, deyeRs485Definition, ...seplosDrivers,
 *    deyeBleDefinition, ...atorchDrivers]
 *
 * plus `deyeCanDefinition` anywhere, kept out of automatic detection. `deye-rs485` goes before
 * Seplos: otherwise a Deye pack first sits through the three Seplos trials (19200 Modbus, 19200
 * ASCII, 9600 ASCII, where an LVESS pack may answer the '~' request with an empty RTN 0 frame that
 * Seplos rejects). `deye-ble` only matters for ties, so it goes after Seplos and before Atorch,
 * which stays last.
 * @type {import('../index.js').DriverDefinitionWithDemo[]}
 */
export const deyeDrivers = [deyeRs485Definition, deyeBleDefinition, deyeCanDefinition];

export {
  deyeRs485Definition,
  deyeBleDefinition,
  deyeCanDefinition,
  DeyeAa55Driver,
  DeyeRs485Driver,
  DeyeBleDriver,
  DeyeCanDriver,
  DEYE_VENDOR,
  VARIANT,
  BLE_NAME_PATTERN,
  LISTEN_MS,
  LISTEN_ONLY_MS,
  aa55Info,
  aa55Snapshot,
  serialFromName,
} from './driver.js';
export { DeyeCanState, ShiftedIdLayout, canInfo, canSnapshot, decodeCanFrame, faultAlarms, FAULT_TABLES } from './can.js';
export { DEMO_BLE_NAME, createDeyeBleSimulator, createDeyeCanSimulator, createDeyeRs485Simulator } from './simulator.js';
