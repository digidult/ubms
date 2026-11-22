# JK (Jikong) active balancers: communication protocols

Implementation reference for JK balancer-only devices (no charge or discharge MOSFETs, no current shunt): the old Bluetooth protocol JK04 used by the JK-B2A16S, JK-B2A24S and JK-B5A24S, the RS485 protocol of the JK-DZ11-B2A24S ("55 AA" requests, "EB 90" answers, 74-byte frames), and what is known about the 2024 balancer generation (firmware 11.x) and the CAN variant JK-DZ08.

This document is a companion to [jk.md](jk.md). Everything that is identical to the JK BMS protocols (BLE frame layout, checksum, ACK frame, reassembly) is referenced there and only the differences are written out here.

Compiled 2026-11-18 from vendor documents published in open-source repositories, the source code and tests of the projects in section 13, and Bluetooth HCI captures of the official JK app that were decoded for this document. Every statement carries a source tag. **unverified** marks a value that has a single weak source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/jk-balancer.json` (71 frames, every checksum verified). Field names written in `code` are the keys of the `expected` objects in that file. The JK04 vectors of `jk.json` (`jk04-*`, `mppsolar-jk04-*`, `ble-cmd-jk04-*`) remain valid and are not repeated.

## Contents

0. Conventions
1. Overview
2. Physical links
3. Frame formats
4. Session flow
5. Commands
6. Responses
7. Settings
8. Controls and actions
9. Bits and enumerations
10. Device information
11. Detection
12. Pitfalls and quirks
13. References

## 0. Conventions

- Offsets are byte offsets from the first byte of the frame, decimal with hex in parentheses where useful. "S98" means settings frame offset 98, "C222" cell info frame offset 222, "D46" device info frame offset 46 (same notation as jk.md).
- Types: u8, u16, u32, i16, f32 = IEEE 754 single precision. LE = little-endian, BE = big-endian. JK04 BLE frames are LE; the RS485 balancer protocol is BE.
- sum8 = arithmetic sum of the listed bytes modulo 256.
- Scale: physical value = raw × scale.
- Source tags (details in section 13): [SY] syssi/esphome-jk-bms, [PR18] its pull request 18 with captures from a JK-DZ11-B2A24S, [D48] its discussion 48 (JK-B2A16S), [I213] its issue 213 (JK-B5A24S), [CAP04] official app btsnoop captures stored in [SY] and decoded for this document, [MPP] jblance/mpp-solar, [BM] fl4p/batmon-ha, [AIO] patman15/aiobmsble, [ZY] Ziyatoe/JK-BMS_BLE_READER issue 1, [JKBAL485] JK "JK-DZ11-B2A24S balancer communication protocol V1.3", [JKBALCAN] JK "JK-DZ08-B1A24S Equalizer communication protocol", [JKM41] JK-B1A24S/JK-B2A24S manual V4.1, [JKM11] JK "Lithium Battery Active Equalizer" manuals of 2024 (versions 11.x), [JK] the JK BMS spec [jk.md](jk.md).

## 1. Overview

### 1.1 Devices and protocols

| Device | Versions seen | Bluetooth | Wired | Sources |
|---|---|---|---|---|
| JK-B2A16S (2 A) | hw 3.0, sw 3.3.0 | JK04 | none; the BLE module (JDY-18) talks UART to the MCU, a spare USART header answered neither "55 AA" nor "DD A5" | [CAP04], [D48], [SY] tests frames_jk04.h |
| JK-B2A24S (2 A) | hw 3.0, sw 3.2.3 | JK04 | none known | [MPP] test_protocol_jk04.py |
| JK-B2A24S, 2025 unit | not reported | JK04 (float32 cell frame, 12 cells) | | [ZY] |
| JK-B5A24S (5 A) | hw 8.X, sw 8.0.3M | JK04 | none known | [CAP04], [I213], [SY] tests frames_jk04_b5a24s.h |
| JK-DZ11-B2A24S (2 A, RS485 option) | hw 6.0 sw 6.0.5 (2021); "HW/SW 11" (2025) | 2025 unit: reported to decode with the JK02_32S decoder of [SY]; no frame published (**unverified**) | RS485, 9600 baud, protocol of section 3.2 | [PR18], [SY] issue 17, [JKBAL485] |
| JK-DZ08-B1A24S / B2A24S (CAN option) | V06, V08 | not reported | CAN 500 kbit/s (section 6.7); not usable in ubms | [JKBALCAN], [PR18] |
| JK-B1A24S | hw 6.0, sw 6.0.3 | unknown (no frames; works with a third-party app) | | [SY] discussion 1066 |
| JK-B2A24S, JK-B4A24S, JK-B2A8S, JK-B2A16S-TH, NY-B2A16S-TH (manuals 2024, versions 11.x and 16.0.2) | 11.x | not captured; configured in the same JK app pages as the JK02_32S BMS (battery type, cell count, capacity, trigger delta, voltage and current calibration, balancer switch on the "BMS control" page) | optional RS485 or CAN on one multiplexed port, address and protocol selectable in the app | [JKM11] |

Balancer hardware facts from the vendor manuals ([JKM41], [JKM11]): 2–24 cells (JK-B2A16S-TH 2–16, JK-B2A8S 2–8), supercapacitor energy transfer at a constant current (1, 2, 4 or 5 A class by model), cell voltage acquisition 1–5 V with ±5 mV (V4.1) or ±3 mV (2024), supply 40–100 V (V4.1), 20–100 V (2024 JK-B2A24S), 9–100 V (JK-B4A24S), 10–40 V (JK-B2A8S), 24–70 V (JK-B2A16S-TH), optional temperature sensor on the 2024 boards and on the DZ08/DZ11 variants, cascading of several balancers for more than 24 cells.

### 1.2 JK-BD models are BMSes, not balancers

The "BD" models (JK-BD4A8S4P, JK-BD6A17S6P, JK-BD6A24S10P, JK-BD6A32S15P, JK_BD4A24S4P and others) are smart BMSes with MOSFETs and a current shunt. Their frames carry current, SOC and MOSFET states, for example the JK-BD6A32S15P sw 20.19 frame in `jk.json` (`batmon-bd6a32s-32-cells-cell-info-full`: −9.813 A, SOC 94 %, both MOSFETs on) and the JK-BD6A17S6P 4E57 frame (`uart-rx-bd6a17s6p-16s-lfp`). They speak JK02_24S or JK02_32S like every JK BMS ([SY] README device list, [SY] issue 1021: JK_BD4A24S4P hw 19H sw 19.19 fixed by selecting JK02_32S, [AIO] test data and BMS_BLE-HA issue 682: JK-BD4A8S-4P hw 11H sw 11.56). They are fully covered by [JK] and the `jk-ble`, `jk-uart` drivers.

### 1.3 Coverage in ubms

| Protocol | Spec | ubms driver | Status |
|---|---|---|---|
| JK04 over BLE | [JK] 3.1–3.4, 6.4, 11.3; this document sections 2.1, 3.1, 4.1, 6.1–6.4, 7 | `jk-balancer-ble` (device type balancer, `packages/bms-drivers/src/jk/balancer.js`); in automatic detection it is probed before `jk-ble` for every name that ranks `jk-ble` ("JK-", "JK_") and for names no driver ranks (section 11.1). `jk-ble` variant `JK04` takes a balancer only when `jk-ble` is chosen explicitly, when the balancer probe sees no JK04 data in time, or for a balancer whose name matches the JK-PB serial number pattern of `jk-ble` | implemented; `jk-balancer-ble` and the JK04 schema of `jk-ble` both keep the balance start voltage read only (pitfall 1) |
| JK balancer RS485 ("55 AA" / "EB 90") | this document sections 2.2, 3.2–3.4, 4.2, 5.3, 6.5, 6.6 | `jk-balancer-rs485` (`packages/bms-drivers/src/jk/balancer.js`, demo simulator) | implemented; every write compares the echoed value (section 4.2) |
| JK02_32S on 2024 balancers | [JK] | `jk-ble` would treat such a device as a BMS | **unverified**, no capture |
| CAN (DZ08) | section 6.7 | none | ubms has no CAN transport |

### 1.4 Telling the protocols apart

- Bluetooth: send 0x97 as for any JK device ([JK] 11.2). A JK04 balancer answers with a 300-byte device info frame whose model string ends in "S" without a current suffix (section 11.1) and streams float32 cell frames after 0x96 ([JK] 11.3).
- RS485: only the JK-DZ11 variant has a 485 transceiver (VP3082 on the board photographed in [PR18]). It answers the 7-byte status request of section 5.3 at 9600 baud. It does not speak the JK BMS RS485 protocols: the JK RS485 adapter with the JK PC software does not see it ([DSB1090]).

## 2. Physical links

### 2.1 Bluetooth (JK04 balancers)

GATT tables from the official app captures [CAP04] (ATT Read By Group Type and Read By Type responses):

| Item | JK-B2A16S hw 3.0 | JK-B5A24S hw 8.X |
|---|---|---|
| Services | 0x1800 (handles 0x0001–0x0007), 0xFFE0 (0x0008–0xFFFF) | 0x1800 (0x0001–0x0009), 0x1801 (0x000A–0x000D), 0xFFE0 as 128-bit UUID 0000ffe0-0000-1000-8000-00805f9b34fb (0x000E–0x0017), 0x180A (0x0018–0x002A), 0x180F (0x002B–0x002E) |
| FFE1 | value handle 0x000A, properties 0x1C (write without response, write, notify), CCCD 0x000B | value handle 0x0010, properties 0x1C, CCCD 0x0011 |
| FFE2 | value handle 0x000D, properties 0x1C, CCCD 0x000E | value handle 0x0013, properties 0x1C, CCCD 0x0014 |
| FFE3 | value handle 0x0010, properties 0x0C (write, write without response) | value handle 0x0016, properties 0x0C, CCCD 0x0017 |
| Used by the app | writes CCCD 0x000B and 0x000E = 01 00, commands with ATT Write Command (0x52) to 0x000A, notifications only on 0x000A | writes CCCD 0x0011 = 01 00, commands with ATT Write Command to 0x0010, notifications only on 0x0010 |
| MTU | no exchange: every notification carries 20 bytes (8571 of 8573) | the balancer itself sends an Exchange MTU Request of 115 bytes at connection; frames arrive as 80 + 80 + 80 + 60 bytes (46 of 130 frames) or with other splits when a notification also carries the end of the previous frame or the ACK |

Consequences:
- Unlike the "new" JK BMS modules of [JK] 2.1, these balancers have one FFE1 characteristic with write and notify on the same handle. `service.getCharacteristics(0xffe1)` returns one entry. FFE2 and FFE3 carry no traffic in the captures.
- Notifications are not aligned with frames; reassemble as in [JK] 3.4 (the same algorithm works unchanged, it also has to extract the 20-byte ACK frame, which the JK-B5A24S once split as 15 + 5 bytes).
- Pairing: none. The device passcode "1234" in the device info frame (D62) is asked by the app only ([JKM41] 5.3.1: "The default password of the device is 1234").
- Advertised name: the device name D46: "BMS" (JK-B2A16S [CAP04]), "JK-B5A24S" (equal to the model [CAP04]), "Power Wall 1" (user defined, JK-B2A24S [MPP]); [JKM41] shows "JK-B1A24S" as the example. No advertisement of a balancer is available, so manufacturer data and advertised service UUIDs are unknown (**unverified**). ubms therefore assumes its chooser filters for `jk-balancer-ble`: the FFE0 service and the name prefixes "JK-" and "JK_". A balancer that advertises neither (for example the JK-B2A16S named "BMS") may be listed only with "show all devices".
- One central at a time; the device LED is steady while a phone is connected and blinks otherwise ([JKM41] table 1, [JKM11] 5.2).

### 2.2 RS485 (JK-DZ11-B2A24S)

| Item | Value | Source |
|---|---|---|
| Line | RS485 half duplex, 9600 baud | [JKBAL485] table 1; [SY] esp32-active-balancer-example.yaml (`baud_rate: 9600`), the configuration confirmed on hardware in [PR18] |
| Character format | 8 data bits, no parity, 1 stop bit | ESPHome UART defaults in the confirmed configuration ([SY] example does not override them); the vendor document does not state it |
| Connector | 3-pin XH: pin 1 D_P = RS485-A (CAN_H on CAN units), pin 2 D_N = RS485-B (CAN_L), pin 3 GND | [JKM11] JK-B2A24S V11.5.1, 5.2 table "P3" |
| Polarity | one user had to swap A and B before the first answer arrived ("red for positive, black for negative" instead of the labels) | [PR18] comments of 2021-11-06 |
| Address | 1 by default; 1–15 settable in the JK app on the DZ11; the DZ08 (CAN) has DIP switches instead | [PR18] comment of 2025-02-02 (single user report, **unverified**); [JKBAL485] uses address 0x01 in every example |
| Bus | two balancers on different addresses were read by one master | [PR18] comment of 2025-02-02 |
| Response time | the balancer answers within 1 s; the master must wait for the answer or for the 1 s timeout before sending the next command | [JKBAL485] section 3 |
| Inter-byte gap | [SY] discards a partial frame after 100 ms without bytes (`rx_timeout: 100ms`); the user of [PR18] reported reliable operation with that value | [SY] jk_balancer_modbus `JkBalancerModbus::loop`, [PR18] |
| Poll interval | 5 s in [SY] (`update_interval: 5s`) | [SY] jk_balancer/__init__.py |

The vendor calls this RS485 port "communication interface"; [SY] names the component `jk_balancer_modbus`, but the protocol has nothing to do with Modbus ([PR18], [SY] author, 2025-01-30).

### 2.3 CAN (JK-DZ08)

500 kbit/s, standard 11-bit identifiers whose low 4 bits carry the balancer address and whose high 7 bits are 0 ([JKBALCAN] sections 2 and 3). The data layout is summarised in section 6.7 for completeness; ubms has no CAN link, so this variant cannot be implemented.

## 3. Frame formats

### 3.1 JK04 over BLE

Identical to JK02 ([JK] 3.1–3.3): commands are 20 bytes `AA 55 90 EB <register> <length> <value> <filler> <sum8 of bytes 0..18>`; data frames are 300 bytes `55 AA EB 90 <type> <counter> <payload> <sum8 of bytes 0..298>`; the ACK frame is `AA 55 90 EB C8 01 01 00 … 00 44`. Differences, all from [CAP04]:

- Values with length 4 are IEEE 754 float32 LE of the value itself (no scale). Lengths 1 and 2 are integers LE ([JK] 3.1, [SY] `encode_jk04_payload`, confirmed by 28 app writes in [CAP04]).
- Register numbers are byte offsets into the settings payload: register = settings frame offset − 6. All six registers that the app wrote confirm this: 0x1C ↔ S34, 0x20 ↔ S38, 0x44 ↔ S74, 0x64 ↔ S106, 0x68 ↔ S110, 0x6C ↔ S114 (four of them confirmed by a changed read-back, section 4.1). JK02 registers are 4-byte word indexes instead ((offset − 6) ÷ 4 + 1).
- The length byte of 0x96 and 0x97 is not checked: the JK-B2A16S answered `AA 55 90 EB 97 04 00 … 15` and `… 96 04 … 14` sent by an old ESPHome version ([D48] logs, vectors `bal-jk04-tx-esphome-*`).
- Random filler after the value is accepted (every app frame in [CAP04]); zero filler works too ([SY], [BM]).
- The frame counter (byte 5) increases by one per cell info frame; the device info and settings frames carry the current counter value (sequence 0xEE, 0xEE, 0xEE, 0xEF, 0xF0 … on the JK-B5A24S).

### 3.2 RS485 request (host to balancer)

7 bytes ([JKBAL485] 4.3 table 2, [SY] `JkBalancerModbus::send`, [MPP] `jk485.get_full_command`):

| Offset | Length | Content |
|---|---|---|
| 0 | 2 | 55 AA |
| 2 | 1 | balancer address (1 by default) |
| 3 | 1 | command: 0xFF read status, 0xF0 cell count, 0xF2 balance trigger voltage, 0xF4 max balance current, 0xF6 balancer switch |
| 4 | 2 | data, u16 BE (0x0000 for the status request) |
| 6 | 1 | sum8 of bytes 0..5 |

### 3.3 RS485 answer (balancer to host)

74 bytes for every command ([JKBAL485] 4.4 table 3: header 2 + address 1 + command 1 + data 69 + checksum 1; [SY] `parse_jk_balancer_modbus_byte_` `frame_len = 74`):

| Offset | Length | Content |
|---|---|---|
| 0 | 2 | EB 90 |
| 2 | 1 | address of the answering balancer |
| 3 | 1 | command code of the request it answers |
| 4 | 69 | data (section 6.5 for 0xFF, 6.6 for writes) |
| 73 | 1 | sum8 of bytes 0..72 |

There is no length field: the length is fixed. All values are BE.

### 3.4 RS485 reassembly

1. Discard bytes until `EB 90`; keep a partial frame for at most 100 ms of line silence ([SY]).
2. Collect 74 bytes, check byte 73 against the sum8 of bytes 0..72, byte 2 against the polled address and byte 3 against the command sent.
3. sum8 is weak; apply the plausibility checks of section 11.2 before using values.
4. `EB 90` also occurs at offset 2 of every JK BLE data frame (`55 AA EB 90`); the two protocols never share a link, so this matters only for a generic sniffer.

## 4. Session flow

### 4.1 JK04 over BLE

Measured in [CAP04] (official app, JK-B2A16S and JK-B5A24S):

1. Connect, write 01 00 to the FFE1 CCCD.
2. Send 0x97. The device info frame (type 0x03) arrives after 83–115 ms, the ACK after 95–138 ms. No cell info frame is sent before 0x96.
3. Send 0x96 (the app does this 0.37–0.82 s after 0x97). The settings frame (type 0x01) arrives after 78–231 ms, the ACK after 93–276 ms, then cell info frames (type 0x02) follow every 0.48–0.60 s without further requests.
4. Every write is acknowledged with the ACK frame after 63–203 ms (33 of 33 writes; 48 of 48 commands on the JK-B2A16S, 14 of 14 on the JK-B5A24S).
5. To read settings again send 0x96: one settings frame (plus ACK) follows, the stream continues.
6. Read-back: the settings frame showed the new value 3 s (0x44), 9 s (0x68) and 18 s (0x20) after the write, without a restart of the device. The user of [D48] wrote that changes needed a power cycle; the captures do not confirm that for the read-back (**unverified** whether the balancing behaviour changes before a restart).
7. Balancer switch: after `0x6C = 0` the next cell info frame (0.6–0.9 s later) shows balancing action 0; after `0x6C = 1` balancing resumed 1.1–1.25 s later with a current ramp (vectors `bal-jk04-rx-cell-info-b2a16s-*`).

### 4.2 RS485

1. Send the status request (0xFF) to the configured address every 1–5 s ([SY] 5 s). Wait up to 1 s for the 74-byte answer ([JKBAL485] 3).
2. To change a setting send 0xF0, 0xF2, 0xF4 or 0xF6 with the new value. The 74-byte answer echoes the command and carries the value in effect in bytes 4..5. The vendor documents state that an out-of-range value is not accepted and the answer then carries the current value ([JKBAL485] notes to 4.2–4.5; the CAN document [JKBALCAN] 5.2–5.5 gives examples of both cases). Compare the echoed value with the request, then poll 0xFF and compare the field of section 6.5.
3. Only the 0xF6 switch write is confirmed on hardware ([PR18] 2025-02-01, "the balancer switch works and switches balancing on and off"); 0xF0, 0xF2 and 0xF4 follow the vendor document and are implemented by [SY] `JkNumber::control`.
4. Never send the next command before the answer or the 1 s timeout ([JKBAL485] 3).

## 5. Commands

All frames are complete, checksums included. "computed" = built with the documented layout. Vector ids in the last column refer to `jk-balancer.json`.

### 5.1 JK04 BLE requests

| Purpose | Frame | Source |
|---|---|---|
| device info request, zero filler | `AA 55 90 EB 97 00 00 00 00 00 00 00 00 00 00 00 00 00 00 11` | [JK] 5.1 (vector `ble-cmd-device-info-jk04` in `jk.json`) |
| device info request, app filler | `AA 55 90 EB 97 00 DF 52 88 67 9D 0A 09 6B 9A F6 70 9A 17 FD` | [CAP04] JK-B2A16S, `bal-jk04-tx-app-device-info-b2a16s` |
| device info request, app filler | `AA 55 90 EB 97 00 B4 4C B1 79 1A 3F A8 61 21 C6 38 DE 6F 09` | [CAP04] JK-B5A24S, `bal-jk04-tx-app-device-info-b5a24s` |
| device info request, length 4 | `AA 55 90 EB 97 04 00 00 00 00 00 00 00 00 00 00 00 00 00 15` | [D48] ESPHome log, answered; `bal-jk04-tx-esphome-device-info-length4` |
| settings request (starts the stream), zero filler | `AA 55 90 EB 96 00 00 00 00 00 00 00 00 00 00 00 00 00 00 10` | [JK] 5.1 |
| settings request, app filler | `AA 55 90 EB 96 00 F4 5F E2 03 6D FB E0 38 AA BC 44 12 34 B8` | [CAP04], `bal-jk04-tx-app-settings-request-b2a16s` |
| settings request, app filler | `AA 55 90 EB 96 00 3D D6 B2 AD 5D 1A 24 46 42 B3 F7 0B 13 6D` | [CAP04], `bal-jk04-tx-app-settings-request-b5a24s` |
| settings request, length 4 | `AA 55 90 EB 96 04 00 00 00 00 00 00 00 00 00 00 00 00 00 14` | [D48], `bal-jk04-tx-esphome-settings-length4` |

No other requests are known for JK04: event log (0xA1), restart, shutdown and presets of [JK] 5.1 are JK02_32S commands and were never seen on a balancer.

### 5.2 JK04 BLE writes

Zero-filler frames as sent by [SY], [BM] and the `jk-ble` driver (ubms sends every one except the balance start voltage frame, which is the [SY] frame only), and the captured app frames for the same registers:

| Purpose | Frame | Source |
|---|---|---|
| balancer on | `AA 55 90 EB 6C 01 01 00 00 00 00 00 00 00 00 00 00 00 00 E8` | [SY] test BalancerOn, [BM] `set_switch` |
| balancer off | `AA 55 90 EB 6C 01 00 00 00 00 00 00 00 00 00 00 00 00 00 E7` | [SY] test BalancerOff |
| balancer off, app | `AA 55 90 EB 6C 01 00 79 62 96 ED E3 D0 82 A1 9B 5B 3C 9C E9` | [CAP04], `bal-jk04-tx-app-balancer-off-b2a16s` |
| balancer on, app | `AA 55 90 EB 6C 01 01 4B D3 27 86 3B E2 12 4D B0 B6 F7 64 F0` | [CAP04], `bal-jk04-tx-app-balancer-on-b2a16s` |
| cell count 16 (u16) | `AA 55 90 EB 1C 02 10 00 00 00 00 00 00 00 00 00 00 00 00 A8` | [SY] test CellCount16 |
| cell count 15, app | `AA 55 90 EB 1C 02 0F 00 D3 27 86 3B E2 12 4D B0 B6 F7 64 64` | [CAP04], `bal-jk04-tx-app-cell-count-15-b2a16s` |
| cell count 17, app | `AA 55 90 EB 1C 02 11 00 04 D2 E3 6F B8 C5 D4 91 2E C0 7E 1F` | [CAP04], `bal-jk04-tx-app-cell-count-17-b5a24s` |
| power off voltage 3.2 V | `AA 55 90 EB 20 04 CD CC 4C 40 00 00 00 00 00 00 00 00 00 C3` | [SY] test Float32PowerOffVoltage |
| power off voltage 3.0 V | `AA 55 90 EB 20 04 00 00 40 40 00 00 00 00 00 00 00 00 00 1E` | computed |
| power off voltage 2.7 V, app | `AA 55 90 EB 20 04 CD CC 2C 40 56 01 32 9F BC CC CC 5F 35 B3` | [CAP04], `bal-jk04-tx-app-power-off-2v7-b2a16s` |
| power off voltage 2.2 V, app | `AA 55 90 EB 20 04 CD CC 0C 40 8A AC 6F 37 68 B5 0A 28 6B 19` | [CAP04], `bal-jk04-tx-app-power-off-2v2-b5a24s` |
| voltage calibration (ADC reference) 3.031334 | `AA 55 90 EB 44 04 60 01 42 40 00 00 00 00 00 00 00 00 00 A5` | [SY] test VoltageCalibration3p031334V |
| voltage calibration 3.01461, app | `AA 55 90 EB 44 04 66 EF 40 40 6B 4E 58 A4 7A F6 39 70 58 BD` | [CAP04], `bal-jk04-tx-app-voltage-calibration-3v01461-b2a16s` |
| balance trigger 0.008 V | `AA 55 90 EB 64 04 6F 12 03 3C 00 00 00 00 00 00 00 00 00 A2` | [SY] test BalanceTrigger8mV |
| balance trigger 0.005 V, app | `AA 55 90 EB 64 04 0A D7 A3 3B 5F 35 6B 4E 58 A4 7A F6 39 93` | [CAP04], `bal-jk04-tx-app-trigger-5mv-b2a16s` |
| balance trigger 0.108 V, app | `AA 55 90 EB 64 04 1B 2F DD 3D 22 B3 5C CE 36 23 A7 5A 4E ED` | [CAP04], `bal-jk04-tx-app-trigger-108mv-b5a24s` |
| max balance current 4.5 A | `AA 55 90 EB 68 04 00 00 90 40 00 00 00 00 00 00 00 00 00 B6` | [SY] test MaxBalanceCurrent4p5A |
| max balance current 2.0 A | `AA 55 90 EB 68 04 00 00 00 40 00 00 00 00 00 00 00 00 00 26` | computed |
| max balance current 1.0 A, app | `AA 55 90 EB 68 04 00 00 80 3F 04 D2 E3 6F B8 C5 D4 91 2E DD` | [D48], `bal-jk04-tx-app-max-balance-current-1a-b2a16s` |
| max balance current 3.5 A, app | `AA 55 90 EB 68 04 00 00 60 40 87 90 EA A8 83 82 EF BC 34 13` | [CAP04], `bal-jk04-tx-app-max-balance-current-3a5-b5a24s` |
| balance start voltage 1.00 V (register 0x58, **unverified**, see pitfall 1) | `AA 55 90 EB 58 04 00 00 80 3F 00 00 00 00 00 00 00 00 00 95` | [SY] test BalancingStartVoltage1p00V, computed; no capture; not sent by ubms |

All 32 app writes of [CAP04] and [D48] are in the vector file. The JK02 balancer register (`AA 55 90 EB 1F 04 01 … 9E`) has no effect on a JK04 balancer ([D48], vector `bal-jk04-tx-jk02-balancer-register-has-no-effect`).

### 5.3 RS485

| Purpose | Frame | Source |
|---|---|---|
| status request, address 1 | `55 AA 01 FF 00 00 FF` | [JKBAL485] 4.1 table 4; on the wire in [PR18]; [MPP] `jk485` |
| status request, address 2 | `55 AA 02 FF 00 00 00` | computed |
| status request, address 15 | `55 AA 0F FF 00 00 0D` | computed |
| cell count 16 | `55 AA 01 F0 00 10 00` | [JKBAL485] 4.2 table 6 |
| cell count 17 | `55 AA 01 F0 00 11 01` | computed |
| balance trigger 10 mV | `55 AA 01 F2 00 0A FC` | [JKBAL485] 4.3 table 8 |
| balance trigger 11 mV | `55 AA 01 F2 00 0B FD` | computed |
| max balance current 500 mA | `55 AA 01 F4 01 F4 E9` | [JKBAL485] 4.4 table 10 |
| max balance current 2000 mA | `55 AA 01 F4 07 D0 CB` | computed; above the vendor range, **unverified** |
| balancer on | `55 AA 01 F6 00 01 F7` | [JKBAL485] 4.5 table 12; effect confirmed in [PR18] |
| balancer off | `55 AA 01 F6 00 00 F6` | computed ([SY] `JkSwitch::write_state` sends 0x0000) |
| balancer off, address 2 | `55 AA 02 F6 00 00 F7` | computed |

## 6. Responses

### 6.1 JK04 cell info frame (type 0x02)

Refines [JK] 6.4 with the observations from 724 frames of the official app captures (594 JK-B2A16S, 130 JK-B5A24S), 65 ESPHome frames of the JK-B2A16S ([SY] docs/pdus/JK-B2A16S-3.3.0-BLE-JK04.txt), the 24-cell frame of [MPP] and the 12-cell JK-B2A24S frame of [ZY]. All LE.

| Offset | Len | Type | Field | Notes |
|---|---|---|---|---|
| 0 | 4 | | header 55 AA EB 90 | |
| 4 | 1 | u8 | frame type 0x02 | |
| 5 | 1 | u8 | `frameCounter` | +1 per cell info frame |
| 6 | 4 per cell | f32, V | `cellVoltages[n]` at 6 + 4n, 24 slots | 0.0 in unused slots; the number of non-zero slots equals the bit count of C214 in every frame |
| 102 | 4 per cell | f32, Ω | `cellResistances[n]` at 102 + 4n, 25 slots | balance lead resistance; 0.07–0.28 Ω in the captures |
| 202 | 4 | f32, V | `cellVoltageAverage` | differs from the mean of the cells of the same frame by up to ±4.4 mV |
| 206 | 4 | f32, V | `cellVoltageDelta` | differs from max − min of the same frame by −16 to +15 mV |
| 210 | 4 | | unknown, always 0 | |
| 214 | 4 | u32 bitmask | `cellMask214`: bit n = cell n+1 present | 0x0000FFFF (16 cells), 0x00FFFFFF (24, [MPP]), 0x00000FFF (12, [ZY]) |
| 218 | 1 | u8 | `cellVoltageMaxIndex`, 0-based | matched the highest cell of the same frame in 513 of 724 frames |
| 219 | 1 | u8 | `cellVoltageMinIndex`, 0-based | matched the lowest cell in 614 of 724 frames |
| 220 | 1 | u8 | `balancingAction`: 0 idle, 1 charging the lowest cell, 2 discharging the highest cell | sign of C222 follows it in every frame (section 9.1) |
| 221 | 1 | u8 | `unknown221` | 1 in every JK-B2A16S, JK-B5A24S and [MPP] frame, independent of the balancer switch; 0 in the [ZY] JK-B2A24S frame |
| 222 | 4 | f32, A | `balanceCurrent` | positive with action 1, negative with action 2, 0.0 with action 0; magnitudes 0.007–2.17 A (JK-B2A16S), −2.6 A (JK-B5A24S [SY]) |
| 226 | 7 | | unknown, always 0 | |
| 233 | 4 | f32 | unknown | varies with the cell voltage level (2.6e6–7.5e6 on the JK-B2A16S, 4.8e6 on the JK-B5A24S, 49987 on the [ZY] unit) |
| 237 | 4 | u32 | `unknown237`, always 64 (40 00 00 00) | all devices |
| 241 | 45 | | unknown | JK-B2A16S: bytes 260 and 261 = 1, bytes 262..265 vary; JK-B5A24S: bytes 242..244 vary, byte 276 = 3 ([SY] frame comment calls the JK-B5A24S frame "3 cycles", **unverified**); [ZY]: f32 −90.2 at 254, byte 260 = 4 |
| 286 | 4 | u32, s | `totalRuntime`: seconds since the last power-on | restarted at 752 s after a power cycle of the JK-B2A16S while the power-on count went from 19 to 20 ([CAP04]); the app shows it as "TIME" in its header |
| 290 | 4 | f32 | `unknown290` | 0 on the JK-B2A16S, 0.71–0.72 on the JK-B5A24S |
| 294 | 4 | f32 | `unknown294` | 2.52–2.54 (JK-B2A16S), 1.67 (JK-B5A24S); [SY] tested it as a temperature and dropped it ([D48]) |
| 298 | 1 | | unknown, 0 | |
| 299 | 1 | u8 | sum8 of bytes 0..298 | |

There is no pack voltage, current, SOC, temperature or alarm field. Pack voltage = sum of the cell voltages ([SY], [BM], [JKM41] 5.3.2 "the battery voltage ... the sum of all the cells voltages").

### 6.2 JK04 settings frame (type 0x01)

All LE. Every byte not listed is 0 in all 22 settings frames of [CAP04] and in the [SY] and [BM] fixtures.

| Offset | Len | Type | Field | Write register | Evidence |
|---|---|---|---|---|---|
| 6 | 4 | f32 | `unknown6`, 1.0 on both models | (0x00 by the offset rule) | [CAP04], [I213] |
| 34 | 2 | u16 | `cellCount` | 0x1C, length 2 | app writes 15, 16, 17 [CAP04]; read 16 |
| 38 | 4 | f32, V | `powerOffVoltage` | 0x20, length 4 | write 3.0 then read 3.0, write 2.7 then read 2.7 [CAP04] |
| 74 | 4 | f32 | `voltageCalibration` (ADC reference, about 3.0) | 0x44, length 4 | write 3.01461 then read 3.01461 (JK-B2A16S), write 3.0868 then read 3.0868 (JK-B5A24S) [CAP04] |
| 98 | 4 | f32, V | `balanceStartVoltage` | not captured; [SY] uses 0x58, the offset rule gives 0x5C (pitfall 1) | reads 4.25 on both models; the iPhone app showed "Start Balance Volt. 4.20" on the JK-B2A16S whose frames read 4.25 ([D48] screenshot); the Android app has no such field ([D48]) |
| 102 | 4 | f32 | `unknown102`, 3.4 on both models | (0x60 by the offset rule) | [CAP04], [BM] |
| 106 | 4 | f32, V | `balanceTriggerVoltage` | 0x64, length 4 | app writes 0.005, 0.009, 0.008, 0.108 [CAP04]; read 0.005 / 0.008 |
| 110 | 4 | f32, A | `maxBalanceCurrent` | 0x68, length 4 | write 2.0 then read 2.0 (was 1.0) [CAP04] |
| 114 | 1 | u8 | `balancerSwitch` (0, 1) | 0x6C, length 1 | JK-B5A24S frames read 0 while every cell frame showed action 0; JK-B2A16S frames read 1 while balancing |

The app labels on the JK-B2A16S settings page ([D48] screenshots): "Cells Count", "Trigger Delta Vol.(V)", "Start Balance Volt.(V)" (iPhone only), "Max Balance Cur.(A)", "Power Off Vol(V)", "ADC Vref(V)". The "ADC Vref" field shows the pack voltage (54.16 V and 53.55 V on screenshots of a pack whose S74 read 3.015), not the raw value.

### 6.3 JK04 device info frame (type 0x03)

Same layout as [JK] 6.3, but only bytes 6..65 carry data on all three models (JK-B2A16S, JK-B2A24S [MPP], JK-B5A24S); bytes 66..298 are 0.

| Offset | Len | Type | Field | Examples |
|---|---|---|---|---|
| 6 | 16 | ASCII | `model` | "JK-B2A16S", "JK-B2A24S", "JK-B5A24S" |
| 22 | 8 | ASCII | `hardwareVersion` | "3.0", "8.X" |
| 30 | 8 | ASCII | `softwareVersion` | "3.3.0", "3.2.3", "8.0.3M" |
| 38 | 4 | u32, s | `uptime`: accumulated operating time | always a multiple of 600 in [CAP04] (37005000, 37081800, 37087800, 18245400); grows across power cycles |
| 42 | 4 | u32 | `powerOnCount` | 19, then 20 after a power cycle; 10 (JK-B5A24S) |
| 46 | 16 | ASCII | `deviceName` (advertised name) | "BMS", "JK-B5A24S", "Power Wall 1" |
| 62 | 16 | ASCII | `devicePasscode` | "1234" |

### 6.4 JK04 ACK frame

`AA 55 90 EB C8 01 01 00 00 00 00 00 00 00 00 00 00 00 00 44`, identical to [JK] 3.3, after every command (section 4.1). Vector `bal-jk04-rx-ack`.

### 6.5 RS485 status answer (command 0xFF)

74 bytes, BE ([JKBAL485] 4.1 table 5; [SY] `JkBalancer::on_status_data_`; [MPP] `jk485` COMMANDS). Checked against the vendor example and five captures of a JK-DZ11-B2A24S hw/sw 11 ([PR18], [SY] pdus-17cells.txt, pdus-20cells.txt).

| Offset | Len | Type | Scale | Field | Notes |
|---|---|---|---|---|---|
| 0 | 2 | | | header EB 90 | |
| 2 | 1 | u8 | | `address` | |
| 3 | 1 | u8 | | `function` 0xFF | |
| 4 | 2 | u16 | 0.01 V | `totalVoltage` | equals the sum of the cells within 3 mV in all captures |
| 6 | 2 | u16 | 0.001 V | `cellVoltageAverage` | |
| 8 | 1 | u8 | | `cellCountDetected` (cells the balancer recognises) | |
| 9 | 1 | u8 | | `cellVoltageMaxIndex`, 0-based | did not match the voltages of the same frame in 1 of 5 captures; compute locally |
| 10 | 1 | u8 | | `cellVoltageMinIndex`, 0-based | 0-based shown by the 20-cell captures (19 = cell 20, the lowest) |
| 11 | 1 | u8 bitmask | | `balanceStatus`: bit 0 charging the lowest cell, bit 1 discharging the highest cell | 0 in every capture (no capture while balancing, **unverified** on hardware) |
| 12 | 1 | u8 bitmask | | `alarmBitmask` (section 9.2) | 0x01 in all five captures although bytes 8 and 22 match (**unverified** meaning of bit 0) |
| 13 | 2 | u16 | 0.001 V | `cellVoltageDelta` (max − min) | 1 of 5 captures differs by 1 mV from the cells |
| 15 | 2 | u16 | 0.001 A | `balanceCurrent` | unsigned per [JKBAL485]; direction from byte 11; 0 in every capture |
| 17 | 2 | u16 | 0.001 V | `balanceTriggerVoltage` | 11 mV on the captured unit |
| 19 | 2 | u16 | 0.001 A | `maxBalanceCurrent` | 2000 mA on the captured unit |
| 21 | 1 | u8 | | `balancerSwitch` (0 off, 1 on) | |
| 22 | 1 | u8 | | `cellCount` (configured) | [SY] decodes min(byte 22, 24) cell voltages |
| 23 | 2 per cell | u16 | 0.001 V | `cellVoltages[n]` at 23 + 2n, 24 slots (23..70) | unused slots 0 in the captures; the vendor example fills all 24 slots |
| 71 | 2 | i16 | 0.1 °C | `temperatureRaw` → `temperature` | captures: 163 and 158 (16.3 and 15.8 °C). [JKBAL485] and [JKBALCAN] say 1 °C (examples 22 and 21); the user of [PR18] reported 0.1 °C steps and [SY] uses 0.1. Sensor optional on the board ([JKM11]); the value without a sensor is unknown |
| 73 | 1 | u8 | | sum8 of bytes 0..72 | |

Derived values used in the vectors: `cellVoltageMin`, `cellVoltageMax`, `cellVoltageMinNumber`, `cellVoltageMaxNumber` (1-based, first occurrence, over the first `cellCount` cells), `cellVoltageDeltaDerived`.

### 6.6 RS485 write answer (commands 0xF0, 0xF2, 0xF4, 0xF6)

| Offset | Len | Type | Field |
|---|---|---|---|
| 0 | 2 | | EB 90 |
| 2 | 1 | u8 | address |
| 3 | 1 | u8 | command code of the request |
| 4 | 2 | u16 | value in effect (equals the request when accepted) |
| 6 | 67 | | reserved, 0 |
| 73 | 1 | u8 | sum8 of bytes 0..72 |

Examples from [JKBAL485] 4.2–4.5 (vectors `bal-rs485-rx-write-answer-*`): `EB 90 01 F0 00 10 00 … 00 7C`, `EB 90 01 F2 00 0A 00 … 00 78`, `EB 90 01 F4 01 F4 00 … 00 65`, `EB 90 01 F6 00 01 00 … 00 73`. [SY] logs the first 6 bytes and ignores the rest. No device capture of a write answer is public.

### 6.7 CAN data of the JK-DZ08 (reference only)

From [JKBALCAN] (machine-translated vendor document): request data `0xFF` to identifier = address; the balancer answers with four or more 8-byte frames whose first byte is the frame kind. Values BE in the examples.

| First byte | Bytes 2..8 |
|---|---|
| 0x01 | temperature i16 (example 0x0015 = 21), total voltage u16 10 mV, average cell voltage u16 mV, detected cell count u8 |
| 0x02 | highest cell u8, lowest cell u8, balance and alarm byte (bit 0 charging, bit 1 discharging, bit 4 cell count wrong, bit 5 wire resistance too high), max delta u16 mV, balance current u16 mA |
| 0x03 | trigger voltage u16 mV, max balance current u16 mA, switch u8, configured cell count u8 |
| 0x04 | first cell index N, then three cell voltages u16 mV (cells N, N+1, N+2), repeated for all cells |

Writes: `F0` cell count, `F2` trigger, `F4` max current, `F6` switch; the answers use `F1`, `F3`, `F5`, `F7` and carry the value in effect.

## 7. Settings

Grouped like the ubms settings catalog (`packages/bms-core/src/catalog.js`). JK04 writes: float32 for length 4, see section 3.1. RS485 writes: u16 BE data of section 3.2, read back from section 6.5.

### 7.1 Balancing

| Catalog id | JK04 read | JK04 write | RS485 read | RS485 write | Range | Status |
|---|---|---|---|---|---|---|
| `balance.trigger_delta` | S106, f32 V | 0x64, length 4 | byte 17, mV | 0xF2, mV | 2–1000 mV ([JKBAL485], [JKBALCAN]); JK04 0.002–1.0 V ([SY] number/__init__.py) | JK04 confirmed by app captures; RS485 vendor document |
| `balance.max_current` | S110, f32 A | 0x68, length 4 | byte 19, mA | 0xF4, mA | vendor document 30–1000 mA, manual V4.1 0.3–2 A, B1A24S at most 1 A and B2A24S at most 2 A ([JKM41] 5.3.3); captured unit reads 2000 mA; JK04 0.1–10 A in [SY]; captured JK04 values 1.0–4.5 A | JK04 confirmed (write and read-back); RS485 vendor document, upper bound **unverified**: ubms writes 0.03–1 A only and shows a higher read value (2 A on the captured unit) without writing it |
| `balance.start_voltage` | S98, f32 V | **not verified**: 0x58 in [SY], 0x5C by the offset rule | none | none | [SY] 1.0–4.2 V | read-only (pitfall 1) |
| `switch.balance` | S114 | 0x6C, length 1 | byte 21 | 0xF6, 0 or 1 | 0, 1 | JK04 confirmed by app capture and effect; RS485 confirmed on hardware ([PR18]) |

Manual guidance (not enforced by the device): the maximum balance current should not exceed 0.1 C of the cell capacity ([JKM41] 5.3.3) or 0.2 C ([JKM11] 3.1); [JKM41] recommends a trigger of 0.005 V for cells above 50 Ah and 0.01 V below.

### 7.2 Cell voltage

| Catalog id | JK04 read | JK04 write | Range | Status |
|---|---|---|---|---|
| `cell.power_off_voltage` | S38, f32 V | 0x20, length 4 | [SY] 2.0–3.7 V; captured 2.2–3.2 V | confirmed (write and read-back). Meaning per the app label "Power Off Vol"; the 2024 balancers have a fixed shutdown at 2.2 ± 0.2 V of the first cell instead ([JKM11] 3.3) |

The RS485 protocol has no voltage setting.

### 7.3 System

| Catalog id | JK04 | RS485 | Range | Status |
|---|---|---|---|---|
| `system.cell_count` | read S34 (u16), write 0x1C length 2 | read byte 22, write 0xF0 | 2–24 ([JKBAL485], [JKM41]); JK04 1–24 in [SY] | JK04 app captures; RS485 vendor document. Danger: a wrong count stops balancing ([JKM41] 5.3.3) |
| `system.address` | none | answer byte 2 echoes it; set in the app only | 1–15 (**unverified**) | read-only, no write command known |

### 7.4 Calibration

| Id | JK04 read | JK04 write | Range | Status |
|---|---|---|---|---|
| `jk.voltage_reference` (ADC reference, as in the `jk-ble` JK04 schema) | S74, f32 | 0x44, length 4 | [SY] 2.80–3.20; captured 2.9603–3.0868 | confirmed by app captures and read-back. The app shows and accepts a pack voltage; how it converts the entered voltage into the reference is not documented (**unverified**; [SY] test comments pair 52.91 V with 3.031334) |

### 7.5 Dependencies and checks

- Write the cell count first; a cell count that differs from the wiring raises the "cell count" alarm and stops correct balancing ([JKM41] 5.3.3 and table 2).
- The maximum balance current must not exceed the model rating (the number after "B" in the model name: JK-B1A24S 1 A, JK-B2A24S 2 A per [JKM41]; JK-B5A24S 5 A per its name, **unverified**).
- RS485: compare the echoed value of the write answer and the next status answer with the request.
- JK04: read back with 0x96 after each write and compare the field of section 6.2.
- Unknown JK04 settings fields (S6, S102) must be left untouched; there is no known register for them.

## 8. Controls and actions

| Action | JK04 BLE | RS485 | Source |
|---|---|---|---|
| balancer on / off | 0x6C, length 1, value 1 / 0 (section 5.2) | 0xF6, 0x0001 / 0x0000 (section 5.3) | [CAP04], [D48], [JKBAL485], [PR18] |
| read device info | 0x97 | none | [CAP04] |
| read settings, start the stream | 0x96 | none (status request 0xFF returns settings and live data together) | [CAP04], [JKBAL485] |

There are no MOSFET switches, no SOC calibration, no restart, shutdown or factory reset command known for any balancer. The app "CONTROL" page is empty for the JK-B1A24S and JK-B2A24S of [JKM41] (5.3.4: "This function is for use on the protection board"); the 2024 manuals put the balancer switch and the CAN / RS485 port selection on the "BMS control" page ([JKM11] 3.1, 3.2).

## 9. Bits and enumerations

### 9.1 JK04 balancing action (C220)

| Value | Meaning | Balance current C222 |
|---|---|---|
| 0 | idle (balancer off, or delta below the trigger) | 0.0 |
| 1 | energy transfer into the lowest cell ("charging balancer") | positive |
| 2 | energy transfer out of the highest cell ("discharging balancer") | negative |

Checked on all 724 [CAP04] frames. While balancing, the action alternates between 1 and 2 every few seconds as the capacitor is charged from the highest cell and discharged into the lowest cell ([CAP04] sequence after `0x6C = 1`; [JKM41] 5.3.2 describes the blue (highest) cell discharging and the red (lowest) cell charging). The app shows "Balancing" or "Waiting" ([D48]).

### 9.2 RS485 status and alarm bytes

| Byte | Bit | Meaning per [JKBAL485] | Observed |
|---|---|---|---|
| 11 | 0 | balancing, charging the lowest cell | 0 in all captures |
| 11 | 1 | balancing, discharging the highest cell | 0 in all captures |
| 12 | 0 | cell count set incorrectly ([SY] label "Wrong cell count") | 1 in all five captures although detected (byte 8) and configured (byte 22) counts were equal: **unverified** |
| 12 | 1 | wire resistance too high ([SY] "Resistance too high") | 0 |
| 12 | 2 | battery overvoltage ([SY] "Overvoltage") | 0 |
| 12 | 3–7 | reserved | 0 |

[SY] treats byte 11 as an enumeration (0 idle, 1 charging, 2 discharging), which is the same for single bits. A driver should derive "cell count mismatch" from byte 8 ≠ byte 22 rather than from bit 0 alone.

## 10. Device information

| Item | JK04 BLE (frame 0x03) | RS485 |
|---|---|---|
| model | D6 | not available |
| hardware version | D22 | not available |
| software version | D30 | not available |
| operating time | D38 (s, 600 s steps) | not available |
| power-on count | D42 | not available |
| device name | D46 | not available |
| passcode | D62 ("1234") | not available |
| time since power-on | C286 (s) | not available |
| address | | byte 2 of every answer |

Version strings: the major number (digits before the first dot) is 3 or 8 on the known JK04 balancers, so the JK02 rule of [JK] 1.2 (major < 11 = JK02_24S) does not identify them; [JK] 11.3 detects JK04 from the cell frame.

## 11. Detection

### 11.1 Bluetooth

1. Scan for service 0xFFE0. JK BMSes, ANT BMSes and NEEY / Heltec balancers use the same UUIDs ([JK] 11.1), so always validate the answer.
2. Probe with 0x97 ([JK] 11.2). A JK04 balancer answers within about 0.1 s with a valid 300-byte device info frame (type 0x03, sum8) and the ACK frame.
3. Model heuristic: the three known JK04 models report model strings without the current suffix that every JK BMS model has ("JK-B2A16S", "JK-B2A24S", "JK-B5A24S" against "JK-B2A24S15P", "JK_PB2A16S15P", "JK_BD4A24S4P"); [BM] jk04.py states the same rule. Regular expression `^JK[-_]B\d+A\d+S$`. A model string alone does not prove JK04: 2024 balancers may report a similar model and speak JK02_32S (**unverified**).
4. Decide JK04 from the first cell info frame after 0x96 ([JK] 11.3: float32 cell slots with byte 9 + 4i = 0x3F or 0x40 and values 0.5–5.0 V, at least two cells), as the `jk-ble` driver does (`looksLikeJk04CellInfo`). Additional JK04 signs: device info bytes 66..298 all 0, settings byte S114 ∈ {0, 1} with S34 = cell count and S38 a float32 between 2.0 and 3.7 V.
5. Driver order in ubms: the advertised name is user defined (section 2.1), so it cannot tell a balancer from a BMS. `jk-balancer-ble` ranks equally with `jk-ble` for every "JK-" or "JK_" name and is registered first, so its probe (steps 2 to 4) runs before `jk-ble` for those names and for names no driver ranks. It rejects a JK BMS after the device info frame (software 11 or later, or a BMS model string with a filled tail) or after the first data frame; a JK BMS pays one extra 0x97 request.

### 11.2 RS485 probe

1. Open the port at 9600 8N1. Send `55 AA <address> FF 00 00 <sum8>` (address 1 unless configured, `55 AA 01 FF 00 00 FF`). This request only reads.
2. Accept the answer when: 74 bytes, starts with `EB 90`, byte 2 = address, byte 3 = 0xFF, byte 73 = sum8 of bytes 0..72, byte 22 (configured cells) in 2–24, byte 8 ≤ 24, no configured cell voltage above 5.0 V (acquisition range 1.0–5.0 V, [JKM41] 1), `totalVoltage` within 0.1 V of the cell sum, `cellVoltageAverage` within 0.01 V of the mean. Do not reject a cell below 1.0 V: an open sense lead, or a configured cell count above the wired cells, reads near 0 V, and a probe that refused it would make the balancer unreachable on every new connection, so the cell count could not be corrected. The other checks still reject foreign frames. Polling applies the same checks without the total and average comparison, so a fault stays visible.
3. Wait at least 1 s for the answer and at most one retry; send nothing else before the timeout ([JKBAL485] 3).

Other ubms serial protocols at 9600 baud use other frames (Daly `A5` with a 13-byte layout, JBD style `DD A5`), the JK BMS serial protocols run at 115200 baud ([JK] 2.2, 2.3). A JK balancer does not answer them, and a JK BMS does not answer `55 AA`.

## 12. Pitfalls and quirks

1. **JK04 balance start voltage write register is not verified.** [SY] writes register 0x58, but no capture contains such a write (the Android app has no field for it, the iPhone app was never captured). The six captured JK04 registers all equal "settings offset − 6", which gives 0x5C for S98; 0x58 would address S94, a field that reads 0. Keep `balance.start_voltage` read-only on JK04 until a capture shows the register. Both drivers do: the `jk-ble` JK04 schema (`buildJk04Schema`) and `jk-balancer-ble` keep it read only. `JK04_SETTINGS_LAYOUT` still records 0x58 as the ESPHome register, used only to name the register in the log, never to build a write.
2. The JK04 cell info fields `cellVoltageAverage`, `cellVoltageDelta` and the min / max indexes do not always match the cell voltages of the same frame (section 6.1). The same applies to the RS485 index bytes and delta (section 6.5). Compute these values from the cells.
3. Index bytes are 0-based in both protocols; the RS485 vendor document and [MPP] present them as cell numbers.
4. RS485 temperature: vendor documents say 1 °C, the captured unit sends 0.1 °C. Without a sensor the raw value is unknown; treat implausible values (outside −40–100 °C after scaling) as absent.
5. RS485 alarm bit 0 was set in every capture while the cell counts matched (section 9.2).
6. RS485 max balance current: the vendor range 30–1000 mA contradicts the 2000 mA read from a JK-DZ11-B2A24S; a refused write answers with the old value, so always compare the echo. No write above 1000 mA is documented and the status answer carries no model to tell a 1 A unit from a 2 A unit (section 10), so ubms writes within the vendor range only.
7. The vendor RS485 example frame is synthetic: 24 voltage slots filled although 20 cells are configured, and its text contains the typo "3.995 V" for 0x0F69 (3.945 V).
8. RS485 A/B labelling may be reversed on some units (section 2.2).
9. JK-DZ08 units are CAN devices (VP1050 CAN transceiver on a V08 board, DIP address switches); they do not answer RS485 requests ([PR18] 2025-02-02). Older V06 boards may carry an RS485 transceiver; the variant can only be told from the board.
10. A statement relayed from JK ([SY] discussion 368, 2024-01-12) says the balancer RS485 port "can only read data and cannot change settings"; the 0xF6 switch write worked on a JK-DZ11-B2A24S in 2025 ([PR18]). Treat other RS485 writes as untested on hardware.
11. JK04 "Start Balance Volt." shows 4.20 in the iPhone app while S98 reads 4.25 (section 6.2); the semantics of S98 are unclear, the balancers balanced at cell voltages of 3.27–3.46 V with S98 = 4.25.
12. JK04 writes are acknowledged even when the value is not applied? Not observed: every read-back after a captured write showed the new value. The JK02 rule of [JK] 4.2 (wait 1 s after a 0x96 before writing) has not been tested on JK04; keep it.
13. JK02 registers sent to a JK04 balancer are acknowledged but do nothing (0x1F balancer, [D48]); 0x6C is the JK04 balancer switch but "time calibration" on JK02_32S ([JK] 8.2). Never use a JK02 register table for a JK04 device.
14. JK04 C286 is time since power-on, D38 the accumulated operating time; [JK] calls C286 `totalRuntime`.
15. A JK04 balancer has no pack voltage field; the app's "Bat. Vol" is the sum of the cells. There is also no current, SOC, temperature or alarm field: the unified snapshot must leave them empty instead of reporting 0.
16. The JK-B2A16S does not negotiate the MTU (20-byte notifications); the JK-B5A24S requests 115 bytes itself. Both need reassembly.
17. 2024 balancers (firmware 11.x) are configured in the JK BMS app with BMS-like pages and one user decoded a JK-DZ11-B2A24S hw/sw 11 with the JK02_32S decoder of [SY] ([PR18] 2025-01-31). If they speak JK02_32S, current, SOC, MOSFET and protection fields will read 0 or defaults and must not raise alarms. No frame of such a balancer is public.
18. The JK-B1A24S hw 6.0 sw 6.0.3 of [SY] discussion 1066 works with a third-party app and did not answer the Heltec balancer component; its protocol is unknown.

## 13. References

All URLs point to the default branch as read on 2026-11-18.

[SY] syssi/esphome-jk-bms, https://github.com/syssi/esphome-jk-bms
- components/jk_balancer/jk_balancer.cpp: `JkBalancer::on_status_data_` (offset table in comments), `on_jk_balancer_modbus_data`, `update`; jk_balancer.h; __init__.py (`DEFAULT_ERRORS`, `update_interval` default 5 s, address default 0x01); number/__init__.py (`NUMBERS` 0xF0, 0xF2, 0xF4, ranges 2–24, 2–1000 mV, 30–2000 mA); number/jk_number.cpp `JkNumber::control`; switch/__init__.py (`SWITCHES` balancer 0xF6), switch/jk_switch.cpp `JkSwitch::write_state`
- components/jk_balancer_modbus/jk_balancer_modbus.cpp: `parse_jk_balancer_modbus_byte_` (`frame_len = 74`, sum8 `chksum`), `send`, `loop` (`rx_timeout_` 100 ms)
- tests/components/jk_balancer/common.h (`STATUS_FRAME_17S`), jk_balancer_test.cpp (TotalAndAverageVoltage, CellCountDetected, BalancingState, Errors, CellVoltageStats, BatteryTemperature), jk_balancer_errors_test.cpp
- docs/balancer-b1a24s/protocol-design.md, pdus-17cells.txt, pdus-20cells.txt, JK-B1A24S-RS485-protocol-english.pdf ([JKBAL485]), JK-DZ08_B1A24S_V4.zh-CN.en.pdf ([JKBALCAN]); docs/cn/Active balancer Specification and operation manual(JK-B1A24S)(JK-B2A24S)V4.1.pdf ([JKM41])
- esp32-active-balancer-example.yaml, esp8266-active-balancer-example.yaml (9600 baud)
- components/jk_bms_ble/jk_bms_ble.cpp: `decode_jk04_cell_info_`, `decode_jk04_settings_`, `encode_jk04_payload`, `build_frame`; number/__init__.py (`NUMBERS` JK04 column and ranges, `CONF_BALANCING_START_VOLTAGE` 0x58)
- tests/components/jk_bms_ble/frames_jk04.h, frames_jk04_b5a24s.h, jk_bms_ble_jk04_test.cpp, jk_bms_ble_jk04_b5a24s_test.cpp (write frame tests: PowerOffVoltage3p2V, BalanceTrigger8mV, MaxBalanceCurrent4p5A, CellCount16, BalancerOn, BalancerOff, VoltageCalibration3p031334V, BalancingStartVoltage1p00V)
- [CAP04] docs/btsnoop_hci_jk-b2a16s_hw30_sw330.log, docs/btsnoop_hci_jk-b2a16s_hw30_sw330_cmds.log, docs/b5a24s/bt-snoop-JK-B5A24S.log (official app captures, decoded for this document: GATT discovery, MTU exchange, 50 writes, 62 ACKs, 26 device info and settings frames, 724 cell info frames); docs/pdus/JK-B2A16S-3.3.0-BLE-JK04.txt (65 ESPHome cell frames); docs/b5a24s/JK-B5A24S-8.0.3M-BLE-JK02.txt
- [PR18] pull request 18 "Add JK active balancer (DZxx) support" with the 2021 and 2025 comments (RS485 captures of a JK-DZ11-B2A24S, polarity, addresses, DZ08 CAN hardware), https://github.com/syssi/esphome-jk-bms/pull/18; issues 16 and 17 (vendor example frame, JK-DZ11-B2A24S hw 6.0 sw 6.0.5)
- [D48] discussion 48 "Add JK-B2A16S support" (JK04 reverse engineering, app write frames, screenshots, ESPHome logs), https://github.com/syssi/esphome-jk-bms/discussions/48; [I213] issue 213 "Improve JK-B5A24S balancer support", https://github.com/syssi/esphome-jk-bms/issues/213; issue 94 (JK04 registers); pull request 991 (JK04 number writes); issue 1021 (JK_BD4A24S4P is a JK02_32S BMS); issue 745, discussions 714, 1066, 368, 516
- README.md (device list)

[MPP] jblance/mpp-solar, https://github.com/jblance/mpp-solar
- mppsolar/protocols/jk485.py (`COMMANDS` getBalancerData, `get_full_command`), mppsolar/protocols/protocol_helpers.py (`crc8` = sum8), tests/integration/test_protocol_jk485.py (test_getBalancerData)
- mppsolar/protocols/jk04.py, tests/integration/test_protocol_jk04.py (JK-B2A24S hw 3.0 sw 3.2.3)
- issue 179 (JK-DZ11-B2A24S, no answer before the polarity fix)

[BM] fl4p/batmon-ha, https://github.com/fl4p/batmon-ha: bmslib/models/jk04.py (module docstring, `looks_like_jk04_status`, `decode_jk04_status`, `decode_jk04_settings`, `JK04Bt.set_switch`), bmslib/test/data/jk04_fixtures.py

[AIO] patman15/aiobmsble, https://github.com/patman15/aiobmsble: aiobmsble/bms/jikong_bms.py (JK02 only, no JK04), aiobmsble/test_data/jikong_bms.json; BMS_BLE-HA issue 682 (JK-BD4A8S-4P hw 11H sw 11.56), https://github.com/patman15/BMS_BLE-HA/issues/682

[ZY] Ziyatoe/JK-BMS_BLE_READER issue 1 "JK-B2A24S" (one JK04 cell info frame as 14 notifications of 20 bytes; the last 20 bytes are missing, so it is not a vector), https://github.com/Ziyatoe/JK-BMS_BLE_READER/issues/1

[DSB1090] Louisvdw/dbus-serialbattery discussion 1090 "JK DZ11" (the JK PC software and RS485 adapter do not see the balancer), https://github.com/Louisvdw/dbus-serialbattery/discussions/1090; mr-manuel/venus-os_dbus-serialbattery issue 142 (no support planned)

[JKBAL485] JK "JK-DZ11-B2A24S balancer communication protocol V1.3", RS485 9600 baud, commands 0xFF, 0xF0, 0xF2, 0xF4, 0xF6; copies in [SY] docs/balancer-b1a24s/JK-B1A24S-RS485-protocol-english.pdf and [MPP] docs/protocols/JK-B1A24S-RS485-protocol-english.pdf

[JKBALCAN] JK "JK-DZ08-B1A24S Equalizer communication protocol" (CAN 500 kbit/s), [SY] docs/balancer-b1a24s/JK-DZ08_B1A24S_V4.zh-CN.en.pdf

[JKM41] JK "Battery Active-Balancer JK-B1A24S/JK-B2A24S Specification and operation manual" V4.1, [SY] docs/cn/

[JKM11] JK "Lithium Battery Active Equalizer Specification and operation manual": JK-B2A24S V11.5.1 (2024-03-26), JK-B4A24S V11.1.1 (2024-03-21), JK-B2A8S V11.6.2, JK-B2A16S-TH V11.5.1, NY-B2A16S-TH V16.0.2, https://jkess-website.vercel.app/downloads/BMS-Protection-Board/ (file names as listed in https://github.com/bigelephant-code/jkess-website/blob/main/src/lib/downloads.ts)
