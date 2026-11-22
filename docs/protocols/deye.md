# Deye batteries (RS485 "AA 55" protocol, Bluetooth session, PCS CAN V3.3)

Implementation reference for the ubms Deye drivers: the low voltage (51.2 V) Deye ESS batteries (SE-G5.1 Pro and Pro-B, SE-F5 / F5 Plus / F5 Pro, SE-F12, SE-F16 and their Max versions, RW-M6.1 and RW-M6.1-B, RW-F10.2, RW-F16, AI-W5.1-B and others with the "LVESS" BMS) with three interfaces a user can reach from a PC or a phone: the binary "AA 55" request / answer protocol on the RS485 pins of the PCS port (the protocol of the vendor tool LVESS_UART_Monitor), the same frames inside an AES encrypted Bluetooth session (SE-F series, Deye Cloud app), and the broadcast frames of the PCS CAN bus (Deye "PCS-CANBUS" protocol V3.3, read through a USB-CAN adapter that speaks SLCAN). The internal pack bus (InterCAN) and the high voltage systems (BOS-G, BOS-G Pro, BOS-A, GB-A) are described for reference only (sections 6.4 and 6.5).

Compiled 2026-11-19 from the Deye protocol document for the PCS CAN bus (machine translated from Chinese), Deye manuals and brochures, two Deye PC tools published by a user, the source code, captures and notes of the open-source projects listed in section 13, and forum posts. Every statement carries a source tag. **unverified** marks a value that has a single weak source, was inferred, or conflicts between sources. Where no Deye specific source exists for a detail, the text says so instead of guessing.

Test vectors: `packages/bms-drivers/test/vectors/deye.json` (74 frames: 25 RS485, 2 Pylontech framed frames observed on a Deye RS485 port, 10 Bluetooth, 37 PCS CAN). `variant` is `DEYE_RS485`, `DEYE_BLE`, `DEYE_PCS_CAN` or `PYLON_ASCII_OBSERVED`; `link` is `rs485`, `ble` or `can`. `hex` always holds the bytes on the link that ubms opens: the AA 55 frame (RS485), the GATT value (Bluetooth: handshake messages in clear, data frames encrypted), or the SLCAN text line of the USB-CAN adapter (`t3518...` plus CR, built from the captured CAN frame; key `slcan` without the CR). Keys in `expected` are named in `code` in this document and are in model units (V, A, Ah, kWh, °C, %), except `...Raw` keys and bit bytes. AA 55 keys: `address`, `command`, `length` (data bytes), `crc` (as transmitted, low byte first, read as a number); Bluetooth keys: `name`, `randomStr`, `key`, `tag`, `trailer`, `block`, `plain` (decrypted AA 55 frame), `plainText` (requests); CAN keys: `canId`, `extended`, `dlc`, `data`, `profile` (`deye` for the Deye native profile, `victron` for the victronCAN profile), `pack` (1 based) for per-pack frames; `current` is always in the ubms convention (positive while charging), `currentWire` as sent; bit flag keys (`chargeEnable`, `chargeMos`, `parallelDone` and similar) follow section 9, count keys (`overchargeCount` and similar) section 6.2. Every vector was checked with a node script: AA 55 header, length, CRC-16/MODBUS and CR LF; Pylontech CHKSUM, LCHKSUM and LENID; the Bluetooth handshake trailers, the AES block of each cipher answer recomputed from name and random string, decryption and the AA 55 checks of every encrypted frame; the SLCAN line against `canId`, `dlc` and `data`; an independent decode compared with `expected`; and the presence of the exact bytes in the cached copy of the source. No frame content is constructed: all 74 payloads are copies of published captures. Only the wrapping is added where the source shows the frame in another form: the SLCAN line around each captured CAN frame, and the CR after the Pylontech answer that the source prints as text. The Bluetooth names were anonymized and the ciphertexts re-keyed by their source (the plaintext frames are the captured ones), and the CAN serial number frames carry a placeholder text of their source; the descriptions say so. Answer 0x04 `rs485-rx-04-se-g51-2` is the only frame whose header extremes disagree with its cell array (6.1.4).

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
14. Implementation in ubms

## 0. Conventions

- Three protocols are described; section headings say which one: **RS485** (AA 55 frames on the PCS port), **BLE** (the same AA 55 frames inside the Bluetooth session), **CAN** (PCS CAN broadcast frames). "AA 55" applies to RS485 and BLE alike.
- Offsets are decimal. AA 55 offsets inside a table count from the first data byte (frame byte 5) unless the table says "frame offset". CAN offsets are byte numbers 0..7 of the data field.
- Byte order: **big-endian** in AA 55 data ([SX] README "Byte order ... is big-endian", confirmed by the cell array of every 0x04 answer of [PSR] and [MV]); **little-endian** in CAN data ([V33] page 3 "Little endian", [VP] `decoder.py` `_u16`, [PS] lambdas `(x[1] << 8) | x[0]`).
- Types: u8, u16, s16, u32. Scale: physical value = raw × scale (+ offset where stated).
- Current sign: ubms uses positive while charging. AA 55 0x01: positive while charging on the LVESS02 firmware ([PSR] screenshot: SysCurr 6.9 with BMSStatus Charge); CAN 0x150 and the Deye native 0x356: **discharge positive, charge negative** ([V33] revision table "discharge is positive, charge is negative"; [VPC] 0x400 mode 1 = charge with 0x150 current −0.3 A); the victronCAN profile inverts 0x356 only ([VP] README "inverts the sign of the current in 0x356", vectors `can-356-charge-native` / `can-356-charge-victron`).
- Temperatures in AA 55 frames are one byte with an offset: °C = raw − 40 ([SX] README `raw-40`, [PSR] screenshot). CAN temperatures are s16 in 0.1 °C without offset ([V33] revision table "uniformly use signed short reporting, without the need for offset").
- Source tags (details in section 13): [V33] Deye "PCS-CANBUS Protocol" V3.3 (2024-05-25), English machine translation; [VP] vladyspavlov/dbus-deye-battery (decoder, notes, vendor app cross-check); [VPC] its two real CAN captures of an SE-F12-C; [PS] Psynosaur/esphome-deye-bms (PCS CAN and InterCAN decoders, InterCAN parameter table, HV decoder, issues); [PSR] Psynosaur/Deye_Battery_Serial_BUS (RS485 log, screenshot of the vendor tool at the time of the log, reader code, setup photos); [MV] Maavey/deye_battery_bms_rs485; [SX] SoCoxx/Deye-Battery-BLE (decompiled Deye Cloud app, HCI captures of an SE-F16-C); [UM] the Deye RS485 PC tool "LVESS_Monitor V1.07" (window title LVESS_UART_Monitor in [PSR]), strings of its executable; [UC] the Deye CAN PC tool "LowVoltageBmsUpperComputer" V1.18 (window title LVESS_Monitor), its configuration files; [PF] powerforum.co.za thread "Deye SE-G5.1 Pro batteries"; [AS] asmcc/my48vdc; [AD] Adminius/esphome-yaml-collection; [YB] Sleeper85/esphome-yambms; [MAN-G51B], [MAN-M61], [MAN-F5P], [MAN-BOSG], [MAN-BOSGP], [MAN-GBA] Deye manuals; [BRO] Deye brochures; [SEP] [seplos.md](seplos.md) of this repository.

## 1. Overview

### 1.1 Models and interfaces

All low voltage models below are 16 cells of LiFePO4 in series (51.2 V). The RS485 and CAN columns refer to the PCS port (section 2.1), which every model has.

| Model (current Deye names) | Capacity | PCS port (RS485 + CAN) | IN / OUT (InterCAN) | Bluetooth | Sources |
| --- | --- | --- | --- | --- | --- |
| SE-G5.1 Pro (older, LVESS02 BMS) | 100 Ah | yes | yes | none listed | [PSR], [PF] page 1 ("It talks to the inverter via CAN BUS via the PCS port"), [UM] |
| SE-G5.1 Pro-B (rack, EU, NA, AU) | 100 Ah | yes | yes | none listed ("CAN2.0, RS485") | [MAN-G51B] 2.2 and 2.4, [BRO] |
| SE-F5, SE-F5 Plus | 100 Ah | yes | yes | built in ("Bluetooth+APP") | [BRO] SE-F series 2026-02-02 |
| SE-F5 Pro (-L, -E, -C: logo, LED, LCD versions) | 100 Ah | yes | yes | optional data logger stick (Wi-Fi + Bluetooth) | [MAN-F5P] 2.3, 2.4, 6.3; [BRO]; [VP] (SE-F5 Pro-C verified on CAN) |
| SE-F12, SE-F12 Max | 230 to 235 Ah | yes | yes | built in | [BRO]; [VP] (SE-F12-C, 230 Ah on CAN) |
| SE-F16, SE-F16 Max | 314 Ah | yes | yes | built in; [SX] reads an SE-F16-C | [BRO], [SX] |
| SE-F5 Lite, SE-F5-A, SE-F5 Plus-A, SE-F12-A, SE-F16-A | various | not checked | not checked | not checked | [BRO] global brochure 2026-09-21 (names only) |
| RW-M6.1, RW-M6.1-B | 120 Ah (6.1 kWh) | yes ("Inverter CAN/RS485 port PCS") | yes | none listed | [MAN-M61], [AS], [AD] |
| RW-F10.2, RW-F10.2-B, RW-F16, RW-F5.3-1H3 | various | not checked | not checked | not checked | [BRO], Deye ESS download list |
| AI-W5.1-B (stacked module) | 100 Ah | "CAN2.0, RS485" | not checked | none listed | [BRO] |

High voltage systems (not implemented, section 6.5): BOS-G (HVB750V/100A control box with BOS-GM5.1 modules), BOS-G Pro (BOS-G-PDU-2 box), BOS-A (CAN2.0 only), GB-A ([MAN-BOSG], [MAN-BOSGP], [MAN-GBA], [BRO] BOS-A NA brochure).

Which BMS a pack has is visible in its version strings: hardware `LVESS02_V1` with software `LVESS0223526N03` (SE-G5.1 Pro, 2023, [PSR]), hardware `LVESS15MOS` with software `LVESS1525814B01` ([MV], model not named, 160 / 230 A limits fit an SE-F12 or SE-F16, **unverified**), software `LVESS1526701N01_F005` (SE-F12-C, [VP]), boot and firmware files `LVESS0223526N03_2007`, `LVESS0224626N02_2018`, `LVESS0223901N01_2007` ([UC] release assets). [SX] calls the BMS of the SE-F16-C "neptune" (app config `neptuneConfig`, Bluetooth codename `neptune_ble`).

### 1.2 Protocols on the battery

1. **RS485 "AA 55"** (PCS port, pins 1/2 or 7/8, 9600 8N1): request and answer, binary, CRC-16/MODBUS. Used by the vendor tool LVESS_UART_Monitor ([PSR] screenshot: "LVESS_UART_Monitor V1.09", COM5, 9600) and by [PSR] and [MV]. Five read commands are known (section 5.1). Deye publishes no description; the field map in section 6.1 comes from the decompiled Deye Cloud app ([SX]) and is checked against the vendor tool screenshot taken at the end of the [PSR] log.
2. **BLE session** (SE-F series, Deye Cloud app "local mode"): the same AA 55 frames, encrypted with AES-128-CBC after a handshake ([SX]). The plaintext of the captured 0x02 answer is byte for byte the RS485 0x02 answer of [PSR] (vectors `ble-rx-02-encrypted`, `rs485-rx-02-se-g51-1`).
3. **PCS CAN** (PCS port pins 4/5, 500 kbit/s, 11-bit identifiers): the battery (the master pack of a bank) broadcasts limits, SOC, SOH, voltage, current, extremes, alarms and per-pack summaries for up to 32 packs about once per second ([V33], [VP], [VPC], [PS]). It is the only Deye-documented interface. Newer firmware has a selectable inverter profile: Deye native (shown as "Sol-ark" in the app) or "victronCAN" ([VP] README "The newer firmware adds CAN protocol selection").
4. **InterCAN** (IN / OUT ports, 250 kbit/s, 29-bit identifiers): pack to pack bus, carries every cell voltage, the parameter read and write service of the vendor CAN tool; cell frames appear only after a wake frame is sent ([PS] issue 3 and 7, [PF] page 4). Reference only (section 6.4).
5. **Pylontech RS485 ASCII** (`~` frames, protocol version 3.5): no Deye source shows a Deye low voltage pack answering Pylontech telemetry. One observation: an LVESS15 pack answered a `~20024642E00202FD33` request with RTN 0x00 and an empty INFO ([MV], vectors `pylon-tx-42-adr02`, `pylon-rx-empty-adr02`). A forum reply says the PCS protocol of a pack can be changed with the vendor CAN tool ([PF] page 5), which protocols it offers is not documented (**unverified**).

