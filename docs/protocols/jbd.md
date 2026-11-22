# JBD (Jiabaida) BMS: communication protocols

Implementation reference for the ubms JBD drivers: the "DD A5" register protocol of the Jiabaida (JBD) smart BMS boards and of the many brands built on them (Xiaoxiang app, Overkill Solar, LLT Power, ECO-WORTHY, Liontron, Supervolt, SBL, Fogstar and others) over Bluetooth LE, UART and RS485; the "FF AA" commands of the newer Bluetooth modules (login with password); the V11 additions of the vendor document; and, for reference, the separate protocol of the JBD UP series rack BMS ("UP16S").

Compiled 2026-11-19 from two vendor documents, a reverse engineered register map, the source code, tests and issue logs of the open source projects listed in section 13, and Bluetooth captures that were decoded for this document. Every statement carries a source tag. **unverified** marks a value that has a single source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/jbd.json` (242 frames). Variants used in that file: `JBD` (all `DD ... 77` frames), `JBD_AUTH` (Bluetooth module frames `FF AA`), `JBD_UP` (UP series frames), `DAREN` (a JBD derived clone, section 1.2). Every `expected` object was produced by one reference decoder that implements this document, and the vectors were checked with a node script: framing (start byte, length byte, end byte 0x77), the 16-bit checksum of section 3.3 for `DD` frames, the 8-bit sum of section 3.6 for `FF AA` frames, CRC-16/MODBUS for UP frames, the password cipher of section 4.2 against the MAC address, random byte and password stated by the source, and, for 215 of the 242 frames, presence of the exact bytes (and of every BLE notification piece) in the cached copy of the cited source. The other 27 frames are constructed from the documented encodings (`source` says so) and are marked by their description; the latest of them, `daren-ble-rx-basic-16s-extended`, was added by the implementation review (section 6.2). The decoder also reproduced every value asserted by an earlier draft of the vector file, and the script found no duplicate frame (identical frames from two sources are one vector citing both). Keys of the `expected` objects (model units: V, A, Ah, °C, s, %):

- Requests (`direction` `tx`, `DD` frames): `operation` (`read` for 0xA5, `write` for 0x5A), `register`, `dataLength`, `data` (hex), `checksum` (u16), `checksumValid`, plus the meaning of a write: `factory` (`enter`, `exit`, `exitSave`), `mos` (`chargeOff`, `dischargeOff`), `control` (code name of section 8.3), `password`, `passwordChange`, `clearPassword`, `fa`, or the decoded register value as below.
- Answers (`rx`, `DD` frames): `register`, `status`, `dataLength`, `checksumValid`; for 0x03 `totalVoltage`, `current`, `currentRaw`, `remainingCapacity`, `nominalCapacity`, `cycleCount`, `productionDate` (ISO date, `null` when invalid), `productionDateRaw`, `balanceBits`, `balancingCells` (zero based), `protectionBits`, `alarms` (ids of section 9.1), `softwareVersion`, `softwareVersionRaw`, `soc`, `fetStatus`, `chargeMos`, `dischargeMos`, `heating`, `cellCount`, `ntcCount`, `temperatures`, `unit100mA` (section 6.2), `extension` (section 6.2) or `extraBytes`; for 0x04 `cellCount`, `cellVoltages`; for 0x05 `hardwareVersion`; for 0xAA `errorCounts`, `restartCount`; for registers 0x10..0xA2 `setting` (ubms id of section 7.2), `raw`, `rawSigned`, `value`, `unit`, `bits`, `enabledSensors`, `values` (byte pairs), `ti` (section 7.5), `scpRecoveryS`, `text`, `textLength`; for 0xFA `fa`.
- `FF AA` frames: `command`, `dataLength`, `data`, `checksum`, `checksumValid`, `result` (one byte answers), `cipher` (`mac`, `password`, `random` stated by the source).
- UP frames: `address`, `function`, `startAddress`, `endAddress`, `dataLength`, `crcValid`, `status` (section 6.10), `write`.
- `notifications`: the BLE notification pieces in arrival order where the capture shows a split. A stream vector (`jbdtool-uart-stream-cells-leading-noise`) carries `discardedBytes` and `frames`.

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

- Frame offsets count from the start byte 0xDD (or 0xFF of `FF AA`, or the address byte of UP frames). Data offsets (written `d[n]`) count from the first data byte, which is frame byte 4 of a `DD` frame. Decimal first, hex in parentheses where useful.
- Types: u8, u16, s16, u32. All multi-byte values of the `DD` protocol are big-endian ([V4] "high byte first", [V11] "all 16 bit data is big-endian"). UP frames are big-endian except the CRC, which is sent low byte first ([SY] `jbd_bms_up.cpp`, [DSB] `lltjbd_up16s.py`).
- Scale: physical value = raw × scale. Temperatures are sent in 0.1 K with offset 2731: °C = (raw − 2731) / 10 ([V4], [V11], [RM]).
- "Register" is the command code byte (byte 2 of a request, byte 1 of an answer). The vendor calls it "command code" or "register address" ([V4], [V11]).
- Current is positive while charging in the device and in the ubms model ([V4], [V11]).
- Source tags (details in section 13): [V4] Jiabaida "Smart BMS protocol V4" (vendor PDF, English and Chinese), [V11] "JBD comm protocol 20230321 V11" (vendor PDF, Chinese original, read in the Chinese text where the translation is garbled), [RM] JBD register map by Eric Poulsen with the Overkill Solar update, [BT] bms-tools (Eric Poulsen) source, [OK] Overkill Solar notes (BLE protocol, capacity registers), [SY] syssi/esphome-jbd-bms (code, tests, docs, issues), [SN] own decode of the btsnoop captures published in [SY] (section 13), [AIO] patman15/aiobmsble, [BH] patman15/BMS_BLE-HA issues, [DSB] mr-manuel/venus-os_dbus-serialbattery, [BM] fl4p/batmon-ha, [JT] sshoecraft/jbdtool, [SBU] NeariX67/SmartBMSUtility, [IEB] ieb/N2KNMEA0183Wifi `lib/jdbbms`, [TI] Texas Instruments bq76920/30/40 data sheet (background knowledge for section 7.5, not a cached source).

## 1. Overview

### 1.1 Devices and brands

| Line | Typical names and models | Protocol | Sources |
| --- | --- | --- | --- |
| JBD SP, DP, AP series "software boards" | JBD-SP04S034-L4S-200A-B-U, JBD-SP25S003-L16S-100A-100A-B, JBD-DP04S007L4S100A, JBD-AP21S001-L21S-200A-B, JBD-SP10S020-L8S-30A, SP24S004L12S200A | `DD A5` over UART, RS485 (some models) and BLE | [SY] README supported devices, docs/pdus; [AIO] test data; [BH] issue 872 |
| Rebranded packs with JBD boards | Overkill Solar, LLT Power, ECO-WORTHY (DP04S007, ECO-LFP48100), Liontron (LISMART, LT40AH), Supervolt (SX1, SX60), SBL, Titan, Nordström, Lossigy, OGRPHY, Chins, Fogstar Drift, Basen Green, CLRD, Vatrer, Epoch | same | [SY] README; [AIO] `matcher_dict_list`, test data; [OK] README |
| Bluetooth dongles and modules | advertise "xiaoxiang BMS" (older dongle, Xiaoxiang app), a model code ("DP04S007L4S100A", "SP17S005P17S120A") or a brand name | `DD A5`, transparent | [AIO] test data; [BH] issue 562 |
| Module generation of 2024 ("V1.3", 0x05 answers "SP04S034L4S200A") | as above | `DD A5` after an optional `FF AA` login (section 4.2) | [SY] issue 94, README, docs/ffaa-auth-flow; [SN] |
| UP series rack BMS | JBD-UP16S020, UP16S015 (ECO-WORTHY 48 V rack batteries) | separate UP protocol, function codes 0x78 / 0x79 over RS485 (section 3.7) | [SY] `jbd_bms_up`, `jbd_bms_up_pack`, docs/pdus/JBD-UP16S020-two-devices.txt; [DSB] `lltjbd_up16s.py` |
| Daren clone | names "DWF..." (Daren, Docan) | `DD A5` with a different 0x03 tail and extra commands 0x08, 0xFF | [AIO] `daren_bms.py`; [BH] issue 795 |
| JBD / LWS high voltage BMS | up to 200 cells | different frames (`A5 B5`, `A2 A3`), not covered | [BM] `jbd_hv_uart.py` |

The model code decodes as series, board number, cell count and current: "SP04S034-L4S-200A" is board SP04S034 configured for 4 cells (L4S) and 200 A ([SY] README list, **unverified** naming rule inferred from the examples).

### 1.2 Protocol layers

1. **Classic register protocol (V4)**: request `DD A5 reg 00 sum 77` (read) or `DD 5A reg len data sum 77` (write), answer `DD reg status len data sum 77`. Registers 0x03 (basic information), 0x04 (cell voltages), 0x05 (hardware version), 0xE1 (MOSFET control) are in the vendor document ([V4]); the EEPROM settings 0x10..0x47, 0xA0..0xA2, calibration and control registers come from the vendor PC tool and were mapped by [RM], [BT], [OK], [JT], [SBU], [DSB].
2. **V11 additions** of the same frame format ([V11] revision history V0..V11): status codes 0x81..0x83, protection counters 0xAA, MOSFET command 0xFB (replaces 0xE1 "in V1" of the document), parameter block mode 0xFA, control command 0x0A, password commands 0x06 / 0x07, chip type read 0x00, heater command 0xFC, internal resistance 0xF6 ("not added yet") and an extended 0x03 answer. Real devices answer 0xAA ([SN]); for 0x0A the only captured answer is a refusal (status 0x80, [JT]) besides the example of the document; no capture shows an answer to 0xFA, 0xFB, 0xFC or 0xF6 (sections 5.1, 12).
3. **Bluetooth module layer**: frames `FF AA cmd len data sum8` written to the same characteristic are handled by the module itself: rename (0x07, [OK]) and, on the newer modules, a login with app key, random byte, password and root password (section 4.2, [SY], [SN]). After the login the module forwards `DD` frames to the BMS.
4. **UP series protocol** (sections 3.7, 6.10): address, function 0x78 / 0x79, start and end address, 16-bit length, data, CRC-16/MODBUS. Not related to the `DD` protocol.

### 1.3 Coverage in ubms

- Driver `jbd` (`packages/bms-drivers/src/jbd/driver.js`): layers 1 to 3 over BLE (FF00, FFF0) and serial (UART TTL, RS485) at 9600 8N1. Monitoring (0x03, 0x04), device information (0x05, 0xAA, and 0xA0..0xA2 after a settings read), EEPROM settings in factory mode (section 7), MOSFET switches, balancer switch, the confirmed actions of section 8 and the FF AA module login with the password and device address the user enters (section 4.2). FA, FB, FC, F6, calibration and the module password change are documented here but not used (sections 5, 8.5).
- Implementation files: `protocol.js` (DD and FF AA frames, parsers, register map), `settings.js` (schema), `driver.js`, `up.js` and `up-driver.js` (UP series), `simulator.js` (DD protocol with factory mode, BMS password and module login; UP status block), tests in `packages/bms-drivers/test/jbd.test.js`.
- Driver `jbd-up-rs485` (optional, experimental): read-only monitoring of the UP series status block 0x1000 (section 6.10). Its sources are two independent implementations and a real capture of two packs; settings blocks and writes are **unverified** and not offered.
- Daren clones are accepted by `jbd` when their 0x03 answer passes the plausibility rules (section 11.2); the Daren specific tail is not decoded. With `variant` `DAREN` the driver only monitors: no source documents factory mode, the EEPROM map, 0xE1 or 0x0A on these clones ([AIO] `daren_bms.py` sends 0x03, 0x04, 0x05, 0x08 and 0xFF only; [BH] issue 795 shows reads only), so the driver reports no settings capability, its schema has no fields and settings, switches and actions are refused without sending a frame (section 11.4).

### 1.4 Telling variants apart

- Old against new Bluetooth module: the new module answers the app key `FF AA 15 ...` (section 4.2); the old one does not, and a password protected new module ignores `DD` requests until the login ([SY] `jbd_bms_ble.cpp` `update`, comment "A password protected BMS ignores all requests silently").
- V11 extended 0x03 answer: data length ≥ 23 + 2 × NTC count + 9 (section 6.2, [V11], [SN], [IEB], [BH] issues 536 and 872), with the copy of d4 at tail +5 (consistency rule of section 6.2).
- 100 mA / 100 mAh unit flag: section 6.2.
- UP series: answers only UP frames; detected by its own probe (section 11.5).

## 2. Physical links

### 2.1 Bluetooth LE

| Item | Value | Sources |
| --- | --- | --- |
| Service | `0000FF00-0000-1000-8000-00805F9B34FB` (0xFF00); also in the advertisement of every JBD record in [AIO] test data | [SY] `jbd_bms_ble/__init__.py` defaults, [AIO] `uuid_services`, [DSB] `lltjbd_ble.py`, [OK], [SBU] `BluetoothInterface.swift`, [SN] |
| Notify characteristic | 0xFF01, properties 0x12 (read, notify), value handle 0x0011 on the SP04S034 module | [SN] (ATT discovery of btsnoop_hci-balancer-onoff.log), [OK], [SY] |
| Write characteristic | 0xFF02, properties 0x06 (read, write without response), value handle 0x0015; older dongles advertise "write" instead of "write without response" | [SN], [OK] ("The older ones advertise READ and WRITE, the current versions READ and WRITE WITHOUT RESPONSE"), [SY] issue 245 (FF02 offers write without response only) |
| Alternative GATT layout | service 0xFFF0 with notify 0xFFF1 and write 0xFFF2 on the JBD-DH04SC02 | [SY] `esp32-ble-dh04sc02-example.yaml`, [DSB] `lltjbd_ble.py` (`_detect_uuids`, "DH04 and similar") (**unverified**, no capture) |
| Other services | 0x1800, 0x1801, Device Information 0x180A, a Telink style OTA service `00010203-0405-0607-0809-0A0B0C0D1912` | [SN] (ATT discovery), [AIO] test data (JBD-SP16S020-L8S advertisement) |
| Notifications | 20 bytes per notification at the default ATT MTU; the 36 byte 0x03 answer arrives as 20 + 16 bytes, longer answers in more pieces | [SN], [OK] ("Some messages (the basic info message) are broken up and returned in 2 consecutive notifications") |
| Pairing | none on most modules; a Liontron module requires real BLE pairing with passkey before it answers (section 4.2) | [SY] issue 245, [BM] `jbd.py` (`_uses_pin`, "newer JBD firmware gates the protocol behind a passkey pairing") |
| Transparency | the module forwards written `DD` frames to the BMS UART and returns UART data as notifications; the BMS never sends without a request | [OK] ("The BMS never sends anything without a request"), [IEB] (UART snoop of the module) |

Write with "write without response" when the characteristic offers it, otherwise with "write" ([OK], [SY] `send_command` uses `ESP_GATT_WRITE_TYPE_NO_RSP`, [AIO]).

Advertising ([AIO] test data, 43 records):

- Service list `FF00` in almost every record.
- Manufacturer data: the company id (little-endian) and the first four payload bytes together are the six bytes of the device address, in reverse order on some modules (record "AP21S002-L21S": company 0x3ED9, payload `42 37 C1 A4`, address A4:C1:37:42:3E:D9; "DP04S007L4S100A", "LT40AH") and in forward order on others (company 0xC1A4, payload `38 99 15 54`, address A4:C1:38:99:15:54; the 70:3E:97 and AA:C2:37 records, the latter with four more bytes). The company id is therefore not a constant and cannot be used as a filter. **unverified** inference: the test data anonymises the address to its first three bytes, which match one of the two orders in every record with manufacturer data except the 0x007B group below.
- Supervolt, SBL, Titan, Nordström and RVPOWER packs send company 0x007B with payload `02 FF FF 7D`.
- Names: model codes (`SP04S034L4S200A`, `DP04S007L4S100A`, `SP17S005P17S120A`, `SP08S025L8S200A`), `JBD-...`, `xiaoxiang BMS`, brand names (`ECO-LFP48100-3U-8EC7`, `LT40AH`, `SX100P-B230201`, `SBL-12330BLH1-242055`, `TITAN-12V-120AHBH-0201`, `OGR-48100-...`, `LSG-48100Y...`) and serial numbers.

### 2.2 UART and RS485

| Item | Value | Sources |
| --- | --- | --- |
| Framing | 9600 baud, 8 data bits, no parity, 1 stop bit; "or other custom rates" | [V4], [V11], [RM], [JT] `serial.c` (`DEFAULT_SPEED 9600`), [SY] `esp32-example.yaml` |
| Connector | 4 pin JST PA 2.0 mm "UART" next to the balance connector, of which GND, RXD and TXD are wired | [SY] README schematic |
| Bluetooth module port | 12 V (or pack voltage), BMS TX, BMS RX, GND; 3.3 V logic measured with a scope | [IEB] SnoopOnBTAdapter.md |
| Levels | 3.3 V TTL on the measured board; RS485 on some models (JBD-AP21S002 "using RS485") | [IEB], [SY] README (issue 121) |
| Sleep | the BMS interface sleeps after about 30 s without traffic; an edge on BMS RX wakes it, and the first request in sleep is lost, so repeat a request that got no answer | [IEB], [V11] section 1 ("the first data cannot be responded to in sleep mode and needs to be sent again") |
| Turnaround | syssi waits 50 ms between the answer to 0x03 and the 0x04 request and clears its receive buffer after 150 ms of silence | [SY] `jbd_bms.cpp` (`INTER_FRAME_DELAY_MS`), `jbd_bms.h` (`rx_timeout_`) |
| Addressing | none: every BMS on the line answers, so the `DD` protocol is point to point | [DSB] `lltjbd.py` `test_connection` ("LLT/JBD does not seem to support addresses"), [SY] README multiple BMS warning |

Do not connect the UART grounds of several packs without galvanic isolation: the BMS switches the negative side and a common ground can carry the pack current ([SY] README "Connecting multiple BMS units").

### 2.3 UP series RS485

9600 baud 8N1 ([SY] `esp32-up-example.yaml`), several packs on one bus with addresses 1, 2, ... (address 1 is the master that aggregates the others) ([SY] docs/pdus/JBD-UP16S020-two-devices.txt, [DSB] `is_master`). An answer takes 0.3 to 0.6 s ([DSB] `SERIAL_TIMEOUT_SECONDS` comment).

## 3. Frame formats

### 3.1 Request (host to BMS)

| Offset | Size | Field | Notes | Sources |
| --- | --- | --- | --- | --- |
| 0 | 1 | start 0xDD | | [V4], [V11], [RM] |
| 1 | 1 | 0xA5 read, 0x5A write | | same |
| 2 | 1 | register | section 5.1 | same |
| 3 | 1 | data length n | 0 for reads of 0x03, 0x04, 0x05, 0xAA and EEPROM registers | same |
| 4 | n | data | | same |
| 4 + n | 2 | checksum, u16 | section 3.3 | same |
| 6 + n | 1 | end 0x77 | | same |

[V11] adds an optional CALLBACK_ID of up to 4 bytes after 0x77 that the BMS echoes ("the slave will reply what the master sends", revision V3); no source uses it, ubms does not send it.

### 3.2 Response (BMS to host)

| Offset | Size | Field | Notes | Sources |
| --- | --- | --- | --- | --- |
| 0 | 1 | start 0xDD | | [V4], [V11] |
| 1 | 1 | register of the request | | same |
| 2 | 1 | status | section 3.4 | same |
| 3 | 1 | data length n | 0 for write acknowledgements and errors | same, [SN] |
| 4 | n | data | | same |
| 4 + n | 2 | checksum | over bytes 2 .. 3 + n | same |
| 6 + n | 1 | end 0x77 | | same |

### 3.3 Checksum

checksum = (0x10000 − (sum of bytes 2 .. 3 + n)) AND 0xFFFF, sent high byte first. Covered are the register (request) or status (answer), the length and the data; not the start byte, the 0xA5 / 0x5A byte or the register of an answer ([V4] "the checksum of the data content + length byte + command code byte, then inverted and 1 added"; [RM] "sum of the payload byte values subtracted from 0x10000"; [SY] `chksum_`, [AIO] `_crc`, [DSB] `checksum`, [BM] `_validate_jbd_response`).

Worked examples:

- `DD A5 03 00 FF FD 77`: 0x03 + 0x00 = 0x03, 0x10000 − 0x03 = 0xFFFD ([V4]).
- `DD 5A E1 02 00 02 FF 1B 77`: 0xE1 + 0x02 + 0x00 + 0x02 = 0xE5, 0x10000 − 0xE5 = 0xFF1B ([V4]).
- Acknowledgement `DD E1 00 00 00 00 77`: status 0 and length 0 sum to 0, 0x10000 AND 0xFFFF = 0x0000 ([SN]). [OK] calls these frames "ok messages without a valid checksum"; they are valid under the rule above.
- Error `DD 24 81 00 FF 7F 77`: 0x81 → 0xFF7F ([SN]); `DD E3 80 00 FF 80 77` ([JT] `jbd_info.c`).

Some implementations compute `0x10000 − sum` without the 16-bit mask ([BT] `chksum`, [AIO] `_crc`) and would reject the zero checksum of acknowledgements; mask it.

### 3.4 Status codes

| Status | Meaning | Sources |
| --- | --- | --- |
| 0x00 | success | [V4], [V11] |
| 0x80 | error; [V11]: command code does not exist | [V4], [V11], [JT] (0xE3 and 0x0A refused), [BH] issue 795 (0x05 on a Daren clone), [OK] (0x42..0x47 on firmware 0x15 / 0x16) |
| 0x81 | operation invalid: not in factory mode, or internal password mismatch ("the password function is for Bluetooth") | [V11]; observed for a register read after leaving factory mode ([SN] V1.3 capture, vector `v13-ble-rx-covp-not-factory`) |
| 0x82 | checksum error; "in principle checksum errors are not answered" | [V11] (**unverified**, never observed) |
| 0x83 | password pairing error | [V11] (**unverified**, never observed) |

Error answers carry no data. A driver treats any non-zero status as a refusal of that request and never retries a refused write automatically.

### 3.5 Reassembly

- Search 0xDD, read the length byte at offset 3, wait for 7 + n bytes, require 0x77 at the end and a valid checksum; on failure drop one byte and search again. Bytes before 0xDD are noise ([BM] `_notification_handler` discards bytes before the header; vector `jbdtool-uart-stream-cells-leading-noise` from [SY] docs/debug.txt has two stray bytes).
- Do not end a frame at the first 0x77: data bytes may be 0x77 ([SY] `assemble` comment "The payload may contain JBD_PKT_END").
- The length byte allows frames of up to 262 bytes. A 32 cell 0x04 answer has 71 bytes, a V11 0x03 answer with 8 NTC 48 data bytes (55 bytes in total). syssi limits its BLE buffer to 41 bytes (`MAX_RESPONSE_SIZE`), which is too small for long answers; do not copy that limit.
- Match answers by the register byte. Answers can arrive 6 to 14 s late on a weak BLE link; a retry then produces two answers to one request ([BH] issue 872: median 0.24 s, p99 1.03 s, late answers at 11.1 s and 14.2 s). Discard an answer whose register does not match the pending request instead of concatenating it.
- Match the kind of answer too: a read takes a refusal or an answer with data, a write only an answer without data (section 6.7). Otherwise a late acknowledgement `DD r 00 00 00 00 77` of an earlier write answers a later read of the same register with zero data bytes, and a late read answer acknowledges a write (ubms rule derived from the above; the implementation review reproduced a wrong unit for 0x28 from a stray 0x2D acknowledgement).
- `FF AA` frames from the module may arrive between `DD` frames on the same characteristic; they always fit into one notification ([SY] `assemble` processes them directly). Start a `FF AA` frame only at a notification boundary.

### 3.6 Bluetooth module frames (FF AA)

| Offset | Size | Field | Sources |
| --- | --- | --- | --- |
| 0 | 2 | `FF AA` | [OK], [SY], [AIO] |
| 2 | 1 | command (section 5.3) | same |
| 3 | 1 | data length n | same |
| 4 | n | data | same |
| 4 + n | 1 | checksum = (sum of bytes 2 .. 3 + n) AND 0xFF | [OK] ("modulo 256 of all bytes between header and checksum"), [SY] `auth_chksum_`, [AIO] `_init_connection` |

Example: `FF AA 07 03 58 59 5A 15` renames the module to "XYZ": 0x07 + 0x03 + 0x58 + 0x59 + 0x5A = 0x115 → 0x15 ([OK]). Module answers have the same format with a one byte result (section 9.8).

### 3.7 UP series frames

| Offset | Size | Field | Sources |
| --- | --- | --- | --- |
| 0 | 1 | address 1..247 | [SY] `jbd_bms_up.cpp` `parse_byte_`, [DSB] `FrameHeader` |
| 1 | 1 | function: 0x78 read, 0x79 write, 0x45 individual pack status | [SY] `jbd_bms_up_pack.cpp`, [DSB] |
| 2 | 2 | start address, u16 BE | same |
| 4 | 2 | end address, u16 BE (start + length in address units) | same |
| 6 | 2 | data length in bytes, u16 BE; 0 in read requests | same |
| 8 | n | data | same |
| 8 + n | 2 | CRC-16/MODBUS (polynomial 0xA001 reflected, init 0xFFFF) over bytes 0 .. 7 + n, low byte first | [SY] `crc16`, [DSB] `calc_crc16` |

The answer echoes address, function, start and end address. A read of 0x1000..0x10A0 returned 158 bytes on one pack and 150 on another ([SN] of [SY] pdus, vectors `up16s-rs485-rx-status-addr1` and `-addr2`). Write data starts with the marker `11 4A 42 44` (0x11 and ASCII "JBD") followed by the value; the answer to a write has no data ([DSB] `JBD_WRITE_PAYLOAD_PREFIX`, `SetSoc`; [SY] `write_frame_test.cpp`).

## 4. Session flow

### 4.1 Bluetooth connect

1. Connect, find service 0xFF00 (or 0xFFF0), start notifications on 0xFF01 (0xFFF1).
2. Send `DD A5 03 00 FF FD 77`. Expect the answer within about 1 s; on no answer repeat once (sleeping BMS, section 2.2). In btsnoop_hci-mosfets-onoff.log the official app sent 0x04 30 ms after enabling notifications and got no answer; the 0x03 request 2 s later was answered after 100 ms ([SN]).
3. If the BMS stays silent, the module may be locked: run the login of section 4.2. syssi sends the app key after 3 unanswered requests when no password is configured, only to report "the BMS requires a password" ([SY] `update`).
4. Read 0x05 (model) once for the device information, then poll (section 4.3).
5. The official app also writes `DD 5A 06 07 06 00 00 00 00 00 00 FF ED 77` (password register 0x06, six zero bytes) after connecting and gets an acknowledgement ([SN], three captures; [IEB] shows the module itself sends it on connect). ubms does not need it for monitoring; see section 8.4.

### 4.2 Login of the newer Bluetooth module (FF AA)

Sequence observed with the official app on a JBD-SP04S034 with the 2024 module ([SN] V1.3 capture; [SY] docs/ffaa-auth-flow, issue 94, `jbd_bms_ble.cpp`):

| Step | Host sends | Module answers | Notes |
| --- | --- | --- | --- |
| 1 app key | `FF AA 15 06 30 30 30 30 30 30 3B` (ASCII "000000") | `FF AA 15 01 rr cs` | rr 0x00: accepted, password required; 0x02: no password set, done; 0x01: rejected ([SY] `handle_auth_response_`) |
| 2 random | `FF AA 17 00 17` | `FF AA 17 01 RR cs` | RR = random byte |
| 3 user password | `FF AA 18 06 e0..e5 cs` | `FF AA 18 01 rr cs` | e[i] = ((MAC[i] XOR pw[i]) + RR) AND 0xFF, pw = 6 ASCII characters; rr 0x00 accepted, 0x01 rejected |
| 4 random | `FF AA 17 00 17` | `FF AA 17 01 RR cs` | new random byte |
| 5 root password | `FF AA 1D 0F e0..e14 cs` | `FF AA 1D 01 rr cs` | 15 bytes "JBDbtpwd!@#2023", e[i] = ((MAC[i] XOR root[i]) + RR) AND 0xFF with MAC[i] = 0 for i ≥ 6 |
| 6 | `DD A5 03 ...` | `DD 03 ...` | the module forwards `DD` frames from now on |

- MAC is the Bluetooth device address of the BMS module in display order (A4:C1:37:04:2D:BE gives bytes A4 C1 37 04 2D BE). With MAC A4:C1:37:04:2D:BE, random 0x62 and password "000000" the bytes are `F6 53 69 96 7F F0`; the check in [SY] issue 94 used `% 255` and got two bytes wrong, the correct operation is AND 0xFF ([SY] `send_user_password_`; vectors `auth-ble-tx-password-000000`, `auth-ble-tx-password-123412`, `auth-ble-tx-root-37` reproduce the captured bytes).
- Web Bluetooth does not expose the device address. A browser can only compute steps 3 and 5 when the user enters the address or when the address is read from the manufacturer data of an advertisement (section 2.1, **unverified**; needs `watchAdvertisements`, which is not available in every browser). The Tauri build gets the address from the platform on Windows and Linux.
- Default password "123123" in syssi when none is configured ([SY] `send_user_password_`); the README lists a pack that needs "123456" ([SY] README, JBD-SP04S034 V1.3). The password has 6 alphanumeric characters ([SY] `validate_password`).
- Change password: `FF AA 16 06 <new password in plain ASCII> cs`, answer `FF AA 16 01 00 17` ([SY] docs/ffaa-auth-flow/communications2.txt). ubms does not offer it.
- After the root password the official app sends `DD 5A 09 07 06 "J1B2D4" FE 83 77` (clear the BMS password, section 8.4) and then enters factory mode ([SN] V1.3 capture). ubms does not copy this: it changes the device configuration.
- A Liontron module echoed the app key frame unchanged and answered `DD` frames only after a BLE pairing with passkey ("keyboard only" IO capability); the app key was then not needed ([SY] issue 245, **unverified** for other modules). In Chromium the operating system shows the passkey prompt when the device asks for an encrypted link.
- syssi times out the login after 10 s and restarts it ([SY] `__init__.py` `auth_timeout`, `check_auth_timeout_`).

### 4.3 Polling

- Alternate 0x03 and 0x04, one request at a time, waiting for the answer before the next request. The official app reads 0x04 then 0x03 about once per second ([SN]); syssi updates every 2 s and requests 0x04 when the 0x03 answer arrived ([SY] `on_jbd_bms_data`, `esp32-ble-example.yaml`).
- Recommended: poll interval 2 s (minimum 1 s), answer timeout 1.5 s per request, one repeat, then report the link as unresponsive; keep accepting late answers by register (section 3.5).
- Read 0x05 once per connection; it is static. syssi retries it up to 5 times when it stays unanswered ([SY] `on_cell_info_data_`).

### 4.4 Factory mode transactions

Reading or writing the EEPROM registers 0x10..0xA2 needs factory mode on current firmware: a read of 0x24 outside factory mode returned status 0x81 ([SN] V1.3 capture). All tools wrap register access in factory mode ([BT] `factoryContext`, [DSB] `eeprom`, [BM] `_fetch_device_info`, [SBU], [SN] official app).

| Step | Frame | Answer | Sources |
| --- | --- | --- | --- |
| enter | `DD 5A 00 02 56 78 FF 30 77` | `DD 00 00 00 00 00 77` | [V11] 5.1, [RM], [SN], [IEB] |
| read register r | `DD A5 r 00 cs 77` | `DD r 00 02 hi lo cs 77` (strings: length prefixed) | [SN] (full read of 0x10..0x3F, 0xA0..0xA2) |
| write register r | `DD 5A r 02 hi lo cs 77` | `DD r 00 00 00 00 77` | [SN] (0x2D), [BT], [SBU] |
| exit, keep | `DD 5A 01 02 00 00 FF FD 77` | `DD 01 00 00 00 00 77` | [RM], [BT] `exitFactory(False)`, [SN] official app after reads and after the balancer write |
| exit, save | `DD 5A 01 02 28 28 FF AD 77` | `DD 01 00 00 00 00 77` | [V11] ("exit factory mode command 0x2828"), [RM] ("update the values in the EEPROM and reset the error counts"), [BT] `exitFactory(True)`, [BM] |

- Read session: enter, read the registers, exit with 0x0000. The official app reads 0x2D and 0x2E, or the full parameter set, this way ([SN]).
- Write session: enter, write one register, read it back, repeat for the next register, exit with 0x2828. bms-tools switched to 0x2828 after the bug report "EEPROM save not sticking between power cycles" ([BT] CHANGELOG v1.1.2). The official app left factory mode with 0x0000 after writing 0x2D ([SN]); whether such a value survives a power cycle is **unverified**. The [RM] statement that 0x2828 also clears the protection counters is **unverified** by a capture.
- The BMS is not answering 0x03 differently in factory mode: polling continued during the sessions of the official app ([SN]); keep polling paused during a transaction anyway, so frames do not interleave.
- If entering factory mode is refused (status 0x81) or unanswered, report the settings as unavailable; [BM] then keeps the basic information only. An unanswered enter request is still followed by exit `00 00`: the answer may be lost while the BMS did enter ([BM] `_fetch_device_info`: "the ack may be lost while the BMS did enter; 00 00 is harmless").
- ubms marks a transaction as open in the connection options before the enter request and clears the mark when an exit is acknowledged. A transaction that could not be closed (both exit answers lost, link lost in the middle) is closed with `00 00` at the beginning of the next poll, also by a new driver instance after a reconnect, at most three times; the probe never sends it, because it must stay read-only (ubms policy).
- A write session whose exit `28 28` is not acknowledged is reported as failed ("written but not confirmed as saved"), although the value was read back: it may be in RAM only (section 4.4 item on `00 00` persistence, [BT] CHANGELOG v1.1.2). The pending exit is then `00 00`, never a delayed `28 28`, because the behaviour of `28 28` outside factory mode (after a power cycle) is not documented.
- The protection counters 0xAA and the strings are read the same way; 0xAA was read outside factory mode by the official app ([SN]).

### 4.5 UART and RS485

Same as 4.3 and 4.4 without the module layer. The first request after a pause may be lost (section 2.2). syssi sends 0x03 at start-up and every update interval, 0x04 50 ms after the 0x03 answer ([SY] `jbd_bms.cpp`).

### 4.6 UP series

Poll the status block with `addr 78 10 00 10 A0 00 00 crc` per address every few seconds ([SY] `JbdBmsUpPack::update`). The official tooling in the capture cycled through 0x1000, 0x1C00, 0x1800, 0x2000, 0x2400, 0x2800, 0x2900 and function 0x45 every 2 s per pack ([SY] docs/pdus/JBD-UP16S020-two-devices.txt). Some blocks are only answered for the pack connected to the port ([DSB] `IndividualPackStatus`, `PackParams1` comments).

## 5. Commands

### 5.1 Register and command table (DD protocol)

| Register | Op | Data | Meaning | ubms | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x00 | write | `56 78` | enter factory mode | yes (4.4) | [V11], [RM], [BT], [SN] |
| 0x00 | read | none (V11) or `00 00` (app) | read chip type (AFE family, section 7.5); no answer in the capture | no | [V11] section 9; [SN] V1.3 app sends `DD A5 00 02 00 00 FF FE 77` without an answer (**unverified**) |
| 0x01 | write | `00 00` or `28 28` | exit factory mode, without or with saving | yes (4.4) | [V11], [RM], [BT], [SN] |
| 0x03 | read | none | basic information (6.1) | yes | [V4], [V11] |
| 0x04 | read | none | cell voltages (6.3) | yes | [V4], [V11] |
| 0x05 | read | none | hardware version string (6.4) | yes | [V4], [V11] |
| 0x06 | write | length 6 + password | use password before factory mode (firmware 0x16 and later) | see 8.4 | [RM], [BT] `_sendPassword`, [V11] 8.1, [SN] |
| 0x07 | write | length 12 + old + new password | change the BMS password | no | [RM], [BT] `setPassword`, [V11] 8.1 |
| 0x09 | write | length 6 + "J1B2D4" | clear the BMS password | no | [RM], [BT] `clearPassword`, [SN] V1.3 app |
| 0x0A | write | 2 byte function code | control command (8.3) | partly | [V11] 6.1, [SY] buttons |
| 0x10..0x3F, 0x42..0x47 | read, write | 2 bytes | EEPROM parameters (7.2) | yes | [RM], [BT], [V11] 5, [OK], [SN] |
| 0x40, 0x41 | read, write | 2 bytes | GPS board cut-off voltage and delay | no | [DSB], [JT] (**unverified**) |
| 0xA0, 0xA1, 0xA2 | read, write | string | manufacturer, model, barcode (7.4) | read only | [RM], [BT], [SN] |
| 0xAA | read | none | protection counters (6.5) | yes | [V11] 3.4, [RM], [SY], [SN] |
| 0xAD, 0xAE, 0xAF | write | 2 bytes | current calibration: idle (write 0), charge and discharge current in 10 mA | no | [RM], [BT] |
| 0xB0..0xCF | write | 2 bytes | cell voltage calibration, measured mV per cell | no | [RM], [BT] |
| 0xD0..0xD7 | write | 2 bytes | NTC calibration, measured 0.1 K | no | [RM], [BT] |
| 0xE0 | write | 2 bytes | set remaining capacity, 10 mAh | no | [RM], [BT] `setPackCapRem` (**unverified**) |
| 0xE1 | write | `00 xx` | MOSFET software switches (8.1) | yes | [V4], [RM], [SN], [SY], [BT], [DSB], [BM] |
| 0xE2 | write | 2 bytes | balancer test: 1 odd cells, 2 even cells, 3 all off; leave by entering and leaving factory mode | no | [RM], [BT] (**unverified**) |
| 0xE3 | write | `43 21` | reset; refused with status 0x80 on the board of [JT] | no | [JT] `jbd_reset`, [DSB] `REG_RESET` |
| 0xF6 | read, write | 60 bytes | cell internal resistance, "not added yet" | no | [V11] 7 |
| 0xFA | read, write | start (2), count (1), data | parameter block mode (7.8) | no | [V11] 5 |
| 0xFB | write | `YY XX` | MOSFET control of [V11] (replaces 0xE1 in the document) | no | [V11] 4 |
| 0xFC | write | 5 bytes | heater schedule | no | [V11] 10 |

### 5.2 Frames sent by ubms

| Purpose | Bytes | Vector |
| --- | --- | --- |
| read 0x03 | `DD A5 03 00 FF FD 77` | `vendor-v4-tx-read-basic` |
| read 0x04 | `DD A5 04 00 FF FC 77` | `vendor-v4-tx-read-cells` |
| read 0x05 | `DD A5 05 00 FF FB 77` | `vendor-v4-tx-read-hwver` |
| read 0xAA | `DD A5 AA 00 FF 56 77` | `sp04s034-uart-tx-error-counts` |
| enter factory | `DD 5A 00 02 56 78 FF 30 77` | `btmodule-uart-tx-enter-factory` |
| exit factory | `DD 5A 01 02 00 00 FF FD 77` | `btmodule-uart-tx-exit-factory-discard` |
| exit and save | `DD 5A 01 02 28 28 FF AD 77` | `tx-exit-factory-save` |
| read register r | `DD A5 r 00 (0x10000 − r) 77` | `sp04s034-ble-tx-read-10` .. `-a2` |
| write register r | `DD 5A r 02 hi lo cs 77` | `tx-write-reg-*-example`, `app-ble-tx-balancer-on` |
| MOSFETs | `DD 5A E1 02 00 xx cs 77` | `app-ble-tx-mos-charge-off`, `app-ble-tx-mos-both-on`, `vendor-v4-tx-mos-discharge-off`, `syssi-tx-mos-both-off` |
| control | `DD 5A 0A 02 hi 00 cs 77` | `vendor-v11-tx-0a-reset-capacity`, `tx-control-0a-0400` |

### 5.3 Bluetooth module commands (FF AA)

| Command | Data | Meaning | Sources |
| --- | --- | --- | --- |
| 0x07 | name | set the advertised name; answer `FF AA 07 00 07` | [OK] |
| 0x15 | "000000" | app key (login step 1) | [SY], [AIO] `_init_connection` (sends the configured secret instead, **unverified**), [SN] |
| 0x16 | 6 ASCII | set the first level (user) password, plain text | [SY] issue 94 frame list, communications2.txt |
| 0x17 | none | get a random byte | [SY], [SN] |
| 0x18 | 6 encrypted | first level password (login step 3) | [SY], [SN] |
| 0x1A | 66 bytes | "testFrame" | [SY] issue 94 frame list from the app (**unverified** meaning) |
| 0x1B | 6 bytes | second level password | same (**unverified**) |
| 0x1D | 15 encrypted | root password (login step 5) | [SY], [SN] |
| 0x1F, 0x20, 0x22, 0x23, 0x24 | 1 or 6 bytes | restore second password, factory reset of the module, base app key, clear first level password, clear app key | [SY] issue 94 frame list (**unverified**, never captured with an answer) |

ubms sends only 0x15, 0x17, 0x18 and 0x1D: the app key 0x15 once in the Bluetooth probe on the FF00 layout when the 0x03 read and its repeat gave no valid answer (section 11.2), and again as step 1 of each login; 0x17, 0x18 and 0x1D only when the user supplied both a password and the module address (section 4.2).

### 5.4 UP series functions and blocks

| Function, start .. end | Content | Status in this document | Sources |
| --- | --- | --- | --- |
| 0x78, 0x1000 .. 0x10A0 | pack status (6.10) | decoded, two packs captured | [SY] `jbd_bms_up_pack.cpp`, frames.h; [DSB] `PackStatus` |
| 0x78, 0x1C00 .. 0x1CA0 | pack parameters part 1: BMS model and serial (30 bytes at data offset 16), BMS date, pack serial (30 bytes), pack date | partly, **unverified** | [DSB] `PackParams1` |
| 0x78, 0x1800 .. 0x1900 | protection thresholds (values such as 3600, 3400, 3650, 2700, 2500 mV in the capture) | not decoded | [SY] docs/pdus |
| 0x78, 0x2006 .. | high resolution SOC (0.01 %), total charge and discharge (0.1 Ah) | **unverified** | [DSB] `PackParams2` |
| 0x78, 0x2800 .. 0x280F | date and time: year, month, day, hour, minute, second as u16 (capture `07 EA 00 06 00 06 00 11 00 06 00 38` = 2026-06-06 17:06:56, taken at 17:06) | inferred, **unverified** | [SY] docs/pdus |
| 0x78, 0x2810 .. 0x283C | firmware major, minor, patch, model (16 bytes), project code (16 bytes) | **unverified** | [DSB] `ProductInformation` |
| 0x79, 0x2006 | write high resolution SOC | not offered | [DSB] `SetSoc` |
| 0x79, 0x2902 .. 0x2904 | write MOSFET bits (bit 0 discharge, bit 1 charge) | not offered | [SY] `jbd_bms_up_pack.cpp` (no captured answer) |
| 0x45, 0x0000 .. 0x0054 | individual pack status, used by the master to poll slaves; charge and discharge current limits at data offset 96 | not used | [DSB] `IndividualPackStatus` |

## 6. Responses

### 6.1 Basic information (register 0x03)

Data length 23 + 2 × N, plus the V11 tail of section 6.2 on newer firmware. Frame offset = data offset + 4.

| Data offset | Type | Field (`expected` key) | Scale | Notes | Sources |
| --- | --- | --- | --- | --- | --- |
| d0 | u16 | `totalVoltage` | 10 mV | | [V4], [V11], [RM], [SY], [AIO], [DSB], [BM] |
| d2 | s16 | `current` | 10 mA, 100 mA with the unit flag (6.2) | positive while charging; the vendor example 0xF824 is −20.12 A | [V4], [V11] 11, [RM] (S16), [SY], [AIO] |
| d4 | u16 | `remainingCapacity` | 10 mAh, 100 mAh with the unit flag | [V4] calls it "balance capacity" | [V4], [V11], [RM] |
| d6 | u16 | `nominalCapacity` | 10 mAh, 100 mAh with the unit flag | equals register 0x10 (design capacity) on the SP04S034 (both 0x6D60) | [V4], [V11], [RM], [SN] |
| d8 | u16 | `cycleCount` | 1 | | [V4], [V11], [RM] |
| d10 | u16 | `productionDate` | | day = bits 4..0, month = bits 8..5, year = 2000 + bits 15..9 (section 9.5) | [V4], [V11], [RM] |
| d12 | u16 | balance bits, cells 1..16 | | bit 0 = cell 1, 1 = bleeding (section 9.4) | [V4], [V11], [RM] |
| d14 | u16 | balance bits, cells 17..32 | | `balanceBits` = d12 + 65536 × d14 | [V4] (added "based on V0"), [V11], [RM], [SY] |
| d16 | u16 | `protectionBits` | | section 9.1 | [V4], [V11], [RM] (Overkill corrected offsets), [SY] |
| d18 | u8 | `softwareVersion` | | 0x10 = "1.0" (high nibble, low nibble) | [V4], [V11], [SY], [AIO] |
| d19 | u8 | `soc` | 1 % | RSOC; the vendor example states "0x48 = 80 %", the value is 72 | [V4], [V11] |
| d20 | u8 | `fetStatus` | | bit 0 charge MOSFET on, bit 1 discharge MOSFET on, more bits in section 9.3 | [V4], [V11], [RM] |
| d21 | u8 | `cellCount` | | number of series cells, up to 32 | [V4], [V11] |
| d22 | u8 | `ntcCount` N | | 0 on a board without probes (vector `sp25s003-uart-rx-basic-bench`) | [V4], [V11], [SY] pdus |
| d23 | N × u16 | `temperatures` | 0.1 K, °C = (raw − 2731) / 10 | the vendor annotated example says "2968 − 2731 = 247 → 24.7 °C", the result is 23.7 °C | [V4], [V11], [RM] |

Notes:

- [RM] in the bms-tools copy places the version at d17 and everything after it one byte early; the Overkill update fixes this ("data byte 0x11 should have been skipped"). All vectors confirm the offsets above ([RM], [SN]).
- Capacities are unsigned: 0xDAC0 is 560.00 Ah ([BM] issue 60, vector `batmon-uart-rx-basic-560ah`).
- The NTC count must fit the data: [BM] rejects frames that announce more NTC words than they carry, after a decoder created 253 phantom sensors ([BM] `_fetch`, issue 321).
- Which NTC sits on the MOSFETs is not stated by any vendor source. dbus-serialbattery treats the first of several NTCs as the MOSFET sensor ([DSB] `read_gen_data` comment "0 = MOS"); aiobmsble treats all as cell sensors ([AIO] `_TEMP_TYPES`). **unverified**; ubms reports them as `t1` .. `tN` without a kind.

### 6.2 V11 extension tail and the unit flag

| Offset after the NTC words | Type | Field (`extension`) | Scale | Sources |
| --- | --- | --- | --- | --- |
| +0 | u8 | `byte0`: humidity in % per [V11]; 0x88 on a Fogstar Drift 628 Ah | 1 % | [V11] 3.1; [AIO] tests (Fogstar capture) |
| +1 | u16 | `alarmBits`, section 9.2 ("not used normally") | | [V11] |
| +3 | u16 | `fullChargeCapacity` | 10 mAh (unit flag) | [V11]; [SN] of [SY] pdus DP04S007 (0x4E20 = 200.00 Ah) |
| +5 | u16 | `remainingCapacity`, a copy of d4 in every capture | 10 mAh | [V11]; [SY] pdus, [IEB], [AIO] tests, [BH] issues 536 and 872 |
| +7 | u16 | `balanceCurrentRaw`, balance current | mA per [V11] (**unverified**, 0 in every capture) | [V11] |

- The tail exists when the data length is at least 23 + 2N + 9. Observed lengths: 34 (1 NTC), 38 (3 NTC), 34 (1 NTC, self heating pack) ([SY] pdus, [IEB], [AIO], [BH]). Older firmware stops after the NTC words.
- Consistency rule used by ubms and the vectors: the bytes after the NTC words count as a V11 tail only when +5 repeats d4, as in all six captured tails (vectors `sp04s060-uart-rx-basic-extended`, `dp04s007-ble-rx-basic-extended`, `ap21s001-uart-rx-basic-extended-16s`, `self-heating-ble-rx-basic-charging-balancing`, `sp24s004-ble-rx-basic-extended-12s`, `fogstar-ble-rx-basic-100ma-units`), and never for a Daren clone. Other bytes are reported as `extraBytes` and give no alarm bits, no full charge capacity and no unit flag (inferred rule, **unverified** beyond these captures). Without it the extended Daren frame below would decode its MOSFET and ambient temperatures as six tail alarm bits (0x870B) and a full charge capacity of 379.88 Ah.
- aiobmsble documents +5 as balance current and +7 as unknown ([AIO] `jbd_bms.md` "Chins Extended Fields"); every capture has +5 equal to d4, which supports [V11].
- Unit flag: [V11] defines bit 7 of the FET status byte d20 as "current and capacity unit 0.1 A / 0.1 Ah" ("V9 added, not used yet"); syssi follows it with a synthetic frame only ([SY] `on_basic_info_data_`, tests `BASICINFO_FRAME_CAPACITY_UNIT_FLAG_SYNTHETIC`). The only real capture with large units (Fogstar Drift 628 Ah, design capacity raw 6280) has d20 = 0x03 and tail byte +0 = 0x88; aiobmsble scales by 10 when bit 7 of that tail byte is set ([AIO] tests, issue 302; [BH] issue 834). Rule used by the vectors (`unit100mA`): bit 7 of d20 set, or a tail present with bit 7 of +0 set. A humidity in % never reaches 0x80, so the second test cannot misfire on a real humidity value. Both locations are **unverified**; function configuration bit 12 (section 7.3) is the persistent setting behind the flag.
- Once a settings session has read 0x2D, ubms also applies its bit 12 to the 0x03 units, together with the two in-frame flags: [V11] defines the bit as the unit of current, remaining, full, cycle and nominal capacity (section 7.6). **unverified**: no capture of a board with bit 12 set; a board with the bit and neither in-frame flag would otherwise read ten times too small.
- Daren clones send a different tail (two more temperature words, then state of health 0x64 and three zero bytes in vector `daren-ble-rx-basic-16s`); they carry production date and software version 0 ([AIO] `daren_bms.py`, [BH] issue 795). The decoder ignores a tail shorter than 9 bytes (`extraBytes`).
- Extended Daren frames carry more fields after those 8 bytes: [AIO] `daren_bms.py` reads, with 4 NTCs, state of health at frame offset 39 (tail +4), remaining capacity in 0.1 Ah at 43 (tail +8), design capacity in 0.1 Ah at 45 (tail +10) and current in 0.1 A at 49 (tail +14), fixed offsets that assume 4 NTCs ([AIO] only, **unverified**, no capture). The constructed vector `daren-ble-rx-basic-16s-extended` has this layout; the consistency rule above keeps it out of the V11 decoding, and the driver never decodes a tail for `variant` `DAREN`.

### 6.3 Cell voltages (register 0x04)

Data length 2 × cells, each u16 in mV, cell 1 first ([V4], [V11], [RM]). A 0 mV slot is real data (cell simulator, vector `sp25s003-uart-rx-cells-bench`); never fill missing cells with zeros from a truncated frame ([BM] issue 388). The count should equal d21 of 0x03; if not, show the cells of 0x04 and raise `cell_count_mismatch` only after two consistent reads (**unverified** policy, no source).

### 6.4 Hardware version (register 0x05)

Plain ASCII, no length prefix, up to 31 characters ([V4] "Support up to 31 characters, write the model through the device model of the host computer"; [V11] 3.3). syssi cuts the string at the first NUL ([SY] `on_hardware_version_data_`). Examples: "JBD-SP04S034-L4S-200A-B-U" ([SY] pdus), "SP04S034L4S200A" on the 2024 module ([SY] issue 94), "JBD-SP04S060-300A-L4S" ([IEB]), "0123456789" ([V4] example). The same string is register 0xA1 with a length prefix (vector `sp04s034-ble-rx-reg-a1`). Daren clones answer with status 0x80 ([BH] issue 795).

### 6.5 Protection counters (register 0xAA)

| Data offset | Counter (`errorCounts` key) | Sources |
| --- | --- | --- |
| d0 | short circuit (`shortCircuit`) | [V11] 3.4, [RM], [BT] `ErrorCountReg`, [SY] |
| d2 | charge overcurrent | same |
| d4 | discharge overcurrent | same |
| d6 | cell overvoltage | same |
| d8 | cell undervoltage | same |
| d10 | charge overtemperature | same |
| d12 | charge undertemperature | same |
| d14 | discharge overtemperature | same |
| d16 | discharge undertemperature | same |
| d18 | pack overvoltage | same |
| d20 | pack undervoltage | same |
| d22 | system restarts (`restartCount`), present when the data length is 24 (**unverified**: [V11] only) | [V11] ("when the data length is 22 there is no restart count"); [SY] `on_error_counts_data_` reads only d0..d20 and ignores the word |

Every capture has 24 data bytes ([SN], [SY] pdus); syssi also accepts 22 ([SY] tests, PR 259). ubms reads 0xAA once per connection with the device information (no factory mode, as the official app) and shows the counters as device information extras. The restart count is published as `DeviceInfo.powerOnCount` with the meaning of [V11]; the code comments mark it unverified.

### 6.6 Register reads

- 16-bit registers: `DD r 00 02 hi lo cs 77`, value per section 7.2 ([SN] full read of an SP04S034).
- Byte pairs (0x38, 0x39, 0x3A..0x3F): same frame, the two bytes have separate meanings (section 7.2).
- Strings (0xA0..0xA2): `DD r 00 (n + 1) n c1 .. cn cs 77`; an empty barcode is `DD A2 00 01 00 FF FF 77` ([SN], [IEB], [RM]). The V11 FA string blocks have the same length prefix ([V11] example "DGJBD" followed by left-over bytes that must be ignored).
- Outside factory mode current firmware answers status 0x81 (section 3.4).

### 6.7 Write acknowledgements and errors

Every accepted write is answered `DD r 00 00 00 00 77` ([SN]: 0x00, 0x01, 0x06, 0x09, 0x2D, 0xE1; [V11] for 0x0A and 0xFB). Errors are `DD r st 00 cs 77` with st ≥ 0x80 (section 3.4). An acknowledgement does not prove that the BMS applied the value: read the register (or 0x03 for MOSFETs) back.

### 6.8 Parameter block answer (0xFA, V11)

`DD FA 00 len p_hi p_lo count w1 .. wcount cs 77` with len = 2 × count + 3 ([V11] 5.1, example: start 0x0001, 2 words 0x0FA0 and 0x1036). Not used by ubms (section 7.8).

### 6.9 Module answers (FF AA)

One data byte with the result (section 9.8), for example `FF AA 15 01 00 16` ([SY], [SN]). The random byte answer carries the random value: `FF AA 17 01 24 3C` ([SN]). The rename answer has no data: `FF AA 07 00 07` ([OK]).

### 6.10 UP series pack status (0x78, 0x1000 .. 0x10A0)

Data offsets; all fields u16 big-endian unless stated ([SY] `on_pack_status_` "byte layout verified against UP16S020 raw capture", [DSB] `PackStatus`). Temperatures: °C = (raw − 500) / 10.

| Offset | Field (`status` key) | Scale | Notes |
| --- | --- | --- | --- |
| 0 | `totalVoltage` | 10 mV | |
| 2 | unknown | | 0 on the master, equal to the voltage on the slave ([SN]) |
| 4 | `current`, u32 | 10 mA, offset 300000 | (raw − 300000) × 0.01 A; sign while charging **unverified** (0 A in both captures) |
| 8 | `soc` | 0.01 % | |
| 10 | `remainingCapacity` | 0.01 Ah | |
| 12 | `fullCapacity` | 0.01 Ah | [SY] calls it nominal capacity |
| 14 | `ratedCapacity` | 0.01 Ah | |
| 16 | `mosTemperature` | | |
| 18 | `ambientTemperature` | | |
| 20 | `operationStatus` | | 0 idle, 1 charging, 2 discharging ([SY]) |
| 22 | `soh` | 1 % | |
| 24 | `protectionBits`, u32 | | [SY] "protect" (27 bits), [DSB] "fault flags"; section 9.9 |
| 28 | `alarmBits`, u32 | | [SY] "errors" (18 bits), [DSB] "alarm flags"; section 9.9 |
| 32 | `mosStatus` | | bit 0 discharge, bit 1 charge, bit 2 precharge, bit 3 heater, bit 4 fan ([SY]) |
| 34 | connection state flags | | [DSB] only |
| 36 | `cycles` | 1 | |
| 38, 40 | `maxCellIndex` (1 based), `maxCellVoltage` | 1, 1 mV | |
| 42, 44 | `minCellIndex`, `minCellVoltage` | 1, 1 mV | |
| 46 | `avgCellVoltage` | 1 mV | |
| 48 .. 56 | max sensor, max, min sensor, min, average temperature | | |
| 58, 60, 62, 64 | `chargeVoltageLimit`, `chargeCurrentLimit`, `dischargeVoltageLimit`, `dischargeCurrentLimit` | 0.1 V, 0.1 A | values for an inverter (58.4 V, 200 A, 44.8 V, 200 A in the capture) |
| 66 | `cellCount` N | | |
| 68 | N cell voltages | 1 mV | |
| 68 + 2N | temperature count M, then M temperatures | | |
| then | unknown u16, `balanceBits` (bit 0 = cell 1), `firmwareVersion` (high byte major, low byte minor; "not available when the master forwards slave data", 0.4 on the slave), 30 ASCII bytes NUL padded | | [SY] calls the string the device model ("JBD48100000"), [DSB] the pack serial number (**unverified**) |

## 7. Settings

### 7.1 Access rules

- Read and write registers 0x10..0xA2 inside factory mode (section 4.4). Write one register per frame with 2 data bytes (strings: section 7.4) ([BT], [SBU], [SN]).
- Read back every written register before leaving factory mode, then leave with `01 28 28` (section 4.4). Compare the read value with the written raw value; report the field as not applied otherwise.
- Byte pair registers and bit fields are read, modified and written as a whole: keep the bytes and bits ubms does not show unchanged ([DSB] `write_balancer` reads 0x2D before writing it).
- The capacity and current registers depend on the unit bit 12 of 0x2D (section 7.6): read 0x2D first in every settings session.
- A password set through register 0x07 must be sent with 0x06 before entering factory mode (section 8.4).

### 7.2 EEPROM register map

ubms column: `rw` writable, `ro` shown read-only, `adv` advanced group, `danger` needs extra confirmation. Value column: what the JBD-SP04S034-L4S-200A-B-U of [SN] returned (vectors `sp04s034-ble-rx-reg-xx` and `app-ble-rx-*`).

| Reg | ubms id | Type and scale | SP04S034 value | ubms | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x10 | `capacity.nominal` | u16, 10 mAh | 280.00 Ah | rw | [V11] param 0, [RM] design_cap, [BT], [SBU], [SN] |
| 0x11 | `capacity.cycle` | u16, 10 mAh; capacity that counts as one cycle | 224.00 Ah | rw | [V11] param 1, [RM], [BT], [SBU], [SN] |
| 0x12 | `charge.soc100_voltage` | u16, 1 mV per cell ("full voltage") | 3.500 V | rw | [V11] 2, [RM] cap_100, [BT], [SBU], [SN] |
| 0x13 | `charge.soc0_voltage` | u16, 1 mV per cell ("end of discharge voltage") | 2.800 V | rw | [V11] 3, [RM] cap_0, [BT], [SBU], [SN] |
| 0x14 | `jbd.self_discharge_rate` | u16, 0.1 % per [RM]; "system power consumption, mA" per [V11] param 4 | 0.2 % (raw 2) | ro, adv (shown as the raw number, no unit) | conflict [RM] against [V11] (**unverified**) |
| 0x15 | `jbd.production_date` | u16 date (9.5) | 2022-03-28 | ro | [V11] 5, [RM], [SN] |
| 0x16 | `jbd.serial_number` | u16 | 0 | ro | [V11] 6, [RM], [SN] |
| 0x17 | `jbd.cycle_count` | u16 | 0 | ro | [V11] 7, [RM], [SN] |
| 0x18 | `charge.otp` | u16, 0.1 K | 75.0 °C | rw | [V11] 8, [RM], [BT], [SBU], [SN] |
| 0x19 | `charge.otpr` | u16, 0.1 K | 55.0 °C | rw | [V11] 9, [RM], [BT], [SBU], [SN] |
| 0x1A | `charge.utp` | u16, 0.1 K | −10.0 °C | rw | [V11] 10, same |
| 0x1B | `charge.utpr` | u16, 0.1 K | 0.0 °C | rw | [V11] 11, same |
| 0x1C | `discharge.otp` | u16, 0.1 K | 75.0 °C | rw | [V11] 12, same |
| 0x1D | `discharge.otpr` | u16, 0.1 K | 55.0 °C | rw | [V11] 13, same |
| 0x1E | `discharge.utp` | u16, 0.1 K | −10.0 °C | rw | [V11] 14, same |
| 0x1F | `discharge.utpr` | u16, 0.1 K | 0.0 °C | rw | [V11] 15, same |
| 0x20 | `pack.ovp` | u16, 10 mV | 14.60 V | rw | [V11] 16, [RM], [BT], [SBU], [SN] |
| 0x21 | `pack.ovpr` | u16, 10 mV | 14.20 V | rw | [V11] 17, same |
| 0x22 | `pack.uvp` | u16, 10 mV | 10.00 V | rw | [V11] 18, same |
| 0x23 | `pack.uvpr` | u16, 10 mV | 10.80 V | rw | [V11] 19, same |
| 0x24 | `cell.ovp` | u16, 1 mV | 3.650 V (3.750 V on the V1.3 unit) | rw | [V11] 20, [RM], [BT], [SBU], [SN] |
| 0x25 | `cell.ovpr` | u16, 1 mV | 3.550 V | rw | [V11] 21, same |
| 0x26 | `cell.uvp` | u16, 1 mV | 2.500 V | rw | [V11] 22, same |
| 0x27 | `cell.uvpr` | u16, 1 mV | 2.700 V | rw | [V11] 23, same |
| 0x28 | `charge.ocp` | s16 positive, 10 mA (100 mA with bit 12) | 230.00 A | rw | [V11] 24, [RM] ("must be positive"), [BT], [SBU], [SN] |
| 0x29 | `discharge.ocp` | s16 stored negative, 10 mA (100 mA with bit 12); ubms shows the magnitude | 230.00 A (raw 0xA628 = −23000) | rw | [V11] 25 ("transmitted in complement form"), [RM] ("must be negative"), [BT], [SBU] (0x10000 − value), [SN] |
| 0x2A | `balance.start_voltage` | u16, 1 mV | 3.200 V | rw | [V11] 26, [RM], [BT], [SBU], [SN] |
| 0x2B | `balance.trigger_delta` | u16, 1 mV ("balance window") | 0.030 V | rw | [V11] 27, same |
| 0x2C | `jbd.shunt_resistance` | u16, 0.1 mΩ; bit 15 set: 0.01 mΩ ([V11]) | 0.1 mΩ | ro, adv | [V11] 28, [RM], [BT], [SN] |
| 0x2D | fields of section 7.3; register key `jbd.function_config` | bits, section 7.3 | 0x0006 | rw (bits 0..5) | [V11] 29, [RM], [BT], [SBU], [DSB], [SN] |
| 0x2E | `jbd.ntc_enable_1` .. `_8`; register key `jbd.ntc_config` | bit i = NTC i + 1 enabled; a cleared bit switches the temperature protection of that probe off | 0x0007 (NTC 1..3) | rw, adv, danger | [V11] 30, [RM], [BT], [SBU], [SN] |
| 0x2F | `system.cell_count` | u16 | 4 | rw, adv, danger | [V11] 31, [RM], [BT], [SBU], [SN] |
| 0x30 | `jbd.switch_time` | u16, 1 s ("switch control time"; [RM]: "fet_ctrl ???") | 30 s | ro, adv | [V11] 32, [RM], [BT], [SN] (meaning **unverified**) |
| 0x31 | `jbd.led_time` | u16, 1 s ("LED operating time") | not read by the app | ro, adv | [V11] 33, [RM], [BT] (**unverified**) |
| 0x32 | `jbd.soc80_voltage` | u16, 1 mV | 3.400 V | rw | [V11] 34, [RM], [BT], [SBU], [OK], [SN] |
| 0x33 | `jbd.soc60_voltage` | u16, 1 mV | 3.350 V | rw | [V11] 35, same |
| 0x34 | `jbd.soc40_voltage` | u16, 1 mV | 3.300 V | rw | [V11] 36, same |
| 0x35 | `jbd.soc20_voltage` | u16, 1 mV | 3.100 V | rw | [V11] 37, same |
| 0x36 | `jbd.cell_ovp_hw` | u16, 1 mV; second level (hardware) cell overvoltage | 3.900 V | rw, adv, danger | [V11] 38, [RM] covp_high, [BT], [SN] |
| 0x37 | `jbd.cell_uvp_hw` | u16, 1 mV; second level cell undervoltage | 2.000 V | rw, adv, danger | [V11] 39, [RM] cuvp_high, [BT], [SN] |
| 0x38 | `jbd.afe_sc_ocd2`; fields `scp.delay`, `jbd.sc_threshold` (mV), `discharge.ocp2_delay`, `jbd.ocd2_threshold` (mV) | byte pair, AFE dependent (7.5) | 0x8D5C | ro, adv | [RM], [BT], [V11] 40, 41 and chapter "IC type" |
| 0x39 | `jbd.afe_hw_delays`, `scp.recovery` | byte 0 AFE delays (7.5, not shown by ubms), byte 1 short circuit release in s | 0xF064: 100 s | ro, adv | [RM], [BT] (**unverified**) |
| 0x3A | `jbd.charge_utp_delay` (byte 0), `jbd.charge_otp_delay` (byte 1); register key `jbd.charge_temp_delays` | byte 0 undertemperature, byte 1 overtemperature, s; [RM] text "release delay", see below | 2 s, 2 s | ro (byte order and meaning **unverified**) | [RM], [BT], [SBU], [SN] |
| 0x3B | `jbd.discharge_utp_delay`, `jbd.discharge_otp_delay`; key `jbd.discharge_temp_delays` | same for discharge | 2 s, 2 s | ro (byte order **unverified**) | same |
| 0x3C | `jbd.pack_uvp_delay`, `jbd.pack_ovp_delay`; key `jbd.pack_voltage_delays` | byte 0 pack undervoltage, byte 1 pack overvoltage, s | 2 s, 2 s | ro (byte order **unverified**) | same |
| 0x3D | `cell.uvp_delay`, `cell.ovp_delay`; key `jbd.cell_voltage_delays` | byte 0 cell undervoltage, byte 1 cell overvoltage, s | 2 s, 2 s | ro (byte order **unverified**) | same |
| 0x3E | `charge.ocp_delay`, `charge.ocp_recovery`; key `jbd.charge_oc_delays` | byte 0 delay, byte 1 release, s | 10 s, 30 s | rw | same |
| 0x3F | `discharge.ocp_delay`, `discharge.ocp_recovery`; key `jbd.discharge_oc_delays` | byte 0 delay, byte 1 release, s | 10 s, 30 s | rw | same |
| 0x42 .. 0x46 | `jbd.soc90_voltage`, `_70_`, `_50_`, `_30_`, `_10_` | u16, 1 mV | firmware 0x20 and later only | rw if readable (hidden after a refusal) | [OK] (vendor tool writes them on firmware 0x20 / 0x21; status 0x80 on 0x15 / 0x16), [DSB], [JT], [BM] |
| 0x47 | `jbd.soc100_voltage_table` | u16, 1 mV ("100 %", besides 0x12 "full voltage") | same | ro, adv, hidden after a refusal | [OK], [JT] (**unverified** relation to 0x12) |
| 0xA0 | `jbd.manufacturer` | string, max 31 | "DGJBD" | ro | [RM], [BT], [SN] |
| 0xA1 | `jbd.model` | string, max 31 | "JBD-SP04S034-L4S-200A-B-U" | ro | [RM], [BT], [SN] |
| 0xA2 | `jbd.barcode` | string, max 31 | "" | ro | [RM], [BT], [SN], [IEB] |

Ids without a catalog entry (`jbd.*`) bring their own English label. In the vectors, `setting` is the field id of a single value register and the register key of a byte pair or bit field register; `values` (pairs) are keyed by field id, `bits` (0x2D) by short names in bit order, `enabledSensors` (0x2E) lists zero based NTC numbers. The pair registers 0x3A..0x3C have no canonical delay ids for temperature and pack voltage, so they use `jbd.` ids; 0x3D..0x3F map to canonical ids.

Delay bytes are 0..255 s ([BT] `DelayReg`). [V11] lists the same delays as separate 2-byte parameters of the FA mode (44..55), not as byte pairs; the classic registers follow [RM], [BT] and [SBU], whose byte order the captured values do not contradict (**unverified** order for 0x3A..0x3D: every captured pair is 2, 2; the [V11] parameter order 44..51, low before high, agrees). ubms therefore shows 0x3A..0x3D read-only; only 0x3E and 0x3F, whose captured bytes differ (10 s delay, 30 s release) in the documented order, are writable. The implementation review found 0x3D in the same situation as 0x3A..0x3C (captured 2, 2), so it is read-only too.

Meaning conflict for 0x3A..0x3D (**unverified**): [RM] describes them as "Charge over/undertemp release delay", "Discharge over/undertemp release delay", "Pack over/under voltage release delay" and "Cell over/under voltage release delay" (byte 0 "under ... release delay", byte 1 "over ... release delay"), while its own field names (`chgut_delay`, `chgot_delay` ...) and [V11] parameters 44..51 describe protection delays. ubms labels them as protection delays (the catalog ids `cell.uvp_delay`, `cell.ovp_delay` for 0x3D) and keeps them read-only; the field description mentions the release delay reading.

### 7.3 Function configuration (0x2D)

| Bit | Meaning | ubms id | Sources |
| --- | --- | --- | --- |
| 0 | external switch input ("weak current switch function", "hardware switch"); the board then follows the external switch, so on a pack without one the output can stay off | `jbd.switch_input` (rw, adv, danger) | [V11], [RM] "switch", [SBU] `cbEnableHardwareSwitch`, [DSB] `FUNC_SW_EN` |
| 1 | short circuit release by load detection ("wait for load disconnect") | `jbd.load_detect` (rw, adv) | [V11] "short circuit load detection", [SBU] `cbWaitForLoadDisconnect`, [DSB] `FUNC_LOAD_EN`; [RM] "scrl: ?" |
| 2 | balancer enabled | `balance.enabled` (rw) | [V11], [RM], [SBU], [DSB]; the official app toggles exactly this bit (0x0006 and 0x0002, [SN]) |
| 3 | balance only while charging | `balance.charge_only` (rw) | [V11] "charge equalization", [RM] ("balance_en must also be on"), [SBU], [DSB] |
| 4 | LED enable | `jbd.led_enable` (rw, adv) | [V11], [RM], [SBU], [DSB] |
| 5 | capacity LEDs ("LED quantity") | `jbd.led_capacity` (rw, adv) | [V11], [RM], [SBU] |
| 6 | [V11] FCC limit; [DSB] RTC (history recording) | ro | conflict (**unverified**) |
| 7 | [V11] RTC enable; [DSB] EDV (FCC update range) | ro | conflict (**unverified**) |
| 8 | [V11] charging handshake; [DSB] GPS board | ro | conflict (**unverified**) |
| 9 | [V11] GPS function; [DSB] buzzer | ro | conflict (**unverified**) |
| 10 | [V11] buzzer | ro | [V11] only |
| 11 | [V11] start battery mode | ro | [V11] only |
| 12 | current and capacity unit: 1 = 100 mA / 100 mAh / 0.01 mΩ (section 7.6) | `jbd.unit_100ma` (ro) | [V11], [RM] Overkill update |
| 13 | built-in BLE radio power ("currently not used, proposed") | ro | [RM] Overkill update (**unverified**) |

Write the whole word with unknown bits preserved. [SBU] writes only the low byte (`[0x00, value]`), which clears bits 8..15; ubms must not. ubms shows the whole word as read-only hex text `jbd.function_config` (advanced), which covers the disputed bits 6..11 and 13.

### 7.4 Strings and identity

Reads are length prefixed (section 6.6). Writes are disputed: [BT] `StringReg.pack` sends a length byte before the ASCII, [JT] `main.c` and [SBU] (0xA1, 0xA2) send the ASCII without it. ubms keeps 0xA0..0xA2, 0x15, 0x16 and 0x17 read-only; they are factory data.

### 7.5 AFE registers 0x38 and 0x39 (read-only)

The encoding depends on the analog front end chip ([V11] chapter "Short circuit protection delay description ... will be based on the IC type"; chip type read in section 5.1). For the TI family (chip type 0) [RM] and [BT] give:

- 0x38 byte 0: bit 7 RSNS (all thresholds doubled, [RM] "sc_dsgoc_x2"), bits 4..3 short circuit delay 70 / 100 / 200 / 400 µs, bits 2..0 short circuit threshold 22, 33, 44, 56, 67, 78, 89, 100 mV (44 .. 200 mV with RSNS). Byte 1: bits 7..4 secondary discharge overcurrent delay 8, 20, 40, 80, 160, 320, 640, 1280 ms, bits 3..0 threshold 8 .. 50 mV in 16 steps (17 .. 100 mV with RSNS). The doubled tables in the vectors come from the TI data sheet ([TI], **unverified** against a JBD source).
- 0x39 byte 0: bits 7..6 hardware undervoltage delay 1 / 4 / 8 / 16 s, bits 5..4 hardware overvoltage delay 1 / 2 / 4 / 8 s ([RM]; [TI] PROTECT3 has the same layout). [BT] `CxvpDelayParser` decodes the two fields the other way round; **unverified** which is right, the captured 0xF0 sets both fields to 3. Byte 1: short circuit release time in s ([RM], [BT]).
- The threshold in amperes is the voltage divided by the shunt resistance (0x2C): 155 mV / 0.1 mΩ = 1550 A for the SP04S034 (inferred).
- Other chips (types 1..6 of [V11]) use other bit layouts and tables; ubms shows the raw bytes for them.

### 7.6 Units and scaling

- Unit bit 12 of 0x2D set: capacities 0x10, 0x11 and the currents 0x28, 0x29 use 100 mAh / 100 mA, the shunt 0.01 mΩ; the 0x03 answer then uses 100 mA and 100 mAh too ([V11] "current capacity unit description", [RM] Overkill update; **unverified**, no capture of a board with the bit set). ubms shows these four fields scaled by ten and read-only while the bit is set; every write reads 0x2D first and refuses them when the bit is set.
- Temperature registers: raw = round(°C × 10) + 2731 ([BT] `TempParser`, [SBU] `IntToKelvin`).
- 0x29: raw = 0x10000 − round(A × 100) ([V11] 25, [SBU]; vector `tx-write-reg-29-example`).
- Ranges ubms enforces (raw u16 or s16, plus plausibility): cell voltages 1.000 .. 5.000 V, pack voltages up to 655.35 V, temperatures −40 .. 120 °C, charge current 1 .. 327.67 A and discharge 1 .. 327.68 A (s16; ten times the maximum with bit 12; 0 A would make the protection trip on any current), delays 0 .. 255 s, capacities up to 655.35 Ah (6553.5 Ah with bit 12). The plausibility limits are a ubms choice, not a vendor limit.

### 7.7 Recommended ubms schema

Groups and fields (catalog ids where the meaning matches):

- `cell_voltage`: `cell.ovp`, `cell.ovpr`, `cell.ovp_delay`, `cell.uvp`, `cell.uvpr`, `cell.uvp_delay`; advanced: `jbd.cell_ovp_hw`, `jbd.cell_uvp_hw`.
- `pack_voltage`: `pack.ovp`, `pack.ovpr`, `jbd.pack_ovp_delay`, `pack.uvp`, `pack.uvpr`, `jbd.pack_uvp_delay`.
- `current`: `charge.ocp`, `charge.ocp_delay`, `charge.ocp_recovery`, `discharge.ocp`, `discharge.ocp_delay`, `discharge.ocp_recovery`; advanced read-only: `scp.delay`, `jbd.sc_threshold`, `discharge.ocp2_delay`, `jbd.ocd2_threshold` (0x38 decoded with the TI tables) and `scp.recovery` (0x39 byte 1).
- `temperature`: `charge.otp`, `charge.otpr`, `jbd.charge_otp_delay`, `charge.utp`, `charge.utpr`, `jbd.charge_utp_delay`, the same six for discharge.
- `balancing`: `balance.enabled`, `balance.charge_only`, `balance.start_voltage`, `balance.trigger_delta`.
- `capacity`: `capacity.nominal`, `capacity.cycle`, `charge.soc100_voltage`, `jbd.soc90_voltage` .. `jbd.soc10_voltage` (0x32..0x35 and, when readable, 0x42..0x46), `charge.soc0_voltage`, read-only `jbd.soc100_voltage_table` (0x47).
- `controls`: `switch.charge`, `switch.discharge` (section 8.1).
- `system`: `system.cell_count` (danger), `jbd.ntc_enable_1` .. `_8` (danger, like `jk.disable_temperature_sensors` of the JK schema), `jbd.switch_input` (danger), `jbd.load_detect`, `jbd.led_enable`, `jbd.led_capacity`; read-only `jbd.shunt_resistance`, `jbd.switch_time`, `jbd.led_time`, `jbd.self_discharge_rate`, `jbd.unit_100ma`, `jbd.function_config`.
- `identity` (read-only): `jbd.manufacturer`, `jbd.model`, `jbd.barcode`, `jbd.serial_number`, `jbd.production_date`, `jbd.cycle_count`; values kept in the app (section 8.4): `jbd.module_password`, `jbd.module_address` (Bluetooth only), `jbd.bms_password`.
- `actions`: `jbd.reset_capacity`, `jbd.clear_protection` (section 8.3).

Census of the implemented schema (Bluetooth): 56 writable device values (54 EEPROM fields and the two MOSFET switches), 3 values kept in the app, 26 read-only fields, 2 actions. A locked module (section 11.2) shows only the two login fields until the login succeeds. A Daren clone (section 11.4) gets no fields.

Validators (errors, checked on both fields of a pair): recovery below protection for `cell.ovpr` < `cell.ovp`, `pack.ovpr` < `pack.ovp`, `charge.otpr` < `charge.otp`, `discharge.otpr` < `discharge.otp`; recovery above protection for the undervoltage and undertemperature pairs; `cell.uvp` < `cell.ovp`, `pack.uvp` < `pack.ovp`, `charge.utp` < `charge.otp`, `discharge.utp` < `discharge.otp`, `balance.start_voltage` < `cell.ovp` (as in the JK schema). Minimum 1 A for `charge.ocp` and `discharge.ocp` (section 7.6). Warnings: `jbd.cell_ovp_hw` ≤ `cell.ovp` or `jbd.cell_uvp_hw` ≥ `cell.uvp` (the hardware level is meant as a second level, [RM] "secondary"); SOC voltage table not increasing; `capacity.cycle` > `capacity.nominal`; pack limits that differ from cell limit × cell count by more than one cell step; every NTC enable bit of 0x2E cleared (on `jbd.ntc_enable_1`: charge and discharge temperature protection off). The validator set is a ubms choice derived from the meaning in [RM] and [V11].

### 7.8 V11 parameter block mode (0xFA), not implemented

[V11] chapter 5 numbers the parameters 0..183: 0..39 are the registers 0x10..0x37 in the same order; from 40 on the numbering differs from the classic map (40 secondary overcurrent, 41 short circuit, 42 hardware voltage delay, 43 short circuit release, 44..55 the twelve delays as separate words, 56..71 manufacturer, 72..87 BMS code, 88..103 barcode, 104 GPS cut-off voltage, 105 GPS delay, 106..111 SOC voltages 90 / 70 / 50 / 30 / 10 / 100 %, 112 learned capacity 0.01 Ah, 113 correction interval s, 114..120 rated values, 121 minimum detection current mA, 122 sleep time s, 123..157 reserved alarm parameters, 158..169 battery model, 170..175 unique id, 176..183 hardware name). A read is `DD A5 FA 03 p_hi p_lo count cs 77` (up to 95 words), a write `DD 5A FA (2n + 3) p_hi p_lo n words cs 77` inside factory mode. The 2024 module app sent `DD A5 FA 03 00 75 04 FE 8A 77` and got no answer ([SY] issue 94, [SN]). Without one answered capture ubms does not use FA.

### 7.9 Registers not offered

Calibration (0xAD..0xAF, 0xB0..0xCF, 0xD0..0xD7), remaining capacity 0xE0, balancer test 0xE2, reset 0xE3, GPS registers 0x40 / 0x41, internal resistance 0xF6, heater 0xFC: single or tool-only sources, or refused on real boards (section 5.1). Calibration writes change measurements permanently ([RM]); ubms leaves them to the vendor tool.

## 8. Controls and actions

### 8.1 MOSFET switches (0xE1)

- Value u16: bit 0 = 1 switches the charge MOSFET off, bit 1 = 1 the discharge MOSFET off, 0 releases the software switch ([V4] "XX value MOS action", [RM], [BT] `chgDsgEnable`, [DSB] `write_charge_discharge_mos`, [SY] `change_mosfet_status`). Always write both bits: keep the bit of the other MOSFET as last commanded ([BM] `_apply_switch` keeps "what was asked for, not what a protection made it").
- The last command can be stale: another app may have sent `E1 00 00`, or the BMS restarted (whether E1 survives a power cycle is **unverified**, below). ubms therefore reads 0x03 right before every E1 write, in the same exclusive transaction, and derives the bit of the other MOSFET from it (ubms rule): a MOSFET that 0x03 reports on is never commanded off; with protection bit 12 clear nothing is held by E1, so the saved command is dropped and the other MOSFET is released; with bit 12 set and no other protection bit an off MOSFET can only be held by E1, so it stays commanded off whatever the saved command says (ubms rule, **unverified** for all firmware: it assumes a MOSFET never reads off without a protection bit unless E1 holds it; this covers another app that changed E1 while bit 12 stayed set, and a lost or late E1 acknowledgement); with other protection bits set too the saved command decides, and without one an off MOSFET stays commanded off. An E1 write without an answer may have been applied, so ubms then drops the saved command (a refusal by status keeps it). Bit 12 does not say which MOSFET it holds, so with other protection bits set and no saved command a MOSFET held by a protection may be taken for a software switch; ubms then keeps it off (the safe side for the load) and logs the case. The command is kept in the connection options across reconnects.
- State: bits 0 and 1 of the FET byte d20 of 0x03; while a software switch holds a MOSFET off, protection bit 12 is set ([SN]: after `E1 00 01` FET 0x02 and protection 0x1000, vectors `app-ble-rx-basic-charge-locked`, `app-ble-rx-basic-discharge-locked`).
- Sequence used by ubms: read 0x03, enter factory mode, write 0xE1, exit with `00 00`, read 0x03 and compare. The official app writes 0xE1 without entering factory mode and exits with `00 00` afterwards ([SN] six toggles); bms-tools enters factory mode first ([BT]); batmon exits with `28 28` and found that this sequence re-enabled charging after an undervoltage cut-off on firmware 3.2 ([BM] issue 418). Whether the E1 state survives a power cycle is **unverified**.
- A protection can hold a MOSFET off whatever E1 says; report "held by protection" when the read back differs and protection bits other than 12 are set ([BM] `_apply_switch`).
- ubms fields: `switch.charge`, `switch.discharge` (group `controls`, `danger` for switching off).
- syssi derives the balancer switch from the same code path with register 0x2D bit 3, which writes the MOSFET state bits into 0x2D ([SY] `switch/__init__.py` `CONF_BALANCER: [0x2D, 3]`, `change_mosfet_status`); do not copy.

### 8.2 Balancer switch

`balance.enabled` (group `balancing`) = bit 2 of 0x2D, written as in section 7.1 (read 0x2D, set or clear bit 2, write, read back, exit). The official app does exactly this with exit `00 00` ([SN] balancer capture, vectors `app-ble-tx-balancer-on`, `app-ble-tx-balancer-off`); ubms exits with `28 28` like every settings write (section 4.4). The current balancing state of each cell is in d12 / d14 of 0x03. The snapshot reports the switch as `switches.balance` once 0x2D was read in a settings session; ubms has no separate `switch.balance` field for the same bit.

### 8.3 Control command 0x0A

`DD 5A 0A 02 hi lo cs 77`, answer `DD 0A 00 00 00 00 77` ([V11] 6.1 example). Function codes ([V11] table, Chinese original):

| Code | Meaning | ubms | Sources |
| --- | --- | --- | --- |
| 0x0100 | reset capacity: re-estimate the remaining capacity from the voltage table | action `jbd.reset_capacity` (danger) | [V11], [SY] button `force_soc_reset` |
| 0x0200 | clear the protection counters (0xAA) | not offered (vendor document only) | [V11] |
| 0x0300 | restart the microcontroller | not offered | [V11] only; [JT] got status 0x80 for its reset attempts |
| 0x0400 | clear protection and alarm status | action `jbd.clear_protection` (danger) | [V11], [SY] button `clear_alarm` |
| 0x0500 | enter sleep | not offered (link lost) | [V11] |
| 0x0600 | power down, wakes only when charged | never offered | [V11] |
| 0x0700 | automatic balancing mode | not offered (effect **unverified**) | [V11], [SY] button `automatic_balancing` |
| 0x0800 | storage and transport mode | never offered | [V11] |
| 0x0900 | SOC 20 % switch function (discharge off below 20 %) | not offered | [V11] |
| 0x0A00 | force output on below 20 % | not offered | [V11] |
| 0x0B00 | force start in starter battery mode | not offered | [V11] |
| 0x0C00 | forced heating, stops at 15 °C | not offered | [V11] |

0x0A is a V11 command: older boards answer status 0x80 ([JT] capture with code 0x1881). ubms reports "not supported by this BMS" for any non-zero status and never retries. ubms offers only the two codes with two sources ([V11] and the [SY] buttons): 0x0100 and 0x0400, without factory mode, as [SY] sends them. 0x0200 has the vendor document as its only source and is not offered; [RM] and [BT] clear the counters also by leaving factory mode with `28 28` (`clearErrors`, **unverified**).

### 8.4 Passwords

- BMS password (UART level, firmware 0x16 and later): 0x06 "use password" with length byte 6 and the password before factory mode, 0x07 change (length 12, old, new), 0x09 clear with "J1B2D4" ([RM], [BT]). [V11] sends the digits as binary values 0..9 (`06 07 06 05 08 02 08` for "765828"), [BT] as ASCII; **unverified** which one a board expects. The official app sends six zero bytes after every connect and the 2024 app even sends the clear command ([SN]). ubms: never sends 0x07 or 0x09; sends 0x06 only with a password from the connection options when entering factory mode was refused with 0x81, first as ASCII, then as binary digits. A settings read that is refused this way is no error: it returns the values that need no factory mode (MOSFET switches, module address) with a notice and the `jbd.bms_password` field next to it, so the user can enter the password and read again.
- Module password (FF AA, section 4.2): needs the password and the device address; connection options `password` and `address` (a MAC string) for BLE. The app has no connection dialog for them, so the schema offers the same values as settings `jbd.module_password` and `jbd.module_address` (identity group, kept in the target options, never read from the device); the driver logs in as soon as both are known. `jbd.bms_password` (option `bmsPassword`) holds the BMS password of 0x06. Passwords are never returned by the settings read.

### 8.5 Not offered

0xFB (V11 MOSFET command, no capture), 0xFC heater schedule, 0xE0, 0xE2, 0xE3, calibration, the 0x0A codes marked above, module rename (0x07) and module password change (0x16).

## 9. Bits and enumerations

### 9.1 Protection status (0x03 d16)

| Bit | Meaning | Alarm id (severity) | Sources |
| --- | --- | --- | --- |
| 0 | cell overvoltage | `cell_overvoltage` | [V4], [V11], [RM], [SY], [AIO] |
| 1 | cell undervoltage | `cell_undervoltage` | same |
| 2 | pack overvoltage | `pack_overvoltage` | same |
| 3 | pack undervoltage | `pack_undervoltage` | same |
| 4 | charge overtemperature | `charge_overtemperature` | same |
| 5 | charge undertemperature | `charge_undertemperature` | same |
| 6 | discharge overtemperature | `discharge_overtemperature` | same |
| 7 | discharge undertemperature | `discharge_undertemperature` | same |
| 8 | charge overcurrent | `charge_overcurrent` | same |
| 9 | discharge overcurrent | `discharge_overcurrent` | same |
| 10 | short circuit | `short_circuit` | same |
| 11 | front end IC error | `afe_fault` | same |
| 12 | MOSFET switched off by software (0xE1) | `jbd.mos_software_lock` (info) | [V4], [V11], [RM], [SY], [SN] |
| 13 | [V11]: charge MOSFET breakdown; [SY] and [AIO]: "charge timeout close" | `charge_mos_fault` with the label "Charge MOSFET fault or charge timeout" (**unverified**, conflict) | [V11], [SY] `ERRORS`, [AIO] `_PROBLEMS` |
| 14 | [V11]: discharge MOSFET breakdown | `discharge_mos_fault` (**unverified**) | [V11] |
| 15 | reserved | `jbd.protection_bit15` (warning) | [V4], [V11] |

A protection bit stays set until the release condition and delay are met, for example bit 0 until every cell is below the overvoltage release (0x25) ([AIO] `jbd_bms.md` "Cell OV release hysteresis").

### 9.2 Alarm status (V11 tail +1)

Bits 0..11: cell high voltage, cell low voltage, pack high voltage, pack low voltage, charge high temperature, charge low temperature, discharge high temperature, discharge low temperature, charge high current, discharge high current, cell voltage difference, low capacity; 12..15 reserved ([V11] note 2, "not used normally"). ubms maps them to the alarms of 9.1 with severity `warning`, bit 10 to `cell_voltage_difference` and bit 11 to `soc_low` (**unverified**: zero in every capture).

### 9.3 FET and control status (0x03 d20)

| Bit | Meaning | Sources |
| --- | --- | --- |
| 0 | charge MOSFET on | [V4], [V11], [RM], [SN] |
| 1 | discharge MOSFET on | same |
| 2 | current limiting module on | [V11] (**unverified**) |
| 3 | heating on | [V11]; [SY] uses bits 3 or 4 (`JBD_MOS_HEATING = 0x18`) (**unverified**) |
| 4 | heating per [SY] only | [SY] (**unverified**) |
| 6 | "factory mode" per [SY] `OPERATION_STATUS` | contradicted: d20 stayed 0x03 while the official app was in factory mode ([SN] V1.3 capture) |
| 7 | 100 mA / 100 mAh unit (section 6.2) | [V11] (**unverified**) |

A self heating pack reported FET 0x03 while its app showed heating ([BH] issue 536, vector `self-heating-ble-rx-basic-charging-balancing`); the heating bit is therefore not reliable. The Daren clone sends 0x0B ([BH] issue 795). ubms maps only bits 0 and 1 (switches) and shows the whole byte as the snapshot extra `fetStatus` (hex), so reports can resolve the disputed bits later.

### 9.4 Balance bits

Bit 0 of d12 is cell 1 ([V4], [V11], [RM], [SY], [BM] issue 283). One Gentai UP16S pack with firmware 0x0A flagged the mirrored cells (bit 0 = cell 16) in three logs ([AIO] issue 328); the library kept the documented order. ubms keeps it too (**unverified** firmware quirk).

### 9.5 Production date

u16: day = raw AND 0x1F, month = (raw >> 5) AND 0x0F, year = 2000 + (raw >> 9) ([V4], [V11], [RM], [BT] `DateParser`). 0x2C7C = 2022-03-28. The vendor example text writes 0x2028 where it means 0x2068 ([V4]). A raw value 0 (Daren clone) is no date.

### 9.6 Software version

d18: high nibble major, low nibble minor; 0x10 = 1.0, 0x80 = 8.0, 0x44 = 4.4 ([V4], [V11], [SY], [AIO] `_fetch_device_info`). Firmware 0x16 and later support the BMS password ([RM]).

### 9.7 Temperatures

°C = (raw − 2731) / 10, raw in 0.1 K ([V4], [V11], [RM]); −30.0 °C is 2431 (vector `overkill-ble-rx-basic-cold-probe` from [OK]). Writes: raw = °C × 10 + 2731.

### 9.8 Module result codes (FF AA)

| Command | 0x00 | 0x01 | 0x02 | Sources |
| --- | --- | --- | --- | --- |
| 0x15 app key | accepted, password required | rejected | accepted, no password set | [SY] `handle_auth_response_`; [AIO] expects 0x00 as success (**unverified** meaning of 0x02 beyond [SY]) |
| 0x16 change password | accepted | | | [SY] communications2.txt |
| 0x18 password | accepted | rejected | | [SY], [SN] |
| 0x1D root password | accepted | | | [SY], [SN] |

### 9.9 UP series bits

- Protection (status offset 24, bit 0 first): cell overvoltage, cell undervoltage, pack overvoltage, pack undervoltage, charge overcurrent 1, charge overcurrent 2, discharge overcurrent 1, discharge overcurrent 2, charge overtemperature, charge undertemperature, discharge overtemperature, discharge undertemperature, MOSFET overtemperature, ambient overtemperature, ambient undertemperature, voltage difference, temperature difference, SOC low, short circuit, cell offline, temperature drop, charge MOSFET fault, discharge MOSFET fault, current limiting fault, aerosol fault, full charge protection, AFE communication fault ([SY] `PROTECT`, [DSB] `parse_protection_and_alarms` "fault_flags" with the same 27 bits; **unverified**, zero in the captures). Bit 27 reverse protection: [DSB] only (**unverified**), alarm `jbd.up_reverse_protection`.
- These bits are fault flags, so ubms reports each of them as a protection (`protection` severity) or, for the fault bits (cell offline, temperature sensor, MOSFET, current limiting, aerosol and AFE faults), as `fault`, whatever the catalog default of the alarm id (a warning for ambient temperature, voltage and temperature difference and SOC low).
- Alarms (offset 28): cell overvoltage, cell undervoltage, pack overvoltage, pack undervoltage, charge overcurrent, discharge overcurrent, charge overtemperature, charge undertemperature, discharge overtemperature, discharge undertemperature, MOSFET overtemperature, ambient overtemperature, ambient undertemperature, voltage difference, temperature difference, SOC low, EEPROM fault, RTC fault ([SY] `ERRORS`, [DSB]; **unverified**). Bit 18 "full charge protection 2": [DSB] only, with the comment that it "appears to be always in the same state as full_charge_protection_1" (protection bit 25); ubms reports it as `jbd.up_full_charge` with `warning` severity when the protection bit is not set (**unverified**).
- Operation status 0 idle, 1 charging, 2 discharging; MOSFET bits section 6.10 ([SY]).

## 10. Device information

| `DeviceInfo` field | Source in the protocol | Sources |
| --- | --- | --- |
| vendor | "JBD" | |
| model | 0x05 string; fallback the advertised name | [V4], [SY], [AIO] `hw_version` |
| softwareVersion | 0x03 d18 as "major.minor" | [V4], [AIO] `sw_version` |
| manufactureDate | 0x03 d10 (no factory mode needed) | [V4] |
| serialNumber | barcode 0xA2, else register 0x16 when not 0 (factory mode, after a settings read) | [RM], [SN] (both empty on the captured units) |
| powerOnCount | restart counter of 0xAA (d22), when present | [V11] (**unverified**, section 6.5) |
| extras | manufacturer 0xA0 ("DGJBD"), cell count, NTC count, the eleven protection counters of 0xAA; Device Information service 0x180A over BLE (Liontron: firmware "F080.001", software "F000.062", not read by ubms) | [RM], [SN], [SY] issue 245 |

Read the factory mode fields only when the user opens the settings or device information, not during detection.

## 11. Detection

### 11.1 Bluetooth scan

- Chooser filters: service 0xFF00 (advertised by every JBD module in [AIO] test data, including those named by model code such as `SP04S034L4S200A`) and the distinctive name prefixes `JBD-`, `xiaoxiang`, `SBL-`, `LSG-`, `OGR-`, `SX1`, `SX60`, `TITAN-`, `TZ-H`, `ECO-LFP`, `@KsM:` ([AIO] `matcher_dict_list` patterns, test data). Short prefixes such as `SP` or `LT` would list unrelated devices; model codes are matched by the ranking patterns instead. `optionalServices`: 0xFF00, 0xFFF0.
- Ranking patterns: `/^(JBD-|xiaoxiang)/i`, `/^(SP|DP|AP|UP)\d{2}S\d{3}/` (model codes), `/^(SBL-|LSG-|OGR-|TITAN-|TZ-H|SJ-\d{3}-|SX(1|60)|ECO-LFP)/`, `/^(12|24)\d{3}BL/`, `/^[JN]-\d{5}[YB]/` ([AIO] patterns "12???BL*", "24???BL*", "J-?????Y*", "N-?????BL*"). Names starting with `DWF` are Daren clones ([AIO] `daren_bms.py`), names `DL-` and `JHB-` are Daly ([daly.md](daly.md) section 11.1).
- Address prefixes 70:3E:97, A4:C1:37, A4:C1:38, A5:C2:37, A5:C2:39, A5:C2:3A, AA:C2:37, A2:C2:37, 10:A5:62 belong to JBD modules ([AIO] `matcher_dict_list` OUIs); Web Bluetooth does not expose them, Tauri can use them for ranking.
- Manufacturer company ids are not usable (section 2.1).
- Other families behind 0xFF00: Daly modules (fallback layout C, [daly.md](daly.md) section 2.1) and Daren clones. Behind 0xFFF0: Daly (primary) and the JBD-DH04SC02.

### 11.2 Bluetooth probe

1. Start notifications on 0xFF01 (or 0xFFF1 on the 0xFFF0 layout).
2. Send `DD A5 03 00 FF FD 77` (read-only). Wait 1.5 s. On no answer send it once more (sleep, section 2.2).
3. Accept when an answer `DD 03 00 n ... 77` arrives with a valid checksum and passes: n ≥ 23; 1 ≤ cells (d21) ≤ 32; N = d22 ≤ 16 and 23 + 2N ≤ n; SOC (d19) ≤ 100. A board without cells connected passes with voltage 0 (vector `sp25s003-uart-rx-basic-bench`). The temperatures are no acceptance rule, neither in the detection nor in the polling: one open or shorted NTC (raw 0 is −273.1 °C) would otherwise keep the pack from connecting, from reconnecting after a lost link (every reconnect runs the probe) or stop the monitoring (ubms rule; the framing, checksum, cell count, NTC count and SOC identify the frame). Such a reading is left out of the snapshot and reported as `temperature_sensor_fault` with the probe number (ubms policy).
4. On silence, on the FF00 layout only: send the app key `FF AA 15 06 30 30 30 30 30 30 3B` once. The FF AA login is known from FF00 modules only, and FFF0 is the default layout of Daly, so ubms does not send the app key on FFF0 (a ubms choice that keeps the cost for a Daly device on FFF0 at two reads). An answer `FF AA 15 01 rr cs` identifies a JBD module: rr 0x02 means no password, repeat step 2; rr 0x00 means the module needs the login of section 4.2: return the probe result `JBD` with `locked: true` so the session can ask for password and address (implementation: the probe result carries `locked: true`, polls publish one alarm `jbd.module_locked` with the reason, and the settings show the login fields; with `password` and `address` already in the options the probe runs the login itself). syssi sends the same frame as its password probe ([SY] `update`). An echo of the app key frame means a module that needs BLE pairing ([SY] issue 245, **unverified**: one report, a LIONTRON 4S pack advertising its serial number "0521150067"). A transparent BLE UART bridge with loopback would echo too and must not keep the Daly drivers behind FF00 (section 11.1) from probing, so ubms takes an echo as JBD (locked, reason "pairing") only when the advertised name matches the JBD prefixes or ranking patterns of section 11.1, a Liontron name (`LT` followed by a digit, `LISMART`), `DWF`, or is a bare serial number of at least six digits as in the report; otherwise the probe returns no result.
5. Otherwise not JBD.

Login outcomes (section 4.2): only a rejection by the module (result 0x01 to the password or a non-zero root result) marks the credentials as wrong, and they are not retried until the user changes them. An unanswered login step (weak link) keeps the module locked with the reason "not answered" and the polls retry it: the next poll at once, then after 1, 2, 3 and finally every 4 skipped polls (ubms policy).

What the probe writes: two 7-byte read requests and at most one app key frame (FF00 only). None of them changes the BMS: 0x03 is a read, the app key only opens the module session ([SY], [SN]). The probe never enters factory mode and never sends 0x06.

### 11.3 Serial probe

9600 8N1. Send `DD A5 03 00 FF FD 77`, wait 0.5 s, repeat once after the wake-up (section 2.2), validate as in 11.2 step 3 (structural rules only, no temperature range). The request is ignored by the other families: Daly expects `A5 <address> ...` with address 0x40 / 0x80 and a fixed 13-byte frame (the `A5 03 00 FF FD 77` tail is not a valid Daly frame), JK UART expects `4E 57`, ANT `5A 5A` or `DB DB`, a Modbus device sees address 0xDD with the unknown function 0xA5 ([daly.md](daly.md), [jk.md](jk.md), [ant.md](ant.md); inferred, **unverified** on real devices).

### 11.4 Rejecting foreign devices

- Daly modules on 0xFF00 or 0xFFF0 answer only Daly frames; the JBD probe times out (3 s with the repeat). A Daly answer that happens to arrive starts with 0xA5 or 0xD2 and never passes the `DD 03 00` check ([daly.md](daly.md) section 3).
- A Daren clone passes the JBD probe; ubms accepts it as `JBD` with `variant` `DAREN` when its name starts with `DWF` (during the probe) or its 0x03 tail does not fit section 6.2 (bytes after the NTC words that are no V11 tail by the consistency rule) and 0x05 returns 0x80 (when the device information is read after connecting) (vectors `daren-ble-*`). From then on the driver only monitors (section 1.3): no factory mode, no 0xE1, no 0x0A, because no source documents them on Daren clones ([AIO] `daren_bms.py` `_VALID_CMD` 0x03, 0x04, 0x05, 0x08, 0xFF; [BH] issue 795 shows reads only).
- A JBD UP pack on RS485 never answers `DD` frames ([SY], [DSB]); it is found by its own probe.

### 11.5 UP series probe (jbd-up-rs485)

For the configured address (default 1): send `addr 78 10 00 10 A0 00 00 crc_lo crc_hi` (vector `up16s-rs485-tx-status-addr1`), wait 1 s, accept an answer with the same address, function 0x78, start 0x1000, a valid CRC, data length ≥ 70 and a cell count of 1..32 at offset 66. The request is a read. Other families: a `DD` BMS ignores frames that do not start with 0xDD; Modbus devices see the unknown function 0x78.

### 11.6 Variant

`variant` = `JBD` (classic, extended tail optional), `DAREN`, or `JBD_UP`. Flags kept by the driver: `extendedTail` (section 6.2), `unit100mA`, `moduleLogin` (FF AA used), `factoryModeRequired` (0x81 seen), `chipType` when read.

## 12. Pitfalls and quirks

1. The checksum of acknowledgements is 0x0000; a check without the 16-bit mask rejects every write answer (section 3.3).
2. 0x77 occurs inside data; frame by the length byte, not by the end byte (section 3.5).
3. Basic information is split over two or more BLE notifications; long frames exceed the 41-byte buffer of syssi (section 3.5).
4. Answers can be 6 to 14 s late; a blind retry produces duplicate answers that corrupt naive buffers ([BH] issue 872).
5. The first request after a pause is often lost (sleep); repeat once before giving up ([V11], [IEB], [SN]).
6. The bms-tools register map has the 0x03 offsets after d16 one byte early; use the Overkill corrected map ([RM]).
7. Current is signed, capacities are unsigned (0xDAC0 = 560.00 Ah) ([BM] issue 60).
8. The vendor examples contain arithmetic slips: 0x48 is 72 %, not 80 %; 2968 − 2731 is 23.7 °C, not 24.7 °C; 0x2028 in the date text is 0x2068 ([V4], [V11]).
9. Units can be 100 mA / 100 mAh; the flag location is disputed (section 6.2); a Fogstar 628 Ah pack read ten times too small without it ([BH] issue 834).
10. EEPROM registers need factory mode on current firmware (status 0x81 otherwise); always leave factory mode, also after errors ([BM] `force_disconnect` comment "would stay in factory mode").
11. Exit with `00 00` does not persist settings on every firmware; bms-tools fixed lost settings by exiting with `28 28` ([BT] CHANGELOG v1.1.2).
12. Discharge overcurrent 0x29 is stored negative; SmartBMSUtility computes it as (0xFFFF − value) + 1, which equals 0x10000 − value ([SBU]).
13. Writing 0x2D with only the low byte (as [SBU] does) clears bits 8..15, including the unit bit 12.
14. syssi's balancer switch writes MOSFET bits into 0x2D (section 8.1); the official app toggles bit 2.
15. The 2024 Bluetooth module ignores `DD` frames until the FF AA login when a password is set; the login needs the device address, which Web Bluetooth hides (section 4.2).
16. The official 2024 app sends "clear BMS password" (0x09 "J1B2D4") on every connect, so the BMS password offers no protection on such packs ([SN], [RM] "you can always clear the password").
17. Some modules require BLE pairing with passkey instead of the FF AA login, and echo the app key frame ([SY] issue 245).
18. syssi's documented check of the password cipher uses `% 255`; the cipher uses AND 0xFF (section 4.2).
19. Protection bit 13 means "charge MOSFET breakdown" in [V11] but "charge timeout" in syssi and aiobmsble.
20. The heating bit of d20 is not reliable (section 9.3).
21. Balance bits may be mirrored on some firmware ([AIO] issue 328).
22. The NTC count must be checked against the data length; a wrong count created hundreds of phantom sensors in batmon ([BM] issue 321).
23. 0x04 may carry a 0 mV cell (a real reading); do not treat it as missing, and do not create zeros from truncated frames ([BM] issue 388).
24. Older boards refuse 0x42..0x47 and the V11 commands with status 0x80 ([OK], [JT]); hide those fields instead of failing the settings screen.
25. String writes are encoded differently by the tools (section 7.4).
26. UP series packs do not speak the `DD` protocol at all, and slaves report firmware 0.4 through the master ([DSB], [SN]).
27. Several packs on one UART need galvanic isolation ([SY] README).
28. The vendor V11 renamed the MOSFET command to 0xFB, but every captured app still uses 0xE1 ([V11], [SN]).
29. A late acknowledgement `DD r 00 00 00 00 77` matches a later read of the same register by the register byte alone; match reads only with data or a refusal, writes only without data (section 3.5).
30. Factory mode can be entered although its acknowledgement was lost; send `00 00` after an unanswered enter request ([BM] `_fetch_device_info`), and close a transaction that could not be closed on the next occasion (section 4.4).
31. The MOSFET command remembered from an earlier write is stale after another app or a power cycle changed 0xE1; read 0x03 before every E1 write (section 8.1).
32. A tail after the NTC words is not always the V11 tail: Daren clones put temperatures, state of health and more there (section 6.2).

## 13. References

All sources read 2026-11-18 and 2026-11-19 from local copies; commit hashes where the copy recorded one.

[V4] Jiabaida "Smart BMS protocol V4" / "Jiabaida Software Board General Protocol V4": https://github.com/syssi/esphome-jbd-bms/blob/4eea180b18e357b8cab244ab301c3b5030bd6c6b/docs/Jiabaida.communication.protocol.pdf; https://github.com/FurTrader/OverkillSolarBMS/blob/adfb7d528f764b3258ad995a7a2217f8af1228e3/Comm_Protocol_Documentation/JBD%20Protocol%20English%20version.pdf; Archive/BMS communication protocol (original language and translated to english).pdf in the same repository. Sections: frame structure, 0x03, 0x04, 0x05, control MOS 0xE1, protocol data description.

[V11] "JBD comm protocol 20230321 V11" (Chinese original "软件板通用协议V8" with revision history up to V11) and its English translation: https://github.com/FurTrader/OverkillSolarBMS/blob/adfb7d528f764b3258ad995a7a2217f8af1228e3/Comm_Protocol_Documentation/JBD_comm_ptotocol_20230321_V11.pdf and Translated_to_english_JBD_comm_ptotocol_20230321_V11.pdf. Chapters 1 (physical interface, sleep), 2 (frame, CALLBACK_ID, status codes), 3.1 to 3.4, 4 (0xFB), 5 (0xFA, factory mode, parameter table, function configuration, NTC configuration, AFE tables), 6.1 (0x0A), 7 (0xF6), 8 (passwords), 9 (chip type), 10 (0xFC), 11 (examples), 12 (revision history).

[RM] Eric Poulsen, "JBD BMS serial interface and register map", with the Overkill Solar update of 2023-12-12 and 2024-05-07: https://gitlab.com/bms-tools/bms-tools/-/blob/master/JBD_REGISTER_MAP.md and https://github.com/FurTrader/OverkillSolarBMS/blob/adfb7d528f764b3258ad995a7a2217f8af1228e3/Comm_Protocol_Documentation/JBD_REGISTER_MAP.md (passwords 0x06 / 0x07 / 0x09, factory mode, stored registers, 0x2D bit 12 details).

[BT] bms-tools (Eric Poulsen), https://gitlab.com/bms-tools/bms-tools: bmstools/jbd/jbd.py (`eeprom_regs`, `chksum`, `enterFactory`, `exitFactory`, `_sendPassword`, `setPassword`, `clearPassword`, `readEeprom`, `writeEeprom`, `clearErrors`, `calCell`, `calNtc`, current calibration, `chgDsgEnable`, `_balTestWrite`, `setPackCapRem`), registers.py (`DelayReg`, `ScDsgoc2Reg`, `CxvpHighDelayScRelReg`, `StringReg`, `BasicInfoReg`), parsers.py (`ScParser`, `Dsgoc2Parser`, `CxvpDelayParser`, `DateParser`, `TempParser`), enums.py, CHANGELOG.md.

[OK] Overkill Solar, https://github.com/FurTrader/OverkillSolarBMS/tree/adfb7d528f764b3258ad995a7a2217f8af1228e3: Comm_Protocol_Documentation/BLE _bluetooth_protocol.md (FF00 / FF01 / FF02, module rename FF AA 07, checksums, basic info example), Capacity_parameter_registers.md (0x42..0x47, 0x80 answers), README.md.

[SY] syssi/esphome-jbd-bms, https://github.com/syssi/esphome-jbd-bms at 4eea180b18e357b8cab244ab301c3b5030bd6c6b: components/jbd_bms_ble/jbd_bms_ble.cpp (constants L24-L95, `send_app_key_` L186, `request_random_byte_` L205, `send_user_password_` L218, `send_root_password_` L241, `assemble` L284, `handle_auth_response_` L355, `update` L434, `on_basic_info_data_` L567, `on_error_counts_data_` L683, `on_hardware_version_data_` L710, `change_mosfet_status`, `build_frame_`), jbd_bms_ble.h (UUID defaults, `auth_chksum_`), `__init__.py` (UUID options, password validation, `auth_timeout`), switch/button/select `__init__.py`; components/jbd_bms/jbd_bms.cpp (`INTER_FRAME_DELAY_MS`, `parse_jbd_bms_byte_`), jbd_bms.h (`rx_timeout_`); components/jbd_bms_up/jbd_bms_up.cpp (`crc16`, `parse_byte_`, `build_frame_`), components/jbd_bms_up_pack/jbd_bms_up_pack.cpp (`ERRORS`, `PROTECT`, `on_pack_status_`); tests/components/jbd_bms_ble/frames.h, write_command_test.cpp, tests/components/jbd_bms_up/request_frame_test.cpp, write_frame_test.cpp, tests/components/jbd_bms_up_pack/frames.h; docs/pdus/*.txt, docs/debug.txt, docs/ffaa-auth-flow/*.txt; README.md (supported devices, wiring, multiple BMS warning); esp32-example.yaml, esp32-ble-dh04sc02-example.yaml, esp32-up-example.yaml; issues 4, 14, 20, 67, 81, 94 (comments 2324791446, 2325146392, 2336755514, 2336756656, 2337850041, 2365235210), 145, 245.

[SN] Own decode (tool `btsnoop.mjs` in the research scratch area, ATT writes and notifications) of the btsnoop files in [SY]: docs/btsnoop_hci_jbd-sp04s034-l4s-200a-b-u.log (official app: full EEPROM read in factory mode, protection counters), docs/pdus/btsnoop_hci-mosfets-onoff.log (MOSFET toggles), docs/pdus/btsnoop_hci-balancer-onoff.log (ATT discovery, balancer toggles via 0x2D, factory mode), docs/ffaa-auth-flow/JBD-SP04S034L4S200A-V1.3-btsnoop_hci.log and JBD-SP04S034L4S200A-btsnoop_hci.log (FF AA login, 0x81 outside factory mode, chip type and FA requests without answer).

[AIO] patman15/aiobmsble, https://github.com/patman15/aiobmsble at b99834fdbbaeb9253e746449ee37cef5b97a15cb: aiobmsble/bms/jbd_bms.py (`matcher_dict_list`, `_init_connection`, `_notification_handler`, `_crc`, `_async_update`, `_FIELDS_D10`), aiobmsble/bms/daren_bms.py (`_VALID_CMD`, `_FIELDS` with the extended frame offsets), aiobmsble/test_data/jbd_bms.json (43 advertisements), tests/bms/test_jbd_bms.py (Fogstar frame), jbd_bms.md; issues 154, 248, 302, 328.

[BH] patman15/BMS_BLE-HA issues 536 (self heating), 562, 593, 778, 795 (Daren clone), 834 (Fogstar units), 857, 872 (late answers).

[DSB] mr-manuel/venus-os_dbus-serialbattery at 99833373ffcf442e61800805393c1118db093bdf: dbus-serialbattery/bms/lltjbd.py (register constants, `FUNC_*`, `checksum`, `get_settings`, `write_charge_discharge_mos`, `write_balancer`, `read_gen_data`, `__enter__`, `__exit__`), lltjbd_ble.py (UUIDs, `_detect_uuids`), lltjbd_up16s.py (UP protocol, `PackStatus`, `PackParams1`, `PackParams2`, `ProductInformation`, `SetSoc`, `IndividualPackStatus`, `calc_crc16`, `parse_protection_and_alarms`).

[BM] fl4p/batmon-ha at 86ea0cbfa913bf39df9c2c830e06a3382a8e2324: bmslib/models/jbd.py (`_validate_jbd_response`, `_JBD_SETTING_NAMES`, `_notification_handler`, `_fetch`, `_fetch_device_info`, `_apply_switch`), jbd_hv_uart.py, test/data/jbd_fixtures.py; issues 60, 75, 82, 110, 203, 217, 283, 321, 388, 418.

[JT] sshoecraft/jbdtool at d8096223bf5e3e3816fa1294ee9a1c4d240f1228: main.c (parameter table, string write), jbd_info.c (`jbd_reset` with the refused 0xE3 and 0x0A frames), serial.c.

[SBU] NeariX67/SmartBMSUtility at 75e89c0a7f8088f5099176cd3b1afc63f923be41: BluetoothInterface.swift (UUIDs, factory mode frames), ConfigurationController.swift (register writes, 0x29 encoding, 0x2D and 0x2E bits, string writes).

[IEB] ieb/N2KNMEA0183Wifi at 9d952a89b7ec2a69bc54c86169401b8ff9ad174f: lib/jdbbms/SnoopOnBTAdapter.md (UART snoop between the Bluetooth module and an SP04S060: levels, sleep, power-up and connect sequences), lib/jdbbms/jdb_bms.cpp.

[TI] Texas Instruments, bq76920 / bq76930 / bq76940 data sheet, registers PROTECT1, PROTECT2, PROTECT3 (not cached; used only for the RSNS tables of section 7.5, **unverified** for JBD).
