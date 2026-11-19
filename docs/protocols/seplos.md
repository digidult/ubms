# Seplos BMS (protocol V2.0 ASCII, V2 Bluetooth, BMS 3.0 Modbus RTU)

Implementation reference for the ubms Seplos drivers: the Seplos BMS 1.0 / 2.0 generation (EMU10xx / EMU11xx boards such as 1101-SP15, 1101-SP76, 1101-ZA11, "10C" and "10E" packs) with its ASCII framed RS485 / RS232 protocol "V2.0" (`~20 00 46 42 ...`, YD/T 1363.3 style) and its binary Bluetooth module protocol (`7E 10 00 46 61 ...`, CRC-16/XMODEM), and the Seplos BMS 3.0 generation (48100 and 48200 boards, "V3", also branded XZH / Xinzhiheng) with Modbus RTU on RS485 and on its Bluetooth module (PIA 0x1000, PIB 0x1100, PIC 0x1200, SPA 0x1300, SFA 0x1400, SCA 0x1500, VIA 0x1700, PCT 0x1800, EIA 0x2000, EIB 0x2100, EIC 0x2200).

Compiled 2026-11-19 from the vendor documents, the vendor PC tool's protocol definition file, a decompilation of the BMS 3.0 firmware, the source code and tests of the open-source projects listed in section 13, and captures published by users. Every statement carries a source tag. **unverified** marks a value that has a single weak source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/seplos.json` (118 frames: 24 V2 ASCII, 35 V2 Bluetooth, 59 V3 Modbus RTU). `variant` is `SEPLOS_V2_ASCII`, `SEPLOS_V2_BLE` or `SEPLOS_V3_MODBUS`; `link` is `rs485` when the cited sources used a wired port (RS485 or RS232) and `ble` when they used the Bluetooth module. Keys in `expected` are named in `code` in this document and are in model units (V, A, Ah, °C, %, s, ms) unless the key says otherwise (`dischargedAh` in Ah, `softStartDelayMs` in ms, `reservedTemps` raw). Frame header keys: `ver`, `adr`, `cid1`, `cid2` (requests), `cid`, `rtn` (V2 Bluetooth answers), `length` (raw LENGTH field), `lenid`, `chksum` (V2 ASCII), `crc` (CRC as transmitted, read as a big-endian number for V2 Bluetooth and as the Modbus low-byte-first number for V3), `address`, `function`, `byteCount`, `start`, `count`, `exception` (V3). Every vector was checked with a node script: framing, LENGTH / LCHKSUM / CHKSUM (V2 ASCII), length and CRC-16/XMODEM (V2 Bluetooth), byte count and Modbus CRC (V3), an independent decode compared field by field with `expected`, and, for frames copied from a source, presence of the exact bytes in the cached copy of that source. 17 frames are not copies: 12 are constructed with the cited code or register table (their description starts with "Constructed") and 5 are repaired from a log that replaced the bytes 0x0A and 0x0D by 0x5C (description "repaired", key `repaired: true`; exactly one substitution gives a valid CRC).

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

- Three protocols are described; section headings say which one: **V2 ASCII** (wired V2.0 protocol), **V2 BLE** (Bluetooth module of the V2 boards), **V3** (BMS 3.0 Modbus RTU, wired and Bluetooth).
- Offsets are decimal with hex in parentheses where useful. V2 ASCII offsets are byte offsets into the decoded INFO field (every two ASCII hex digits are one byte, section 3.1). V2 BLE offsets are byte offsets from the start byte 0x7E of the frame unless a table says "DATA offset". V3 offsets are register addresses; byte offsets inside a Modbus answer count from the first data byte after the byte count.
- Types: u8, u16, s16, u32, s32; all multi-byte values are big-endian unless a row says otherwise. V3 32-bit values in EIA are sent low word first (section 6.3.8).
- Scale: physical value = raw × scale. Temperatures marked "0.1 K" are °C = (raw − 2731) / 10 ([V2PDF] table 9, [BLEPDF] table 5, [XZH] section 3). Some sources use 273.15 instead of 273.1 (section 12).
- Current sign: positive while charging, negative while discharging, in every protocol ([V2PDF] table 9 "signed integer", [SY] tests: −6.76 A while discharging, [SYP2] +27.56 A with system state "charge", [XZH] 0x1001 INT16).
- Source tags (details in section 13): [V2PDF] SEPLOS BMS Communication Protocol V2.0 (2019-10-15); [V2EN] Seplos 48V 100A BMS RS485 Protocol (MODBUS-ASCII, EMU10XX); [MAN100] Seplos 48V 100A BMS specification 2020-05-28; [MAN200] Seplos 48V 200A 8S-16S BMS manual; [BLEPDF] Seplos Bluetooth communication protocol V2.0 (2022-09-08); [BSX] the vendor PC tool's protocol definition `16S_V20_ADDR_EN.xml` (published by [IC]); [XZH] XZH BMS Modbus-RTU Protocol V0.3, community translation of the Chinese edition with notes from Seplos (October 2026), and [XZHEN] the official English edition of V0.3 (2024-11-28); [S30] SEPLOS-3.0 RS485 BMS Modbus RTU Protocol V0.1 (2023-02-09); [MR] marcelrv/seplosBMSv3 (tables extracted from the vendor app BMS Studio); [SO] abedegno/SeplOSS, a byte-identical decompilation of the BMS 3.0 firmware V1.43l; [SY] syssi/esphome-seplos-bms (code, tests, README); [SYP2] its Bluetooth capture `docs/pdus/v2/btsnoop_hci_1101-10E-SP76-16S.log` (official app, pack named BP00); [SYP3] its V3 Bluetooth logs `docs/pdus/v3/SG16S200A-SP57B-A-all-frames.txt` and `SP05B2312190075-*.txt`; [AIO] patman15/aiobmsble `seplos_v2_bms.py`, `seplos_bms.py` and tests; [IC] ichernev/seplos-bms-tool (captures of the vendor PC tool in `notes.md`, `seplos.py`); [DSB] mr-manuel/venus-os_dbus-serialbattery `seplos.py`, `seplosv3.py`; [BM] fl4p/batmon-ha `seplos_uart.py`; [FL] flip555/bms_connector (V2 constants and the 47H / 51H decoders); [BP] BrucePerens/seplos_c; [PC] Privatecoder/seplos-mqtt-rs485; [PY] Frankkkkk/python-pylontech (for the Pylontech comparison only).

## 1. Overview

### 1.1 Generations and protocols

| Generation | Boards and packs seen | Wired protocol | Bluetooth protocol | Sources |
| --- | --- | --- | --- | --- |
| BMS 1.0 / 2.0 ("V2", "10C", "10E", "V16") | EMU10xx, EMU11xx series; 1101-SP05, 1101-SP15, 1101-SP16, 1101-SP76, 1101-SP101, 1101-ZA11, 1101-ZH26, 1101-MZ02, 1101-10E-SP76-16S, 1101-10E-JK06-16S (Apex 48200) | V2 ASCII on RS485 (and RS232 on some boards) | V2 BLE (module named BP00..BP15) | [SY] README "Supported devices", [IC] notes, [PC] README, [BLEPDF] 1.3.2 |
| BMS 3.0 ("V3", XZH) | 48100 (100 A), 48200 (200 A, hardware V10 and V11); SG16S200A-SP57B-A, BMS16S200A-SP05B, B-48200-C | V3 Modbus RTU on RS485 | V3 Modbus RTU over the Bluetooth module | [SO] README, [SY] README, [SYP3], [XZH] |

Notes:

- The same ASCII framing (`~` VER ADR CID1 CID2 LENGTH INFO CHKSUM CR) is used by Pylontech, Pace and Boqiang batteries; only the INFO layouts and the VER byte differ ([BM] module docstring, [PY], [SY] README "Boqiang ... protocol_version: 0x26"). Section 11.2 says how to reject them.
- The V2 BLE protocol is not the V2 ASCII protocol carried over Bluetooth: it is binary, has its own commands (0x61, 0x62, 0x63, 0x64, 0x65) and CRC-16/XMODEM ([BLEPDF] sections 2 and 3). Only the 0x47 parameter block, the 0xA1 parameter write and the alarm bit meanings are shared (sections 6.1.3, 6.2.4, 9.2).
- The BMS 3.0 Bluetooth module is a UART bridge into the same Modbus server as the RS485 ports ([SO] `bluetooth.c`, `rtu_slave.c`); V3 frames are identical on both links.

### 1.2 Driver definitions (plan)

| id | Protocol | Links | Notes |
| --- | --- | --- | --- |
| `seplos-v2` | V2 ASCII | serial (RS485, RS232) | settings read and write (0x47 / 0xA1), no MOSFET control |
| `seplos-v2-ble` | V2 BLE | BLE FF00 / FF01 / FF02 | settings read and write (0x47 / 0xA1), no MOSFET control |
| `seplos-v3` | V3 Modbus RTU | BLE FFF0 / FFF1 / FFF2 and serial (RS485) | settings read and write (SPA, SFA), MOSFET control (SCA) |

All three: `family: 'seplos'`, `vendor: 'Seplos'`, `deviceType: 'bms'`. Detection and registration order: section 11.

### 1.3 Telling variants apart at runtime

- V2 ASCII or V3 on a wired port: a V2 board answers only frames that start with `~` (0x7E) and end with CR; a V3 board answers only Modbus RTU frames to its address ([V2PDF] 3.1, [XZH] 1.2, [SO] `rtu_slave.c` `Rtu_SlaveReceive`). The two probes cannot be mistaken for each other (section 11.3).
- V2 BLE or V3 BLE: different GATT services (FF00 for V2, FFF0 for V3, section 2.1) and different names (BPxx for V2; the BMS code such as `SP57B-A2506120022` or `XZH_B40_...` for V3, section 11.1).
- PIA current unit on V3: 0.01 A on boards rated 200 A and below, 0.1 A on 300 A and 400 A boards ([XZH] revision V0.2). No register tells the rating; the device name in VIA (for example `SG16S200A-...`) contains it (section 12).

## 2. Physical links

### 2.1 BLE

**V2 BLE** ([SY] `seplos_bms_ble.cpp`, [AIO] `seplos_v2_bms.py`, [SYP2] GATT discovery records 1..38):

| Item | Value | Sources |
| --- | --- | --- |
| Service | 0xFF00, handles 0x000F..0x001A in [SYP2] | [SY], [AIO], [SYP2] |
| Notify characteristic | 0xFF01, properties 0x10 (notify), value handle 0x0011, CCCD 0x0012 | [SY], [AIO], [SYP2] record 24 |
| Write characteristic | 0xFF02, properties 0x0C (write without response, write), value handle 0x0014 | [SY], [AIO], [SYP2] record 24 |
| Other characteristics | 0xFF03 (properties 0x1C), 0xFF04 (properties 0x1E), unused | [SYP2] records 24 and 26 |
| Write mode | the official app writes with response (ATT Write Request) [SYP2]; syssi writes without response | [SYP2], [SY] `send_command` |
| MTU | the app requests 512 (0x0200) and gets 512 | [SYP2] records 37..38 |
| Name | `BPxx`, xx = the decimal DIP address of the pack, BP00..BP15 | [BLEPDF] 1.3.2; [AIO] matcher `BP[0-2][0-9]*`; [SYP2] "BP00" |
| Pairing | none | [SYP2] (no SMP traffic), [BLEPDF] |

The Daly driver uses the same FF00 / FF01 / FF02 layout as its second profile (see [daly.md](daly.md) section 2.1), and the JBD driver uses it as its default layout ([jbd.md](jbd.md) section 2.1); service UUIDs cannot tell Daly, JBD and Seplos V2 apart (section 11).

**V3 BLE** ([SY] `seplos_bms_v3_ble.cpp`, [AIO] `seplos_bms.py`):

| Item | Value | Sources |
| --- | --- | --- |
| Service | 0xFFF0 | [SY], [AIO] |
| Notify characteristic | 0xFFF1 (read, notify) | [SY], [AIO] comment "char fff1 (#16): ['read', 'notify']" |
| Write characteristic | 0xFFF2 (read, write without response, write) | [SY] (writes without response), [AIO] comment |
| Module | an AT command module on USART3 of the BMS; the firmware sets ROLE=1, SLEEPEN=1, RFPOWER=16, its name and ADVEN, and turns advertising off on packs that are not the first or only pack of a bank | [SO] `bluetooth_at.c`, `bluetooth.c` (`Bluetooth_Hide`) |
| Name | the stored BMS code (up to 22 characters, cut at the first space), or `XZH_B40_` and 14 hex digits of the MCU unique id when the code starts with "000" | [SO] `bluetooth.c` `Bluetooth_NameCmd` |
| Names seen | `SP05B2312190075`, `SG16S200A-SP57B-A` pack with code `SP57B-A2506120022`; [AIO] matches `SP??B*`, `SP1??B*`, `XZHX*`, `CSY*`, `ST*` | [SYP3] file names and VIA answers, [AIO] `matcher_dict_list` |

The Daly driver uses the same FFF0 / FFF1 / FFF2 layout as its first profile, and the JBD driver for the JBD-DH04SC02 ([jbd.md](jbd.md) section 2.1); the service does not identify Seplos V3 either.

### 2.2 Wired serial

**V2 ASCII**:

| Item | Value | Sources |
| --- | --- | --- |
| Framing | 8N1, no flow control | [V2PDF] 1.1, [V2EN] 1.1 |
| Baud rate | 9600 is the documented default; the RS485 ports of the 48 V packs (parallel link and PC tool) run 19200 | [V2PDF] 1.1 "default data transmission rate: 9600BPS"; [MAN100] section 11 "RS485 ... 19200bps", "Master controller baud rate 9600"; [MAN200] "RS485 interface (Baud rate 19200)"; [IC] notes `stty ... 19200`; [BM] 19200 on RS485, 9600 on the RS232 console; [FL] 19200; [SY] examples 9600 |
| Multi pack | [PC]: 19200 for a single pack on its RS485 port, 9600 for several packs read through the RS485 pins of the master's CAN port | [PC] README and `fetch_bms_data.py` (**unverified**, single source) |
| Connector | RJ45 (8P8C): pins 1 and 8 RS485-B, 2 and 7 RS485-A, 3 and 6 ground | [MAN100] section 11; [PC] README "Seplos pin assignment" |
| Addressing | DIP switches, address 0x00..0x0F; a pack answers only its DIP address on RS485 | [V2PDF] 1.2 and 4.1.1, [MAN100] "DIP address" |
| Response timeout | 500 ms | [V2PDF] 1.3 |
| Termination | 120 Ω at both ends of the bus | [V2PDF] 1.2 |

Recommended serial profiles for `seplos-v2`: 19200 8N1 first, then 9600 8N1.

**V3 Modbus RTU**:

| Item | Value | Sources |
| --- | --- | --- |
| Framing | 19200 8N1 | [XZH] 1.1, [S30], [DSB] `seplosv3.py`, [SY] `esp32-seplos-v3-example.yaml`, [SO] `pack_link.c` (USART at 19200) |
| Ports in the firmware | UART4 = pack link (answers its link address), USART2 = PC tool and display (answers 0xE0 only), USART3 = Bluetooth module (answers 0xE0 and 0..20), UART5 = inverter port when protocol 13 "XZH-Modbus" is selected (answers 0xE0 and 0..20) | [SO] `rtu_slave.c` |
| Addressing | BMS ids 0x00..0x7F on RS485 ([XZH] 2.2); display 0xE0; the master pack of a bank answers 0x00 | [XZH] 2.2, [SY] example (address 0x00 with `allow_broadcast_read`), [DSB] scans 0..15 |

Recommended serial profile for `seplos-v3`: 19200 8N1 only.

## 3. Frame formats

### 3.1 V2 ASCII frame

| Item | Bytes on the wire | Meaning |
| --- | --- | --- |
| SOI | 1 (0x7E, `~`) | start |
| VER | 2 ASCII hex digits | protocol version, 0x20 = 2.0 |
| ADR | 2 | address 0x00..0x0F |
| CID1 | 2 | device type, 0x46 = lithium iron phosphate battery BMS |
| CID2 | 2 | command (request) or return code RTN (answer) |
| LENGTH | 4 | LCHKSUM (4 bits) and LENID (12 bits) |
| INFO | LENID | ASCII hex digits, two per byte |
| CHKSUM | 4 | checksum of all characters between SOI and CHKSUM |
| EOI | 1 (0x0D, CR) | end |

Sources: [V2PDF] tables 1 to 5 and 3.1, [V2EN] 2, [SY] `seplos_modbus.cpp`, [IC] `build_cmd`. All fields except SOI and EOI are sent as uppercase ASCII hex; byte 0x4B is sent as `4B` = 0x34 0x42 ([V2PDF] 3.1). Every captured frame uses uppercase digits ([SY] README, [IC] notes).

LENGTH ([V2PDF] 3.2): LENID = number of ASCII characters of INFO (twice the INFO byte count), 12 bits, so at most 4095. LCHKSUM = (−((D11..D8) + (D7..D4) + (D3..D0)) mod 16) & 0xF, i.e. sum the three nibbles of LENID, take mod 16, invert and add 1. LENID 0 gives LCHKSUM 0 ([SY] `lchksum`). Worked example ([V2PDF] 3.2.2): LENID 18 = 0x012, nibble sum 3, LCHKSUM 0xD, LENGTH = 0xD012. For a 2 character INFO, LENGTH = 0xE002 ([V2PDF] table 7).

CHKSUM ([V2PDF] 3.3): sum of the ASCII codes of every character after SOI and before CHKSUM, mod 65536, bitwise inverted, plus 1; sent as 4 ASCII hex digits, high byte first. Worked example ([V2PDF] 3.3): `~1203400456ABCEFEFC72` CR: sum 0x038E, CHKSUM 0xFC72. The example is not consistent as printed: the characters `1203400456ABCEFE` sum to 0x038F (CHKSUM 0xFC71); the sum 0x038E and CHKSUM 0xFC72 belong to `1203400456ABCDEF` (found while implementing, checked in `seplos.test.js`; [V2EN] prints the same example). The algorithm itself is confirmed by every captured frame. Test vector example: `~20004642E00200FD37` CR (`v2a-tx-42-adr00`).

Answers carry RTN in the CID2 position ([V2PDF] table 5): 0x00 normal, 0x01 VER error, 0x02 CHKSUM error, 0x03 LCHKSUM error, 0x04 CID2 invalid, 0x05 command format error, 0x06 data invalid (parameter setting), 0x07 no data (history), 0xE1 CID1 invalid, 0xE2 command execution failure, 0xE3 device fault, 0xE4 invalid permissions.

Reassembly: collect from `~` to CR; a new `~` restarts the frame ([SY] `parse_seplos_modbus_byte_`: buffer cleared on any other first byte; frames above 340 characters dropped). Check, in this order, that every character is a hex digit, CHKSUM, LCHKSUM, and that LENID equals the INFO length.

### 3.2 V2 BLE frame

| Offset | Size | Request (host to BMS) | Answer (BMS to host) |
| --- | --- | --- | --- |
| 0 | 1 | SOI 0x7E | SOI 0x7E |
| 1 | 1 | VER 0x10 | VER, 0x14 on the captured pack, 0x10 in the vendor examples |
| 2 | 1 | ADR 0x00..0xFF | ADR |
| 3 | 1 | 0x46 (REQ) | CID, the function code of the command |
| 4 | 1 | CID (function code) | RTN (table below) |
| 5 | 2 | LENGTH, u16 BE, number of DATA bytes | LENGTH |
| 7 | LENGTH | DATA | DATA |
| 7+LENGTH | 2 | CRC-16/XMODEM, high byte first | CRC |
| 9+LENGTH | 1 | EOI 0x0D | EOI 0x0D |

Sources: [BLEPDF] tables 1 to 4, [SY] `send_command` and `assemble`, [AIO] `_cmd` and `_notification_handler`, [SYP2]. The request and the answer swap the meaning of bytes 3 and 4: requests carry 0x46 then the function code; answers carry the function code then the return code ([BLEPDF] tables 6 and 7, every [SYP2] frame).

CRC: CRC-16/XMODEM (polynomial 0x1021, initial value 0, no reflection, no final XOR) over bytes 1 .. 6+LENGTH (VER through the last DATA byte, without SOI, CRC and EOI), sent high byte first ([BLEPDF] 3.2 and 3.3, [SY] `crc_xmodem`, [AIO] `crc_xmodem(frame[1:])`). Worked example ([BLEPDF] 3.4): `7E 10 00 46 51 00 00 3A 7F 0D`: CRC over `10 00 46 51 00 00` = 0x3A7F. The bit-by-bit routine printed in [BLEPDF] 3.3 computes the same value.

RTN ([BLEPDF] table 4): 0x00 normal, 0x01 VER error, 0x02 CRC error, 0x03 data length error, 0x04 CID invalid, 0x05 command format error, 0x06 invalid data, 0x07 no data (history), 0xE1 REQ invalid, 0xE2 command execution failed, 0xE3 equipment failure, 0xE4 invalid permissions.