### 1.3 Driver definitions (plan)

| id | Protocol | Links | Notes |
| --- | --- | --- | --- |
| `deye-rs485` | AA 55 | serial, 9600 8N1, USB to RS485 adapter on the PCS port | read only; cells, temperatures, limits, versions; alarms only as raw bytes (6.1.2). Only when the inverter talks to the battery over CAN: with the inverter on RS485, ubms would be a second master on that bus, which no source covers (4.1, 12); the connection note says so |
| `deye-ble` | AA 55 in the AES session | BLE service FFF1, characteristic FFF2 | read only; needs AES-128 and SHA-256 in pure JavaScript (drivers never touch browser APIs) |
| `deye-can` | PCS CAN V3.3 | serial, SLCAN (Lawicel) USB-CAN adapter at 500 kbit/s | never transmits a CAN frame: the adapter opens listen only and acknowledges frames (normal mode) only when no other node does (4.3); bank and per-pack summaries, no individual cells; needs the generic SLCAN codec of `@ubms/transport` and must not be tried by automatic serial detection (11.4) |

All three: `family: 'deye'`, `vendor: 'Deye'`, `deviceType: 'bms'`. No setting is writable and no action is offered (sections 7, 8).

### 1.4 Telling variants apart at runtime

- RS485 or CAN: the user chooses the adapter; an RS485 adapter cannot see CAN and the reverse.
- AA 55 main answer length: 61 data bytes on RS485 ([PSR] 2023, [MV] 2026), 65 in the app configuration of the SE-F16-C ([SX] `main_message` "65 bytes"); bytes 61..64 exist only in the longer form (6.1.1).
- Pack current encoding in the 0x01 answer differs between BMS generations (6.1.1): offset 3000 on LVESS02 (proven), presumably 30000 on LVESS15 (**unverified**).
- CAN profile: `0x35E` starting with `DY` = Deye native; `0x35E` starting with `PYLON` together with `0x35F` (ending in `DY`) and `0x35A` = victronCAN ([VP] `profile.py`, [VPC]).

## 2. Physical links

### 2.1 PCS port (RJ45)

| Pin | Signal | Sources |
| --- | --- | --- |
| 1 | RS485 B | [MAN-G51B] 2.4 "Definition of PCS Port Pin"; [PSR] README image (same table) |
| 2 | RS485 A | same |
| 3 | not connected | same |
| 4 | CAN H | same; [VP] README wiring ("Deye pin 4 → Victron pin 7") |
| 5 | CAN L | same |
| 6 | not connected | same |
| 7 | RS485 A | same; [VP] README ("Deye pins 7 and 8, which are RS485") |
| 8 | RS485 B | same |

The BOS-G and BOS-G Pro control boxes use the same assignment on their "PCS COM" port (485B− 1 and 8, 485A+ 2 and 7, PCANH 4, PCANL 5; [MAN-BOSG], [MAN-BOSGP]); the GB-A uses a 16 pin COM connector with PCS CAN on 14/15 ([MAN-GBA]).

| Item | Value | Sources |
| --- | --- | --- |
| RS485 | 9600 bit/s ("RS-485 (baud rate: 9600bps), used to output battery information to the inverter"); 8N1 | [MAN-G51B] 2.2, [MAN-F5P] 2.4, [BRO]; 8N1: [MV] table, [PSR] code (`BaudRate = 9600`, defaults) |
| RS485 address | 0x01 in every capture; [PSR] read two packs over two adapters, both at 0x01; whether a pack in a bank answers another address is not documented (**unverified**) | [PSR] `RS485BackgroundService.cs`, [MV] "Confirmed battery address: 01" |
| Vendor tool baud rates | 9600, 19200, 38400, 115200 offered by the RS485 tool; 9600 used | [UM] strings, [PSR] screenshot |
| CAN | 500 kbit/s, standard (11-bit) frames, data cycle 1 s | [V33] page 3, [MAN-M61] "baud rate: 500K", [VP] README "classical 11-bit frames" |
| CAN termination | not documented by Deye for the PCS port; a Victron installation terminates the bus with the GX terminator | [VP] README (Victron cable guidance) |

Where the RS485 tool connects: [PSR] split the PCS port of each pack into "CAN to Inverter" and "RS485" with an RJ45 breakout and read each pack with its own USB to RS485 adapter (setup photo in the README of [PSR], labels "Top CAN + RS485", "Bottom RS485"). The pinout above has two RS485 pairs (1/2 and 7/8); which pair [PSR] used is not stated (**unverified**; both pairs carry the same bus per the table).

**Wiring warning** ([VP] README "DANGER"): never connect the PCS port to another device with a straight-through patch cable. A Victron BMS-Can port has CAN on 7/8 and supply voltages on other pins; a patch cable puts CAN levels on the RS485 pins of the battery and supply voltages on its connector. Connect only the signal wires of the bus in use; [VP] also advises against wiring ground to a non-isolated port (ground loop).

### 2.2 IN / OUT ports (InterCAN)

| Pin | IN | OUT | Sources |
| --- | --- | --- | --- |
| 1 | CAN L | CAN L | [MAN-G51B] 2.4 "Definition of IN Port Pin", "Definition of Out Port Pin" |
| 2 | CAN H | CAN H | same |
| 3 | DI+ | DO+ | same |
| 4 | DI− | DO− | same |
| 5 | DI− | DO− | same |
| 6 | DI+ | DO+ | same |
| 7 | CAN H | CAN H | same |
| 8 | CAN L | CAN L | same |

InterCAN runs at 250 kbit/s with 29-bit identifiers ([PS] `deye-can-bus.yaml` `bit_rate: 250KBPS`, issue 3; [PF] page 2 "The wiring for the InterCAN port is different and it also uses a different baud rate of 250K"). The DI/DO pairs are the wake / address chain of the parallel bank (inference from the names, **unverified**).

### 2.3 BLE (SE-F series)

| Item | Value | Sources |
| --- | --- | --- |
| Advertised name | `BAT` followed by the serial number printed on the QR sticker, e.g. `BAT00000000000001` (anonymized by the source) | [SX] README "Device identification"; [VP] README (the app lists the battery as a device starting with `BAT...`, its QR code is the serial number) |
| Service | 0xFFF1 (`0000fff1-0000-1000-8000-00805f9b34fb`) | [SX] README "GATT layout" |
| Characteristic | 0xFFF2 (`0000fff2-...`), properties notify, read, write without response; carries the handshake and all data in both directions | [SX] |
| Other service | `02f00000-0000-0000-0000-00000000fe00` with characteristics ff00..ff03, unused by the app | [SX] |
| Module | Tuya / ThingSmart BLE SDK transport; the data protocol on top is Deye's own | [SX] |
| Pairing | none, no bonding | [SX] "not paired/bonded" |
| Units checked | 3 SE-F16-C packs | [SX] `verify_all_three.py` |

The SE-F5 Pro gets Bluetooth only with the optional data logger stick ([MAN-F5P] 6.3); whether the stick exposes the same service and session is not documented (**unverified**). The SE-G5.1 Pro and Pro-B list no Bluetooth ([BRO], [MAN-G51B]).

### 2.4 USB-CAN adapters

- **SLCAN (Lawicel ASCII)** adapters (USBtin, Lawicel CANUSB, CANable with slcan firmware and clones) appear as a serial port and can be driven with Web Serial; ubms supports this kind only (section 3.3.2), and only adapters that answer every command with CR or BEL (4.3). The stock CANable slcan firmware (normaldotcom/canable-fw, `usbd_cdc_if.c`: the CR and BEL replies are commented out; `slcan.c` knows no `L`, its listen only mode is `M1`) answers no command, so the probe times out on `S6` and the adapter is not supported (firmware source read, **unverified** on hardware; other CANable firmware builds were not checked). Support for adapters without answers (write the commands blindly, open with `M1`, let received frames prove the adapter) is not implemented. [PF] page 2 shows a user reading InterCAN with a CANable through the SLCAN driver of "CAN Monitor 3000" ("Selecting SL-Can/ Lawicel => set to listen only and 250").
- **ZLG USBCAN / CANalyst-II**: the vendor CAN tool ([UC]) uses the ZLG `ControlCAN` library (`ControlCAN.lib`, `kerneldll.ini` lists `USBCAN.dll`, `USBCAN_E.dll` and other ZLG drivers); these are USB devices with a vendor DLL, not reachable from a browser. [PF] page 2: "the software doesn't work with it [slcan device]".
- **CH340 "USB-CAN" analyzers** with the binary `AA ... 55` serial protocol of "CAN Monitor 3000" ([PSR] `CANInformation/Can bus analysis.txt`: `AA-55-01-01-01-56-03-...`) are a different protocol, not SLCAN; not supported. Their `AA 55` frames must not be confused with the battery's AA 55 RS485 frames.

## 3. Frame formats

### 3.1 AA 55 frame (RS485 and BLE plaintext)

| Frame offset | Size | Field | Notes | Sources |
| --- | --- | --- | --- | --- |
| 0 | 2 | header `AA 55` | | [MV], [SX], [PSR] |
| 2 | 1 | address | 0x01 in every capture, requests and answers | [MV], [SX], [PSR] |
| 3 | 1 | command | 0x01..0x05 (section 5.1); the answer repeats the request's command | [MV], [PSR] |
| 4 | 1 | length n | number of data bytes; 0 in every request | [MV], [SX], [PSR] |
| 5 | n | data | big-endian fields | [SX] |
| 5 + n | 2 | CRC | CRC-16/MODBUS (polynomial 0xA001 reflected, initial value 0xFFFF, no final XOR) over command, length and data (frame bytes 3 .. 4 + n), **low byte first** | [SX] `build_frame`, README "CRC"; all 75 frames of the [PSR] log and every [MV] frame pass (this research) |
| 7 + n | 2 | `0D 0A` | CR LF | [MV] "Frame Terminator 0D 0A", [SX] |

Header and address are not covered by the CRC ([SX]). Total length = n + 9.

Worked example: request 0x01 = `AA 55 01 01 00 00 20 0D 0A`. CRC-16/MODBUS of `01 00` = 0x2000, sent as `00 20` (vector `rs485-tx-01`). Answer 0x02 without alarms: `AA 55 01 02 0C` + 12 × `00` + `B9 0F 0D 0A` (CRC 0x0FB9 over `02 0C 00 ... 00`, vector `rs485-rx-02-se-g51-1`).

The header `AA 55` and the terminator `0D 0A` may also occur inside the data (cell voltages such as 0x0D0A = 3338 mV): find frames by header, length and CRC, never by searching for CR LF.

### 3.2 BLE session

All messages are written to and notified from characteristic 0xFFF2 ([SX]).

**Handshake** (in clear; CRC-16/MODBUS of all preceding bytes, low byte first, as trailer):

| Message | Direction | Bytes | Sources |
| --- | --- | --- | --- |
| random | host → battery | `01 FF` + ASCII `random` + randomStr (16 ASCII hex characters chosen by the host, upper case in the app) + trailer; 26 bytes | [SX] `build_random_message`; vectors `ble-tx-random-1..3` |
| cipher | battery → host | `01 FF` + ASCII `cipher` + one 16 byte block = AES-128-CBC(key, IV, randomStr) without padding + trailer; 26 bytes | [SX] `verify_cipher_response`, `verify_all_three.py`; vectors `ble-rx-cipher-1..3` |
| result | host → battery | `01 FF` + ASCII `result` + status 0x01 + trailer; 11 bytes | [SX] `build_result_message`; vector `ble-tx-result` |

