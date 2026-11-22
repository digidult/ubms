# Daly active balancers: communication protocol

Implementation reference for the ubms Daly balancer driver: the Daly "Smart Active Balance Module" boards (1 A active balancers for 3 to 24 cells, sold as the UART/RS485 model and as the dual UART "software active balance module", [BAL1A], [SW11]), read and configured over the Daly Bluetooth dongle (BLE) or over the wired UART port at 9600 baud with the Modbus style "D2" protocol of the newer Daly BMS boards.

This document is a companion to [daly.md](daly.md). Framing, CRC, addressing and register addresses are the same as the D2 variant of the Daly BMS; they are summarised here and the differences are written out: which registers a balancer fills, what it leaves at fixed values, how a probe tells a balancer from a BMS, and which settings are safe to write.

Compiled 2026-11-19 from an HCI capture of the official Android app talking to a balancer (decoded for this document), the source code, tests and issues of the open source projects in section 13, two Daly manuals and one Daly specification. Every statement carries a source tag. **unverified** marks a value that has a single weak source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/dalybal.json` (68 entries: 31 requests, 23 balancer replies, 7 Daly BMS frames used as negative detection cases, 7 Bluetooth module text messages). Field names written in `code` are keys of the `expected` objects in that file, in model units (V, °C, s) unless the key ends in `Raw` (register value as read) or `Register` (a register value scaled, kept to compare with the value derived from the cells). Further keys: `balancerSignature` (section 11.3), `crcValid` (section 3.4), `writable` (requests: whether ubms may send the frame), `frames` and `frameCount` (several replies in one BLE notification), `isDalyFrame: false` (module text that the frame assembler must skip). `variant` is `DALY_BALANCER_D2` for balancer frames, `DALY_BMS_D2` for BMS frames from `daly.json`, `DALY_MODBUS_81` and `DALY_CLASSIC` for the app probes of section 4.1, `BLE_MODULE_TEXT` for AT text. Every entry of that file was checked with a node script (part of the research notes, not of the repository): length per function code, CRC-16/MODBUS or A5 checksum against the declared `crcValid`, the split of multi-frame notifications, and the presence of the exact bytes in the decoded capture or in the cached copy of the cited source (68 entries, 64 CRC or checksum checks, no failure).

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

- Registers are 16-bit, transmitted big-endian (u16 BE). Register addresses are hex (0x00A3). In a read reply that starts at register `s`, register `r` sits at frame offset `3 + 2 × (r − s)`; frame offsets are decimal.
- CRC = CRC-16/MODBUS (initial value 0xFFFF, reflected polynomial 0xA001, no final XOR) over every byte before the CRC, transmitted low byte first ([DALY] 3.2, [VL]).
- Scale: physical value = raw × scale. "30000 offset" means value = (raw − 30000) × scale. "+40" means °C = raw − 40.
- Status block = registers from 0x0000 (62 or 80), settings block = 41 registers from 0x0080, version block = 32 registers from 0x00A9, switch block = 5 registers from 0x00CC.
- "rec N" is the record number (1-based) in the HCI capture [SNOOP] as decoded by the research script; times are seconds from the first record.
- Source tags (details in section 13): [SNOOP] official app HCI capture of a Daly balancer in syssi/esphome-daly-bms, [SY] syssi/esphome-daly-bms (code, tests, issues), [SY25] its issue 25 (the balancer owner who supplied [SNOOP]), [CEPR] cepr/daly-to-lithium-balance-adapter (a compiled balancer protocol note with a hardware validation log, and firmware that polls four balancers), [AC97] acpiccolo/Daly-BMS issue 97 and pull request 98 (classic protocol timing of a 20S balancer), [MG] matthewgream/DalyBMSInterface (classic protocol, tested on a Daly BMS and a balancer), [D2M] softwarecrash/Daly2MQTT issue 140, [BBH42] patman15/BMS_BLE-HA issue 42 (15S balancer over BLE), [BM239] fl4p/batmon-ha issue 239, [AIO] patman15/aiobmsble Daly plugin, [PYD31] dreadnought/python-daly-bms issue 31, [IMG] app screenshot in [SY] issue 28, [BAL1A] Daly "Smart Active Balance Module (1A) Instruction", [SW11] Daly "Software active balance module V1.1 specification", [ABMS] Daly "Smart Active Balance BMS User Manual", [VL] Daly Modbus register lists (two xlsx files in [SY] docs), [DPAGE] Daly product page "Active Balance Module (1A/5A)", [FORUM] DIY Solar Forum thread 98570 (not readable, HTTP 403; used only as summarised by [CEPR]), [DALY] the ubms Daly BMS specification [daly.md](daly.md).

## 1. Overview

### 1.1 Devices

| Device | Facts | Sources |
| --- | --- | --- |
| UART/RS485 smart active balance module | 3–24 cells (the board must match the string count of the pack; [SW11] 2.1: different string counts use different PCBs), balance current up to 1 A, Li-ion and LiFePO4; ports "UART" (the Bluetooth dongle plugs in here) and "RS485"; balancing starts when a cell reaches the start voltage (default 3.3 V) and the cell difference reaches the start difference (default 20 mV); default sleep time 3600 s, 65535 cancels sleep; disabled for packs below 2 V, not to be used below 10 V total; green LED on while balancing | [BAL1A] |
| Dual UART smart active balance module ("software active balance module", PCB for example DL_ZDJH-R24_V1.1) | Li-ion and LiFePO4 4–24 cells, LTO 6–24 cells, pack at least 10 V; balance current settable 0–1 A (default 1 A, ±0.1 A); balance on voltage and balance off voltage 1.5–4.5 V (lower and upper limit of the working window); balance on difference default 20 mV, settable 0.01–1.5 V; low and high temperature protection default −40 °C and 85 °C; over-discharge protection settable (below it the module sleeps after 55 s and wakes after 3600 s); UART1 and UART2 (GH1.25, 6 pins) | [SW11] 2.1, 4 |
| Same dual UART model, figures of the older instruction | default working window 3–3.7 V and default start difference 50 mV; disabled below 1.5 V pack voltage; LTO supported | [BAL1A] 5; conflicts with the 20 mV of [SW11] (section 12, item 15) |
| Unit of [SNOOP] | 16 cells at 3.33 V (LiFePO4), software `B002_111132_03`, hardware `E303-032DG-SMB`, Bluetooth module HiLink HLK-B40; product link of the owner: "active balancer lifepo4 16s, Daly 3 to 24s 1A smart active balancer" | [SNOOP], [SY25] |
| Units of [CEPR] | three 24S and one 20S balancer on a Li-ion (NMC) pack, read over the UART port | [CEPR] README, 4.9 |
| Other reported units | 15S (BLE, needed Bluetooth pairing) [BBH42]; 12S on the UART port with Daly2MQTT [D2M]; a balancer next to a Daly BMS, each on its own serial interface [MG] | [BBH42], [D2M], [MG] README |
| 5 A model | Daly sells an "Active Balance Module (1A/5A)"; no frame or protocol statement for the 5 A model was found (**unverified**) | [DPAGE] |

Not covered by this document:

- The "Smart Active Balance BMS" (models R24TH1A, R24TK1A, R24TM1A, R24TS1A, 40–500 A) is a BMS with 1 A built-in balancing, MOSFETs and current measurement ([ABMS]); it is a BMS for the `daly-modbus` or `daly` driver.
- A dual UART balancer whose UART1 is connected to a Daly K, M or S BMS: the BMS reads the balancer and reports it, the Bluetooth dongle or the PC talks to the BMS ([SW11] 9.1: "set active Balancing Module to ON" in the BMS; [BAL1A] 3). The Daly app shows an "Active balance" page for such a BMS (balance status, balance current, balance position, balance current setting, battery strings, discharge high and low temperature protection, sleep time, start difference, start voltage, cut-off voltage, balance switch) ([IMG], [SW11] 7 and 8). Which BMS registers carry that page is not known (**unverified**); only the switch register 0x00CF is read by [SY] on such a BMS ([SY] issue 28 and pull request 109).

### 1.2 Protocols spoken by the balancer

| Protocol | Evidence | Use in ubms |
| --- | --- | --- |
| Modbus style D2 (address 0xD2, functions 0x03, 0x06, 0x10, CRC-16/MODBUS) | the official app reads and writes the balancer only with D2 frames over BLE ([SNOOP]); single register reads and a write of 0x008A answered over the UART port, and the 80 register status read answered over the UART port ([CEPR] 4.9, firmware README); the aiobmsble Daly plugin (D2) reads a 15S balancer over BLE ([BBH42], [AIO]) | the only protocol of the `daly-balancer` driver |
| Classic A5 (13-byte frames, sum8) | answered over the UART port: 0x94 within about 38 ms and 0x95 as seven frames 150–400 ms after the request on a 20S balancer ([AC97]); [MG] sends 0x50, 0x51, 0x53, 0x57, 0x59, 0x5A, 0x5F, 0x60, 0x62, 0x63, 0x91, 0x94, 0x95, 0x97, 0x98 to its balancer, notes for 0x90 "voltage only", for 0x92 "probably onboard sensor", for 0x54 "no response", and reserves 0x93 (MOSFETs) for the BMS; [D2M] maintainer: balancers use the BMS protocol without currents. Over BLE the app sends one A5 frame (command 0x02) and gets no A5 answer ([SNOOP] rec 66, 194). [FORUM] (as summarised by [CEPR] 3) reports a balancer that ignored A5 requests | reference only (section 5.4); no captured A5 balancer reply exists, so no vector and no driver |
| Modbus 0x81 map | the balancer answered the app's 0x81 write probe with `51 10 0F 05 AA AA 21 93` ([SNOOP] rec 69, 197); no 0x81 read was ever sent to a balancer | not used (**unverified**) |

### 1.3 Coverage in ubms

| Driver id | Links | Protocol | Status |
| --- | --- | --- | --- |
| `daly-balancer` (family `daly`, vendor `Daly BMS` as in the Daly BMS definitions, device type `balancer`, folder `packages/bms-drivers/src/daly-balancer/`) | BLE (service 0xFFF0) and serial (9600 8N1) | D2, sections 3 to 9 | implemented: `protocol.js` (frames, parsers, fault bits, log names), `settings.js` (schema of section 7), `driver.js` (driver and definition), `simulator.js` (demo and tests), `index.js` (`dalyBalancerDrivers`); tests in `packages/bms-drivers/test/dalybal.test.js`. Detection in section 11, registration order in section 11.5 |

The family id `daly` makes the selection "Daly, any protocol" (`family:daly`) include the balancer next to `daly-modbus` and `daly`. The code shares nothing with `packages/bms-drivers/src/daly/`: the framing is the same, but detection, register use and writes differ (1.4).

The simulator answers like the captured unit (register values of 6.1 to 6.6, reversed version strings, 0xFF filled blocks, write echoes) and applies only the four writes of section 7. Its balancing model is a simulator choice, not a device fact: state 0x0034 = 1 while the switch is on, the highest cell is at or above the start voltage and the difference reaches the start difference; balance current (raw − 30000) mA rising to 1 A; 0x003E / 0x003F flag the two cells involved.

### 1.4 How a balancer differs from a Daly BMS on the wire

| Aspect | Daly BMS (D2) | Daly balancer | Sources |
| --- | --- | --- | --- |
| Framing, address, CRC, function codes | `D2 03`, `D2 06`, `D2 10` without byte count | identical | [DALY] 3.2, [SNOOP] |
| Register addresses of the status, settings and version blocks | vendor list | identical layout; all blocks answered with the same lengths | [VL], [SNOOP] |
| Current 0x0029, SOC 0x002A, remaining capacity 0x0030, cycles 0x0033, MOSFET flags 0x0035 / 0x0036, state 0x002F | measured values | fixed: 30000 (0 A), 0, 0, 0, 0, 0, 0 | [SNOOP] rec 73, 201, 263 |
| Temperatures | up to 8 NTC slots, count in 0x0032 | one board sensor (count 1); slots 7 and 8 carry the total voltage and the average cell voltage | [SNOOP], [CEPR] 4.5 |
| MOSFET and board temperature 0x0042 / 0x0043 | plausible value, or 0 / 0xFFFF on older firmware | 0xFFFF / 0 | [SNOOP] rec 212, [CEPR] 4.5, [DALY] 6.3 |
| Settings block: current limits 0x0093..0x0096 | real thresholds (for example raw 29900, 29900, 29840, 30160) | all 30000 (0 A); pack high limits 0, pack low limits 500.0 V | [SNOOP] rec 71, [SY] `SETTINGS_FRAME_1` |
| Register 0x00CE..0x00D0 | vendor list: cloud server IP address in ASCII | 0x00CE = cell count, 0x00CF = balancer switch, 0x00D0 = 10 | [VL], [SNOOP] rec 220 |
| Balancer switch 0x00CF | present on some BMS with active balancing ([SY] issue 28, pull request 109); 0xFFFF on an 0x81 ESS pack ([DALY] 6.4) | 0 / 1, written by the app | [SNOOP] |
| Version strings | `T00K_321042_11` / `H2.0_103R_309F9F` (aiobmsble BMS) | `B002_111132_03` / `E303-032DG-SMB` | [AIO], [SNOOP] |
| Request the app sends after the first data | none special | the app reads 0x003E (9), 0x00CC (5), 0x00DF (17) on its balancer page | [SNOOP] |

The decisive differences for detection are the fixed current, SOC, capacity, cycle and MOSFET fields of the status block and the zero current limits of the settings block (section 11.3).

## 2. Physical links

### 2.1 BLE

The Daly Bluetooth dongle plugs into the balancer UART port ([BAL1A] 2, step 1.3) and is a transparent bridge: whatever the app writes reaches the balancer UART ([CEPR] 2, community statement), and the module answers its own AT commands on the data characteristic ([SNOOP] rec 62, 68). The captured dongle is a HiLink HLK-B40, firmware `HLK-B40(b.2.02.1202305041115)` (answer to `AT+VER=?`, [SNOOP] rec 61).

GATT table of the captured module (read by type and find information responses, [SNOOP] rec 3–44, decoded for this document):

| Service | Characteristic | Value handle | Properties | Descriptors | Use |
| --- | --- | --- | --- | --- | --- |
| 0x1800 | 0x2A00 device name | 0x0003 | read, write | | do not write (a write renames the module on Daly dongles, [DALY] 2.1.2) |
| 0x1800 | 0x2A01, 0x2A04, 0x2AC9 | 0x0005, 0x0007, 0x0009 | read (0x2A01 also write) | | not used |
| 0x1801 | 0x2A05 service changed | 0x000C | read, indicate | CCCD 0x000D | not used |
| `0000fff0-0000-1000-8000-00805f9b34fb` | 0xFFF1 | 0x0010 | read, notify | CCCD 0x0011, user description 0x0012 | Daly frames from the balancer; also AT answers of the module |
| same | 0xFFF2 | 0x0014 | read, write without response, write | CCCD 0x0015, user description 0x0016 | Daly frames to the balancer |
| same | 0xFFF3 | 0x0018 | read, write without response, write | CCCD 0x0019 | AT commands to the module (answers arrive on 0xFFF1) |
| `02f00000-0000-0000-0000-00000000fe00` | `...ff03` | 0x001C | read | | module vendor service, not used |
| same | `...ff02` | 0x001E | read, notify | CCCD 0x001F | not used |
| same | `...ff00` | 0x0021 | read | | not used |
| same | `...ff01` | 0x0023 | write without response, write | | not used |
| same | `...ff04` | 0x0025 | read, write without response, write, notify | CCCD 0x0026 | AT commands (`AT+VER=?`) |
| same | `...ff05` | 0x0028 | read, write without response, write | | the app writes ASCII `HiLink` and reads back `01 00` |

The same two services, with the same characteristics except 0xFFF3 and with other handles, were listed for a Daly module in [PYD31]; [DALY] 2.1.2 calls this "layout A". No 0xFF00 service and no Device Information service (0x180A) exist on the captured balancer module ([SNOOP] rec 4 and 6: four primary services, the next request at handle 0x0029 ends with "attribute not found").

| Item | Value | Sources |
| --- | --- | --- |
| Notify / write | subscribe to 0xFFF1, write requests to 0xFFF2 with ATT Write Command (write without response), one frame per write | [SNOOP] (every Daly request is a Write Command to handle 0x0014) |
| MTU | the module requests 512 itself (rec 1) and the app requests 512 (rec 45); every reply then fits one notification (largest captured reply: 129 bytes; an 80 register reply of 165 bytes would fit too). Other hosts may get a smaller MTU, so replies can also arrive in pieces ([DALY] 2.1.3) | [SNOOP] |
| Several frames per notification | 70 bytes with two replies (rec 209), 91 bytes with three (rec 212), after the app sent requests without waiting | [SNOOP] |
| Connection parameters | the module requests interval 15 ms (0x000C), latency 0, supervision timeout 4 s (L2CAP connection parameter update, rec 63, 127, 191) | [SNOOP] |
| CCCDs written by the app | 0x0011 (FFF1), 0x0015 (FFF2), 0x0026 (ff04), 0x001F (ff02), each `01 00` (rec 47–54); ubms needs only 0x0011 | [SNOOP] |
| Pairing | none in [SNOOP] (no security manager traffic); one 15S unit could only be read after bonding with PIN `123456`; its owner had changed the password in the app, and pairing still wanted the original `123456` | [SNOOP], [BBH42] |
| Advertised name | not in [SNOOP] (the capture starts after connecting). The [BBH42] unit (address 40:18:04:01:3A:EF) was offered by Home Assistant through the aiobmsble Daly matcher, which accepts names `DL-*` with service 0xFFF0 or Daly manufacturer data ([AIO] `matcher_dict_list`), so its name probably starts with `DL-` (**unverified**). The name does not distinguish a balancer from a BMS | [BBH42], [AIO] |

### 2.2 Wired serial (UART, RS485)

| Item | Value | Sources |
| --- | --- | --- |
| Format | 9600 baud, 8 data bits, no parity, 1 stop bit; every D2 request of the validation log was answered with a valid CRC on the first try | [CEPR] 4.9; the Bluetooth module reports its UART at 9600 (`AT+BAND=?` answered `9600`, [SNOOP] rec 62); vendor list header "9600 8bits, 1 stop bit, no parity" ([VL]) |
| Connector (dual UART model) | UART1 and UART2: GH1.25 6 pins, 1 GND, 2 3.3 V supply, 3 5 V supply, 4 S1 button, 5 TX, 6 RX | [SW11] 4 |
| Connector (UART/RS485 model) | ports labelled "UART" (Bluetooth) and "RS485" on the board drawing; pinout not documented | [BAL1A] 2 |
| Levels | TXD open collector, needs a pull-up on the host side (for example 4.7 kΩ to 3.3 V); RXD "0" below 0.5 V, "1" above 3 V | [CEPR] 2 (quoting the Daly UART/485 protocol V1.2) |
| Ground | the port is referenced to the most negative cell (B−) of the string the balancer sits on; isolate when several balancers on one pack are read | [CEPR] README "Isolation concept" |
| RS485 port | no D2 frame over RS485 is documented for a balancer; [CEPR] 9 cites a project that reads a balancer over RS485 with the classic A5 library (not available to this document, **unverified**) | [CEPR] 3, 9 |
| Reply time | "the reply ends up to 510 ms after the request (it answers on its own ~1 s cycle)" for the 80 register read; cepr waits 1000 ms | [CEPR] `firmware/board/src/main.rs` `BALANCER_TIMEOUT` |
| Classic reply time | 0x94 about 38 ms; 0x95 frames start 150–270 ms after the request and end at about 400 ms; a 100 ms timeout fails two reads in three | [AC97] |
| Sleep | after the sleep time (default 3600 s) the balancer stops answering on the UART until it is woken (power cycle or the button pin S1); 65535 disables sleep | [BAL1A] 2 step 6 (default and 65535); [CEPR] 7 and firmware README (stops answering, **unverified**: inferred from BMS behaviour); [SW11] 4 (S1 = button) |

## 3. Frame formats

All frames are the D2 frames of [DALY] 3.2. Summary:

### 3.1 Read holding registers (function 0x03)

| Offset | Request | Reply |
| --- | --- | --- |
| 0 | 0xD2 | 0xD2 |
| 1 | 0x03 | 0x03 |
| 2–3 | start register, u16 BE | byte 2: byte count N = 2 × register count |
| 4–5 | register count, u16 BE | bytes 3 … 3 + N − 1: registers, u16 BE |
| 6–7 | CRC low, CRC high | last 2 bytes: CRC low, CRC high |

Reply length = 5 + 2 × count: 129 bytes for 62 registers, 165 for 80, 87 for 41, 69 for 32, 23 for 9, 15 for 5, 11 for 3, 7 for 1 ([SNOOP], [CEPR] `REALTIME_REPLY_LEN`). Replies carry no register address: match them to the request (one request in flight) and check the byte count ([DALY] 3.2).

### 3.2 Write single register (function 0x06)

`D2 06 <reg hi> <reg lo> <value hi> <value lo> <CRC lo> <CRC hi>`; the balancer echoes the 8 bytes ([SNOOP] rec 231/232 and 250/251; [CEPR] 4.9 for 0x008A).

### 3.3 Write multiple registers (function 0x10, no byte count)

`D2 10 <start> <count> <2 × count data bytes> <CRC>`; the vendor list documents the missing byte count ([VL] example `D2 10 00 0C 00 02 00 01 00 02 7D 65`). The app writes the clock this way (`D2 10 00 D4 00 03 18 0B 07 09 34 1C F7 D8`, rec 56); no reply to it appears in the capture ([SNOOP]). ubms does not need this function.

### 3.4 CRC

CRC-16/MODBUS, low byte first. Check values: `D2 03 00 00 00 3E` gives CRC 0xB9D7, sent `D7 B9`; `D2 06 00 CF 00 01` gives 0x966B, sent `6B 96` ([DALY] 3.2, recomputed for every vector).

### 3.5 Reassembly

Use the D2 rules of [DALY] 3.3 with these additions from the balancer capture:

1. Drop bytes until 0xD2. Length by function: 0x03 → 5 + byte 2, 0x06 and 0x10 → 8, function with bit 7 set → 5 ([DALY] 3.3).
2. ASCII text from the Bluetooth module arrives on 0xFFF1 between frames: `9600` and `AT+PRODUCTINFO=NoPID` ([SNOOP] rec 62, 68). It contains no 0xD2 byte and is skipped by the resync.
3. One notification may carry several complete replies ([SNOOP] rec 209, 212); split them.
4. Damaged frames happen when requests overlap: a 29 byte frame `D2 03 18 FF…FF D6 82` whose byte count says 24 but whose CRC belongs to the 56 byte reply of another request ([SNOOP] rec 82, 273), and an echo with a wrong CRC ([SNOOP] rec 249). On a CRC error drop one byte and resynchronise ([DALY] 3.3); never trust a frame with a bad CRC.
5. The reply to the app's 0x81 probe starts with 0x51 ([SNOOP] rec 69). A driver that never sends 0x81 frames never sees it; the assembler skips it when it waits for 0xD2.
6. On the UART, late replies to an earlier timed-out request can still arrive ([AC97], [CEPR] `drain()`): discard pending input before each request, as cepr does.

### 3.6 Classic A5 frame (reference only)

13 bytes `A5 <address> <command> 08 <8 data bytes> <sum8 of bytes 0..11>` ([DALY] 3.1). Only relevant for section 5.4.

## 4. Session flow

### 4.1 What the official app does over BLE

The capture holds three connections (the module requests the MTU and the app rediscovers the services at rec 1, 83 and 129); the second one sends no Daly frame ([SNOOP]).

1. Exchange MTU 512 (rec 1/2 requested by the module, rec 45/46 by the app), discover services (rec 3–44), write `01 00` to the four CCCDs (rec 47–54).
2. Write ASCII `HiLink` to `...ff05` (rec 55, 183) and read it back (`01 00`, rec 57/58).
3. Write the phone clock: `D2 10 00 D4 00 03 YY MM DD hh mm ss <CRC>` (rec 56: 2024-11-07 09:52:28; rec 184: 09:53:05). No reply.
4. Query the module: `AT+VER=?` on `...ff04`, `AT+BAND=?` and `AT+PRODUCTINFO=?` on 0xFFF3 (rec 59, 60, 65).
5. Send a classic frame `A5 40 02 08 00 00 00 00 00 00 00 00 EF` (rec 66, no answer) and an 0x81 write probe `81 10 0F 05 00 02 00 00 00 00 87 6A` (rec 67, answered `51 10 0F 05 AA AA 21 93` after 201 ms).
6. Read settings (0x0080 × 41), status (0x0000 × 62), version (0x00A9 × 32), password (0x00C9 × 3), then 0x0063 × 28, 0x00CC × 2, 0x003E × 9 and 0x0057 × 12 (the third connection adds 0x00DF × 17 and 0x00D7 × 1, rec 210 and 213). The app sends these last reads in bursts without waiting for replies: twice (rec 78–81 and, when the app repeated the start sequence, rec 268–272) only one damaged frame came back (rec 82, 273); once (rec 206–211) all replies arrived, packed into two notifications (rec 209, 212).
7. On its balancer page the app repeats every 2.5–5 s: settings (0x0080 × 41), 0x003E × 9, 0x00CC × 5 (contains the switch 0x00CF) and 0x00DF × 17 (rec 215–261).
8. Switch writes: 0x00CF = 0 (rec 231, echo after 179 ms), 0x00CF = 1 (rec 248, echo with a bad CRC; repeated 10 s later, rec 250, echo after 397 ms). The following 0x00CC reads show the new state.

Reply times of all 41 valid replies: 63–501 ms after the request ([SNOOP], decoded for this document).

### 4.2 Recommended ubms flow

1. Open the link: BLE notify 0xFFF1, write 0xFFF2 without response; serial 9600 8N1. Do not write the CCCDs of the vendor service, `HiLink`, AT commands, the clock or the app probes; no open source implementation needs them ([SY], [AIO], [CEPR]).
2. Probe (section 11.3).
3. Device information once: version block 0x00A9 × 32 (section 10).
4. Settings on demand: 0x0080 × 41 and 0x00CC × 5 (section 7).
5. Poll: status 0x0000 × 62, then 0x003E × 9 (balance current), then 0x00CC × 5 (switch). These are the reads of the app ([SNOOP]). They also reach the UART: the BLE dongle plugs into the balancer UART port ([BAL1A] 2 step 1.3), reports that UART at 9600 baud ([SNOOP] rec 62) and passes the same frames to it ([CEPR] 2). The 80 register read, which covers 0x003E..0x004F, is confirmed over the UART as well ([CEPR] 4.8, firmware README). ubms polls with the reads of the app on BLE and with 0x0000 × 80 plus 0x00CC × 5 on serial links: on the UART a reply ends up to 510 ms after the request ([CEPR]), so one turnaround less matters in a 2 s poll (ubms choice).
6. One request in flight. Timeout per request: BLE 1.5 s (longest captured reply 501 ms), serial 1.2 s ([CEPR] waits 1 s for a reply that ends up to 510 ms after the request). At most one retry, after discarding pending input. ubms resets the frame assembler before every attempt (pending partial input is dropped and logged) and waits 30 ms (BLE) or 50 ms (serial) after the last frame before the next request (ubms choice; the app paced its requests by the replies).
7. Poll interval: 2 s by default, at least 1 s. The app refreshes every 2.5–5 s ([SNOOP]); cepr reads every 500 ms but gets about one reply per second ([CEPR] `BALANCER_POLL`).
8. Writes: one register per request (function 0x06), wait for the echo, compare all 8 bytes, then read the block back and compare the value (section 7.5).

Implementation notes (ubms choices, not device facts): the status read is retried once per poll; the balance block (BLE only) and the switch block are optional and read without a retry. After two lost replies in a row (timeout or exception reply) a block is skipped for the next 15 polls and then read again; a success ends the pause, one more loss after the pause starts the next one at once. So a firmware without the block costs one timeout per 16 polls, and a lossy link loses the block only for a while (serial links never reconnect on their own). One lost switch block read keeps the switch state of the previous poll; while the block is paused the switch is left out of the snapshot, because a stale state could be wrong (the Daly app on the second UART of the dual UART model can change it). A lost balance block read leaves the balance current out of that snapshot. The settings screen reads the switch block itself and shows the switch only from that read.

## 5. Commands

### 5.1 Read requests

| Purpose | Frame | Reply | Source | Status |
| --- | --- | --- | --- | --- |
| status, 62 registers from 0x0000 | `D2 03 00 00 00 3E D7 B9` | 129 bytes | [SNOOP] rec 72, 200, 262 | captured |
| status, 80 registers from 0x0000 | `D2 03 00 00 00 50 56 55` | 165 bytes | [CEPR] 4.8, `REALTIME_REQUEST` | answered on the UART ([CEPR] firmware README); the ubms poll on serial links (4.2 step 5) |
| balance block, 9 registers from 0x003E | `D2 03 00 3E 00 09 F7 A3` | 23 bytes | [SNOOP] rec 80, 208, 217, … | captured |
| settings, 41 registers from 0x0080 | `D2 03 00 80 00 29 96 5F` | 87 bytes | [SNOOP] rec 70, 198, 215, … | captured |
| version, 32 registers from 0x00A9 | `D2 03 00 A9 00 20 87 91` | 69 bytes | [SNOOP] rec 74, 202, 264 | captured |
| password, 3 registers from 0x00C9 | `D2 03 00 C9 00 03 C6 56` | 11 bytes | [SNOOP] rec 76, 204, 266 | captured; not sent by ubms (section 10) |
| switch block, 5 registers from 0x00CC | `D2 03 00 CC 00 05 56 55` | 15 bytes | [SNOOP] rec 219, 227, 237, 245, 256 | captured |
| production date, 2 registers from 0x00CC | `D2 03 00 CC 00 02 17 97` | 9 bytes | [SNOOP] rec 79, 207, 270 | captured |
| balancer switch alone, 0x00CF | `D2 03 00 CF 00 01 A7 96` | 7 bytes | [SY] `DALY_COMMAND_REQ_BALANCER_SWITCH`, [CEPR] 4.8 | not captured on a balancer; the app reads 0x00CC × 5 |
| single settings registers 0x0089, 0x008A, 0x00A3, 0x00A4, 0x00A8 | `D2 03 00 89 00 01 46 43`, `D2 03 00 8A 00 01 B6 43`, `D2 03 00 A3 00 01 67 8B`, `D2 03 00 A4 00 01 D6 4A`, `D2 03 00 A8 00 01 16 49` | 7 bytes | [CEPR] 4.9 (read one at a time on hardware); frames computed | answered on the UART |
| 0x0063 × 28, 0x0057 × 12, 0x00D7 × 1, 0x00DF × 17 | `D2 03 00 63 00 1C A7 BE`, `D2 03 00 57 00 0C E7 BC`, `D2 03 00 D7 00 01 27 91`, `D2 03 00 DF 00 11 A7 9F` | 61, 29, 7, 39 bytes | [SNOOP] | captured; contents in 6.6, not needed |

### 5.2 Write requests

| Purpose | Frame | Source | Status |
| --- | --- | --- | --- |
| balancer on (0x00CF = 1) | `D2 06 00 CF 00 01 6B 96` | [SNOOP] rec 248, 250 | captured, echoed, state read back; the LED reacts ([SY25]) |
| balancer off (0x00CF = 0) | `D2 06 00 CF 00 00 AA 56` | [SNOOP] rec 231 | captured, echoed, state read back |
| sleep never (0x008A = 65535) | `D2 06 00 8A FF FF BA 33` | [CEPR] 4.8 and `daly.rs` test | a write to 0x008A was echoed on hardware ([CEPR] 4.9, value not stated) |
| sleep 3600 s (0x008A = 3600) | `D2 06 00 8A 0E 10 BE 2F` | computed | same register |
| balance start voltage 3300 mV (0x00A3) | `D2 06 00 A3 0C E4 6F 00` | computed | register read on two balancers, write not captured (section 7.1) |
| balance start difference 20 mV (0x00A4) | `D2 06 00 A4 00 14 DB 85` | computed | register read on two balancers, write not captured (section 7.1) |
| battery type 0 / 1 / 2 (0x0089) | `D2 06 00 89 00 00 4B 83`, `D2 06 00 89 00 01 8A 43`, `D2 06 00 89 00 02 CA 42` | computed | effect on a balancer unknown: not sent by ubms (section 7.3) |

The value field is u16 BE in the unit of the register (mV, s, enumeration). Any other value is encoded the same way; for example 0x00A3 = 3200 mV is `D2 06 00 A3 0C 80 6E EB` and 0x00A4 = 30 mV is `D2 06 00 A4 00 1E 5B 82` (computed).

### 5.3 Requests ubms must not send

| Frame | Why |
| --- | --- |
| `D2 10 00 D4 00 03 …` (clock) | write; no reply in [SNOOP]; a balancer has no documented use for the clock |
| `81 10 0F 05 00 02 00 00 00 00 87 6A` | write multiple to an unknown register; answered with `51 10 0F 05 AA AA` ([SNOOP]) |
| `A5 40 02 08 …` | command 0x02 is not a documented read ([DALY] 5.1) |
| AT commands, `HiLink` | Bluetooth module configuration, not the balancer |
| `D2 06 00 F0..F3 00 01` (restart, shutdown, zero current, reset) | BMS commands of the vendor list ([VL], [DALY] 5.4); never tested on a balancer |
| `D2 06 00 A5 / A6 …` (MOSFETs), `D2 06 00 A7 …` (SOC) | the balancer has no MOSFETs and no SOC ([SNOOP] status values) |
| writes to 0x0080..0x0088, 0x008B..0x00A2 | BMS protection and hardware configuration registers; their role on a balancer is unknown (section 7.4) |

### 5.4 Classic A5 requests answered on the UART port (reference)

Host address 0x40, zero data ([DALY] 5.2). Answered by balancers according to [MG] (capability table of `DalyBMSManager.hpp`) and [AC97]; not used by the `daly-balancer` driver.

| Command | Answer on a balancer | Source |
| --- | --- | --- |
| 0x90 | answered, only the voltage is meaningful | [MG] |
| 0x91, 0x94, 0x95, 0x97, 0x98 | answered (0x94 in about 38 ms, 0x95 as ⌈cells / 3⌉ frames within about 400 ms) | [MG], [AC97] |
| 0x92 | answered, "probably onboard sensor" | [MG] |
| 0x50, 0x51, 0x53, 0x57, 0x59, 0x5A, 0x5F, 0x60, 0x62, 0x63 | answered | [MG] |
| 0x5C, 0x5E | answered, content "questionable" | [MG] |
| 0x54 | no answer (BMS and balancer) | [MG] |
| 0x93 | not answered: a classic BMS driver that polls 0x93 stalls on a balancer | [MG], [BM239] maintainer comment |

## 6. Responses

### 6.1 Status block (read from 0x0000, 62 or 80 registers)

Frame offset of register r = 3 + 2 × r. Observed values: [SNOOP] rec 73, 201, 263 (16S, idle) unless noted. Vectors `bal-rx-status62-a` to `-c`.

| Register | Offset | Type | Scale | Meaning | Balancer values | Use in ubms |
| --- | --- | --- | --- | --- | --- | --- |
| 0x0000–0x001F | 3–66 | u16 | 1 mV | cell voltage 1–32 | 16 cells 3.331–3.338 V, unused slots 0 | `cells`, first 0x0031 slots; keep a 0 mV cell (open sense lead or wrong count) |
| 0x0020 | 67–68 | u16 | +40 | temperature 1 | 68 (28 °C); the board sensor ([CEPR] 4.5: "only Temperature 1 is used, its PCB sensor") | temperature id `board`, kind `board` |
| 0x0021–0x0025 | 69–78 | u16 | +40 | temperatures 2–6 | 0 | ignore (count 0x0032 = 1) |
| 0x0026 | 79–80 | u16 | | temperature 7 on a BMS | 533 = the total voltage register | ignore (**unverified** why) |
| 0x0027 | 81–82 | u16 | | temperature 8 on a BMS | 3335, 3336 = the average cell voltage register | ignore |
| 0x0028 | 83–84 | u16 | 0.1 V | total voltage | 533 (53.3 V); equals the cell sum truncated to 0.1 V in all three frames (53.374, 53.377, 53.375 V) | `voltage` |
| 0x0029 | 85–86 | u16 | 0.1 A, 30000 offset | current | 30000 | not reported; signature |
| 0x002A | 87–88 | u16 | 0.1 % | SOC | 0 | not reported; signature |
| 0x002B | 89–90 | u16 | 1 mV | highest cell voltage | 3338, 3336, 3337; frame b: 3336 while its cells reach 3338 | not used (derive from cells) |
| 0x002C | 91–92 | u16 | 1 mV | lowest cell voltage | 3332, 3331, 3333; frame a: 3332 while its lowest cell is 3333 | not used |
| 0x002D / 0x002E | 93–96 | u16 | +40 | highest / lowest temperature | 68 / 68 | not used |
| 0x002F | 97–98 | u16 | enum | charge / discharge state | 0 | not reported; signature |
| 0x0030 | 99–100 | u16 | 0.1 Ah | remaining capacity | 0 | not reported; signature |
| 0x0031 | 101–102 | u16 | | cell count | 16 | number of cells |
| 0x0032 | 103–104 | u16 | | temperature sensor count | 1 | number of temperature slots to decode (clamp to 8) |
| 0x0033 | 105–106 | u16 | | cycle count | 0 | not reported; signature |
| 0x0034 | 107–108 | u16 | enum | balancing state | 0 (idle: difference below 20 mV) | `balancingActive` = value ≠ 0 (section 9.1) |
| 0x0035 / 0x0036 | 109–112 | u16 | 0 / 1 | charge / discharge MOSFET | 0 / 0 | not reported; signature |
| 0x0037 | 113–114 | u16 | 1 mV | average cell voltage | 3335, 3336, 3335 = mean of the cells truncated to 1 mV | not used |
| 0x0038 | 115–116 | u16 | 1 mV | cell voltage difference | 6, 5, 4 = 0x002B − 0x002C, not the spread of the cells of the frame (5, 7, 5 mV) | not used |
| 0x0039 | 117–118 | u16 | 1 W | power | 0 | not reported |
| 0x003A–0x003D | 119–126 | 4 × u16 | bits | fault status | 0 | alarms (section 9.2) |
| 0x003E–0x004F | 127–162 | | | only in the 80 register read; see 6.2 | | |

The 62 register reply ends with the CRC at offsets 127–128 (129 bytes); the 80 register reply at 163–164 (165 bytes).

### 6.2 Balance block (read 9 registers from 0x003E)

Offset in the 9 register reply = 3 + 2 × (r − 0x003E); in an 80 register status read = 3 + 2 × r. Vector `bal-rx-block003e` ([SNOOP] rec 212 frame 1, identical in rec 218, 226, 236, 244, 255).

| Register | Offset (9 register read) | Meaning | Balancer value | Status |
| --- | --- | --- | --- | --- |
| 0x003E | 3–4 | balancing bits cells 1–16 ([SY] inferred); vendor list: remaining mileage 0.1 km | 0 | **unverified**, never non-zero |
| 0x003F | 5–6 | balancing bits cells 17–32 ([SY]); vendor list: reserved | 0 | **unverified** |
| 0x0040 | 7–8 | balance current, (raw − 30000) × 0.001 A ([SY]) | 30000 (0 A) | **unverified** scale and sign; publish `balanceCurrent` only from this register. A raw 0 or 0xFFFF (−30 A or +35.5 A, impossible for a 1 A balancer) is treated as "not available" (ubms choice) |
| 0x0041 | 9–10 | unknown | 0 | |
| 0x0042 | 11–12 | MOSFET temperature +40 on newer BMS firmware | 0xFFFF (not available) | ignore on a balancer |
| 0x0043 | 13–14 | board temperature +40 ([SY]) | 0; [CEPR] 4.5: "reads 0 on a balancer: use 0x0020" | ignore |
| 0x0044–0x0046 | 15–20 | unknown | 0 | |

The app shows "Balance current" and "Balance position" (the cell being balanced) on its balancer page ([IMG], [SW11] 7) and the owner of [SNOOP] asked for both sensors ([SY25]). Their registers are probably in this block, but no capture of an active balancer exists (**unverified**).

### 6.3 Settings block (read 41 registers from 0x0080)

Offset = 3 + 2 × (r − 0x0080). Vector `bal-rx-settings` ([SNOOP] rec 71, identical in seven more replies). "cepr" values are single register reads of a Li-ion balancer ([CEPR] 4.9).

| Register | Offset | Type / scale | Meaning (vendor list) | [SNOOP] | cepr | Role on a balancer |
| --- | --- | --- | --- | --- | --- | --- |
| 0x0080 | 3–4 | 0.1 Ah | rated capacity | 500 (50.0 Ah) | | unknown; not shown |
| 0x0081 | 5–6 | 1 mV | cell reference voltage | 3200 | | unknown; not shown |
| 0x0082 | 7–8 | | acquisition board count | 1 | | number of board cell counts that are valid |
| 0x0083–0x0085 | 9–14 | | cells on boards 1, 2, 3 | 16, 6, 6 | | configured cell count = sum over the first 0x0082 boards (16); boards 2 and 3 hold values that the board count makes irrelevant (pitfall 4) |
| 0x0086–0x0088 | 15–20 | | temperature sensors on boards 1, 2, 3 | 1, 1, 1 | | not shown |
| 0x0089 | 21–22 | enum | battery type: 0 LiFePO4, 1 ternary (Li-ion), 2 LTO | 0 (LiFePO4 cells at 3.33 V) | 1 (Li-ion pack) | `system.battery_type`, read-only (7.3) |
| 0x008A | 23–24 | 1 s | sleep wait time; 65535 = never ([BAL1A]) | 65535 | 3600 (factory default) | `system.sleep_delay` (7.3) |
| 0x008B–0x008E | 25–32 | 1 mV | cell high level 1 and 2, cell low level 1 and 2 | 3550, 3650, 2300, 2200 | | possibly the balancer's cell over- and undervoltage protection: the vendor PC tool shows "balance cell overvoltage 3650 mV" and "balance cell undervoltage 2500 mV" for a balancer ([SW11] 8) (**unverified**); not shown |
| 0x008F–0x0092 | 33–40 | 0.1 V | pack high level 1 and 2, pack low level 1 and 2 | 0, 0, 5000, 5000 | | unused |
| 0x0093–0x0096 | 41–48 | 0.1 A, 30000 offset | charge and discharge current limits | 30000 × 4 (0 A) | | unused; detection signature (11.3) |
| 0x0097–0x009E | 49–64 | +40 | charge high L1, L2, charge low L1, L2, discharge high L1, L2, discharge low L1, L2 | 40, 125, 40, 0, 40, 125, 40, 0 (0, 85, 0, −40, 0, 85, 0, −40 °C) | | the level 2 values equal the default temperature protection of [SW11] 2.1 (85 °C, −40 °C) (**unverified** link); not shown |
| 0x009F–0x00A2 | 65–72 | 1 mV, 1 °C | cell and temperature difference L1, L2 | 0 × 4 | | unused |
| 0x00A3 | 73–74 | 1 mV | balancing start voltage | 3200 | 3300 (factory default of [BAL1A]) | `balance.start_voltage` (7.1) |
| 0x00A4 | 75–76 | 1 mV | balancing start difference | 20 | 20 (factory default of [BAL1A]) | `balance.trigger_delta` (7.1) |
| 0x00A5 / 0x00A6 | 77–80 | 0 / 1 | charge / discharge MOSFET switch | 0 / 0 | | unused |
| 0x00A7 | 81–82 | 0.1 % | SOC setting | 0 | | unused |
| 0x00A8 | 83–84 | +40 | MOSFET temperature alarm | 87 | 87 ("not shown in the DALY PC software") | unknown; not shown |

### 6.4 Version block (read 32 registers from 0x00A9) and password

Split 16 / 16 / 32 bytes as in [DALY] 10.2. Vector `bal-rx-version`.

| Registers | Offset | Content | Balancer value |
| --- | --- | --- | --- |
| 0x00A9–0x00B0 | 3–18 | software version, ASCII, NUL padded | `B002_111132_03` |
| 0x00B1–0x00B8 | 19–34 | hardware version | `E303-032DG-SMB` |
| 0x00B9–0x00C8 | 35–66 | machine code | empty (all 0) |
| 0x00C9–0x00CB (separate read) | 3–8 | parameter password, 6 ASCII | `123456` (vector `bal-rx-password`); not read by ubms (section 10) |

Read backwards, the two strings are `30_231111_200B` and `BMS-GD230-303E`. The Daly PC tool screenshot of a balancer shows the hardware `BMS-GD230-303E` and a software version in the same `30_YYMMDD_…` form (`30_240424_00NB`) ([SW11] 8), and the D2 software version of a BMS read backwards (`T00K_321042_11` → `11_240123_K00T`, [AIO]) has the form of the 0x81 map strings (`12_260120_K00T`, [DALY] 10.3). So the firmware probably stores these strings in reverse order and the vendor tools reverse them for display (**unverified**). ubms reports the string as read and may add the reversed form as an extra value.

### 6.5 Switch block (read 5 registers from 0x00CC)

Offset = 3 + 2 × (r − 0x00CC). Vectors `bal-rx-00cc-5-on`, `bal-rx-00cc-5-off`.

| Register | Offset | Vendor list | Balancer value | Status |
| --- | --- | --- | --- | --- |
| 0x00CC–0x00CD | 3–6 | production date `YY MM DD 00` | `00 01 01 00` (placeholder, not set) | as on BMS boards ([DALY] 10.2) |
| 0x00CE | 7–8 | start of the cloud server IP address (ASCII) | 16, equal to the cell count | meaning **unverified** (copy of the cell count, or the app's "battery strings" setting) |
| 0x00CF | 9–10 | (IP address) | balancer switch: 1 on, 0 off; follows the writes of rec 231 and 250 | confirmed |
| 0x00D0 | 11–12 | (IP address) | 10 | meaning **unverified**; a balance current setting of 1.0 A in 0.1 A steps would match the factory default of [SW11] 2.1 and the "Balance current 1.0A" of [IMG] |

Only 0x00CF changed between the reads before and after the switch write ([SNOOP] rec 228 and 238).

### 6.6 Other blocks

| Read | Balancer reply | Vector |
| --- | --- | --- |
| 0x0063 × 28 | 56 bytes 0xFF | `bal-rx-0063-all-ff` |
| 0x0057 × 12 (GPS block on BMS boards) | 24 bytes 0x00 | `bal-rx-0057-zero` |
| 0x00D7 × 1 | 0 | `bal-rx-00d7` |
| 0x00DF × 17 | 34 bytes 0xFF | `bal-rx-00df-all-ff` |

0xFF filled blocks mean "not implemented" on this firmware. The app still reads 0x00DF on its balancer page; the extra parameters of the dual UART model (cut-off voltage, temperature protection, balance current) may live there on other firmware (**unverified**).

### 6.7 Write echo and the 0x81 reply

| Frame | Meaning | Vector |
| --- | --- | --- |
| `D2 06 00 CF 00 00 AA 56` | echo of the switch-off write, 179 ms | `bal-rx-echo-switch-off` |
| `D2 06 00 CF 00 01 6B 96` | echo of the repeated switch-on write, 397 ms | `bal-rx-echo-switch-on` |
| `D2 06 00 CF 00 01 1C 8A` | echo with a wrong CRC (correct `6B 96`); the app wrote again | `bal-rx-echo-switch-on-bad-crc` |
| `51 10 0F 05 AA AA 21 93` | reply to the 0x81 write probe: address 0x51, function 0x10, register 0x0F05, then 0xAAAA where the count is expected | `bal-rx-app-probe-81-reply` |

### 6.8 Mapping to the ubms snapshot

| Model field | Source | Rule |
| --- | --- | --- |
| `cells` | 0x0000.., count 0x0031 | mV / 1000 |
| `voltage` | 0x0028 | × 0.1 V |
| `temperatures` | 0x0020.., count 0x0032 (clamp 8) | one entry per counted slot, raw − 40; the first is the board sensor ([CEPR] 4.5), id `board`, the others `t2`..`t8`; a value above 150 °C is dropped (a voltage register read as a temperature, pitfall 2; ubms choice) |
| `balancingActive` | 0x0034 | ≠ 0 (section 9.1) |
| `balanceCurrent` | 0x0040 (balance block or 80 register read) | (raw − 30000) × 0.001 A, **unverified** |
| `switches.balance` | 0x00CF | 1 = on |
| `alarms` | 0x003A–0x003D | section 9.2 |
| `extra.faultCode` | high byte of 0x003D (classic byte 7) | numeric value, shown only when not 0 (section 9.2) |
| `current`, `power`, `soc`, `capacity*`, `cycles`, `switches.charge`, `switches.discharge` | | not reported: the balancer has no current sensor and no MOSFETs (fixed values in 6.1) |
| `cellStats` | | derived from `cells` by `deriveSnapshot()`; do not use 0x002B, 0x002C, 0x0037, 0x0038 |
| `balancing` (per cell) | 0x003E / 0x003F | not published until a capture with balancing is available |
| `extra.balancer` | 0x0034, 0x00CF | "Balancing now" while 0x0034 ≠ 0, otherwise "Off" when the switch is off, else "Idle" |
| `extra.startVoltage`, `extra.triggerDelta` | 0x00A3, 0x00A4 of the last settings read | shown with the live data once the settings block has been read (probe or settings screen) |

## 7. Settings

Grouped like the ubms catalog (`packages/bms-core/src/catalog.js`). Read from the settings block (6.3) and the switch block (6.5); write with function 0x06, one register at a time (5.2).

### 7.1 Balancing

| Catalog id | Register | Read | Write frame | Encoding | Range | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `balance.start_voltage` | 0x00A3 | settings offset 73 | `D2 06 00 A3 <mV hi> <mV lo> <CRC>`, for example 3300 mV = `D2 06 00 A3 0C E4 6F 00` | u16, 1 mV | 1.500–4.500 V ([SW11] 2.1, dual UART model); UART/RS485 range not documented | writable with read-back and a confirmation in the UI (`danger`). Register meaning confirmed by two balancer reads that match the manual defaults (3300 mV [CEPR], 3200 mV [SNOOP]; [BAL1A] 5 item 3: 3.3 V) and by the vendor list ([VL] "balancing turn on voltage", R/W); D2 writes of this register are confirmed on Daly BMS boards ([DALY] 7.5). The write itself is not captured on a balancer and is confirmed by the read-back |
| `balance.trigger_delta` | 0x00A4 | settings offset 75 | `D2 06 00 A4 <mV> <CRC>`, for example 20 mV = `D2 06 00 A4 00 14 DB 85` | u16, 1 mV | 0.010–1.500 V ([SW11] 2.1) | same status as 0x00A3; factory default 20 mV ([BAL1A] 5 item 3, [SW11] 2.1, read on both units; 50 mV for the dual UART model in [BAL1A] 5 item 4, pitfall 15) |
| `balance.max_current` | 0x00D0 (candidate) | switch block offset 11 | none | 0.1 A (candidate) | 0–1 A ([SW11]) | **unverified**: not in the schema; the raw value may be shown as an extra |

### 7.2 Switches

| Catalog id | Register | Read | Write | Status |
| --- | --- | --- | --- | --- |
| `switch.balance` | 0x00CF | switch block offset 9 (or `D2 03 00 CF 00 01 A7 96`) | on `D2 06 00 CF 00 01 6B 96`, off `D2 06 00 CF 00 00 AA 56` | confirmed: captured writes, echoes, read-back ([SNOOP]); LED stops and starts ([SY25]) |

### 7.3 System

| Catalog id | Register | Read | Write | Status |
| --- | --- | --- | --- | --- |
| `system.sleep_delay` | 0x008A | settings offset 23 | `D2 06 00 8A <s hi> <s lo> <CRC>`: 3600 s `D2 06 00 8A 0E 10 BE 2F`, never `D2 06 00 8A FF FF BA 33` | writable with read-back. 65535 = never sleep, default 3600 s ([BAL1A]); write echoed on hardware ([CEPR] 4.9). Register range 0–65535 s; ubms writes 60–65535 s only (the driver refuses other values itself, also when it is called directly), because the effect of shorter values (0 in particular) is not documented, and shows a warning below 600 s, which the write confirmation repeats: a short value makes the device unreachable after that idle time (ubms choices). The description says that 65535 means "never" |
| `system.cell_count` | 0x0083 (sum over 0x0082 boards); 0x0031 in the status block | settings offset 9 | none | read-only. The app has a "battery strings" setting ([IMG], [SW11] 7) and the manual demands that it matches the board ([BAL1A] 2 step 5), but which register the app writes (0x0083 or 0x00CE) is not captured (**unverified**). A wrong count causes mismeasurement ([BAL1A]) |
| `system.battery_type` | 0x0089 | settings offset 21 | not sent (frames in 5.2) | read-only enum 0 LiFePO4, 1 Li-ion (ternary), 2 LTO ([VL]); values 0 and 1 read on balancers, 2 unconfirmed; the effect of a write on a balancer is unknown (the manual tells LTO users to set the start voltage instead, [BAL1A] 5) |

### 7.4 Not exposed

Rated capacity (0x0080), cell reference voltage (0x0081), board and sensor counts (0x0082, 0x0084..0x0088), the BMS protection thresholds (0x008B..0x00A2), MOSFET switches (0x00A5, 0x00A6), SOC (0x00A7), 0x00A8 and the password: on the balancer they are either fixed at neutral values (6.3) or of unknown effect. They are never written. The password is not read either: it would end up in log exports (section 10).

### 7.5 Dependencies and checks

- Write one register, wait for the 8 byte echo (BLE: up to about 0.4 s seen; serial: up to 1.2 s), compare it with the request. On a CRC error or a timeout do not resend blindly: read the register back and resend only if it still has the old value ([SNOOP] rec 249/250 shows a bad echo of a successful write).
- After every write read the settings block (or the switch block for 0x00CF) and compare.
- As implemented: an echo with a bad CRC is dropped by the assembler, so it looks like a timeout. The driver then reads the block that holds the register (switch block for 0x00CF, settings block otherwise); the new value there counts as success; the old value leads to one more write and, without an echo again, one more read-back; a value still not taken is reported as "not applied". An echo whose value differs from the request is reported as "not applied" at once. An exception reply (`D2 86 <code> <CRC>`, 5 bytes, 3.5 step 1) is reported as "rejected" at once, without a read-back or a second write. The session then reads all settings back and marks each written field as verified or not. The driver refuses writes to any register outside 0x00CF, 0x00A3, 0x00A4 and 0x008A, and values outside the ranges of 7.1 and 7.3, also when called directly; nothing is sent then.
- Ranges in ubms: start voltage 1.5–4.5 V and start difference 0.01–1.5 V ([SW11] 2.1); the range of the UART/RS485 model is not documented, so a value the balancer does not take shows up as "not verified" after the read-back.
- Start voltage per chemistry: the factory value suits NMC and LiFePO4; LTO users must set the start voltage ([BAL1A] 5). Offer a warning (ubms check, not a device rule) when the start voltage lies outside the normal cell voltage range of the configured chemistry, taken from the wiring check of the manual: Li-ion about 3.0–4.15 V, LiFePO4 2.5–3.6 V, LTO 1.8–2.8 V ([BAL1A] 2 step 1.2 and 3 step 1.2). A start voltage above that range means the balancer never starts.
- Both conditions must hold for balancing: a cell at or above the start voltage and a difference at or above the start difference ([BAL1A] 5). The dual UART model has a working window instead: "Balance off voltage > Balance work voltage > Balance on voltage", and balancing stops when a cell leaves it ([SW11] 2.1); the off (cut-off) voltage defaults to 3.7 V ([BAL1A] 5 item 4; 3.70 V in [IMG]) and the on voltage to 3 V ([BAL1A] 5 item 4). A start voltage at or above the cut-off voltage therefore leaves an empty window and disables balancing on that model (inferred from that condition, **unverified**). ubms cannot check this, because the cut-off register is not known (6.6); the description of the start voltage says so.

## 8. Controls and actions

| Action | Frame | Verify with | Source |
| --- | --- | --- | --- |
| balancer on / off | 7.2 | 0x00CF in the switch block | [SNOOP] |

No restart, shutdown, reset or calibration command is documented for a balancer. The BMS commands 0x00F0..0x00F3 of the vendor list ([VL], [DALY] 8) are not offered; [MG] enables its classic reset command 0x00 for balancers too, which is outside D2 and untested here.

## 9. Bits and enumerations

### 9.1 Balancing state (0x0034)

| Value | Meaning | Source |
| --- | --- | --- |
| 0 | off | [VL] ("0: off, 1: on"); every captured balancer frame |
| 1 | on | [VL] |
| 2 | active balancing ("0 off, 1 passive, 2 active") | [SY] docs/protocol-register-map.md (D2 0x0034 and 0x81 map 0x004D); [CEPR] 4.5; the cepr emulator reports 2 |

No frame of a balancing balancer exists, so the value set is **unverified**; treat any non-zero value as balancing.

### 9.2 Fault registers (0x003A–0x003D)

Same layout as the Daly BMS: each register holds two classic `0x98` bytes, high byte first on the wire, so the wire order is classic bytes 1 0 3 2 5 4 7 6 ([DALY] 9.2; bit meanings in [DALY] 9.1). All captured balancer values are 0. Which bits a balancer sets is not documented; [CEPR] 6 expects only cell voltage, difference, temperature sensor and AFE bits (**unverified**, inferred). ubms maps the bits that make sense without current or MOSFETs:

| Classic byte / bit | Meaning | Alarm id |
| --- | --- | --- |
| 0 / 0–3 | cell voltage high (L1, L2), low (L1, L2) | `cell_overvoltage`, `cell_undervoltage` (L1 as warning) |
| 0 / 4–7 | pack voltage high, low | `pack_overvoltage`, `pack_undervoltage` |
| 1 / 0–7 | charge and discharge temperature high, low | `charge_overtemperature`, `charge_undertemperature`, `discharge_overtemperature`, `discharge_undertemperature` |
| 3 / 0–3 | cell voltage difference, temperature difference | `cell_voltage_difference`, `temperature_difference` |
| 5 / 0–3 | AFE failure, cell voltage acquisition offline, temperature sensor failure, EEPROM failure | `afe_fault`, `cell_wire_open`, `temperature_sensor_fault`, `eeprom_fault` |
| 5 / 7 | internal communication failure | `communication_fault` |

Bits of classic bytes 2, 4 and 6 (current, SOC, MOSFETs, precharge, short circuit) are reported with their raw source only (`source: 'bit n of 0x003X'`) if they ever appear. As implemented, every set bit of classic bytes 0 to 6 outside the table above (also classic byte 3 bits 4–7 and byte 5 bits 4–6) becomes an alarm with the id `daly.fault_<register>_bit<n>` (for example `daly.fault_003B_bit0` for classic byte 2 bit 0), the label "Undocumented fault bit", severity warning and the source `bit n of 0x003X`; the register bit is the classic bit plus 8 for the high byte. A level 1 and a level 2 bit of the same alarm give one alarm with the more severe level.

Classic byte 7 (the high byte of 0x003D) is a numeric fault code, not bits: the classic protocol documents data byte 7 of 0x98 as a fault code ([DALY] 9.1, CAN v1.0 notes), and on D2 that position is not described ([DALY] 9.2); the ubms Daly BMS driver ignores it on D2 and shows it as one number on classic. Its meaning on a balancer is not known (**unverified**). ubms does not split it into bit alarms (a code 3 would otherwise become two alarms): `parseStatus` returns it as `faultCode`, and the snapshot shows it as the extra value "Fault code" when it is not 0.

### 9.3 Battery type (0x0089)

0 LiFePO4, 1 ternary lithium (Li-ion, NMC), 2 lithium titanate (LTO) ([VL]). Observed 0 with LiFePO4 cells ([SNOOP]) and 1 on an NMC pack ([CEPR] 4.9).

### 9.4 Fixed fields

0x002F (charge / discharge state) is 0, 0x0035 / 0x0036 (MOSFETs) are 0 on every captured balancer frame ([SNOOP]); see the signature in 11.3.

## 10. Device information

| Item | Source | Value on [SNOOP] |
| --- | --- | --- |
| vendor | constant | Daly BMS (the same vendor string as the Daly BMS definitions, 11.5) |
| model | not transmitted | "Active balancer" (ubms label) |
| software version | 0x00A9, bytes 0–15 | `B002_111132_03` (reversed: `30_231111_200B`, 6.4) |
| hardware version | 0x00B1, bytes 16–31 | `E303-032DG-SMB` (reversed: `BMS-GD230-303E`) |
| machine code | 0x00B9, bytes 32–63 | empty |
| production date | 0x00CC–0x00CD | `00 01 01 00` = not set; show nothing |
| password | 0x00C9–0x00CB | `123456` (default; also the BLE pairing PIN of the [BBH42] unit); not read by ubms: device information and decoded frames go into log exports, and a password the user changed must not end up in bug reports |
| cell count | 0x0031 | 16 |
| Bluetooth module | `AT+VER=?` on the vendor service | `HLK-B40(b.2.02.1202305041115)`; not read by ubms |

As implemented, the device information carries vendor `Daly BMS`, model "Active balancer", the protocol label, the software and hardware version strings as read, and as extra values the reversed strings ("read backwards", **unverified** meaning, 6.4), the machine code when not empty and the cell count of the status block. The production date is shown only when the year byte is 1–99 and month and day are valid; `00 01 01 00` is the placeholder. The version block is read once after connecting; a lost reply leaves only the base fields. The password block is never read (see the table).

## 11. Detection

### 11.1 Bluetooth

1. Chooser filters: the same advertising data as the other Daly definitions (`DL-` and `JHB-` names, Daly manufacturer ids, [DALY] 2.1.1), because the balancer uses the same Daly Bluetooth dongles and its own name is not documented (2.1). The balancer therefore ranks equally with `daly-modbus` and `daly` for every Daly name; registration order decides (11.5).
2. Profile: service 0xFFF0, notify 0xFFF1, write 0xFFF2, write without response preferred. The 0xFF00 fallback of the BMS definitions was not seen on a balancer module; leaving it out also avoids sending D2 frames to JBD BMSes, which use 0xFF00 ([DALY] 11.1).

### 11.2 Serial

9600 8N1 (2.2). The chooser cannot tell what is behind an adapter; the probe decides.

### 11.3 Probe (read only)

The probe writes only the two read requests below. It must not send the app's clock write, `HiLink`, AT commands, the A5 probe or the 0x81 write probe (4.1, 5.3).

1. Send `D2 03 00 00 00 3E D7 B9`. Wait for a reassembled frame `D2 03 7C`, 129 bytes, valid CRC: BLE 1.5 s, serial 1.2 s. Without a frame send it once more (some Daly modules drop the first request after connecting, [DALY] 11.2; the balancer of [SNOOP] answered the first one). No frame: return null.
2. Plausibility: 1 ≤ 0x0031 ≤ 32 (balancers are sold for 3–24 cells, [BAL1A]), every counted cell ≤ 5000 mV, at least one counted cell ≥ 1000 mV, 0x0032 ≤ 8. Do not reject a counted cell near 0 mV: an open sense lead or a wrong cell count reads 0 and must stay visible so that the user can fix it (same reasoning as [JK balancer RS485 probe](jk-balancer.md#112-rs485-probe)). Failure: return null.
3. Status signature: 0x0029 = 30000 and 0x002A = 0 and 0x0030 = 0 and 0x0033 = 0 and 0x0035 = 0 and 0x0036 = 0 and 0x002F = 0. Any other value: return null (a BMS; vectors `bms-rx-status62-*`, `bms-rx-status80-blue-series`).
4. Settings signature: send `D2 03 00 80 00 29 96 5F` (same timeouts, one retry), expect `D2 03 52`, 87 bytes, valid CRC. If 0x0093..0x0096 are all 30000 (no current limits): balancer, confidence 1. If any of them differs: return null (a BMS that happens to be idle with both MOSFETs off, SOC 0 and no cycles; vector `bms-rx-settings-4s`). If no reply: balancer with confidence 0.7 (status signature only).
5. Result: `{ variant: 'DALY_BALANCER_D2', confidence, info: { vendor: 'Daly BMS', protocol } }`. Keep the settings reply as the first settings read.

As implemented: the time per attempt is the value above, shortened to the probe timeout of the session when that is smaller (at least 0.4 s), so a silent device costs two attempts (3 s BLE, 2.4 s serial with the default session timeout of 2.5 s). An exception reply (function 0x83) to the status read returns null; one to the settings read is treated like no reply (confidence 0.7).

The signature rests on one settings capture and three status captures of one firmware plus the cepr reports (**unverified** for other firmware); a balancer that fails it falls through to `daly-modbus`, which shows it as a BMS with zero current, so the failure mode is visible and harmless.

### 11.4 Rejecting foreign devices

| Device | What happens |
| --- | --- |
| Daly D2 BMS | answers step 1, fails step 3 (current, SOC, MOSFETs, cycles) or step 4 (current limits) |
| Daly classic-only BMS (A5) | ignores D2 requests ([DALY] 11.2): two timeouts |
| Daly 0x81 map packs | no D2 answer documented: timeouts |
| Other devices on 0xFFF0 or a serial adapter | no `D2 03 7C` frame with a valid CRC: timeouts; the D2 read request changes no state on any documented device |
| Bluetooth module text on 0xFFF1 | skipped by the assembler (3.5) |

### 11.5 Registration order

Recommended order inside the family: `daly-balancer`, then `daly-modbus`, then `daly` (in `packages/bms-drivers/src/index.js`: the balancer definitions before `...dalyDrivers`).

Reasons:

- `daly-modbus` accepts a balancer: its D2 probe checks only the frame and the cell plausibility ([DALY] 11.2, `daly-modbus` probe), and the balancer passes it. Registered after it, the balancer driver would never run for a Daly name in automatic detection. This is the same arrangement as `jk-balancer-ble` before `jk-ble` ([jk-balancer.md](jk-balancer.md) 11.1).
- `daly` (classic) must come after the balancer on serial: balancers answer classic 0x90 and 0x94 on the UART ([MG], [AC97]) and the classic driver would take them and then stall on 0x93 ([BM239]).
- Cost: a Daly D2 BMS pays one extra 62 register read (63–501 ms on BLE in [SNOOP]); a classic-only Daly device or an 0x81 pack pays up to two balancer timeouts (3 s on BLE, 2.4 s on serial) before `daly-modbus` starts.

Alternative if that delay matters: register the balancer after `daly-modbus` and before `daly`, and make the `daly-modbus` probe return null for the status signature of 11.3 in automatic detection (`statusSignature` in `daly-balancer/protocol.js`, exported as `dalyBalancerStatusSignature`). This needs a change in the `daly-modbus` driver and is not required.

The type selector names a family after the vendor of its first registered definition. The balancer definition therefore uses the vendor `Daly BMS` of the Daly BMS definitions (Daly sells its balancers on dalybms.com, [DPAGE]; the JK balancer does the same with `JK BMS`), so the recommended order does not change the label of the Daly family. The default demo is not affected while the JK family stays first. The tests check the recommended order with a registry built in the test (`dalybal.test.js`, "registry: the family combined with the existing drivers").

## 12. Pitfalls and quirks

1. **`daly-modbus` takes balancers.** It decodes a balancer as a BMS with 0 A, SOC 0 % and both MOSFETs off (11.5).
2. **Temperature slots 7 and 8 are not temperatures.** 0x0026 and 0x0027 repeat the total voltage and the average cell voltage ([SNOOP]); decode only the 0x0032 counted slots. A decoder that reads all eight slots reports 493 °C and 3295 °C.
3. **Statistic registers lag the cells.** 0x002B, 0x002C, 0x0037 and 0x0038 do not match the cells of the same frame (6.1); derive them from the cells.
4. **Cell counts of unused boards.** The settings block shows 16, 6, 6 cells on boards 1 to 3 with a board count of 1 ([SNOOP]); a sum over all three boards gives 28 instead of 16. Sum only the first 0x0082 boards, as the ubms `daly-modbus` D2 schema does (when 0x0082 holds 1 to 3).
5. **BMS registers with neutral values.** The settings block contains BMS protection fields that the balancer fills with 0, 30000 or 5000 (6.3). Never show them as protection settings and never write them.
6. **No pipelining.** Four reads sent within 200 ms produced one damaged frame and three lost replies ([SNOOP] rec 78–82); five reads within 210 ms produced one damaged frame and four lost replies (rec 268–273). Keep one request in flight. On the UART, late replies of a timed-out request can still arrive ([AC97]); discard pending input before a request ([CEPR]).
7. **Bad echo of a good write.** The first switch-on echo had a wrong CRC although the write took effect ([SNOOP] rec 249); verify by reading, not by repeating.
8. **Replies do not name the register.** The 0x00D7 reply `D2 03 02 00 00 3D 96` is byte for byte the "0x00CF = 0" frame used in the [SY] tests, whose comment says it comes from the balancer capture; the capture has no single 0x00CF read. Match replies to requests.
9. **Text on the data characteristic.** AT answers of the Bluetooth module arrive on 0xFFF1 (3.5).
10. **The app probes are writes.** The app's 0x81 probe is a write multiple and its clock frame is a write; the A5 frame uses an undocumented command. Copying the app's start sequence into a probe would write to the device (5.3).
11. **Pairing.** Some balancer dongles require Bluetooth bonding; the PIN `123456` worked on one unit even after the app password was changed ([BBH42]). The operating system asks for it on the first encrypted access.
12. **Sleep.** Factory sleep time 3600 s; after it the balancer stops answering until woken ([BAL1A], [CEPR], **unverified** for the wake sources). Show "asleep or out of range" after repeated timeouts; the user can set 65535 to disable sleep. [SNOOP]'s unit was already set to 65535.
13. **Reversed version strings** (6.4, **unverified**).
14. **Balance current, position and per cell bits** were 0 in every capture (6.2); their scale and meaning are inferred from BMS firmware.
15. **Defaults differ between documents and units.** Start voltage default 3.3 V ([BAL1A], [CEPR] unit) but 3200 mV on the [SNOOP] unit; dual UART model working window 3–3.7 V and start difference 50 mV in [BAL1A] but start difference 20 mV in [SW11]. Read the device; do not assume defaults. The descriptions of both settings name these figures.
16. **Dual UART model behind a BMS.** When UART1 is connected to a K, M or S BMS the balancer is read through the BMS; moving the Bluetooth module from UART1 to UART2 requires restarting the app or the phone's Bluetooth ([SW11] 9.2, [BAL1A] 5 item 7).
17. **The syssi "balancer" faker is a BMS.** `tests/esp32-balancer-ble-example-faker.yaml` in [SY] feeds BMS frames (MOSFETs on, current, SOC); it is not balancer data.
18. **Classic protocol conflict.** Classic requests are answered on the UART by the units of [AC97], [MG] and [D2M] but reportedly not by the unit of [FORUM]; over BLE no classic answer was seen ([SNOOP]). The driver uses D2 only.
19. **0x00CF is not a balancer marker.** Daly BMS boards with an active balancing function also expose it ([SY] issue 28 and pull request 109) and an 0x81 pack reads 0xFFFF ([DALY] 6.4).
20. **Hardware limits.** The UART/RS485 model stops below a 2 V pack and should not be used below 10 V; the board must match the string count of the pack, and different string counts must not be mixed ([BAL1A] 1, 2, 5).
21. **The register 0x00A8 reads 87** on two units and is not shown by the Daly PC software ([CEPR] 4.6, 4.9); its meaning on a balancer is unknown.

## 13. References

All URLs were read on 2026-11-18 or 2026-11-19; commit hashes pin the version used.

[SNOOP] syssi/esphome-daly-bms `docs/pdus/btsnoop_daly_balancer.log` at commit 35afc8f, https://github.com/syssi/esphome-daly-bms/blob/35afc8f/docs/pdus/btsnoop_daly_balancer.log. Android HCI snoop log (btsnoop version 1, datalink 1002, 273 records, ACL only) of the official "Smart BMS" app and a Daly active balancer with an HLK-B40 module, supplied in [SY25]. Decoded for this document: ATT discovery (rec 3–44, 85–126, 131–172), 56 Daly requests (all CRC or checksum valid), 44 reply frames (41 valid, rec 82, 249, 273 damaged), 4 text notifications, reply times 63–501 ms. SHA-256 of the file: 27246841ad81802f8b3709ef16d9bc502fc15db2bbb20583220ae6637c8132c2.

[SY] syssi/esphome-daly-bms, https://github.com/syssi/esphome-daly-bms (commit 35afc8f)
- components/daly_bms_ble/daly_bms_ble.cpp (`DALY_COMMAND_REQ_BALANCER_SWITCH`, `update`, `decode_status_data_` offsets 127–131 for balance bits and current, `decode_balancer_switch_data_`); switch/__init__.py (`SWITCHES` balancer 0x00CF); number/__init__.py (`NUMBERS`, registers 0x0080–0x00A8)
- tests/components/daly_bms_ble/common.h (`BALANCER_SWITCH_FRAME_ON`, `BALANCER_SWITCH_FRAME_OFF`, `SETTINGS_FRAME_1`), daly_bms_ble_test.cpp (`DalyBmsBleBalancerSwitchTest`)
- docs/protocol-register-map.md (D2 and 0x81 register map, balancer state 0 off, 1 passive, 2 active); tests/esp32-balancer-ble-example-faker.yaml (BMS frames)
- issue 28 (felipecrs: balancer switch on a BMS, app screenshot [IMG]), pull request 109 (poll 0x00CF; the app reads 0x00CC–0x00D0), pull request 114 (route replies by request address), https://github.com/syssi/esphome-daly-bms/issues/28, /pull/109, /pull/114

[SY25] syssi/esphome-daly-bms issue 25 (leodesigner, 2024-11-06/07: Daly 3–24S 1 A smart active balancer, captured switch frames, `balancer_snoop.log`, LED reacts to 0x00CF writes, request for balance current and balance position sensors), https://github.com/syssi/esphome-daly-bms/issues/25

[IMG] app screenshot attached to [SY] issue 28: "Active balance" page of `DL-F28BBED000824` (balance status, balance current, balance position; settings balance current 1.0 A, battery strings 8, discharge high and low temperature protection 70 °C and −35 °C, sleep waiting time 3600 s, balanced open diff volt 0.02 V, balanced open start volt 3.40 V, equalized cut-off voltage 3.70 V, balance switch ON)

[CEPR] cepr/daly-to-lithium-balance-adapter at commit 9449b16, https://github.com/cepr/daly-to-lithium-balance-adapter
- DALY_Active_Balancer_UART_Protocol.md: sections 2 (physical layer, quoting the Daly UART/485 protocol V1.2), 3 (which protocol, summary of [FORUM]), 4.5–4.8 (register tables and ready-made frames), 4.9 (hardware validation log: 0x0089 = 1, 0x008A = 3600, 0x00A3 = 3300, 0x00A4 = 20, 0x00A8 = 87, write to 0x008A echoed), 6, 7, 9
- firmware/core/src/daly.rs (`REALTIME_REQUEST`, `REALTIME_REPLY_LEN`, test `reference_frames`), firmware/board/src/main.rs (`BALANCER_POLL` 500 ms, `BALANCER_TIMEOUT` 1000 ms with the 510 ms measurement, `drain`, `DISABLE_SLEEP`), firmware/README.md (open points: 0x0020 board temperature and the 80 register read confirmed), README.md (four balancers, isolation concept), daly/fake_balancer.py (emulator, not evidence)

[AC97] acpiccolo/Daly-BMS issue 97 "Default timeout too short for a 20 cells BMS" (cepr, 2026-10-17: classic 0x94 and 0x95 timing of a 20S Daly active balancer), https://github.com/acpiccolo/Daly-BMS/issues/97; pull request 98 (default timeout 1 s, `FrameReader` resynchronising on 0xA5 "Some BMS (e.g. the Daly active balancer) reply slowly"), https://github.com/acpiccolo/Daly-BMS/pull/98

[MG] matthewgream/DalyBMSInterface, https://github.com/matthewgream/DalyBMSInterface: README ("tested on a Daly Smart BMS device and balancer", separate balancer with its own serial interface), DalyBMSManager.hpp (capability table: Managing, Balancing, TemperatureSensing per request), DalyBMSRequestResponseTypes.hpp (command codes)

[D2M] softwarecrash/Daly2MQTT issue 140 "Add support for smart active balancer" (maintainer: balancers use the BMS protocol, no currents; 12S user confirmed), https://github.com/softwarecrash/Daly2MQTT/issues/140

[BBH42] patman15/BMS_BLE-HA issue 42 "DALY Smart Active BALANCER - Can't connect" (15S balancer, pairing with PIN 123456, readable afterwards), https://github.com/patman15/BMS_BLE-HA/issues/42

[BM239] fl4p/batmon-ha issue 239 "Daly Smart Active Balancer (not bms)" (maintainer comment 2026-09-03 on 0x93), https://github.com/fl4p/batmon-ha/issues/239

[AIO] patman15/aiobmsble at commit 95a6421, https://github.com/patman15/aiobmsble: aiobmsble/bms/daly_bms.py (`matcher_dict_list`, D2 reads 0x0000 × 62, 0x003E × 9, 0x00A9 × 32), tests/bms/test_daly_bms.py (`_DEV_DEFS` version strings)

[PYD31] dreadnought/python-daly-bms issue 31 "Characteristic 17 not found" (GATT listing with the FFF0 and 02f00000…fe00 services), https://github.com/dreadnought/python-daly-bms/issues/31

[BAL1A] Daly "DALY Smart Active Balance Module Instruction" (UART/RS485 and dual UART models), https://www.dalyelec.com/images/ZDJHR/%E8%8B%B1%E6%96%87/Smart%20Active%20Balance%20Module%C2%A0(1A).pdf (link as given by [CEPR] 9)

[SW11] Daly "Software active balance module V1.1 specification" (revisions A0 2024-06-05, A1 2024-09-15): 2.1 technical parameters, 4 interface definition, 7 Bluetooth display and 8 PC display (app and BMS Tool V1.14.14 screenshots of the active balance page), 9 wiring with and without a K/M/S BMS. Read from PDF copies named sw_active_balance_v11.pdf, smart_balanced_daly_inf.pdf and anleitung_daly_active_balancer.pdf (same content); no public Daly URL was recorded

[ABMS] Daly "Smart Active Balance BMS User Manual" (R24T* 1 A balancing BMS models), PDF copy active_balance_bms_en.pdf; no public Daly URL was recorded

[DPAGE] Daly product page "Active Balance Module (1A/5A)", https://www.dalybms.com/active-balance-module-1a5a/

[VL] Daly Modbus register lists in syssi/esphome-daly-bms docs: dalyModbusProtocol.xlsx and modbus_protocol.xlsx (sheets "protocol" and "register descriptions" / "Registers"), https://github.com/syssi/esphome-daly-bms/tree/35afc8f/docs

[FORUM] DIY Solar Forum "Intelligent balance system by Daly", https://diysolarforum.com/threads/intelligent-balance-system-by-daily.98570/ (HTTP 403 when read; content only as summarised in [CEPR] 3)

[DALY] ubms Daly BMS specification, [daly.md](daly.md): sections 2.1 (BLE layouts), 3.2–3.3 (D2 frames, reassembly), 5.4 (D2 requests), 6.3 (D2 register map), 9.1–9.2 (fault bits), 10.2 (version block), 11.2 (probe sequence)