Reassembly: answers are split over several notifications (2 to 12 in [SYP2]; for example the 46 byte 0x51 answer as 35 + 11 bytes, `v2b-rx-51-sp76`). Start a frame at 0x7E, read LENGTH from bytes 5..6, wait for 10 + LENGTH bytes, then check EOI and CRC; on failure drop the buffer and resynchronise at the next 0x7E followed by 0x14 or 0x10 ([SY] `assemble` clears the buffer on every notification that starts with 0x7E; [AIO] restarts when a notification longer than 10 bytes starts with 0x7E). [SYP2] contains one corrupted answer with three stray bytes inside (`v2b-rx-61-corrupted`, section 12).

### 3.3 V3 Modbus RTU frame

Standard Modbus RTU ([XZH] 2.3 to 2.8, [SO] `rtu_slave.c`):

| Function | Request | Answer |
| --- | --- | --- |
| 0x04 read input registers | addr, 0x04, start (u16 BE), count N (u16 BE), CRC | addr, 0x04, byte count 2N, N × u16 BE, CRC |
| 0x01 read coils | addr, 0x01, start, coil count (8 per byte), CRC | addr, 0x01, byte count, coil bytes, CRC |
| 0x10 write multiple registers | addr, 0x10, start, N, byte count 2N, values, CRC | addr, 0x10, start, N, CRC |
| 0x0F write multiple coils | addr, 0x0F, start, coil count, byte count, values, CRC | addr, 0x0F, start, coil count, CRC |
| exception | | addr, function + 0x80, code, CRC |

CRC: Modbus CRC-16 (polynomial 0xA001 reflected, initial value 0xFFFF), sent low byte first ([SY] `crc16_`, [AIO] `crc_modbus`, [XZH] "CRC Lo Hi"). The firmware accepts functions 0x01, 0x04, 0x0F and 0x10 only; a request with any other function byte (0x03 included) is dropped while it is received and gets no answer ([SO] `rtu_slave.c` `Rtu_SlaveReceive`; [XZH] 2.1 lists no 0x03). Answers longer than 224 bytes are never sent (the receiver is re-armed instead), so one read returns at most 109 registers ([SO] `Rtu_SlaveTransmit`).

Exception codes ([XZH] 2.8, [XZHEN], [SO] `rtu_slave.c`, `bus_commands.c`, `registers.c`, `register_write.c`): 0x01 illegal function (also: the calendar was read or written while the history switch 0x1430 bit 4 is off; a request on the Bluetooth or inverter port while this pack is not the first or only pack of a bank), 0x02 illegal data address (also: a request that runs past the end of a block), 0x03 illegal data value (also: a request with a bad CRC in firmware V1.43l, and a pack of the bank that is not present), 0x04 slave device failure, 0x05 acknowledge, 0x06 busy (SPA write while parameters are being processed; the Chinese edition of [XZH] prints 0x07), 0x81 no history record ([XZHEN] only).

Coil blocks are byte oriented: the firmware copies whole bytes; bit 0 of the first data byte is the coil at the start address ([SO] `Reg_PutBits`, `Reg_StoreBits`; [XZH] PIC "each entry is one byte (8 coils)").

Reassembly over BLE: answers longer than the ATT payload arrive in several notifications; read the byte count at offset 2 (or take 5 bytes when bit 7 of the function byte is set) and wait for 5 + byte count bytes, then check the CRC ([SY] `assemble`, [AIO] `_notification_handler`).

## 4. Session flow

### 4.1 V2 ASCII (wired)

1. Open the port at 19200 8N1; on no answer try 9600 8N1 (section 2.2).
2. Send one request, wait for the answer up to 500 ms ([V2PDF] 1.3; allow 1 s for long answers at 9600: the 0x47 answer is 358 characters, about 0.37 s at 9600), then send the next. Never send a second request before the first is answered or timed out; the bus is half duplex and shared by all packs ([V2PDF] 1.3 "point-to-multipoint master-slave").
3. Start: 0x4F (protocol version, optional) and 0x51 (device information), as the vendor PC tool does ([IC] `ucbpcap_status.pcapng` records 90 and 114, `ucbpcap_params_x2.pcapng` records 70 and 90).
4. Poll: 0x42 (telemetry) then 0x44 (alarms and switch states). The PC tool repeats the pair about every 1.2 s ([IC] records 284..750: 74.14 s, 75.3 s, 76.5 s, 77.7 s).
5. Settings: 0x47 on demand; a write sends the whole block back with 0xA1 ([IC] reads at records 352, 3408 and 6102, writes at 7826 and 8512); read 0x47 again afterwards to confirm.
6. INFO of 0x42 and 0x44 is one byte, COMMAND GROUP = the pack address on RS485 ([V2PDF] 4.1.1 and 4.2.1: "SM checks whether the received COMMAND_GROUP matches the DIP address"); 0xFF ("all groups") is for RS232 only. The vendor tool sends INFO 0x00 to address 0x00 ([IC] record 126), [PC] sends 0x01 to every address and [V2PDF] table 7 pairs the group with the address. Send INFO = address. [FL] sends group 0x01 to address 0x00 (`v2a-tx-42-adr00-group01`), which suggests that some firmware does not check the group (**unverified** which packs check it). How a pack refuses a wrong group is not documented (**unverified**; the ubms simulator answers RTN 0x05). The rule is documented for 0x42 and 0x44 only. 0x47 is sent with INFO 0x00 as the vendor tool does, and 0xA1 carries group byte 0 in its block; both are captured only at address 0 ([IC] records 352, 7826); at other addresses **unverified**.

### 4.2 V2 BLE

1. Connect, discover service 0xFF00, enable notifications on 0xFF01, write requests to 0xFF02 (with response where the property allows it, as the official app does, section 2.1).
2. Start: 0x51 (manufacturer information); then 0x47 (DATA 0x00) once for the settings ([SYP2] record 39 then 233; [SY] queue 0x47, 0x51, 0x61, 0x62).
3. Poll: 0x61 with DATA 0x00 (single machine data) about every 1 to 3 s; 0x62 (parallel data, no DATA) when the pack is the master of a bank (its 0x51 answer reports slaves > 0) ([SYP2] records 44..252: 0x62 every 3 s, then 0x61 every 1.3 to 3 s; [AIO] polls 0x51 and 0x61 only).
4. One request at a time: the app waits up to 5 s and reports a connection fault after 3 failures ([BLEPDF] 1.3.1). In [SYP2] the BMS answered a pending 0x47 request with the CID byte of a newer 0x61 request (records 358..374, `v2b-rx-61-carrying-47`); never pipeline requests, and check that LENGTH and content fit the request (section 12).
5. Parallel banks: each pack has its own Bluetooth name BPxx; the app connects to each pack separately, and BP00 (the master) also serves the bank summary 0x62 ([BLEPDF] 1.3.2). Whether DATA of 0x61 selects another pack through the master is not shown by any capture (**unverified**); query each pack over its own connection.

### 4.3 V3 (Bluetooth and RS485)

1. Bluetooth: connect, service 0xFFF0, notifications on 0xFFF1, write requests to 0xFFF2 without response ([SY], [AIO]). Address 0x00 (or 0xE0) reaches the connected pack; it must be the only pack or the first pack of a bank, others hide their Bluetooth module and refuse the port with exception 0x01 ([SO] `bluetooth.c`, `bus_commands.c`).
2. RS485: address the pack by its link address (DIP setting, 0x00 for the master; [DSB] scans 0..15, [SY] uses 0x00). Through the PC / display port only 0xE0 answers ([SO] `rtu_slave.c`).
3. Start: VIA (0x1700, 51 registers) for the identity, then the settings blocks SPA (0x1300) and SFA (0x1400) on demand ([SY] queue: EIA, EIB, EIC, VIA, PCT, SFA, SPA, SPA, then per pack PIA, PIB, PIC).
4. Poll the connected pack: PIA (0x1000, 18 registers), PIB (0x1100, 26 registers), PIC (0x1200, 144 coils). For a bank over Bluetooth: EIA (0x2000, 26 registers), EIB (0x2100, 22 registers) and EIC (0x2200, 80 coils) at address 0x00 for the bank summary, and PIA / PIB / PIC at address 1..16 for each pack, pack 1 being the connected master ([AIO] `_async_update`; [SO] `bus_commands.c`: addresses 0, 1 and 0xE0 are the connected pack, 2..20 come from its pack table and only for PIA, PIB and PIC).
5. One request at a time; send the next request after the answer or after a timeout of about 1 s ([SY] sends the next command from the answer handler; [DSB] uses a 0.4 s serial timeout). The firmware drops a half-received request after 250 ms of silence ([SO] `Rtu_SlaveCheckTimeouts`), so a request split over several BLE writes must arrive within 250 ms.

## 5. Commands

### 5.1 V2 ASCII requests

| CID2 | Meaning | INFO of the request | Answer | Status | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x42 | telemetry (cells, temperatures, current, voltage, capacity) | 1 byte, command group = address | section 6.1.1 | captured | [V2PDF] 4.1, [SY], [IC] record 126 |
| 0x44 | telecommand: alarm bytes, alarm bits, switch, balance and system state | 1 byte, command group | section 6.1.2 | captured | [V2PDF] 4.2, [IC] record 144 |
| 0x45 | telecontrol (switch the MOSFETs, shut down, factory reset) | 2 bytes per [BSX] `teleCtrlByteNum`; layout not documented | unknown | **unverified**, no capture | [V2PDF] table 4, [BSX] `teleControl_Group` |
| 0x47 | teleregulation information (parameter block) | 1 byte, group 0x00 | section 6.1.3 | captured at address 0 only (other addresses **unverified**, 4.1 step 6) | [V2PDF] table 4, [IC] record 352 |
| 0x49 | setting of teleregulation information | not documented; the vendor tool writes with 0xA1 | unknown | not used | [V2PDF] table 4, [IC] |
| 0x4B | historical data | not documented | unknown | not used | [V2PDF] table 4 |
| 0x4D | get time | none | 7 bytes: year u16, month, day, hour, minute, second ([IC] `TimeStamp.from_data`) | **unverified**, answer not captured | [V2PDF] table 4, [IC] `seplos.py` |
| 0x4E | set time | 7 bytes as above | RTN only (expected) | **unverified** | [IC] `seplos.py` |
| 0x4F | protocol version | none | RTN 0x00, empty INFO; the version is the VER byte | captured | [V2PDF] table 4, [IC] record 90 |
| 0x51 | device vendor information | none, or 1 byte 0x00 | section 6.1.4 | captured | [V2PDF] table 4, [SY] README, [IC] record 114, [FL] 51H decoder |
| 0xA0 | production calibration | not documented | unknown | not used | [V2PDF] table 4 |
| 0xA1 | production setting = write the parameter block | the complete 169 byte block of the 0x47 answer (section 7.1) | RTN 0x00, empty INFO | captured | [V2PDF] table 4, [IC] records 7826 and 8512 |
| 0xA2 | regular recording | not documented | unknown | not used | [V2PDF] table 4 |

Request examples (all in the vectors): `~20004642E00200FD37` CR (0x42 to address 0, `v2a-tx-42-adr00`), `~20004644E00200FD35` CR (0x44, `v2a-tx-44-adr00`), `~20004647E00200FD32` CR (0x47, `v2a-tx-47-adr00`), `~2000464F0000FD9A` CR (0x4F, `v2a-tx-4f`), `~200046510000FDAE` CR (0x51, `v2a-tx-51`), `~20014642E00201FD35` CR (0x42 to address 1, `v2a-tx-42-adr01`).

syssi's README also sends 0x47 with an empty INFO (`~200046470000FDA9`) and lists no answer; the vendor tool always sends the group byte ([SY] README "RX <- ?", [IC] record 352). Send the group byte.

### 5.2 V2 BLE requests