- key = the first 16 characters of the lower case hex SHA-256 of (advertised name + randomStr), used as 16 ASCII bytes ([SX] `get_ble_key`; example: name `BAT00000000000001`, randomStr `7C9DDC07457314B7` → key `6825a9f956746774`).
- IV = the 16 ASCII characters `0000000000000000` (0x30 × 16), the same for every message ([SX] "not sixteen null bytes").
- The host checks that the cipher block equals its own AES of randomStr; a mismatch means a wrong name or a foreign device. "Real hardware silently drops the entire message ... if the trailer is wrong" ([SX] README).

**Data frames** after the handshake ([SX] "Asymmetry to replicate exactly"):

- Request: AES-128-CBC with PKCS#7 padding (same key and IV) of the **lower case ASCII hex text** of the AA 55 request frame. `AA 55 01 02 00 00 D0 0D 0A` → text `aa5501020000d00d0a` (18 characters) → 32 bytes of ciphertext (vector `ble-tx-02-encrypted`).
- Answer: AES-128-CBC with PKCS#7 padding of the AA 55 frame bytes themselves (no text layer). An 81 byte 0x04 answer becomes 96 bytes (vector `ble-rx-04-encrypted`).
- Each GATT write and each answer is encrypted on its own (CBC restarts with the fixed IV); in the captures every answer arrived in one notification ([SX] example client takes one notification per request; large MTU on BlueZ). With a small MTU an answer may be split: collect notifications until the length is a multiple of 16 and decryption yields valid padding and a complete AA 55 frame (inference, **unverified**).

Security note ([SX] "Security notes"): the key derives from public data only (the advertised name and a nonce the host chooses), so the session gives no protection; ubms may implement it without any secret.

### 3.3 PCS CAN frames

#### 3.3.1 CAN frames

- Standard 11-bit identifiers, DLC 8, data little-endian ([V33] page 3, [VP] `decode` rejects DLC ≠ 8, [VPC] every battery frame has 8 bytes).
- Bank frames (sent once by the master pack): 0x351, 0x355, 0x356, 0x358 (USB board option), 0x359, 0x35C, 0x35E, 0x361, 0x363, 0x364, 0x371; victronCAN profile adds 0x35A, 0x35F and drops 0x359, 0x35C, 0x361, 0x363, 0x364, 0x371 ([V33], [VP] README "victronCAN drops ...").
- Per-pack frames: identifier = base + (pack address − 1) for the bases 0x110, 0x150, 0x200, 0x250, 0x400, 0x500, 0x550, 0x600, 0x650, 0x700, 0x750 ([V33] "CAN ID:0x110+(BmsAddr - 1)", [VP] notes "Per-pack frames in a parallel bank", confirmed on a two pack SE-F5 Pro-C bank). [VP] decodes up to 32 packs per base; packs beyond 32 are not covered by any source.
- Inverter frames on the same bus (never sent by ubms): 0x305 heartbeat, 0x306 USB board control, 0x307 inverter identity ([V33] page 3, [VPC]).

#### 3.3.2 SLCAN lines on the serial link

Lawicel ASCII protocol of the USB-CAN adapter (generic, see `packages/transport/src/slcan.js`):

| Line | Meaning |
| --- | --- |
| `t` iii l dd... CR | received or transmitted standard frame: 3 hex digits identifier, 1 digit DLC, 2 hex digits per data byte; adapters with time stamps on (`Z1`) append 4 hex digits (ms) |
| `T` iiiiiiii l dd... CR | extended (29-bit) frame |
| `r` iii l CR, `R` iiiiiiii l CR | remote frames |
| `S6` CR | set 500 kbit/s (`S5` = 250 kbit/s for InterCAN) |
| `O` CR, `L` CR, `C` CR | open the channel normally, open listen only, close |
| CR / BEL (0x07) | command accepted / rejected |

The battery frame 0x351 `48 02 00 00 FC 08 E0 01` arrives as `t351848020000FC08E001` CR (vector `can-351-ccl0`).

### 3.4 Reassembly

- RS485: the answer follows the request after about 60 to 80 ms at 9600 bit/s ([PSR] log time stamps; the logger printed each answer next to the following request). Collect from `AA 55`, read n at offset 4, wait for n + 9 bytes, check CRC and CR LF; on failure skip one byte and search again.
- BLE: see 3.2.
- CAN: one SLCAN line per frame; ignore lines that are not `t`/`T` frames (command acknowledgements CR, BEL, `z`, `Z`).

## 4. Session flow

### 4.1 RS485

1. Open the port at 9600 8N1 ([MAN-G51B], [MV], [PSR]).
2. Send one request at a time; wait up to 500 ms for the answer (observed 60 to 80 ms, [PSR]). The vendor tool and [PSR] cycle through 0x03, 0x04, 0x05, 0x01, 0x02 about every 0.35 s per request ([PSR] log); ubms needs 0x01, 0x03 and 0x04 per poll (about 1 s), 0x02 for alarms, 0x05 not at all.
3. A pack on the bus that is also connected to an inverter over RS485 (RS485 inverter protocol selected) would share the bus with the inverter's requests: not covered by any source (**unverified**); use the RS485 pins only when the inverter talks CAN.

### 4.2 BLE

1. Connect, discover service 0xFFF1, enable notifications on 0xFFF2 ([SX] example client).
2. Handshake (3.2): write `random`, wait up to 5 s for `cipher` ([SX] client timeout 5000 ms), check the block, write `result`.
3. Poll 0x01, 0x03, 0x04 one at a time, 5 s timeout each ([SX] client). [SX] polls three packs every 30 s in production; a 2 to 5 s poll interval is an assumption (**unverified**).
4. A new connection needs a new handshake (key derives from a fresh random string).

### 4.3 CAN (SLCAN)

1. Open the serial port (CDC ACM; the baud rate is ignored by most adapters).
2. Write `C` CR (close a channel left open), `S6` CR (500 kbit/s), then `L` CR (listen only). Each command waits up to 500 ms for CR or BEL; no answer to `S6` ends the probe (no SLCAN adapter, or one that answers no command, 2.4). In listen only mode the adapter takes no part in the bus: no acknowledge bit, no error frame. When another node (the inverter) is on the bus, it acknowledges the battery's frames and the adapter receives all of them within one bank cycle. When the battery is the only other node, nobody acknowledges: the battery repeats its first frame forever, each attempt ends in an error at the acknowledge delimiter, and the adapter receives nothing (CAN acknowledge rule; general CAN behaviour, not a Deye source). So when nothing arrives within about 1.5 s, write `C` CR and `O` CR: in normal mode the adapter acknowledges frames, but transmits none of its own. Normal mode also sends error frames on bit errors, so on a bus with another bit rate (the 250 kbit/s InterCAN pins, 2.2) it would disturb that bus; listen only first keeps this to the case where nothing at all was received. If the acknowledging node leaves later (the inverter is switched off), the frames stop in listen only mode; then switch to normal mode the same way.
3. Listen. The master pack sends every bank frame about once per second, the per-pack frames 0x110, 0x150, 0x200, 0x250, 0x400 about once per second, 0x500, 0x600, 0x650 every 2.1 s and 0x550, 0x700, 0x750 every 5.3 s ([VPC] measured over 296 s: mean intervals 1.00 to 1.09 s, 2.10 to 2.13 s, 5.28 to 5.36 s).
4. Never transmit. The battery sends its frames without the inverter heartbeat 0x305: a user read the PCS bus for a year with an ESP32 that never wrote ("Currently I am only reading and not writing to the CANBUS", and filtering for 0x305 found nothing, [PF] page 3). Whether the pack raises "PCS communication failure" (table 4 bit 6) or goes to sleep sooner without 0x305 is unknown; the same user saw his idle pack switch off after one or two days (**unverified** cause).
5. Close with `C` CR.

## 5. Commands

### 5.1 AA 55 requests (RS485 and BLE)

| Command | Name in the app | Request frame (address 0x01) | Answer data | Sources |
| --- | --- | --- | --- | --- |
| 0x01 | `main_message` | `AA 55 01 01 00 00 20 0D 0A` | 61 bytes (65 in the SE-F16-C app config), 6.1.1 | [MV], [PSR], [SX] |
| 0x02 | `waring_message` (sic) | `AA 55 01 02 00 00 D0 0D 0A` | 12 bytes, alarm bits, layout unknown (6.1.2) | [MV], [PSR], [SX] capture |
| 0x03 | `cell_temperature_message` | `AA 55 01 03 00 01 40 0D 0A` | 13 bytes used, 21 sent on RS485; the app configuration says 13 (6.1.3) | [MV], [PSR], [SX] |
| 0x04 | `cell_voltage_message` | `AA 55 01 04 00 03 70 0D 0A` | 8 + 2 × 32 = 72 bytes on RS485 and Bluetooth; the app configuration says 40 (6.1.4) | [MV], [PSR], [SX] |
| 0x05 | none known | `AA 55 01 05 00 02 E0 0D 0A` | 64 bytes, all zero in both captures (6.1.5) | [MV], [PSR]; [UM] has a `Parse0x05Frm` routine |

Other commands exist but are not documented: the RS485 tool writes parameters with command 0x60 ([UM] strings "cmd = 0x60, write parameter successed!", `Parse0x60Frm`) and has buttons for reading system information, setting the BMS code and product serial number, "Recover system", "Deep sleep", "Shut down", "Enter debug mode", "Erase code", "Clear Mos Adhesion Fault", history and event download and erase, and firmware upgrade over RS485 ([UM] strings, [PSR] screenshot; [PF] page 2 firmware changelog "Add the function of reading historical data and historical events on the 485 serial port host computer", "Add the 485 serial port upgrade function"). Their command codes and frames are unknown. **ubms sends only commands 0x01 to 0x04.** 0x05 is polled by the vendor tool and harmless in the captures, but its content is unexplained, so ubms does not send it.

### 5.2 CAN

ubms sends nothing on the PCS bus. For reference, frames other nodes send:

| Id | Sender | Content | Sources |
| --- | --- | --- | --- |
| 0x305 | inverter, every 1 s | heartbeat; [V33]: bytes 0..5 = second, minute, hour, day, month, year − 2000 (the table is garbled in the translation, the year row reads "offset 2000"); a Victron GX sends eight zero bytes ([VP]: "Deye V1.0 requires eight zero bytes") | [V33] page 3, [VPC], [VP] `_decode_305` |
| 0x306 | inverter | USB board control: byte 0 USB switch (0 close, 1 open), bytes 1..2 disable time in s (3000 to 18000, default 5 min per the translation) | [V33] page 3 (**unverified**, garbled table), [VP] `_decode_306` |
| 0x307 | Victron GX | `12 34 56 78 56 49 43 00` ("VIC"), Victron's inverter identity frame | [VPC], [VP] `_decode_307` |
| 0x18A2FF80 (29-bit), data `01` | vendor CAN tool | InterCAN wake frame, about every second; 0x18A20080 `01` once when the app connects | [PF] page 4 (ZS1SCI), [PS] `deye-can-bus.yaml` L225-L228, [YB] |

The [PS] and [YB] decoders send the InterCAN wake frame once after the first 0x351; on the PCS bus it has no documented effect. ubms does not send it.

## 6. Responses

### 6.1 AA 55 answers (RS485 and BLE)

Offsets count from the first data byte (frame byte 5). Keys in `code` are the `expected` keys of the vectors.

#### 6.1.1 0x01 main information (61 data bytes; 65 in the SE-F16-C app)

