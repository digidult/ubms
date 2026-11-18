# Daly BMS protocol specification (DALY_CLASSIC and DALY_MODBUS)

Implementation reference for the ubms Daly driver (Web Bluetooth, Web Serial, later Rust/Tauri).
Vendor: Dongguan Daly Electronics Co., Ltd. ("DALY BMS", "Daly Smart BMS"). Vendor apps: "SMART BMS" / "DALY BMS" for
Android and iOS (`com.inuker.bluetooth.daliy` in older references), Windows tools "BMS Monitor" / "DalyBmsMonitor".

Status of this document: compiled from open source implementations, two vendor register lists for the Modbus variant
(xlsx, English translations shipped in syssi/esphome-daly-bms), a third-party transcription of the vendor CAN protocol
v1.0 (same data IDs as the UART protocol), forum captures and an HCI snoop of the official app (see section 13).
Every table row names its sources. Items marked **unverified** come from a single source without a capture, or are
inferred from captured values. Where sources disagree, the disagreement is stated next to the item and collected in
section 12.1.

Test vectors: `packages/bms-drivers/test/vectors/daly.json` (252 frames; every checksum and CRC validated, one frame with
a deliberately wrong CRC is marked `crcValid: false`).

Conventions:

* Byte offsets in classic tables are given twice: **data offset** (0 = first of the 8 data bytes) and **frame offset**
  (0 = the `A5` start byte; frame offset = data offset + 4). Modbus tables use register addresses; a register is
  `u16be`, and register `r` of a read response starting at `start` sits at frame offset `3 + 2 * (r - start)`.
* `u16be` = unsigned 16 bit big endian, `u32be` = unsigned 32 bit big endian, `u8` = one byte. "raw" is the integer read
  from the frame, "value = raw x scale".
* "+40" means `value = raw - 40` (temperature offset). "30000 offset" means `value = (raw - 30000) x 0.1 A`.
* Level 1 / level 2: Daly has two alarm levels for most limits. Level 1 is the warning (pre-alarm), level 2 is the
  protection level that switches the MOSFETs (dbus-serialbattery `read_alarm_data`, patagonaa `has_warnings` /
  `has_errors`, syssi "Warning" / "Critical").

---

## 1. Overview

### 1.1 Protocol variants

| Variant id (vectors) | Common names | Frame shape | Integrity | Byte order | Used by |
|---|---|---|---|---|---|
| `DALY_CLASSIC` | "UART/485 protocol V1.2", "A5 protocol" | 13 bytes fixed: `A5 <addr> <cmd> 08 <8 data> <sum>` | 8 bit sum of bytes 0..11 | big endian | all older Daly Smart BMS lines (vendor J/T/A/U/W/ND series, for example R16T, R24TK, R32 boards), their Bluetooth dongles, and the UART port of at least some newer H/K/M/S boards |
| `DALY_MODBUS`, address `D2` | "Modbus protocol", "new protocol", syssi "D2" | Modbus RTU style, device address `0xD2` in requests and responses | CRC-16/MODBUS | big endian registers | H/K/M/S series through the Daly Bluetooth module (the module sends these frames on the BMS UART), Daly active balancers |
| `DALY_MODBUS`, address `0x80 + board` | syssi "p81", patagonaa "H/K/M/S Modbus" | Modbus RTU style, request address `0x80 + board` (`0x81` for board 1), response address `0x50 + board` (`0x51`) | CRC-16/MODBUS | big endian registers | H/K/M/S series on RS485, ESS and "DL BMS" packs with built-in BLE (for example ESS-DL-BMS, DALY BMS F16S48V200A) |

Sources: syssi/esphome-daly-bms README ("H/K/M/S series (start of frame 0xD2)", "J/T/A/U/W/ND series (start of frame 0xA5)",
"F16S48V200A ... protocol_version 0x81"); patagonaa/esphome-daly-hkms-bms `daly_hkms_bms.cpp`
(`DALY_MODBUS_REQUEST_ADDRESS_OFFSET = 0x80`, `DALY_MODBUS_RESPONSE_ADDRESS_OFFSET = 0x50`); forum page 3 (a poster
notes that requests starting with `D2` belong to the Modbus protocol and requests starting with `A5` to the RS485
protocol); acpiccolo/Daly-BMS
(classic frames captured from a `DL_HKMS_3.1.L` board on the serial link).

The two Modbus address flavours use **different register maps** (section 6.3 and 6.4). The D2 map reserves 32 cell
slots and puts settings at `0x0080`; the 0x81 map reserves 48 cell slots and puts settings at `0x0100` and above.

Out of scope: the Daly CAN protocol (250 kbit/s, same data IDs `0x90..0x98` packed into CAN IDs `0x18<id><dst><src>`,
see jblance powermon `daly_can` notes) and "Daly" boards built on a Sinowealth chip that speak the BMStool protocol
(`0A <reg> <len>`, python-daly-bms `daly_sinowealth.py`).

### 1.2 Model families seen in sources

| Name / model string | Link | Variant | Source |
|---|---|---|---|
| DALY R24TK, 4S LiFePO4 | UART (CH340, 9600 8N1) | CLASSIC | batmon-ha issue #429 |
| R16T, R16A, R16T-FK03 | RS485, UART | CLASSIC | diysolarforum thread 21898 page 2 and 3 |
| Hardware `DL-BMS-R32-01E`, software `20210222-1.01T`, 14S Li-ion | UART | CLASSIC | forum thread 21898 post 1 |
| `DL_HKMS_3.1.L` (8S), software `12_250520_BRST`, hardware `H2.1_103E_30XF` | serial | CLASSIC | acpiccolo/Daly-BMS `protocol.rs` tests |
| `DL-D6C14E1000D1` (generic BLE module with template characteristics) | BLE | CLASSIC only | batmon-ha issue #416 |
| Daly Smart BMS K series 100A, `DL-40D63C3223A2`, `DL-F28BBED000824` | BLE | MODBUS D2 | syssi README |
| "blue series", 16S (80 status registers) | BLE | MODBUS D2 | syssi issue #55 capture |
| 24S pack | BLE | MODBUS D2 | syssi issue #60 capture |
| Daly active balancer, software `B002_111132_03`, hardware `E303-032DG-SMB`, BLE module HLK-B40 | BLE | MODBUS D2 | syssi `docs/pdus/btsnoop_daly_balancer.log` |
| 100A 15S K, 100A 8–24S "100 Balance", 100A 8S K, 300A 8S K, 500A 24S | RS485, UART | MODBUS 0x81 | patagonaa README |
| ESS-DL-BMS, software `41_260321_0323`, product `ESS41_0323` | BLE | MODBUS 0x81 | syssi `docs/pdus/ess-dl-bms-41_260321_0323.txt` |
| `DL_HKMS_3.2.E`, `12_260120_K00T` / `H2.1_103E_30XF` | BLE | MODBUS 0x81 | aiobmsble `tests/bms/test_daly_bms.py` |

### 1.3 Telling them apart at runtime

* By the first byte of a reply: `A5` = classic, `D2` = Modbus D2, `0x51..0x5F` with function `0x03` = Modbus 0x81 map.
* Names and GATT layouts do **not** identify the protocol: `DL-` modules exist for all three variants (batmon-ha
  `daly2.py` notes that J/T/A/U/W series modules expose the same `fff0` layout but answer only classic frames).
* A safe probe sequence (all reads) is given in section 11.

---

## 2. Physical links

### 2.1 BLE

#### 2.1.1 Advertisement

| Item | Value | Source |
|---|---|---|
| Local name | `DL-` + 12 hex digits (the module MAC, for example `DL-401710015C9B`); `DL-F` + 12 hex digits on Bouffalo Lab modules (`DL-FB4C2E0000000`); `JHB-` + 12 hex digits (`JHB-D2190701C66E`); user defined names are possible (`BT270-2`, `MyName`, `DL-home`) and may carry trailing NUL bytes | syssi README; aiobmsble `test_data/daly_bms.json`; batmon-ha issue #356 |
| Service UUID in advertisement | `0000fff0-0000-1000-8000-00805f9b34fb` is advertised by some modules only | aiobmsble `test_data/daly_bms.json` (one of ten devices) |
| Manufacturer data | the first two payload bytes are reported as the "company id" (not a registered vendor id): `0x0102`, `0x0104`, `0x0107`, `0x0302`, `0x0303`, `0x0402` seen; the payload contains the 6 byte module MAC and then ASCII `DL` (`44 4C`) or `JHB` (`4A 48 42`) | aiobmsble `matcher_dict_list()` and `test_data/daly_bms.json` |

Observed manufacturer data (company id as decoded by the host stack, then the remaining payload):

| Name | Company id | Remaining payload | Interpretation |
|---|---|---|---|
| `DL-401710015C9B` | `0x0302` | `16 40 17 10 01 5C 9B 44 4C` | `16`, MAC `40:17:10:01:5C:9B`, `DL` |
| `BT270-2` (renamed) | `0x0302` | `16 40 17 12 01 11 97 44 4C` | `16`, MAC, `DL` |
| `MyName` (renamed, MAC `40:18:07:00:00:00`) | `0x0302` | `16 40 18 07 00 00 00 44 4C` | `16`, MAC, `DL` |
| `JHB-50181201A494` (shown as `Randomname`) | `0x0104` | `01 50 18 12 01 A4 94 4A 48 42` | `01`, MAC, `JHB` |
| `JHB-D2190701C66E` | `0x0402` | `27 D2 19 07 01 C6 6E 4A 48 42` | `27`, MAC, `JHB` |
| `DL-home` (MAC `D2:1A:08:00:00:00`) | `0x0107` | `04 D2 1A 08 00 00 00 44 4C` | `04`, MAC, `DL` |
| `DL-FB4C2E0000000` | `0x0303` | `00 B4 C2 E0 00 00 00 44 4C 00` | `00`, MAC, `DL`, `00` |
| `DL-40160901534C` | `0x0102` | `04` | short form |
| `DL-46640102XXXX` | `0x6446` | `01 02 09 AC` | the six bytes `46 64 01 02 09 AC` are the id in the name (masked in the source) |

The meaning of the first payload byte (`16`, `01`, `27`, `04`, `00`) is **unverified**. Web Bluetooth hides MAC
addresses; the MAC part of the name or of the manufacturer data is a usable stable device id.

#### 2.1.2 GATT layouts

Four layouts are documented. In all of them the BMS data channel is a write characteristic (host to BMS) and a notify
characteristic (BMS to host) that carry the raw UART bytes in both directions.

| Layout | Service | Notify (BMS to host) | Write (host to BMS) | Other characteristics | Source |
|---|---|---|---|---|---|
| A: HiLink HLK-B40 module (Modbus D2 devices, active balancer) | `0000fff0-...` | `fff1` (read, notify; value handle `0x0010`, CCCD `0x0011`) | `fff2` (read, write without response, write; value handle `0x0014`) | `fff3` (read, write, write without response; AT commands to the module, the module answers on `fff1`); service `02f00000-0000-0000-0000-00000000fe00` with `...ff00` (read), `...ff01` (write), `...ff02` (read, notify), `...ff03` (read), `...ff04` (read, write, notify; AT commands), `...ff05` (read, write) | own decode of syssi `docs/pdus/btsnoop_daly_balancer.log` (ATT discovery records 3..44) |
| B: TI CC254x based classic dongle | `0000fff0-...` (handle `0x000E`) | `fff1` (characteristic `0x0011`) | `fff2` (characteristic `0x000F`) | Device Information `180a`; TI OAD service `f000ffc0-0451-4000-b000-000000000000` | GATT listing in forum thread 21898 page 2 (Marv085); python-daly-bms `daly_bms_bluetooth.py` uses BlueZ handles 17 (notify) and 15 (write) |
| C: newer firmware reported by batmon-ha | `0000ff00-...` | `ff01` (read, notify) | `ff02` (read, write without response, write) | the same device also has `fff0` with `fff1`, `fff2`, `fff3`, `fffa`, `fffb` | batmon-ha issue #356, `daly.py` and `daly2.py` `CHARACTERISTIC_UUIDS`; data flow over `ff01`/`ff02` **unverified** |
| D: generic module with template values | `0000fff0-...` | `fff1` (read, notify, handle 16) | `fff2` (read, write without response, write, handle 20) | `fff3` (handle 23); characteristic values `char1_ntf_data`, `CHAR2_VALUE`, `CHAR3_VALUE` | batmon-ha issue #416 snoop |

UUIDs: `fff1` = `0000fff1-0000-1000-8000-00805f9b34fb` and so on. For Web Bluetooth list `0000fff0-...`,
`0000ff00-...` and `02f00000-0000-0000-0000-00000000fe00` in `optionalServices`.

Rules derived from the sources:

* Subscribe to `fff1` and write requests to `fff2`. Fall back to `ff01`/`ff02` when `fff0` is missing or the
  subscription to `fff1` fails (batmon-ha falls back after a BlueZ `NotPermitted` error on `fff1`).
* Use **write without response** when the characteristic supports it: the official app (snoop: every request is an ATT
  Write Command, opcode `0x52`), syssi (`ESP_GATT_WRITE_TYPE_NO_RSP`) and batmon-ha `daly2.py` (`response=False`) do so.
  aiobmsble alternates both write modes on retries.