| CID | Meaning | DATA of the request | Answer | Status | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x47 | get BMS parameters | 1 byte, group number 0x00 | section 6.2.4 (169 bytes) | captured | [BLEPDF] 4.4, [SYP2] record 233 |
| 0x51 | get manufacturer information | none | section 6.2.1 (36 bytes) | captured | [BLEPDF] 4.1, [SYP2] record 39 |
| 0x61 | get single machine data | 1 byte, group number 0x00..0xFF (the app sends 0x00); [BLEPDF]'s own example sends LENGTH 0 | section 6.2.2 | captured | [BLEPDF] 4.2, [SYP2] record 87 |
| 0x62 | get parallel data (bank summary) | none | section 6.2.3 | captured | [BLEPDF] 4.3, [SYP2] record 44 |
| 0x63 | switch the CAN protocol | 1 byte, table 9.6 code | RTN 0x00 or 0xE2, DATA echoed | documented, not captured | [BLEPDF] 4.6 |
| 0x64 | switch the RS485 protocol | 1 byte, table 9.6 code | RTN 0x00 or 0xE2, DATA echoed | documented, not captured | [BLEPDF] 4.7 |
| 0x65 | set device group number and device number | 2 bytes: group, device | RTN 0x00 or 0xE2, DATA echoed | documented, not captured | [BLEPDF] 4.8 |
| 0xA1 | set BMS parameters | 169 bytes, the 0x47 block | RTN 0x00 or 0xE2, LENGTH 0 | documented over BLE, captured over RS485 | [BLEPDF] 4.5, [IC] records 7826 and 8512 |
| 0xAA | MOSFET switch (syssi only): DATA = switch bit (0x01 discharge, 0x02 charge, 0x04 current limit, 0x08 heating), state (0x01 on, 0x00 off) | 2 bytes | 0xAA answer, DATA[0] 0x00 = success (syssi's guess) | **unverified**: not in [BLEPDF], not captured | [SY] `switch/seplos_switch.cpp`, `switch/__init__.py` |

Request examples: `7E 10 00 46 51 00 00 3A 7F 0D` (`v2b-tx-51`), `7E 10 00 46 61 00 01 00 F7 C1 0D` (`v2b-tx-61`), `7E 10 00 46 62 00 00 A6 8A 0D` (`v2b-tx-62`), `7E 10 00 46 47 00 01 00 E7 16 0D` (`v2b-tx-47`), `7E 10 00 46 63 00 01 02 3A EB 0D` (`v2b-tx-63-can2`).

[AIO] restricts its command builder to 0x47, 0x51, 0x61, 0x62 and 0x04 ("allow only read commands"); 0x04 appears in no other source (**unverified**, not used).

### 5.3 V3 requests

| Block | Function | Start | Count | Address | Notes | Sources |
| --- | --- | --- | --- | --- | --- | --- |
| PIA pack information A | 0x04 | 0x1000 | 18 (0x12); 17 also works | pack | 0x1011 is the precharge percent in [XZHEN] and reserved in the Chinese edition | [XZH] example `00 04 10 00 00 12 75 16`, [SO] pack table 0x12, [SY] and [AIO] 0x11 |
| PIB pack information B | 0x04 | 0x1100 | 26 (0x1A) | pack | | [XZH] example, [SY], [AIO], [SO] |
| PIC pack information C | 0x01 | 0x1200 | 144 coils (0x90), 18 bytes | pack | syssi sends 0x0900 coils and gets exception 0x02 (`v3-tx-pic-wrong`) | [XZH] example `00 01 12 00 00 90 38 CF`, [SO] |
| SPA configuration parameters | 0x04 | 0x1300 | 106 (0x6A) in one read, or 0x1300 and 0x1335 with 53 (0x35) each | pack | syssi reads SPA from 0xE0, aiobmsble from 0x00, both answered over BLE | [DSB], [MR], [SY], [AIO] |
| SFA function switches | 0x01 | 0x1400 | 80 coils (0x50), 10 bytes | pack | syssi's 0x0500 coils get exception 0x02 (`v3-tx-sfa-wrong`) | [DSB], [MR], [XZH], [SO] (80 bits) |
| SCA calendar | 0x04 | 0x1500 | 4 | pack | answered only when the history switch (0x1430 bit 4) is on, else exception 0x01 | [DSB], [SO] |
| VIA version information | 0x04 | 0x1700 | 51 (0x33) | pack | [DSB] reads 0x1700 x 10, 0x170A x 10, 0x1714 x 1, 0x1715 x 15 | [SY], [DSB] |
| PCT inverter information | 0x04 | 0x1800 | 36 (0x24) | pack | | [SY] |
| EIA bank summary A | 0x04 | 0x2000 | 26 (0x1A) | 0x00 | | [XZH] example, [SY], [AIO] |
| EIB bank summary B | 0x04 | 0x2100 | 22 (0x16) | 0x00 | 26 registers get exception 0x02 on firmware "15" (`v3-rx-eib-exception`) | [XZH] example `00 04 21 00 00 16 7A 29`, [AIO], [SYP3] |
| EIC bank summary C | 0x01 | 0x2200 | 80 coils (0x50), 10 bytes | 0x00 | | [XZH] example `00 01 22 00 00 50 37 9F`, [SY], [AIO] |
| HIA history | 0x04 | 0x7000 | 0x55AA first record, 0xAA55 next record | pack | non standard; not used by any open source tool | [XZH] HIA notes |
| SPB network parameters | 0x04 / 0x10 | 0x1900 | | pack | X02 and X03 boards only (SNMP, Wi-Fi, gyro); absent from [XZHEN] | [XZH] |

Request examples: `00 04 10 00 00 12 75 16` (PIA, `v3-tx-pia-18`), `00 04 11 00 00 1A 75 2C` (PIB, `v3-tx-pib`), `00 01 12 00 00 90 38 CF` (PIC, `v3-tx-pic`), `00 04 20 00 00 1A 7B D0` (EIA, `v3-tx-eia`), `00 04 21 00 00 16 7A 29` (EIB, `v3-tx-eib-22`), `00 01 22 00 00 50 37 9F` (EIC, `v3-tx-eic`), `00 04 17 00 00 33 B4 7A` (VIA, `v3-tx-via`), `01 04 10 00 00 11 34 C6` (PIA of pack 1 over Bluetooth, `v3-tx-pia-p1`).

The register and coil writes (functions 0x10 and 0x0F) are in sections 7.3, 7.4 and 8.3.

## 6. Responses

### 6.1 V2 ASCII answers

Offsets are byte offsets into the decoded INFO. M = cell count, N = temperature count.

#### 6.1.1 0x42 telemetry

| Offset | Size | Field (`expected` key) | Scale and unit | Sources |
| --- | --- | --- | --- | --- |
| 0 | 1 | DATA FLAG (`dataFlag`) | 0x00 in every capture | [V2PDF] table 8, [IC], [SY] |
| 1 | 1 | COMMAND GROUP (`commandGroup`), echo of the request INFO | | [V2PDF] table 8 |
| 2 | 1 | M, number of cells (`cellCount`), 16 in every capture; syssi accepts 8..16 | | [V2PDF], [SY] `on_seplos_modbus_data` |
| 3 + 2i | 2 | cell i+1 voltage (`cellVoltages`), u16 | 0.001 V | [V2PDF], [BSX] `teleMeterType Cell`, [SY] |
| c = 3 + 2M | 1 | N, number of temperatures (`tempCount`), 6 in every capture | | [V2PDF], [SY] |
| c + 1 + 2j | 2 | temperature j+1 (`temperatures`): N − 2 cell sensors, then ambient ("environment"), then power (MOSFET) | 0.1 K | [V2PDF] table 8, [BSX] "Battery temp1..4, Ambient temp, Power temp", [SY] |
| t = c + 1 + 2N | 2 | current (`current`), s16 | 0.01 A | [V2PDF] tables 8 and 9, [SY] |
| t + 2 | 2 | total voltage (`voltage`) | 0.01 V | [V2PDF], [SY] |
| t + 4 | 2 | residual capacity (`remainingAh`) | 0.01 Ah | [V2PDF], [SY] |
| t + 6 | 1 | custom number P (`customCount`), 10 = ten u16 fields follow | | [V2PDF] "Custom number P=10", [SY] |
| t + 7 | 2 | battery capacity, full charge capacity (`capacityAh`) | 0.01 Ah | [V2PDF], [SY] |
| t + 9 | 2 | SOC (`soc`) | 0.1 % | [V2PDF] "SOC (1 ‰)", [BSX] scale 0.1, [SY] 787 = 78.7 % |
| t + 11 | 2 | rated capacity (`ratedAh`) | 0.01 Ah | [V2PDF], [SY] |
| t + 13 | 2 | number of cycles (`cycles`) | 1 | [V2PDF], [SY] |
| t + 15 | 2 | SOH (`soh`) | 0.1 % | [V2PDF], [BSX], [SY] |
| t + 17 | 2 | port voltage (`portVoltage`), voltage at the output terminals | 0.01 V | [V2PDF] "Port voltage", [BSX] "Bus voltage" / "Port voltage", [SY] |
| t + 19 | 8 | 4 reserved u16 (`reserved`) | | [V2PDF] items 17..20 |

For 16 cells and 6 temperatures: cells at 3..34, N at 35, temperatures at 36..47, current 48, voltage 50, residual 52, P 54, capacity 55, SOC 57, rated 59, cycles 61, SOH 63, port voltage 65, reserved 67..74; INFO = 75 bytes, LENID 150 ([V2PDF] 4.1.2 "INFO is 75 bytes"). The fields after the rated capacity exist only when P says so: [SY] stops after the rated capacity, the cycles or the SOH when the frame is shorter, and [BM] reads the SOH only for P ≥ 8 and the port voltage for P ≥ 9.

The reserved words are not always zero: a 1101-ZA11 sends FFFB FFFD 0067 000B (`v2a-rx-42-za11-idle`); ignore them.

Vectors: `v2a-rx-42-readme-16s` (syssi README, 16 cells, −6.76 A, 52.80 V, SOC 78.7 %), `v2a-rx-42-za11-idle` (vendor tool capture, 0 A, 53.26 V, SOC 46.4 %).

#### 6.1.2 0x44 telecommand (alarms and states)

| Offset | Size | Field | Notes | Sources |
| --- | --- | --- | --- | --- |
| 0 | 1 | DATA FLAG | | [V2PDF] table 11 |
| 1 | 1 | COMMAND GROUP | | [V2PDF] |
| 2 | 1 | M (`cellCount`) | | [V2PDF] |
| 3 + i | 1 | cell i+1 alarm (`cellAlarms`) | byte alarm code, table 9.1 | [V2PDF], [BSX] `GB_Byte` |
| 3 + M | 1 | N (`tempCount`) | | [V2PDF] |
| 4 + M + j | 1 | temperature j+1 alarm (`tempAlarms`), same order as 6.1.1 | table 9.1 | [V2PDF], [BSX] |
| 4 + M + N | 1 | charge / discharge current alarm (`currentAlarm`) | table 9.1 | [V2PDF] item 7, [BSX] "Current" |
| 5 + M + N | 1 | total voltage alarm (`voltageAlarm`) | table 9.1 | [V2PDF] item 8, [BSX] "Total voltage" |
| b = 6 + M + N | 1 | P, number of bit alarm bytes (`bitAlarmCount`), 20 | | [V2PDF] item 9 |
| b + 1 | 1 | alarm event 1 (`event1`) | table 9.2 | [V2PDF] table 13, [BSX] `Ext_Bit` byte 0 |
| b + 2 | 1 | alarm event 2 (`event2`) | | [V2PDF], [BSX] byte 1 |
| b + 3 | 1 | alarm event 3 (`event3`) | | [BSX] byte 2 |
| b + 4 | 1 | alarm event 4 (`event4`) | | [BSX] byte 3 |
| b + 5 | 1 | alarm event 5 (`event5`) | | [BSX] byte 4 |
| b + 6 | 1 | alarm event 6 (`event6`) | | [BSX] byte 5 |
| b + 7 | 1 | on-off state (`switchState`) | table 9.3 | [V2PDF], [BSX] byte 6 |
| b + 8 | 1 | equilibrium (balancing) state 1, cells 1..8 (`balance1`), bit 0 = cell 1 | | [V2PDF], [BSX] byte 7 |
| b + 9 | 1 | balancing state 2, cells 9..16 (`balance2`) | | [V2PDF], [BSX] byte 8 |
| b + 10 | 1 | system state (`systemState`) | table 9.4 | [V2PDF], [BSX] `Mode_Byte` |
| b + 11 | 1 | disconnection state 1, cells 1..8 (`disconnect1`) | 1 = sense wire open | [V2PDF] |
| b + 12 | 1 | disconnection state 2, cells 9..16 (`disconnect2`) | | [V2PDF] |
| b + 13 | 1 | alarm event 7 (`event7`) | | [V2PDF], [BSX] byte 12 |
| b + 14 | 1 | alarm event 8 (`event8`) | | [V2PDF], [BSX] byte 13 |
| b + 15 | 6 | reserved extension (`reservedBytes`) | the ZA11 sends 0x10 in the last one | [V2PDF], `v2a-rx-44-za11` |

For 16 cells and 6 temperatures: cell alarms 3..18, N at 19, temperature alarms 20..25, current alarm 26, voltage alarm 27, P at 28, event 1 at 29 ... event 8 at 42, reserved 43..48; INFO = 49 bytes, LENID 98 ([V2PDF] 4.2.2 "INFO is 49 bytes"). Vector: `v2a-rx-44-za11` (no alarm, switch state 0x03, system state 0x10 standby).

[BM] decodes this answer with three single byte alarms (charge current, voltage, discharge current) before the event count and takes the switch state from the sixth event byte; that disagrees with [V2PDF], [BSX] and the ZA11 capture, and [BM] says it is untested. Follow [V2PDF].

#### 6.1.3 0x47 parameter block (also V2 BLE 0x47 and the 0xA1 write)

| INFO offset | Size | Field | Sources |
| --- | --- | --- | --- |
| 0 | 1 | group number (`group`), 0x00 | [BLEPDF] table 21, [IC] `to_msg_body` ("00") |
| 1 | 1 | M, number of two byte parameters (`intCount`), 60 (0x3C) | [BLEPDF] "Number of integer parameters M=60", [IC] |
| 2 + 2i | 2 | two byte parameter i (i = 0..59), u16 or s16, table 7.1 | [BLEPDF], [BSX] `int_para` ParaIndex 0..0x3B, [IC] |
| 122 | 1 | N, number of one byte parameters (`byteCount`), 27 (0x1B) | [BLEPDF] "N=27", [IC] |
| 123 + j | 1 | one byte parameter j (j = 0..26), table 7.1 | [BLEPDF], [BSX] ParaIndex 0x3C..0x56 |
| 150 | 1 | P, number of function switch bytes (`switchCount`), 8 | [BLEPDF] "P=8", [BSX] `bitParaByteNum = 8` |
| 151 + k | 1 | function switch byte k+1 (`functionSwitches`), table 7.2 | [BLEPDF], [BSX] `bit_para` |
| 159 | 10 | device model, ASCII (`model`): "1101-ZA11 ", "1101-SP76 ", "EMU110110E" | [BLEPDF] item 106, [IC], [SYP2] |

INFO = 169 bytes, LENID 338 (LENGTH 0x8152) on V2 ASCII, LENGTH 0x00A9 on V2 BLE ([BLEPDF] 4.4.2, [IC] record 352). In a V2 BLE frame add 7 to every offset: the first parameter is at frame offset 9, the one byte parameters at 130..156 ([SY] `decode_settings_data_` uses the same frame offsets for the two byte parameters).

Vectors: `v2a-rx-47-za11` (RS485, vendor tool), `v2b-rx-47-sp76` (BLE, official app), `v2b-rx-47-doc` ([BLEPDF] example).

#### 6.1.4 0x51 device vendor information

| INFO offset | Size | Field | Sources |
| --- | --- | --- | --- |
| 0 | 10 | device name (`model`), ASCII, space padded: "1101-SP15 ", "1101-ZA11 ", "1101-SP76 " | [SY] README, [IC] record 114, [FL] 51H decoder |
| 10 | 2 | software version (`softwareVersion`), major and minor byte: 02 07 = "2.7", 10 04 = "16.4" | [SY] README, [IC], [FL] |
| 12 | 20 | manufacturer name (`manufacturer`), ASCII, space padded; carries the selected CAN protocol: "CANProtocol:Sofar   ", "CAN:PNG_DYE_Luxp_TBB", "CAN:Victron" | [SY] README, [IC], [FL] |

INFO = 32 bytes, LENID 64. This is the order of the Pylontech 0x51 answer (device name, software version, manufacturer; [PY]); the V2 BLE answer has another order (6.2.1). Vectors: `v2a-rx-51-sp15`, `v2a-rx-51-za11`, `v2a-rx-51-sp76`.

#### 6.1.5 Empty answers

0x4F and 0xA1 are answered with RTN 0x00 and LENID 0: `~200046000000FDB4` CR ([IC] records 90, 7826, 8512; `v2a-rx-4f-empty`, `v2a-rx-a1-ack`). The bytes are identical, so match an answer to the request that is outstanding. The protocol version is the VER byte of the answer (0x20 = "2.0").

### 6.2 V2 BLE answers

Frame offsets (from 0x7E); DATA starts at offset 7.

#### 6.2.1 0x51 manufacturer information

| Frame offset | DATA offset | Size | Field | Sources |
| --- | --- | --- | --- | --- |
| 7 | 0 | 20 | manufacturer information (`manufacturer`), ASCII; holds the CAN protocol name: "CAN:Victron" + spaces, "CAN:PNG_DYE_Luxp_TBB" | [BLEPDF] table 7, [SY] (publishes it as "device model"), [SYP2], [AIO] test |
| 27 | 20 | 10 | part model (`model`), ASCII: "1101-SP76 " | [BLEPDF], [SY] ("hardware version"); [AIO] reads frame bytes 26..35, one byte too early (its test expects "B1101-SP76") |
| 37 | 30 | 2 | software version (`softwareVersion`): 10 04 = "16.4", 10 06 = "16.6" | [BLEPDF] "10H 04H interpreted as V16.4", [SY], [AIO] |
| 39 | 32 | 1 | CAN protocol (`canProtocol`), table 9.6 | [BLEPDF] table 8, [SY] |
| 40 | 33 | 1 | RS485 protocol (`rs485Protocol`), table 9.6 | [BLEPDF] table 9, [SY] |
| 41 | 34 | 1 | battery type (`batteryType`), table 9.7 | [BLEPDF] table 10, [SY] |
| 42 | 35 | 1 | number of slaves (`slaves`), 0x00..0x0F; non-zero on the master of a bank only | [BLEPDF], [AIO] `pack_count` |

LENGTH 36 (0x24). Vectors: `v2b-rx-51-sp76` (CAN protocol 3 Victron, RS485 protocol 1, LFP, 1 slave), `v2b-rx-51-aio`.

#### 6.2.2 0x61 single machine data

| DATA offset | Size | Field | Scale and unit | Sources |
| --- | --- | --- | --- | --- |
| 0 | 1 | DATA FLAG (`dataFlag`) | | [BLEPDF] table 12 |
| 1 | 1 | device address 0x00..0x0F (`address`) | | [BLEPDF] table 12 ([SY] calls DATA 0 the address and DATA 1 reserved) |
| 2 | 1 | M (`cellCount`) | | [BLEPDF], [SY], [AIO] `_CELL_POS` 9 |
| 3 + 2i | 2 | cell voltages (`cellVoltages`) | 0.001 V | [BLEPDF], [SY], [AIO] |
| c = 3 + 2M | 1 | N (`tempCount`) | | [BLEPDF], [SY] |
| c + 1 + 2j | 2 | temperatures (`temperatures`): N − 2 cell sensors, ambient, power | 0.1 K | [BLEPDF] "Cell temperature (N−2), ambient temperature, power temperature", [SY], [AIO] |
| t = c + 1 + 2N | 2 | current (`current`), s16 | 0.01 A | [BLEPDF] table 5, [SY], [AIO] |
| t + 2 | 2 | total voltage (`voltage`) | 0.01 V | [BLEPDF], [SY], [AIO] |
| t + 4 | 2 | remaining capacity (`remainingAh`) | 0.01 Ah | [BLEPDF], [SY], [AIO] |
| t + 6 | 1 | custom amount K (`customCount`), 6 | | [BLEPDF] "Custom amount K=6" |
| t + 7 | 2 | battery (full) capacity (`capacityAh`) | 0.01 Ah | [BLEPDF], [SY] |
| t + 9 | 2 | SOC (`soc`) | 0.1 % | [SY], [AIO] (`/10`); `v2b-rx-61-sp76`: 0x03B5 = 94.9 % |
| t + 11 | 2 | rated capacity (`ratedAh`) | 0.01 Ah | [BLEPDF], [SY], [AIO] |
| t + 13 | 2 | cycles (`cycles`) | 1 | [BLEPDF], [SY], [AIO] |
| t + 15 | 2 | SOH (`soh`) | 0.1 % | [SY], [AIO] |
| t + 17 | 2 | port voltage (`portVoltage`) | 0.01 V | [BLEPDF], [SY] |
| a = t + 19 | M | cell voltage alarms (`cellAlarms`) | table 9.1 | [BLEPDF] item 23, [SY] |
| a + M | N | temperature alarms (`tempAlarms`), same order as the temperatures | table 9.1 | [BLEPDF], [SY] |
| a + M + N | 1 | charge and discharge current alarm (`currentAlarm`) | table 9.1 | [BLEPDF] item 25, [SY] |
| a + M + N + 1 | 1 | total voltage alarm (`voltageAlarm`) | table 9.1 | [BLEPDF] item 26, [SY] |
| a + M + N + 2 | 1 | system state (`systemState`) | table 9.4 | [BLEPDF] table 13, [SY] |
| a + M + N + 3 | 1 | switch state (`switchState`) | table 9.3 | [BLEPDF] table 14, [SY], [AIO] |
| p = a + M + N + 4 | 1 | P, number of alarm event bytes (`eventCount`), 8 | | [BLEPDF] "Custom alarm volume P", [SY], [AIO] |
| p + 1 | P | alarm events 1..P (`events`), table 9.2 | | [BLEPDF] table 15, [SY], [AIO] |
| p + 1 + P | X = ceil(M / 8) | balancing state bytes (`balance`), bit 0 of the first byte = cell 1 | | [BLEPDF] table 16, [SY], [AIO] |
| p + 1 + P + X | X | disconnection state bytes (`disconnect`), 1 = sense wire open | | [BLEPDF] table 17, [SY] |

For 16 cells and 6 temperatures (frame offsets): cells 10..41, N 42, temperatures 43..54, current 55, voltage 57, remaining 59, K 61, capacity 62, SOC 64, rated 66, cycles 68, SOH 70, port 72, cell alarms 74..89, temperature alarms 90..95, current alarm 96, voltage alarm 97, system state 98, switch state 99, P 100, events 101..108, balancing 109..110, disconnection 111..112; LENGTH 106 (0x6A), frame 116 bytes. Vectors: `v2b-rx-61-sp76` (+27.56 A, SOC 94.9 %), `v2b-rx-61-sp76-b`, `v2b-rx-61-sp76-c`, `v2b-rx-61-aio` (cell 10 balancing), `v2b-rx-61-doc-faults` ([BLEPDF] example).

#### 6.2.3 0x62 parallel data (bank summary)

| DATA offset | Size | Field | Scale and unit | Sources |
| --- | --- | --- | --- | --- |
| 0 | 1 | DATA FLAG (`dataFlag`) | | [BLEPDF] table 19 |
| 1 | 1 | device address, 0x00 (`address`) | | [BLEPDF] |
| 2 | 1 | M (`cellCount`) | | [BLEPDF], [SY] |
| 3 | 2 | highest cell voltage of the bank (`maxCellVoltage`) | 0.001 V | [BLEPDF], [SY] |
| 5 | 2 | lowest cell voltage (`minCellVoltage`) | 0.001 V | [BLEPDF], [SY] |
| 7 | 1 | N (`tempCount`) | | [BLEPDF] |
| 8 | 2 | highest cell temperature (`maxCellTemp`) | 0.1 K | [BLEPDF], [SY] |
| 10 | 2 | lowest cell temperature (`minCellTemp`) | 0.1 K | [BLEPDF], [SY] |
| 12 | 2 | ambient temperature (`ambientTemp`) | 0.1 K | [BLEPDF], [SY] |
| 14 | 2 | power temperature (`powerTemp`) | 0.1 K | [BLEPDF], [SY] |
| 16 | 2 | current (`current`), s16 | **0.1 A** | [BLEPDF] "0.1A", [SY], [AIO] comment "/10 for 0x62" |
| 18 | 2 | total voltage (`voltage`) | 0.01 V | [BLEPDF], [SY] |
| 20 | 2 | remaining capacity (`remainingAh`) | **0.1 Ah** | [BLEPDF], [SY] |
| 22 | 1 | custom amount K (`customCount`), 7 | | [BLEPDF] "K=7" |
| 23 | 2 | battery capacity (`capacityAh`) | 0.1 Ah | [BLEPDF], [SY] |
| 25 | 2 | SOC (`soc`) | 0.1 % | [SY]; `v2b-rx-62-sp76` 0x0392 = 91.4 % |
| 27 | 2 | rated capacity (`ratedAh`) | 0.1 Ah | [BLEPDF], [SY] |
| 29 | 2 | cycles (`cycles`) | 1 | [BLEPDF], [SY] |
| 31 | 2 | SOH (`soh`) | 0.1 % | [BLEPDF], [SY] |
| 33 | 2 | port voltage (`portVoltage`) | 0.01 V | [BLEPDF], [SY] |
| 35 | 2 | parallel connection status (`parallelStatus`, two bytes as sent) | 03 00 with 2 packs online | [BLEPDF] item 27; meaning **unverified** (bit mask of online packs in the first byte, by the one capture) |
| 37 | 1 | system state (`systemState`) | table 9.4 | [BLEPDF], [SY] |
| 38 | 1 | switch state (`switchState`) | table 9.3 | [BLEPDF], [SY] |
| 39 | 1 | P (`eventCount`), 8 | | [BLEPDF], [SY] |
| 40 | P | alarm events 1..P (`events`) | table 9.2 | [BLEPDF], [SY] |

LENGTH 48 with P = 8. Current and capacities use a ten times coarser unit than 0x61 ([BLEPDF] table 19; `v2b-rx-62-sp76`: 0x0229 = 55.3 A, 0x1798 = 604.0 Ah for two 302 Ah packs). Vectors: `v2b-rx-62-sp76`, `v2b-rx-62-sp76-b`, `v2b-rx-62-aio`, `v2b-rx-62-extension`, `v2b-rx-62-doc`.

#### 6.2.4 0x47 parameter block

Same 169 byte layout as 6.1.3, at frame offset 7 ([BLEPDF] table 21, [SYP2] record 233 and following, `v2b-rx-47-sp76`).

#### 6.2.5 Short answers

0xA1, 0x63, 0x64 and 0x65 are answered with RTN 0x00 (accepted) or 0xE2 (command execution failed). 0xA1 has LENGTH 0; 0x63 and 0x64 echo their one DATA byte; 0x65 echoes its two DATA bytes ([BLEPDF] 4.5.2 to 4.8.2). The vendor examples carry VER 0x10 and the 0x65 example says "LEN 00H 01H" while sending 2 bytes ([BLEPDF] 4.8.2); accept the LENGTH that is sent. Vectors: `v2b-rx-a1-ok`, `v2b-rx-a1-e2`, `v2b-rx-63-ok`, `v2b-rx-63-e2`, `v2b-rx-64-ok`, `v2b-rx-64-e2`, `v2b-rx-65-ok`, `v2b-rx-65-e2`.

### 6.3 V3 answers

Register tables give the register address; "byte" is the offset in the data of an answer that starts at the first register of the block.

#### 6.3.1 PIA (0x1000, function 0x04)

| Register | Byte | Field (`expected` key) | Type | Scale and unit | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x1000 | 0 | pack voltage (`voltage`) | u16 | 0.01 V | [XZH], [SY], [AIO] |
| 0x1001 | 2 | current (`current`) | s16 | 0.01 A on boards up to 200 A, 0.1 A on 300 A and 400 A boards | [XZH] note 1 (V0.2), [SY], [AIO] |
| 0x1002 | 4 | remaining capacity (`remainingAh`) | u16 | 0.01 Ah | [XZH], [SY], [AIO] |
| 0x1003 | 6 | battery (full) capacity (`totalAh`) | u16 | 0.01 Ah | [XZH], [SY] |
| 0x1004 | 8 | total discharged capacity (`dischargedAh`) | u16 | 10 Ah | [XZH], [SY] |
| 0x1005 | 10 | SOC (`soc`) | u16 | 0.1 % | [XZH], [SY], [AIO] |
| 0x1006 | 12 | SOH (`soh`) | u16 | 0.1 % | [XZH], [SY], [AIO] |
| 0x1007 | 14 | cycles (`cycles`) | u16 | 1 | [XZH], [SY], [AIO] |
| 0x1008 | 16 | average cell voltage (`avgCellVoltage`) | u16 | 0.001 V | [XZH], [SY] |
| 0x1009 | 18 | average cell temperature (`avgCellTemp`) | u16 | 0.1 K | [XZH], [SY] |
| 0x100A | 20 | highest cell voltage (`maxCellVoltage`) | u16 | 0.001 V | [XZH] |
| 0x100B | 22 | lowest cell voltage (`minCellVoltage`) | u16 | 0.001 V | [XZH] |
| 0x100C | 24 | highest cell temperature (`maxCellTemp`) | u16 | 0.1 K | [XZH] |
| 0x100D | 26 | lowest cell temperature (`minCellTemp`) | u16 | 0.1 K | [XZH] |
| 0x100E | 28 | reserved (`reg100E`) | | | [XZH] |
| 0x100F | 30 | maximum discharge current (`maxDischargeCurrent`) | u16 | 1 A | [XZH] |
| 0x1010 | 32 | maximum charge current (`maxChargeCurrent`) | u16 | 1 A | [XZH] |
| 0x1011 | 34 | precharge percent (`reg1011`, raw) | u16 | 0.1 % | [XZHEN]; reserved in the Chinese edition whose example shows 03 E8 |

Vectors: `v3-rx-pia-xzh` (vendor example, 18 registers), `v3-rx-pia-p1-sg`, `v3-rx-pia-p1-sg-b`, `v3-rx-pia-p1-aio` (17 registers).

#### 6.3.2 PIB (0x1100, function 0x04)

| Register | Byte | Field | Type | Scale and unit | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x1100..0x110F | 0..31 | cell voltages 1..16 (`cellVoltages`) | u16 | 0.001 V | [XZH], [SY], [AIO] |
| 0x1110..0x1113 | 32..39 | cell temperatures 1..4 (`cellTemps`) | u16 | 0.1 K | [XZH], [SY], [AIO] |
| 0x1114..0x1117 | 40..47 | reserved temperature slots (`reservedTemps`, raw), 2731 (0.0 °C) in every capture | u16 | | [XZH], [SYP3], [AIO] |
| 0x1118 | 48 | ambient temperature (`ambientTemp`) | u16 | 0.1 K | [XZH], [SY], [AIO] |
| 0x1119 | 50 | power (MOSFET) temperature (`powerTemp`) | u16 | 0.1 K | [XZH], [SY], [AIO] |

The block always has 16 cell slots; the cell count is SPA 0x1301 and the number of cell temperature sensors SPA 0x1300 ([XZH] SPA, [MR]). Vectors: `v3-rx-pib-xzh`, `v3-rx-pib-p1-sg`, `v3-rx-pib-p1-sg-b`, `v3-rx-pib-p1-aio`, `v3-rx-pib-p1-sp05b-repaired`.

#### 6.3.3 PIC (0x1200, function 0x01, 144 coils = 18 bytes)

| Coil | Byte | Field | Bits | Sources |
| --- | --- | --- | --- | --- |
| 0x1200 | 0 | cells 1..8 low voltage alarm | bit 0 = cell 1 | [XZH] PIC and example "Cells 08–01" |
| 0x1208 | 1 | cells 9..16 low voltage alarm | | [XZH] |
| 0x1210 | 2 | cells 1..8 high voltage alarm | | [XZH] |
| 0x1218 | 3 | cells 9..16 high voltage alarm | | [XZH] |
| 0x1220 | 4 | cell temperatures 1..8 low alarm | | [XZH] |
| 0x1228 | 5 | cell temperatures 1..8 high alarm | | [XZH] |
| 0x1230 | 6 | cells 1..8 balancing | 1 = balancing | [XZH], [MR] |
| 0x1238 | 7 | cells 9..16 balancing | | [XZH] |
| 0x1240 | 8 | system state | table 9.9 | [XZH] |
| 0x1248 | 9 | voltage events | table 9.9 | [XZH] |
| 0x1250 | 10 | cell temperature events | | [XZH] |
| 0x1258 | 11 | ambient and power temperature events | | [XZH] |
| 0x1260 | 12 | current events 1 | | [XZH] |
| 0x1268 | 13 | current events 2 | | [XZH] |
| 0x1270 | 14 | remaining capacity events | | [XZH] |
| 0x1278 | 15 | FET (switch) state | | [XZH], [MR] |
| 0x1280 | 16 | balancing state events | | [XZH] |
| 0x1288 | 17 | hardware failure events | | [XZH] |

Vectors (key `bytes`): `v3-rx-pic-xzh`, `v3-rx-pic-p1-sp05b` (system state 0x10, FET state 0x03).

#### 6.3.4 VIA (0x1700, function 0x04, 51 registers)

| Register | Byte | Field | Size | Sources |
| --- | --- | --- | --- | --- |
| 0x1700 | 0 | manufacturer name (`manufacturer`): "XZH-ElecTech Co.,Ltd" | 20 ASCII | [XZH], [DSB], [SYP3] |
| 0x170A | 20 | device name (`deviceName`): "SG16S200A-SP57B-A" | 20 ASCII, NUL padded | [XZH], [DSB], [SYP3] |
| 0x1714 | 40 | firmware version (`firmware`): "15" | 2 ASCII | [XZH], [DSB] (shows "1.5"), [SYP3] |
| 0x1715 | 42 | BMS QR code (serial) (`bmsSerial`): "SP57B-A2506120022" | 30 ASCII | [XZH], [DSB], [SYP3] |
| 0x1724 | 72 | pack QR code (`packSerial`), empty in the capture | 30 ASCII | [XZH], [SYP3] |

Strings are in natural byte order (first character in the high byte of the register) and NUL padded ([SYP3] `v3-rx-via-sg`). [XZH] marks the device name and both QR codes R/W; ubms keeps them read only.

#### 6.3.5 PCT (0x1800, function 0x04, 36 registers)

| Register | Byte | Field | Size | Sources |
| --- | --- | --- | --- | --- |
| 0x1800 | 0 | inverter protocol (`protocol`), table 9.8; firmware V1.43l publishes this word low byte first (05 00 = 5) while every other register is high byte first | u16 | [XZH], [SO] `findings.md` (`Protocol_Load`), `v3-rx-pct-sp05b` |
| 0x1801 | 2 | inverter link rate (`baud`): 500 (CAN, kbit/s) | u16 | [XZH] "kbps / bps", [SYP3] |
| 0x1802 | 4 | inverter name (`inverterName`): "SUN-3.6K-SG03P1-EU", "MultiPlus-II 48/3000/35" | 32 ASCII | [XZH], [SYP3] |
| 0x1812 | 36 | protocol name (`protocolName`): "Pylon CAN Protocol", "Victron Can Protocol" | 32 ASCII | [XZH], [SYP3] |
| 0x1822 | 68 | protocol version (`protocolVersion`): "20" | 2 ASCII | [XZH], [SYP3] |
| 0x1823 | 70 | protocol pre-fetch flags (`prefetch`) | u16 | [XZH], [SO] |

The selected protocol is also SPA register 0x1368 ([SO] `docs/protocols.md`, [MR] "Pcs protocol"). Vectors: `v3-rx-pct-sg` (protocol 0), `v3-rx-pct-sp05b` (protocol 5).

#### 6.3.6 EIA (0x2000, function 0x04, 26 registers, bank summary)

32-bit values are sent low word first: `14 A4 00 00` = 0x000014A4 = 52.84 V ([XZH] EIA, [AIO] `swap32`, [SY] `decode_eia_data_`).

| Register | Byte | Field | Type | Scale and unit | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x2000 | 0 | bank voltage (`voltage`) | u32 | 0.01 V | [XZH], [SY], [AIO] |
| 0x2002 | 4 | bank current (`current`) | s32 | **0.1 A** | [XZH], [SY], [AIO] |
| 0x2004 | 8 | remaining capacity (`remainingAh`) | u32 | 0.01 Ah | [XZH], [SY], [AIO] |
| 0x2006 | 12 | total capacity (`totalAh`) | u32 | 0.01 Ah | [XZH], [SY] |
| 0x2008 | 16 | total discharged capacity (`dischargedAh`) | u32 | 10 Ah | [XZH], [SY] |
| 0x200A | 20 | total rated capacity (`ratedAh`) | u32 | 0.01 Ah | [XZH], [SY], [AIO] |
| 0x200C | 24 | online pack flags (`onlineMask`), bit 0 = first pack | u32 | | [XZH] |
| 0x200E | 28 | protected pack flags (`protectMask`) | u32 | | [XZH] |
| 0x2010 | 32 | suggested maximum discharge current (`maxDischargeCurrent`) | u32 | 0.1 A | [XZH], [SY] |
| 0x2012 | 36 | suggested maximum charge current (`maxChargeCurrent`) | u32 | 0.1 A | [XZH], [SY] |
| 0x2014 | 40 | suggested pack over-voltage (`suggestOv`) | u16 | 0.1 V | [XZH] |
| 0x2015 | 42 | suggested pack under-voltage (`suggestUv`) | u16 | 0.1 V | [XZH] |
| 0x2016 | 44 | number of packs in parallel (`packCount`) | u16 | | [XZH], [AIO] |
| 0x2017 | 46 | average cycle count (`cycles`) | u16 | | [XZH], [AIO] |
| 0x2018 | 48 | SOC (`soc`) | u16 | 0.1 % | [XZH], [AIO] |
| 0x2019 | 50 | SOH (`soh`) | u16 | 0.1 % | [XZH], [AIO] |

Vectors: `v3-rx-eia-xzh`, `v3-rx-eia-sg`, `v3-rx-eia-sg-b`, `v3-rx-eia-aio` (2 packs), `v3-rx-eia-sp05b-repaired`.

#### 6.3.7 EIB (0x2100, function 0x04, 22 registers, bank extremes)

| Register | Byte | Field | Type | Scale | Sources |
| --- | --- | --- | --- | --- | --- |
| 0x2100 | 0 | highest cell voltage (`maxCellVoltage`) | u16 | 0.001 V | [XZH], [SY] |
| 0x2101 | 2 | lowest cell voltage (`minCellVoltage`) | u16 | 0.001 V | [XZH] |
| 0x2102 | 4 | highest cell position (`maxCellPos`), from 0 | u16 | | [XZH] |
| 0x2103 | 6 | lowest cell position (`minCellPos`), from 0 | u16 | | [XZH] |
| 0x2104 | 8 | highest pack voltage (`maxPackVoltage`) | u16 | 0.01 V | [XZH] |
| 0x2105 | 10 | lowest pack voltage (`minPackVoltage`) | u16 | 0.01 V | [XZH] |
| 0x2106 | 12 | highest pack voltage position (`maxPackPos`) | u16 | | [XZH] |
| 0x2107 | 14 | lowest pack voltage position (`minPackPos`) | u16 | | [XZH] |
| 0x2108 | 16 | highest cell temperature (`maxCellTemp`) | s16 | **0.1 °C** (not Kelvin) | [XZH] example "00 B3 = 17.9 °C", [SY] |
| 0x2109 | 18 | lowest cell temperature (`minCellTemp`) | s16 | 0.1 °C | [XZH] |
| 0x210A | 20 | average cell temperature (`avgCellTemp`) | s16 | 0.1 °C | [XZH] |
| 0x210B | 22 | highest temperature position (`maxTempPos`) | u16 | | [XZH] |
| 0x210C | 24 | lowest temperature position (`minTempPos`) | u16 | | [XZH] |
| 0x210D | 26 | highest pack SOC (`maxSoc`) | u16 | 0.1 % | [XZH] |
| 0x210E | 28 | lowest pack SOC (`minSoc`) | u16 | 0.1 % | [XZH] |
| 0x210F | 30 | highest pack cycle count (`maxCycles`) | u16 | | [XZH] |
| 0x2110 | 32 | highest SOH (`maxSoh`) | u16 | 0.1 % | [XZH] |
| 0x2111 | 34 | highest power temperature (`maxPowerTemp`) | s16 | 0.1 °C | [XZH] |
| 0x2112 | 36 | lowest power temperature (`minPowerTemp`) | s16 | 0.1 °C | [XZH] |
| 0x2113 | 38 | average power temperature (`avgPowerTemp`) | s16 | 0.1 °C | [XZH] |
| 0x2114 | 40 | highest power temperature position (`maxPowerTempPos`) | u16 | | [XZH] |
| 0x2115 | 42 | lowest power temperature position (`minPowerTempPos`) | u16 | | [XZH] |

[SO] `docs/protocols.md`: the firmware's Pylon CAN sender takes the lowest cell position from the register named "highest" and vice versa; either the document or the firmware swaps the position pairs (**unverified** which). Vectors: `v3-rx-eib-xzh`, `v3-rx-eib-aio`, `v3-rx-eib-sp05b-repaired`.

#### 6.3.8 EIC (0x2200, function 0x01, 80 coils = 10 bytes)

| Coil | Byte | Field | Sources |
| --- | --- | --- | --- |
| 0x2200 | 0 | system state, table 9.9 | [XZH], [SY] |
| 0x2208 | 1 | voltage events | [XZH], [AIO] |
| 0x2210 | 2 | cell temperature events | [XZH] |
| 0x2218 | 3 | ambient and power temperature events | [XZH] |
| 0x2220 | 4 | current events 1 | [XZH] |
| 0x2228 | 5 | current events 2 | [XZH] |
| 0x2230 | 6 | remaining capacity events | [XZH] |
| 0x2238 | 7 | FET state | [XZH], [AIO] |
| 0x2240 | 8 | balancing state events | [XZH] |
| 0x2248 | 9 | hardware failure events | [XZH] |

Vectors (key `bytes`): `v3-rx-eic-xzh`, `v3-rx-eic-sg` (FET byte 0x43: bit 6 set, undocumented), `v3-rx-eic-sp05b-repaired`.

## 7. Settings

### 7.1 V2 parameter block (V2 ASCII 0x47 / 0xA1 and V2 BLE 0x47 / 0xA1)

Read: 0x47 (section 6.1.3). Write: 0xA1 with the complete 169 byte block, every field as read except the changed ones ([IC] records 7826 and 8512: the vendor PC tool changed only the rated capacity, 160.00 to 170.00 Ah and back, and sent all other bytes unchanged, `v2a-tx-a1-rated-170`, `v2a-tx-a1-rated-160`; [BLEPDF] 4.5 documents the same command over Bluetooth, `v2b-tx-a1-doc`). There is no single parameter write: 0x49 has no documented layout and no source uses it. Status: write confirmed by a capture over RS485 (the BMS answered both writes with RTN 0x00, [IC] records 7826 and 8512, `v2a-rx-a1-ack`; no read back of 0x47 after a write is published); over Bluetooth documented by the vendor, not captured.

Two byte parameters (INFO offset 2 + 2i), names from [BLEPDF] table 21 and [BSX] `int_para`:

| i | INFO offset | Key | Name | Raw | Scale and unit | ubms id |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2 | `cellHighAlarm` | cell high voltage alarm | u16 | 0.001 V | `cell.ov_alarm` |
| 1 | 4 | `cellHighAlarmRecovery` | cell high voltage alarm recovery | u16 | 0.001 V | `seplos.cell_ov_alarm_recovery` |
| 2 | 6 | `cellLowAlarm` | cell low voltage alarm | u16 | 0.001 V | `cell.uv_alarm` |
| 3 | 8 | `cellLowAlarmRecovery` | cell low voltage alarm recovery | u16 | 0.001 V | `seplos.cell_uv_alarm_recovery` |
| 4 | 10 | `cellOvp` | cell overvoltage protection | u16 | 0.001 V | `cell.ovp` |
| 5 | 12 | `cellOvpRecovery` | cell overvoltage recovery | u16 | 0.001 V | `cell.ovpr` |
| 6 | 14 | `cellUvp` | cell undervoltage protection | u16 | 0.001 V | `cell.uvp` |
| 7 | 16 | `cellUvpRecovery` | cell undervoltage recovery | u16 | 0.001 V | `cell.uvpr` |
| 8 | 18 | `balanceStartVoltage` | balancing turn-on voltage | u16 | 0.001 V | `balance.start_voltage` |
| 9 | 20 | `lowVoltageChargeForbid` | cell low voltage charging prohibited below | u16 | 0.001 V | `seplos.low_voltage_charge_forbid` |
| 10 | 22 | `packHighAlarm` | total voltage high alarm | u16 | 0.01 V | `pack.ov_alarm` |
| 11 | 24 | `packHighAlarmRecovery` | total voltage high alarm recovery | u16 | 0.01 V | `seplos.pack_ov_alarm_recovery` |
| 12 | 26 | `packLowAlarm` | total voltage low alarm | u16 | 0.01 V | `pack.uv_alarm` |
| 13 | 28 | `packLowAlarmRecovery` | total voltage low alarm recovery | u16 | 0.01 V | `seplos.pack_uv_alarm_recovery` |
| 14 | 30 | `packOvp` | total voltage overvoltage protection | u16 | 0.01 V | `pack.ovp` |
| 15 | 32 | `packOvpRecovery` | total voltage overvoltage recovery | u16 | 0.01 V | `pack.ovpr` |
| 16 | 34 | `packUvp` | total voltage undervoltage protection | u16 | 0.01 V | `pack.uvp` |
| 17 | 36 | `packUvpRecovery` | total voltage undervoltage recovery | u16 | 0.01 V | `pack.uvpr` |
| 18 | 38 | `chargeOvp` | charging overvoltage protection (pack, charger side) | u16 | 0.01 V | `seplos.charge_ovp` |
| 19 | 40 | `chargeOvpRecovery` | charging overvoltage recovery | u16 | 0.01 V | `seplos.charge_ovp_recovery` |
| 20 | 42 | `chargeHighTempAlarm` | charging high temperature alarm | u16 | 0.1 K | `seplos.charge_ot_alarm` |
| 21 | 44 | `chargeHighTempAlarmRecovery` | charging high temperature alarm recovery | u16 | 0.1 K | `seplos.charge_ot_alarm_recovery` |
| 22 | 46 | `chargeLowTempAlarm` | charging low temperature alarm | u16 | 0.1 K | `seplos.charge_ut_alarm` |
| 23 | 48 | `chargeLowTempAlarmRecovery` | charging low temperature alarm recovery | u16 | 0.1 K | `seplos.charge_ut_alarm_recovery` |
| 24 | 50 | `chargeOtp` | charging overtemperature protection | u16 | 0.1 K | `charge.otp` |
| 25 | 52 | `chargeOtpRecovery` | charging overtemperature recovery | u16 | 0.1 K | `charge.otpr` |
| 26 | 54 | `chargeUtp` | charging undertemperature protection | u16 | 0.1 K | `charge.utp` |
| 27 | 56 | `chargeUtpRecovery` | charging undertemperature recovery | u16 | 0.1 K | `charge.utpr` |
| 28 | 58 | `dischargeHighTempAlarm` | discharge high temperature alarm | u16 | 0.1 K | `seplos.discharge_ot_alarm` |
| 29 | 60 | `dischargeHighTempAlarmRecovery` | discharge high temperature alarm recovery | u16 | 0.1 K | `seplos.discharge_ot_alarm_recovery` |
| 30 | 62 | `dischargeLowTempAlarm` | discharge low temperature alarm | u16 | 0.1 K | `seplos.discharge_ut_alarm` |
| 31 | 64 | `dischargeLowTempAlarmRecovery` | discharge low temperature alarm recovery | u16 | 0.1 K | `seplos.discharge_ut_alarm_recovery` |
| 32 | 66 | `dischargeOtp` | discharge overtemperature protection | u16 | 0.1 K | `discharge.otp` |
| 33 | 68 | `dischargeOtpRecovery` | discharge overtemperature recovery | u16 | 0.1 K | `discharge.otpr` |
| 34 | 70 | `dischargeUtp` | discharge undertemperature protection | u16 | 0.1 K | `discharge.utp` |
| 35 | 72 | `dischargeUtpRecovery` | discharge undertemperature recovery | u16 | 0.1 K | `discharge.utpr` |
| 36 | 74 | `heatingStart` | cell low temperature heating (start) | u16 | 0.1 K | `seplos.heating_start` |
| 37 | 76 | `heatingStop` | cell heating recovery (stop) | u16 | 0.1 K | `seplos.heating_stop` |
| 38 | 78 | `ambientHighAlarm` | ambient high temperature alarm | u16 | 0.1 K | `seplos.ambient_ot_alarm` |
| 39 | 80 | `ambientHighAlarmRecovery` | ambient high temperature alarm recovery | u16 | 0.1 K | `seplos.ambient_ot_alarm_recovery` |
| 40 | 82 | `ambientLowAlarm` | ambient low temperature alarm | u16 | 0.1 K | `seplos.ambient_ut_alarm` |
| 41 | 84 | `ambientLowAlarmRecovery` | ambient low temperature alarm recovery | u16 | 0.1 K | `seplos.ambient_ut_alarm_recovery` |
| 42 | 86 | `ambientOtp` | ambient overtemperature protection | u16 | 0.1 K | `seplos.ambient_otp` |
| 43 | 88 | `ambientOtpRecovery` | ambient overtemperature recovery | u16 | 0.1 K | `seplos.ambient_otp_recovery` |
| 44 | 90 | `ambientUtp` | ambient undertemperature protection | u16 | 0.1 K | `seplos.ambient_utp` |
| 45 | 92 | `ambientUtpRecovery` | ambient undertemperature recovery | u16 | 0.1 K | `seplos.ambient_utp_recovery` |
| 46 | 94 | `powerHighAlarm` | power (MOSFET) high temperature alarm | u16 | 0.1 K | `seplos.mos_ot_alarm` |
| 47 | 96 | `powerHighAlarmRecovery` | power high temperature alarm recovery | u16 | 0.1 K | `seplos.mos_ot_alarm_recovery` |
| 48 | 98 | `powerOtp` | power overtemperature protection | u16 | 0.1 K | `mos.otp` |
| 49 | 100 | `powerOtpRecovery` | power overtemperature recovery | u16 | 0.1 K | `mos.otpr` |
| 50 | 102 | `chargeOcAlarm` | charging overcurrent alarm | s16 | 0.01 A | `charge.oc_alarm` |
| 51 | 104 | `chargeOcAlarmRecovery` | charging overcurrent alarm recovery | s16 | 0.01 A | `seplos.charge_oc_alarm_recovery` |
| 52 | 106 | `dischargeOcAlarm` | discharge overcurrent alarm, negative | s16 | 0.01 A | `discharge.oc_alarm` |
| 53 | 108 | `dischargeOcAlarmRecovery` | discharge overcurrent alarm recovery, negative | s16 | 0.01 A | `seplos.discharge_oc_alarm_recovery` |
| 54 | 110 | `chargeOcp` | charging overcurrent protection | s16 | 0.01 A | `charge.ocp` |
| 55 | 112 | `dischargeOcp` | discharge overcurrent protection, negative | s16 | 0.01 A | `discharge.ocp` |
| 56 | 114 | `transientOcp` | transient overcurrent protection, negative | s16 | 0.01 A | `discharge.ocp2` |
| 57 | 116 | `softStartDelayMs` | output soft start delay | u16 | 1 ms | `seplos.soft_start_delay` |
| 58 | 118 | `ratedCapacityAh` | battery rated capacity | u16 | 0.01 Ah | `capacity.nominal` |
| 59 | 120 | `remainingCapacityAh` | battery remaining capacity (live value; [BSX] labels it "SOC") | u16 | 0.01 Ah | `capacity.remaining` |

One byte parameters (INFO offset 123 + j), names from [BLEPDF] and [BSX] ParaIndex 0x3C..0x56 (units from [BSX]: "When" = hour):

| j | INFO offset | Key | Name | Scale and unit | ubms id |
| --- | --- | --- | --- | --- | --- |
| 0 | 123 | `cellFailureDiff` | cell failure voltage difference | 0.01 V | `cell.diff_protection` |
| 1 | 124 | `cellFailureDiffRecovery` | cell failure recovery | 0.01 V | `seplos.cell_diff_protection_recovery` |
| 2 | 125 | `balanceStartDiff` | balancing opening voltage difference | 0.001 V | `balance.trigger_delta` |
| 3 | 126 | `balanceStopDiff` | balancing end voltage difference | 0.001 V | `seplos.balance_stop_delta` |
| 4 | 127 | `staticBalanceHours` | static balancing time | 1 h | `seplos.static_balance_time` |
| 5 | 128 | `cellCount` | number of cells in series, 8 to 16 ([MAN100] "8-16 cells in series", [MAN200] "8s-16s", [BSX] Cell01..Cell16; 0x44 and 0x61 carry two balancing bytes) | 1 | `system.cell_count` |
| 6 | 129 | `chargeOcDelayS` | charging overcurrent delay | 1 s | `charge.ocp_delay` |
| 7 | 130 | `dischargeOcDelayS` | discharge overcurrent delay | 1 s | `discharge.ocp_delay` |
| 8 | 131 | `transientOcDelayMs` | transient overcurrent delay | 1 ms | `discharge.ocp2_delay` |
| 9 | 132 | `ocRecoveryDelayS` | overcurrent recovery delay | 1 s | `seplos.oc_recovery_delay` |
| 10 | 133 | `ocRecoveryTimes` | overcurrent recovery times (then lockout) | 1 | `seplos.oc_lockout_count` |
| 11 | 134 | `chargeCurrentLimitDelayMin` | charging current limit delay | 1 min | `seplos.charge_limit_delay` |
| 12 | 135 | `chargeActivationDelayMin` | charge activation delay | 1 min | `seplos.charge_activation_delay` |
| 13 | 136 | `chargeActivationIntervalH` | charging activation interval | 1 h | `seplos.charge_activation_interval` |
| 14 | 137 | `chargeActivationTimes` | number of charging activations | 1 | `seplos.charge_activation_count` |
| 15 | 138 | `workRecordIntervalMin` | work record interval | 1 min | `seplos.work_record_interval` |
| 16 | 139 | `standbyRecordIntervalMin` | standby record interval | 1 min | `seplos.standby_record_interval` |
| 17 | 140 | `standbyShutdownDelayH` | standby shutdown delay | 1 h | `system.sleep_delay` (unit h) |
| 18 | 141 | `socAlarmPercent` | remaining capacity alarm | 1 % | `soc.low_alarm` |
| 19 | 142 | `socProtectPercent` | remaining capacity protection | 1 % | `seplos.soc_low_protection` |
| 20 | 143 | `intermittentChargeSocPercent` | intermittent (top-up) charge capacity | 1 % | `seplos.top_up_soc` |
| 21 | 144 | `cycleCapacityPercent` | cycle cumulative capacity (share of the rated capacity counted as one cycle) | 1 % | `seplos.cycle_capacity_ratio` |
| 22 | 145 | `connectionFaultMilliohm` | connection fault impedance | 0.1 mΩ | `seplos.connection_fault_resistance` |
| 23 | 146 | `comp1Cell` | compensation point 1 position (cell 1..16; whether 0 means "off" is **unverified**) | 1 | `seplos.comp1_cell` |
| 24 | 147 | `comp1Milliohm` | compensation point 1 impedance | 0.1 mΩ | `seplos.comp1_resistance` |
| 25 | 148 | `comp2Cell` | compensation point 2 position (cell 1..16; 0 as above) | 1 | `seplos.comp2_cell` |
| 26 | 149 | `comp2Milliohm` | compensation point 2 impedance | 0.1 mΩ | `seplos.comp2_resistance` |

Byte parameter units: [BLEPDF] table 21 rows 76..96 are garbled in the published PDF; the units above follow [BSX] (`UnitName` per ParaIndex), and both agree on order and scale for the voltage and impedance rows. The meaning of `cycleCapacityPercent` is inferred from its name (**unverified**).

Encoding rules:

- Temperatures: raw = round(°C × 10) + 2731 ([IC] `IntParam.encode`: (value + 273.1) / 0.1). syssi decodes with 273.15 ([SY] `decode_settings_data_`), which shifts every value by 0.05 °C; use 2731 ([V2PDF] table 9, [BLEPDF] table 5).
- Discharge currents (i = 52, 53, 55, 56) are stored negative (two's complement): every capture shows negative values (`v2a-rx-47-za11`: −155.00, −153.00, −160.00, −300.00 A; [BLEPDF] example: −110.00, −105.00, −120.00, −180.00 A; [AIO] decodes the discharge OCP with scale −0.01). ubms shows the magnitude for the canonical ids (`discharge.ocp` is a positive current elsewhere) and writes the negative raw value.
- Ranges: no source gives limits for the V2 parameters. Validate the usual relations before a write (protection beyond alarm, recovery between alarm and normal; e.g. `cell.ovpr` < `cell.ovp`, `cell.uvpr` > `cell.uvp`) and show the vendor's cell chemistry context (LFP defaults in the captures: cell OVP 3.65 V, UVP 2.70 V). Every captured block and vendor example follows them (`v2a-rx-47-za11`, `v2b-rx-47-sp76`, `v2b-rx-47-doc`); the relations implemented are listed in 7.7.
- `cellCount`, `model` and the remaining capacity need care: `model` is read only (identity), `cellCount` is marked danger (wrong values stop the protection) and limited to the 8 to 16 cells of the V2 boards (row j = 5), and `remainingCapacityAh` changes while the pack works, so read 0x47 immediately before every 0xA1 and send the fresh value unless the user edits it (**unverified** how the BMS treats a stale remaining capacity).
- Group byte: the block starts with the group byte 0x00 as read; the 0x47 request and the 0xA1 write are captured only at address 0 ([IC] records 352, 7826), so whether a pack at another DIP address accepts them with group 0 is **unverified** (4.1 step 6).

Vectors: `v2a-rx-47-za11`, `v2b-rx-47-sp76`, `v2b-rx-47-doc` (reads), `v2a-tx-a1-rated-170`, `v2a-tx-a1-rated-160`, `v2b-tx-a1-doc` (writes).

### 7.2 V2 function switches (8 bytes at INFO offset 151)

Bit = 1 enables the function ([BLEPDF] "Function switch bit (1: open, 0: closure)", [BSX] `bit_para`, [SY] `decode_settings_data_` names). Bytes 1 to 6 enable the alarms and protections of the alarm event bytes 1 to 6 bit for bit (table 9.2), except byte 6 bit 1, which enables the intermittent (top-up) charge function, not its waiting event ([BSX] `bit_para` "Intermittent charging function", ByteIndex 5 BitIndex 1); byte 6 bit 7 and bytes 7 and 8 enable functions:

| Byte | Bit | Function | ubms id |
| --- | --- | --- | --- |
| 1..5 | 0..7 | enable of alarm event 1..5 bit b (table 9.2) | `seplos.fn_event<byte>_<bit>`, advanced, danger except 4.6 |
| 6 | 0, 2..6 | enable of alarm event 6 bit b | `seplos.fn_event6_<bit>`, advanced, danger |
| 6 | 1 | intermittent (top-up) charge function | `seplos.fn_top_up` (the V3 id of the same function, 7.4) |
| 6 | 7 | output soft start function | `seplos.fn_soft_start` |
| 7 | 0 | charge balancing function | `balance.enabled` |
| 7 | 1 | static balancing function | `seplos.fn_static_balance` |
| 7 | 2 | balancing stops after the timeout | `seplos.fn_balance_timeout` |
| 7 | 3 | balancing stops when over temperature | `seplos.fn_balance_overtemp` |
| 7 | 4 | automatic charge activation | `seplos.fn_auto_charge_activation` |
| 7 | 5 | manual charge activation | `seplos.fn_manual_charge_activation` |
| 7 | 6 | active current limiting while charging | `seplos.fn_active_current_limit` |
| 7 | 7 | passive current limiting while charging | `seplos.fn_passive_current_limit` |
| 8 | 0 | switch (button) shutdown function | `seplos.fn_switch_shutdown` |
| 8 | 1 | standby power off | `seplos.fn_standby_power_off` |
| 8 | 2 | history recording | `seplos.fn_history` |
| 8 | 3 | LCD display | `seplos.fn_lcd` |
| 8 | 4 | Bluetooth communication | `seplos.fn_bluetooth` (read only: switching it off over Bluetooth cuts the link) |
| 8 | 5 | automatic address coding | `seplos.fn_auto_address` |
| 8 | 6 | parallel external polling | `seplos.fn_parallel_polling` |
| 8 | 7 | standalone 1.0 C charging | `seplos.fn_1c_charging` |

Clearing an enable bit of bytes 1 to 6 switches that alarm, protection, lockout or failure detection off (byte 2 bit 1, for example, the cell overvoltage protection). ubms marks these 45 bits danger (a confirmation before the write) and says so in their description; byte 4 bit 6 (cell heating) and byte 6 bit 1 (top-up charge) are functions and are not marked.

Captured values: `FF FF FF 3F BF 9F AF 1E` (1101-ZA11 and 1101-SP76), `FF FF FF 3F BF 1F AF 1E` ([BLEPDF] example). syssi decodes INFO 129..136 (frame 136..143) as the function switches; those are the one byte parameters 6..13, the switches are at frame offsets 158..165 ([BLEPDF] table 21; `v2b-rx-47-sp76`). Do not copy syssi's offsets.

### 7.3 V3 SPA configuration parameters (0x1300..0x1369)

Read: function 0x04 (section 5.3). Write: function 0x10 ([XZH] SPA "FC 0x04 read, 0x10 write", R/W column; [SO] `register_write.c` `Reg_WriteWords` case 0x1300; [MR] "Writing to the SPA & SCA registers will change the settings"). Status: the write is documented by the vendor and implemented in the decompiled firmware; Seplos itself gave a function 0x10 example for register 0x1800 (`00 10 18 00 00 01 02 00 01 F2 01`, [XZH] "Notes from Seplos", `v3-tx-write-1800`); no capture of an SPA write exists (**unverified** on the wire).

Firmware V1.43l behaviour ([SO] `Reg_WriteWords`):

- A write of exactly one register is applied but not saved to flash; it is lost at the next restart. A write of two or more registers is applied and saved. Write the target register together with a neighbouring register that holds its freshly read value (section 7.5).
- The remaining capacity (0x135A) is limited to the full capacity (0x1359), and both are copied into the battery record.
- While the BMS is busy with its parameters (task flag bit 3) the write is refused with exception 0x06; retry after a second.
- A write that runs past 0x1369 (106 registers) gets exception 0x02.
- No value is range checked: the registers are copied as written ([SO] `Reg_WriteWords` case 0x1300), so a protection below its recovery value or a negative charge current is stored and used. The checks of 7.7 are the only guard.
- Ranges: no source gives limits. ubms keeps cell voltages within 1..5 V, differences within 0..2 V, other voltages within 0..100 V, temperatures within −40..120 °C, percentages within 0..100 % and every current (s16 registers, charge values positive, discharge values as magnitudes) within 0..1000 A. The current bound is a plausibility bound of ubms, not a vendor limit: the captured 200 A board holds at most 350 A (`v3-rx-spa1-sg`), and the raw range of ±32767 A would let a sign or digit typo invert or switch off a protection.

| Register | Key | Name | Type | Scale and unit | ubms id | Write |
| --- | --- | --- | --- | --- | --- | --- |
| 0x1300 | `ntcCount` | number of cell temperature sensors, 1 to 4 (PIB has 4 slots; 0 would remove every cell temperature protection) | u16 | 1 | `system.temp_sensor_count` | danger |
| 0x1301 | `cellCount` | number of cells in series, at most 16 (PIB has 16 cell slots); no V3 source gives the minimum (**unverified**, ubms allows 1) | u16 | 1 | `system.cell_count` | danger |
| 0x1302 | | pack high voltage alarm recovery | u16 | 0.01 V | `seplos.pack_ov_alarm_recovery` | yes |
| 0x1303 | | pack high voltage alarm | u16 | 0.01 V | `pack.ov_alarm` | yes |
| 0x1304 | | pack overvoltage protection recovery | u16 | 0.01 V | `pack.ovpr` | yes |
| 0x1305 | | pack overvoltage protection | u16 | 0.01 V | `pack.ovp` | yes |
| 0x1306 | | pack low voltage alarm recovery | u16 | 0.01 V | `seplos.pack_uv_alarm_recovery` | yes |
| 0x1307 | | pack low voltage alarm | u16 | 0.01 V | `pack.uv_alarm` | yes |
| 0x1308 | | pack undervoltage protection recovery | u16 | 0.01 V | `pack.uvpr` | yes |
| 0x1309 | | pack undervoltage protection | u16 | 0.01 V | `pack.uvp` | yes |
| 0x130A | | cell high voltage alarm recovery | u16 | 0.001 V | `seplos.cell_ov_alarm_recovery` | yes |
| 0x130B | | cell high voltage alarm | u16 | 0.001 V | `cell.ov_alarm` | yes |
| 0x130C | | cell overvoltage protection recovery | u16 | 0.001 V | `cell.ovpr` | yes |
| 0x130D | | cell overvoltage protection | u16 | 0.001 V | `cell.ovp` | yes |
| 0x130E | | cell low voltage alarm recovery | u16 | 0.001 V | `seplos.cell_uv_alarm_recovery` | yes |
| 0x130F | | cell low voltage alarm | u16 | 0.001 V | `cell.uv_alarm` | yes |
| 0x1310 | | cell undervoltage protection recovery | u16 | 0.001 V | `cell.uvpr` | yes |
| 0x1311 | | cell undervoltage protection | u16 | 0.001 V | `cell.uvp` | yes |
| 0x1312 | | cell undervoltage failure | u16 | 0.001 V | `seplos.cell_uv_failure` | yes |
| 0x1313 | | cell voltage difference protection | u16 | 0.001 V | `cell.diff_protection` | yes |
| 0x1314 | | cell voltage difference protection recovery ([XZHEN] keeps V0.1's label "Secondary Charge current") | u16 | 0.001 V | `seplos.cell_diff_protection_recovery` | yes |
| 0x1315 | | charge overcurrent recovery | s16 | 1 A | `seplos.charge_oc_recovery` | yes |
| 0x1316 | | charge overcurrent alarm | s16 | 1 A | `charge.oc_alarm` | yes |
| 0x1317 | | charge overcurrent protection | s16 | 1 A | `charge.ocp` | yes |
| 0x1318 | | charge overcurrent delay | u16 | 0.1 s | `charge.ocp_delay` | yes |
| 0x1319 | | charge overcurrent protection, level 2 | s16 | 1 A | `seplos.charge_ocp2` | yes |
| 0x131A | | charge overcurrent delay, level 2 | u16 | 1 ms | `seplos.charge_ocp2_delay` | yes |
| 0x131B | | discharge overcurrent recovery, negative | s16 | 1 A | `seplos.discharge_oc_recovery` | yes |
| 0x131C | | discharge overcurrent alarm, negative | s16 | 1 A | `discharge.oc_alarm` | yes |
| 0x131D | | discharge overcurrent protection, negative | s16 | 1 A | `discharge.ocp` | yes |
| 0x131E | | discharge overcurrent delay | u16 | 0.1 s | `discharge.ocp_delay` | yes |
| 0x131F | | discharge overcurrent protection, level 2, negative | s16 | 1 A | `discharge.ocp2` | yes |
| 0x1320 | | discharge overcurrent delay, level 2 | u16 | 1 ms | `discharge.ocp2_delay` | yes |
| 0x1321 | | output short circuit protection, negative | s16 | 1 A | `scp.current` | yes |
| 0x1322 | | output short circuit delay | u16 | 1 µs | `scp.delay` | yes |
| 0x1323 | | overcurrent recovery delay | u16 | 0.1 s | `seplos.oc_recovery_delay` | yes |
| 0x1324 | | overcurrent lockout count | u16 | 1 | `seplos.oc_lockout_count` | yes |
| 0x1325 | | charge current limit duration | u16 | 0.1 s | `seplos.charge_limit_duration` | yes |
| 0x1326 | | pulse current limit current | s16 | 1 A | `seplos.pulse_limit_current` | yes |
| 0x1327 | | pulse current limit time | u16 | 0.1 s | `seplos.pulse_limit_time` | yes |
| 0x1328 | | float charge lock voltage | u16 | 0.001 V | `seplos.float_lock_voltage` | no ([XZH] "/", absent from [XZHEN]) |
| 0x1329 | | float charge release voltage | u16 | 0.001 V | `seplos.float_release_voltage` | no |
| 0x132A | | float charge lock current | s16 | 1 mA | `seplos.float_lock_current` | no |
| 0x132B | | precharge completion ratio, short circuit | u16 | 0.1 % | `seplos.precharge_ratio_short` | yes |
| 0x132C | | precharge completion ratio, normal | u16 | 0.1 % | `seplos.precharge_ratio_normal` | yes |
| 0x132D | | precharge completion ratio, abnormal | u16 | 0.1 % | `seplos.precharge_ratio_abnormal` | yes |
| 0x132E | | precharge timeout | u16 | 0.1 s | `seplos.precharge_timeout` | yes |
| 0x132F | | charge high temperature alarm recovery | u16 | 0.1 K | `seplos.charge_ot_alarm_recovery` | yes |
| 0x1330 | | charge high temperature alarm | u16 | 0.1 K | `seplos.charge_ot_alarm` | yes |
| 0x1331 | | charge overtemperature recovery | u16 | 0.1 K | `charge.otpr` | yes |
| 0x1332 | | charge overtemperature protection | u16 | 0.1 K | `charge.otp` | yes |
| 0x1333 | | charge low temperature alarm recovery | u16 | 0.1 K | `seplos.charge_ut_alarm_recovery` | yes |
| 0x1334 | | charge low temperature alarm | u16 | 0.1 K | `seplos.charge_ut_alarm` | yes |
| 0x1335 | | charge undertemperature recovery | u16 | 0.1 K | `charge.utpr` | yes |
| 0x1336 | | charge undertemperature protection | u16 | 0.1 K | `charge.utp` | yes |
| 0x1337 | | discharge high temperature alarm recovery | u16 | 0.1 K | `seplos.discharge_ot_alarm_recovery` | yes |
| 0x1338 | | discharge high temperature alarm | u16 | 0.1 K | `seplos.discharge_ot_alarm` | yes |
| 0x1339 | | discharge overtemperature recovery | u16 | 0.1 K | `discharge.otpr` | yes |
| 0x133A | | discharge overtemperature protection | u16 | 0.1 K | `discharge.otp` | yes |
| 0x133B | | discharge low temperature alarm recovery | u16 | 0.1 K | `seplos.discharge_ut_alarm_recovery` | yes |
| 0x133C | | discharge low temperature alarm | u16 | 0.1 K | `seplos.discharge_ut_alarm` | yes |
| 0x133D | | discharge undertemperature recovery | u16 | 0.1 K | `discharge.utpr` | yes |
| 0x133E | | discharge undertemperature protection | u16 | 0.1 K | `discharge.utp` | yes |
| 0x133F | | ambient high temperature alarm recovery | u16 | 0.1 K | `seplos.ambient_ot_alarm_recovery` | yes |
| 0x1340 | | ambient high temperature alarm | u16 | 0.1 K | `seplos.ambient_ot_alarm` | yes |
| 0x1341 | | ambient overtemperature recovery | u16 | 0.1 K | `seplos.ambient_otp_recovery` | yes |
| 0x1342 | | ambient overtemperature protection | u16 | 0.1 K | `seplos.ambient_otp` | yes |
| 0x1343 | | ambient low temperature alarm recovery | u16 | 0.1 K | `seplos.ambient_ut_alarm_recovery` | yes |
| 0x1344 | | ambient low temperature alarm | u16 | 0.1 K | `seplos.ambient_ut_alarm` | yes |
| 0x1345 | | ambient undertemperature recovery | u16 | 0.1 K | `seplos.ambient_utp_recovery` | yes |
| 0x1346 | | ambient undertemperature protection | u16 | 0.1 K | `seplos.ambient_utp` | yes |
| 0x1347 | | power high temperature alarm recovery | u16 | 0.1 K | `seplos.mos_ot_alarm_recovery` | yes |
| 0x1348 | | power high temperature alarm | u16 | 0.1 K | `seplos.mos_ot_alarm` | yes |
| 0x1349 | | power overtemperature recovery | u16 | 0.1 K | `mos.otpr` | yes |
| 0x134A | | power overtemperature protection | u16 | 0.1 K | `mos.otp` | yes |
| 0x134B | | cell heating stop | u16 | 0.1 K | `seplos.heating_stop` | yes |
| 0x134C | | cell heating start | u16 | 0.1 K | `seplos.heating_start` | yes |
| 0x134D | | balancing disabled above (high temperature) | u16 | 0.1 K | `seplos.balance_max_temp` | yes |
| 0x134E | | balancing disabled below (low temperature) | u16 | 0.1 K | `seplos.balance_min_temp` | yes |
| 0x134F | | static balancing timer | u16 | 1 h | `seplos.static_balance_time` | yes |
| 0x1350 | | balancing start voltage | u16 | 0.001 V | `balance.start_voltage` | yes |
| 0x1351 | | balancing start voltage difference | u16 | 0.001 V | `balance.trigger_delta` | yes |
| 0x1352 | | balancing end voltage difference | u16 | 0.001 V | `seplos.balance_stop_delta` | yes |
| 0x1353 | | top-up (intermittent) charge SOC | u16 | 0.1 % | `seplos.top_up_soc` | yes |
| 0x1354 | | low SOC alarm recovery | u16 | 0.1 % | `seplos.soc_low_alarm_recovery` | yes |
| 0x1355 | | low SOC alarm | u16 | 0.1 % | `soc.low_alarm` | yes |
| 0x1356 | | low SOC protection recovery | u16 | 0.1 % | `seplos.soc_low_protection_recovery` | yes |
| 0x1357 | | low SOC protection | u16 | 0.1 % | `seplos.soc_low_protection` | yes |
| 0x1358 | | rated capacity | u16 | 0.01 Ah | `capacity.nominal` | yes |
| 0x1359 | | total (full charge) capacity | u16 | 0.01 Ah | `seplos.full_capacity` | yes |
| 0x135A | | remaining capacity (live) | u16 | 0.01 Ah | `capacity.remaining` | yes, limited to 0x1359 |
| 0x135B | | standby sleep timer | u16 | 1 h | `system.sleep_delay` (unit h) | yes |
| 0x135C | | forced output delay | u16 | 0.1 s | `seplos.forced_output_delay` | yes |
| 0x135D | | forced output interval | u16 | 1 min | `seplos.forced_output_interval` | yes |
| 0x135E | | forced output count | u16 | 1 | `seplos.forced_output_count` | yes |
| 0x135F | | compensation point 1 (cell position 1..16; 0 as "off" **unverified**) | u16 | 1 | `seplos.comp1_cell` | yes, 0..16 |
| 0x1360 | | compensation point 1 resistance | u16 | 0.1 mΩ per [XZH], 1 mΩ per [MR] | `seplos.comp1_resistance` | no (**unverified** scale) |
| 0x1361 | | compensation point 2 (cell position 1..16; 0 as above) | u16 | 1 | `seplos.comp2_cell` | yes, 0..16 |
| 0x1362 | | compensation point 2 resistance | u16 | 0.1 mΩ per [XZH], 1 mΩ per [MR] | `seplos.comp2_resistance` | no (**unverified** scale) |
| 0x1363 | | cell voltage difference alarm | u16 | 0.001 V ([MR]: 1 mV) | `cell.diff_alarm` | yes |
| 0x1364 | | cell voltage difference alarm recovery | u16 | 0.001 V | `seplos.cell_diff_alarm_recovery` | yes |
| 0x1365 | | charge request voltage (pack, to the inverter) | u16 | 0.01 V | `seplos.charge_request_voltage` | yes |
| 0x1366 | | charge request current | s16 | 1 A | `seplos.charge_request_current` | yes |
| 0x1367 | | discharge request current, negative | s16 | 1 A | `seplos.discharge_request_current` | yes |
| 0x1368 | | inverter protocol (table 9.8) | u16 | | `seplos.inverter_protocol` | no (changes the inverter link; only [MR] and [SO] describe it) |
| 0x1369 | | current detector correction factor | u16 | | `seplos.current_correction` | no (meaning **unverified**, [MR] only) |

Sources: register list, types and scales [XZH] SPA; cross-checked with [MR] `spa.md` (vendor app table), [AIO] `_LIMIT_FIELDS` (0x1304, 0x1305, 0x1308, 0x1309, 0x130C, 0x130D, 0x1310, 0x1311, 0x1315, 0x1317, 0x1318, 0x131D, 0x131E, 0x1331, 0x1332, 0x1335, 0x1336, 0x1339, 0x133A, 0x133D, 0x133E, 0x1349, 0x134A), [SY] `decode_spa1_data_` / `decode_spa2_data_`, and the captures `v3-rx-spa1-sg`, `v3-rx-spa2-sg`, `v3-rx-spa1-aio`, `v3-rx-spa2-aio` (106 registers from two packs; 0x1358 = 330.00 Ah shows the registers are unsigned, 0x1367 = −180 A shows it is signed although [MR] marks it unsigned).

Example values in [XZH] are not all consistent with their raw bytes (0x1309 "12 0C = 43.20 V", several "0A BB = 0 °C"); trust the raw bytes ([XZH] translator's notes).

### 7.4 V3 SFA function switches (coils 0x1400..0x144F)

Read: function 0x01, 80 coils (10 bytes). Write: function 0x0F ([XZH] SFA "FC 0x01 read, 0x0F write"; [SO] `Reg_WriteBits`: only the 0x1400 block is writable, other coil addresses get exception 0x02; a write of more than one coil is applied and saved, a single coil is applied without saving; a multi-coil write never changes coil 0x142D, bit 5 of byte 0x1428). Status: documented and implemented in the decompiled firmware, not captured (**unverified** on the wire).

| Coil | Byte | Table | ubms ids |
| --- | --- | --- | --- |
| 0x1400 | 0 | voltage function switches, 9.10 a | `seplos.fn_v0` .. `seplos.fn_v7` (advanced) |
| 0x1408 | 1 | cell temperature function switches, 9.10 b | `seplos.fn_ct0` .. `seplos.fn_ct7` (advanced) |
| 0x1410 | 2 | ambient and power temperature function switches, 9.10 c | `seplos.fn_at0` .. `seplos.fn_at7` (advanced) |
| 0x1418 | 3 | function switches (Bluetooth, fan, LEDs, SNMP, Wi-Fi, DHCP, gyro), 9.10 d | `seplos.fn_bluetooth` (read only), `seplos.fn_fan`, `seplos.fn_leds`, `seplos.fn_snmp`, `seplos.fn_wifi`, `seplos.fn_dhcp`, `seplos.fn_gyro` (the last four advanced); bit 7 reserved |
| 0x1420 | 4 | current function switches 1, 9.10 e | `seplos.fn_c1_0` .. `seplos.fn_c1_6` (advanced); bit 7 reserved |
| 0x1428 | 5 | current function switches 2, 9.10 f | `seplos.fn_c2_0` .. `seplos.fn_c2_3` (advanced); bits 4 to 7 reserved |
| 0x1430 | 6 | capacity and other switches, 9.10 g (bit 4 history recording is needed for the calendar) | `seplos.fn_soc_alarm`, `seplos.fn_top_up`, `seplos.fn_external_switch`, `seplos.fn_standby_sleep`, `seplos.fn_history`, `seplos.fn_soc_protection`, `seplos.fn_active_current_limit`, `seplos.fn_passive_current_limit` |
| 0x1438 | 7 | balancing function switches, 9.10 h | `balance.enabled`, `seplos.fn_static_balance`, `seplos.fn_balance_timeout`, `seplos.fn_balance_overtemp`; bits 4 to 7 reserved |
| 0x1440 | 8 | indication function switches, 9.10 i | `switch.buzzer` (buzzer and indicator lights), `seplos.fn_lcd`, `seplos.fn_manual_forced_output`, `seplos.fn_auto_forced_output`, `seplos.fn_uv_recovery`, `seplos.fn_aerosol_test`, `seplos.fn_aerosol_disconnect`, `seplos.fn_current_temp_comp` |
| 0x1448 | 9 | failure detection switches, 9.10 j | `seplos.fn_fd0` .. `seplos.fn_fd7` (advanced) |

Clearing a bit of bytes 0, 1, 2, 4, 5 or 9, or the low SOC alarm and protection bits of byte 6, switches that alarm, protection, lockout or failure detection off (coil 0x1401, for example, the cell overvoltage protection). ubms marks these 44 bits danger (a confirmation before the write, with the description "Off disables this protection or check."); byte 2 bit 6 (cell low temperature heating) is a function and is not marked.

Captured SFA (`v3-rx-sfa-sp05b-repaired`, block identity inferred): FF FF 3F 01 7F 2F 9F 0F 63 6F.

### 7.5 Write procedures

V2 (ASCII and BLE):

1. Read 0x47; decode the block.
2. Change the field(s); keep every other byte, including the counts M, N, P and the model.
3. Send 0xA1 with the 169 bytes; expect RTN 0x00 (0xE2 = refused, 0x06 = data invalid on V2 ASCII).
4. Read 0x47 again and compare the changed field (recommended; not shown in the captures).

V3 SPA:

1. Read the whole SPA block (0x1300, 106 registers; or the two halves).
2. Build a two register write: the target register r and its neighbour r + 1 (r − 1 when r is 0x1369 or when r + 1 is 0x135A), the neighbour carrying its freshly read value. Never include 0x135A unless it is the target: it moves while the pack works.
3. Send function 0x10 to the pack's address; the answer echoes start and count (`v3-rx-write-ack`, constructed). Exception 0x06: retry later; 0x02: wrong range.
4. Read the registers back.

V3 SFA:

1. Read 80 coils at 0x1400.
2. Write the whole byte that holds the bit (8 coils from the byte's first coil, function 0x0F, byte count 1, the other 7 bits as read).
3. Read back.

These procedures are derived from the firmware decompilation ([SO]) and the vendor documents; the vendor app's own write sequence for V3 is not published (**unverified**).

### 7.6 Recommended ubms schema

- Groups: canonical groups of `SETTING_GROUPS` (cell_voltage, pack_voltage, charging, current, temperature, balancing, capacity, system, wire_resistance, advanced) plus one driver group `seplos.functions` for the function switch bits (7.2, 7.4).
- Every canonical id of tables 7.1 and 7.3 is shown in its catalog group; driver specific ids carry the family prefix `seplos.` and their own English label (ids above).
- Writable: V2: every row of 7.1 and 7.2 except `model`, `seplos.fn_bluetooth` and the counts; `system.cell_count` and the enable bits of alarms, protections, lockouts and failure detections with `danger`. V3: rows marked "yes" or "danger" in 7.3, the SFA bits except 0x1418 bit 0 (Bluetooth module) and reserved bits; the enable bits of alarms, protections, lockouts and failure detections with `danger` (7.4).
- Read only: everything marked "no" or **unverified** above, device identity (section 10), 0x1368 and 0x1369.
- Temperature fields in °C with one decimal; voltage fields with three (cell) or two (pack) decimals; currents in A with the sign removed for discharge values.

### 7.7 Implementation in ubms (`packages/bms-drivers/src/seplos/`)

Settings census of the schemas (`settings.js`, checked in `seplos.test.js`):

| Definition | Fields | Writable | Read only | Actions |
| --- | --- | --- | --- | --- |
| `seplos-v2`, `seplos-v2-ble` | 151: 60 two byte and 27 one byte parameters (7.1), 64 function switch bits (7.2: 46 event enables, top-up charge, soft start, 8 bits of byte 7, 8 bits of byte 8) | 150 (45 switch bits with danger, `system.cell_count` with danger) | 1 (`seplos.fn_bluetooth`) | none |
| `seplos-v3` over Bluetooth, on the PC port (0xE0) or at a configured RS485 address | 180: 106 SPA registers, 70 SFA bits (reserved bits left out), `switch.charge`, `switch.discharge`, 2 actions | 170 (99 SPA, 69 SFA of which 44 with danger, 2 MOSFET switches with danger) | 8 (0x1328, 0x1329, 0x132A, 0x1360, 0x1362, 0x1368, 0x1369, `seplos.fn_bluetooth`) | `seplos.restart` (danger), `seplos.sync_clock` (advanced) |
| `seplos-v3` on RS485 at address 0 | 178 | 0 | 178 (reason: Modbus broadcast address, 11.3) | none |

Decisions taken while implementing (all follow from sections 4, 7 and 11):

- V2 parameter writes always read 0x47 first, change one field in the 169 bytes and send the whole block with 0xA1; the read back of the session checks the result. A block whose counts are not 60 / 27 / 8 or whose size is not 169 makes every V2 field read only. Discharge currents are written back negative.
- V2 BLE accepts any 0x47 answer whose counts add up to its length (2 + 2M + 1 + N + 1 + P + 10 model bytes), so a block with another layout reaches the read only schema instead of a timeout; a late 0x61 answer under the CID 0x47 (12) fails that check (its DATA starts with the pack address, and the bytes read as N and P are cell voltage bytes).
- Limits (7.1, 7.3): `system.cell_count` 8 to 16 on V2 and 1 to 16 on V3, `system.temp_sensor_count` 1 to 4, `seplos.comp1_cell` and `seplos.comp2_cell` 0 to 16, every current 0 to 1000 A (a plausibility bound, not a vendor limit).
- V2 BLE requests use ADR 0x00 and 0x61 DATA 0x00 on every pack, as the captured app does with BP00; whether a pack named BP01..BP15 expects its own ADR is not shown by any source (**unverified**).
- V2 BLE requests are written in GATT writes of 20 bytes, so the 179 byte 0xA1 request becomes nine writes with response. The official app writes it at once after an MTU exchange of 512; whether the module joins split writes is not captured (**unverified**, the write itself is vendor documented only, 7.1).
- The V2 BLE driver skips a 0x61 answer whose DATA has the parameter block layout (12, `v2b-rx-61-carrying-47`) and keeps waiting for the real answer.
- V3 over Bluetooth: telemetry (VIA, PIA, PIB, PIC, PCT, EIA, calendar) at address 0x00, settings reads and every write at 0xE0 (both are this pack on the Bluetooth port, [SO] `bus_commands.c`; syssi's captured SPA reads use 0xE0). On RS485: the configured address, else 0x00 then 0xE0 for the probe; at 0x00 nothing is written.
- V3 SPA writes are two register writes (7.5). The neighbour is r + 1, or r − 1 when r + 1 is past 0x1369, is 0x135A or a register this driver keeps read only (0x1328..0x132A, 0x1360, 0x1362, 0x1368, 0x1369); only 0x1361 has read only registers on both sides and is written with 0x1362 carrying its value as read. Exception 0x06 is retried once after a second.
- V3 SFA writes send the whole byte (8 coils, function 0x0F) with the other seven bits as just read.
- `switch.discharge` writes 0x1510 (0x55AA off, 0xAA55 cancel), `switch.charge` writes 0x1511 (0x55AA off, 0xAA55 cancel); "on" only cancels the off command and never forces a MOSFET on. 0x1515 is never sent: it sets command bit 7, whose effect is **unverified** (8.3). The cancel through 0x1511 = 0xAA55 is verified in firmware V1.43l only ([SO]); the vendor app uses 0x1515 ([MR] `sca.md`). The value shown is the FET state of PIC byte 15, polled for about a second after the command.
- `seplos.sync_clock` writes the calendar (0x1500, 4 registers, bytes of [XZH] table 4.21) with the time of the computer; exception 0x01 is reported as "history recording is off".
- The PIA current unit follows the VIA device name (`...16S200A...` 0.01 A, 300 A or more 0.1 A). A name without a rating (for example `B-48200-C`) or a lost VIA answer keeps 0.01 A, logs a warning and adds the device information value "Current unit: 0.01 A, assumed" (12). The cell count (0x1301), sensor count (0x1300) and rated capacity (0x1358) are read from SPA once after connecting.
- Reads refused with exception 0x03 are sent once more (firmware V1.43l answers a bad CRC with 0x03, 12); writes are not repeated.
- The bank summary EIA is read at the start and by readInfo at address 0. A timeout leaves the bank size unknown and EIA is asked again every 30 polls; an exception answer means no bank. In a bank (more than one pack) EIA is read on every poll.
- Cross-field checks (blocking, attached to both fields of each pair, because the settings view blocks Apply only for an error on the edited field): every recovery value against its protection or alarm value (below for high side limits, above for low side limits), including the V3 overcurrent recovery currents 0x1315 and 0x131B against the alarms; every alarm before its protection (cell and pack voltage, cell difference, the charge, discharge, ambient and MOSFET temperatures, charge and discharge overcurrent, low SOC); cell undervoltage below overvoltage protection; level 1 overcurrent protection below level 2 (charge on V3, discharge on both); cell undervoltage failure (V3) and charging prohibited voltage (V2) below the cell undervoltage protection; heating start below heating stop; balance stop difference below the start difference. Not compared: the short circuit current with the level 2 discharge protection, because the captured SG16S200A block holds 350 A for level 2 and 300 A for the short circuit (`v3-rx-spa1-sg`). Non-blocking warnings: pack overvoltage and undervoltage protection against the cell value times the cell count (more than one cell step apart), and a remaining capacity above the full charge capacity (V3; the firmware limits it, 7.3). Every captured block and the simulator defaults pass all checks.

## 8. Controls and actions

### 8.1 V2 ASCII

The protocol has a telecontrol command 0x45 ([V2PDF] table 4), and the vendor tool's definition file lists two control bytes with six flags: byte 0 bit 0 discharge control, bit 1 charge control, bit 2 current limit control, bit 3 temperature (heater) control, bit 4 system shutdown, bit 5 restore factory settings ([BSX] `teleControl_Group`, `teleCtrlByteNum = 2`). No source shows the INFO layout of a 0x45 request or a captured 0x45 frame (**unverified**). ubms offers no V2 ASCII control. The MOSFET states are shown read only from the 0x44 on-off state (table 9.3).

### 8.2 V2 BLE

| Command | Effect | Status | ubms |
| --- | --- | --- | --- |
| 0x63 | select the CAN protocol (table 9.6) | documented with request and answers ([BLEPDF] 4.6), not captured | read only enum from 0x51 in the first version |
| 0x64 | select the RS485 protocol (table 9.6) | documented ([BLEPDF] 4.7), not captured | read only enum |
| 0x65 | set group number and device number | documented ([BLEPDF] 4.8), not captured | not offered |
| 0xAA | MOSFET switches (syssi) | **unverified**: not in [BLEPDF], no capture, success byte guessed | not offered |

The MOSFET states are shown read only from the 0x61 switch state (table 9.3).

### 8.3 V3 system control (SCA, 0x1500..0x151D)

All commands are function 0x10 writes of one register to the pack's address ([XZH] SCA, [XZHEN] SCA, [SO] `Reg_WriteWords` case 0x1500). The values 0x55AA and 0xAA55 are fixed patterns, not numbers. Status: documented by the vendor (both editions) and implemented in the decompiled firmware; [MR] lists the same commands from the vendor app ("Discharing FETs Off" 0x1510 OnOff, "Discharing FETs On" 0x1510 OffOn, "Charing FETs Off" 0x1511, "Charing FETs On" 0x1515). No capture (**unverified** on the wire).

| Register | Value | Effect | Firmware detail ([SO]) | ubms |
| --- | --- | --- | --- | --- |
| 0x1500 | 4 words | set the calendar: year low byte, year high byte, month, day, hour, minute, second, reserved, words sent low byte first | refused with exception 0x01 unless the history switch (0x1430 bit 4) is on | action `seplos.sync_clock` (advanced) |
| 0x1504 | 13 words | history record timing (two dates and an interval) | | not offered |
| 0x150D | 0x55AA | zero current calibration | calibrates the shunt zero; exception 0x03 on failure | not offered |
| 0x150E | s16, 0.01 A | current calibration to the value written | exception 0x03 on failure | not offered (needs a reference current) |
| 0x150F | u16, 0.001 V | cell voltage calibration | exception 0x03 on failure | not offered |
| 0x1510 | 0x55AA / 0xAA55 | discharge MOSFET off / cancel off | sets / clears command bit 1 | `switch.discharge` (danger) |
| 0x1511 | 0x55AA / 0xAA55 | charge MOSFET off; 0xAA55 is not in the vendor documents | 0x55AA sets command bit 2 and clears bit 7; 0xAA55 clears bits 2 and 7 (cancel) | `switch.charge` off and on (danger); the cancel is verified in firmware V1.43l only |
| 0x1512 | 0x55AA | current limit MOSFET off | sets command bit 3 | not offered |
| 0x1514 | 0xAA55 | heater on | sets command bit 5 | not offered (no documented off) |
| 0x1515 | 0xAA55 | charge MOSFET on ([XZH], [MR] "Charing FETs On", 充电管开启, OffOn) | sets command bit 7, clears bit 2; 0x55AA clears both | not offered: what command bit 7 does beyond clearing the off bit (for example whether it overrides a charge forbidden by a protection, or acts as a manual charge activation) is **unverified**, the code that reads the command bits is not in the decompilation |
| 0x1516 | 0x55AA | clear running data | clears the log counters, writes the default battery record, reloads the capacity | not offered |
| 0x1517 | 0x55AA | system shutdown | the master forwards it to every slave of the bank | not offered (the pack cannot be woken over the link) |
| 0x1518 | 0x55AA | system reset (restart) | saves the battery record, resets 100 ms after the answer | action `seplos.restart` (danger) |
| 0x1519 | 0x55AA | "reserved" in [XZH] | erases a flash page (0x0803D000), saves the record and resets | never write |
| 0x151A | 0x55AA / 0xAA55 | not documented | all MOSFETs off for the whole bank / cancel | never write |
| 0x151B | 0x55AA | restore factory settings | `SysCfg_Reset` | not offered |
| 0x151C, 0x151D | | not documented | status and request flags | never write |

Encoding example (constructed): discharge off `00 10 15 10 00 01 02 55 AA 52 BE` (`v3-tx-dsg-off`), discharge on `00 10 15 10 00 01 02 AA 55 53 0E` (`v3-tx-dsg-on`), charge off `00 10 15 11 00 01 02 55 AA 53 6F` (`v3-tx-chg-off`), charge on `00 10 15 15 00 01 02 AA 55 53 5B` (`v3-tx-chg-on`). The answer echoes start and count (section 3.3).

Read back the switch states from PIC byte 15 (pack) or EIC byte 7 (bank): bit 0 discharge, bit 1 charge (table 9.9 FET state). A set MOSFET-off command stays active until it is cancelled. How the firmware combines the command bits with its protections is not in the decompilation (**unverified**); ubms therefore only sets and cancels the off commands (0x1510, 0x1511) and never sends 0x1515.

Only a pack that is alone or first in its bank accepts writes over Bluetooth ([SO] `BusCmd_WriteRegs`: other roles get exception 0x01); writes to another pack's address 2..20 through the master are refused ([SO]: function 0x10 only for addresses 0, 1, 0xE0).

## 9. Bits and enumerations

### 9.1 V2 byte alarm codes (0x44 and 0x61 cell, temperature, current and voltage alarm bytes)

| Value | Meaning | Sources |
| --- | --- | --- |
| 0x00 | normal | [V2PDF] table 12 |
| 0x01 | below the lower limit | [V2PDF] table 12 |
| 0x02 | above the upper limit | [V2PDF] table 12 |
| 0xF0 | other alarm | [V2PDF] table 12 |

The event bits (9.2) carry the same conditions with alarm and protection levels; ubms derives alarms from the event bits and uses the byte codes only to name the affected cell or sensor (`AlarmState.source`, e.g. "cell 5").

### 9.2 V2 alarm events (0x44 event 1..8, 0x61 and 0x62 events 1..8)

Bit = 1: active. Names from [BSX] `Ext_Bit` (byte index = event − 1, events 7 and 8 at byte index 12 and 13), [BLEPDF] table 15 and [SY] `ALARM_EVENTx_MESSAGES`; severities from [BSX] (`Warn` / `Protect`) and [AIO] `_PROBLEMS`.

| Event | Bit | Meaning | ubms alarm id | Severity |
| --- | --- | --- | --- | --- |
| 1 | 0 | voltage sensing failure | `voltage_sensor_fault` | fault |
| 1 | 1 | temperature sensing failure | `temperature_sensor_fault` | fault |
| 1 | 2 | current sensing failure | `current_sensor_fault` | fault |
| 1 | 3 | key (button) switch failure | `seplos.key_switch_fault` | fault |
| 1 | 4 | cell voltage difference failure | `cell_voltage_difference` | fault |
| 1 | 5 | charge switch failure | `charge_mos_fault` | fault |
| 1 | 6 | discharge switch failure | `discharge_mos_fault` | fault |
| 1 | 7 | current limit switch failure | `seplos.current_limit_switch_fault` | fault |
| 2 | 0 | cell high voltage alarm | `cell_overvoltage` | warning |
| 2 | 1 | cell overvoltage protection | `cell_overvoltage` | protection |
| 2 | 2 | cell low voltage alarm | `cell_undervoltage` | warning |
| 2 | 3 | cell undervoltage protection | `cell_undervoltage` | protection |
| 2 | 4 | pack high voltage alarm | `pack_overvoltage` | warning |
| 2 | 5 | pack overvoltage protection | `pack_overvoltage` | protection |
| 2 | 6 | pack low voltage alarm | `pack_undervoltage` | warning |
| 2 | 7 | pack undervoltage protection | `pack_undervoltage` | protection |
| 3 | 0 | charge high temperature alarm | `charge_overtemperature` | warning |
| 3 | 1 | charge overtemperature protection | `charge_overtemperature` | protection |
| 3 | 2 | charge low temperature alarm | `charge_undertemperature` | warning |
| 3 | 3 | charge undertemperature protection | `charge_undertemperature` | protection |
| 3 | 4 | discharge high temperature alarm | `discharge_overtemperature` | warning |
| 3 | 5 | discharge overtemperature protection | `discharge_overtemperature` | protection |
| 3 | 6 | discharge low temperature alarm | `discharge_undertemperature` | warning |
| 3 | 7 | discharge undertemperature protection | `discharge_undertemperature` | protection |
| 4 | 0 | ambient high temperature alarm | `ambient_overtemperature` | warning |
| 4 | 1 | ambient overtemperature protection | `ambient_overtemperature` | protection |
| 4 | 2 | ambient low temperature alarm | `ambient_undertemperature` | warning |
| 4 | 3 | ambient undertemperature protection | `ambient_undertemperature` | protection |
| 4 | 4 | power (MOSFET) overtemperature protection | `mos_overtemperature` | protection |
| 4 | 5 | power high temperature alarm | `mos_overtemperature` | warning |
| 4 | 6 | cell low temperature heating active | `seplos.heating` | info |
| 4 | 7 | secondary trip protection ([BSX], [BLEPDF]; the garbled table 13 of [V2PDF] may show a reserved bit, **unverified**) | `seplos.secondary_trip` | protection |
| 5 | 0 | charge overcurrent alarm | `charge_overcurrent` | warning |
| 5 | 1 | charge overcurrent protection | `charge_overcurrent` | protection |
| 5 | 2 | discharge overcurrent alarm | `discharge_overcurrent` | warning |
| 5 | 3 | discharge overcurrent protection | `discharge_overcurrent` | protection |
| 5 | 4 | transient overcurrent protection | `discharge_overcurrent` (label "Transient overcurrent") | protection |
| 5 | 5 | output short circuit protection | `short_circuit` | protection |
| 5 | 6 | transient overcurrent lockout | `seplos.transient_oc_lockout` | protection |
| 5 | 7 | output short circuit lockout | `seplos.short_circuit_lockout` | protection |
| 6 | 0 | charging high voltage protection | `seplos.charge_overvoltage` | protection |
| 6 | 1 | waiting for intermittent (top-up) charge | `seplos.top_up_waiting` | info |
| 6 | 2 | remaining capacity alarm | `soc_low` | warning |
| 6 | 3 | remaining capacity protection | `soc_low` | protection |
| 6 | 4 | cell low voltage, charging prohibited | `seplos.low_voltage_charge_forbidden` | protection |
| 6 | 5 | output reverse polarity protection | `seplos.reverse_polarity` | protection |
| 6 | 6 | output connection failure | `seplos.output_connection_fault` | fault |
| 6 | 7 | internal | ignore | |
| 7 | 0..3, 6, 7 | internal | ignore | |
| 7 | 4 | automatic charging waiting | `seplos.auto_charge_waiting` | info |
| 7 | 5 | manual charging waiting | `seplos.manual_charge_waiting` | info |
| 8 | 0 | EEPROM storage failure | `eeprom_fault` | fault |
| 8 | 1 | RTC clock failure | `rtc_fault` | fault |
| 8 | 2 | voltage calibration not done | `seplos.voltage_not_calibrated` | warning |
| 8 | 3 | current calibration not done | `seplos.current_not_calibrated` | warning |
| 8 | 4 | zero point calibration not done | `seplos.zero_not_calibrated` | warning |
| 8 | 5 | calendar not synchronised ([BSX], [SY]; not in [V2PDF]) | `seplos.calendar_not_synced` | info |
| 8 | 6, 7 | internal | ignore | |

[AIO] masks bit 7 of event 6 and bits 0..3, 6, 7 of events 7 and 8 the same way (`_PRB_MASK`).

### 9.3 V2 switch (on-off) state

| Bit | Meaning | Model | Sources |
| --- | --- | --- | --- |
| 0 | discharge switch on | `switches.discharge` | [V2PDF], [BSX] byte 6, [BLEPDF] table 14, [SY], [AIO] |
| 1 | charge switch on | `switches.charge` | same |
| 2 | current limit switch on | extra "Current limit" | same |
| 3 | heating switch on | `switches.heater` | same |
| 4..7 | reserved | | [V2PDF] |

### 9.4 V2 system state

| Bit | Meaning | Sources |
| --- | --- | --- |
| 0 | discharge | [V2PDF], [BLEPDF] table 13, [BSX] mode 0x01 |
| 1 | charge | same, mode 0x02 |
| 2 | floating charge | same, mode 0x04 |
| 3 | fully charged ([BSX] mode 0x08); reserved in [V2PDF] and [BLEPDF] | [BSX] |
| 4 | standby | same, mode 0x10 |
| 5 | shutdown | same, mode 0x20 |
| 6, 7 | reserved | [V2PDF] |

Captured values: 0x02 (charging, `v2b-rx-61-sp76`), 0x10 (standby, `v2a-rx-44-za11`).

### 9.5 V2 balancing and disconnection bytes

Balancing byte k bit b = cell 8k + b + 1 is being balanced; disconnection byte k bit b = sense wire of cell 8k + b + 1 open ([V2PDF] table 13, [BLEPDF] tables 16 and 17, [BSX] "Equalization1..16"). `v2b-rx-61-aio` has balancing bytes 00 02 = cell 10. Map balancing to `balancing[]` and disconnection to alarm `cell_wire_open` (fault) with the cell number as source.

### 9.6 V2 CAN and RS485 protocol codes (0x51 bytes 32 and 33, commands 0x63 and 0x64)

| Code | CAN protocol | RS485 protocol | Sources |
| --- | --- | --- | --- |
| 0x00 | none | none | [BLEPDF] tables 8 and 9, [SY] |
| 0x01 | Pylontech (PN_GDLT) | Pylontech (PN) | same |
| 0x02 | Growatt (GRWT) | Growatt (GRWT) | same |
| 0x03 | Victron (VCTR) | Voltronic (VLTC) | same |
| 0x04 | SMA / Sofar (SMA_SF) | Sofar (SF) | same |
| 0x05 | Ginlong (GINL) | Luxpower (LUXP) | same |
| 0x06 | Studer (STUD) | Studer (STUD) | [BLEPDF] (RS485 row 0x06 garbled), [SY] |

[BSX] `canProtocol` lists the same CAN names with type 1..6.

### 9.7 V2 battery type (0x51 byte 34)

| Code | Chemistry | Sources |
| --- | --- | --- |
| 0x46 | lithium iron phosphate (LFP) | [BLEPDF] table 10, [SY], [V2PDF] CID1 0x46 |
| 0x47 | ternary lithium (NCM) | [BLEPDF], [SY] |
| 0x48 | not named in [BLEPDF]; [SY] says LCO | [SY] (**unverified**) |
| 0x49 | lithium cobalt oxide (LCO) per [BLEPDF]; [SY] says LTO | conflict (**unverified**) |
| 0x4A | lithium titanate (LTO) per [BLEPDF]; [SY] says reserved | conflict (**unverified**) |

Use `system.battery_type` read only with these labels; show the raw code when it is not 0x46 or 0x47.

### 9.8 V3 inverter protocol (PCT 0x1800, SPA 0x1368)

| Value | Protocol name in the firmware | Bus | Sources |
| --- | --- | --- | --- |
| 0 | Pylon CAN Protocol | CAN 500 k | [SO] `docs/protocols.md`, `v3-rx-pct-sg` |
| 1 | Growatt CAN Protocol | CAN 500 k | [SO], [XZH] "Notes from Seplos" |
| 2 | Goodwe LV CAN Protocol | CAN | [SO] |
| 3 | SOFAR CAN Protocol | CAN | [SO] |
| 4 | SMA CAN Protocol | CAN | [SO] |
| 5 | Victron CAN Protocol | CAN | [SO], `v3-rx-pct-sp05b`, `v3-rx-spa2-aio` |
| 6 | Studer CAN Protocol | CAN | [SO] |
| 7 | CAN communication protocol (Ginlong / Solis) | CAN | [SO] |
| 8 | Voltronic 485 Protocol | RS485 9600 | [SO] |
| 9 | PACK BMS Modbus Protocol | RS485 9600 | [SO] |
| 10 | SPF Modbus RS485 RTU (Growatt) | RS485 9600 | [SO] |
| 11 | Pylon low voltage protocol | RS485 9600 | [SO] |
| 12 | RS485 Pylon low voltage protocol (Deye) | RS485 9600 | [SO] |
| 13 | XZH-Modbus (this document's V3 protocol on the inverter port) | RS485 19200 | [SO] |
| 14 | Modbus RTU (Hengrui) | RS485 9600 | [SO] |
| 15 | Modbus RTU (NPP) | RS485 9600 | [SO] |
| 16 | CAN protocol (MUST) | CAN 100 k | [SO] |
| 17 | Modbus RTU (YNG) | RS485 9600 | [SO] |
| 18 | Pylon low voltage protocol (M5000H) | RS485 9600 | [SO] |
| 19 | TBB CAN Protocol | CAN 500 k | [SO] |
| 20 | Afore CAN Protocol | CAN 500 k | [SO] |

Firmware V1.43l has 21 protocols, V1.5D has 25 ([SO] README); the numbers above are V1.43l. Prefer the protocol name string of PCT 0x1812 for display.

### 9.9 V3 state and event bytes (PIC bytes 8..17, EIC bytes 0..9)

Bit = 1: present (events) or on (FET state). Names from [XZH] tables 4.1 to 4.10, cross-checked with [XZHEN], [MR] `pic.md` and [AIO] `_PROBLEMS`.

| Byte (table) | Bit | Meaning | ubms | Severity |
| --- | --- | --- | --- | --- |
| system state (4.1) | 0 | discharging | state | |
| | 1 | charging | state | |
| | 2 | float charge | extra | |
| | 3 | fully charged | extra | |
| | 4 | standby | extra | |
| | 5 | shut down | extra | |
| voltage events (4.2) | 0..7 | as V2 event 2 bits 0..7 | `cell_overvoltage`, `cell_undervoltage`, `pack_overvoltage`, `pack_undervoltage` | warning / protection |
| cell temperature events (4.3) | 0..7 | as V2 event 3 bits 0..7 | `charge_overtemperature` ... `discharge_undertemperature` | warning / protection |
| ambient and power temperature events (4.4) | 0 | ambient high temperature alarm | `ambient_overtemperature` | warning |
| | 1 | ambient overtemperature protection | `ambient_overtemperature` | protection |
| | 2 | ambient low temperature alarm | `ambient_undertemperature` | warning |
| | 3 | ambient undertemperature protection | `ambient_undertemperature` | protection |
| | 4 | power high temperature **alarm** | `mos_overtemperature` | warning |
| | 5 | power overtemperature **protection** | `mos_overtemperature` | protection |
| | 6 | cell low temperature heating | `seplos.heating` | info |
| current events 1 (4.5) | 0 | charge overcurrent alarm | `charge_overcurrent` | warning |
| | 1 | charge overcurrent protection | `charge_overcurrent` | protection |
| | 2 | charge overcurrent protection, level 2 | `charge_overcurrent` (label "level 2") | protection |
| | 3 | discharge overcurrent alarm | `discharge_overcurrent` | warning |
| | 4 | discharge overcurrent protection | `discharge_overcurrent` | protection |
| | 5 | discharge overcurrent protection, level 2 | `discharge_overcurrent` (label "level 2") | protection |
| | 6 | output short circuit protection | `short_circuit` | protection |
| current events 2 (4.6) | 0 | output short circuit lockout | `seplos.short_circuit_lockout` | protection |
| | 1 | reverse connection protection | `seplos.reverse_polarity` | protection |
| | 2 | charge level 2 lockout | `seplos.charge_ocp2_lockout` | protection |
| | 3 | discharge level 2 lockout | `seplos.discharge_ocp2_lockout` | protection |
| remaining capacity events (4.7) | 2 | low SOC alarm | `soc_low` | warning |
| | 3 | low SOC protection | `soc_low` | protection |
| | 4 | cell voltage difference alarm | `cell_voltage_difference` | warning |
| | 6 | gyro lockout | `seplos.gyro_lockout` | protection |
| FET state (4.8) | 0 | discharge switch on | `switches.discharge` | |
| | 1 | charge switch on | `switches.charge` | |
| | 2 | current limit switch on | extra | |
| | 3 | heating on | `switches.heater` | |
| | 6 | undocumented, set in `v3-rx-eic-sg` (0x43) | ignore (**unverified**) | |
| balancing state events (4.9) | 0 | balancing module on | `balancingActive` | |
| | 1 | static balancing | extra | |
| | 2 | static balancing timeout | extra | |
| | 3 | balancing inhibited by over temperature | `seplos.balance_overtemp` | info |
| | 4 | cell failure alarm | `seplos.cell_failure` | warning |
| hardware failure events (4.10) | 0 | NTC failure | `temperature_sensor_fault` | fault |
| | 1 | AFE failure | `afe_fault` | fault |
| | 2 | charge MOSFET failure | `charge_mos_fault` | fault |
| | 3 | discharge MOSFET failure | `discharge_mos_fault` | fault |
| | 4 | cell failure | `seplos.cell_failure` | fault |
| | 5 | open wire (disconnection) failure | `cell_wire_open` | fault |
| | 6 | button failure | `seplos.key_switch_fault` | fault |
| | 7 | aerosol (fire suppression) alarm | `seplos.aerosol_alarm` | fault |

Bits not listed are reserved. Note that the power temperature bits 4 and 5 are in the opposite order from V2 event 4 (alarm first on V3, protection first on V2; [XZH] 4.4 vs [BSX] byte 3). PIC bytes 0..5 (per cell and per sensor low / high alarms) and 6..7 (balancing) name the affected cells: map balancing to `balancing[]` and use the alarm bytes as the source of the cell alarms.

### 9.10 V3 function switch bytes (SFA)

Bit = 1: enabled ([XZH] tables 4.11 to 4.20, [MR] `sfa.md`).

| Byte | Bits 0..7 |
| --- | --- |
| a 0x1400 voltage | cell high voltage alarm, cell OVP, cell low voltage alarm, cell UVP, pack high voltage alarm, pack OVP, pack low voltage alarm, pack UVP |
| b 0x1408 cell temperature | charge high temperature alarm, charge OTP, charge low temperature alarm, charge UTP, discharge high temperature alarm, discharge OTP, discharge low temperature alarm, discharge UTP |
| c 0x1410 ambient and power | ambient high temperature alarm, ambient OTP, ambient low temperature alarm, ambient UTP, power high temperature alarm, power OTP, cell low temperature heating, cell voltage failure |
| d 0x1418 functions | Bluetooth module, cooling fan, capacity LEDs always on, SNMP module, Wi-Fi module, DHCP, gyro module, reserved |
| e 0x1420 current 1 | charge OC alarm, charge OCP, charge OCP level 2, discharge OC alarm, discharge OCP, discharge OCP level 2, short circuit protection, reserved |
| f 0x1428 current 2 | short circuit lockout, reverse connection protection, charge level 2 lockout, discharge level 2 lockout, reserved (bit 5 kept by the firmware on multi-coil writes), reserved, reserved, reserved |
| g 0x1430 capacity and other | low SOC alarm, intermittent top-up charge, external switch control, standby sleep, history recording, low SOC protection, active current limiting, passive current limiting |
| h 0x1438 balancing | balancing function (`balance.enabled`), static balancing, static balancing timeout, balancing temperature limit, reserved x4 |
| i 0x1440 indication | buzzer and indicator lights (`switch.buzzer`), LCD display, manual forced output, automatic forced output, under-voltage recovery function, aerosol test, aerosol disconnect mode, current sensor temperature compensation |
| j 0x1448 failure detection | NTC failure, AFE failure, charge MOSFET failure, discharge MOSFET failure, cell failure, open wire, button, aerosol alarm |

## 10. Device information

| Item | V2 ASCII | V2 BLE | V3 | Model field |
| --- | --- | --- | --- | --- |
| vendor | "Seplos" (constant) | "Seplos" | VIA manufacturer name, "XZH-ElecTech Co.,Ltd" | `vendor` |
| model | 0x51 device name (`1101-SP15`) | 0x51 part model (`1101-SP76`) | VIA device name (`SG16S200A-SP57B-A`) | `model` |
| software version | 0x51 bytes 10..11 as "major.minor" (`16.4`) | 0x51 DATA 30..31 (`16.4`) | VIA 0x1714, two ASCII digits, shown as "1.5" by [DSB] | `softwareVersion` |
| serial number | none | none | VIA BMS QR code (`SP57B-A2506120022`); pack QR code as extra | `serialNumber` |
| protocol | VER of any answer ("2.0") | "V2 Bluetooth" | "Modbus RTU (XZH)" | `protocol` |
| extra | manufacturer field (CAN protocol text) | CAN protocol, RS485 protocol, battery type, slaves | inverter protocol and name (PCT), cell and sensor counts (SPA 0x1300, 0x1301) | `extra` |

Trim trailing spaces and NULs from every string ([SY] `find_last_not_of(' ')`, [DSB] `rstrip("\x00")`). The 0x47 model field (`1101-SP76 `, `EMU110110E`) repeats the model on V2 ([IC], [BLEPDF] example).

## 11. Detection

### 11.1 BLE scan

| Definition | Profile | Name patterns | Sources |
| --- | --- | --- | --- |
| `seplos-v2-ble` | FF00 / FF01 notify / FF02 write | `/^BP\d{2}$/` (BP00..BP15) | [BLEPDF] 1.3.2, [AIO], [SYP2] |
| `seplos-v3` | FFF0 / FFF1 notify / FFF2 write | `/^SP\d{2}B/`, `/^SP1\d{2}B/`, `/^XZH/`, `/^CSY/` | [SO] `Bluetooth_NameCmd` (`XZH_B40_...` or the BMS code), [SYP3] names, [AIO] patterns |

Chooser name prefixes in ubms (Web Bluetooth filters accept prefixes only): `BP0`, `BP1` for `seplos-v2-ble`; `SP0` .. `SP9`, `XZH`, `CSY` for `seplos-v3`. The prefixes only widen the chooser; the patterns above rank the candidates.

[AIO] also matches `ST*` for V3; that prefix is too generic for a name filter (**unverified** which devices use it), so ubms should not list it as a prefix. No manufacturer data is documented for either module. Both profiles collide with Daly and JBD (FFF0 and FF00), so service lists cannot decide; the name ranking and the probe do. The chooser prefixes `SP0` .. `SP9` also list JBD packs named by their model code (`SP04S034L4S200A`, [jbd.md](jbd.md) section 11.1); the JBD pattern `/^(SP|DP|AP|UP)\d{2}S\d{3}/` and the Seplos patterns do not overlap (S or B after the two digits), so such a name ranks JBD first (tested in `seplos.test.js`).

### 11.2 Probes (read only)

A probe may only send read requests: V2 ASCII 0x51 and 0x42 (or 0x4F), V2 BLE 0x51 and 0x61, V3 function 0x04 and 0x01. It must never send 0xA1, 0x45, 0x63, 0x64, 0x65, 0xAA, function 0x10 or 0x0F.

`seplos-v2` (serial, address a from the options, default 0):

1. Send 0x51 to a: `~20` + a + `4651` + `0000` + CHKSUM + CR. Accept an answer only if: framing and CHKSUM, LCHKSUM and LENID check (3.1); VER = 0x20; ADR = a; CID1 = 0x46; RTN = 0x00; LENID = 64 and bytes 0..9 and 12..31 are printable ASCII. Confidence 0.6; `info.model` from bytes 0..9.
2. Send 0x42 with INFO = a. Accept if RTN = 0x00 and the INFO parses as 6.1.1 with 1 ≤ M ≤ 24, 1 ≤ N ≤ 8 (6 on every capture), P = 10, LENID = 2 × (3 + 2M + 1 + 2N + 7 + 2P) and plausible values (every cell 1.0..5.0 V or 0, SOC ≤ 100.0 %). Confidence 0.95.
3. Reject other batteries with the same framing: any VER other than 0x20 (Boqiang uses 0x26, [SY] README; Pace shares the framing with its own VER and layouts, [BM] docstring, VER value **unverified**), and Pylontech (VER 0x20 but P = 2 or 4 in 0x42, [PY]). Boqiang packs that speak the Seplos layout with VER 0x26 ([SY] README "requires custom settings") could be accepted by an option, not by default (**unverified** layout).

`seplos-v2-ble`:

1. Enable notifications, write the 0x51 request `7E 10 00 46 51 00 00 3A 7F 0D`. Accept a reassembled answer with valid EOI and CRC-16/XMODEM, byte 3 = 0x51, RTN = 0x00, LENGTH = 36. Confidence 0.8.
2. Write 0x61 with DATA 0x00. Accept LENGTH and layout of 6.2.2 (M ≤ 24, P = 8, plausible values). Confidence 0.95.
3. Daly modules answer only their own frames (A5 ..., or Modbus with address 0xD2 or 0x81, see [daly.md](daly.md) section 1); a Daly module never produces a 7E ... 0D frame with a valid CRC-16/XMODEM.

`seplos-v3` (Bluetooth: address 0x00; serial: address from the options, default 0x00, then 0xE0 for the PC port):

1. Read VIA: `00 04 17 00 00 0A` + CRC (10 registers, the manufacturer name; [DSB] `test_connection`, `v3-tx-via-10`). Accept a Modbus answer with valid CRC, the same address, function 0x04 and byte count 20. "XZH-ElecTech" in the string: confidence 0.95.
2. Otherwise (other OEM strings) read PIA (18 registers) and accept plausible values (pack voltage 5..70 V, average cell voltage 1.5..4.5 V, SOC and SOH ≤ 100.0 %): confidence 0.7.
3. An exception answer (function 0x84) proves a Modbus responder at that address, not a Seplos; continue with the next candidate.
4. Daly Modbus modules use the addresses 0xD2 or 0x80 + board (0x81) and do not answer address 0x00; a Daly classic module ignores Modbus frames ([daly.md](daly.md) section 1). A JBD BMS answers only frames that start with 0xDD ([jbd.md](jbd.md) section 11.4). JK and ANT use other services or their own frames.

Implementation (`driver.js`): `seplos-v2` returns nothing when 0x51 is not answered or fails a check, 0.6 when 0x42 then times out, nothing when 0x42 is answered with another layout (Pylontech) or an error code, 0.95 otherwise. `seplos-v2-ble` returns 0.8 after a valid 0x51 and 0.95 when 0x61 also passes; a 0x61 answer with the parameter block layout is skipped (12). `seplos-v3` reads VIA at each candidate address, then PIA when the manufacturer is not XZH. The probe timeout of the session is split over the requests (at least 300 ms each on RS485, 500 ms over Bluetooth). Tests (`seplos.test.js`) check that each probe sends only the reads above, that Boqiang (VER 0x26) and Pylontech (P = 4) look-alikes, the other Seplos generation and the Daly and JBD simulators on the shared Bluetooth profiles are rejected, that the Daly and JBD probes reject the Seplos simulators (and that the JBD probe frames reach neither Seplos simulator as a request), and that no frame of the other families' test vectors (Daly, Daly balancer, JK, JK balancer, ANT, Atorch, JBD, NEEY) passes a Seplos frame assembler.

### 11.3 Cross protocol safety on a shared RS485 bus

- A V3 board takes the first byte of a frame as the address and only proceeds for its own address ([SO] `Rtu_SlaveReceive`); the V2 probe starts with 0x7E 0x32 and is ignored. A V2 board waits for `~`; the Modbus probe is ignored ([SY] `parse_seplos_modbus_byte_`).
- Address 0x00 is the Modbus broadcast address for standard devices: they do not answer reads to it but may execute writes. The Seplos master answers reads to 0x00 ([SY] example comment "The Seplos V3 firmware answers reads sent to the broadcast address"). ubms must never send a write to address 0x00 on a wired bus; use the pack's own address (or 0xE0 on the PC port) for writes.

### 11.4 Registration order

- Register the Seplos definitions after the Daly definitions: both Seplos BLE profiles share their service UUIDs with Daly profiles, Daly devices have their own names and manufacturer ids, and a renamed device gets the Daly probes first. Seplos names (BPxx, SPxxB..., XZH...) rank above every other family by name anyway.
- JBD shares both profiles as well (FF00 default, FFF0 on the JBD-DH04SC02, [jbd.md](jbd.md) section 2.1) and is registered before Daly (the order recommended in `packages/bms-drivers/src/jbd/index.js`: `jbd` before the Daly drivers, `jbd-up-rs485` after them). With the Seplos definitions after `jbd-up-rs485`, the order is `[...jk, ...ant, jbd, ...daly, jbd-up-rs485, ...seplos, ...atorch]`. A renamed Seplos device then costs the JBD probe first (two unanswered `DD A5 03 00 FF FD 77` reads and, on FF00 only, one app key frame `FF AA 15 ...`, [jbd.md](jbd.md) section 11.2; about 3.75 s on FF00 and 2.5 s on FFF0 per the same comment) and the Daly probes; neither can match, because both Seplos generations answer only their own frames (the Seplos V2 BLE parser waits for 0x7E, the V3 Modbus server for its address; whether the V2 Bluetooth module itself reacts to the FF AA frame is **unverified**, no capture). On serial the JBD probe (`DD ...`, address 0xDD for a V3 board) and the JBD UP probe (function 0x78, dropped by the V3 firmware, 3.3) are ignored by both generations.
- Keep Atorch last as now (comment in `packages/bms-drivers/src/index.js`): the Seplos profiles do not use FFE0, so they do not delay the Atorch listen window.
- Within the family: `seplos-v3`, `seplos-v2-ble`, `seplos-v2`. Serial trial order: `seplos-v3` 19200, `seplos-v2` 19200, `seplos-v2` 9600. The probes are read only and ignored by the other generation.

## 12. Pitfalls and quirks

- **Answer with the wrong CID (V2 BLE).** When a new request is sent before the previous answer arrived, the BMS may answer the old request with the new CID byte: [SYP2] records 358..374 carry the 169 byte parameter block under CID 0x61 (`v2b-rx-61-carrying-47`). Send one request at a time and check LENGTH against the request (0x47 → the length its own counts give, 169 for the standard layout; 0x51 → 36; 0x61 → 6.2.2 layout).
- **Corrupted notifications (V2 BLE).** One 0x61 answer in [SYP2] contains three stray bytes (`0C 30 C0`) inside the alarm area; the byte at 9 + LENGTH is 0x0F instead of 0x0D and the CRC fails (`v2b-rx-61-corrupted`). Drop it and resynchronise on the next 0x7E.
- **VER of V2 BLE answers.** Captured answers carry 0x14, the vendor examples 0x10 ([SYP2], [BLEPDF]); [AIO] drops every answer whose VER is not 0x14. Accept any VER.
- **Two scales in V2 BLE.** 0x61 reports current in 0.01 A and capacities in 0.01 Ah; 0x62 in 0.1 A and 0.1 Ah ([BLEPDF] tables 12 and 19).
- **syssi's V2 settings offsets.** syssi decodes INFO 129..136 as function switches; they are one byte parameters (section 7.2). aiobmsble reads the charge and discharge overcurrent delays from the same bytes ([AIO] `_LIMIT_FIELDS` 136, 137), which matches [BLEPDF].
- **Temperature offset.** 2731 per the vendor documents; syssi BLE and the V3 SPA decoder use 273.15 for settings, aiobmsble 273.1; differences of 0.05 °C only.
- **V3 PIA current unit** depends on the board rating: 0.01 A up to 200 A, 0.1 A on 300 A and 400 A boards ([XZH] V0.2). Seplos told the translator that 400 A boards are not in use yet ([XZH] "Notes from Seplos"). Take the rating from the VIA device name (`...16S200A...`) and treat other names as **unverified**: a name such as `B-48200-C` (1.1) carries no rating in that form, so ubms assumes 0.01 A, logs a warning and shows the assumption in the device information instead of guessing from other name patterns; a 300 A board with such a name would show current and power 10 times too small.
- **EIA units differ from PIA.** EIA current is 0.1 A in a 32-bit value sent low word first; EIB temperatures are 0.1 °C, not 0.1 K ([XZH]).
- **PCT 0x1800 byte order.** Firmware V1.43l sends the inverter protocol word low byte first (05 00 = 5) ([SO] findings; `v3-rx-pct-sp05b`), while Seplos writes it high byte first (`00 10 18 00 00 01 02 00 01 F2 01`).
- **Wrong block lengths in syssi.** syssi multiplies coil block lengths by 16 (PIC 0x0900, SFA 0x0500) and reads EIB with 26 registers; the firmware answers exception 0x02 ([SYP3], `v3-tx-pic-wrong`, `v3-tx-sfa-wrong`, `v3-rx-eib-exception`). Use 144 / 80 coils and 22 registers.
- **Single register writes are not saved** by firmware V1.43l (SPA and SFA); write at least two registers or coils (section 7.5).
- **Reserved command registers are destructive.** 0x1519 erases a flash page and resets; 0x151A switches off the whole bank ([SO]). Never write registers that the vendor documents as reserved.
- **JK Modbus answers at address 1.** The JK test vectors contain Modbus write echoes from address 0x01 (`01 10 16 1E ...`). A Modbus assembler that syncs on address 1 takes them for frames; the V3 driver therefore listens only to 0x00, 0xE0 and a configured address, and never reads at address 1 (found while implementing).
- **CHKSUM example of the V2.0 document** does not add up as printed (3.1).
- **Slave packs hide their Bluetooth module** (V3): only the single or first pack advertises and serves Bluetooth requests ([SO] `Bluetooth_Hide`, `BusCmd_*`).
- **Bad CRC answered with exception 0x03** by firmware V1.43l instead of silence ([SO] `Rtu_SlaveRequestCheck`). A request corrupted on a noisy line therefore looks like a refused value; ubms sends a read refused with 0x03 once more (7.7). The ubms simulator answers a bad CRC the same way.
- **Logs with 0x5C.** The SP05B logs of [SYP3] replaced the bytes 0x0A and 0x0D by 0x5C; frames copied from them need repair before their CRC checks (five vectors marked `repaired`).
- **"MODBUS-ASCII" is a misnomer.** Seplos calls the V2 protocol "MODBUS-ASCII", but it is the YD/T 1363.3 ASCII frame, not Modbus ASCII (`:` frames) ([BP] notes; [V2EN] title vs content).
- **aiobmsble V2 model offset.** [AIO] takes the model from frame bytes 26..35 and reports "B1101-SP76" (last byte of the manufacturer field included); the model is at frame bytes 27..36 ([BLEPDF] table 7, [SY]).
- **0x4F and 0xA1 answers are identical bytes** (`~200046000000FDB4`); match answers to the outstanding request.
- **Reserved words in 0x42** carry data on some firmware (ZA11: FFFB FFFD 0067 000B); ignore them.
- **Unsupported request lengths.** [AIO] reads PIA with 17 registers, [XZH] and the firmware's pack table use 18; both work. aiobmsble and syssi read SPA at different addresses (0x00 and 0xE0); both are answered over Bluetooth.
- **EIB position pairs** may be swapped between the document and the firmware (section 6.3.7).
- **Bank reads over RS485.** A slave pack is reached at its own DIP address on the pack link; the master's address 0x00 also answers EIA / EIB / EIC with the bank summary ([XZH] EIA "served by the master pack at ID 0x00").

## 13. References

| Tag | Source | Version used |
| --- | --- | --- |
| [V2PDF] | Shenzhen Seplos Technology, "Battery Management System (BMS) for Communication, MODBUS-ASCII Communication Protocol", V2.0, 2019-10-15, EMU10XX / EMU11XX, file `docs/SEPLOS BMS Communication Protocol_V2.0.pdf` in https://github.com/syssi/esphome-seplos-bms | commit d467742222199a12dea9a75796040443288dd40d |
| [V2EN] | Seplos, "MODBUS-ASCII Communication Protocol", EMU10XX, file `docs/Seplos 48v 100A BMS RS485 Protocol.pdf` (same repository) | same commit |
| [MAN100] | Seplos, "48V 100A Battery Management System Specifications", 2020-05-28, `docs/Seplos 48v 100A BMS 20200528.pdf` (same repository) | same commit |
| [MAN200] | Seplos, "48V 200A 8S-16S BMS" manual, `docs/Seplos 48v 200A 8S-16S BMS.pdf` (same repository) | same commit |
| [BLEPDF] | Seplos Bluetooth communication protocol V2.0 (2022-09-08, machine translated), `docs/Seplos.bluetooth.protocol.2.pdf` (same repository) | same commit |
| [XZH] | "XZH BMS Modbus RTU Protocol V0.3 (unofficial English translation)" of the Chinese edition (revised 2024-10-15), with notes from Seplos (October 2026), `docs/XZH BMS Modbus-RTU Protocol V0.3.md` (same repository) | same commit |
| [XZHEN] | Seplos, "XZH BMS Modbus-RTU Protocol V0.3 (English, official)", 2024-11-28, `docs/XZH BMS Modbus-RTU Protocol V0.3 (English, official).pdf` (same repository) | same commit |
| [S30] | Seplos, "SEPLOS-3.0 RS485 BMS Modbus RTU Protocol" V0.1, 2023-02-09, `assets/SEPLOS-3.0RS485BMS.Modbus.RTU.Protocol.1._20230822104940 .pdf` in https://github.com/flip555/bms_connector | commit ba3e6c7b3f41a16e69d3bc946e63fbe14c36cf0c |
| [BSX] | vendor PC tool protocol definition `protocol/16S_V20_ADDR_EN.xml` (and `16S_V20_ADDR.xml`), published in https://github.com/ichernev/seplos-bms-tool | commit 23d9adec82530d074cc8a42ecc5e058628bcb0b9 |
| [IC] | https://github.com/ichernev/seplos-bms-tool `notes.md` (decoded captures of the vendor PC tool on a 1101-ZA11: `ucbpcap_status.pcapng`, `ucbpcap_params_x2.pcapng`), `seplos.py` | same commit |
| [SY] | https://github.com/syssi/esphome-seplos-bms: `components/seplos_modbus`, `seplos_bms`, `seplos_bms_ble` (and `switch/`), `seplos_bms_v3_ble`, `seplos_bms_v3_ble_pack`, `tests/`, `README.md`, `esp32-seplos-v3-example.yaml` | commit d467742222199a12dea9a75796040443288dd40d |
| [SYP2] | same repository, `docs/pdus/v2/btsnoop_hci_1101-10E-SP76-16S.log` (official app, pack BP00, one slave) | same commit |
| [SYP3] | same repository, `docs/pdus/v3/SG16S200A-SP57B-A-all-frames.txt`, `SP05B2312190075-all-frames.txt`, `-coil-frames.txt`, `-pia-frames.txt`, `-pib-frames.txt`, `-via-frames.txt`, `-error-responses.txt` | same commit |
| [AIO] | https://github.com/patman15/aiobmsble `aiobmsble/bms/seplos_v2_bms.py`, `aiobmsble/bms/seplos_bms.py`, `tests/bms/test_seplos_v2_bms.py`, `tests/bms/test_seplos_bms.py` | commit 5de275a9f1035ebefc82d8ec1eab6ffb06d30045 |
| [SO] | https://github.com/abedegno/SeplOSS (decompiled Seplos BMS 3.0 firmware V1.43l, 48100 and 48200): `v1.43l/src/comms/*.c`, `v1.43l/docs/findings.md`, `v1.43l/docs/protocols.md`, `README.md` | commit c50c68f21ddb138ed9ab26dadd8241e7904c206a |
| [MR] | https://github.com/marcelrv/seplosBMSv3 `README.md`, `pia.md`, `pib.md`, `pic.md`, `spa.md`, `sfa.md`, `sca.md` (tables from the vendor app BMS Studio) | commit 0e81046f6ccda6733b9b3f006d955516041f5fa9 |
| [DSB] | https://github.com/mr-manuel/venus-os_dbus-serialbattery `dbus-serialbattery/bms/seplos.py`, `seplosv3.py` | commit 99833373ffcf442e61800805393c1118db093bdf |
| [BM] | https://github.com/fl4p/batmon-ha `bmslib/models/seplos_uart.py` | commit 86ea0cbfa913bf39df9c2c830e06a3382a8e2324 |
| [FL] | https://github.com/flip555/bms_connector `custom_components/bms_connector/bms/seplos/v2/*.py`, `assets/misc/SEPLOS_V2_47H_DECODER.py`, `SEPLOS_V2_51H_DECODER.py` | commit ba3e6c7b3f41a16e69d3bc946e63fbe14c36cf0c |
| [BP] | https://github.com/BrucePerens/seplos_c `library/seplos.h`, notes | commit a5108bea640df5442e849fd01184cc68969c76eb |
| [PC] | https://github.com/Privatecoder/seplos-mqtt-rs485 `README.md`, `src/fetch_bms_data.py` | commit 3a105dfd299c86ec4ff8ddbfec1ec0bf8d91b87e |
| [PY] | https://github.com/Frankkkkk/python-pylontech `pylontech/pylontech.py` | commit 5d91f6d7fe3a42853eacbf9d79fd03a70055ccc4 |