| Offset | Size | Field (`expected` key) | Scale and unit | Notes | Sources |
| --- | --- | --- | --- | --- | --- |
| 0 | u16 | heating current (`heatingCurrent`) | 0.1 A | 0 in every capture; tool "HeatCurrent(A) 0" | [SX] `heating_current`; [PSR] screenshot |
| 2 | u16 | SOC, second value (`socAh`) | 0.1 % | equal to offset 23 in every capture; the tool shows "SysSOC(%)" and "AH SOC(%)", both 93.9; which label belongs to which offset is not proven (**unverified**); the app map skips these bytes | [PSR], [MV] |
| 4 | u16 | SOH (`soh`) | 0.1 % | 100.0 | [SX] `soh`; [PSR] "SOH(%) 100" |
| 6 | u8 | MOSFET temperature (`mosTemp`) | raw − 40 °C | 0x39 = 17 °C | [SX] `mos_temperature`; [PSR] "MosTemp 17" |
| 7 | u8 | board temperature (`boardTemp`) | raw − 40 °C | 0x3C = 20 °C; raw 0 (−40) on the LVESS15 pack, probably no sensor | [SX] `board_temperature`; [PSR] "BoardTemp 20"; [MV] |
| 8 | u8 | heating film temperature (`heaterTemp`) | raw − 40 °C | raw 0 shown as −40 by the tool; [SX] lists °C without offset, the screenshot decides for the offset (**unverified**, one value); −40 means no heater sensor | [SX] `heating_film_temperature`; [PSR] "HeatFilmTemp -40" |
| 9 | u16 | cycles (`cycles`) | 1 | 5 | [SX] `charge_discharge_cycles`; [PSR] "CycleTimes 5" |
| 11 | u8 | status byte (`statusByte`) | bits | 0 in every capture; meaning unknown. The tool shows "LoadStatus: NotDetected" and "ChgInStatus: NotDetected" without a visible source byte (**unverified** candidate) | [SX] `status_byte_11` |
| 12 | u16 | charge current limit (`chargeCurrentLimit`) | 0.1 A | 40.0 (SE-G5.1 Pro), 160.0 (LVESS15) | [SX] `allowed_charging_current`; [PSR] "MaxChgCur 40" |
| 14 | u16 | discharge current limit (`dischargeCurrentLimit`) | 0.1 A | 100.0, 230.0 | [SX] `allowed_discharging_current`; [PSR] "MaxDsgCur 100" |
| 16 | u8 | heating request (`heatRequest`) | bits | 0 = "SysHeatNeed: No"; bit meanings unknown | [SX] `bms_heating_demand_byte`; [PSR] |
| 17 | u8 | charge request (`chargeRequest`) | bits | 0 = "FullChgRequest: No", "ForceChgRequest: No"; 0x01 on the LVESS15 pack (meaning unknown) | [SX] `charge_request_status_byte`; [PSR]; [MV] |
| 18 | u8 | BMS sub-state (`subState`) | code | 0x0F in both packs; enumeration unknown (as CAN 0x400 bytes 6-7) | [SX] `bms_sub_status`; [PSR] "SysSubState 0xf" |
| 19 | u16 | system (bank) voltage (`voltage`) | 0.1 V | 54.0 V | [SX] `parallel_system_total_voltage`; [PSR] "SysVolt 54" |
| 21 | u16 | system (bank) current (`currentRaw`, `current`, `currentOffset` = offset chosen by the rule below) | (raw − 3000) × 0.1 A on LVESS02; positive while charging | raw 3069 = +6.9 A with "BMSStatus: Charge" in the tool at the same moment (life counter 248 in frame and screenshot); [SX] gives "A ×0.1" without the offset; the LVESS15 pack sends raw 30240, which the 3000 offset turns into an impossible 2724 A: there the offset is probably 30000 (+24.0 A, **unverified**, no reference value) | [PSR] screenshot and vector `rs485-rx-01-se-g51-7`; [SX] `parallel_system_total_current`; [MV] |
| 23 | u16 | SOC (`soc`) | 0.1 % | 93.9, 82.4 | [SX] `soc`; [PSR] "SysSOC(%) 93.9"; [MV] |
| 25 | u8 | MOSFET state (`mosState`) | bits | 0x03 while the tool shows ChgMOS ON, DisChgMOS ON, PreChgMOS OFF, HeatMOS OFF: bits 0 and 1 are the charge and discharge MOSFETs, which is which is not proven; bits 2 and 3 presumably precharge and heater (**unverified**) | [SX] `mos_status_byte`; [PSR] |
| 26 | u8 | battery type (`batteryType`) | code, 9.6 | 3 = "EVE 100Ah" in the tool list; 27 on the LVESS15 pack (not in any list) | [SX] `battery_type`; [PSR] "BatteryType 3"; [UC] `config.txt` |
| 27 | u8 | life counter (`life`) | 0..255 | increments by one from one 0x01 answer to the next (0xF2..0xF8 at 0.34 to 0.38 s intervals in [PSR]); the tool shows it as "Life: 248". Whether it counts answers or time is unknown | [SX] `bms_life`; [PSR] |
| 28 | u8 | number of cell temperature sensors (`tempCount`) | 1 | 6 | [SX] `system_temperature_points`; [PSR] Temp1..Temp6 |
| 29 | u8 | number of cells (`cellCount`) | 1 | 16 | [SX] `system_voltage_points` |
| 30 | 16 | software version (`softwareVersion`) | ASCII, NUL padded | "LVESS0223526N03", "LVESS1525814B01"; [MV] calls it the serial number, the vendor tool labels it "SoftVersion" and it has the form of the firmware image names (section 12) | [SX] `software_version`; [PSR] "SoftVersion LVESS0223526N03" |
| 46 | 14 | hardware version (`hardwareVersion`) | ASCII, space padded | "LVESS02_V1", "LVESS15MOS" | [SX] `hardware_version`; [PSR] "HardVersion LVESS02_V1" |
| 60 | u8 | system status (`systemStatus`) | code | 1 while the tool shows "BMSStatus: Charge"; probably 0 standstill, 1 charge, 2 discharge as CAN 0x400 byte 0 (**unverified**) | [SX] `system_status`; [PSR] |
| 61 | u8 | current BMS board number | | 65 byte answers only | [SX] `current_bms_board_number` |
| 62 | u8 | PCS protocol type | code | values unknown | [SX] `pcs_protocol_type` |
| 63 | u8 | heating strategy | bits | | [SX] `heating_strategy` |
| 64 | u8 | buzzer setting | bits | | [SX] `buzzer_setting_byte` |

Power is not transmitted: power = `voltage` × `current`. Voltage and current are the system (bank) values; for a single pack they are the pack's. No remaining capacity in Ah is transmitted in any decoded answer (the tool has a "RemainCapacity(AH)" column, source byte unknown).

Current offset rule for drivers until a reference value of an LVESS15 pack exists: raw < 15000 → (raw − 3000) × 0.1 A; raw ≥ 15000 → (raw − 30000) × 0.1 A, the second case flagged as unverified in the device information. Both ranges cover ±1000 A and cannot overlap.

#### 6.1.2 0x02 alarm block (12 data bytes)

All twelve bytes are zero when the vendor tool shows "ProtectionExist: No" and an empty alarm list ([PSR] screenshot and every 0x02 answer of the log; [SX] HCI capture of an SE-F16-C). No source maps the bits. The vendor RS485 tool contains this alarm name table, in this order: SysErrLevel; OverChgCurr, OverDisChgCurr, OverChgTemp, OverDisChgTemp, ChgTempLow, DisChgTempLow, OverDiffVolt, OverDiffTemp, OverCellVolt, UnderCellVolt, OverMosTemp, OverHeatFilmTemp, SocLow, OverChgSumVolt, UnderDsgSumVolt; AFE-OV, AFE-UV, AFE-OCDL, AFE-SCD, AFE-OT, AFE-UT, AFE-OCC, AFE-SCDL, AFE-OCD1, AFE-OCD2; HostAddrRepeat, InternalCanCommFail, ExternalCanCommFail, AFECommFail, Rs485CommError, CellVoltSampErr, TempSampErr, CellVoltOpenWireErr, TempOpenWireErr, EEPROMErr, RTCErr, PreChgFailed, ChargeInversed, MosShortCircuit, ChgVoltLow, FuseBlown, HeatingMosVdhesionFault, HeatingAbnormalFault ([UM] strings at file offsets 0x5626B..0x5648A). A layout of one level byte plus bit fields in this order is plausible but not proven (**unverified**). Drivers report any non-zero byte as one driver specific alarm `deye.alarm_raw` (severity warning) with the twelve bytes in hex as `source`.

#### 6.1.3 0x03 temperatures (13 data bytes used, 21 sent)

21 data bytes in every RS485 answer ([PSR], [MV]). The app configuration of the SE-F16-C defines the message as 13 bytes ([SX] README "cell_temperature_message (13 bytes)", `expectedLength 13`), and no Bluetooth 0x03 answer was captured: the length over Bluetooth is **unverified**. Readers accept 13 or more data bytes.

| Offset | Size | Field (`expected` key) | Scale | Sources |
| --- | --- | --- | --- | --- |
| 0 | u8 | highest cell temperature (`maxTemp`) | raw − 40 °C | [SX]; [PSR] "MaxTemp 16" |
| 1 | u8 | its sensor number (`maxTempNo`), 1 based | | [SX]; [PSR] "MaxTempPos 6" |
| 2 | u8 | lowest cell temperature (`minTemp`) | raw − 40 °C | [SX]; [PSR] "MinTemp 16" |
| 3 | u8 | its sensor number (`minTempNo`) | | [SX]; [PSR] "MinTempPos 1" |
| 4 | u8 | difference (`tempDiff`) | 1 °C, no offset | [SX]; [PSR] "MaxDiffTemp 0"; [MV] 28 − 27 = 1 |
| 5 | 8 × u8 | cell temperatures (`temperatures`) | raw − 40 °C | [SX]; [PSR] Temp1..Temp6 = 16 |
| 13 | 8 | padding, zero (`padding` = number of padding bytes) | | [PSR], [MV] (data length 21) |

Use the first `tempCount` (0x01 offset 28) values; the unused slots read raw 0 = −40 °C. MOSFET, board and heater temperatures come from 0x01.

#### 6.1.4 0x04 cell voltages (72 data bytes)

72 data bytes on RS485 ([PSR], [MV]) and in the Bluetooth capture of an SE-F16-C (vector `ble-rx-04-encrypted`). The app configuration defines 40 bytes, header plus 16 cells ([SX] `expectedLength 40`, with the remark that real captures show a 72 byte buffer). Readers accept 40 or more data bytes with whole cell slots (8 + 2 × k) and read the slots present.

| Offset | Size | Field (`expected` key) | Scale | Sources |
| --- | --- | --- | --- | --- |
| 0 | u16 | highest cell voltage (`maxCell`) | 1 mV | [SX], [PSR] "MaxCellVolt 3.38" |
| 2 | u8 | its cell number (`maxCellNo`), 1 based | | [SX], [PSR] "MaxCellVoltPos 15" |
| 3 | u16 | lowest cell voltage (`minCell`) | 1 mV | [SX], [PSR] "MinCellVolt 3.376" |
| 5 | u8 | its cell number (`minCellNo`) | | [SX], [PSR] "MinCellVoltPos 8" |
| 6 | u16 | difference (`cellDiff`) | 1 mV | [SX], [PSR] "MaxDiffVolt 0.004" |
| 8 | 32 × u16 | cell voltages (`cellVoltages`, first 16 in the vectors; `cellSlots` = 32) | 1 mV | [SX] (16 used), [PSR], [MV] (32 slots, unused = 0); the [PSR] reader takes cell 1 at frame offset 13 |

Use the first `cellCount` (0x01 offset 29) values. The extremes are sampled separately from the array: in one of the 7 [PSR] answers the header says 3.376 V at cell 4 while the array of the same frame has 3.377 V at cell 4 (vector `rs485-rx-04-se-g51-2`). Derive the statistics from the array.

#### 6.1.5 0x05 (64 data bytes)

All zero in both captures ([PSR]; [MV] "Mostly zero / reserved in tested firmware"). Not decoded, not polled. The tool shows connector temperatures (ConnPosTemp, ConnNegTemp) of −40 °C, total charge and discharge Ah columns, and has a `Parse0x05Frm` routine ([UM], [PSR]); 0x05 may carry them (raw 0 = −40 °C), **unverified**.

### 6.2 PCS CAN frames (Deye native profile)

