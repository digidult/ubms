# NEEY / Heltec / EnerKey active balancers ("AA 55 11" protocol)

Implementation reference for a ubms driver of the NEEY active balancers with Bluetooth LE: the 4 A units sold as NEEY, Heltec or "Smart Active Balancer" (GW-24S4EB, EK-24S4EB, EK-16S2EB), the 8 A to 20 A EnerKey units (EK-24S10EB, EK-24S15EB, EK-24S20EB) including the "4th generation" hardware, and the EK-B24S8E200A, a 200 A unit that adds BMS functions to the balancer.

Compiled 2026-11-19 from the source code, tests, captures and issue logs of the open-source projects listed in section 13, the vendor manual, and BLE captures decoded for this document (btsnoop logs of the vendor apps and nRF Connect logs posted by users). Every statement carries a source tag. **unverified** marks a value that has a single weak source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/neey.json` (103 vectors: 41 requests, 55 answers of the balancer, 7 foreign frames). Field names written in `code` in this document are the keys of the `expected` objects of that file. Units in the vectors follow the protocol: V, A, Ah, °C, s, and Ω for the lead resistances (the ubms model uses mΩ, section 6.4). Further keys: `function`, `command`, `register`, `lengthField`, `checksumAlgorithm` (`sum8` or `xor8`), `checksum`, `value` (requests); `rawValue` (u32 at offset 8 of a 20-byte answer); `notifications` (the BLE notification pieces in arrival order where a capture shows the split); `frameTypes`, `frameLengths`, `checksums` (a byte stream holding several frames); `foreign: true` with `family` (frames of other device families that a NEEY parser must reject, section 11.4). `variant` is `NEEY_V1`, `NEEY_V2` (section 1.2) or `FOREIGN`. `expectedComputed: true` marks the 13 requests that were built from a source's encoder description instead of being copied from a capture or a test file. Every vector was checked with a node script (`neey-research/verify.mjs` in the session scratchpad): header, address 0x11, end marker 0xFF, length field, checksum (sum8 for every answer and for the current requests, XOR for the frames of the old Android app), an independent decode compared with every expected value, and the presence of the exact bytes (or of every notification piece) in the cached copy of at least one cited source. All 103 pass; the 13 computed requests and 5 of the 7 foreign frames (copied from the other vector files of this repository) are, as expected, not present in the NEEY sources. Five answers appear twice with identical bytes under different ids because different units sent them (for example the settings frames of a GW-24S4EB ZH-1.2.3 and an EK-24S4EB ZH-1.2.9, or the acknowledgement of register 0x0D on three firmware versions); they are kept as evidence that the layouts agree.

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

- Offsets are byte offsets from the first byte of a frame, decimal, with hex in parentheses where useful: 216 (0xD8).
- Types: u8, u16, u24, u32 unsigned little-endian; f32 is an IEEE 754 single precision float, little-endian. ASCII fields are padded with 0x00.
- sum8 = (sum of the covered bytes) modulo 256. xor8 = XOR of the covered bytes.
- "Request" is a frame from the host to the balancer, "answer" a frame from the balancer (also when it is pushed without a request).
- Variant names used here and in the vectors: `NEEY_V1` (100-byte settings frame, 2 temperatures), `NEEY_V2` (150-byte settings frame, pack current, SOC, 4 temperatures), section 1.2.
- Source tags (details in section 13): [SY] syssi/esphome-jk-bms, component `heltec_balancer_ble` (code, unit tests, docs) and its issues and pull requests, cited as [SY#n] and [SY PR n]; [SYC] the three btsnoop captures in [SY] docs, decoded for this document; [AIO] patman15/aiobmsble `neey_bms.py` and its tests and advertisement data; [HA#n] issues of patman15/BMS_BLE-HA with debug logs and nRF Connect logs; [BSC] shining-man/bsc_fw (`NeeyBalancer`, `NeeySerial`); [BM] fl4p/batmon-ha `BMS_FACTSHEET.md`; [MAN] the vendor manual "NEEY-24S4EB Battery Active-Balancer Specification and operation manual" Ver1.1; [DS] the vendor datasheet sheet "NEEY BALANCER".

## 1. Overview

### 1.1 Devices and models

The device information frame (section 6.1) carries the model, hardware and software version and a "protocol version" string. Known units:

| Model (frame) | Hardware | Software | Protocol string | Variant | Sources |
| --- | --- | --- | --- | --- | --- |
| GW-24S4EB (4 A) | HW-2.8.0 | SW-1.1.0 (production 2021-09) | V1.0.0 | NEEY_V1 | [SYC] gw-24s4eb-sw110, [SY#384] |
| GW-24S4EB | HW-2.8.0 | ZH-1.2.3 (production 2022) | V1.0.0 | NEEY_V1 | [SY#109], [SY#444], [AIO] tests |
| GW-24S4EB ("4th generation") | HW-3.2.0 | ZH-1.2.4 (production 2022-12) | V1.0.0 | NEEY_V1 | [HA#291] (hand transcription), [SY] README |
| EK-24S4EB (4 A) | HW-3.2.0 | ZH-1.2.9, ZH-1.3.2 | V1.2.9 (ZH-1.2.9; not reported for ZH-1.3.2) | NEEY_V1 | [SY#444] |
| EK-24S4EB | HW-3.2.0 | ZH-2.0.2, ZH-2.0.8 | V1.2.27, V1.2.73 | NEEY_V1 | [SY#707], [SY#640], [SYC] ek-24s4eb-zh208 |
| EK-24S4EB ("4th generation") | HW-3.2.0 | ZH-2.1.1 (production 2026) | V1.3.13 | NEEY_V1 | [SY#767], [SY#950], [SY#1031], [SYC] ek-24s4eb-zh211, [SY] tests |
| EK-16S2EB (2 A, 16 cells) | not reported | not reported | not reported | NEEY_V1 | [HA#454] (cell frames only) |
| EK-24S10EB (10 A) | HW-1.1.5 / HW-2.0.0 | SW-1.1.1 / ZL-2.0.2 | V0.1.73 (ZL-2.0.2; not reported for SW-1.1.1) | NEEY_V1 | [SY] README, [SY#1027], [SY] tests |
| EK-24S15EB (15 A) | not reported | not reported | not reported | NEEY_V1 (**unverified**, no frame) | [SY] README, [SY PR 571] |
| EK-24S20EB (20 A) | HW-1.8.0 | ZL-1.8.2 | V0.1.73 | NEEY_V1 (frames not published) | [SY#1092] |
| EK-B24S8E200A (balancer 8 A with 200 A BMS, advertises as "EK-24S200A") | HW-2.0.0 | SW-2.0.0 (production 2025-10) | V1.3.36 | NEEY_V2 | [SY PR 952], [SY] tests, [AIO] tests, [HA#670] |

Notes:

- "NEEY" is Henan Nengyi Electronic Technology Co., Ltd. ([MAN]); the same units are sold as Heltec and EnerKey ([SY#444], [BM]). The vendor apps are "NEEY" (old Android app V3.1, which cannot talk to EK units), "neey-v1.2.14" / "zy-v1.2.24" and the EnerKey iOS app ([SY#444] comments 1937584807, 1944561220; [BM] names the Android package `com.sjty.heltec`).
- The model name encodes the rating: `<cells>S<amps>EB`, e.g. EK-24S10EB = 24 cells, 10 A ([SY] README, [SY#1092]). [MAN]: 2–24 cells, cell voltage range 1–5 V, constant balance current up to 4 A for the NEEY-24S4EB, supercapacitor energy transfer.
- These are active balancers: no current shunt, no MOSFETs ([MAN], [BM]). The EK-B24S8E200A is the exception: it reports pack current, capacity, SOC and four temperatures and carries BMS protection settings (section 6.3, 6.5; [HA#670]: "Its a full bms").
- Not covered: JK active balancers (JK-B2A24S and others, [jk-balancer.md](jk-balancer.md)); a JK-B1A24S hw 6.0 did not answer this protocol ([jk-balancer.md](jk-balancer.md) pitfall 18).

### 1.2 Protocol variants

Both variants use the same frames, requests and write command 0x05 with register 0x0D (balancer switch). They differ in two answers:

| | NEEY_V1 | NEEY_V2 |
| --- | --- | --- |
| Settings frame (0x04) | 100 bytes, section 6.2 | 150 bytes, section 6.3 |
| Cell info frame (0x02) | 300 bytes, 2 temperatures, section 6.4 | 300 bytes, identical up to offset 216, then pack current, 4 temperatures, capacity, SOC, section 6.5 |
| Extra write command | none | 0x06 for BMS protection registers (**unverified**, section 5.3) |
| Models | all except EK-B... | EK-B24S8E200A |

Sources: [SY] `decode_()` (chooses V2 when the settings frame has 150 bytes), `decode_cell_info_v2_`, `decode_settings_v2_`; [AIO] (chooses v2 when the model starts with "EK-B").

### 1.3 Telling variants apart at runtime

- Read the settings frame (request 0x04) and use its length: 150 bytes means NEEY_V2, 100 bytes NEEY_V1 ([SY] `decode_()`). This is the only rule seen in a source that does not depend on a model name.
- The model from the device info frame is a hint: [AIO] treats every model starting with "EK-B" as v2. Only one such model is known.
- The cell info frame alone does not identify the variant (both are 300 bytes with the same header); a V1 decoder applied to a V2 frame reads the pack current as a temperature ([HA#670]: temperatures of about -3·10^20 °C). Decode cell info only after the variant is known; until then show the shared part (offsets 8..216).
- The protocol version string does not separate the variants (V1.3.13 on a NEEY_V1 unit, V1.3.36 on NEEY_V2).

### 1.4 Coverage in ubms

One BLE driver definition `neey-ble`, family `neey`, vendor "NEEY", device type `balancer`, marked experimental, variants `NEEY_V1` and `NEEY_V2` (section 11). No serial definition (section 2.2). Code: `packages/bms-drivers/src/neey/` (`protocol.js` frames, parsers and encoders; `settings.js` schema; `driver.js` driver, snapshot and device info mapping, definition; `simulator.js` device side for the demo and the tests; `index.js` with `neeyDrivers` and the registration advice of 11.6). Tests: `packages/bms-drivers/test/neey.test.js` (every vector decoded and re-encoded byte for byte, the encoders, the schema census, detection against the simulators of the other FFE0 families, sessions over an in-memory link).

Implementation choices (ubms, not device facts):

- Parsers return float32 values unrounded, so the encoders reproduce every captured frame; the snapshot rounds (cells 0.1 mV, resistances 0.01 mΩ, temperatures 0.1 °C).
- Cell lists: the parser keeps the slots up to the last non-zero voltage (no vector has a zero slot between cells); the snapshot shows the configured cell count of the settings frame or the slots up to the last non-zero voltage, whichever is higher, so an unwired configured slot shows 0 V and a cell wired beyond the configured count (status 0x01) stays visible (9.2).
- A settings frame younger than 10 s is reused instead of a new request: the frame of the probe serves the first settings screen and the frame after a write serves the read-back, so the balancer does not beep for them (4.2). Only the vendor app changes settings otherwise, and it cannot be connected at the same time (2.1). When no settings frame arrived after a write, the cached frame is marked stale: the read-back then requests a new one, and if that fails the session reports a read-back error instead of comparing against the values from before the write (4.3).
- Requests use sum8. A unit that answers neither sum8 device info attempt gets the xor8 form of the old app once; if it answers, every later request uses the captured xor8 forms (3.4, 11.2).
- Writes are refused while the variant is provisional (no settings frame seen, 11.5): the registers differ between the layouts (5.3).
- Alarms with the same id are merged (sources joined, the more severe level kept), for example status 0x03 and the lead resistance mask.
- No action is offered: the factory data request 0x03 carries the label "Factory reset" in one source (5.1, 8).

## 2. Physical links

### 2.1 BLE

GATT tables ([SY] `gattc_event_handler` comments for GW-24S4EB HW-2.8.0 SW-1.1.0 and EK-24S4EB HW-3.2.0 ZH-1.2.9; [SY#109] comment 1200409014 log; [SYC] discovery of the three captures; [HA#670] nRF Connect log of the EK-B24S8E200A):

| Item | Value |
| --- | --- |
| Services | 0x1800 (handles 0x0001–0x0007: 0x2A00 device name, 0x2A01 appearance, 0x2A04 preferred connection parameters, all read) and 0xFFE0 = `0000ffe0-0000-1000-8000-00805f9b34fb` (0x0008–0xFFFF); characteristics `0000ffe1-0000-1000-8000-00805f9b34fb`, `0000ffe2-0000-1000-8000-00805f9b34fb`, `0000ffe3-0000-1000-8000-00805f9b34fb` ([HA#670] nRF log) |
| FFE1 | value handle 0x000A, properties 0x1C (write without response, write, notify), CCCD 0x000B |
| FFE2 | value handle 0x000D, properties 0x1C |
| FFE3 | value handle 0x0010, properties 0x0C (write, write without response) |
| Used by the apps | CCCD 0x000B = 01 00 (ATT Write Request), then every request as ATT Write Command (0x52) to 0x000A; all answers as notifications on 0x000A ([SY#444] comment 1948446768; [SYC] all three captures: one Write Request, notifications on handle 0x000A only) |
| MTU | GW SW-1.1.0 and EK ZH-2.0.8: no MTU exchange in the app captures, 20-byte notifications ([SYC]); EK ZH-2.1.1: the balancer itself sends an Exchange MTU Request of 153 bytes, answers arrive as 100-byte and 150-byte notifications ([SYC] ek-24s4eb-zh211, vector `rx-ek-zh211-cell-info-split-150`); ESP32 clients negotiate 244 ([SY] comment "cfg_mtu status 0, mtu 244"), [BSC] handles 241-byte notifications |
| Pairing | none; no PIN in any source |
| Connections | one central at a time: the vendor app must be closed for ESPHome or Home Assistant to connect ([SY#1031], [HA#670] comment 14); two balancers on one ESP32 caused sporadic disconnects ([SY#387], [SY#310]) |

ubms profile: service 0xFFE0, notify and write on 0xFFE1, write without response (as the apps and [SY] do), writes of exactly 20 bytes. FFE2 and FFE3 carry no traffic in any capture.

Advertising (the name is in the scan response on these modules):

| Module type | Address examples | Advertisement | Name | Sources |
| --- | --- | --- | --- | --- |
| Older modules (GW-24S4EB, EK-24S4EB up to ZH-2.0.8) | 3C:A5:51:xx:xx:xx, 2B:80:03:xx:xx:xx | flags, 16-bit service list `FFE0, FEE7`, manufacturer data with a company id that differs per unit (0x17D7, 0x720D, 0x301C, 0xD9D9) and the payload `88 A0` followed by the 6 address bytes in normal order, e.g. adv data `02 01 06 05 02 E0 FF E7 FE 0B FF D7 17 88 A0 3C A5 51 89 34 C5` | empty in some advertisements; "GW-24S4EB", "EK-24S4EB" by default, user defined names seen: "neey", "GW-2BMS" | [SY#384] comment 1784050070, [SY#444] comment 1934095115, [SY#640], [AIO] test data, [HA#454] |
| "4th generation" modules (EK-24S4EB ZH-2.1.1, EK-24S10EB, EK-16S2EB, EK-B24S8E200A, the "Backup BMS" unit of [HA#291]) | 33:39:xx:xx:xx:xx, 38:36:xx:xx:xx:xx | service list `FFE0, FEE7` (adv data `02 01 06 05 02 E0 FF E7 FE`), manufacturer data company 0x8888 with payload `88 88` followed by the address bytes in reverse order, e.g. `88 88 BF 95 01 11 36 38` for 38:36:11:01:95:BF | "EK-24S4EB", "EK-16S2EB", "EK-24S200A"; user defined names seen: "Backup BMS", "GW-24Srenamed1" | [SY#767] comments 3032611742, 3034652044; [HA#291] comment 2895622080; [AIO] test data; [HA#670] |

The vendor app shows the address of the 4th generation modules in reverse byte order; users who copied it from the app could not connect ([SY#767], [SY#1027] comment 5012912579). Web Bluetooth does not expose addresses, so this only matters for messages shown to users.

The `88 A0` payload and the FEE7 service are module traits that JK BMS, ANT BMS and Atorch modules share ([jk.md](jk.md) section 11.1, [ant.md](ant.md) section 2, [atorch.md](atorch.md) section 2.1); they cannot identify a NEEY unit. Company 0x8888 with an `88 88` payload was seen only on NEEY units in the sources read (**unverified** as a unique trait).

### 2.2 Wired serial

None usable. Some EnerKey units have a "TTL" connector, but users saw no data on it at any baud rate ([SY#1027] comment 5129192777) and no protocol is documented ([SY#444] comment 4010419531). [BSC] `NeeySerial.cpp` is an experiment that writes the BLE requests to a serial port and logs whatever comes back; its comment lists `+CONNECTED\r\n` and `+DISCONNECTED\r\n`, which look like the status lines of the BLE module on the internal module UART (**unverified**). [AIO] defines `AT\r\n` as a "message from the BLE module" (`_BT_MODULE_MSG`) without using it. No serial profile is proposed.

## 3. Frame formats

### 3.1 Request frame (host to balancer)

Always 20 bytes ([SY] `build_command_frame_`, [AIO] `_cmd`, [BSC] `neeyBtBuildSendData`, every captured request):

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | `AA 55` | request start |
| 2 | 1 | 0x11 | device address, fixed |
| 3 | 1 | function | 0x01 read, 0x00 write |
| 4 | 1 | command | 0x01 device info, 0x02 cell info, 0x03 factory defaults, 0x04 settings, 0x05 write register, 0x06 write V2 register (section 5) |
| 5 | 1 | register | 0x00 for reads |
| 6 | 2 | length, u16 = 0x0014 (20) | the old Android app sends `00 14` (swapped) in the cell info request only (section 3.4) |
| 8 | 4 | value | u32 or f32, little-endian; 0 for reads |
| 12 | 6 | zero | except the device name write, which uses bytes 8..17 for up to 10 ASCII characters ([SY] number/__init__.py comment table, **unverified**) |
| 18 | 1 | checksum | sum8 of bytes 0..17 (section 3.3) |
| 19 | 1 | 0xFF | end marker |

[SY] names bytes 4..5 "command" (2 bytes) in comments; the code and every capture use byte 4 as command and byte 5 as register.

### 3.2 Answer frame (balancer to host)

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | `55 AA` | answer start (byte order reversed against the request) |
| 2 | 1 | 0x11 | device address |
| 3 | 1 | function | 0x01 for data frames, 0x00 for a write acknowledgement |
| 4 | 1 | command / frame type | 0x01, 0x02, 0x03, 0x04, 0x05 |
| 5 | 1 | register | 0x00, or the written register in an acknowledgement |
| 6 | 2 | frame length, u16 | 20 (acknowledgement and factory echo), 100 (device info, factory defaults, V1 settings), 150 (V2 settings), 300 (cell info); the total length including header, checksum and end marker |
| 8 | n − 10 | payload | section 6 |
| n − 2 | 1 | checksum | sum8 of bytes 0..n−3 |
| n − 1 | 1 | 0xFF | end marker |

Sources: [SY] `assemble` (lengths 20..300, end marker, sum8), every frame of [SYC], [AIO] `_notification_handler`. All 55 answer vectors carry a valid sum8 checksum.

### 3.3 Checksum

sum8 over bytes 0..17 of a request and over bytes 0..n−3 of an answer. Example: device info request `AA 55 11 01 01 00 14 00 00 .. 00 26 FF`: 0xAA + 0x55 + 0x11 + 0x01 + 0x01 + 0x14 = 0x126, low byte 0x26 ([SY] tests `CrcIsCorrect`, [SY#444] capture).

The old NEEY Android app (V3.1, GW-24S4EB SW-1.1.0 capture) uses xor8 over bytes 0..17 instead: the same request carries 0xFA ([SYC] gw-24s4eb-sw110, [SY#109] comment 1200280511 "Commands", [SY#384]). [BSC] picks xor8 for GW-24S4EB units and sum8 for EK units (`neeyBtCrc`). Answers always use sum8, on every firmware.

### 3.4 What the balancer accepts

| Request form | GW-24S4EB SW-1.1.0 | GW-24S4EB ZH-1.2.3 | EK-24S4EB ZH-1.2.9 and later, EK-16S2EB |
| --- | --- | --- | --- |
| sum8, length `14 00` (current form) | **unverified** (no capture; [SY PR 677] states that GW and EK behave the same without details) | answered ([SY#109] comment 1200247482, 2022; [SY#444] comment 1951365713, 2024) | answered ([SY#444] comment 1949941551, [SYC] ek-24s4eb-zh208, [SY#640]) |
| xor8, cell info with length `00 14` (old app) | answered ([SYC] gw-24s4eb-sw110, [SY#384] comment 1784050070 with ESPHome 2023) | answered ([SY#109] comment 1200459251, factory request) | not answered: "the device doesn't respond to the requests/commands of other models" ([SY#444] comments 1934112368 and 1949938945; it answered after [SY] switched to sum8 and the normal length) |
| `55 AA` start instead of `AA 55` | not answered ([SY#109] comments 1200400389, 1200402154) | | |
| 21 bytes, length byte 0 ([AIO] bug of 2025) | | | not answered by EK-16S2EB ([HA#454] comments 3198064982, 3201971117) |

Conclusion: send the sum8 form with the length `14 00`. EK firmware checks at least the length and the checksum and drops a failing request silently; no NAK frame exists in any source. GW ZH-1.2.3 answers both checksum forms, so it probably does not check the checksum (**unverified**). Every request seen reaching a GW SW-1.1.0 used xor8: the app capture ([SYC] gw-24s4eb-sw110) and ESPHome in 2023 ([SY#384] comment 1784050070: `.. FA FF` device info, `.. F9 FF` cell info, answered; the issue was closed as an ESP32 board problem). Whether SW-1.1.0 answers sum8 is not known (**unverified**).

As implemented: the probe sends the sum8 device info request twice, then once its xor8 form (vector `tx-device-info-xor-app`, a read; EK firmware drops it silently). When only the xor8 form is answered, the driver sends every later request in the form the old app sent to SW-1.1.0: `tx-settings-xor-app`, `tx-cell-info-xor-app-swapped-length` (xor8 with the length bytes `00 14`) and the xor8 writes of the `tx-*-xor-app` vectors. The ubms simulator answers sum8 on 'gw' firmware only by assumption; its option `checksums: ['xor8']` models a unit without sum8.

### 3.5 Reassembly

- Answers arrive split over notifications whose size depends on the MTU: 20 bytes without MTU exchange ([SYC] gw-24s4eb-sw110: 2671 notifications of 20 bytes; the tail of a 300-byte frame once arrived as 16 + 4 bytes), 100 and 150 bytes with MTU 153 ([SYC] ek-24s4eb-zh211), 241 bytes ([BSC] `neeyBalancerCopyData` expects 241-byte notifications), two notifications per 300-byte frame on a Home Assistant host ([HA#454] debug log, "start" and "cnt." pieces).
- One answer may be followed directly by the next in the same byte stream (settings frame then cell info frame, vector `rx-ek-zh129-stream-settings-then-cell-info`, [SY#444]).
- Algorithm: search `55 AA 11`, read the length at offset 6, require 20 ≤ length ≤ 300 ([SY] `MIN_RESPONSE_SIZE`, `MAX_RESPONSE_SIZE`), wait for the whole frame, then check end marker and sum8; on any failure drop one byte and search again. Never end a frame at a 0xFF byte: 0xFF occurs inside data (byte 137 of vector `rx-ek-zh211-cell-info` is 0xFF inside a resistance float); [SY] used that shortcut until 2026 and dropped every frame on small MTUs ([SY#1031], fixed by [SY PR 1032], which reads the length field).
- Start a new frame at every notification that begins with `55 AA 11` even if an older frame is incomplete ([SY] "Flush buffer on every preamble", [AIO]): a lost notification otherwise corrupts the next frame. In [SYC] ek-24s4eb-zh211 a reconnect left a half frame that only this rule recovers from (979.788 s).
- Accept answer frames at any time: settings and cell info frames arrive without a matching request (section 4.2).

## 4. Session flow

### 4.1 Connect and initialise

Sequence of the vendor apps and of [SY] ([SYC] all three captures; [SY] `update()`, `decode_()`; [SY#444] comment 1944454687):

1. Connect, discover 0xFFE0, take 0xFFE1, enable notifications (CCCD 0x000B).
2. Request device info (0x01). Answer: 100-byte device info frame within about 0.06–0.08 s (GW: request 0.890 s, answer 0.948 s; EK ZH-2.0.8: 1.274 s and 1.350 s; [SYC]). [SY] waits 1 s after enabling notifications before the first request and repeats it every update interval until an answer arrives.
3. Request settings (0x04). Answer: settings frame (100 or 150 bytes), which also decides the variant (section 1.3).
4. The balancer starts streaming cell info frames by itself after the settings request: in [SYC] gw-24s4eb-sw110 the first cell frame arrives 0.08 s after the settings answer (1.111 s, 1.190 s) and before the first cell info request (1.313 s); the same in [SYC] ek-24s4eb-zh208 and in the [HA#670] log of the EK-B24S8E200A. A device info request alone did not start the stream in these captures (GW: no cell frame for 0.1 s between device info and settings request; EK ZH-2.0.8: none during 0.93 s). Observed in three captures, not documented: **unverified** as a rule.
5. [SY] then sends one cell info request (0x02); the apps send it repeatedly (about once per second in [SY#444]). Send it once if no cell frame arrived within about 1 s after the settings answer.

### 4.2 Streaming and polling

- Cell info frames arrive about every 0.5 s (mostly 0.42–0.59 s, extremes 0.06 and 0.66 s, in the [HA#670] 2026-05-11 log; 0.5 s in [SYC] gw-24s4eb-sw110; 0.55–0.85 s on the EK-16S2EB of [HA#454]) for as long as the connection stays up (964 frames in 980 s in [SYC] ek-24s4eb-zh211).
- Byte 8 counts the frames, wraps from 254 to 0 in [SYC] gw-24s4eb-sw110 (255 was skipped once, **unverified** as a rule).
- Settings frames also arrive unrequested: after every write (EK ZH-1.2.9, [SY#444]; EK-B24S8E200A, [HA#670]) and sometimes after a cell info request ([SY#444] capture).
- Poll: send nothing while frames arrive. If no cell frame arrived for about 3 s, send the cell info request again; [AIO] does exactly this check (requests cell info only when no fresh frame is there). Do not poll the settings periodically: the balancer beeps on every request it accepts ([SY#109] comments 1208399805 and 1208471674, GW-24S4EB ZH-1.2.3; [MAN] 5.3.3: a "di" sound confirms a received parameter). The beep on read requests is a single report (**unverified** for other models).
- What the cell info request does to a stopped stream is not documented: the sources show an answer and a stream that continues (5.1), never a restart. While the stream runs it brought no extra frame in [SYC] gw-24s4eb-sw110 (requests at 1.313 s, 65.921 s and 86.636 s, the next frames came at the usual 0.5 s rhythm). The settings request is the documented stream starter (4.1 step 4). **unverified** in both directions.
- As implemented: when two cell info requests in a row brought at most one cell frame each, the next silence gets one settings request instead (one beep), once per stall; a stall ends when frames flow again. Poll reports an error after 10 s without any cell frame.
- [SY] throttles publishing (`throttle` option); ubms can publish every frame or every second frame.

### 4.3 Writing a setting

1. Send the write request (function 0x00, command 0x05, register, value; section 5.2).
2. The balancer answers with a 20-byte acknowledgement (section 6.7) within about 0.03 s ([SYC] gw-24s4eb-sw110: write 2.521 s, ack 2.550 s).
3. EK firmware and the EK-B24S8E200A then send a fresh settings frame without a request ([SY#444], [HA#670]); GW SW-1.1.0 does not ([SYC]). The only timed capture: the EK-B24S8E200A pushed it 0.433 s and 0.394 s after the first acknowledgement and sent every acknowledgement twice, 0.18 to 0.21 s apart ([HA#670] Log.2026-04-07: acknowledgements 22:50:17.719 and 17.933, settings 18.152; 20.177 and 20.360, settings 20.571); one settings frame per write. No timing is captured for NEEY_V1 EK units ([SY#444] has no timestamps). Request settings (0x04) only when none arrived within about 1 s (a request costs a beep, 4.2) and compare the value: the acknowledgement does not prove that the value was applied (on GW SW-1.1.0 it does not even echo the value).
4. One write at a time. Keep at least 0.2 s between writes ([BSC] sends its write sequence step by step, one per BLE cycle; no source states a minimum).

As implemented: acknowledgement timeout 1 s (a missing acknowledgement is logged, not an error: the settings frame decides; a doubled acknowledgement is ignored), then up to 1 s for the pushed settings frame, then one settings request with 1.5 s timeout; the session compares the read-back. Without any settings frame after the write the cached frame is marked stale, so the read-back requests a new one and reports a read-back error when that fails too, never the values from before the write. The acknowledgement value is logged only, since GW SW-1.1.0 sends zeros (6.7).

### 4.4 Timing summary

| Item | Value | Source |
| --- | --- | --- |
| Answer to a request | 0.03–0.08 s | [SYC] |
| Settings frame pushed after a write | 0.39–0.43 s after the first acknowledgement (EK-B24S8E200A); 1 s wait proposed | [HA#670] |
| Cell info stream | one frame every 0.43–0.8 s | [SYC], [HA#454], [HA#670] |
| Probe timeout (device info) | 1.5 s proposed; [SY] retries every update interval (5 s default, `polling_component_schema("5s")`) | [SY] __init__.py |
| Settings re-read | [SY] example configuration presses "retrieve settings" every 30 min (one beep each time) | [SY] esp32-heltec-balancer-ble-example.yaml |
| Silence before a new cell info request | 3 s proposed | this document |

## 5. Commands

### 5.1 Read requests (function 0x01)

| Command | Request (sum8) | Answer | Notes | Sources |
| --- | --- | --- | --- | --- |
| 0x01 device info | `AA 55 11 01 01 00 14 00 00 00 00 00 00 00 00 00 00 00 26 FF` | 100-byte frame, section 6.1 | vectors `tx-device-info`, `tx-device-info-xor-app` | [SY], [AIO], [SYC], [SY#444] |
| 0x02 cell info | `AA 55 11 01 02 00 14 00 00 .. 00 27 FF` | 300-byte frame, sections 6.4, 6.5; the stream continues | the old app sends `AA 55 11 01 02 00 00 14 .. F9 FF` (vector `tx-cell-info-xor-app-swapped-length`); while the stream ran it brought no extra frame in [SYC] gw-24s4eb-sw110; that it restarts a stopped stream is not documented (**unverified**, 4.2) | [SY], [AIO], [SYC] |
| 0x03 factory defaults | `AA 55 11 01 03 00 14 00 00 .. 00 28 FF` | 20-byte echo, then two 100-byte frames, section 6.6 | only the xor8 form (`.. F8 FF`) was captured, answered by one GW-24S4EB ZH-1.2.3; the sum8 form is computed (vector `tx-factory-defaults`); never seen answered by EK firmware. The decompiled command list of [SY#109] comment 1124248872 (2022-05-11) names 0x03 "Factory reset", which conflicts with the read-only answers seen: effect on other firmware **unverified**, ubms never sends it | [SY] button 0x03, [SY#109] comments 1124248872, 1200459251, 1201370280 |
| 0x04 settings | `AA 55 11 01 04 00 14 00 00 .. 00 29 FF` | settings frame, sections 6.2, 6.3 | starts the cell info stream (section 4.1) | [SY], [SYC], [SY#444] |

### 5.2 Write command 0x05 (function 0x00)

Request: `AA 55 11 00 05 <register> 14 00 <value u32 or f32 LE> 00 00 00 00 00 00 <sum8> FF`. Answer: acknowledgement (section 6.7).

| Register | Setting | Encoding | Read back at | Evidence |
| --- | --- | --- | --- | --- |
| 0x0D | balancer switch | u32, 1 on, 0 off | V1 settings 21, V2 settings 128 | captured: app to GW SW-1.1.0 ([SYC]), app to GW ZH-1.2.3 ([SY#109] comment 1200282155), app to EK ZH-1.2.9 ([SY#444]), app to EK-B24S8E200A ([HA#670] 2026-04-07 log); [SY], [BSC]. Read back by a settings frame with the new value in three of them: [SYC] gw-24s4eb-sw110 (write "on" at 15.798 s, requested settings frame at 18.032 s), [SY#444] and [HA#670] (pushed settings frames). The only register with a captured write followed by such a frame |
| 0x02 | balance trigger voltage difference ("Startup DifVol") | f32, V | V1 settings 9 | encoding captured as xor8 requests of the old app only: GW SW-1.1.0 (0.008, 0.004, 0.002 V, [SYC] 24.5–36.8 s), GW ZH-1.2.3 (0.004 V, [SY#109] comment 1201464093); no settings frame follows these writes in either capture (the last settings frame of [SYC] gw-24s4eb-sw110 is at 18.03 s). sum8 form computed. EK firmware: used by [SY] and [BSC], named by the maintainer for ZH-2.1.1 ([SY#950] comment 4427620497) |
| 0x03 | maximum balance current | f32, A | V1 settings 13 | encoding captured as xor8 requests of the old app only: GW SW-1.1.0 (4, 2, 1 A, [SYC] 41.0–52.3 s; no settings frame after them, but the balance current of the following cell frames follows the written value: about 4, 2, 1, then 4 A), GW ZH-1.2.3 (2.5, 3.4 A); write confirmed in the app by a user ([SY#109] comment 1208388899). sum8 form computed. EK firmware: [SY], [BSC], one user report of [SY]'s write on an EK-24S20EB ([SY#1092] comment 6614294386) |
| 0x04 | sleep voltage (balancing stops below it, "StopVol") | f32, V | V1 settings 17 | encoding captured as an xor8 request of the old app only: GW ZH-1.2.3 (2.3 V, [SY#109] comment 1201464093), no read-back in the capture. sum8 form computed. EK firmware: [SY], [BSC], [SY#950] comment 4427620497 |
| 0x17 | balance start voltage ("RunVol", "equalization voltage" in [BSC]) | f32, V | V1 settings 28 | encoding captured as an xor8 request of the old app only: GW ZH-1.2.3 (2.5 V, [SY#109] comment 1201464093), no read-back in the capture. sum8 form computed. EK firmware: [SY], [BSC], [SY#950] comment 4427620497 |
| 0x16 | nominal capacity | u32, Ah (integer, not a float) | V1 settings 24 | encoding captured as xor8 requests of the old app only: GW SW-1.1.0 (300, 200, 280 Ah, [SYC] 57.0–64.1 s), GW ZH-1.2.3 (280 Ah); no settings frame after them in either capture. sum8 form computed. EK firmware: [SY], [BSC] |
| 0x01 | cell count | u32 | V1 settings 8 | app command table only ([SY#109] comment 1202062333 and [SY] number/__init__.py comments, from the decompiled app's field `single_num`), copied by [BSC] and [SY]; no capture: **unverified** |
| 0x14 | buzzer mode | u32, section 9.4 | V1 settings 22 | app table only (`alarm_mode`, values {1, 2, 3, 4} in the table, three options in [SY]): **unverified** |
| 0x15 | battery type | u32, section 9.5 | V1 settings 23 | app table only (`bat_mode`, values {1, 2, 3} in the table, four in [SY] and [BSC]): **unverified** |
| 0x1A | balance stop voltage difference ("Stop DifVol", ZH-2.1.1 and later) | f32, V | V1 settings 33 | [SY] `NUMBERS` only (2026, [SY#950] comment 4427620497); no capture: **unverified** |
| 0x13 | device name | up to 10 ASCII characters in bytes 8..17 | not readable in V1 (V2: device info 82, **unverified**) | app table only: **unverified** |

Factory and calibration registers of the same command (app table of [SY#109] comment 1202062333, "dev mode" panel of the app, all **unverified**, never write): 0x05 reference voltage, 0x06 battery voltage, 0x07 balancing current default, 0x08 start voltage (factory), 0x09 boot count, 0x0A working time (u32), 0x0B battery maximum, 0x0C battery minimum, 0x0E mean supercapacitor voltage, 0x0F reference battery voltage, 0x10 production date (8 ASCII digits in bytes 8..15), 0x11 NTC maximum, 0x12 NTC minimum.

Register 0x0D of command 0x05 is the balancer switch; register 0x0D of command 0x06 is the V2 short circuit delay (section 5.3). Never mix the two commands.

[BSC] also sends `AA 55 11 00 04 00 14 00 ..` (function 0x00 with command 0x04) at the start and end of its write sequence. No other source sends it and its effect is unknown (**unverified**); do not send it.

### 5.3 V2 write command 0x06 (EK-B24S8E200A)

Request layout as in 5.2 with command 0x06. Registers from [SY] `V2_NUMBERS` ([SY PR 952], 2026-05); no capture of any 0x06 write exists, so every entry is **unverified** and stays read-only in ubms.

| Register | Setting | Payload | V2 settings offset |
| --- | --- | --- | --- |
| 0x01 | cell overvoltage protection | f32 V | 34 |
| 0x02 | cell overvoltage recovery | f32 V | 38 |
| 0x04 | cell undervoltage protection | f32 V | 42 |
| 0x03 | cell undervoltage recovery | f32 V | 46 |
| 0x1B | cell voltage difference protection | f32 V | 50 |
| 0x1C | cell voltage difference recovery | f32 V | 54 |
| 0x1D | cell shutdown voltage | f32 V | 58 |
| 0x07 | charge overcurrent protection | f32 A | 62 |
| 0x08 | charge overcurrent delay | u32 s | 66 (u16) |
| 0x09 | charge overcurrent recovery | u32 s | 68 (u16) |
| 0x0A | discharge overcurrent protection | f32 A | 70 |
| 0x0B | discharge overcurrent delay | u32 s | 74 (u16) |
| 0x0C | discharge overcurrent recovery | u32 s | 76 (u16) |
| 0x1E | discharge overcurrent protection 2 | f32 A | 78 |
| 0x1F | discharge overcurrent 2 delay | u32 ms | 82 (u16) |
| 0x20 | discharge overcurrent 2 recovery | u32 s | 84 (u16) |
| 0x21 | short circuit protection current | f32 A | 86 |
| 0x0D | short circuit delay | u32 µs | 90 (u16) |
| 0x0E | short circuit recovery | u32 s | 92 (u16) |
| 0x0F / 0x10 | charge overtemperature protection / recovery | f32 °C | 94 / 98 |
| 0x13 / 0x14 | charge undertemperature protection / recovery | f32 °C | 102 / 106 |
| 0x11 / 0x12 | discharge overtemperature protection / recovery | f32 °C | 110 / 114 |
| 0x22 / 0x23 | discharge undertemperature protection / recovery | f32 °C | 118 / 122 |

Whether the EK-B24S8E200A accepts command 0x05 with the V1 registers 0x02, 0x03, 0x04, 0x16, 0x17 is not documented ([SY] sends them with 0x05 to both variants; no V2 capture): **unverified**.

## 6. Responses

### 6.1 Device info (command 0x01), 100 bytes

| Offset | Size | Field | Vector key | Notes and sources |
| --- | --- | --- | --- | --- |
| 8 | 16 | model, ASCII | `model` | "GW-24S4EB", "EK-24S4EB", "EK-24S10EB", "EK-B24S8E200A" ([SY] `decode_device_info_`) |
| 24 | 8 | hardware version | `hardwareVersion` | "HW-2.8.0", "HW-3.2.0", "HW-2.0.0" |
| 32 | 8 | software version | `softwareVersion` | "SW-1.1.0", "ZH-1.2.3", "ZH-2.1.1", "ZL-2.0.2", "SW-2.0.0" |
| 40 | 8 | protocol version | `protocolVersion` | "V1.0.0" .. "V1.3.36"; does not identify the variant (1.3) |
| 48 | 8 | production date, ASCII YYYYMMDD | `manufacturingDate` | |
| 56 | 4 | power-on count, u32 | `powerOnCount` | [SY PR 1124] reads all four bytes since 2026-11 |
| 60 | 4 | total runtime, u32, s | `totalRuntime` | 4064370 s on the GW SW-1.1.0 of [SYC] |
| 64 | 18 | identifier, ASCII | `identifier` | 12 hex digits of the BLE address followed by "123456" ("3CA5519C110C123456" for 3C:A5:51:9C:11:0C); on 4th generation modules the address bytes are reversed ("DF9701123638" for 38:36:12:01:97:DF), i.e. the address as the vendor app shows it; all zero on GW SW-1.1.0, ZH-1.2.3 and ZH-1.2.4 (vectors). The meaning of "123456" is unknown (**unverified**) |
| 82 | 16 | name, ASCII | `modelAlias` | "EK-24S200A" on the EK-B24S8E200A, equal to its advertised name ([HA#670]); zero in every NEEY_V1 frame (**unverified** as the user defined name) |
| 98 | 1 | checksum | | sum8 |
| 99 | 1 | 0xFF | | |

[SY] calls bytes 64..97 "reserved" in comments; the identifier and name are decoded here from the vectors.

### 6.2 Settings NEEY_V1 (command 0x04), 100 bytes

| Offset | Size | Field | Vector key | Unit | Notes and sources |
| --- | --- | --- | --- | --- | --- |
| 8 | 1 | cell count | `cellCount` | | [SY], [BSC], [HA#291] |
| 9 | 4 | balance trigger voltage difference | `balanceTriggerVoltage` | f32 V | "Startup DifVol" ([SY#950]); [BSC] calls it "start voltage" |
| 13 | 4 | maximum balance current | `maxBalanceCurrent` | f32 A | |
| 17 | 4 | sleep voltage ("StopVol", balancing stop voltage) | `balanceStopVoltage` | f32 V | [SY] `balance_sleep_voltage` |
| 21 | 1 | balancer switch | `balancerSwitch` | 0 off, 1 on | changes with register 0x0D in [SYC] and [SY#444]; [BSC] displays 0 as "EIN" (on), contradicted by the captures |
| 22 | 1 | buzzer mode | `buzzerMode` | section 9.4 | |
| 23 | 1 | battery type | `batteryType` | section 9.5 | |
| 24 | 4 | nominal capacity | `nominalCapacity` | u32 Ah | integer, unlike the other values |
| 28 | 4 | balance start voltage ("RunVol") | `balanceStartVoltage` | f32 V | 0.0 on GW SW-1.1.0, which has no such setting ([SYC]) |
| 32 | 1 | unknown | `byte32` | | 1 on ZH-2.1.1 and ZL-2.0.2, 0 on older firmware; [SY] comment "device address" (**unverified**) |
| 33 | 4 | balance stop voltage difference ("Stop DifVol") | `balanceStopDiffVoltage` | f32 V | ZH-2.1.1 and ZL-2.0.2 only (0.003 V), 0 elsewhere ([SY#950], vectors) |
| 37 | 4 | unknown float | `float37` | | 1.5 on ZH-2.1.1, 1.0 on ZL-2.0.2, 0 elsewhere; [SY] comment "line resistance reference" (**unverified**) |
| 41 | 57 | zero in every capture | | | [SY] comments "feature flags" at 41 and "reset current" at 47 (**unverified**) |
| 98 | 1 | checksum | | | |
| 99 | 1 | 0xFF | | | |

### 6.3 Settings NEEY_V2 (command 0x04), 150 bytes

Offsets from [SY] `decode_settings_v2_`, checked against the four V2 settings frames of the vectors ([SY] tests, [AIO] tests, [HA#670] logs). All limits are f32, delays u16.

| Offset | Size | Field | Vector key | Unit / example |
| --- | --- | --- | --- | --- |
| 8 | 1 | unknown, 0x02 in every frame | `byte8` | |
| 9 | 1 | cell count | `cellCount` | 16 |
| 10 | 4 | nominal capacity | `nominalCapacity` | f32 Ah, 320 (a float here, unlike V1) |
| 14 | 4 | balance trigger voltage difference | `balanceTriggerVoltage` | V, 0.003 |
| 18 | 4 | unknown float | `float18` | 0.001 in every frame ([SY] "unknown") |
| 22 | 4 | sleep voltage ([SY], **unverified**, see below) | `float22` | V, 3.25 / 3.4 |
| 26 | 4 | balance start voltage ([SY], **unverified**, see below) | `float26` | V, 3.15 / 3.38 |
| 30 | 4 | maximum balance current | `maxBalanceCurrent` | A, 8 |
| 34 / 38 | 4 + 4 | cell overvoltage protection / recovery | `cellOvp`, `cellOvpr` | V, 3.65 / 3.45 |
| 42 / 46 | 4 + 4 | cell undervoltage protection / recovery | `cellUvp`, `cellUvpr` | V, 2.6 / 2.9 |
| 50 / 54 | 4 + 4 | cell voltage difference protection / recovery | `cellDiffProtection`, `cellDiffRecovery` | V, 1.0 / 0.7 |
| 58 | 4 | cell shutdown voltage | `cellShutdownVoltage` | V, 2.0 |
| 62, 66, 68 | 4, 2, 2 | charge overcurrent protection, delay, recovery | `chargeOcp`, `chargeOcpDelay`, `chargeOcpRecovery` | A, s, s: 100 A, 5 s, 300 s |
| 70, 74, 76 | 4, 2, 2 | discharge overcurrent protection, delay, recovery | `dischargeOcp`, `dischargeOcpDelay`, `dischargeOcpRecovery` | 200 A, 5 s, 120 s |
| 78, 82, 84 | 4, 2, 2 | discharge overcurrent 2 protection, delay, recovery | `dischargeOcp2`, `dischargeOcp2Delay`, `dischargeOcp2Recovery` | 400 A, 1000 ms, 120 s |
| 86, 90, 92 | 4, 2, 2 | short circuit current, delay, recovery | `scpCurrent`, `scpDelay`, `scpRecovery` | 800 A, 500 µs, 0 s |
| 94 / 98 | 4 + 4 | charge overtemperature protection / recovery | `chargeOtp`, `chargeOtpr` | °C, 60 / 50 |
| 102 / 106 | 4 + 4 | charge undertemperature protection / recovery | `chargeUtp`, `chargeUtpr` | °C, -2 / 2 |
| 110 / 114 | 4 + 4 | discharge overtemperature protection / recovery | `dischargeOtp`, `dischargeOtpr` | °C, 60 / 50 |
| 118 / 122 | 4 + 4 | discharge undertemperature protection / recovery | `dischargeUtp`, `dischargeUtpr` | °C, -10 / -5 |
| 126 | 1 | unknown, 1 in every frame | `byte126` | [SY] decodes it as the balancer switch: contradicted, see 128 |
| 127 | 1 | unknown, 1 in every frame | `byte127` | [SY] decodes it as the buzzer mode (**unverified**) |
| 128 | 1 | balancer switch | `balancerSwitch` | 0 / 1: the only byte that changed after the acknowledged writes 0x0D = 0 and 0x0D = 1 ([HA#670] 2026-04-07 log, vectors `rx-v2-settings-balancer-off`, `rx-v2-settings-balancer-on`). [SY] decodes 128 as the battery type (conflict, **unverified** there) |
| 129 | 1 | unknown, 1 in every frame | `byte129` | |
| 130 | 18 | zero | | |
| 148 / 149 | 1 / 1 | checksum, 0xFF | | |

The units of the V2 delays follow [SY] `V2_NUMBERS` (s, ms, µs); the example values are plausible for these units but no app screenshot was matched (**unverified**). The location of the battery type and buzzer mode in V2 is unknown.

Offsets 22 and 26: in every V2 frame the value at 22 is above the value at 26 (3.25 / 3.15 V in [HA#670] 2026-04-07 and vectors `rx-v2-settings-balancer-on` / `-off`; 3.40 / 3.38 V in `rx-v2-settings` and [HA#670] 2026-05-11). Under the [SY] labels that means sleep voltage above start voltage, the opposite of every V1 frame (start above sleep in all of them, 7.2). The labels may be swapped (**unverified**); ubms shows the two values under driver specific ids with the offset in the label (`neey.v2_voltage_22`, `neey.v2_voltage_26`), not under `cell.sleep_voltage` and `balance.start_voltage`.

### 6.4 Cell info NEEY_V1 (command 0x02), 300 bytes

| Offset | Size | Field | Vector key | Unit | Notes and sources |
| --- | --- | --- | --- | --- | --- |
| 8 | 1 | frame counter | `frameCounter` | | +1 per frame (section 4.2) |
| 9 + 4i | 4 | cell voltage i, i = 0..23 | `cellVoltages` | f32 V | 0.0 for slots without a cell; the vectors list only the non-zero slots |
| 105 + 4i | 4 | lead resistance of cell i | `cellResistances` | f32 Ω | 0.07–0.20 Ω in the vectors; the ubms model wants mΩ (× 1000). "Wire resistance" in [MAN] 5.3.2: a rough value to find wiring faults |
| 201 | 4 | total voltage | `totalVoltage` | f32 V | sum of the cells ([MAN] 5.3.2) |
| 205 | 4 | average cell voltage | `cellVoltageAverage` | f32 V | agrees with the cells in the vectors (`cellVoltageAverageDerived`) |
| 209 | 4 | cell voltage difference | `cellVoltageDelta` | f32 V | agrees with the cells (`cellVoltageDeltaDerived`) |
| 213 | 1 | index of the highest cell, 0-based | `cellVoltageMaxIndex` | | on ties the last cell with that voltage (`rx-gw-zh123-cell-info-max-index-tie`, `rx-ek-zh129-cell-info-balancing`); [SY] computes min / max from the cells instead |
| 214 | 1 | index of the lowest cell, 0-based | `cellVoltageMinIndex` | | |
| 215 | 1 | unknown, 0x0F in every frame | `byte215` | | also with 15 or 16 cells, so not a cell count ([HA#454] vector `rx-ek16s2eb-cell-info-15-cells`); [SY] "single number, not exposed at the android app" |
| 216 | 1 | operation status | `operationStatus` | | section 9.1; 0x05 = balancing |
| 217 | 4 | balance current | `balanceCurrent` | f32 A | signed: negative while the highest cell is discharged into the supercapacitor, positive while the lowest cell is charged ([MAN] 5.3.2 b; [BM]); the sign alternates between frames during balancing ([SY#109] comment 1200445939); 0 when not balancing |
| 221 | 4 | temperature 1 | `temperature1` | f32 °C | balancer board ([SY] "Temperature 1"); equal to temperature 2 in most frames |
| 225 | 4 | temperature 2 | `temperature2` | f32 °C | |
| 229 | 3 | cell detection failed, bit i = cell i + 1 | `cellDetectionFailedMask` | u24 | bits above the cell count are set on several units (0xFF0000 with 16 cells): mask with the configured cell count (section 9.2) |
| 232 | 3 | cell overvoltage | `cellOvervoltageMask` | u24 | |
| 235 | 3 | cell undervoltage | `cellUndervoltageMask` | u24 | |
| 238 | 3 | cell polarity error | `cellPolarityErrorMask` | u24 | |
| 241 | 3 | excessive lead resistance | `cellWireResistanceMask` | u24 | |
| 244 | 1 | system overheating | `temperatureWarningMask` | | bit 0 sensor 1, bit 1 sensor 2 ([SY], [BSC]) |
| 245 | 1 | charging fault | `chargingFault` | 0 / 1 | meaning for a balancer unclear (**unverified**) |
| 246 | 1 | discharging fault | `dischargingFault` | 0 / 1 | **unverified** |
| 247 | 1 | unknown | `byte247` | | [SY] comment: bit 0 read failed, bit 1 write failed (**unverified**) |
| 248 | 6 | zero | | | |
| 254 | 4 | time since power-on | `uptime` | u32 s | +1 per second ([SYC]) |
| 258 | 40 | zero | | | |
| 298 / 299 | 1 / 1 | checksum, 0xFF | | | |

Sources: [SY] `decode_cell_info_` (offset table), `decode_cell_arrays_`; [BSC] `OFFSET_NEEYBAL4A_DATA0x2_*`; [AIO] `_FIELDS_v1`; all V1 cell vectors. In vector `rx-ek-zh211-cell-info` the detection mask is 0xFE0000 with 16 cells: bit 16 (cell 17) is clear while bits 17..23 are set; the reason is unknown (**unverified**).

### 6.5 Cell info NEEY_V2 (command 0x02), 300 bytes

Offsets 8..216 as in 6.4. Then ([SY] `decode_cell_info_v2_`, [AIO] `_FIELDS`, vectors):

| Offset | Size | Field | Vector key | Unit | Notes |
| --- | --- | --- | --- | --- | --- |
| 217 | 1 | unknown, 0x02 in every frame | `byte217` | | |
| 218 | 4 | balance current | `balanceCurrent` | f32 A | sign as in V1 |
| 222 | 4 | pack current | `current` | f32 A | positive while charging: remaining capacity rises with +18 A ([HA#670] log, vector `rx-v2-cell-info-charging`); [SY] does not decode it, [AIO] does |
| 226 | 4 | temperature 1 (NTC 1 and 2) | `temperature1` | f32 °C | labels from [SY] |
| 230 | 4 | temperature 2 (NTC 3 and 4) | `temperature2` | f32 °C | |
| 234 | 4 | MOSFET temperature | `temperatureMos` | f32 °C | |
| 238 | 4 | balancer temperature | `temperatureBalancer` | f32 °C | 61.9 °C while balancing at 8 A |
| 242 | 4 | capacity | `nominalCapacity` | f32 Ah | 320 = settings capacity |
| 246 | 4 | remaining capacity | `capacityRemaining` | f32 Ah | |
| 250 | 4 | state of charge | `soc` | f32 % | 100.0 when remaining = capacity (`rx-v2-cell-info-full`) |
| 254 | 4 | unknown float, equal to the capacity in every frame | `float254` | | **unverified**, perhaps full charge capacity |
| 258 | 4 | unknown float, 0 | `float258` | | |
| 262 | 4 | unknown float, about 5.36 | `float262` | | |
| 266 .. 283 | | bitmasks and fault bytes of V1 offsets 229..246, shifted by 37 | as in 6.4 | | |
| 284 | 1 | unknown | `byte284` | | |
| 285 | 6 | zero | | | |
| 291 | 4 | time since power-on | `uptime` | u32 s | |
| 295 | 3 | zero | | | |
| 298 / 299 | 1 / 1 | checksum, 0xFF | | | |

### 6.6 Factory defaults (command 0x03)

The request is answered by a 20-byte frame `55 AA 11 01 03 00 14 00 00 .. 00 28 FF` and then two 100-byte frames ([SY#109] comment 1200459251, [SY] `decode_factory_defaults_` "A factory settings request returns 3 responses?"). These answers were seen from one unit only, a GW-24S4EB ZH-1.2.3 that received the xor8 form of the old app ([SY#109] comments 1200459251 and 1201370280); the settings frame requested right after it in 1200459251 holds user values (16 cells, 280 Ah), but that log has no frame from before the request to compare with. No EK firmware (ZH-1.2.9 and later, ZL, SW-2.0.0) was seen answering 0x03. The decompiled command list in [SY#109] comment 1124248872 names command 0x03 "Factory reset", while listing the fields of this frame under it. Whether 0x03 resets anything on other firmware is unknown (**unverified**); ubms never sends it (8).

Payload of the 100-byte frame (names from the app's developer panel, meanings **unverified**; [SY], [SY PR 1124] corrected offset 12 and the production date label):

| Offset | Field | Vector key | Example (GW-24S4EB ZH-1.2.3) |
| --- | --- | --- | --- |
| 8, 12 | standard voltage 1, 2 (f32 V) | `standardVoltage1`, `standardVoltage2` | 1.4986, 1.4984 |
| 16, 20 | battery voltage 1, 2 (f32 V) | `batteryVoltage1`, `batteryVoltage2` | 3.3205, 3.8 |
| 24, 28 | standard current 1, 2 (f32 A) | `standardCurrent1`, `standardCurrent2` | 1.7168, 1.7178 |
| 32, 36 | SuperBat 1, 2 (f32) | `superBat1`, `superBat2` | 1.8815, 0 |
| 40 | resistor 1 (f32) | `resistor1` | 1 |
| 44 | battery status (f32) | `batteryStatus` | 1.65 |
| 48, 52 | maximum, minimum voltage (f32 V) | `maxVoltage`, `minVoltage` | 1.645, 1.46 |
| 56, 60 | maximum, minimum temperature (f32 °C) | `maxTemperature`, `minTemperature` | 85, 65 |
| 64 | power-on count (u32) | `powerOnCount` | 8 |
| 68 | total runtime (u32 s) | `totalRuntime` | 778742 |
| 72 | production date (8 ASCII) | `productionDate` | "20220531" |

The two frames differ only in the live-looking values at 8, 16, 24 and 32. ubms does not need this frame: the parser and the encoder exist for the vectors and the simulator, the driver does not request it.

### 6.7 Write acknowledgement (command 0x05), 20 bytes

`55 AA 11 00 05 <register> 14 00 <value> 00 .. 00 <sum8> FF`: function 0x00, command 0x05, the written register at byte 5 and the length 20.

| Firmware | Value bytes 8..11 | Sources |
| --- | --- | --- |
| GW-24S4EB SW-1.1.0 | always zero (`rx-gw-sw110-ack-*`) | [SYC] |
| EK-24S4EB ZH-1.2.9 | the written value (an echo of request bytes 3..17 with the 55 AA header) | [SY#444] |
| EK-B24S8E200A | the written value | [HA#670] |

[SY] logs the acknowledgement and does nothing else. ubms: match the register, then confirm through the settings frame (section 4.3).

## 7. Settings

### 7.1 What can be written

Writable in ubms. Evidence differs per register (5.2): only the balancer switch 0x0D has a captured write followed by a settings frame with the new value. For 0x02, 0x03, 0x04, 0x16 and 0x17 the encoding is captured from the old NEEY app on GW SW-1.1.0 and ZH-1.2.3 (xor8 requests) without a settings frame after the writes in the capture (for 0x03 the balance current of the following cell frames follows the written value); the sum8 form ubms sends is computed, and on EK firmware these registers rest on their use by [SY] and [BSC], the maintainer's note for ZH-2.1.1 ([SY#950] comment 4427620497) and, for 0x03, one user report on an EK-24S20EB ([SY#1092] comment 6614294386). ubms therefore reads every write back (4.3) and reports a mismatch or a failed read-back.

| Setting | Register | Encoding | Variants | Range |
| --- | --- | --- | --- | --- |
| Balancer switch | 0x0D | u32 0 / 1 | V1, V2 | |
| Balance trigger voltage difference | 0x02 | f32 V | V1 | 0.001–1.0 V (app table); [MAN]: 0.005 V above 50 Ah, 0.01 V below |
| Maximum balance current | 0x03 | f32 A | V1 | 1.0 A to the model rating (4 A for "24S4EB", 2 A for "16S2EB", 10, 15, 20 A, section 7.3); [MAN] says 0.3–4 A, the app table 1.0–4.0 A; [MAN]: should not exceed 0.1 C |
| Sleep voltage | 0x04 | f32 V | V1 | 1.0–4.5 V (app table); [DS]: 1.5–4.2 V |
| Balance start voltage | 0x17 | f32 V | V1 except GW SW-1.1.0 (reads 0, no such setting) | 1.0–4.5 V (app table) |
| Nominal capacity | 0x16 | u32 Ah | V1 | 1–2000 Ah (app table) |

Read-only (encoding not confirmed by a capture, section 5.2, 5.3): cell count, buzzer mode, battery type, balance stop voltage difference (ZH-2.1.1, ZL-2.0.2), all V2 settings except the balancer switch.

### 7.2 Recommended ubms schema

| Field id | Source | Write | Notes |
| --- | --- | --- | --- |
| `switch.balance` | V1 settings 21, V2 settings 128 | 0x05 / 0x0D | same id as the JK balancer driver |
| `balance.trigger_delta` | V1 9 (V2 14 read-only) | 0x05 / 0x02 (V1) | decimals 3 |
| `balance.max_current` | V1 13 (V2 30 read-only) | 0x05 / 0x03 (V1) | max from the model (7.3), decimals 1 |
| `cell.sleep_voltage` | V1 17 | 0x05 / 0x04 (V1) | override group `balancing`; description: balancing stops while cells are below it |
| `balance.start_voltage` | V1 28 | 0x05 / 0x17 (V1) | left out when the value is 0 and the software is SW-1.1.0; warning when it is not above the sleep voltage |
| `neey.v2_voltage_22`, `neey.v2_voltage_26` | V2 22, V2 26 | none | read-only; labels name the offset and the [SY] meaning, which may be swapped (6.3, **unverified**) |
| `capacity.nominal` | V1 24 (u32), V2 10 (f32, read-only) | 0x05 / 0x16 (V1) | decimals 0 |
| `system.cell_count` | V1 8, V2 9 | none (**unverified** register 0x01) | `readOnly` with a note that the vendor app changes it; the alarm `cell_count_mismatch` (9.1) tells the user |
| `neey.stop_delta` | V1 33 | none (**unverified** 0x1A) | label "Balance stop voltage difference", group `balancing`; show only when byte 32 or the value is non-zero |
| `neey.buzzer_mode` | V1 22 | none (**unverified** 0x14) | enum, section 9.4 |
| `system.battery_type` | V1 23 | none (**unverified** 0x15) | enum, section 9.5 |
| V2 protection limits: `cell.ovp`, `cell.ovpr`, `cell.uvp`, `cell.uvpr`, `cell.diff_protection`, `neey.cell_diff_recovery`, `cell.power_off_voltage` (shutdown), `charge.ocp`, `charge.ocp_delay`, `charge.ocp_recovery`, `discharge.ocp`, `discharge.ocp_delay`, `discharge.ocp_recovery`, `discharge.ocp2`, `discharge.ocp2_delay`, `neey.discharge_ocp2_recovery`, `scp.current`, `scp.delay`, `scp.recovery`, `charge.otp`, `charge.otpr`, `charge.utp`, `charge.utpr`, `discharge.otp`, `discharge.otpr`, `discharge.utp`, `discharge.utpr` | V2 settings 34..122 | none (command 0x06 **unverified**) | read-only |

Mark `switch.balance` with `danger` (switching the balancer off stops balancing until someone switches it on again). Use `warn` for values outside the vendor recommendations: trigger difference below 0.005 V on packs above 50 Ah or below 0.01 V on smaller packs, maximum balance current above 0.1 C of the nominal capacity ([MAN] 5.3.3). Read back every write as in section 4.3; an unchanged value after 2 s is a failed write.

Cross-field hints, as warnings only because no source states a firmware limit:

- `balance.trigger_delta` at or below `neey.stop_delta`: the trigger is the difference where balancing starts and the stop difference the one where it ends ([SY#950] comment 4427620497: "Startup DifVol" 0.005 V, "Stop DifVol" 0.003 V), so balancing could never settle. Both captured frames with a stop difference have trigger above it (0.005 / 0.003 V `rx-ek-zh211-settings`, 0.02 / 0.003 V `rx-ek24s10eb-settings`).
- `balance.start_voltage` not above `cell.sleep_voltage`: every captured V1 frame with a start voltage has it above the sleep voltage (2.6 / 2.5 V `rx-gw-zh123-settings-*` and `rx-ek-zh129-settings-*`, 3.37 / 3.35 V `rx-gw-zh124-settings`, 3.65 / 3.4 V `rx-ek-zh208-settings`, 3.45 / 3.4 V `rx-ek-zh211-settings`, 3.42 / 3.35 V `rx-ek24s10eb-settings`).

As implemented (`settings.js`):

- NEEY_V1: 6 writable fields (`switch.balance`, `balance.trigger_delta` 0.001–1 V, `balance.max_current` 1 A to the rating, `cell.sleep_voltage` 1–4.5 V, `balance.start_voltage` 1–4.5 V, `capacity.nominal` 1–2000 Ah), 4 read-only fields (`system.cell_count`, `neey.stop_delta`, `neey.buzzer_mode`, `system.battery_type` with the catalog label "Battery chemistry"). `balance.start_voltage` is left out when the software is SW-1.1.0 and the value reads 0; `neey.stop_delta` appears only when byte 32 or the value is non-zero. The upper limit of `balance.max_current` is the rating of 7.3, raised to the value the balancer already holds when that is higher (EK-16S2EB, 7.3). Warnings: the vendor recommendations above on `balance.trigger_delta` and `balance.max_current`, the two cross-field hints on `balance.trigger_delta` and `balance.start_voltage`.
- NEEY_V2: `switch.balance` writable; 33 read-only fields (the six balancer values of 6.3, with offsets 22 and 26 as `neey.v2_voltage_22` and `neey.v2_voltage_26`, and the 27 limits of the table above). The register of the unverified 0x06 command is kept in the field `meta` as documentation and never sent. `system.cell_count` gives the same reason as on V1 (register 0x01 from the app table only).
- No actions (8).
- Every read-only field says in its description why it is not written.

### 7.3 Ratings per model

| Model | Maximum balance current | Evidence |
| --- | --- | --- |
| GW-24S4EB, EK-24S4EB | 4 A | [MAN], app table range 1.0–4.0 A ([SY] comments) |
| EK-16S2EB | 2 A (from the name) | **unverified**; balance currents of 2.5 A were reported by this unit ([HA#454] vector `rx-ek16s2eb-cell-info-15-cells`, -2.499 A), so the rating in the name is not a hard limit of the reported current |
| EK-24S10EB | 10 A | 8 A set in [SY#1027] |
| EK-24S15EB | 15 A | [SY PR 571] |
| EK-24S20EB | 20 A | [SY#1092], [SY PR 1093] |
| EK-B24S8E200A | 8 A (settings 30 = 8) | [SY] tests |

Rule: parse `(\d+)S(\d+)E` from the model of the device info frame and use the second number as the maximum; fall back to 4 A when the model does not match.

## 8. Controls and actions

| Action | Frame | Notes |
| --- | --- | --- |
| Balancer on / off | write 0x05 / 0x0D, u32 1 / 0 | the `switch.balance` setting; verified on every variant |
| Read settings again | request 0x04 | the balancer beeps (4.2); offer it as a manual refresh only |
| Read factory data | request 0x03 | not offered: answered by one GW ZH-1.2.3 only, never seen on EK firmware, and one source names the command "Factory reset" (5.1, 6.6, **unverified** effect); ubms does not need the frame |

No restart, calibration or password action is documented, and no confirmed factory reset. The voltage calibration of the app ([MAN] 5.3.3 d) is not captured (it is probably one of the factory registers of 5.2): not offered. The ubms driver offers no actions.

## 9. Bits and enumerations

### 9.1 Operation status (cell info byte 216)

Names from [SY] `OPERATION_STATUS` and [BSC]; [AIO] maps some codes to problems. Proposed ubms mapping (`balancingActive` = status 0x05):

| Value | [SY] text | ubms | Alarm (catalog id, severity) |
| --- | --- | --- | --- |
| 0x00 | unknown | | |
| 0x01 | wrong cell count | | `cell_count_mismatch` (fault); [MAN] 6 "Cell count is not equal to settings" |
| 0x02 | acquisition line resistance test | state "testing" | |
| 0x03 | acquisition line resistance too high | | `wire_resistance` (warning); [MAN] 6 "wire resistance is too large" |
| 0x04 | system test completed | idle | |
| 0x05 | balancing | balancing | |
| 0x06 | balancing finished | idle | |
| 0x07 | low voltage | | `neey.low_voltage` (warning), label "Low voltage" as in [SY]: the sources do not tell whether the pack or the supply voltage is meant (**unverified**: [DS] needs a pack voltage above 30 V or an external supply; [AIO] maps 0x07 to `PACK_UNDERVOLTAGE`) |
| 0x08 | system overtemperature | | `neey.system_overtemperature` (protection) |
| 0x09 | host fails | | `communication_fault` (fault) |
| 0x0A | low battery voltage, balancing stopped | idle (cells below the sleep voltage) | none, [AIO] reports it as info; seen in many idle frames |
| 0x0B | temperature too high, balancing stopped | | `neey.system_overtemperature` (warning) |
| 0x0C | self-test completed | idle | |
| other | | unknown, the state shows the raw code, for example "0x0D" | |

### 9.2 Cell bitmasks (V1 229..243, V2 266..280)

Five u24 masks, bit i = cell i + 1 ([SY], [BSC]). Mask the detection-failed bits with `(1 << cellCount) - 1` using the settings cell count before raising alarms: unused slots read as "detection failed" (0xFF0000 with 16 cells, vectors `rx-gw-zh123-cell-info-2024`, `rx-ek-zh132-cell-info`, `rx-ek-zh208-cell-info`). ubms limits the other four masks to the displayed cells (the configured count or the last non-zero slot, whichever is higher, 1.4), so a cell wired beyond the configured count keeps its alarms.

| Mask | Alarm |
| --- | --- |
| detection failed | `cell_wire_open` (fault), source "cells n, m" |
| overvoltage | `cell_overvoltage`: warning on NEEY_V1 (a balancer without MOSFETs cannot disconnect anything); catalog severity (protection) on NEEY_V2 |
| undervoltage | `cell_undervoltage`: as overvoltage |
| polarity error | `neey.cell_polarity` (fault), label "Cell connected with reversed polarity" |
| excessive lead resistance | `wire_resistance` (warning) |

The EK-B24S8E200A (NEEY_V2) is a 200 A BMS with protection settings ([HA#670]: "Its a full bms", 1.1, 6.3), so its voltage bits may be real protection states. No source shows a V2 frame with these bits set: the meaning on V2 is **unverified** in both directions, and ubms uses the higher severity there so that a protection is not under-reported.

### 9.3 Fault bytes (V1 244..247, V2 281..284)

| Byte | Alarm |
| --- | --- |
| system overheating, bit 0 sensor 1, bit 1 sensor 2 | `neey.system_overtemperature` (warning) |
| charging fault (non-zero) | `neey.charge_fault`: warning on NEEY_V1, protection on NEEY_V2 (**unverified** meaning on both, see 9.2) |
| discharging fault (non-zero) | `neey.discharge_fault`: as the charging fault |
| byte 247 / 284 | not mapped (**unverified** bits read failed, write failed) |

None of these bytes was non-zero in any vector.

Labels of the driver specific alarms in ubms: `neey.system_overtemperature` "Balancer overtemperature", `neey.low_voltage` "Low voltage", `neey.cell_polarity` "Cell connected with reversed polarity", `neey.charge_fault` "Charging fault", `neey.discharge_fault` "Discharging fault". The balancer state shown with the live data is the status text of 9.1 (the raw code such as "0x0D" for a status without a text), or "Off" while the balancer switch of the settings frame is off (the status then reads 0x04).

### 9.4 Buzzer mode (V1 settings 22)

1 off, 2 beep once, 3 beep regular ([SY] `BUZZER_MODES`); 0 unknown. The app table lists the values {1, 2, 3, 4} (**unverified** meaning of 4). Values seen: 1 (most units), 2 (EK-24S10EB).

### 9.5 Battery type (V1 settings 23)

1 NCM, 2 LFP, 3 LTO, 4 PbAc ([SY] `BATTERY_TYPES`, [BSC]); the app table lists {1, 2, 3} (**unverified** for 4). Value seen: 2 in every V1 frame. The V2 location is unknown (6.3).

## 10. Device information

| `DeviceInfo` field | Source |
| --- | --- |
| `vendor` | "NEEY" |
| `model` | device info 8 |
| `hardwareVersion` | device info 24 |
| `softwareVersion` | device info 32 |
| `manufactureDate` | device info 48, shown as YYYY-MM-DD |
| `serialNumber` | device info 64 when non-zero (identifier) |
| `name` | device info 82 when non-zero (V2), otherwise the advertised name |
| `powerOnCount` | device info 56 |
| `extra.totalRuntime` | device info 60 (s); [SY] formats it as days and hours |
| `uptime` | cell info 254 (V1) / 291 (V2) |
| `protocol` | the variant id plus the protocol version string of device info 40 in parentheses, for example "NEEY_V1 (V1.0.0)" |

## 11. Detection

### 11.1 BLE scan

- Default names: "GW-24S4EB", "EK-24S4EB", "EK-16S2EB", "EK-24S10EB", "EK-24S15EB", "EK-24S20EB", "EK-24S200A" ([SY], [AIO] `matcher_dict_list` patterns `EK-*` and `GW-*` with service FEE7, [HA#454], [HA#670]); the manual's example name is "24S4EB" ([MAN] 5.3.1). Users rename units ("neey", "GW-2BMS", "Backup BMS", "GW-24Srenamed1"; [SY#444], [HA#454], [HA#291], [AIO] test data), and some advertisements carry no name at all ([SY#384], [SY#640]).
- Chooser filters for `neey-ble`: `namePrefixes` ["GW-", "EK-"], `advertisedServices` [0xFFE0] (as `jk-balancer-ble` does, so renamed units are listed), `optionalServices` none beyond the profile.
- Ranking pattern: `/^(GW|EK)-(B?\d{1,2}S\d{1,3}E|\d{1,2}S\d{1,3}A)/i` (matches every default name above, not "GW-24Srenamed1"). A plain prefix `/^(GW|EK)-/i` is also acceptable; no other ubms family uses these prefixes.
- FEE7, the `88 A0` manufacturer payload and the varying company ids do not identify NEEY (2.1).

### 11.2 Probe

The probe writes only the device info request (a read, in its sum8 and xor8 forms); nothing that changes the balancer.

1. Connect, enable notifications on 0xFFE1.
2. Listen for 0.3 s first: if a valid cell info frame arrives (55 AA 11 01 02 00 2C 01, 300 bytes, sum8, end marker), the balancer is still streaming from an earlier session; accept it as evidence and continue with step 3 anyway for the model.
3. Write the device info request `AA 55 11 01 01 00 14 00 00 00 00 00 00 00 00 00 00 00 26 FF` (without response).
4. Accept, high confidence, when within 1.5 s a frame arrives with: bytes 0..7 = `55 AA 11 01 01 00 64 00`, length 100, byte 99 = 0xFF, byte 98 = sum8 of bytes 0..97, model (8..23) printable ASCII and non-empty, hardware version (24..31) printable, and either the hardware version starting with "HW-" or the model starting with "GW-" or "EK-". "HW-" is an observed pattern only: every captured device info frame has it (GW-24S4EB, EK-24S4EB, EK-24S10EB, EK-B24S8E200A), but no frame of the EK-16S2EB or the EK-24S15EB is known (**unverified** for them), so a known model name is enough. Read model, versions and identifier (section 6.1).
5. If nothing arrives, send the request once more (the first request after connecting may be lost while the link parameters change, [SY] waits 1 s after enabling notifications) and wait another 1.5 s.
6. If still nothing arrives, send the xor8 form of the old app once (`AA 55 11 01 01 00 14 00 .. FA FF`, vector `tx-device-info-xor-app`, a read) and wait up to 1 s: the only form seen reaching a GW SW-1.1.0 (3.4). When it is answered, use the xor8 forms for every later request. Then give up and let the next driver probe.
7. The variant is decided later by the settings frame (11.5); `probe()` returns `variant: 'NEEY_V1'` as a provisional value only when it saw nothing else, or `NEEY_V2` when the model starts with "EK-B".

Cost on a NEEY unit: the request may make the balancer beep once (4.2), as it does when the vendor app connects.

As implemented (`driver.js`): each sum8 device info attempt waits 0.6 times the session probe timeout, at least 0.5 s and at most 1.5 s (1.5 s with the default 2.5 s timeout), and the xor8 attempt the same but at most 1 s, so a device that does not answer costs 0.3 s plus three attempts (4.3 s with the default timeout). The settings request of 11.5 follows inside `probe()`; without its answer the probe still accepts the unit with confidence 0.9 and a provisional variant from the model (step 7), decodes cell frames up to offset 216 only, retries the settings request at most twice more from `poll()` (10 s apart) and refuses writes until a settings frame arrives. With it the confidence is 1.

### 11.3 Foreign requests on FFE1

JK BMS, JK balancers, ANT BMS and Atorch meters share the FFE0 / FFE1 profile, so a NEEY unit may receive the JK probe `AA 55 90 EB 97 ..` (20 bytes, vector `foreign-jk-request-device-info`), the ANT probe `7E A1 01 00 00 BE 18 55 AA 55` (`foreign-ant-request-status`) or the ANT legacy probe `DB DB 00 00 00 00` (`foreign-ant-legacy-request-status`) when those drivers probe first.

- No source tested what a NEEY unit does with them: **unverified**.
- Evidence that they are ignored: EK firmware drops requests that fail its length or checksum check without any answer (3.4); the JK request has 0x90 at byte 2 (not 0x11), its checksum at byte 19 (no 0xFF end marker) and byte 18 = 0x00, so it fails the NEEY checks in every position; the ANT frames do not start with `AA 55` and are not 20 bytes long. A write needs function 0x00 at byte 3 and command 0x05 at byte 4; the JK frame carries 0xEB and 0x97 there, so even a firmware that skipped the checks could not take it for a write.
- GW firmware answers requests with either checksum (3.4), so it may skip the checksum check; the address byte and end marker still differ.
- The ubms simulator drops these frames (its request assembler synchronises on `AA 55 11` only); the tests use that to show that a NEEY unit probed after the JK drivers on the same link is still detected and receives no write. This is a simulator assumption, not hardware evidence.

The opposite direction: the NEEY request `AA 55 11 01 01 ..` has the `AA 55` start of a JK request but 0x11 0x01 instead of 0x90 0xEB; JK firmware is expected to ignore it ([jk.md](jk.md) 11.2 checks the full header, **unverified** on hardware). ANT and Atorch devices parse only their own start bytes ([ant.md](ant.md), [atorch.md](atorch.md) 11.2, **unverified** on hardware).

### 11.4 Rejecting foreign devices

Answers of the other families fail the NEEY envelope (vectors `foreign-*`):

| Family | First bytes | Rejected by |
| --- | --- | --- |
| JK BMS, JK04 balancer | `55 AA EB 90 03 ..` (300 bytes) | byte 2 = 0xEB, not 0x11; the length field at 6..7 holds model text |
| ANT BMS (new) | `7E A1 11 ..` | no `55 AA` start |
| ANT BMS (legacy) | `AA 55 AA FF ..` frames of 140 bytes ([ant.md](ant.md)) | `AA 55` is the NEEY request start, not an answer start; the parser only looks for `55 AA 11` |
| Atorch meters | `FF 55 01 ..` reports pushed every second | no `55 AA 11` start |

A NEEY parser that sees only foreign bytes for 1.5 s returns null. It never needs a name to reject a device.

### 11.5 Variant

Request settings (0x04) right after a successful probe and set `NEEY_V2` for a 150-byte answer, `NEEY_V1` for a 100-byte answer (1.3). Until then decode only the shared part of cell frames.

### 11.6 Registration order

Current Bluetooth order: `jk-balancer-ble`, `jk-ble`, `ant`, `ant-legacy`, `daly-modbus`, `daly`, `atorch`; candidates are ranked by name first, so the order only matters among equal ranks (a NEEY with a default name ranks `neey-ble` first anyway).

Recommendation: register `neey-ble` after `jk-ble` and before `ant`, i.e. `drivers = [...jkDrivers, ...neeyDrivers, ...antDrivers, ...dalyDrivers, ...atorchDrivers]`, giving `jk-balancer-ble`, `jk-ble`, `neey-ble`, `ant`, `ant-legacy`, `daly-modbus`, `daly`, `atorch`. Reasons:

- Renamed or unnamed FFE0 devices are probed in registration order. JK BMS names are user defined and JK devices are the most common FFE0 devices, so the two JK probes stay first; a renamed NEEY then waits for the two JK probe timeouts, which is cheaper than delaying every renamed JK device by the NEEY timeout.
- NEEY units are often renamed (11.1) while ANT names keep their "ANT-BLE" form ([ant.md](ant.md)), which ranks the ANT drivers first for ANT devices; placing NEEY before ANT therefore costs ANT devices nothing in practice and saves renamed NEEY units two ANT probes.
- Daly drivers use other GATT services and do not compete on FFE0. Atorch stays last as its index.js explains (passive listener, default demo stays `jk-ble`).
- All foreign probes a NEEY unit can receive are read requests or unparseable for it (11.3), and the NEEY probe is a read request, so the order has no safety impact, only a delay impact.

## 12. Pitfalls and quirks

1. Two checksum algorithms in requests: the old app sends xor8, current apps sum8. EK firmware ignores xor8 requests; send sum8 first. GW SW-1.1.0 was only ever seen with xor8 requests, so fall back to the xor8 form when sum8 gets no answer (3.3, 3.4, 11.2).
2. The old app sends the cell info request with the length bytes swapped (`00 14`); EK firmware ignores that form (3.4).
3. A request with a wrong layout gets no answer at all, never a NAK (3.4). A missing answer means "wrong frame" as often as "lost packet".
4. Request start `AA 55`, answer start `55 AA`. A parser that looks for `AA 55` in answers finds nothing; the ANT legacy answer starts with `AA 55` too (11.4).
5. 0xFF occurs inside data: never end a frame at a 0xFF byte, use the length field (3.5, [SY#1031]).
6. The balancer streams cell info after the settings request and pushes settings frames after writes (about 0.4 s after the acknowledgement, which the EK-B24S8E200A sends twice); an assembler must accept answers at any time (4.1, 4.2, 4.3). A restart of a stopped stream by the cell info request is not documented (4.2).
7. The balancer beeps on requests it accepts; do not poll settings ([SY#109]).
8. Variant V2 changes the cell info layout after offset 216 and the settings layout entirely; a V1 decoder applied to V2 reads the pack current as a temperature ([HA#670]). Decide the variant from the settings length first (1.3).
9. [SY] decodes the V2 balancer switch at settings offset 126, but the [HA#670] capture shows it at 128 (6.3). [SY] also labels 127 and 128 as buzzer mode and battery type; both are **unverified**. The [SY] labels of V2 offsets 22 (sleep voltage) and 26 (start voltage) may be swapped: in every V2 frame 22 is above 26, the opposite order of every V1 frame (6.3, **unverified**).
10. Register 0x0D means "balancer switch" with command 0x05 and "short circuit delay" with the V2 command 0x06 (5.3).
11. Nominal capacity is a u32 integer in V1 (settings and write) and an f32 in V2 settings (6.2, 6.3).
12. The start voltage reads 0.0 on GW SW-1.1.0, which has no such setting; do not offer a write that the firmware cannot store (6.2).
13. The detection-failed mask has bits set for unused cell slots; mask with the cell count (9.2).
14. Index bytes 213 / 214 are 0-based and report the last cell on ties; compute min and max from the cell voltages (6.4).
15. Byte 215 is 0x0F with 15 or 16 cells; it is not a cell count (6.4).
16. The balance current alternates its sign between frames during balancing (energy into the supercapacitor, then out of it); average or show the magnitude with the direction as a hint (6.4).
17. The lead resistances are in Ω, the ubms model uses mΩ (6.4).
18. The vendor app shows the address of 4th generation modules reversed; the identifier in the device info frame does the same (2.1, 6.1).
19. One central at a time: the vendor app blocks ubms and the other way round (2.1).
20. Weak ESP32 power supplies and some ESP32 boards caused connection failures in [SY#384], [SY#640], [SY#767]; these are host problems, but users will report them as driver problems.
21. The write acknowledgement of GW SW-1.1.0 does not echo the value; always confirm a write through a settings frame (6.7, 4.3).
22. The rating in the model name is the maximum balance current setting; the reported balance current may exceed it slightly (7.3).

## 13. References

All URLs as read on 2026-11-18 and 2026-11-19.

[SY] syssi/esphome-jk-bms, https://github.com/syssi/esphome-jk-bms
- components/heltec_balancer_ble/heltec_balancer_ble.cpp: constants (`SOF_REQUEST_BYTE1` .. `END_OF_FRAME`, `MIN_RESPONSE_SIZE` 20, `MAX_RESPONSE_SIZE` 300, `OPERATION_STATUS`, `BUZZER_MODES`, `BATTERY_TYPES`, `CELL_ERRORS`), `crc`, `build_command_frame_` (request layout and the commented xor8 / sum8 request examples), `gattc_event_handler` (GATT tables of GW-24S4EB and EK-24S4EB), `update`, `send_command`, `assemble`, `decode_`, `decode_cell_arrays_`, `decode_cell_info_`, `decode_cell_info_v2_`, `decode_settings_v2_`, `decode_settings_`, `decode_factory_defaults_`, `decode_device_info_`; heltec_balancer_ble.h (`ProtocolVersion`, `throttle`)
- components/heltec_balancer_ble/number/__init__.py (`NUMBERS`, `V2_NUMBERS`, app command tables in the comments), number/heltec_number.cpp (`control`: integer or float payload); select/__init__.py (`SELECTS` 0x14, 0x15), select/heltec_select.cpp; switch/__init__.py (`SWITCHES` balancer 0x0D), switch/heltec_switch.cpp; button/__init__.py (`BUTTONS` 0x01, 0x03, 0x04), button/heltec_button.cpp; sensor.py (`UNIT_OHM` for the cell resistances)
- tests/components/heltec_balancer_ble: frames_gw-24s4eb.h, frames_gw-24s4eb-zh123.h, frames_ek-24s4eb.h, frames_ek-24s10eb.h, frames_ek-b24s8e200a.h and the matching *_test.cpp files; write_command_test.cpp; assemble_test.cpp
- docs/neey-gw-24s4eb-sw110, docs/neey-ek-24s4eb-zh208, docs/neey-ek-24s4eb-zh211, docs/neey-ek-b24s8e200a-sw200 (pdus-*.txt, device-info.txt)
- README.md (supported devices); esp32-heltec-balancer-ble-example.yaml
- Issues: [SY#109] "Add NEEY/Heltec 4A balancer support" (2022; comments 1200247482, 1200280511, 1200282155, 1200400389, 1200402154, 1200445939, 1200459251, 1200464667, 1201464093, 1202062333, 1208388899, 1208399805, 1208471674), [SY#310], [SY#384] (GW SW-1.1.0, comments 1784050070 and 1784055147), [SY#387], [SY#444] "Add Neey/EnerKey EK-24S4EB balancer support" (comments 1934095115, 1934112368, 1937584807, 1944454687, 1944458126, 1944459820, 1944461589, 1948446768, 1949938945, 1949941551, 1951365713, 1951419346, 1951421357, 4010419531), [SY#545], [SY#569], [SY#640] (ZH-2.0.8), [SY#707] (ZH-2.0.2), [SY#767] (4th generation, ZH-2.1.1), [SY#950] (ZH-2.1.1 settings names), [SY#1027] (EK-24S10EB, TTL port), [SY#1031] (CRC errors on small MTU), [SY#1092] (EK-24S20EB)
- Pull requests: [SY PR 145] (initial support), [SY PR 452] (EK-24S4EB, sum8), [SY PR 571] (15 A), [SY PR 677] (GW and EK behave the same), [SY PR 952] (EK-B24S8E200A), [SY PR 1032] (reassembly by length field), [SY PR 1093] (20 A), [SY PR 1120], [SY PR 1124] (factory offset 12, power-on count u32)

[SYC] btsnoop captures of the vendor apps in [SY] docs, decoded for this document with a btsnoop / ATT parser (scratchpad `neey-research/lib.mjs`, `snoop.mjs`, `timeline.mjs`):
- docs/neey-gw-24s4eb-sw110/btsnoop_hci.log: GW-24S4EB HW-2.8.0 SW-1.1.0 and the NEEY app V3.1; 1 CCCD write, 30 requests, 2673 notifications (20 bytes), 196 frames (1 device info, 2 settings, 176 cell info, 17 write acknowledgements)
- docs/neey-ek-24s4eb-zh208/btsnoop_hci.log: EK-24S4EB HW-3.2.0 ZH-2.0.8; 210 notifications of 20 bytes, 16 frames
- docs/neey-ek-24s4eb-zh211/btsnoop_hci_filtered.log ([SY#950]): EK-24S4EB HW-3.2.0 ZH-2.1.1; MTU request of 153 bytes by the balancer, 1935 notifications of 100 and 150 bytes, 970 frames

[AIO] patman15/aiobmsble, https://github.com/patman15/aiobmsble: aiobmsble/bms/neey_bms.py (`_HEAD_RSP`, `_HEAD_CMD`, `_BT_MODULE_MSG`, `_FIELDS`, `_FIELDS_v1`, `_PROBLEMS`, `matcher_dict_list`, `_fetch_device_info` with the "EK-B" rule, `_notification_handler`, `_cmd`, `_async_update`), tests/bms/test_neey_bms.py (`_PROTO_DEFS`, `_RESULT_DEFS`), tests/test_data/neey_bms.json (advertisements)

[HA#n] patman15/BMS_BLE-HA issues: [HA#291] "Neey Balancer 4th Gen" (comment 2855817366: hand transcribed GW-24S4EB ZH-1.2.4 frames; comment 2895622080: advertisement), [HA#454] "Enerkey EK-16S2EB Balancer" (attachment ET.nRF.txt with notifications, debug logs in comments 3198064982, 3201971117, 3206595158), [HA#670] "EK-B24S8E200A Not showing values" (attachments Log.2026-04-07.22_57_31.txt and Log.2026-05-11.14_14_44.txt: nRF Connect logs of the EK-B24S8E200A with the GATT table, device info, settings, write acknowledgements and cell info)

[BSC] shining-man/bsc_fw, https://github.com/shining-man/bsc_fw: src/devices/NeeyBalancer.cpp and .h (version of 2024-08: request builder `neeyBtBuildSendData`, `neeyBtCrc` with xor8 for GW and sum8 for EK units, write sequence `neeyWriteData`, register constants `NEEYBAL4A_FUNC_SETTING_*`, readback offsets; current version: readback only), src/devices/NeeySerial.cpp (serial experiment)

[BM] fl4p/batmon-ha, https://github.com/fl4p/batmon-ha: BMS_FACTSHEET.md section "NEEY active balancer" (vendor names, app package, transport)

[MAN] Henan Nengyi Electronic Technology Co., Ltd., "NEEY-24S4EB Battery Active-Balancer Specification and operation manual", Ver1.1 (sections 1, 2, 5.3.1–5.3.3, 6), distributed with the NEEY apps (https://github.com/NEEY-ELEC/NEEY-BALANCER is the app link printed in it)

[DS] NEEY balancer datasheet sheet "NEEY BALANCER" (NEEY.xlsx: 2–24 cells, sleep voltage 1.5–4.2 V, balance current 1–4 A, pack voltage above 30 V or an external supply)

Other material read for cross-checks: a Raspberry Pi MQTT reader generated from [SY] (no new facts), an STM32 NEEY reader header (request XOR checksum, frame type names), the neeywifi gateway README (units modified with an RS485 interface, no protocol published).