* Do not write anything else. python-daly-bms writes an empty value to BlueZ handle 48; in the layout B listing,
  characteristic `0x0030` is the TI OAD characteristic `f000ffc2-...` (own inference from the two sources). batmon-ha
  writes an empty value to `...ff01`. Neither write is needed by any other implementation. On layout D a write to the Device Name characteristic `2a00` changed the advertised name (batmon-ha
  issue #416: the name afterwards read back as the written frame).
* Non-frame text can arrive on `fff1`: on layout A the module answers AT commands written to `fff3` there (`9600`,
  `AT+PRODUCTINFO=NoPID` in the snoop). The frame assembler must skip such bytes.

#### 2.1.3 MTU and fragmentation

* The HLK-B40 module requests an ATT MTU of 512 itself (snoop record 1: peripheral sends Exchange MTU Request `0x0200`).
  With that MTU every Modbus reply arrives in one notification (largest seen: 165 bytes for 80 registers; 153 bytes for
  the 0x81 version block).
* One notification can contain **several frames**: the snoop shows a 70 byte notification with two Modbus replies and a
  91 byte notification with three (records 209 and 212, the app had pipelined several requests). python-daly-bms and
  batmon-ha handle classic notifications of 26 bytes (two frames).
* aiobmsble and syssi assume exactly one complete frame per notification; with a smaller MTU (Web Bluetooth on some
  platforms) frames may be split. Implement stream reassembly (section 3.3) and never assume notification boundaries
  are frame boundaries.

#### 2.1.4 Sleep, cloud mode

* The Bluetooth module sleeps after one hour without load or charging; the serial port keeps answering, and a command
  on the serial port wakes the module again (python-daly-bms README, Bluetooth notes).
* Enabling WiFi/cloud mode on combined WiFi/BT modules disables Bluetooth until the device is deleted from the cloud
  account in the app (syssi README, "Known issues").

### 2.2 UART / RS485

| Item | Value | Source |
|---|---|---|
| Serial format | 9600 baud, 8 data bits, no parity, 1 stop bit | maland16 `Init()`, python-daly-bms `connect()`, esphome `FINAL_VALIDATE_SCHEMA`, acpiccolo `serialport.rs`, vendor xlsx ("9600 8bits, 1 stop bit, no parity") |
| Other baud rates | one RS485 Modbus (0x81) user runs 115200 | Sundaya python-daly-16S `main.py` `BAUDRATE`; **unverified** whether this is a setting of that pack |
| Levels | UART is 3.3 V TTL; UART ground is the battery negative (B-), not the load side; RS485 is isolated on the K series | matthewgream README; patagonaa README "BMS connection" |
| Connector | JST-GH compatible (1.25 mm) | patagonaa README |
| Wake input | the "S1"/button pin is an active low wake input; holding it low keeps the interface awake | matthewgream README "Hardware"; softwarecrash Daly2MQTT `wakeupHandler()` pulses a wake pin |

Addressing (classic):

| Request byte 1 | Meaning | Source |
|---|---|---|
| `0x40` | upper computer (PC); RS485 board 1 | V1.2 address table as encoded in matthewgream `VALUE_ADDRESS_UPPER_COMPUTER`, CAN v1.0 notes, maland16, dbus-serialbattery |
| `0x40 + (board - 1)` = `0x3F + board` | RS485 board number 1..16 (`0x41` = board 2) | forum page 2 (KaFun board 2 frames), batmon-ha `daly_board_addr_byte()`, dbus-serialbattery `generate_command()` comment, esphome issue #12445 |
| `0x80` | Bluetooth APP | matthewgream `VALUE_ADDRESS_BLUETOOTH_APP`, CAN v1.0 notes, python-daly-bms, esphome default `address: 0x80`, mpp-solar `daly` |
| `0x20` | GPRS module | matthewgream `VALUE_ADDRESS_GPRS`, CAN v1.0 notes |

Reply byte 1 is the board number (`0x01` for board 1, `0x02` for board 2), not the request address (esphome issue
#12445 capture, forum page 2, dbus-serialbattery check `63 + id == address`). esphome accepts only `0x01` and therefore
cannot read board 2 (issue #12445).

Addressing (Modbus 0x81 map on RS485): request address `0x80 + board`, response address `0x50 + board`; board 1 =
`0x81`/`0x51`, board 2 = `0x82`/`0x52` (patagonaa, Sundaya `address.py` `BMS_UNITS`). The board number is set in the PC
software (patagonaa README: Administrator, password `12345678`, Manufacturing, Board number). The D2 address is fixed.

Link notes:

* **Shared UART.** The Daly Bluetooth/WiFi dongle sits on the same UART. Its own requests (`A5 80 ..`, `A5 40 ..`,
  `D2 03 ..`) and the BMS answers to them appear on the line (acpiccolo `is_reply_for`, forum page 3 UART monitor of the
  Bluetooth module sending `D2 03 00 80 00 29 96 5F`). Accept a reply only if its address byte and command match the
  outstanding request.
* **Sleep.** By default the BMS sleeps after one hour without current. RS485 traffic does not wake it; UART traffic
  (also from the Bluetooth dongle), charge or discharge current and the switch input do (patagonaa README, "BMS
  connection"). The timeout is a setting (section 7.7).
* **Payload fill.** The 8 data bytes of a classic read request are don't care. dbus-serialbattery and batmon-ha fill
  them with `0xAA` on wired links: the firmware UART resynchronises on signal edges, an all-zero payload offers none,
  and zero-filled requests went unanswered much more often (batmon-ha `daly_uart.py` `UART_FILL`, dbus-serialbattery
  `command_base` comment). The R24TK in batmon-ha issue #429 copies
  request byte 8 into reply byte 8 (the DI/DO byte of `0x94`); see section 12.2.
* **Turnaround.** Wait for the complete reply before sending the next request (half duplex RS485).

### 2.3 Which link carries which variant

| Link | CLASSIC | MODBUS D2 | MODBUS 0x81 |
|---|---|---|---|
| BLE (Daly dongle or built-in module) | yes (older dongles, J/T/A/U/W/ND series) | yes (H/K/M/S series dongle, active balancer) | yes (ESS/DL packs, F16S48V200A) |
| UART (BMS "UART"/"LED" port) | yes | yes (frames sent by the Bluetooth dongle on this port, forum page 3) | not documented |
| RS485 | yes (board addressed) | not documented | yes (H/K/M/S series) |

---

## 3. Frame formats

### 3.1 DALY_CLASSIC frame

| Frame offset | Length | Field | Value |
|---|---|---|---|
| 0 (0x00) | 1 | start flag | `0xA5` |
| 1 (0x01) | 1 | address | request: host address (section 2.2); reply: board number (`0x01`..) |
| 2 (0x02) | 1 | data id (command) | section 5.1 |
| 3 (0x03) | 1 | data length | always `0x08` |
| 4 (0x04) | 8 | data | requests: parameters or don't care; replies: section 6 |
| 12 (0x0C) | 1 | checksum | `(sum of bytes 0..11) & 0xFF` |

Sources: maland16 `sendCommand()` / `validateChecksum()`, python-daly-bms `_calc_crc()`, esphome `request_data_()` /
`decode_data_()`, acpiccolo `calc_crc()`, mpp-solar `crc8` (a plain sum despite the name).

Example: `A5 40 90 08 00 00 00 00 00 00 00 00 7D` (0xA5 + 0x40 + 0x90 + 0x08 = 0x17D, low byte 0x7D).

Multi-frame replies (`0x95`, `0x96`, `0x57`, `0x62`, `0x63`) are a sequence of complete 13 byte frames with the same
command; data byte 0 is the frame number starting at 1 (all captures; the CAN v1.0 notes say 0 based and `0xFF` =
invalid, which no UART capture shows).

Reply bytes that a command does not define are **not zero**: they keep bytes of earlier replies (forum post 1: `0x91`
ends with `01 F4`, the SOC field of the previous `0x90`; `0x5F` ends with `0E 74` from the previous `0x50`; write
acknowledgements carry an old `0x90` payload; mpp-solar frames end with `40` or `F9`). Never use undefined bytes.

### 3.2 DALY_MODBUS frames

Read holding registers (function `0x03`):

| Offset | Request | Response |
|---|---|---|
| 0 | address (`0xD2`, or `0x80 + board`) | address (`0xD2`, or `0x50 + board`) |
| 1 | `0x03` | `0x03` |
| 2..3 | start register `u16be` | byte 2: byte count `N = 2 x registers` |
| 4..5 | register count `u16be` | bytes 3..(3+N-1): register values, `u16be` each |
| 6..7 | CRC low, CRC high | last 2 bytes: CRC low, CRC high |

Write single register (function `0x06`): `addr 06 reg_hi reg_lo val_hi val_lo crc_lo crc_hi`; the response repeats the
request (vendor xlsx, write register section; snoop record 232). For the 0x81 map
the response carries the response address (`0x51`), as all 0x81 map responses do.

Write multiple registers (function `0x10`), **non-standard**: there is no byte count byte. Request:
`addr 10 start_hi start_lo count_hi count_lo <2 x count data bytes> crc_lo crc_hi`. Response:
`addr 10 start_hi start_lo count_hi count_lo crc_lo crc_hi`. Evidence: vendor xlsx example
`D2 10 00 0C 00 02 00 01 00 02 7D 65` (valid CRC without a byte count), official app snoop
`D2 10 00 D4 00 03 18 0B 07 09 34 1C F7 D8` (3 registers, 6 data bytes, valid CRC). A standard Modbus library inserts
a byte count and produces frames the BMS does not expect (patagonaa README: the component has to patch the
ESPHome Modbus component because Daly deviates from Modbus).

Exception response: `addr (func | 0x80) code crc_lo crc_hi` (5 bytes) is handled by batmon-ha `daly2.py`; no capture
shows one (**unverified** that Daly sends them).

CRC: CRC-16/MODBUS (reflected polynomial `0xA001`, initial value `0xFFFF`, no final xor) over all bytes before the
CRC, transmitted low byte first. Check value of `D2 03 00 00 00 3E` is `0xB9D7`, sent as `D7 B9`. Sources: vendor xlsx
(examples verified), syssi `build_frame_()`, aiobmsble `crc_modbus()`, batmon-ha `daly2.py`, Sundaya
`crc16_modbus()`.

Replies do not contain the start register. Match each reply to its request by order (one request in flight, or a FIFO
of outstanding requests) and check that the byte count equals `2 x requested count`.

### 3.3 Reassembly

One assembler instance per link, fed with every received chunk:

1. Append the chunk to a buffer.
2. Classic: drop bytes until `buf[0] == 0xA5`. If fewer than 13 bytes, wait. If `buf[3] != 0x08` or the checksum of
   `buf[0..12]` fails, drop one byte and resync (do not drop 13: batmon-ha `feed_buffer()` drops the whole frame; the
   one byte rule also survives a stray `A5` inside data). Otherwise emit `buf[0..12]` and remove it.
3. Modbus: drop bytes until `buf[0]` is the expected response address (`0xD2`, or `0x50 + board`). With fewer than 3
   bytes wait. Length by function: `0x03` -> `5 + buf[2]`; `0x06` and `0x10` -> 8; `buf[1] & 0x80` -> 5; any other
   function: drop one byte. If the length is not yet available, wait. If the CRC fails, drop one byte and resync
   (batmon-ha `daly2.py` `_notification_handler`). Otherwise emit the frame.
4. For `0x03` replies also check `buf[2]` against the outstanding request before trusting a length (batmon-ha keeps
   `_read_bytecount` so that the tail of a cut-off reply cannot be taken for a new reply header).
5. Discard the buffer after a quiet time (esphome resets a partial frame after 200 ms).

Text, foreign frames and echoes (for example an `A5 40 ..` request echoed by a half duplex adapter) must be skipped:
classic replies have byte 1 in `0x01..0x10`; requests have `0x20`, `0x40..0x4F` or `0x80` there (batmon-ha
`daly_reply_valid()`, acpiccolo `is_reply_for()`).

Sundaya python-daly-16S skips the CRC check when a `0x03` reply has an odd byte count ("Daly quirk"); no capture in the
vector file shows such a frame (**unverified**).

---

## 4. Session flow

### 4.1 Classic over UART / RS485

1. Open the port at 9600 8N1. Optionally assert the wake input.
2. Send `0x94` first: it gives the cell count and the temperature sensor count needed for `0x95` and `0x96`
   (python-daly-bms `connect()` calls `get_status()`; esphome derives the frame counts from `0x94`).
3. Live poll: `0x90`, `0x91`, `0x92`, `0x93`, `0x94`, `0x95`, `0x96`, `0x97`, `0x98` (maland16 `update()`; esphome uses
   `0x90..0x96`; dbus-serialbattery uses `0x90, 0x93, 0x91, 0x98, 0x92, 0x97, 0x95` plus `0x94` at start).
4. Static data once per session: `0x50`, `0x51`, `0x52`, `0x53`, `0x54`, `0x57`, `0x59..0x60`, `0x61`, `0x62`, `0x63`
   (forum post 1 "Read All" order: `50 5F 52 60 51 53 54 57 61 62 63 59 5A 5B 5E 5D 5C`). The PC software also sends
   `0xD8` at the end of every live poll (forum post 1; meaning **unverified**).
5. One request at a time. Wait for all frames of a multi-frame reply, then a quiet gap.

Timing used by implementations (none documented by Daly):

| Implementation | Gap before a request | Reply timeout | Retries |
|---|---|---|---|
| esphome `daly_bms` | next request 50 ms after the line is quiet | 250 ms | none (next request) |
| dbus-serialbattery `daly.py` | 20 ms (comment: without it many requests get no reply) | 0.5 s per 13 byte frame | 3 for some commands |
| batmon-ha `daly_uart.py` | 20 ms (`REQUEST_SETTLE`) | 12 s (`TIMEOUT` inherited from `DalyBt`) | on timeout |
| softwarecrash Daly2MQTT | 150 ms between requests (comment: faster polling causes connection errors) | stream timeout | 20 ms retry delay |
| acpiccolo Daly-BMS | at least 4 ms (`MINIMUM_DELAY`) | 500 ms example | configurable |
| python-daly-bms | none | 0.5 s | 3, 0.2 s apart |

Recommended: 20–50 ms gap after the last received byte, 500 ms timeout per frame, 3 retries, one outstanding request.

Multi-board RS485: poll each board with its own address (`0x40 + board - 1`); route replies by reply byte 1
(batmon-ha `DalyUart._wrap_notify()`; the dispatcher described by Kicosta in esphome issue #12445).

### 4.2 Classic over BLE

1. Connect, discover services, start notifications on `fff1` (or `ff01`).
2. Requests use host address `0x80` (python-daly-bms BLE, esphome default, mpp-solar). Some modules only answer `0x40`
   (batmon-ha issue #416): batmon-ha sends `0x90` with the preferred address, then `0x94` with the other one and keeps
   the address that is answered; it repeats the first request because some modules drop the first request after
   connecting (`DalyBt._handshake()`, `HANDSHAKE_STEP = 2` s).
3. Same command sequence as 4.1. With host address `0x80` the BMS sends all 16 frames of `0x95` (frames without cells
   are zero) and up to 3 frames of `0x96` (python-daly-bms `_calc_num_responses()`: over Bluetooth the BMS also sends the
   frames without data; mpp-solar test response with 16 frames for a 16S pack).
4. Timeouts: python-daly-bms 5 s per request, batmon-ha 12 s.

### 4.3 Modbus D2 over BLE

1. Connect, subscribe to `fff1`, write to `fff2` without response.
2. Live poll: read `0x0000` with 62 registers (`D2 03 00 00 00 3E D7 B9`, all implementations) or 80 registers
   (`D2 03 00 00 00 50 56 55`, syssi `status_registers: 80`, adds balance current and MOSFET temperature on newer
   firmware). aiobmsble reads `0x003E` with 9 registers for the MOSFET temperature before the 62 register read and stops
   doing so when it times out or returns `0x0000`/`0xFFFF`.
3. Settings: read `0x0080` with 41 registers (`D2 03 00 80 00 29 96 5F`).
4. Device info: read `0x00A9` with 32 registers (`D2 03 00 A9 00 20 87 91`) and the password `0x00C9` with 3
   (`D2 03 00 C9 00 03 C6 56`).
5. Balancer switch (balancer devices): read `0x00CF` with 1.
6. One request at a time with a timeout (syssi: 3 s default, queue of 16; batmon-ha `daly2.py`: 8 s; aiobmsble: about
   0.7 s, doubled per retry, 3 attempts). batmon-ha retries the first request once after connecting.
7. Poll interval: syssi default 10 s; batmon-ha typical 1 s sample period.

What the official app sends after connecting (snoop of a Daly active balancer, records 47..82): enable all four CCCDs
(`fff1`, `fff2`, `ff02`, `ff04`); write ASCII `HiLink` to `...ff05`; write the phone clock with
`D2 10 00 D4 00 03 YY MM DD hh mm ss` (no byte count); query the module with `AT+VER=?` (`ff04`), `AT+BAND=?` and
`AT+PRODUCTINFO=?` (`fff3`); send a classic probe `A5 40 02 08 00..00 EF`; send a 0x81 probe
`81 10 0F 05 00 02 00 00 00 00 87 6A` (the balancer answered `51 10 0F 05 AA AA 21 93`); then read settings, status,
version, password, `0x0063` (28), `0x00CC` (2), `0x003E` (9), `0x0057` (12), `0x00DF` (17), `0x00D7` (1). None of the
open source implementations needs these steps; their purpose is **unverified**.

### 4.4 Modbus 0x81 map (BLE and RS485)

1. Request address `0x81` (board 1), responses from `0x51`.
2. Live poll: realtime block 1 `0x0000` with 64 registers (`81 03 00 00 00 40 5B FA`), realtime block 2 `0x0041` with 62
   registers (`81 03 00 41 00 3E 8B CE`) (syssi, aiobmsble). To include register `0x0040` (minimum cell voltage) read
   65 registers in block 1 (`81 03 00 00 00 41 9A 3A`; ril3y/daly_bms `kPart1Count = 0x41`, "the app does the same").
3. Device info: `0x0178` with 74 registers (`81 03 01 78 00 4A 5A 18`).
4. Settings blocks read by syssi: `0x0100` (81), `0x0151` (39), `0x01C3` (80), `0x0220` (11), `0x024B` (2), and
   `0x00A4` (10), `0x00CF` (1).
5. RS485 polling: patagonaa reads cell voltages, `0x0030..0x0047`, `0x0048..0x005C`, `0x006D..0x0073` and
   `0x0121..0x0122` every 30 s (default), optionally voltage and current (`0x0038..0x0039`) more often. Sundaya waits
   60 ms after sending and 80 ms between reads, and ends a reply after a 60 ms quiet gap.

### 4.5 Authentication and passwords

* No protocol variant needs a login for reads.
* D2: registers `0x00C9..0x00CB` hold the "parameter setting password" as 6 ASCII bytes (default `123456` in every
  capture). The official app only reads it and compares the user input locally; MOSFET writes work without writing it
  (batmon-ha `daly2.py` comment on the HCI snoop). syssi has a `password` option (default `12345678`) that is stored but
  never sent.
* 0x81 map: the same 6 ASCII bytes `123456` were observed at `0x0126..0x0128` (ESS capture; **unverified** meaning).
* Classic: no password in the protocol. A forum post summarised by smefa/DalyBMS-to-MQTT
  (`docs/daly-write-commands.md`, "Engineering unlock") says some firmware ignores extended commands until
  `0xE0`, `0xE1`, `0xE2` with data `A5 5A 00 00 00 00 00 00` and `0xE3` with the date and time are sent; the same
  document reads `0x59`/`0x5A` without it. A firmware disassembly lists valid command ranges `0x00..0x0F`,
  `0x10..0x27`, `0x50..0x6A`, `0x90..0x99`, `0xD0..0xDD` (forum page 3, gnif), which does not include `0xE0..0xE3`.
  **Unverified**; do not send.
* The PC software administrator password `12345678` (patagonaa README) is a user interface gate, not a protocol item.

---

## 5. Commands (exact bytes)

### 5.1 DALY_CLASSIC command list

| Cmd | Purpose | Request data | Reply frames | Status | Sources |
|---|---|---|---|---|---|
| `0x90` | pack voltage, current, SOC | none | 1 | V1.2 | all implementations |
| `0x91` | highest and lowest cell voltage | none | 1 | V1.2 | all |
| `0x92` | highest and lowest temperature | none | 1 | V1.2 | all |
| `0x93` | charge/discharge state, MOSFETs, remaining capacity | none | 1 | V1.2 | all |
| `0x94` | status information 1 (counts, charger, load, DI/DO, cycles) | none | 1 | V1.2 | all |
| `0x95` | cell voltages, 3 per frame | none | `ceil(cells / 3)` with host `0x40`; 16 with host `0x80` | V1.2 | all |
| `0x96` | temperatures, 7 per frame | none | `ceil(sensors / 7)`, one extra frame seen | V1.2 | all |
| `0x97` | cell balancing bits | none | 1 | V1.2 | maland16, matthewgream, python-daly-bms, dbus-serialbattery |
| `0x98` | failure status bits | none | 1 | V1.2 | maland16, matthewgream, python-daly-bms, dbus-serialbattery |
| `0x50` | rated capacity, nominal cell voltage | none | 1 | captured | forum post 1, dbus-serialbattery, acpiccolo, matthewgream |
| `0x51` | acquisition boards, cells and NTCs per board | none | 1 | captured | forum post 1, acpiccolo, matthewgream |
| `0x52` | cumulative charge and discharge | none | 1 | captured | forum post 1, acpiccolo, matthewgream |
| `0x53` | operation mode, battery type, production date, sleep time, current wave | none | 1 | captured | forum post 1, smefa, dbus-serialbattery, acpiccolo, matthewgream |
| `0x54` | firmware index number (8 ASCII) | none | 1 | captured | forum post 1, matthewgream |
| `0x57` | battery code (35 ASCII) | none | 5 | captured | forum post 1, dbus-serialbattery, acpiccolo, matthewgream |
| `0x59` | cell voltage thresholds | none | 1 | captured | forum post 1, matthewgream, Daly2MQTT, smefa |
| `0x5A` | pack voltage thresholds | none | 1 | captured | forum post 1, matthewgream, Daly2MQTT, smefa |
| `0x5B` | current thresholds | none | 1 | captured | forum post 1, matthewgream |
| `0x5C` | temperature thresholds | none | 1 | captured | forum post 1, matthewgream |
| `0x5D` | SOC thresholds | none | 1 | captured | forum post 1, matthewgream |
| `0x5E` | cell voltage and temperature difference thresholds | none | 1 | captured | forum post 1, matthewgream |
| `0x5F` | balancing thresholds | none | 1 | captured | forum post 1, matthewgream, smefa |
| `0x60` | short circuit current, current sampling resistance | none | 1 | captured | forum post 1, matthewgream |
| `0x61` | real time clock | none | 1 | captured | forum post 1, acpiccolo, matthewgream |
| `0x62` | software version (14 ASCII) | none | 2 | captured | forum post 1, acpiccolo, matthewgream |
| `0x63` | hardware version (14 ASCII) | none | 2 | captured | forum post 1, acpiccolo, matthewgream |
| `0x10`..`0x14`, `0x17`, `0x19`..`0x20` | write the group read by `cmd + 0x40` | same layout as the read reply | 1 (acknowledgement) | captured (PC software "Set All") | forum post 1, smefa |
| `0x21` | set SOC (and RTC) | `YY MM DD hh mm ss`, SOC x 10 `u16be` | 1 | implemented by several projects | dbus-serialbattery, batmon-ha, python-daly-bms, Daly2MQTT |
| `0xD9` | discharge MOSFET on/off | data 0 = `01` on, `00` off | 1 | captured | forum page 2, maland16, python-daly-bms, dbus-serialbattery, smefa |
| `0xDA` | charge MOSFET on/off | data 0 = `01` on, `00` off | 1 | captured | same |
| `0x00` | BMS reset | none | **unverified** | implemented | maland16 `setBmsReset()`, python-daly-bms `restart()`, matthewgream |
| `0xD8` | sent by the PC software after every poll; reply all zero | none | 1 | captured, meaning **unverified** | forum post 1; "equilibrium config" per a forum post quoted by smefa |
| `0x02` | sent once by the official app over BLE | none | none logged | **unverified** | snoop record 66 |
| `0x64` | sent with data 0 = `01` about every 3.3 s while the PC settings screen is open, never answered | | none | **unverified** | smefa `docs/daly-write-commands.md` |
| `0x67`, `0x68`, `0x69`, `0x99`, `0xE0`..`0xE3` | "alt FW version", "extended status", "equilibrium status", "engineering unlock" | | | **unverified**, single forum post | smefa `docs/daly-write-commands.md` |

### 5.2 DALY_CLASSIC read requests

All with zero payload. Column `0x41` = RS485 board 2 (for board `n` use address `0x3F + n` and add `n - 1` to the
checksum). Frames in the `0x40` column are identical to the captures in forum post 1 and to the checksums listed in
maland16 `example-output.txt`; the `0x80` frame for `0x95` is the example in python-daly-bms `_format_message()`.

| Cmd | Host `0x40` (PC, RS485 board 1) | Host `0x80` (Bluetooth APP) | Host `0x41` (RS485 board 2) |
|---|---|---|---|
| 0x90 | `A5 40 90 08 00 00 00 00 00 00 00 00 7D` | `A5 80 90 08 00 00 00 00 00 00 00 00 BD` | `A5 41 90 08 00 00 00 00 00 00 00 00 7E` |
| 0x91 | `A5 40 91 08 00 00 00 00 00 00 00 00 7E` | `A5 80 91 08 00 00 00 00 00 00 00 00 BE` | `A5 41 91 08 00 00 00 00 00 00 00 00 7F` |
| 0x92 | `A5 40 92 08 00 00 00 00 00 00 00 00 7F` | `A5 80 92 08 00 00 00 00 00 00 00 00 BF` | `A5 41 92 08 00 00 00 00 00 00 00 00 80` |
| 0x93 | `A5 40 93 08 00 00 00 00 00 00 00 00 80` | `A5 80 93 08 00 00 00 00 00 00 00 00 C0` | `A5 41 93 08 00 00 00 00 00 00 00 00 81` |
| 0x94 | `A5 40 94 08 00 00 00 00 00 00 00 00 81` | `A5 80 94 08 00 00 00 00 00 00 00 00 C1` | `A5 41 94 08 00 00 00 00 00 00 00 00 82` |
| 0x95 | `A5 40 95 08 00 00 00 00 00 00 00 00 82` | `A5 80 95 08 00 00 00 00 00 00 00 00 C2` | `A5 41 95 08 00 00 00 00 00 00 00 00 83` |
| 0x96 | `A5 40 96 08 00 00 00 00 00 00 00 00 83` | `A5 80 96 08 00 00 00 00 00 00 00 00 C3` | `A5 41 96 08 00 00 00 00 00 00 00 00 84` |
| 0x97 | `A5 40 97 08 00 00 00 00 00 00 00 00 84` | `A5 80 97 08 00 00 00 00 00 00 00 00 C4` | `A5 41 97 08 00 00 00 00 00 00 00 00 85` |
| 0x98 | `A5 40 98 08 00 00 00 00 00 00 00 00 85` | `A5 80 98 08 00 00 00 00 00 00 00 00 C5` | `A5 41 98 08 00 00 00 00 00 00 00 00 86` |
| 0x50 | `A5 40 50 08 00 00 00 00 00 00 00 00 3D` | `A5 80 50 08 00 00 00 00 00 00 00 00 7D` | `A5 41 50 08 00 00 00 00 00 00 00 00 3E` |
| 0x51 | `A5 40 51 08 00 00 00 00 00 00 00 00 3E` | `A5 80 51 08 00 00 00 00 00 00 00 00 7E` | `A5 41 51 08 00 00 00 00 00 00 00 00 3F` |
| 0x52 | `A5 40 52 08 00 00 00 00 00 00 00 00 3F` | `A5 80 52 08 00 00 00 00 00 00 00 00 7F` | `A5 41 52 08 00 00 00 00 00 00 00 00 40` |
| 0x53 | `A5 40 53 08 00 00 00 00 00 00 00 00 40` | `A5 80 53 08 00 00 00 00 00 00 00 00 80` | `A5 41 53 08 00 00 00 00 00 00 00 00 41` |
| 0x54 | `A5 40 54 08 00 00 00 00 00 00 00 00 41` | `A5 80 54 08 00 00 00 00 00 00 00 00 81` | `A5 41 54 08 00 00 00 00 00 00 00 00 42` |
| 0x57 | `A5 40 57 08 00 00 00 00 00 00 00 00 44` | `A5 80 57 08 00 00 00 00 00 00 00 00 84` | `A5 41 57 08 00 00 00 00 00 00 00 00 45` |
| 0x59 | `A5 40 59 08 00 00 00 00 00 00 00 00 46` | `A5 80 59 08 00 00 00 00 00 00 00 00 86` | `A5 41 59 08 00 00 00 00 00 00 00 00 47` |
| 0x5A | `A5 40 5A 08 00 00 00 00 00 00 00 00 47` | `A5 80 5A 08 00 00 00 00 00 00 00 00 87` | `A5 41 5A 08 00 00 00 00 00 00 00 00 48` |
| 0x5B | `A5 40 5B 08 00 00 00 00 00 00 00 00 48` | `A5 80 5B 08 00 00 00 00 00 00 00 00 88` | `A5 41 5B 08 00 00 00 00 00 00 00 00 49` |
| 0x5C | `A5 40 5C 08 00 00 00 00 00 00 00 00 49` | `A5 80 5C 08 00 00 00 00 00 00 00 00 89` | `A5 41 5C 08 00 00 00 00 00 00 00 00 4A` |
| 0x5D | `A5 40 5D 08 00 00 00 00 00 00 00 00 4A` | `A5 80 5D 08 00 00 00 00 00 00 00 00 8A` | `A5 41 5D 08 00 00 00 00 00 00 00 00 4B` |
| 0x5E | `A5 40 5E 08 00 00 00 00 00 00 00 00 4B` | `A5 80 5E 08 00 00 00 00 00 00 00 00 8B` | `A5 41 5E 08 00 00 00 00 00 00 00 00 4C` |
| 0x5F | `A5 40 5F 08 00 00 00 00 00 00 00 00 4C` | `A5 80 5F 08 00 00 00 00 00 00 00 00 8C` | `A5 41 5F 08 00 00 00 00 00 00 00 00 4D` |
| 0x60 | `A5 40 60 08 00 00 00 00 00 00 00 00 4D` | `A5 80 60 08 00 00 00 00 00 00 00 00 8D` | `A5 41 60 08 00 00 00 00 00 00 00 00 4E` |
| 0x61 | `A5 40 61 08 00 00 00 00 00 00 00 00 4E` | `A5 80 61 08 00 00 00 00 00 00 00 00 8E` | `A5 41 61 08 00 00 00 00 00 00 00 00 4F` |
| 0x62 | `A5 40 62 08 00 00 00 00 00 00 00 00 4F` | `A5 80 62 08 00 00 00 00 00 00 00 00 8F` | `A5 41 62 08 00 00 00 00 00 00 00 00 50` |
| 0x63 | `A5 40 63 08 00 00 00 00 00 00 00 00 50` | `A5 80 63 08 00 00 00 00 00 00 00 00 90` | `A5 41 63 08 00 00 00 00 00 00 00 00 51` |
| 0xD8 | `A5 40 D8 08 00 00 00 00 00 00 00 00 C5` | `A5 80 D8 08 00 00 00 00 00 00 00 00 05` | `A5 41 D8 08 00 00 00 00 00 00 00 00 C6` |

Wired variant with `0xAA` fill (batmon-ha `REQUEST_FRAMES`): `A5 40 90 08 AA AA AA AA AA AA AA AA CD`,
`A5 40 93 08 AA .. AA D0`, `A5 40 94 08 AA .. AA D1`, `A5 40 95 08 AA .. AA D2`; checksum = `(0x5FD + addr + cmd) & 0xFF`.

### 5.3 DALY_CLASSIC write requests

Writes reuse the layout of the matching read reply (write command = read command - 0x40). The PC software writes a
whole group in one frame, so read the group first, change one field, write all 8 bytes back and read the group again to
verify (smefa `docs/daly-write-commands.md`).

| Write | Mirrors read | Captured example (host `0x40`) | Decoded | Source |
|---|---|---|---|---|
| `0x10` | `0x50` | `A5 40 10 08 00 00 9C 40 00 00 0E 74 5B` | 40.000 Ah, 3.700 V | forum post 1 |
| `0x11` | `0x51` | `A5 40 11 08 01 0E 00 00 01 00 00 00 0E` | 1 board, cells (14, 0, 0), NTCs (1, 0, 0) | forum post 1 |
| `0x12` | `0x52` | `A5 40 12 08 00 00 00 00 00 00 00 00 FF` | cumulative values 0 (effect **unverified**) | forum post 1 |
| `0x13` | `0x53` | `A5 40 13 08 01 02 15 03 06 FF FF 00 1F` | mode 1, type 2, 2021-03-06, sleep 0xFFFF, wave 0 | forum post 1 |
| `0x13` | `0x53` | `A5 40 13 08 00 01 17 06 13 04 D2 02 09` | sleep 1234 s, other bytes copied from the read | smefa |
| `0x13` | `0x53` | `A5 40 13 08 00 01 17 06 13 FF FF 02 31` | no sleep timeout | smefa |
| `0x14` | `0x54` | `A5 40 14 08 32 30 32 30 30 33 30 36 8E` | "20200306" | forum post 1 |
| `0x17` | `0x57` | 5 frames sent back to back: `A5 40 17 08 01 32 30 32 30 30 33 30 5C`, `A5 40 17 08 02 36 20 20 20 20 20 20 FC`, `A5 40 17 08 03 20 .. 20 E7`, `A5 40 17 08 04 20 .. 20 E8`, `A5 40 17 08 05 20 .. 20 E9`; one reply | battery code "20200306" padded with spaces | forum post 1 |
| `0x19` | `0x59` | `A5 40 19 08 10 36 10 04 0A F0 0B B8 1D` | 4.150, 4.100, 2.800, 3.000 V | forum post 1 |
| `0x19` | `0x59` | `A5 40 19 08 0E 38 0E 42 08 FC 0A 28 D2` | 3.640, 3.650, 2.300, 2.600 V | smefa (Windows app capture) |
| `0x1A` | `0x5A` | `A5 40 1A 08 02 44 02 3E 01 88 01 B2 C9` | 58.0, 57.4, 39.2, 43.4 V | forum post 1 |
| `0x1A` | `0x5A` | `A5 40 1A 08 00 84 00 85 00 76 00 6C F2` | 13.2, 13.3, 11.8, 10.8 V | smefa |
| `0x1B` | `0x5B` | `A5 40 1B 08 6B D0 6F 54 7E 90 78 1E AA` | -240.0, -150.0, +240.0, +75.0 A | forum post 1 |
| `0x1C` | `0x5C` | `A5 40 1C 08 5F 69 05 00 69 6E 05 00 B2` | 55, 65, -35, -40, 65, 70, -35, -40 °C | forum post 1 |
| `0x1D` | `0x5D` | `A5 40 1D 08 03 E8 03 FC 00 C8 00 64 20` | 100.0, 102.0, 20.0, 10.0 % | forum post 1 |
| `0x1E` | `0x5E` | `A5 40 1E 08 01 F4 00 C8 0A 0F 78 1E 77` | 0.500, 0.200 V, 10, 15 °C (last 2 bytes copied stale bytes) | forum post 1 |
| `0x1F` | `0x5F` | `A5 40 1F 08 0D 48 00 32 00 00 0E 74 15` | 3.400 V, 0.050 V (last 4 bytes copied stale bytes) | forum post 1 |
| `0x1F` | `0x5F` | `A5 40 1F 08 0D 20 00 14 00 00 00 00 4D` | 3.360 V, 0.020 V | smefa |
| `0x20` | `0x60` | `A5 40 20 08 07 D0 00 64 00 00 00 00 48` | 2000 A, sampling resistance raw 100 | forum post 1 |
| `0x21` | (`0x61`) | `A5 40 21 08 1A 0B 12 0C 1E 00 03 E8 5A` | RTC 2026-11-18 12:30:00, SOC 100.0 % (computed example) | layout: dbus-serialbattery `write_soc_and_datetime()`, batmon-ha `daly_set_soc_payload()` |
| `0x21` | | `A5 40 21 08 00 00 00 00 00 00 03 25 36` | SOC 80.5 %, RTC bytes zero (python-daly-bms style) | smefa |

Write acknowledgement: `A5 <board> <cmd> 08 01 ..` (forum post 1: every write in "Set All" was answered with data 0 =
`0x01`, the other 7 bytes stale). dbus-serialbattery treats data 0 = `1` as success for `0x21`. smefa observed
unreliable replies to `0x13` (old data with one byte changed, later only stray single bytes). Verify every write by
reading the group back.

### 5.4 Modbus D2 requests

| Purpose | Frame | Source |
|---|---|---|
| status, 62 registers from `0x0000` | `D2 03 00 00 00 3E D7 B9` | aiobmsble, syssi, batmon-ha, snoop |
| status, 80 registers from `0x0000` | `D2 03 00 00 00 50 56 55` | syssi test `build_frame_` |
| MOSFET temperature block, 9 registers from `0x003E` | `D2 03 00 3E 00 09 F7 A3` | aiobmsble `MOS_INFO`, snoop |
| settings, 41 registers from `0x0080` | `D2 03 00 80 00 29 96 5F` | syssi, snoop, forum page 3 |
| version, 32 registers from `0x00A9` | `D2 03 00 A9 00 20 87 91` | aiobmsble, syssi, snoop |
| password, 3 registers from `0x00C9` | `D2 03 00 C9 00 03 C6 56` | syssi, snoop |
| production date, 2 registers from `0x00CC` | `D2 03 00 CC 00 02 17 97` | snoop |
| balancer switch, 1 register at `0x00CF` | `D2 03 00 CF 00 01 A7 96` | syssi |
| GPS block, 12 registers from `0x0057` | `D2 03 00 57 00 0C E7 BC` | snoop |
| charge MOSFET on / off (`0x00A5`) | `D2 06 00 A5 00 01 4B 8A` / `D2 06 00 A5 00 00 8A 4A` | registers: batmon-ha `SWITCH_REGISTERS` (from an HCI snoop of the app), syssi `SWITCHES`; CRC computed |
| discharge MOSFET on / off (`0x00A6`) | `D2 06 00 A6 00 01 BB 8A` / `D2 06 00 A6 00 00 7A 4A` | same |
| balancer on / off (`0x00CF`) | `D2 06 00 CF 00 01 6B 96` / `D2 06 00 CF 00 00 AA 56` | snoop records 248, 231 |
| set SOC to 100.0 % (`0x00A7` = 1000) | `D2 06 00 A7 03 E8 2B 34` | syssi `NUMBERS`; CRC computed |
| restart (`0x00F0` = 1) | `D2 06 00 F0 00 01 5B 9A` | syssi `BUTTONS`; vendor list "system restart" |
| shutdown (`0x00F1` = 1) | `D2 06 00 F1 00 01 0A 5A` | same |
| zero the current (`0x00F2` = 1) | `D2 06 00 F2 00 01 FA 5A` | same |
| reset (`0x00F3` = 1) | `D2 06 00 F3 00 01 AB 9A` | same; syssi calls it factory reset |
| set the clock (3 registers at `0x00D4`) | `D2 10 00 D4 00 03 1A 0B 12 0C 1E 00 FC 9E` (2026-11-18 12:30:00) | layout from snoop records 56 and 184; **unverified** on BMS firmware |

The value written to `0x00F0..0x00F3` is `1` in syssi; the vendor list gives no value (**unverified**). batmon-ha notes
that writes to `0x000C`/`0x000D` (the vendor example registers) are echoed but do not switch the MOSFETs.

### 5.5 Modbus 0x81 map requests (board 1)

| Purpose | Frame | Source |
|---|---|---|
| realtime block 1, 64 registers from `0x0000` | `81 03 00 00 00 40 5B FA` | aiobmsble, syssi, ESS capture |
| realtime block 1, 65 registers (includes `0x0040`) | `81 03 00 00 00 41 9A 3A` | ril3y/daly_bms; CRC computed |
| realtime block 2, 62 registers from `0x0041` | `81 03 00 41 00 3E 8B CE` | aiobmsble, syssi, ESS capture |
| `0x00A4`, 10 registers | `81 03 00 A4 00 0A 9B EE` | syssi, ESS capture |
| balancer switch `0x00CF` | `81 03 00 CF 00 01 AB F5` | syssi, ESS capture |
| cumulative energy `0x00E0`, 4 registers | `81 03 00 E0 00 04 5A 3F` | Sundaya `ADDR_CUM_CHG_POWER_START`; CRC computed |
| cumulative discharge energy `0x00E2`, 2 registers | `81 03 00 E2 00 02 7B FD` | Sundaya README example |
| settings block 1, 81 registers from `0x0100` | `81 03 01 00 00 51 9A 0A` | syssi, ESS capture |
| settings block 2, 39 registers from `0x0151` | `81 03 01 51 00 27 4A 3D` | syssi, ESS capture |
| version block, 74 registers from `0x0178` | `81 03 01 78 00 4A 5A 18` | aiobmsble, syssi, ESS capture |
| battery code, 16 registers from `0x019B` | `81 03 01 9B 00 10 2B D5` | Sundaya `ADDR_BAT_CODE_START`; CRC computed |
| settings block 3, 80 registers from `0x01C3` | `81 03 01 C3 00 50 AB F6` | syssi, ESS capture |
| settings block 4, 11 registers from `0x0220` | `81 03 02 20 00 0B 1B BF` | syssi, ESS capture |
| settings block 5, 2 registers from `0x024B` | `81 03 02 4B 00 02 AA 65` | syssi, ESS capture |
| charge MOSFET on / off (`0x0121`) | `81 06 01 21 00 01 06 3C` / `81 06 01 21 00 00 C7 FC` | patagonaa `DALY_MODBUS_ADDR_CHG_MOS_CONTROL`; CRC computed |
| discharge MOSFET on / off (`0x0122`) | `81 06 01 22 00 01 F6 3C` / `81 06 01 22 00 00 37 FC` | patagonaa `DALY_MODBUS_ADDR_DSCHG_MOS_CONTROL`; CRC computed |
| set SOC to 100.0 % (`0x0116` = 1000) | `81 06 01 16 03 E8 76 8C` | patagonaa README; CRC computed |
| sleep time 3600 s (`0x0115` = 360) | `81 06 01 15 01 68 86 4C` | patagonaa README; CRC computed |
| force heater on (`0x01F7` = 1) | `81 06 01 F7 00 01 E7 C4` | patagonaa README; CRC computed |
| force fan on (`0x01F8` = 1) | `81 06 01 F8 00 01 D7 C7` | patagonaa README; CRC computed |
| realtime block 1 of board 2 | `82 03 00 00 00 40 5B C9` | addressing per patagonaa and Sundaya; CRC computed |

---

## 6. Responses

### 6.1 DALY_CLASSIC live data

#### 0x90 pack voltage, current, SOC

| Data offset | Frame offset | Len | Type | Scale / unit | Meaning | Notes and sources |
|---|---|---|---|---|---|---|
| 0–1 | 4–5 (0x04–0x05) | 2 | u16be | 0.1 V | cumulative total voltage (pack voltage) | all implementations |
| 2–3 | 6–7 (0x06–0x07) | 2 | u16be | 0.1 V | "gather total voltage" (acquisition voltage) | CAN v1.0 notes; 0 in every capture; python-daly-bms "always 0" |
| 4–5 | 8–9 (0x08–0x09) | 2 | u16be | 0.1 A, 30000 offset | current | sign convention below |
| 6–7 | 10–11 (0x0A–0x0B) | 2 | u16be | 0.1 % | SOC | |

Current sign (classic): python-daly-bms and batmon-ha comment that negative means charging and positive discharging;
dbus-serialbattery computes `(raw - 30000) / -10` (default `INVERT_CURRENT_MEASUREMENT = 1`) so that discharge is
negative in Venus OS; the vendor Modbus list also states that charging current is negative and discharging current
positive; the PC software encodes charge current limits below 30000 (`0x5B`, forum post 1). The maland16 comment says
the opposite (positive into the pack), and dbus-serialbattery offers an option to invert because units differ.
Rule: `raw < 30000` = charging on classic firmware unless a cross-check with `0x93` data 0 (state) shows the opposite;
convert to the ubms model (positive = charging) accordingly and keep a per-device inversion option.

#### 0x91 highest and lowest cell voltage

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | 1 mV | highest cell voltage |
| 2 | 6 | 1 | u8 | | number of that cell, 1 based |
| 3–4 | 7–8 | 2 | u16be | 1 mV | lowest cell voltage |
| 5 | 9 | 1 | u8 | | number of that cell |
| 6–7 | 10–11 | 2 | | | undefined (stale) |

Sources: maland16, python-daly-bms, esphome, dbus-serialbattery, mpp-solar; capture `A5 01 91 08 0D 0C 04 0D 09 01 00 00
73` = 3.340 V cell 4, 3.337 V cell 1 (batmon-ha issue #429).

#### 0x92 highest and lowest temperature

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0 | 4 | 1 | u8 | +40, 1 °C | highest temperature |
| 1 | 5 | 1 | u8 | | probe number |
| 2 | 6 | 1 | u8 | +40 | lowest temperature |
| 3 | 7 | 1 | u8 | | probe number |
| 4–7 | 8–11 | 4 | | | undefined (stale) |

Temperatures above 87 °C have raw values above 127: decode the byte as unsigned (batmon-ha issue #429 fix).

#### 0x93 charge/discharge state and MOSFETs

| Data offset | Frame offset | Len | Type | Scale | Meaning | Notes |
|---|---|---|---|---|---|---|
| 0 | 4 | 1 | u8 | enum | state: 0 stationary, 1 charging, 2 discharging | maland16, python-daly-bms, esphome, mpp-solar |
| 1 | 5 | 1 | u8 | bool | charge MOSFET on | |
| 2 | 6 | 1 | u8 | bool | discharge MOSFET on | batmon-ha comments that on its unit this byte does not show the real switch state (**unverified**) |
| 3 | 7 | 1 | u8 | | "BMS life", rolling counter 0–255 | CAN v1.0 notes "BMS life (0~255 cycles)"; maland16 `bmsHeartBeat`; python-daly-bms "unstable"; not a cycle count |
| 4–7 | 8–11 | 4 | u32be | 1 mAh | remaining capacity | |

#### 0x94 status information 1

| Data offset | Frame offset | Len | Type | Scale | Meaning | Notes |
|---|---|---|---|---|---|---|
| 0 | 4 | 1 | u8 | | number of cells | decode unsigned |
| 1 | 5 | 1 | u8 | | number of temperature sensors | |
| 2 | 6 | 1 | u8 | bool | charger connected | |
| 3 | 7 | 1 | u8 | bool | load connected | |
| 4 | 8 | 1 | u8 | bits | DI/DO states: bits 0–3 = DI1–DI4, bits 4–7 = DO1–DO4 | CAN v1.0 notes, python-daly-bms, maland16 (LSB first); some firmware copies request byte 8 here (batmon-ha #429) |
| 5–6 | 9–10 | 2 | u16be | | charge/discharge cycles | decode unsigned |
| 7 | 11 | 1 | u8 | +40 | reserved; `DL_HKMS` boards report the MOSFET temperature here, 0 = not reported | acpiccolo `Status::mosfet_temperature` (**unverified** on other lines; the forum post 1 unit returns `0x20`, which would be -8 °C indoors) |

#### 0x95 cell voltages (per frame)

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0 | 4 | 1 | u8 | | frame number `n`, 1 based |
| 1–2 | 5–6 | 2 | u16be | 1 mV | cell `3(n-1)+1` |
| 3–4 | 7–8 | 2 | u16be | 1 mV | cell `3(n-1)+2` |
| 5–6 | 9–10 | 2 | u16be | 1 mV | cell `3(n-1)+3` |
| 7 | 11 | 1 | | | undefined (stale) |

Ignore slots beyond the cell count from `0x94`. dbus-serialbattery notes that current firmware occasionally sends
corrupted cell voltage frames and only fails after two bad reads in a row; batmon-ha checks the frame number order.

#### 0x96 temperatures (per frame)

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0 | 4 | 1 | u8 | | frame number `n`, 1 based |
| 1–7 | 5–11 | 7 | u8 each | +40 | sensors `7(n-1)+1` to `7(n-1)+7` |

A pack with one sensor answered with two frames (forum post 1, mpp-solar). Ignore sensors beyond the count from `0x94`.

#### 0x97 cell balancing

| Data offset | Frame offset | Len | Meaning |
|---|---|---|---|
| 0–5 | 4–9 | 6 | balancing state of cells 1–48: cell `k` (1 based) = bit `(k-1) % 8` of data byte `(k-1) / 8`, 1 = balancing |
| 6–7 | 10–11 | 2 | reserved |

Sources: maland16 `getCellBalanceState()`, matthewgream `getBit(index)`, CAN v1.0 notes ("Bit0~47 ... cells 1~48").
python-daly-bms (cell 1 = bit 0 of data byte 7, marked "not implemented") and dbus-serialbattery (cell 1 = bit 48 of the
64 bit value, then descending) disagree. No capture with balancing active is known: **unverified**.

#### 0x98 failure status

8 data bytes; bit tables in section 9.1. Data bytes 0–6 are flags, data byte 7 is a fault code (CAN v1.0 notes).

### 6.2 DALY_CLASSIC configuration and information replies

#### 0x50 rated capacity and nominal cell voltage

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0–3 | 4–7 | 4 | u32be | 1 mAh | rated (design) capacity |
| 4–5 | 8–9 | 2 | | | reserved (0) |
| 6–7 | 10–11 | 2 | u16be | 1 mV | nominal cell voltage |

Forum post 1 (`00 00 9C 40 00 00 0E 74` = 40 Ah, 3.7 V). dbus-serialbattery, acpiccolo and matthewgream read bytes 4–7
as one `u32be` in mV, which gives the same value while bytes 4–5 are 0.

#### 0x51 board configuration

| Data offset | Frame offset | Len | Meaning |
|---|---|---|---|
| 0 | 4 | 1 | number of acquisition boards |
| 1–3 | 5–7 | 3 | cells on board 1, 2, 3 |
| 4–6 | 8–10 | 3 | NTC sensors on board 1, 2, 3 |
| 7 | 11 | 1 | reserved |

Forum post 1 (`01 0E 00 00 01 00 00 00`), matthewgream `RequestResponse_BMS_CONFIG`, acpiccolo test (`01 08 00 00 02 00 00
00`: 1 board, 8 cells, 2 NTCs). acpiccolo names byte 0 "board number"; the Modbus registers `0x0082..0x0088` (board
count, cells per board, sensors per board) support "number of boards".

#### 0x52 cumulative charge and discharge

| Data offset | Frame offset | Len | Type | Meaning |
|---|---|---|---|---|
| 0–3 | 4–7 | 4 | u32be | cumulative charge |
| 4–7 | 8–11 | 4 | u32be | cumulative discharge |

Unit: acpiccolo decodes 1 Ah per count (capture 2119 / 3144 on an 8S `DL_HKMS` board); matthewgream marks it "XXX TBC";
forum post 1 unit returns zeros. Unit **unverified**.

#### 0x53 battery information

| Data offset | Frame offset | Len | Type | Meaning | Notes |
|---|---|---|---|---|---|
| 0 | 4 | 1 | u8 | battery operation mode | raw; matthewgream: `0x01` = "long-press power on/off" (**unverified**) |
| 1 | 5 | 1 | u8 | battery type | raw; `0x01` on a 4S LiFePO4 pack (smefa), `0x02` on a 14S pack with 4.15 V limits (forum post 1); enumeration **unverified** |
| 2 | 6 | 1 | u8 | production year - 2000 | dbus-serialbattery `read_production_date()`, acpiccolo, matthewgream |
| 3 | 7 | 1 | u8 | production month | |
| 4 | 8 | 1 | u8 | production day | |
| 5–6 | 9–10 | 2 | u16be | sleep timeout in seconds, `0xFFFF` = never | smefa (two writes, 1234 s and 4321 s, confirmed the byte order); acpiccolo reads only byte 5 as minutes and matthewgream byte 5 x 60 s: both disagree with the captures |
| 7 | 11 | 1 | u8 | current wave: current below which 0 A is reported, 0.1 A | smefa ("DfilterCur", from a forum post; `0x02` = 0.2 A) |

#### 0x54 firmware index number

All 8 data bytes are ASCII (forum post 1: `32 30 32 30 30 33 30 36` = "20200306"). matthewgream treats it as a framed
string and loses the first character.

#### 0x57 battery code

5 frames; data 0 = frame number 1–5, data 1–7 = 7 ASCII characters; 35 characters padded with spaces or NUL
(forum post 1, dbus-serialbattery `read_battery_code()`, acpiccolo).

#### 0x59 cell voltage thresholds, 0x5A pack voltage thresholds

| Data offset | Frame offset | Len | Type | 0x59 scale | 0x5A scale | Meaning |
|---|---|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | 1 mV | 0.1 V | high, level 1 |
| 2–3 | 6–7 | 2 | u16be | 1 mV | 0.1 V | high, level 2 |
| 4–5 | 8–9 | 2 | u16be | 1 mV | 0.1 V | low, level 1 |
| 6–7 | 10–11 | 2 | u16be | 1 mV | 0.1 V | low, level 2 |

Sources: forum post 1, matthewgream `RequestResponse_TYPE_THRESHOLD_MINMAX`, Daly2MQTT `getVoltageThreshold()`, smefa.
The order is the same in every source, but the voltage examples are not monotonic (forum: high L1 4.150 V above high L2
4.100 V; smefa: low L1 2.300 V below low L2 2.600 V), while the SOC and temperature examples are. Whether the device
enforces an order is **unverified**.

#### 0x5B current thresholds

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | 0.1 A, 30000 offset | charge overcurrent, level 1 |
| 2–3 | 6–7 | 2 | u16be | 0.1 A, 30000 offset | charge overcurrent, level 2 |
| 4–5 | 8–9 | 2 | u16be | 0.1 A, 30000 offset | discharge overcurrent, level 1 |
| 6–7 | 10–11 | 2 | u16be | 0.1 A, 30000 offset | discharge overcurrent, level 2 |

Charge limits are stored below 30000 (`6B D0` = 27600 = -240.0 A), discharge limits above (`7E 90` = 32400 = +240.0 A)
(forum post 1). Present them as positive amperes and keep the sign rule when writing.

#### 0x5C temperature thresholds

| Data offset | Frame offset | Meaning (all u8, +40) |
|---|---|---|
| 0 | 4 | charge high, level 1 |
| 1 | 5 | charge high, level 2 |
| 2 | 6 | charge low, level 1 |
| 3 | 7 | charge low, level 2 |
| 4 | 8 | discharge high, level 1 |
| 5 | 9 | discharge high, level 2 |
| 6 | 10 | discharge low, level 1 |
| 7 | 11 | discharge low, level 2 |

Sources: matthewgream `RequestResponse_THRESHOLDS_SENSOR`; forum capture `5F 69 05 00 69 6E 05 00` = 55, 65, -35, -40,
65, 70, -35, -40 °C.

#### 0x5D SOC thresholds

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | 0.1 % | SOC high, level 1 |
| 2–3 | 6–7 | 2 | u16be | 0.1 % | SOC high, level 2 |
| 4–5 | 8–9 | 2 | u16be | 0.1 % | SOC low, level 1 |
| 6–7 | 10–11 | 2 | u16be | 0.1 % | SOC low, level 2 |

Sources: matthewgream `RequestResponse_THRESHOLDS_CHARGE`; forum capture = 100.0, 102.0, 20.0, 10.0 %.

#### 0x5E difference thresholds

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | 1 mV | cell voltage difference, level 1 |
| 2–3 | 6–7 | 2 | u16be | 1 mV | cell voltage difference, level 2 |
| 4 | 8 | 1 | u8 | 1 °C, no offset | temperature difference, level 1 |
| 5 | 9 | 1 | u8 | 1 °C, no offset | temperature difference, level 2 |
| 6–7 | 10–11 | 2 | | | undefined (stale) |

matthewgream applies the 40 offset to bytes 4–5, which turns the forum values 10 and 15 into -30 and -25 °C; the Modbus
registers `0x00A1`/`0x00A2` (same quantity) have no offset. No offset is used here (**unverified** by a write test).

#### 0x5F balancing thresholds

| Data offset | Frame offset | Len | Type | Scale | Meaning |
|---|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | 1 mV | balancing start (enable) voltage |
| 2–3 | 6–7 | 2 | u16be | 1 mV | balancing start difference (acceptable difference) |
| 4–7 | 8–11 | 4 | | | undefined (stale; smefa saw `00 00 0C 80`, forum `00 00 0E 74`) |

Forum note: the PC software does not accept a difference below 0.050 V, the protocol would.

#### 0x60 short circuit and current sampling

| Data offset | Frame offset | Len | Type | Meaning |
|---|---|---|---|---|
| 0–1 | 4–5 | 2 | u16be | short circuit shutdown current, 1 A |
| 2–3 | 6–7 | 2 | u16be | current sampling resistance, raw (100 in the capture; forum: "in milliohms ... 0.1 Ω", matthewgream: raw / 1000); unit **unverified** |
| 4–7 | 8–11 | 4 | | reserved |

#### 0x61 real time clock

| Data offset | Frame offset | Meaning |
|---|---|---|
| 0 | 4 | year - 2000 |
| 1 | 5 | month |
| 2 | 6 | day |
| 3 | 7 | hour |
| 4 | 8 | minute |
| 5 | 9 | second |
| 6–7 | 10–11 | 0 in the acpiccolo capture, stale in the forum capture; Daly2MQTT comments "read the time and soc" (**unverified**) |

Capture: `A5 01 61 08 1A 07 1D 13 20 18 00 00 98` = 2026-07-29 19:32:24 (acpiccolo `rtc_decodes_datetime`).

#### 0x62 software version, 0x63 hardware version

2 frames each; data 0 = frame number, data 1–7 = 7 ASCII characters; 14 characters in total. Captures: "20210222-1.01T"
and "DL-BMS-R32-01E" (forum post 1); "12_250520_BRST" and "H2.1_103E_30XF" (acpiccolo).

#### Write acknowledgements, 0xD8

`A5 <board> <cmd> 08 <data 0> ..`: data 0 = `0x01` after configuration writes, the requested state after `0xD9`/`0xDA`
(forum page 2: only the first byte is new, the others are left over from the previous reply);
reply to `0xD8`: 8 zero bytes (forum post 1).

### 6.3 Modbus D2 register map

Read with function `0x03`, write with `0x06` (single register) or `0x10` (several, no byte count). R/W column from the
vendor list. Sources for every row: both vendor xlsx files in syssi/esphome-daly-bms `docs/` ("protocol" and
"register descriptions" sheets), unless another source is named.

#### Status registers 0x0000–0x004F

| Register | Payload offset in a read from 0x0000 | Type | Scale / unit | Meaning | Notes |
|---|---|---|---|---|---|
| `0x0000`–`0x001F` | 0–63 | u16be | 1 mV | cell voltage 1–32 | 0 for unused cells |
| `0x0020`–`0x0027` | 64–79 | u16be | +40, 1 °C | temperature 1–8 | count in `0x0032`; an unused slot read `0x0028` (0 °C) in a capture |
| `0x0028` | 80–81 | u16be | 0.1 V | total voltage | |
| `0x0029` | 82–83 | u16be | 0.1 A, 30000 offset | current | positive = charging in captures (section 12.1, item 1) |
| `0x002A` | 84–85 | u16be | 0.1 % | SOC | vendor text: "0.001, 800/1000 = 80 %" |
| `0x002B` | 86–87 | u16be | 1 mV | highest cell voltage | |
| `0x002C` | 88–89 | u16be | 1 mV | lowest cell voltage | |
| `0x002D` | 90–91 | u16be | +40 | highest cell temperature | |
| `0x002E` | 92–93 | u16be | +40 | lowest cell temperature | |
| `0x002F` | 94–95 | u16be | enum | 0 stationary, 1 charging, 2 discharging | |
| `0x0030` | 96–97 | u16be | 0.1 Ah | remaining capacity | |
| `0x0031` | 98–99 | u16be | | cell count | aiobmsble and syssi clamp to 32 |
| `0x0032` | 100–101 | u16be | | temperature sensor count | clamp to 8 |
| `0x0033` | 102–103 | u16be | | cycle count | |
| `0x0034` | 104–105 | u16be | 0 off, 1 on | balancing active | |
| `0x0035` | 106–107 | u16be | 0 off, 1 on | charge MOSFET | |
| `0x0036` | 108–109 | u16be | 0 off, 1 on | discharge MOSFET | |
| `0x0037` | 110–111 | u16be | 1 mV | average cell voltage | |
| `0x0038` | 112–113 | u16be | 1 mV | cell voltage difference | |
| `0x0039` | 114–115 | u16be | 1 W | power, unsigned | sign from `0x002F`; syssi computes V x I instead |
| `0x003A`–`0x003D` | 116–123 | 4 x u16be | bits | fault status 1–4 | section 9.2 |
| `0x003E` | 124–125 | u16be | | vendor: remaining mileage, 0.1 km; syssi: balancing bits cells 1–16 (inferred) | **unverified** |
| `0x003F` | 126–127 | u16be | | vendor: reserved; syssi: balancing bits cells 17–32 (inferred) | **unverified** |
| `0x0040` | 128–129 | u16be | 0.001 A, 30000 offset | vendor: reserved; balance current (syssi) | 30000 in every capture |
| `0x0041` | 130–131 | u16be | | reserved / unknown | |
| `0x0042` | 132–133 | u16be | +40 | MOSFET temperature (aiobmsble, syssi) | `0x0000` or `0xFFFF` = not available (aiobmsble disables the read) |
| `0x0043` | 134–135 | u16be | +40 | board temperature (syssi) | 0 or `0xFFFF` in captures, **unverified** |
| `0x0044`–`0x004F` | 136–159 | | | unknown, 0 in captures | |

A 62 register read ends at `0x003D`; an 80 register read (newer firmware) ends at `0x004F`.

#### Other read blocks

| Registers | Meaning | Notes |
|---|---|---|
| `0x0047`–`0x0056` | vendor: "single battery voltage" (16 more cell registers) | roccotsi2 simulation lists a 32 byte block of 16 further cell voltages; overlaps the newer status layout; **unverified** |
| `0x0057`–`0x0069` | GPS and IMEI block for 4G/GPS modules: valid flag (`0xA5` = valid), longitude, latitude, speed (0.1 km/h), altitude (m), satellites, "protection board data acquisition normal flag", IMEI | the two vendor files place the fields differently (`0x0058` longitude E/W and `0x0059..0x005A` value, against `0x0058..0x0059` longitude); not decoded here |
| `0x0063` (28), `0x00D7` (1), `0x00DF` (17) | read by the official app; all `0xFF` or 0 on the balancer | unknown |

#### Settings registers 0x0080–0x00A8 (read 41 registers from 0x0080)

| Register | R/W | Type | Scale / unit | Meaning |
|---|---|---|---|---|
| `0x0080` | R/W | u16be | 0.1 Ah | rated capacity |
| `0x0081` | R/W | u16be | 1 mV | cell reference (nominal) voltage |
| `0x0082` | R/W | u16be | | number of acquisition boards |
| `0x0083`–`0x0085` | R/W | u16be | | cells on acquisition board 1, 2, 3 |
| `0x0086`–`0x0088` | R/W | u16be | | temperature sensors on board 1, 2, 3 |
| `0x0089` | R/W | u16be | enum | battery type: 0 LiFePO4, 1 ternary (Li-ion), 2 lithium titanate |
| `0x008A` | R/W | u16be | 1 s | sleep wait time |
| `0x008B` | R/W | u16be | 1 mV | cell voltage high, level 1 |
| `0x008C` | R/W | u16be | 1 mV | cell voltage high, level 2 |
| `0x008D` | R/W | u16be | 1 mV | cell voltage low, level 1 |
| `0x008E` | R/W | u16be | 1 mV | cell voltage low, level 2 |
| `0x008F` | R/W | u16be | 0.1 V | total voltage high, level 1 |
| `0x0090` | R/W | u16be | 0.1 V | total voltage high, level 2 |
| `0x0091` | R/W | u16be | 0.1 V | total voltage low, level 1 |
| `0x0092` | R/W | u16be | 0.1 V | total voltage low, level 2 |
| `0x0093` | R/W | u16be | 0.1 A, 30000 offset | charge current high, level 1 |
| `0x0094` | R/W | u16be | 0.1 A, 30000 offset | charge current high, level 2 |
| `0x0095` | R/W | u16be | 0.1 A, 30000 offset | discharge current high, level 1 |
| `0x0096` | R/W | u16be | 0.1 A, 30000 offset | discharge current high, level 2 |
| `0x0097` | R/W | u16be | +40 | charge temperature high, level 1 |
| `0x0098` | R/W | u16be | +40 | charge temperature high, level 2 |
| `0x0099` | R/W | u16be | +40 | charge temperature low, level 1 |
| `0x009A` | R/W | u16be | +40 | charge temperature low, level 2 |
| `0x009B` | R/W | u16be | +40 | discharge temperature high, level 1 |
| `0x009C` | R/W | u16be | +40 | discharge temperature high, level 2 |
| `0x009D` | R/W | u16be | +40 | discharge temperature low, level 1 |
| `0x009E` | R/W | u16be | +40 | discharge temperature low, level 2 |
| `0x009F` | R/W | u16be | 1 mV | cell voltage difference, level 1 |
| `0x00A0` | R/W | u16be | 1 mV | cell voltage difference, level 2 |
| `0x00A1` | R/W | u16be | 1 °C | temperature difference, level 1 |
| `0x00A2` | R/W | u16be | 1 °C | temperature difference, level 2 |
| `0x00A3` | R/W | u16be | 1 mV | balancing start voltage |
| `0x00A4` | R/W | u16be | 1 mV | balancing start difference |
| `0x00A5` | R/W | u16be | 0 off, 1 on | charge MOSFET switch |
| `0x00A6` | R/W | u16be | 0 off, 1 on | discharge MOSFET switch |
| `0x00A7` | W (reads back in captures) | u16be | 0.1 % | SOC setting |
| `0x00A8` | R/W | u16be | +40 | MOSFET temperature protection alarm |

Register layout confirmed by syssi `decode_settings_data_()` and its tests, by a real capture of a 4S pack (forum page
3) and by the balancer snoop. Example (syssi `SETTINGS_FRAME_1`): 105.0 Ah, 3200 mV, 1 board, 4 cells, 1 sensor, type 0,
sleep 7200 s, cell high 3500/3500 mV, cell low 2600/2600 mV, total high 14.0/14.0 V, total low 10.4/10.4 V, charge
current -10.0/-10.0 A, discharge current -16.0/+16.0 A, charge temperature 45/45 and 0/0 °C, discharge temperature
70/70 and -1/-1 °C, differences 255 mV/255 mV/255 °C/255 °C, balancing 3200 mV/20 mV, MOSFETs 1/1, SOC 68.0 %,
MOSFET alarm 47 °C.

#### Information and command registers

| Registers | R/W | Format | Meaning | Notes |
|---|---|---|---|---|
| `0x00A9`–`0x00B0` | R | 16 ASCII, NUL padded | software version | aiobmsble reads bytes 0..15 |
| `0x00B1`–`0x00B8` | R | 16 ASCII | hardware version | aiobmsble reads bytes 16..31 |
| `0x00B9`–`0x00C8` | R | 32 bytes | machine code | syssi reads its "hardware version" from here (see section 10) |
| `0x00C9`–`0x00CB` | R/W | 6 ASCII | parameter setting password | `123456` in all captures |
| `0x00CC`–`0x00CD` | R | 4 bytes `YY MM DD 00` | production date | vendor example "August 15, 2020 -> 0x14080F00" |
| `0x00CE`–`0x00E5` | R | ASCII | IP address and port of the cloud server (vendor list) | second vendor file ends at `0x00DE` |
| `0x00CF` | R/W | u16be | balancer switch on Daly active balancers (0 off, 1 on) | snoop, syssi; conflicts with the IP address range of the vendor list |
| `0x00D4`–`0x00D6` | W | `YY MM DD hh mm ss` | clock, written by the app with function `0x10` | snoop only, **unverified** |
| `0x00F0` | W | | system restart | |
| `0x00F1` | W | | system shutdown | |
| `0x00F2` | W | | zero the current reading | |
| `0x00F3` | W | | reset (syssi: factory reset) | |

### 6.4 Modbus 0x81 register map

Read with function `0x03` from address `0x80 + board`; answers come from `0x50 + board`. Sources per row.

#### Realtime block 1: 0x0000–0x0040

| Register | Payload offset in a read from 0x0000 | Type | Scale / unit | Meaning | Sources / notes |
|---|---|---|---|---|---|
| `0x0000`–`0x002F` | 0–95 | u16be | 1 mV | cell voltage 1–48 | patagonaa, syssi, aiobmsble, ril3y |
| `0x0030`–`0x0037` | 96–111 | u16be | +40 | temperature 1–8; `0x00FF` = not available | patagonaa (`unavailable_value` 255); aiobmsble capture with `0x00FF` |
| `0x0038` | 112–113 | u16be | 0.1 V | total voltage | all |
| `0x0039` | 114–115 | u16be | 0.1 A, 30000 offset | current, positive = charging | patagonaa README, ril3y "+ charge / - discharge", ESS capture (-8.9 A while state = 2) |
| `0x003A` | 116–117 | u16be | 0.1 % | SOC | all |
| `0x003B` | 118–119 | u16be | | patagonaa: SOH (defined, not used); syssi: heartbeat counter | changes on every poll in the ESS capture (`0x00B6`, then `0x00F2`); value 72 on the aiobmsble pack; treat as counter, **unverified** |
| `0x003C` | 120–121 | u16be | | cell count | |
| `0x003D` | 122–123 | u16be | | temperature sensor count | |
| `0x003E` | 124–125 | u16be | 1 mV | highest cell voltage | patagonaa |
| `0x003F` | 126–127 | u16be | | number of the highest cell | patagonaa |
| `0x0040` | 128–129 | u16be | 1 mV | lowest cell voltage | patagonaa; only in a 65 register read |

#### Realtime block 2: 0x0041–0x007E

| Register | Payload offset in a read from 0x0041 | Type | Scale / unit | Meaning | Sources / notes |
|---|---|---|---|---|---|
| `0x0041` | 0–1 | u16be | | number of the lowest cell | patagonaa; ESS = 9 |
| `0x0042` | 2–3 | u16be | 1 mV | cell voltage difference | patagonaa; ESS = 5 |
| `0x0043` | 4–5 | u16be | +40 | highest temperature | patagonaa, syssi |
| `0x0044` | 6–7 | u16be | | probe of the highest temperature | patagonaa, syssi |
| `0x0045` | 8–9 | u16be | +40 | lowest temperature | |
| `0x0046` | 10–11 | u16be | | probe of the lowest temperature | |
| `0x0047` | 12–13 | u16be | 1 °C | temperature difference | patagonaa |
| `0x0048` | 14–15 | u16be | enum | 0 stationary, 1 charging, 2 discharging | patagonaa, syssi, ril3y |
| `0x0049`–`0x004A` | 16–19 | | | unknown (0) | |
| `0x004B` | 20–21 | u16be | 0.1 Ah | remaining capacity | patagonaa, syssi, aiobmsble, ril3y |
| `0x004C` | 22–23 | u16be | | cycle count | |
| `0x004D` | 24–25 | u16be | | balancing state: 0 off, 1 passive, 2 active (syssi, ril3y); patagonaa: active if > 0 | ESS shows 7: other values **unverified** |
| `0x004E` | 26–27 | u16be | 0.001 A, 30000 offset | balance current | patagonaa, syssi; the ESS pack reports raw 0 (treat as not available) |
| `0x004F`–`0x0051` | 28–33 | 3 x u16be | bits | balancing cells 1–16, 17–32, 33–48: bit `i` = cell `16 g + i + 1` of group `g` | patagonaa |
| `0x0052` | 34–35 | u16be | bool | charge MOSFET on | |
| `0x0053` | 36–37 | u16be | bool | discharge MOSFET on | |
| `0x0054` | 38–39 | u16be | bool | precharge MOSFET on | patagonaa, syssi |
| `0x0055` | 40–41 | u16be | bool | heater MOSFET on | patagonaa, aiobmsble (`heater`) |
| `0x0056` | 42–43 | u16be | bool | fan MOSFET on | patagonaa |
| `0x0057` | 44–45 | u16be | 1 mV | average cell voltage | syssi map, ril3y; ESS 3314 mV |
| `0x0058` | 46–47 | u16be | 1 W | power, unsigned | patagonaa signs it with `0x0048`; ESS 471 W at 53.0 V and 8.9 A (Sundaya scales by 0.1, contradicted by this capture) |
| `0x0059` | 48–49 | u16be | | energy | patagonaa; syssi "Wh"; unit **unverified** |
| `0x005A` | 50–51 | u16be | +40 | MOSFET temperature | patagonaa, syssi; ESS 24 °C |
| `0x005B` | 52–53 | u16be | +40 | board temperature | patagonaa, syssi; ESS 30 °C |
| `0x005C` | 54–55 | u16be | +40 | heater temperature | patagonaa |
| `0x005D` | 56–57 | | | unknown | |
| `0x005E` | 58–59 | u16be | | remaining mileage | patagonaa; unit **unverified** |
| `0x005F`–`0x0060` | 60–63 | | | unknown (`0x0060` = 30000 in both captures) | |
| `0x0061`–`0x0063` | 64–69 | 6 bytes | `YY MM DD hh mm ss` | date and time | ESS capture: 2026-06-02 20:02:33, one poll later 20:03:34; aiobmsble capture: 2026-06-05 09:34:16; **unverified** |
| `0x0064` | 70–71 | u16be | | remaining charging time | patagonaa; unit **unverified**; decreased from 2891 to 2868 between two polls |
| `0x0065` | 72–73 | | | unknown | |
| `0x0066`–`0x0069` | 74–81 | 8 bytes | bits | "type 1" fault bytes | patagonaa defines, does not decode; ESS `0x0068` = `0x0080`; **unverified** |
| `0x006A`–`0x006C` | 82–87 | | | unknown; `0x006C` equals SOC x 10 in both captures | |
| `0x006D`–`0x0073` | 88–101 | 14 bytes | level fields and flags | "type 2" alarm codes 0–13 | patagonaa `DalyHkmsStatus`; section 9.3 |
| `0x0074`–`0x007E` | 102–123 | | | unknown | |

aiobmsble reads its `problem_code` from `0x006D..0x006E` only (4 bytes) and misses the alarms in codes 4–13.

#### Other registers of the 0x81 map

| Register | Type | Meaning | Source |
|---|---|---|---|
| `0x00A4`–`0x00AD` | u16be | read by syssi for logging only; `0x00A6` and `0x00A7` = allowed charge and discharge current, 0.1 A (ESS: 150.0 A each) | Sundaya `ADDR_ALLOW_CHG_CURRENT`; rest unknown |
| `0x00CF` | u16be | balancer switch; any non-zero value = on (ESS reads `0xFFFF`) | syssi |
| `0x00E0`–`0x00E1` | u32be | cumulative charge energy, 0.1 kWh | Sundaya |
| `0x00E2`–`0x00E3` | u32be | cumulative discharge energy, 0.1 kWh | Sundaya |
| `0x0100` | u16be | board number (= Modbus address - 0x80) | patagonaa README; ESS = 1 |
| `0x0115` | u16be | sleep time in units of 10 s; 65535 = off | patagonaa README; ESS = 65535 |
| `0x0116` | u16be | SOC x 10 (write to set the SOC) | patagonaa README; ESS reads 834 while `0x003A` = 864 |
| `0x0117` | u16be | SOH x 10 | Sundaya `ADDR_SOH_SETTINGS`; ESS = 1000 |
| `0x0121` | u16be | charge MOSFET control, 0 / 1 | patagonaa |
| `0x0122` | u16be | discharge MOSFET control, 0 / 1 | patagonaa |
| `0x0126`–`0x0128` | 6 ASCII | `123456` in the ESS capture (password, as D2 `0x00C9`) | **unverified** |
| `0x0129`–`0x012A` | `YY MM DD 00` | `1A 03 1A 00` = 2026-03-26 (matches the date in the version block) | **unverified** |
| `0x0178`–`0x01C1` | ASCII fields | version block, section 10 | aiobmsble, syssi |
| `0x019B`–`0x01AA` | 32 ASCII | battery code | Sundaya `ADDR_BAT_CODE_START` |
| `0x01F7` | u16be | force heater on, 0 / 1 | patagonaa README; ESS = 0 |
| `0x01F8` | u16be | force fan on, 0 / 1 | patagonaa README; ESS = 0 |

syssi `docs/protocol-register-map.md` claims that the 0x81 settings sit exactly `0x80` above the D2 settings (rated
capacity at `0x0100`, balancing at `0x0123/0x0124`, SOC at `0x0127`). The ESS capture contradicts it (`0x0100` = 1, the
board number per patagonaa; `0x0123/0x0124` hold part of a date; `0x0127` holds ASCII `34`), so that table is not used
here.

---

## 7. Settings

How to read the tables: "Classic" gives the read command and data offset, then the write command; writes always send
the complete 8 byte group of the read reply (section 5.3). "D2" and "0x81" give the register (write with function
`0x06`). The suggested `id` uses the canonical ids of `packages/bms-core/src/catalog.js`; ids starting with `daly.`
are Daly specific. Status: **confirmed** = layout seen in a capture or the vendor list and used by an implementation;
**inferred** = value pattern only, keep read-only.

### 7.1 Cell voltage

| Setting | id | Classic | D2 | 0x81 | Encoding | Status, notes |
|---|---|---|---|---|---|---|
| cell high voltage, level 1 (warning) | `cell.ov_alarm` | `0x59` data 0–1 / `0x19` | `0x008B` | `0x0130` | u16be mV | classic and D2 confirmed; 0x81 inferred (ESS 3450 mV) |
| cell high voltage, level 2 (protection) | `cell.ovp` | `0x59` data 2–3 / `0x19` | `0x008C` | `0x0131` | u16be mV | as above (ESS 3550 mV) |
| cell high voltage recovery | `cell.ovpr` | none | none | `0x0132` | u16be mV | inferred (ESS 3400 mV) |
| cell high voltage delay | `cell.ovp_delay` | none | none | `0x0133` | u16be, unit unverified | inferred (ESS 5000) |
| cell low voltage, level 1 | `cell.uv_alarm` | `0x59` data 4–5 / `0x19` | `0x008D` | `0x0134` | u16be mV | classic and D2 confirmed; 0x81 inferred (ESS 2800 mV) |
| cell low voltage, level 2 | `cell.uvp` | `0x59` data 6–7 / `0x19` | `0x008E` | `0x0135` | u16be mV | as above (ESS 2700 mV) |
| cell low voltage recovery | `cell.uvpr` | none | none | `0x0136` | u16be mV | inferred (ESS 2900 mV) |
| cell low voltage delay | `cell.uvp_delay` | none | none | `0x0137` | u16be, unit unverified | inferred (ESS 5000) |
| cell voltage difference, level 1 | `cell.diff_alarm` | `0x5E` data 0–1 / `0x1E` | `0x009F` | `0x015A` | u16be mV | classic and D2 confirmed; 0x81 inferred (ESS 450 mV) |
| cell voltage difference, level 2 | `cell.diff_protection` | `0x5E` data 2–3 / `0x1E` | `0x00A0` | `0x015B` | u16be mV | as above (ESS 500 mV) |
| nominal (reference) cell voltage | `daly.cell_nominal_voltage` | `0x50` data 6–7 / `0x10` | `0x0081` | `0x0114` | u16be mV | classic and D2 confirmed; 0x81 inferred (ESS 3200 mV) |

### 7.2 Pack voltage

| Setting | id | Classic | D2 | 0x81 | Encoding | Status, notes |
|---|---|---|---|---|---|---|
| pack high voltage, level 1 | `pack.ov_alarm` | `0x5A` data 0–1 / `0x1A` | `0x008F` | `0x0138` | u16be 0.1 V | classic and D2 confirmed; 0x81 inferred (ESS 55.2 V) |
| pack high voltage, level 2 | `pack.ovp` | `0x5A` data 2–3 / `0x1A` | `0x0090` | `0x0139` | u16be 0.1 V | ESS 56.2 V |
| pack high voltage recovery | `pack.ovpr` | none | none | `0x013A` | u16be 0.1 V | inferred (ESS 54.2 V); `0x013B` = delay (1000) |
| pack low voltage, level 1 | `pack.uv_alarm` | `0x5A` data 4–5 / `0x1A` | `0x0091` | `0x013C` | u16be 0.1 V | ESS 45.6 V |
| pack low voltage, level 2 | `pack.uvp` | `0x5A` data 6–7 / `0x1A` | `0x0092` | `0x013D` | u16be 0.1 V | ESS 44.0 V |
| pack low voltage recovery | `pack.uvpr` | none | none | `0x013E` | u16be 0.1 V | inferred (ESS 45.0 V); `0x013F` = delay (1000) |

### 7.3 Current

| Setting | id | Classic | D2 | 0x81 | Encoding | Status, notes |
|---|---|---|---|---|---|---|
| charge overcurrent, level 1 | `charge.oc_alarm` | `0x5B` data 0–1 / `0x1B` | `0x0093` | `0x0140` | u16be, `raw = 30000 - A x 10` | classic confirmed (forum); D2 confirmed register; 0x81 inferred (ESS 28400 = 160 A) |
| charge overcurrent, level 2 | `charge.ocp` | `0x5B` data 2–3 / `0x1B` | `0x0094` | `0x0141` | same | ESS 200 A; `0x0142` = delay (1000) |
| charge overcurrent, level 3 | `daly.charge_ocp3` | none | none | `0x0143` | same | inferred (ESS 300 A); `0x0144` = delay |
| discharge overcurrent, level 1 | `discharge.oc_alarm` | `0x5B` data 4–5 / `0x1B` | `0x0095` | `0x0145` | u16be, `raw = 30000 + A x 10` | 0x81 inferred (ESS 31600 = 160 A) |
| discharge overcurrent, level 2 | `discharge.ocp` | `0x5B` data 6–7 / `0x1B` | `0x0096` | `0x0146` | same | ESS 200 A; `0x0147` = delay |
| discharge overcurrent, level 3 | `discharge.ocp2` | none | none | `0x0148` | same | inferred (ESS 300 A); `0x0149` = delay |
| short circuit current | `scp.current` | `0x60` data 0–1 / `0x20` | none | unknown | u16be A | classic confirmed (forum: 2000 A) |
| current sampling resistance | `daly.current_sampling_resistance` | `0x60` data 2–3 / `0x20` | none | unknown | u16be raw | unit **unverified**; keep read-only (wrong values corrupt the current measurement) |
| current wave (zero current band) | `daly.current_deadband` | `0x53` data 7 / `0x13` | none | unknown | u8, 0.1 A | smefa (forum post); **unverified** |
| allowed charge / discharge current | `daly.allowed_charge_current`, `daly.allowed_discharge_current` | none | none | `0x00A6`, `0x00A7` | u16be 0.1 A | Sundaya reads them; writable **unverified** |

The D2 example frame (syssi) stores charge limits as 29900 (-10.0 A) and the discharge limits as 29840 (-16.0 A, level 1)
and 30160 (+16.0 A, level 2): the sign of a stored discharge limit is not reliable. Decode as `abs((raw - 30000) x 0.1)`
for display; when writing use `30000 - A x 10` for charge and `30000 + A x 10` for discharge (forum and ESS captures).

### 7.4 Temperature

All temperature thresholds are `+40` encoded (raw = °C + 40): one byte in classic `0x5C`, one register in D2 and 0x81.

| Setting | id | Classic `0x5C` / `0x1C` | D2 | 0x81 | Status, notes |
|---|---|---|---|---|---|
| charge high temperature, level 1 | `daly.charge_ot_alarm` | data 0 | `0x0097` | `0x014A` | 0x81 inferred (ESS 50 °C) |
| charge high temperature, level 2 | `charge.otp` | data 1 | `0x0098` | `0x014B` | ESS 55 °C |
| charge high temperature recovery | `charge.otpr` | none | none | `0x014C` | inferred (ESS 50 °C); `0x014D` = delay |
| charge low temperature, level 1 | `daly.charge_ut_alarm` | data 2 | `0x0099` | `0x014E` | ESS 5 °C |
| charge low temperature, level 2 | `charge.utp` | data 3 | `0x009A` | `0x014F` | ESS 0 °C |
| charge low temperature recovery | `charge.utpr` | none | none | `0x0150` | inferred (ESS 5 °C); `0x0151` = delay |
| discharge high temperature, level 1 | `daly.discharge_ot_alarm` | data 4 | `0x009B` | `0x0152` | ESS 50 °C |
| discharge high temperature, level 2 | `discharge.otp` | data 5 | `0x009C` | `0x0153` | ESS 55 °C |
| discharge high temperature recovery | `discharge.otpr` | none | none | `0x0154` | inferred; `0x0155` = delay |
| discharge low temperature, level 1 | `daly.discharge_ut_alarm` | data 6 | `0x009D` | `0x0156` | ESS -15 °C |
| discharge low temperature, level 2 | `discharge.utp` | data 7 | `0x009E` | `0x0157` | ESS 0 °C (not below level 1: the 0x81 mapping is **unverified**) |
| temperature difference, level 1 | `temp.diff_alarm` | `0x5E` data 4 / `0x1E` | `0x00A1` | `0x015E` | plain °C, no offset; 0x81 inferred (ESS 10) |
| temperature difference, level 2 | `daly.temp_diff_protection` | `0x5E` data 5 / `0x1E` | `0x00A2` | `0x015F` | plain °C; ESS 15 |
| MOSFET over-temperature | `mos.otp` | none | `0x00A8` | `0x0167` | `+40`; D2 confirmed; 0x81 inferred (`0x0166` 95 °C, `0x0167` 100 °C, `0x0168` 65 °C recovery) |

### 7.5 Balancing

| Setting | id | Classic | D2 | 0x81 | Encoding | Status |
|---|---|---|---|---|---|---|
| balancing start voltage | `balance.start_voltage` | `0x5F` data 0–1 / `0x1F` | `0x00A3` | unknown (`0x011A` = 3400 in the ESS capture) | u16be mV | classic and D2 confirmed |
| balancing start difference | `balance.trigger_delta` | `0x5F` data 2–3 / `0x1F` | `0x00A4` | unknown (`0x011B` = 20) | u16be mV | confirmed; PC software minimum 50 mV (forum) |
| balancer switch | `switch.balance` | none | `0x00CF` (active balancers) | `0x00CF` | 0 / 1 (0x81 reads `0xFFFF` as on) | snoop, syssi |

### 7.6 Capacity and SOC

| Setting | id | Classic | D2 | 0x81 | Encoding | Status |
|---|---|---|---|---|---|---|
| rated capacity | `capacity.nominal` | `0x50` data 0–3 / `0x10` | `0x0080` | `0x0109`–`0x010A` | classic u32be mAh; D2 u16be 0.1 Ah; 0x81 u32be mAh | classic, D2 confirmed; 0x81 inferred (ESS 314000 mAh, repeated at `0x010B`–`0x010C`) |
| set SOC | `soc.value` | `0x21` (data 6–7, SOC x 10, data 0–5 = clock) | `0x00A7` (SOC x 10) | `0x0116` (SOC x 10) | | classic: four implementations; D2: syssi; 0x81: patagonaa |
| SOC high, level 1 / 2 | `daly.soc_high_alarm`, `daly.soc_high_protection` | `0x5D` data 0–1, 2–3 / `0x1D` | none | unknown | u16be 0.1 % | classic confirmed (forum) |
| SOC low, level 1 / 2 | `soc.low_alarm`, `daly.soc_low_protection` | `0x5D` data 4–5, 6–7 / `0x1D` | none | unknown (`0x0162`..`0x0164` = 0, 0, 20 in ESS) | u16be 0.1 % | classic confirmed |
| cumulative charge / discharge | `daly.cumulative_charge`, `daly.cumulative_discharge` | `0x52` / `0x12` | none | `0x010D`..`0x0110` (u32be, ESS discharge counter grows while discharging) | u32be | unit **unverified**; keep read-only |
| state of health | `daly.soh` | none | none | `0x0117` (SOH x 10) | u16be | Sundaya; ESS 100.0 % |

### 7.7 System, chemistry, communication

| Setting | id | Classic | D2 | 0x81 | Encoding | Status |
|---|---|---|---|---|---|---|
| number of acquisition boards | `daly.board_count` | `0x51` data 0 / `0x11` | `0x0082` | `0x0102` (inferred) | u8 / u16be | confirmed classic, D2; changing it breaks measurements: read-only |
| cells per board 1–3 | `system.cell_count` (sum) | `0x51` data 1–3 / `0x11` | `0x0083`–`0x0085` | `0x0103`–`0x0105` (inferred) | u8 / u16be | read-only recommended |
| NTC sensors per board 1–3 | `system.temp_sensor_count` (sum) | `0x51` data 4–6 / `0x11` | `0x0086`–`0x0088` | `0x0106`–`0x0108` (inferred) | u8 / u16be | read-only recommended |
| battery type | `system.battery_type` | `0x53` data 1 / `0x13` | `0x0089` | unknown (`0x0118` = 3 in ESS) | D2: 0 LiFePO4, 1 ternary, 2 LTO; classic raw (section 6.2) | D2 confirmed (vendor list); classic enumeration **unverified** |
| battery operation mode | `daly.operation_mode` | `0x53` data 0 / `0x13` | none | unknown | raw | **unverified** |
| sleep delay | `system.sleep_delay` | `0x53` data 5–6 / `0x13` (seconds, `0xFFFF` = never) | `0x008A` (seconds) | `0x0115` (units of 10 s, 65535 = off) | | classic: smefa captures; D2: vendor list; 0x81: patagonaa |
| production date | `daly.production_date` | `0x53` data 2–4 / `0x13` | `0x00CC`–`0x00CD` (read) | `0x0129`–`0x012A` (read, inferred) | `YY MM DD` | keep read-only |
| board number (bus address) | `system.address` | not in the protocol (PC software; a forum user needed a special firmware) | none | `0x0100` | u16be | patagonaa; changing it changes the Modbus address |
| parameter password | `identity.password` | none | `0x00C9`–`0x00CB` (6 ASCII) | `0x0126`–`0x0128` (observed) | ASCII | D2 confirmed |
| battery code | `daly.battery_code` | `0x57` / `0x17` (5 frames) | none | `0x019B`–`0x01AA` (read) | ASCII | classic write captured once (forum) |
| firmware index number | `daly.firmware_index` | `0x54` / `0x14` | none | none | 8 ASCII | read-only (the PC software rewrites the read value) |
| clock | `daly.rtc` | `0x61` / `0x21` (together with SOC) | `0x00D4`–`0x00D6` (write, snoop) | `0x0061`–`0x0063` (read, observed) | `YY MM DD hh mm ss` | |
| force heater, force fan | `switch.heater`, `daly.force_fan` | none | none | `0x01F7`, `0x01F8` | 0 / 1 | patagonaa |

### 7.8 Dependencies and limits

* Level 2 should be beyond level 1 (higher for "high", lower for "low"). The temperature and SOC examples follow this;
  two captured cell voltage groups do not (section 6.2), so the BMS does not seem to enforce it. Validate in the UI and
  ask for confirmation instead of blocking.
* Pack voltage limits are independent registers; the PC software does not derive them from cell limits. Check
  `pack limit ≈ cell limit x cell count` in the UI.
* Recovery values (0x81 map) lie between the trigger value and the normal range (ESS: cell high 3550, recovery 3400).
* Ranges used by implementations (UI limits, not device limits): syssi `NUMBERS` (rated capacity 0–6553.5 Ah, battery
  type 0–2, temperatures -40–100 °C, currents -3000–3553.5 A, raw 0–65535 for mV values); smefa (cell 1500–4500 mV, pack
  5–100 V, sleep at least 10 s); forum (balancing difference at least 0.050 V in the PC software).
* Defaults: board number 1 (patagonaa, batmon-ha); sleep after 1 hour (patagonaa README); password `123456` (all
  captures). Other factory defaults are not documented.
* Write safety: read the group or register first, write, then read back and compare. On classic, write the whole
  group and copy undefined bytes back unchanged (that is what the PC software does). Never write `0x10`/`0x11` or the
  0x81 board registers unless the user explicitly wants to reconfigure the hardware.

---

## 8. Controls and actions

| Action | Classic (host `0x40`; for `0x80` add 0x40 to the checksum) | D2 | 0x81 (board 1) | Verify with |
|---|---|---|---|---|
| charge MOSFET on | `A5 40 DA 08 01 00 00 00 00 00 00 00 C8` | `D2 06 00 A5 00 01 4B 8A` | `81 06 01 21 00 01 06 3C` | classic `0x93` data 1; D2 `0x0035`; 0x81 `0x0052` |
| charge MOSFET off | `A5 40 DA 08 00 00 00 00 00 00 00 00 C7` | `D2 06 00 A5 00 00 8A 4A` | `81 06 01 21 00 00 C7 FC` | same |
| discharge MOSFET on | `A5 40 D9 08 01 00 00 00 00 00 00 00 C7` | `D2 06 00 A6 00 01 BB 8A` | `81 06 01 22 00 01 F6 3C` | classic `0x93` data 2; D2 `0x0036`; 0x81 `0x0053` |
| discharge MOSFET off | `A5 40 D9 08 00 00 00 00 00 00 00 00 C6` | `D2 06 00 A6 00 00 7A 4A` | `81 06 01 22 00 00 37 FC` | same |
| set SOC (100.0 %) | `A5 40 21 08 YY MM DD hh mm ss 03 E8 <sum>` | `D2 06 00 A7 03 E8 2B 34` | `81 06 01 16 03 E8 76 8C` | classic `0x90` data 6–7 |
| balancer on / off | none | `D2 06 00 CF 00 01 6B 96` / `D2 06 00 CF 00 00 AA 56` | `81 06 00 CF ..` (**unverified**) | read `0x00CF` |
| reset | `A5 40 00 08 00 00 00 00 00 00 00 00 ED` | `D2 06 00 F3 00 01 AB 9A` | unknown | reconnect |
| restart | none known | `D2 06 00 F0 00 01 5B 9A` | unknown | reconnect |
| shutdown | none known | `D2 06 00 F1 00 01 0A 5A` | unknown | the BMS stops answering |
| zero current (calibrate offset) | none known | `D2 06 00 F2 00 01 FA 5A` | unknown | `0x0029` reads 30000 at rest |
| force heater / fan | none | none | `81 06 01 F7 00 01 E7 C4` / `81 06 01 F8 00 01 D7 C7` | `0x0055` / `0x0056` |
| set clock | `0x21` (with SOC) | `D2 10 00 D4 00 03 YY MM DD hh mm ss <crc>` | unknown | classic `0x61` |

Classic MOSFET frames for board 2 replace `40` by `41` and add 1 to the checksum (forum page 2:
`A5 41 DA 08 01 .. C9`, `A5 41 D9 08 00 .. C7`). Over BLE with host address `0x80`: `A5 80 DA 08 01 .. 08`,
`A5 80 DA 08 00 .. 07`, `A5 80 D9 08 01 .. 07`, `A5 80 D9 08 00 .. 06`.

Notes:

* Read the state back after a MOSFET command: dbus-serialbattery checks that reply data 0 equals the requested state,
  batmon-ha re-reads `0x93`. Whether an active protection keeps a MOSFET off despite an "on" command is **unverified**.
* `0x00F0..0x00F3` and classic `0x00` change the device state immediately. Ask the user for confirmation.
* dbus-serialbattery writes SOC 100 % when the charger enters float, because Daly only resets the SOC at a cell
  overvoltage event (patagonaa README, "Advanced usage").

---

## 9. Code tables

### 9.1 DALY_CLASSIC failure status (0x98)

Bit `n` of data byte `b` (bit 0 = least significant). Sources: maland16 `getFailureCodes()` (names), matthewgream
`FAILURE_DESCRIPTIONS` (same order, adds byte 6 bit 4), python-daly-bms `error_codes.py` (taken from "Part 4_ Daly
RS485+UART Protocol.pdf"), and the vendor Modbus list for the D2 fault registers (same bit meanings, section 9.2).

| Byte | Bit | Meaning | Level | Suggested alarm id |
|---|---|---|---|---|
| 0 | 0 | cell voltage high | 1 | `cell_overvoltage` (warning) |
| 0 | 1 | cell voltage high | 2 | `cell_overvoltage` |
| 0 | 2 | cell voltage low | 1 | `cell_undervoltage` (warning) |
| 0 | 3 | cell voltage low | 2 | `cell_undervoltage` |
| 0 | 4 | pack (sum) voltage high | 1 | `pack_overvoltage` (warning) |
| 0 | 5 | pack voltage high | 2 | `pack_overvoltage` |
| 0 | 6 | pack voltage low | 1 | `pack_undervoltage` (warning) |
| 0 | 7 | pack voltage low | 2 | `pack_undervoltage` |
| 1 | 0 | charge temperature high | 1 | `charge_overtemperature` (warning) |
| 1 | 1 | charge temperature high | 2 | `charge_overtemperature` |
| 1 | 2 | charge temperature low | 1 | `charge_undertemperature` (warning) |
| 1 | 3 | charge temperature low | 2 | `charge_undertemperature` |
| 1 | 4 | discharge temperature high | 1 | `discharge_overtemperature` (warning) |
| 1 | 5 | discharge temperature high | 2 | `discharge_overtemperature` |
| 1 | 6 | discharge temperature low | 1 | `discharge_undertemperature` (warning) |
| 1 | 7 | discharge temperature low | 2 | `discharge_undertemperature` |
| 2 | 0 | charge overcurrent | 1 | `charge_overcurrent` (warning) |
| 2 | 1 | charge overcurrent | 2 | `charge_overcurrent` |
| 2 | 2 | discharge overcurrent | 1 | `discharge_overcurrent` (warning) |
| 2 | 3 | discharge overcurrent | 2 | `discharge_overcurrent` |
| 2 | 4 | SOC high | 1 | `daly.soc_high` |
| 2 | 5 | SOC high | 2 | `daly.soc_high` |
| 2 | 6 | SOC low | 1 | `soc_low` |
| 2 | 7 | SOC low | 2 | `soc_low` |
| 3 | 0 | cell voltage difference | 1 | `cell_voltage_difference` |
| 3 | 1 | cell voltage difference | 2 | `cell_voltage_difference` (protection) |
| 3 | 2 | temperature difference | 1 | `temperature_difference` |
| 3 | 3 | temperature difference | 2 | `temperature_difference` (protection) |
| 3 | 4–7 | reserved | | |
| 4 | 0 | charge MOSFET over-temperature | | `mos_overtemperature` |
| 4 | 1 | discharge MOSFET over-temperature | | `mos_overtemperature` |
| 4 | 2 | charge MOSFET temperature sensor failure | | `temperature_sensor_fault` |
| 4 | 3 | discharge MOSFET temperature sensor failure | | `temperature_sensor_fault` |
| 4 | 4 | charge MOSFET adhesion (welded) failure | | `charge_mos_fault` |
| 4 | 5 | discharge MOSFET adhesion failure | | `discharge_mos_fault` |
| 4 | 6 | charge MOSFET breaker (open circuit) failure | | `charge_mos_fault` |
| 4 | 7 | discharge MOSFET breaker failure | | `discharge_mos_fault` |
| 5 | 0 | AFE acquisition chip failure | | `afe_fault` |
| 5 | 1 | cell voltage acquisition offline | | `cell_wire_open` |
| 5 | 2 | cell temperature sensor failure | | `temperature_sensor_fault` |
| 5 | 3 | EEPROM failure | | `eeprom_fault` |
| 5 | 4 | RTC failure | | `rtc_fault` |
| 5 | 5 | precharge failure | | `precharge_fault` |
| 5 | 6 | vehicle (external) communication failure | | `daly.external_comm_fault` |
| 5 | 7 | internal communication module failure | | `communication_fault` |
| 6 | 0 | current module failure | | `current_sensor_fault` |
| 6 | 1 | total voltage detection module failure | | `voltage_sensor_fault` |
| 6 | 2 | short circuit protection failure | | `short_circuit` |
| 6 | 3 | low voltage, charging forbidden | | `daly.low_voltage_no_charge` |
| 6 | 4 | GPS or soft switch turned the MOSFETs off | | `daly.soft_switch_off` (matthewgream, vendor Modbus list) |
| 6 | 5 | charging cabinet offline | | `daly.cabinet_offline` (vendor Modbus list only) |
| 6 | 6–7 | reserved | | |
| 7 | all | fault code (numeric) | | CAN v1.0 notes; matthewgream treats value `0x03` as "show" (**unverified**) |

Disagreements: maland16 reads all byte 1 flags from bit 1 (`bitRead(..., 1)` for every field, an implementation bug).
dbus-serialbattery groups byte 0 differently (`& 15` = high voltage pre-alarm, `& 48` = high voltage alarm, bit 6 / 7 =
low voltage pre-alarm / alarm), which mixes cell and pack bits; the table above follows the vendor order.

### 9.2 Modbus D2 fault status (0x003A–0x003D)

Each register holds two of the classic bytes. "Byte 0" of the vendor list is the **low** byte of the register (the
second byte on the wire), "Byte 1" the high byte (syssi `ERRORS` table and test frames; the same convention is
validated for the 0x81 map in section 9.3).

| Register | High byte (first on the wire) | Low byte (second on the wire) |
|---|---|---|
| `0x003A` | classic byte 1: temperatures | classic byte 0: cell and pack voltage |
| `0x003B` | classic byte 3: differences | classic byte 2: current and SOC |
| `0x003C` | classic byte 5: AFE, sensors, EEPROM, RTC, precharge, communication | classic byte 4: MOSFET temperature and faults |
| `0x003D` | not described (classic byte 7 position) | classic byte 6: current module, voltage detection, short circuit, low voltage no charge, soft switch, cabinet |

So the 8 wire bytes are classic bytes `1 0 3 2 5 4 7 6`. Read as one `u64be` (aiobmsble `problem_code`, syssi
`error_bitmask`), bit `i` corresponds to classic byte `b`, bit `n` with `i = 8 x p + n`, where `p` is the position from
the least significant end: classic byte 6 -> `p = 0`, 7 -> 1, 4 -> 2, 5 -> 3, 2 -> 4, 3 -> 5, 0 -> 6, 1 -> 7. Example
(syssi test): wire bytes `00 01 00 00 00 00 00 00` (low byte of `0x003A`, bit 0) = level 1 cell voltage high.

The first vendor file translates register `0x003B` byte 0 bits 2–3 as "discharging current too low"; the second file
says "discharge overcurrent". The second is used.

### 9.3 Modbus 0x81 alarm codes (0x006D–0x0073)

Source: patagonaa `DalyHkmsStatus` (bit fields over the 14 bytes after converting each register to little endian, so
code `2k` = low byte of register `0x006D + k`, code `2k+1` = high byte). Level fields are 3 bit numbers: 0 = no alarm,
1 = level 1, 2 = level 2 (patagonaa treats `> 0` as warning and `> 1` as error). Evidence for the byte order: the
aiobmsble 4S capture has `0x0070` = `0x0002` (code 6 = SOC low level 2 at 11.2 % SOC) and `0x0072` = `0x8000` (code 11
bit 7 = temperature detection error, with both probes reading `0x00FF`).

| Code | Register, byte | Bits 0–2 | Bits 3–5 | Bit 6 | Bit 7 |
|---|---|---|---|---|---|
| 0 | `0x006D` low | cell overvoltage level | cell undervoltage level | smart charger connected | smart charger connection error |
| 1 | `0x006D` high | cell voltage difference level | charge over-temperature level | smart discharger connected | smart discharger connection error |
| 2 | `0x006E` low | charge under-temperature level | discharge over-temperature level | charge MOSFET temperature high | charge MOSFET temperature detection fault |
| 3 | `0x006E` high | discharge under-temperature level | temperature difference level | discharge MOSFET temperature high | discharge MOSFET temperature detection fault |
| 4 | `0x006F` low | total overvoltage level | total undervoltage level | short circuit | upgrade flag |
| 5 | `0x006F` high | charge overcurrent level | discharge overcurrent level | charge undervoltage error | discharge overvoltage error |
| 6 | `0x0070` low | SOC low level | SOH low level | parallel communication | parallel communication error |
| 7 | `0x0070` high | MOSFET over-temperature level | thermal runaway level | unused | unused |
| 8, 9 | `0x0071` | unused | | | |
| 10 | `0x0072` low | unused | | | |
| 11 | `0x0072` high | bit 0 AFE chip error, bit 1 AFE communication error, bit 2 AFE sampling error, bit 3 voltage detection error, bit 4 voltage detection disconnected, bit 5 total voltage detection error, bit 6 current detection error, bit 7 temperature detection error | | | |
| 12 | `0x0073` low | bit 0 temperature sensor disconnected, bit 1 EEPROM error, bit 2 flash error, bit 3 RTC error, bit 4 charge MOSFET error, bit 5 discharge MOSFET error, bit 6 precharge MOSFET error, bit 7 precharge error | | | |
| 13 | `0x0073` high | bit 0 charge MOSFET off by bus, bit 1 discharge MOSFET off by bus, bit 2 charge MOSFET off by switch, bit 3 discharge MOSFET off by switch, bit 4 fan active, bit 5 heater active, bit 6 current limit active, bit 7 heater error | | | |

The ESS capture shows `0x0070` = `0x0080` (code 6 bit 7, parallel communication error) on a single pack: meaning in that
context **unverified**. Registers `0x0066..0x0069` ("type 1" faults) are not decoded by any source.

### 9.4 Enumerations and bit fields

| Field | Values | Sources |
|---|---|---|
| classic `0x93` data 0, D2 `0x002F`, 0x81 `0x0048` | 0 stationary (idle), 1 charging, 2 discharging | all |
| classic `0x93` data 1 / 2, D2 `0x0035` / `0x0036`, 0x81 `0x0052` / `0x0053` | 0 off, 1 on | all |
| classic `0x94` data 2 / 3 | charger / load: 0 disconnected, 1 connected | CAN v1.0 notes, maland16 |
| classic `0x94` data 4 | bit 0–3 DI1–DI4, bit 4–7 DO1–DO4 | CAN v1.0 notes, python-daly-bms, acpiccolo |
| D2 `0x0034` | balancing: 0 off, 1 on | vendor list |
| 0x81 `0x004D` | balancing: 0 off, 1 passive, 2 active (other values seen: 7) | syssi, ril3y |
| D2 `0x0089` | battery type: 0 LiFePO4, 1 ternary, 2 lithium titanate | vendor list |
| D2 `0x0057` (GPS valid flag), D2 `0x005F`/`0x0061` (acquisition normal flag) | `0xA5` = valid | vendor list |

---

## 10. Device information

### 10.1 DALY_CLASSIC

| Item | Command | Format | Examples |
|---|---|---|---|
| software version | `0x62` (2 frames) | 14 ASCII | `20210222-1.01T` (forum post 1), `12_250520_BRST` (acpiccolo) |
| hardware version | `0x63` (2 frames) | 14 ASCII | `DL-BMS-R32-01E` (forum post 1), `H2.1_103E_30XF` (acpiccolo) |
| firmware index number | `0x54` | 8 ASCII | `20200306` (forum post 1) |
| battery code | `0x57` (5 frames) | 35 ASCII, padded | `20200306` + spaces (forum post 1) |
| production date | `0x53` data 2–4 | `YY MM DD` | 2021-03-06 (forum), 2023-06-19 (smefa) |
| rated capacity, nominal cell voltage | `0x50` | section 6.2 | 40 Ah, 3.7 V |
| boards, cells, NTCs | `0x51` | section 6.2 | 1 board, 14 cells, 1 NTC |
| clock | `0x61` | `YY MM DD hh mm ss` | 2026-07-29 19:32:24 (acpiccolo) |

dbus-serialbattery builds its identifier from the battery code (spaces collapsed) or, when empty, from the production
date and capacity (`unique_identifier()`).

### 10.2 Modbus D2

| Registers | Bytes in the `0x00A9` read | Format | Meaning | Examples |
|---|---|---|---|---|
| `0x00A9`–`0x00B0` | 0–15 | ASCII, NUL padded | software version | `T00K_321042_11` (aiobmsble), `401012` and `204012` (syssi), `B002_111132_03` (balancer) |
| `0x00B1`–`0x00B8` | 16–31 | ASCII | hardware version | `H2.0_103R_309F9F` (aiobmsble), `E303-032DG-SMB` (balancer), empty in the syssi frames |
| `0x00B9`–`0x00C8` | 32–63 | ASCII | machine code | `20240229` (aiobmsble), `BMS` and `SH39F003` (syssi frames) |
| `0x00C9`–`0x00CB` | separate read | 6 ASCII | parameter password | `123456` |
| `0x00CC`–`0x00CD` | separate read | `YY MM DD 00` | production date | `00 01 01 00` (balancer, not set) |

Field split from the vendor list and aiobmsble `_fetch_device_info()` (`[3:19]`, `[19:35]`). syssi splits 32 + 32 bytes
and therefore shows the machine code as "hardware version" (`BMS`, `SH39F003`); the roccotsi2 simulation describes
16 + 16 + 32 bytes ("App Version", "MCU Version", "Machine Version").

### 10.3 Modbus 0x81 map

Version block `0x0178`–`0x01C1` (74 registers), made of 14 byte ASCII fields:

| Registers | Bytes | ESS-DL-BMS capture | aiobmsble capture | Meaning |
|---|---|---|---|---|
| `0x0178`–`0x017E` | 0–13 | `41_260321_0323` | `12_260120_K00T` | software version |
| `0x017F`–`0x0185` | 14–27 | `ESS-DL-BMS` | `H2.1_103E_30XF` | hardware version or product name |
| `0x0186`–`0x018C` | 28–41 | `ESS41_0323` | `DL_HKMS_3.2.E` | model |
| `0x018D`–`0x0193` | 42–55 | `210LC210900005` | `221LD011111111` | serial number |
| `0x0194`–`0x019A` | 56–69 | zeros, ends with 4 spaces | zeros | unknown |
| `0x019B`–`0x01A1` | 70–83 | `20260326` | `20260530` | Sundaya: start of the 32 byte battery code (`0x019B`, 16 registers); on both packs a date |
| `0x01A2`–`0x01C1` | 84–147 | zeros, then `FF` | zeros | unknown |

Field names other than the battery code are **unverified**: aiobmsble reports bytes 0–27 as `sw_version`, 28–41 as
`hw_version` and 42–55 as `serial_number`; syssi reports bytes 0–27 as software and 28–41 as hardware version. The 14
byte fields have no separator when full, so read them by position, not up to the first NUL.

---

## 11. Detection

### 11.1 Candidates

* BLE names starting with `DL-` or `JHB-` (aiobmsble matcher `DL-*`; batmon-ha issue #356 `JHB-`), or manufacturer data
  whose payload ends with ASCII `DL` or `JHB` after a 6 byte MAC (section 2.1.1). Renamed devices only match by
  manufacturer data or by a manual choice.
* Service `0000fff0-...` or `0000ff00-...` after connecting. Both UUIDs are also used by other families (JBD BMS uses
  `ff00`/`ff01`/`ff02`, syssi/esphome-jbd-bms `jbd_bms_ble/__init__.py` defaults), so the protocol must be confirmed
  by a probe.
* Serial ports: any USB UART or RS485 adapter at 9600 8N1.

### 11.2 Probe sequence (read only)

Send one probe, wait for a valid frame (BLE 1.5 s, serial 0.5 s), go to the next probe if none arrives. Repeat the
first probe once, because some modules drop the first request after connecting (batmon-ha).

| Step | Send | Accept when | Result |
|---|---|---|---|
| 1 | `D2 03 00 00 00 3E D7 B9` | a reassembled frame starts `D2 03 7C`, is 129 bytes long and the CRC is valid | Modbus D2 (aiobmsble tries this first) |
| 2 | `81 03 00 00 00 40 5B FA` | frame starts `51 03 80`, 133 bytes, CRC valid | Modbus 0x81 map, board 1 |
| 3 | `A5 80 90 08 00 00 00 00 00 00 00 00 BD` (BLE) or `A5 40 90 08 00 00 00 00 00 00 00 00 7D` (serial) | 13 byte frame `A5 <0x01..0x10> 90 08 ..` with valid checksum | classic, host address as sent |
| 4 | the other host address with `0x94` (`A5 40 94 08 .. 81` or `A5 80 94 08 .. C1`) | `A5 <board> 94 08 ..`, valid checksum | classic, host address as sent (batmon-ha handshake) |

Plausibility checks after a match: cell count 1–32 (D2) or 1–48 (0x81, classic), cell voltages 1000–5000 mV for the
counted cells, SOC raw 0–1000. On RS485, scan boards 1–16 with classic addresses `0x40`..`0x4F` and Modbus addresses
`0x81`.. as needed.

A Modbus probe sent to a classic-only module is ignored (batmon-ha `daly2.py` message for issue #416), and the official
app itself sends a classic frame to Modbus devices (snoop record 66), so the order above is safe.

If none of the probes is answered, the board may be a Sinowealth based "Daly" that only speaks the BMStool protocol
(python-daly-bms README "Compatibility"), or it may be asleep (section 2.1.4, 2.2).

---

## 12. Pitfalls and quirks

### 12.1 Source disagreements and resolution

1. **Current sign.** Classic: `raw < 30000` = charging (python-daly-bms and batmon-ha comments, dbus-serialbattery
   default, vendor Modbus text, PC software encoding of charge limits); maland16 comments the opposite. Modbus D2 and
   0x81: captures show positive = charging (D2 forum frames: `0x7571` with state 1 = charging, power 84 W; syssi 80
   register frame: -3.1 A with state 2; ESS 0x81 frame: -8.9 A with state 2), which contradicts the vendor text
   (charging current negative). Resolution: decode `(raw - 30000) x 0.1`, compare with the state field
   when `|I| > 0.5 A`, and offer a per-device inversion option (dbus-serialbattery `INVERT_CURRENT_MEASUREMENT`).
2. **D2 version block split.** 16/16/32 (vendor list, aiobmsble, roccotsi2) against 32/32 (syssi). 16/16/32 is used.
3. **Classic `0x53` sleep field.** `u16be` seconds at data 5–6 (smefa; two writes confirmed the byte order) against one
   byte of minutes at data 5 (acpiccolo) or byte 5 x 60 s (matthewgream). smefa is used.
4. **Classic `0x97` bit order.** Byte 0 bit 0 = cell 1 (maland16, matthewgream, CAN notes) against other orders
   (python-daly-bms, dbus-serialbattery). The first is used, **unverified**.
5. **Classic `0x98` grouping.** dbus-serialbattery mixes cell and pack bits of byte 0; maland16 reads byte 1 from the
   wrong bit. The vendor order (section 9.1) is used.
6. **Classic `0x5E` temperature differences.** matthewgream subtracts 40; captured values and the Modbus registers say
   plain °C. Plain °C is used.
7. **Classic `0x50` nominal voltage.** u16 at data 6–7 (forum) against u32 at data 4–7 (dbus-serialbattery, acpiccolo,
   matthewgream). Identical while data 4–5 are 0.
8. **Classic `0x51` byte 0.** "number of acquisition boards" (forum, matthewgream, Modbus `0x0082`) against "board
   number" (acpiccolo). The first is used.
9. **0x81 settings location.** syssi's "+0x80" table against the ESS capture and patagonaa. The capture is used.
10. **0x81 `0x003B`.** SOH (patagonaa header, unused) against a counter (syssi; value changes every poll). Treated as
    counter.
11. **0x81 power `0x0058`.** Watts (patagonaa; ESS 471 W = 53.0 V x 8.9 A) against 0.1 W (Sundaya). Watts are used.
12. **Classic frame numbers.** 1 based in every UART/BLE capture; 0 based in the CAN v1.0 notes.
13. **Host address on UART.** python-daly-bms documents host nibble 4 for RS485 and 8 for UART/Bluetooth; maland16,
    acpiccolo, smefa and the PC software use `0x40` on UART; esphome defaults to `0x80` on UART. Both are answered on the UART port in the
    sources; RS485 board addressing needs `0x40 + board - 1`.
14. **D2 `0x003E..0x0043`.** Vendor list: mileage and reserved; newer firmware: balance current and MOSFET
    temperature (captures show `0x7530` and a plausible temperature). Read them only from 80 register frames or the
    9 register block, and treat `0x0000`/`0xFFFF` as not available.
15. **acpiccolo `docs/unimplemented_commands.md`** lists `0x10`..`0x26` and `0x2F` with meanings that contradict the
    PC software captures (for example `0x10`/`0x20` as cell overvoltage read/write, `0x2F` as set nominal capacity,
    `0x99` as a parameter overview, while the captures show that `0x20` writes the short circuit group and `0x21` sets
    the SOC). It cites code that does not contain these commands and marks them as not tested. Not used.
16. **SOC write layout.** dbus-serialbattery and batmon-ha send `YY MM DD hh mm ss SOCx10`; python-daly-bms sends zeros
    for the clock; Daly2MQTT copies data 1–5 of a `0x61` reply into data 1–5 and leaves data 0 unset. The
    dbus-serialbattery layout is used with the current local time.

### 12.2 Other quirks

* **Stale bytes.** Undefined reply bytes repeat old data (section 3.1). Never derive values or validity from them.
* **Echoed request fill.** The R24TK copies request byte 8 into the `0x94` DI/DO byte (batmon-ha #429). Send zero fill
  by default; when `0xAA` fill is used for reliability, ignore `0x94` data 4.
* **Variable frame counts.** `0x95` returns 16 frames with host `0x80` and `ceil(cells / 3)` frames with `0x40`; `0x96`
  returned two frames for one sensor. Collect frames until the expected cells are filled and the line is quiet; key
  them by frame number and ignore extra frames.
* **Occasional corrupted cell frames** on current firmware (dbus-serialbattery). Reject a `0x95` set with missing or
  duplicate frame numbers and keep the previous values.
* **Unsigned decoding.** Counts, cycle counters, cell voltages and temperature bytes are unsigned (batmon-ha #429 fix).
* **Bad CRC on a write echo** happens (snoop record 249); repeat the write after verifying the state.
* **Replies without register address.** Keep a FIFO of outstanding Modbus requests; when several replies arrive in one
  notification, consume them in order and check each byte count.
* **Non-standard write multiple** (no byte count, section 3.2).
* **AT text** from the BLE module on `fff1` (section 2.1.2).
* **Sleep.** BLE module after 1 hour without activity; BMS after its sleep time; RS485 cannot wake it (sections 2.1.4,
  2.2). Show "asleep or out of range" instead of a protocol error after repeated timeouts.
* **Shared UART.** Frames of the Daly dongle appear on the line; filter by address and command.
* **Board 2 and higher** answer with their board number in byte 1 (classic) or `0x50 + board` (Modbus).
* **Not available markers.** Temperatures `0x00FF` (0x81), `0x0000`/`0xFFFF` (D2 MOSFET temperature), `0` for unused
  cells; clamp counts (D2 32 cells, 0x81 48 cells, 8 temperatures).
* **Noisy current.** dbus-serialbattery smooths the classic current (`0.1 x new + 0.9 x old`) because it flickers;
  the driver should report raw values and leave smoothing to the UI.
* **SOC drift.** The SOC is only reset to 100 % by a cell overvoltage event (patagonaa); tools rewrite it at float.
* **Cloud mode** disables BLE on combined WiFi/BT modules (syssi).
* **MOSFET bits may lag** the real switch state on some units (batmon-ha comment on `0x93`); verify with current flow.

---

## 13. References

All URLs were read on 2026-11-18; commit hashes pin the version used.

1. maland16/daly-bms-uart (Arduino): https://github.com/maland16/daly-bms-uart/blob/a663360/daly-bms-uart.cpp
   (`Init`, `sendCommand`, `validateChecksum`, `getPackMeasurements` .. `getFailureCodes`, `setDischargeMOS`,
   `setChargeMOS`, `setBmsReset`); `daly-bms-uart.h` (`COMMAND`, `get`, `alarm`);
   `example-sketch/daly-bms-example/example-output.txt` (request checksums).
2. dreadnought/python-daly-bms: https://github.com/dreadnought/python-daly-bms/blob/307ed22/dalybms/daly_bms.py
   (`_format_message`, `get_soc`, `get_mosfet_status`, `get_status`, `_calc_num_responses`, `get_cell_voltages`,
   `get_balancing_status`, `set_charge_mosfet`, `set_discharge_mosfet`, `set_soc`, `restart`);
   `dalybms/daly_bms_bluetooth.py` (`connect`, `_notification_callback`); `dalybms/error_codes.py`;
   `dalybms/daly_sinowealth.py`; `README.md` (Compatibility, Bluetooth notes).
3. esphome/esphome: https://github.com/esphome/esphome/blob/6a743ec/esphome/components/daly_bms/daly_bms.cpp
   (`loop`, `request_data_`, `decode_data_`), `__init__.py` (default address `0x80`, 9600 8N1); issue
   https://github.com/esphome/esphome/issues/12445 (board 2 capture, Kicosta dispatcher comment).
4. fl4p/batmon-ha: https://github.com/fl4p/batmon-ha/blob/f658002/bmslib/models/daly.py (`daly_reply_valid`,
   `daly_board_addr_byte`, `daly_command_message`, `daly_set_soc_payload`, `DalyBt.connect`, `_handshake`, `set_switch`,
   `fetch_states`); `bmslib/models/daly_uart.py` (`UART_FILL`, `feed_buffer`, `DalyUart`); `bmslib/models/daly2.py`
   (`SWITCH_REGISTERS`, `_notification_handler`, `_q`, `fetch`); `bmslib/test/data/daly_fixtures.py`,
   `daly_uart_fixtures.py`, `daly2_fixtures.py`, `SOURCES.md`; issues #356, #398, #416, #429
   (https://github.com/fl4p/batmon-ha/issues/429 and so on).
5. mr-manuel/venus-os_dbus-serialbattery:
   https://github.com/mr-manuel/venus-os_dbus-serialbattery/blob/358d3c7/dbus-serialbattery/bms/daly.py
   (`command_base`, `read_status_data`, `read_soc_data`, `read_alarm_data`, `read_cells_volts`, `read_balance_state`,
   `read_capacity`, `read_production_date`, `read_battery_code`, `write_soc_and_datetime`,
   `write_charge_discharge_mos`, `generate_command`, `request_data`, `read_sentence`); `dbus-serialbattery/config.default.ini`
   (`INVERT_CURRENT_MEASUREMENT`).
6. softwarecrash/Daly2MQTT: https://github.com/softwarecrash/Daly2MQTT/blob/bf0410b/src/daly.h (`COMMAND`,
   `DELAYTINME`, `BMS_RETRY_DELAY_MS`); `src/daly.cpp` (`requestData`, `setSOC`, `getVoltageThreshold`); `src/main.cpp`
   (`wakeupHandler`).
7. acpiccolo/Daly-BMS (Rust): https://github.com/acpiccolo/Daly-BMS/blob/46b53d4/src/protocol.rs (`Address`,
   `MINIMUM_DELAY`, `BMS_ADDRESS`, `is_reply_for`, `RatedCapacity`, `BatteryInfo`, `BatteryStat`, `BmsConfig`, `Rtc`,
   `SoftwareVersion`, `HardwareVersion`, `Status::mosfet_temperature`; tests `battery_stat_decodes_lifetime_ah`,
   `bms_config_decodes_board_cells_ntc`, `rtc_decodes_datetime`, `version_strings_decode_from_two_frames`,
   `is_reply_for_accepts_only_bms_reply_to_our_command`); `src/serialport.rs`; `docs/additional_commands.md`;
   `docs/unimplemented_commands.md` (not used, see 12.1 item 15).
8. matthewgream/DalyBMSInterface:
   https://github.com/matthewgream/DalyBMSInterface/blob/3e40856/src/DalyBMSRequestResponseTypes.hpp
   (`RequestResponse_*` classes, `FAILURE_DESCRIPTIONS`); `src/DalyBMSRequestResponse.hpp` (address constants,
   `getBit`); `README.md` (Hardware, Supported Request/Responses).
9. jblance/mpp-solar: https://github.com/jblance/mpp-solar/blob/fcf1c02/mppsolar/protocols/daly.py (`COMMANDS`,
   `test_responses`); `mppsolar/protocols/daly40.py`; `mppsolar/inout/dalyserialio.py`.
10. jblance powermon, Daly CAN protocol notes (transcription of "DALY CAN Communications Protocol V1.0"):
    https://jblance.github.io/powermon/protocol_docs/daly_can/
11. smefa/DalyBMS-to-MQTT: https://github.com/smefa/DalyBMS-to-MQTT/blob/f5e9a93/docs/daly-write-commands.md;
    `lib/daly/daly_protocol.h`.
12. DIY Solar Forum, "Decoding the DALY SmartBMS protocol":
    https://diysolarforum.com/threads/decoding-the-daly-smartbms-protocol.21898/ (post 1 by tanoshimini: "Read All"
    and "Set All" captures), `page-2` (KaFun: MOSFET frames, board 2; Marv085: GATT listing), `page-3` (gnif: command
    ranges from firmware disassembly; UART monitor of the Bluetooth module with D2 frames; D2 versus A5 note).
13. patman15/aiobmsble: https://github.com/patman15/aiobmsble/blob/5de275a/aiobmsble/bms/daly_bms.py (`Proto`,
    `_PROTOS`, `matcher_dict_list`, `uuid_services`, `uuid_rx`, `uuid_tx`, `_fetch_device_info`, `_init_connection`,
    `_notification_handler`, `_async_update`); `aiobmsble/basebms.py` (`_cmd_modbus`, `crc_modbus`, `TIMEOUT`,
    `MAX_RETRY`); `aiobmsble/test_data/daly_bms.json`;
    https://github.com/patman15/aiobmsble/blob/95a6421/tests/bms/test_daly_bms.py (`_PROTO_DEFS`, `_RESULT_DEFS`,
    `_DEV_DEFS`, `MOS_INFO`).
14. syssi/esphome-daly-bms: https://github.com/syssi/esphome-daly-bms/blob/35afc8f/components/daly_bms_ble/daly_bms_ble.cpp
    (`build_frame_`, `update`, `on_daly_bms_ble_data`, `decode_status_data_`, `decode_settings_data_`,
    `decode_version_data_`, `decode_password_data_`, `decode_p81_cells_data_`, `decode_p81_status_data_`,
    `decode_p81_version_data_`, `ERRORS`); `components/daly_bms_ble/__init__.py`, `number/__init__.py` (`NUMBERS`),
    `switch/__init__.py` (`SWITCHES`), `button/__init__.py` (`BUTTONS`); `README.md`; `docs/protocol-register-map.md`;
    `docs/dalyModbusProtocol.xlsx` and `docs/Modbus protocol.xlsx` (vendor register lists, English); `docs/pdus/`
    (`daly_bms_24cells.txt`, `daly_bms_blue_series_80_registers.txt`, `ess-dl-bms-41_260321_0323.txt`,
    `btsnoop_daly_balancer.log`, decoded for this document with a btsnoop parser); `tests/components/daly_bms_ble/`
    (`common.h`, `frames_p81_ess_dl_bms.h`, `daly_bms_ble_test.cpp`, `daly_bms_ble_p81_ess_dl_bms_test.cpp`).
15. syssi/esphome-jbd-bms: https://github.com/syssi/esphome-jbd-bms/blob/main/components/jbd_bms_ble/__init__.py (JBD
    defaults `0xFF00`/`0xFF01`/`0xFF02`).
16. patagonaa/esphome-daly-hkms-bms: https://github.com/patagonaa/esphome-daly-hkms-bms/blob/732d812/README.md;
    `components/daly_hkms_bms/daly_hkms_bms.cpp` (`DALY_MODBUS_REQUEST_ADDRESS_OFFSET`,
    `DALY_MODBUS_RESPONSE_ADDRESS_OFFSET`, `update`, `on_modbus_data`); `daly_hkms_bms.h` (`DalyHkmsStatus`);
    `daly_hkms_bms_registers.h`.
17. Sundaya-Development-Team/python-daly-16S:
    https://github.com/Sundaya-Development-Team/python-daly-16S/blob/b45f189/address.py (`BMS_UNITS`, register
    constants); `daly_modbus_rtu.py` (`parse_fc03_response`); `main.py` (timing constants); `README.md`.
18. ril3y/daly_bms (Dart, from a decompilation of the official app):
    https://github.com/ril3y/daly_bms/blob/93b9fcb/lib/src/gatt.dart; `lib/src/registers.dart`.
19. roccotsi2/esp32-smart-bms-simulation: https://github.com/roccotsi2/esp32-smart-bms-simulation/blob/f035f43/README.md
    (D2 run info, version info layout).

### Test vectors

`packages/bms-drivers/test/vectors/daly.json` follows the common vector format. Notes for this family:

* `variant` is `DALY_CLASSIC` or `DALY_MODBUS`; the Modbus flavour follows from the first byte (`D2`, `0x8n`
  request, `0x5n` response).
* `expected.current` is the raw decode `(raw - 30000) x 0.1` without any sign correction, so tests can check the
  decoder separately from the sign policy of section 12.1.
* Values that a source marks as not available are `null` (0x81 temperatures `0x00FF`, D2 MOSFET temperature `0xFFFF`).
* Write acknowledgements and multi-frame replies are single 13 byte frames; ids end with `-f<n>` for frame `n`.
* Vectors with `expectedComputed: true` were decoded for this document with the layouts above; all others carry the
  values stated by the source (test expectations, forum decodes, issue texts).