All values little-endian. Bank frames come from the master pack and cover the whole bank; per-pack frames come once per pack at base + pack − 1 ([V33], [VP]).

| Id | Bytes | Field (`expected` key) | Type, scale | Notes | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x351 | 0-1 | charge voltage limit (`chargeVoltageLimit`) | u16, 0.1 V | 58.4 V on firmware since 2007 (57.6 V before) | [V33], [PF] page 2 changelog, [VPC] |
| | 2-3 | charge current limit (`chargeCurrentLimit`) | s16, 0.1 A | [V33] says "off-grid"; the vendor CAN tool labels the column "Chg Cur Limit With Power Sys" (grid connected): conflict, **unverified**; equal to 0x371 in every capture | [V33], [UC] CSV header, [VPC] |
| | 4-5 | discharge current limit (`dischargeCurrentLimit`) | s16, 0.1 A | same remark | same |
| | 6-7 | discharge voltage limit (`dischargeVoltageLimit`) | u16, 0.1 V | 48.0 V | [V33], [VPC] |
| 0x355 | 0-1 | SOC (`soc`) | u16, 1 % | whole percent; 0x150 has 0.1 % | [V33], [VP] |
| | 2-3 | SOH (`soh`) | u16, 1 % | | [V33] |
| | 4-7 | not used | | zero (Victron defines 4-5 as SOC in 0.01 %; Deye sends 0) | [VP] `_decode_355` |
| 0x356 | 0-1 | bank voltage (`voltage`) | s16, 0.01 V | | [V33] |
| | 2-3 | bank current (`currentWire`) | s16, 0.1 A | discharge positive in the Deye native profile; ubms `current` = −`currentWire` | [V33] revision table, [VPC] |
| | 4-5 | average cell temperature (`temperature`) | s16, 0.1 °C | | [V33] |
| 0x358 | 0-1 | USB board real time power | u16, 0.1 W | only with the optional USB board | [V33] (**unverified**, never captured) |
| | 2-5 | USB board energy | u32, 0.1 Wh | | [V33] |
| | 6 | USB board switch | 0 disabled, 1 enabled | | [V33] |
| 0x359 | 0-6 | bank fault tables 1..7 (`tables`) | bits, 9.1 | presumably the union of the packs (**unverified** for a fault on a slave pack, [VP] notes "Not yet seen") | [V33] |
| | 7 | not used | | | [V33] "Not Enabled" |
| 0x35C | 0 | request flags (`flags`) | bits, 9.2 | | [V33], [PS], [VP] |
| 0x35E | 0-1 | manufacturer "DY" (`manufacturer`) | ASCII | Deye | [V33] "Manufacturer Name (same as DY above) DEYE", [VPC] |
| | 2-4 | pack number (`packNumber`) | ASCII | "001" | [V33], [VP] notes |
| | 5 | battery (cell) type (`batteryType`) | code, 9.6 | 28 on an SE-F12-C | [V33], [VPC] |
| | 6-7 | nominal capacity of the bank (`capacity`) | u16, 0.1 Ah | 230.0 Ah (one SE-F12-C), 200.0 Ah (two 100 Ah packs) | [V33], [VP] |
| 0x361 | 0-1, 2-3 | highest / lowest cell voltage of the bank (`maxCell`, `minCell`) | u16, 1 mV | no cell numbers on CAN | [V33], [VP] |
| | 4-5, 6-7 | highest / lowest cell temperature (`maxTemp`, `minTemp`) | s16, 0.1 °C | | [V33] |
| 0x363 | 0-1 | software version of the master (`softwareMarker`) | 2 bytes, shown as hex digits | `F0 02` = "F002", the suffix of the firmware image name (`..._F005` after an update) | [V33], [VP] notes "Firmware marker" |
| | 2-3 | hardware version (`hardwareMarker`) | 2 bytes | equal to bytes 0-1 in every capture | [V33], [VPC] |
| 0x364 | 0 | packs in normal operation (`packsNormal`) | u8 | | [V33] |
| | 1 | packs with charge prohibited (`packsChargeDisabled`) | u8 | | [V33] |
| | 2 | packs with discharge prohibited (`packsDischargeDisabled`) | u8 | | [V33] |
| | 3 | packs with communication lost (`packsCommLost`) | u8 | | [V33] |
| | 4 | packs connected in parallel (`packsParallel`) | u8 | | [V33] |
| 0x371 | 0-1 | grid state charge current limit (`gridChargeCurrentLimit`) | s16, 0.1 A | | [V33] |
| | 2-3 | grid state discharge current limit (`gridDischargeCurrentLimit`) | s16, 0.1 A | | [V33] |
| 0x110 + n | 0-6 | pack fault tables 1..7 (`tables`) | bits, 9.1 | | [V33], [VP] (vendor app cross-check) |
| | 7 | MOSFET and parallel flags (`mosFlags`) | bits, 9.3 | | [V33], [VP] |
| 0x150 + n | 0-1 | pack voltage (`voltage`) | u16, 0.1 V | | [V33], [VP] |
| | 2-3 | pack current (`currentWire`) | s16, 0.1 A | discharge positive in every profile | [V33], [VPC] |
| | 4-5 | pack SOC (`soc`) | u16, 0.1 % | vendor app 95.6 vs 95.4 a moment apart | [V33], [VP] |
| | 6-7 | pack SOH (`soh`) | u16, 0.1 % | | [V33] |
| 0x200 + n | 0-1, 2-3 | pack highest / lowest cell voltage (`maxCell`, `minCell`) | u16, 1 mV | | [V33] |
| | 4-5, 6-7 | pack highest / lowest temperature (`maxTemp`, `minTemp`) | s16, 0.1 °C | vendor app 24 / 23 °C confirmed | [V33], [VP] |
| 0x250 + n | 0-1 | highest MOSFET temperature (`mosTemp`) | s16, 0.1 °C | | [V33] |
| | 2-3 | heating film temperature (`heaterTemp`) | s16, 0.1 °C | −40.0 = no sensor | [V33], [VP] |
| | 4-5 | pack allowable charge current (`maxChargeCurrent`) | u16, **1 A** | | [V33] revision table ("Add the last 32 bits of 0x250 as the maximum allowable charging current ...") |
| | 6-7 | pack allowable discharge current (`maxDischargeCurrent`) | u16, 1 A | | [V33] |
| 0x400 + n | 0 | operation mode (`mode`) | 0 standstill, 1 charge, 2 discharge | vendor app "Standby" for 0 | [V33], [VP] |
| | 1 | fault level (`faultLevel`) | 0 none, 1 minor, 2 major | | [V33] |
| | 2-3 | cycles (`cycles`) | u16 | | [V33] |
| | 4-5 | balancing cells 1..16 (`balancing`) | bit 0 = cell 1 | | [V33] |
| | 6-7 | sub-state (`subState`) | code | not enumerated; 0x03, 0x08, 0x0F, 0x10, 0x11, 0x12 seen | [V33] ("system sub-state and reserve 8 bits"), [VP] notes |
| 0x500 + n | 0-1 | software version (`firmwareMarker`) | hex digits | "F002", "F005" | [V33], [VP] |
| | 2 | separator 0xAA (`marker`) | | | [V33] |
| | 3-7 | boot version (`bootVersion`) | ASCII | "V1.0F" | [V33] revision table ("report the Boot version information instead"), [VPC] |
| 0x550 + n | 0-3, 4-7 | accumulated charged / discharged energy (`chargedEnergy`, `dischargedEnergy`) | u32, 0.001 kWh | vendor app "Total Charge AH 120.90Ah" = 6.190 kWh / 51.2 V | [V33], [VP] notes |
| 0x600 + n | 0-7 | serial number characters 1..8 (`serialPart`) | ASCII | | [V33] |
| 0x650 + n | 0-7 | serial number characters 9..16 | ASCII | | [V33] |
| 0x700 + n | 0-7 | overcharge, over-discharge, short circuit, MOSFET over temperature counts | 4 × u16 | | [V33], [PS] |
| 0x750 + n | 0-7 | charge overcurrent, discharge overcurrent, charge over temperature, discharge over temperature counts | 4 × u16 | | [V33], [PS] |

Bank limits in a parallel bank: 0x351 discharge = sum of the packs' 0x250 discharge values; 0x351 charge = sum over the packs whose charge MOSFET is closed (two pack capture, [VP] notes "Per-pack frames in a parallel bank").

### 6.3 victronCAN profile differences

Selected in the battery (app setting); [VPC] contains both profiles on one SE-F12-C ([VP] README "The newer firmware adds CAN protocol selection").

| Item | Deye native | victronCAN | Sources |
| --- | --- | --- | --- |
| 0x356 current sign | discharge positive | charge positive | [VP], vectors `can-356-charge-native`, `can-356-charge-victron` |
| 0x35E | "DY" + "001" + type + capacity | "PYLON" + type + capacity | [VPC] |
| 0x35F | absent | byte 1 type, 2-3 firmware marker, 4-5 capacity in 0.1 Ah (Victron defines 1 Ah), 6-7 "DY" | [VPC], [VP] `_decode_35f` |
| 0x35A | absent | Victron alarm frame, all zero = every field "not supported" | [VP] README |
| 0x359, 0x35C, 0x361, 0x363, 0x364, 0x371 | sent | not sent | [VP] README |
| Per-pack frames 0x110..0x750 | sent | still sent | [VPC] |

### 6.4 InterCAN (reference, not implemented)

29-bit identifiers at 250 kbit/s on the IN / OUT ports, big-endian data ([PS] lambdas `(x[0] << 8) | x[1]`). Pack p (1 based, last byte of the id) sends `0x020980pp`: highest cell mV (0-1), its number (2), lowest cell mV (3-4), its number (5); `0x040080pp`..`0x040380pp`: cells 1-4, 5-8, 9-12, 13-16 as u16 mV ([PS] `deye-can-bus.yaml`). These cell frames appear only after the frame `0x18A2FF80` with data `01` (the vendor tool sends it every second; [PF] page 4, [PS] issue 3). According to the user made table in [PS] (`InterCAN parameters address table.xlsx`), the PC tool (source address 0x80) reads a parameter of pack pp with `0x18F1pp80` (1 byte: parameter id; answer `0x18F180pp`, 8 bytes: id and the value as u32 big-endian in bytes 1..4, e.g. `01 00 00 0E 24 00 00 00` = cell overvoltage level 1, 3620 mV) and writes with `0x18F0pp80` (5 bytes: id and u32 big-endian value, example `D5 00 00 0D 48` = balance start voltage 3400 mV; answer `0x18F080pp` `D5 01 00 ...`); the table lists about 100 protection thresholds plus SOC (id 0xCA), SOH (0xCB), cycle count (0xC9) and battery type (0xD7); a user set SOC and battery type of a pack this way ([PS] issue 7). Writing parameters voids the warranty according to Deye ([UC] README). ubms does not implement InterCAN: the cell frames need a transmitted wake frame and the bus carries write services.

### 6.5 High voltage systems (reference, not implemented)

A BOS-G control box (BMU "HVMU0225...") sends Pylontech high voltage style frames with 29-bit identifiers on the PCS bus at 500 kbit/s: 0x4210 (voltage 0.1 V, current (raw − 30000) × 0.1 A, temperature (raw − 1000) × 0.1 °C, SOC, SOH), 0x4220 (cut-off voltages, current limits), 0x4230 and 0x4240 (cell extremes with numbers), 0x4250 (status, alarms, protections), 0x4260, 0x4270, 0x4280, 0x4290, 0x42E0 (serial number), 0x42F0 (manufacturer), 0x7310 (versions), 0x7320 (module counts) ([PS] `hv-bms.yaml`, contributed by a user in issue 11). Whether these frames come without the inverter requests of the Pylontech high voltage protocol is unknown, and no capture with bytes is published; not implemented. No source documents the RS485 protocol of the high voltage boxes.

## 7. Settings

No setting is readable or writable through a documented interface:

- AA 55 (RS485, BLE): reads 0x01..0x05 only. The vendor RS485 tool writes parameters with command 0x60; its frame is unknown ([UM]).
- PCS CAN: broadcast only.
- InterCAN: a parameter service exists (6.4), documented only by users; writing voids the warranty ([UC] README, [PF] page 2 "changing any alarm and protection settings voids the warranty").

Recommended ubms schema: `capabilities.settings = false`, `writeSettings = false`. The limits the BMS reports (charge voltage limit, current limits, discharge voltage limit) are shown as read-only extras, not as settings.

## 8. Controls and actions

None. The vendor tools can shut the pack down, put it into deep sleep, clear a MOSFET adhesion fault, erase flash records and upgrade firmware ([UM] strings, [PSR] screenshot), but the commands are not documented and are not implemented. The MOSFET state is reported read-only (AA 55 0x01 offset 25, CAN 0x110 + n byte 7).

## 9. Bits and enumerations

### 9.1 CAN fault tables (0x359 bytes 0..6 for the bank, 0x110 + n bytes 0..6 per pack)

Bit = 1: active ([V33] "Each bit represents a fault, 1 means there is a fault"). Tables 1 to 3 are protections, table 4 failures, tables 5 and 6 alarms (warnings) of the quantities of tables 1 and 2, table 7 system errors ([V33] names "protection" vs "alarm"; [AS] PCSCAN sheet levels 2 and 1). Bit order from [V33] (raw text extraction), cross-checked with [VP] `FAULT_TABLE_BITS` and [AS].

| Table (byte) | Bit | [V33] name | ubms alarm | Severity |
| --- | --- | --- | --- | --- |
| 1 (0) | 0 | cell overvoltage protection | `cell_overvoltage` | protection |
| 1 | 1 | cell undervoltage protection | `cell_undervoltage` | protection |
| 1 | 2 | module (total) overvoltage | `pack_overvoltage` | protection |
| 1 | 3 | module (total) undervoltage | `pack_undervoltage` | protection |
| 1 | 4 | charge overcurrent | `charge_overcurrent` | protection |
| 1 | 5 | discharge overcurrent | `discharge_overcurrent` | protection |
| 1 | 6 | cell over temperature (charge) | `charge_overtemperature` | protection |
| 1 | 7 | cell under temperature (charge) | `charge_undertemperature` | protection |
| 2 (1) | 0 | cell over temperature (discharge) | `discharge_overtemperature` | protection |
| 2 | 1 | cell under temperature (discharge) | `discharge_undertemperature` | protection |
| 2 | 2 | cell voltage difference | `cell_voltage_difference` | protection |
| 2 | 3 | cell temperature difference | `temperature_difference` | protection |
| 2 | 4 | MOSFET over temperature | `mos_overtemperature` | protection |
| 2 | 5 | heating film over temperature | `deye.heater_overtemperature` (driver specific) | protection |
| 2 | 6 | AFE-OCD1 (hardware discharge overcurrent level 1) | `discharge_overcurrent` (source AFE-OCD1) | protection |
| 2 | 7 | AFE-OCD2 | `discharge_overcurrent` (source AFE-OCD2) | protection |
| 3 (2) | 0 | AFE-UV | `cell_undervoltage` (source AFE) | protection |
| 3 | 1 | AFE-OV | `cell_overvoltage` (source AFE) | protection |
| 3 | 2 | AFE-OCDL / OCD1 / OCD2 (latched) | `discharge_overcurrent` | protection |
| 3 | 3 | AFE-OCC (charge overcurrent) | `charge_overcurrent` | protection |
| 3 | 4 | AFE-SCD (short circuit in discharge) | `short_circuit` | protection |
| 3 | 5 | AFE-UT | `afe_fault` (source AFE under temperature) | fault |
| 3 | 6 | AFE-OT | `afe_fault` (source AFE over temperature) | fault |
| 3 | 7 | AFE-SCDL (latched short circuit) | `short_circuit` | protection |
| 4 (3) | 0 | AFE communication failure | `afe_fault` | fault |
| 4 | 1 | cell voltage sampling failure | `voltage_sensor_fault` | fault |
| 4 | 2 | temperature sampling failure | `temperature_sensor_fault` | fault |
| 4 | 3 | MOSFET short circuit | `deye.mosfet_short` (driver specific) | fault |
| 4 | 4 | EEPROM error | `eeprom_fault` | fault |
| 4 | 5 | internal communication failure | `communication_fault` | fault |
| 4 | 6 | PCS communication failure | `deye.pcs_communication` (driver specific; expected without an inverter, 4.3) | warning |
| 4 | 7 | duplicate master address | `deye.duplicate_address` (driver specific) | fault |
| 5 (4) | 0..7 | alarms of table 1 bits 0..7 (cell high / low voltage, module high / low voltage, charge / discharge high current, cell high / low temperature while charging) | same ids as table 1 | warning |
| 6 (5) | 0..5 | alarms of table 2 bits 0..5 (discharge high / low temperature, voltage and temperature difference, MOSFET and heating film high temperature) | same ids as table 2 | warning |
| 6 | 6 | heating MOSFET adhesion (stuck closed) | `heater_fault` | fault |
| 6 | 7 | heating abnormal | `heater_fault` | fault |
| 7 (6) | 0 | connector over temperature | `deye.connector_overtemperature` (driver specific) | protection |
| 7 | 1 | precharge failed | `precharge_fault` | fault |
| 7 | 2 | charge reversed (reverse charging) | `deye.reverse_charge` (driver specific) | fault |
| 7 | 3 | terminal over temperature | `deye.terminal_overtemperature` (driver specific) | protection |
| 7 | 4 | fuse blown | `deye.fuse_blown` (driver specific) | fault |
| 7 | 5 | voltage sense wire open | `cell_wire_open` | fault |
| 7 | 6 | temperature sensor wire open | `temperature_sensor_fault` | fault |
| 7 | 7 | charging voltage too low | `deye.charge_voltage_low` (driver specific) | warning |

[PS] reads `master_address_repeat` from table 4 bit 3 (`x[3] & 0x08`, the same bit as MOSFET short circuit); [V33], [VP] and [AS] put it at bit 7. Follow [V33]. The ubms mapping in the last two columns is this research's proposal, not a Deye statement.

### 9.2 0x35C request flags (byte 0)

| Bit | Meaning | Sources |
| --- | --- | --- |
| 7 | charge enable | [V33], [PS], [VP] |
| 6 | discharge enable | same |
| 5 | request force charge I (SOC below 20 %, cleared above 23 %; the inverter may let the pack shut down and wake it to charge) | [V33] notes |
| 4 | request force charge II (the inverter charges before shutdown; Deye recommends this one) | [V33] notes |
| 3 | request full charge (set when SOC was not above 97 % for 30 days) | [V33] notes |
| 0 | request heating ("banned") | [V33], [VP], [AS] (the translated table is garbled between bits 2..0, **unverified** position) |

[VP] advises not to use bits 7 and 6 alone as permission ("Do not use alone as charge permission").

### 9.3 0x110 + n byte 7 (MOSFET and parallel state)

Bit 0 parallel finished (1 yes); bit 4 charge MOSFET, bit 5 discharge MOSFET, bit 6 precharge MOSFET, bit 7 heater MOSFET (1 = closed, conducting) ([V33]; vendor app cross-check of 0x21 in [VP] notes: discharge closed, charge open, parallel 1). Bits 1..3 are unassigned; the app shows a fifth "Current Limit MOS" whose bit is unknown ([VP] notes).

### 9.4 0x400 + n

Byte 0 mode: 0 standstill, 1 charge, 2 discharge. Byte 1 fault level: 0 none, 1 minor, 2 major ([V33]). Bytes 6-7 sub-state: no source enumerates it ([VP] notes "Open: 0x400 system status enumeration").

### 9.5 AA 55 bit bytes

| Byte | Values seen | Meaning |
| --- | --- | --- |
| 0x01 offset 11 | 0x00 | unknown (load and charger detection are candidates) |
| 0x01 offset 16 | 0x00 = no heating need | bit meanings unknown |
| 0x01 offset 17 | 0x00 = no full or force charge request; 0x01 seen | bit meanings unknown |
| 0x01 offset 25 | 0x03 = charge and discharge MOSFETs on | bits 0 and 1 charge and discharge (order unknown); 2 and 3 presumably precharge and heater |
| 0x01 offset 60 | 0x01 = charge | probably the mode of CAN 0x400 byte 0 |

### 9.6 Battery (cell) type code (AA 55 0x01 offset 26, CAN 0x35E byte 5)

| Code | Cells | Sources |
| --- | --- | --- |
| 0 | undefined (charge and discharge limits stay 0 A until set, [PS] issue 7); ubms shows "Not set" | [UC] `config.txt` |
| 1 | GOTION 96 Ah | [UC], [V33] ("1. GOTION"), [PS] |
| 2 | CATL 100 Ah | [UC], [V33], [PS] |
| 3 | EVE 100 Ah | [UC], [V33], [PS], [PSR] (SE-G5.1 Pro) |
| 4 | PH 100 Ah | [UC], [PS] |
| 5 | EVE 120 Ah | [UC], [PS] |
| 6 | PH 100 Ah (214R) | [UC], [PS] |
| 7 | ZENERGY 104 Ah | [UC], [PS] |
| 27, 28 | not listed (LVESS15 pack on RS485, SE-F12-C on CAN) | [MV], [VPC]; show the raw code |

## 10. Device information

| Item | RS485 / BLE | CAN | Model field |
| --- | --- | --- | --- |
| vendor | "Deye" (constant) | "Deye" (0x35E "DY") | `vendor` |
| model | not transmitted; the hardware version (`LVESS02_V1`) is the best available label | not transmitted | `model`: hardware version where known, else empty |
| software version | 0x01 offset 30 (`LVESS0223526N03`) | 0x500 + n bytes 0-1 as hex digits ("F005") and boot version bytes 3-7 ("V1.0F") | `softwareVersion` |
| hardware version | 0x01 offset 46 | 0x363 bytes 2-3 | `hardwareVersion` |
| serial number | BLE: advertised name without "BAT" ([SX]); RS485: none | 0x600 + n and 0x650 + n, 16 ASCII characters ([V33]); wait for both halves ([VP] README) | `serialNumber` |
| protocol | the definition label: "Deye LVESS (RS485)" / "Deye LVESS (Bluetooth)" | the definition label "Deye PCS CAN (USB-CAN adapter)"; the profile is not part of it | `protocol` |
| extra | `batteryType` (code and name, 9.6), `cellCount`, `tempCount`, `currentEncoding` (offset in use), `pcsProtocol` when sent | `bootVersion`, `batteryType`, `capacity` (nominal, 0x35E or 0x35F), `packNumber`, `profile` ("Deye native" or "victronCAN (Pylontech identity)"), `packCount` (the number of packs seen on the per-pack identifiers, shown when more than one) | `extra` |

Trim NUL and trailing spaces from every string. The CAN serial number is a private identifier; [VP] keeps it out of shared output ("Sensitive local-only identifier; redact from shared output").

## 11. Detection

### 11.1 BLE scan

| Definition | Profile | Name | Sources |
| --- | --- | --- | --- |
| `deye-ble` | service 0xFFF1, notify and write on 0xFFF2 (write without response) | prefix `BAT`; ranking pattern `/^BAT[0-9A-Z]{6,24}$/` (length of real serial numbers **unverified**, the published names are anonymized) | [SX] |

`BAT` is a generic prefix; the service 0xFFF1 decides. No other family in ubms uses a service 0xFFF1: Seplos V3, Daly and JBD use the service FFF0 (with characteristics FFF1 and FFF2), Atorch, JK, ANT and NEEY use FFE0 ([SEP] 2.1, [atorch.md](atorch.md) 2.1). Whether the battery advertises 0xFFF1 is not documented: request it in `optionalServices` instead of filtering on it (**unverified**).

### 11.2 Probes (read only)

A probe may only send AA 55 commands 0x01, 0x03, 0x04 and 0x02, the three handshake messages, and SLCAN adapter commands (`C`, `S6`, `L`, `O`, `V`). Never 0x05 or any other AA 55 command, never a CAN frame.

`deye-rs485` (9600 8N1):

1. Send `AA 55 01 01 00 00 20 0D 0A`. Accept an answer with header, address 0x01, command 0x01, n = 61 or 65, valid CRC and CR LF, `cellCount` 1..32, `tempCount` ≤ 8, `voltage` 5..70 V, `soc` ≤ 100.0 % and printable software and hardware versions. Software version starting with "LVESS": confidence 0.95; other printable text: 0.8.
2. Optionally send 0x04 and check the first `cellCount` cells for 1.0..5.0 V.
3. Foreign devices stay silent: Seplos V2 and Pylontech packs wait for `~` ([SEP] 11.3); Modbus devices (Seplos V3, JK-PB, Daly D2, JBD UP) see address 0xAA, which none of them uses; JBD waits for 0xDD, Daly classic for 0xA5. A foreign answer would still have to pass the AA 55 length and CRC rule; a NEEY request (`AA 55 11 01 ...`) does not.

`deye-ble`:

1. Enable notifications on 0xFFF2 and write `random` with a fresh random string. Accept a 26 byte `cipher` notification with a valid trailer whose block equals AES-128-CBC(key, IV, randomStr): confidence 0.9 (only a Deye "neptune" BMS computes it).
2. Write `result`, then the encrypted 0x01 request; a decrypted 0x01 answer that passes the RS485 checks: 0.98.

`deye-can` (SLCAN adapter, explicit selection only, 11.4):

1. Send `C`, `S6`, `L` (each acknowledged with CR). BEL means the adapter refused: report "not an SLCAN adapter or wrong state" and stop sending. Exception: the answer to `C` (CR, BEL or none) is ignored, because the Lawicel command set accepts `C` only on an open channel and answers BEL otherwise (general SLCAN behaviour, not a Deye source; the reply of clones is **unverified**), so only the answers to `S6` and `L` decide. An adapter that answers BEL to `L` (no listen only mode; clones vary, **unverified**) is opened with `O` instead. When the open command times out, the adapter state is unknown: send a best effort `C`.
2. Listen up to 3 s (three bank cycles, 4.3). When no frame at all arrived in the first 1.5 s (no other node acknowledges), send `C` and `O` and listen for the rest of the window in normal mode (4.3).
3. Accept with confidence 0.95 when 0x35E starts with "DY" or 0x35F ends with "DY", and at least one of 0x351, 0x355, 0x356 passes its range checks.
4. Accept with confidence 0.6 when 0x351, 0x355 and 0x356 pass their range checks and per-pack frames 0x110 or 0x150 (Deye specific identifiers) are seen, but no 0x35E arrived yet.
5. Reject: no frames (wrong bit rate, wrong pins, battery off; the InterCAN pins run at 250 kbit/s and show nothing at `S6`); a Pylontech or other battery (0x35E text other than "DY" without 0x35F "DY", with or without 0x110 / 0x150 frames: step 4 applies only while no 0x35E arrived); only 29-bit frames (a high voltage control box, 6.5, or another bus). A Pylontech identity alone does not select the victronCAN profile: only 0x35F ending in "DY" does. The probe never transmits a CAN frame, and the adapter channel is closed (`C`) whenever the driver lets go of it.

### 11.3 Deye, Pylontech and Seplos on RS485

- A Deye pack does not use the `~` framing for its data; the only `~` observation is an empty answer (RTN 0x00, LENID 0) to a 0x42 request ([MV], vector `pylon-rx-empty-adr02`). The Seplos V2 probe rejects such a pack: its 0x51 check requires LENID 64 and a 0x42 answer must have the telemetry layout ([SEP] 11.2). How a Deye pack answers a 0x51 (manufacturer information) request is not documented by any source (**unverified**); an answer, if any, would not carry the Seplos device names `1101-...`.
- A Seplos or Pylontech pack never answers the AA 55 probe; it waits for `~`.
- The probes of all families are reads; the order affects only the detection time.

### 11.4 Registration order

Current order: JK, NEEY, ANT, JBD, Daly balancer, Daly, JBD UP, Seplos (`seplos-v3`, `seplos-v2-ble`, `seplos-v2`), Atorch.

- `deye-ble`: its service 0xFFF1 is unique among the families, so the position only matters for ties; put it after the Seplos definitions and before Atorch (Atorch stays last so that its listen window does not delay the write probes).
- `deye-rs485`: before the Seplos definitions on serial, right after `jbd-up-rs485`. Its probe is one 9 byte request at 9600 answered within about 80 ms and ignored by both Seplos generations and by Pylontech packs; after Seplos, a Deye pack would first cost the three Seplos trials (19200 Modbus, 19200 ASCII, 9600 ASCII, where it may answer the `~` request with an empty frame that Seplos then rejects).
- Resulting array: `[...jk, ...neey, ...ant, jbd, ...dalyBalancer, ...daly, jbdUpRs485, deyeRs485, ...seplos, deyeBle, ...atorch]`, with `deyeCan` registered but excluded from automatic detection.
- `deye-can` must not take part in automatic serial detection. Its probe writes SLCAN commands, which an RS485 BMS would receive as noise, and the binary probes of the other families, sent into an SLCAN adapter, could contain bytes that the adapter executes (`O` CR opens the channel, a following `t...` line transmits a CAN frame onto the battery bus). Offer it only when the user selects "Deye (CAN, USB-CAN adapter)" explicitly: the definition carries `links.serial.autoDetect: false`, which keeps it out of automatic and family wide serial detection in bms-core. Serial profile: 115200 8N1 (ignored by USB CDC adapters such as the CANable; 115200 is the usual default of serial SLCAN adapters, general practice, **unverified** for clones).

## 12. Pitfalls and quirks

- **Current encoding of the 0x01 answer differs between BMS generations.** Offset 3000 on LVESS02 (proven with the vendor tool), raw 30240 on LVESS15 (offset 30000 presumed, **unverified**); [SX] gives no offset. Reject values outside ±1000 A instead of showing them.
- **Software version is not the serial number.** [MV] labels `LVESS1525814B01` as "Battery Serial Number"; the vendor tool shows the same field as "SoftVersion", and the text has the form of the firmware image names (`LVESS1526701N01_F005`, [VP]).
- **Cell extremes vs cell array.** The 0x04 header and the array are sampled separately (6.1.4); compute statistics from the array.
- **Other "AA 55" protocols.** The CH340 USB-CAN analyzers frame CAN messages as `AA 55 01 01 01 <id> ...` on their serial port ([PSR] `Can bus analysis.txt`); NEEY balancer requests start with `AA 55 11 01`. Only the length and CRC rules of 3.1 identify a Deye frame.
- **CAN current sign depends on the profile** (6.3); 0x150 keeps the Deye sign. A driver that assumes one profile shows charge as discharge in the other ([VP] README).
- **SOC resolution.** 0x355 carries whole percent, 0x150 tenths ([VP] notes); prefer 0x150 for a single pack.
- **Firmware that clears bit 10 of the per-pack identifiers.** A two pack SE-F5 Pro-C bank with host software word 0x02E0 sent 0x400 as 0x000, 0x500 as 0x100, 0x550 as 0x150, 0x600 as 0x200, 0x650 as 0x250, 0x700 as 0x300 and 0x750 as 0x350, so pack 2's 0x751 arrived as an all-zero 0x351 every 5.35 s ([VP] notes, issues 6 and 7). Range checks alone do not cover larger banks: pack n's 0x750 + n − 1 lands on 0x350 + n − 1, which is a bank identifier for packs 2 (0x351), 6 (0x355), 7 (0x356), 9 (0x358), 10 (0x359), 11 (0x35A), 13 (0x35C), 15 (0x35E), 16 (0x35F), 18 (0x361), 20 (0x363) and 21 (0x364); packs 6..8 send 0x705..0x707 as 0x305..0x307, the inverter identifiers; packs 17..32 send 0x510.. as 0x110.., the fault frames of packs 1..16; and a 0x550 with small counters (0.5 kWh charged, 0.3 kWh discharged) reads as a plausible 0x150 (50 V, SOC 30 %, SOH 0). Zero counters on 0x355 read SOC 0 %, an over-current count of 2 on 0x359 reads as cell undervoltage protection. Handling ([VP] `id_layout.py`, extended where noted):
  - Prove the layout first: two frames whose payload only a shifted frame carries (a 0x500 shaped frame, `xx xx AA` + five printable characters, on 0x100..0x10F, or eight printable characters on 0x200..0x21F or 0x250..0x26F). A battery frame on a documented identifier at or above 0x400 proves the documented layout, and then nothing is remapped.
  - While the shift is proven, map back (+ 0x400): 0x000..0x01F; 0x100..0x11F with the 0x500 shape (0x110..0x11F: this research, for packs 17..32); 0x200..0x21F and 0x250..0x26F holding serial number text; 0x150..0x16F when the frame is no plausible summary (35..65 V, SOC ≤ 100 %, SOH 0.1..100 %) or continues the energy counters of the identifier (growth of at most 10 Wh plus 30 kW over the elapsed time, [VP]); 0x300..0x31F, but 0x305..0x307 only when the pack exists and the previous frame on the identifier is more than 2.5 s old (the inverter sends every second, the counters come every 5.3 s; this research); 0x350..0x36F where no bank frame uses the identifier ([VP] maps 0x350 and 0x352..0x354; the others up to pack 32 are this research).
  - A bank frame on 0x350 + n − 1 of an existing pack n (n ≥ 2) is accepted only when it agrees with the per-pack frames (this research): 0x351 by its range checks; 0x355 SOC within 5 % of the mean 0x150 SOC; 0x356 voltage within 2 V of the mean 0x150 voltage; 0x359 equal to the union of the 0x110 fault tables; 0x361 cell extremes within 0.05 V of those of the 0x200 frames; 0x35E only with the "DY" or "PYLON" identity, 0x35F only ending in "DY"; the others (0x358, 0x35A, 0x35C, 0x363, 0x364) only when the same payload arrived on the identifier at most 2.5 s earlier (a bank frame repeats every second, the counter frame every 5.3 s). Otherwise the frame is dropped; the bank SOC, SOH, voltage, current and cell extremes then derive from the per-pack frames. The 0x750 counters of these packs are lost (they are not shown).
  - Independent of the layout: 0x351 needs charge voltage 40..65 V and discharge voltage 35..60 V; 0x355 and 0x150 frames with SOH 0 are dropped (no capture has SOH 0, the zero counters have it); 0x356 and 0x150 voltages must be 35..65 V ([VP] decoder); a foreign 0x35E does not replace a Deye or Pylontech identity seen in the last 15 s.
- **Battery type codes beyond the published list** (27, 28); show the raw number.
- **−40 °C means "no sensor"** (heating film, connector, board temperature on some boards).
- **Straight-through patch cables destroy the BMS** when the other side carries supply voltages on its RJ45 (2.1, [VP]).
- **Listen only mode with a lone battery** gives no acknowledge and the adapter receives nothing; normal mode with the wrong bit rate disturbs the bus with error frames. Open listen only and switch to normal mode only when nothing arrives (4.3).
- **InterCAN cell frames need a wake frame** (6.4); without it a listener sees only a few frames, and firmware 2004 sends fewer InterCAN frames than 2007 and later ([PF] pages 2 and 4).
- **Charge voltage request 58.4 V** since firmware 2007 (57.6 V before) lets cells of an imbalanced pack reach 3.65 V and trip the cell overvoltage alarm ([PF] pages 1 and 2). Not a decoding problem, but users will see the alarm.
- **0x35A all zero means "not supported"**, not "no alarm" ([VP]).
- **0x35F capacity** uses 0.1 Ah although Victron's table says 1 Ah ([VP] `_decode_35f`).
- **BLE asymmetry**: requests are encrypted as lower case hex text, answers as bytes; the IV is sixteen ASCII "0"; the cipher answer is one block without padding; a wrong trailer makes the battery ignore the message silently ([SX]).
- **[PS] table 4 bit for "master address repeat"** is wrong in its decoder (9.1).
- **Unknown commands.** The vendor RS485 tool can shut down, deep-sleep, erase and reflash the BMS (5.1). Never send an AA 55 command other than 0x01..0x04 (0x05 is harmless in the captures but unexplained).
- **RS485 shares the PCS port with the inverter link.** Reading a pack while an inverter talks RS485 to it is not covered by any source; with the inverter on CAN, the RS485 pins are free ([PSR] setup).
- **0x351 grid / off-grid wording** conflicts between [V33] and the vendor tool (6.2); the values were identical to 0x371 in every capture.

## 13. References

All URLs as read on 2026-11-19; commits are the versions read.

| Tag | Source | Version used |
| --- | --- | --- |
| [V33] | Ningbo Deye ESS, "PCS-CANBUS Protocol" V3.3 (revision table 1.0 of 2021-09-28 to 3.3 of 2024-05-25; the title page says V3.2), machine translated from Chinese by onlinedoctranslator, file `PCS CAN-Bus-protocol-DY-low-voltage V3.3.zh-CN.en.pdf` in https://github.com/Psynosaur/esphome-deye-bms (identical copies in Psynosaur/MitM-Deye, Psynosaur/esphome-MitM-deye-jk-bms and asmcc/my48vdc `CAN/PCSCAN/`) | commit fdc38a3d132cb1054f04f9e952a854923a4b695c, MD5 0e8bcb1d662a3de8476aa9b111dcc5b2 |
| [VP] | https://github.com/vladyspavlov/dbus-deye-battery: `README.md`, `docs/protocol-notes.md`, `src/deye_virtual_battery/decoder.py`, `profile.py`, `id_layout.py`, `can_keepalive.py`, `tests/test_vendor_app_reference.py`, issues 1, 2, 6, 7 | commit 0981e2d01bfb1019acab65ac3d338ea56bfbaff4 |
| [VPC] | same repository, `tests/data/deye-se-f12c-sample-5min.log` (296 s, Deye native profile, firmware F002) and `deye-profile-switch-window.log` (firmware F005, both profiles); candump format, Victron MultiPlus-II GX on the bus | same commit |
| [PS] | https://github.com/Psynosaur/esphome-deye-bms: `deye-can-bus.yaml`, `hv-bms.yaml`, `InterCAN parameters address table.xlsx`, `README.md`, issues 3, 7, 9, 11 | commit fdc38a3d132cb1054f04f9e952a854923a4b695c |
| [PSR] | https://github.com/Psynosaur/Deye_Battery_Serial_BUS: `RS485/RS485 data.log` (2023-07-12, SE-G5.1 Pro), `RS485/Screenshot at time of data dump.jpg` (LVESS_UART_Monitor V1.09), `CAN2JSON/BackgroundServices/RS485BackgroundService.cs`, `CAN2JSON/CANInformation/Frame_IDs.md`, `Can bus analysis.txt`, `README.md` (setup photos, PCS pin table image) | commit c9386a76b32420306f6dc4f1af5f62124d960b0a |
| [MV] | https://github.com/Maavey/deye_battery_bms_rs485 `README.md` (LVESS15 pack, RS485 frames, Pylontech framed observation) | commit 01d5f1e76bc2c7b9869627cd8cffb3cf29a40274 |
| [SX] | https://github.com/SoCoxx/Deye-Battery-BLE: `README.md`, `scripts/deye_ble_protocol.py`, `deye_ble_protocol.js`, `deye_ble_client_example.js`, `verify_all_three.py`, `parse_frames.py` (decompiled Deye Cloud app, HCI captures of SE-F16-C packs; names anonymized and ciphertexts re-keyed by the author) | commit 9ff81a50acede99e2fb6634ce7a09bb5ea1900d8 |
| [UM] | Deye RS485 PC tool "LVESS_Monitor V1.07" (Qt, `LVESS_Monitor.exe` dated 2023-04-14), release asset `LVESS_485_Monitor.V1.07.7z` of https://github.com/Psynosaur/LVESS_485_Monitor (release-v1.07); read as strings only, not executed | release of 2024-06-26 |
| [UC] | Deye CAN PC tool "LowVoltageBmsUpperComputer" V1.18 (window title LVESS_Monitor), release asset `LowVoltageBmsUpperComputerV1.18.zip` of https://github.com/Psynosaur/Deye_LowVoltageBmsUpperComputer: `config.txt` (battery types), `kerneldlls/kerneldll.ini`, `setting/threshold.cfg`, headers of `RunData/*/pcsMasterRealTimeData.csv` and `realTimeData_Pack1.csv`, `logs.txt`; repository README (warranty remark); read only, not executed | release v1.18 of 2025-07-19 |
| [PF] | powerforum.co.za, "Deye SE-G5.1 Pro batteries", https://powerforum.co.za/topic/20233-deye-se-g51-pro-batteries/ pages 1 to 5 (ZS1SCI = Psynosaur, Peter Obermeier, ppwwdd, cristof and others) | read 2026-11-19 |
| [AS] | https://github.com/asmcc/my48vdc `README.md`, `CAN/PCSCAN/deye_pcscan.xlsx`, `datasheets/DEYE_User_Manual_RW-M6_1_Version_1_2_DE_EN.pdf` | commit 97e065b983b77c836aefd114e3ab525439434077 |
| [AD] | https://github.com/Adminius/esphome-yaml-collection `deye_rw-m6.1.yaml` | commit 29070e77082099574f3b8e06853a415f3072ae40 |
| [YB] | https://github.com/Sleeper85/esphome-yambms `packages/bms/bms_sensors_DEYE_CAN_top_full.yaml` and the other `*DEYE_CAN*` packages | commit f44738ce8fd66eb7c0f5f335fc46186fe4f93122 |
| [MAN-G51B] | Deye ESS User Manual SE-G5.1 Pro-B, AU, EN, V01, 2025-09-17, https://au.deyeinverter.com/deyeinverter/2026/01/14/Installationmanual-DeyeESSUserManualSE-G5.1Pro-BAUENV01_20250917.pdf (sections 2.2 and 2.4; the pin tables are images) | downloaded 2026-11-19 |
| [MAN-M61] | DEYE User Manual RW-M6.1, version 1.2 (DE and EN), copy in [AS] | as [AS] |
| [MAN-F5P] | Deye ESS User Manual SE-F5 Pro, issue 11, 2026-09-16, https://deyeess.com/wp-content/uploads/2025/12/Deye-ESS-User-Manual-SE-F5-Pro-EUENDE-V11_20260916.pdf | read 2026-11-19 |
| [MAN-BOSG] | Deye ESS User Manual BOS-G, AU, issue 01, 2025-09-29, https://deye.com/wp-content/uploads/2025/10/deye-ess-user-manual-bos-g-auen-v01-_20250929.pdf | read 2026-11-19 |
| [MAN-BOSGP] | Deye BOS-G-Pro installation and operation instructions, issue 04, 2025-05-24, https://media.deyeindia.com/documents/manuals/bos-g-pro-high-voltage-rack-mounted-battery-user-manual-78072ade.pdf | read 2026-11-19 |
| [MAN-GBA] | Deye ESS User Manual GB-A, issue 02, 2025-08-29, https://deye.com/wp-content/uploads/2025/11/deye-ess-user-manual-gb-a-jpnen-v02_20250829.pdf | read 2026-11-19 |
| [BRO] | Deye ESS Brochure Global 2026-09-21 (https://deyeess.com/wp-content/uploads/2026/09/Deye-ESS-Brochure_Global_20260921.pdf); SE-F series brochure 2026-02-02 v1.1; SE-G5.1 Pro-B series brochure 2026-09-07; BOS-G Pro brochure 2026-01-13; BOS-A NA brochure 2025-10-21 | read 2026-11-19 |
| [SEP] | [seplos.md](seplos.md) of this repository (sections 2.1, 3.1, 11) | this repository |

Read for cross-checks without own tags: Psynosaur/MitM-Deye and Psynosaur/esphome-MitM-deye-jk-bms (same PCS document, frame rewriting), Psynosaur/LVESS_485_Monitor README, Vidiborets0012/deye-battery-monitor (cloud API, no battery protocol), the GitHub code search for the RS485 request bytes (no further sources).

## 14. Implementation in ubms

Code: `packages/bms-drivers/src/deye/` (`protocol.js` AA 55 and Bluetooth session, `can.js` PCS CAN, `driver.js`, `simulator.js`), AES-128 and SHA-256 in `packages/bms-drivers/src/common/crypto.js`, the SLCAN codec in `packages/transport/src/slcan.js`. Tests: `packages/bms-drivers/test/deye.test.js`. Choices made where the sources leave room:

- **Read only.** `capabilities.settings` and `writeSettings` are false, there is no settings schema and no action (sections 7, 8). Limits and request flags are snapshot extras.
- **Polling (AA 55).** Every poll reads 0x01 (required, one repeat, 500 ms on RS485, 2.5 s over Bluetooth), then 0x03, 0x04 and 0x02 without repeat; a failed optional read keeps its last value for 15 s. RS485 waits 30 ms between requests. Poll interval 1 s on RS485, 2 s over Bluetooth (assumption, 4.2). Answers of 0x03 and 0x04 are accepted from 13 and 40 data bytes on (6.1.3, 6.1.4).
- **Bluetooth session renewal.** After two polls in a row whose 0x01 read timed out, the next poll first repeats the handshake (new random string, new key): the battery may drop its session while GATT stays connected (module reset, idle time, the Deye app connecting; not documented, 4.2), and then ignores every request encrypted with the old key. A refused handshake fails the poll with "no answer".
- **0x01 answers** must pass the detection checks of 11.2 on every poll, so a corrupted but CRC-valid answer is never shown. The current follows the offset rule of 6.1.1; values outside ±1000 A are dropped and shown as a raw extra.
- **MOSFET byte.** Charge and discharge switch states are shown only when bits 0 and 1 agree (both on or both off); otherwise only the raw byte (9.5).
- **0x02** non-zero gives one alarm `deye.alarm_raw` (warning) with the twelve bytes as source (6.1.2).
- **Nominal capacity (AA 55)** is inferred from the battery type code 1..7 (the cell named in 9.6, every pack 16S1P per 1.1): 96, 100, 100, 100, 120, 100, 104 Ah; other codes give none. No remaining capacity is shown (not transmitted, 6.1.1).
- **Bluetooth.** The key derives from the link name, which is the advertised name in Web Bluetooth and Tauri. A cipher block that does not match is logged and the probe fails (a name that differs from the advertised one gives the same symptom). The GATT profile has `chunkSize: 64`, so each message (at most 32 bytes from the host) is one write; this needs an ATT MTU of at least 35, which the browser and the OS negotiate (**unverified** per platform). Notifications are reassembled as in 3.2. The serial number is the advertised name without `BAT` when it matches `/^BAT[0-9A-Z]{6,24}$/`.
- **CAN.** The probe opens the adapter listen only (`C`, `S6`, `L`; `O` when the adapter refuses `L`); when nothing arrives in 1.5 s it reopens it in normal mode (`C`, `O`) for the rest of the 3 s window (4.3); it logs the mode in use, applies 11.2, and then waits until a burst ends (150 ms without a battery frame) so the first snapshot is complete. `poll()` builds the snapshot from the latest values (older than 15 s are dropped) and fails after 5 s without battery frames; in listen only mode it first switches to normal mode once (the inverter may have left). With one pack the snapshot uses the per-pack values (SOC in 0.1 %, MOSFET states, cycles, mode, energy counters); with several packs the bank frames, plus one summary extra per pack made of numbers and units only (voltage, current, SOC, cell voltage range, cell temperature range), so it needs no translation. Missing bank values of a bank derive from the per-pack frames (mean voltage, SOC and SOH, summed current, cell extremes). Every frame passes the range checks of `decodeCanFrame()`, and `DeyeCanState` undoes the shifted identifier layout and checks the colliding bank frames as described in 12 (`ShiftedIdLayout`). Alarms combine 0x359 and every 0x110 + n by alarm id (the most severe wins). `stop()` sends `C`, and so does `dispose()` when the channel is still open (the session can release a driver without `stop()`).
- **Detection order.** `deye-can` carries `links.serial.autoDetect: false` (11.4); `DriverRegistry.serialCandidates()` leaves such definitions out for 'auto' and family selections and offers them only for their own id.
