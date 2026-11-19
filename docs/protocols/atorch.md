# Atorch meters and electronic loads ("FF 55" protocol)

Implementation reference for the ubms Atorch driver: the "FF 55" report and command protocol spoken by Atorch electronic loads (DL24, DL24P, DL24M), DC meters (DT24 family, DT3010), USB testers (UD18, UD24, J7-C, J7-H) and AC meters (AT3010, S1 / S1-B, AT24) over their Bluetooth modules, plus the older "PX100" frames (`B1 B2 ... B6`) that the DL24 family accepts on the same byte stream for load control.

Compiled 2026-11-19 from the source code, tests and issue logs of the open-source projects listed in section 13, two decompilations of the vendor app "E-test" published by third parties, and captures posted by users. Every statement carries a source tag. **unverified** marks a value that has a single source, was inferred, or conflicts between sources.

Test vectors: `packages/bms-drivers/test/vectors/atorch.json` (81 frames: reports, replies, commands, PX100 frames). Field names written in `code` in this document are the keys used in the `expected` objects of that file, always in model units (V, A, W, Ah, Wh, °C, s): `energy` is in Wh for every device type, `capacity` in Ah, `runtime` in seconds. Further keys: `checksumValid` (rule of section 3.2), `checksumFrom3Valid` (the variant of section 3.2 that starts at byte 3), `notifications` (the BLE notification pieces in arrival order when a source shows a split), `replyType` and `status` (replies), `command`, `name`, `value`, `checksum` (commands), `frame`, `d1`, `d2`, `value` (PX100 frames). `link` is `ble` when at least one cited source used the frame over BLE and `uart` when the sources used only a serial link (Bluetooth SPP, section 2.1, or the USB serial port, section 2.2). Every FF 55 frame in that file was checked with a node script: length per message type, checksum per section 3.2, and, for frames copied from a source, presence of the exact bytes (and of every BLE notification piece) in the cached copy of that source.

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

- Offsets are byte offsets from the first header byte (0xFF) of the frame, written as decimal with hex in parentheses, e.g. 13 (0x0D).
- Types: u8, u16, u24, u32. All multi-byte values are unsigned big-endian. No field of any source is signed.
- Atorch checksum = (sum of the covered bytes) modulo 256, XOR 0x44 (section 3.2).
- Scale: physical value = raw × scale. "0.01 kWh" means one raw unit is 10 Wh.
- Device type names used in this document and in the `variant` field of the vectors: `AC_METER` (type byte 0x01), `DC_METER` (0x02), `USB_METER` (0x03); `DL24_PX100` for the PX100 frames of section 3.5.
- Source tags (details in section 13): [SY] syssi/esphome-atorch-dl24 (code, tests, issues, discussions), [NL] NiceLabs/atorch-console, [MS] msillano/UD18-protocol-and-node-red, [LP] lispnik/ud18 (UD18 over BLE, with a decompile of E-test 2.0), [DV] devanlai/webvoltmeter REVERSE.md (J7-H, with a decompile of the Android app), [FT] Flaviu Tamas "DL24M reversing" (DL24M, with a decompile of the Android app), [TS] Shaddack's sw_dl24 (DL24 over Bluetooth SPP, both protocols), [WH] whisker73 DL24 Android Monitor (DL24 over BLE, both protocols), [RT] RobThree/LibAtorch (PX100 over USB serial), [KO] koedame/usbmeter, [DW] dallanwagz/atorch-ble, [JC] jakubcizek/atorch-dl24-dashboard (DL24P over Web Bluetooth), [ORD] ordinoscope.net DL24P page (commands of the Windows app), [AS] auto-scripting.com "Atorch DL24 hack 1" (DL24 captures of the E-test app), [BK] bukys.eu PowerMon (UD18, UD24, S1-B), [WR] Werner Rothschopf DT24HD page, [AF] Arduino forum thread 943891 (J7-C raw frames with display values).

## 1. Overview

### 1.1 Device types and models

The report frame carries a device type byte (offset 3). It selects the field layout; the model itself is not transmitted.

| Type byte | Class | Models seen with this type | Sources |
| --- | --- | --- | --- |
| 0x01 | AC meter | AT3010 energy meter; S1 smart socket (S1-B, names S1BP_BLE, S1WP_BLE); AT24 (listed as AC meter by [NL]) | [SY] issue 94 and 60, [NL] README, [BK], tiede and meneerthijs loggers |
| 0x02 | DC meter and electronic load | DL24, DL24P, DL24M (also "Purple" edition), DT24 family (DT24PW, DT24TW-300A), DT3010 | [SY] README, docs/pdus, issues 10, 59, 73, 76, 91, 104, discussion 107; [JC]; [FT] |
| 0x03 | USB meter | UD18, UD24, J7-C (advertises as UC96_BLE), J7-H (advertises as JDY-19); T18 and UD18-L listed by [NL] without frames | [MS], [LP], [NL] README, [AF], [DV], [KO], [BK] |

Notes:

- The DL24 family (DL24, DL24P, DL24M) are electronic loads that report as DC meters (type 0x02). The PX100 frames of section 3.5 are documented only for DL24 and DL24P; DL24M support is unknown.
- The class of AT24 and AT2401 is not settled: [NL] lists AT24 as an AC meter ("TESTED"), no frame of either model was found, and AT2401 appears in no source (**unverified**). A driver must use the type byte of the received report, never the advertised name, to choose the layout.
- Atorch devices with a different protocol (not covered here): Q7-T, A3-B, KM001 ([SY] README, [NL] README). Some newer Atorch branded loads use a Tuya BLE module and data points ([SY] issue 110; out of scope, **unverified**).

### 1.2 Two protocols on one byte stream

1. **FF 55 protocol** (all devices): the device pushes a 36-byte report every second without being asked; the host may send 10-byte commands that mostly simulate the front panel keys or reset the counters; the device answers each command it parses with an 8-byte reply ([NL], [SY], [LP], [TS]).
2. **PX100 protocol** (DL24 family only): fixed 6-byte requests `B1 B2 cmd d1 d2 B6` that set the load current, the cutoff voltage and the timer, switch the load on or off, and query settings and measurements; answers are the single byte `6F` or the 7-byte `CA CB d1 d2 d3 CE CF` ([TS], [RT] over USB serial or Bluetooth SPP; [WH] over BLE). Over BLE only [WH] uses it: **unverified** for BLE.

The FF 55 protocol has no command that sets the load current, the cutoff voltage or the timer directly; on FF 55 these settings are only reachable through key presses (setup, enter, plus, minus).

### 1.3 Telling variants apart at runtime

- Device class: byte 3 of the first valid report (0x01, 0x02, 0x03). syssi locks the type after the first report ([SY] tests `AtorchDL24DeviceTypeTest.LockedAfterFirstFrame`).
- Model: only the advertised name (section 11.1) hints at it. There is no device information frame (section 10).
- Electronic load or plain DC meter: not distinguishable from the frames. A name starting with "DL24" is the only hint of a load; PX100 control is documented for the DL24 and DL24P names only (section 1.1).
- Checksum behaviour differs per model and firmware (section 3.2); a driver learns it from the stream (section 11.2).

## 2. Physical links

### 2.1 BLE

The Bluetooth module is a transparent UART bridge to the meter MCU: the same bytes appear on the internal UART, on Bluetooth Classic SPP and on BLE ([FT]: "the BLE data is exactly the same as what can be found by serial on the board"; module BP0D608-68A2 by Zhuhai Jieli on a DL24M; [DV]: J7-H module advertises as JDY-19).

| Item | Value | Sources |
| --- | --- | --- |
| Service | `0000FFE0-0000-1000-8000-00805F9B34FB` (0xFFE0) | all |
| Report and command characteristic | 0xFFE1, properties 0x1C (write without response, write, notify); the J7-H also has read | [SY] README log and issue 10, issue 94 log; [LP]; [DV] |
| Second characteristic | 0xFFE2, properties 0x0C (write without response, write), present on a DL24_BLE, a DL24-BLE, the AT3010-BLE and a UD18; absent on the J7-H, whose service has a single characteristic | [SY] issue 10 and 94 logs; [LP] ("write-only, purpose unknown"); [DV] |
| Notifications | about one report per second, forever, after notifications are enabled; the J7-H enables them by itself on connect | [LP], [MS], [TS], [FT], [DV] |
| MTU | 248 (DL24_BLE), 247 (UD18), 136 (AT3010) negotiated by ESP32 / BlueZ clients | [SY] issue 10 and 94 logs, [LP] |
| Pairing | none; no PIN in any source | all |
| Other services | 0x1800 (every GAP characteristic returns the name on a UD18), 0x1801 | [LP], [SY] logs |

Writing commands: write to 0xFFE1 ([LP], [JC], [WH], [DV], [KO], [FT]). syssi writes to 0xFFE2 without response and logs an error when 0xFFE2 is missing ([SY] atorch_dl24.cpp `DL24_COMMAND_CHARACTERISTIC_UUID`, `gattc_event_handler`); [AS] also used 0xFFE2 on a DL24-BLE. Use 0xFFE1, with write-with-response when the property is present: [LP] found that an acknowledged write is the only way to tell a lost command from an ignored one.

Advertising ([SY] issue 10 and 94 logs, [DV]):

- Older modules (DL24_BLE): flags, the 16-bit service list `FFE0` and the name.
- Newer modules (DL24-BLE, AT3010-BLE, J7-H): service list `FFE0, FEE7` and manufacturer data whose company id differs per unit (0x8DC1 on a DL24-BLE, 0x26FE on the AT3010-BLE, 0x4AEA on a J7-H) and whose payload is `88 A0` followed by six bytes close to the device address (e.g. `88 A0 19 10 24 13 03 EE` for address 19:10:24:14:03:EE). JK BMS modules use the same `88 A0` layout (company 0x0B65, [jk.md](jk.md) section 11.1), so manufacturer data cannot identify Atorch.

Bluetooth Classic SPP: most models also expose an SPP device named `<MODEL>_SPP` or `<MODEL>-SPP` (DL24M_SPP, DT24PW_SPP, UD18-SPP, AT24-SPP) that carries the same stream ([NL] protocol-design.md, [SY] issues 76 and 104, [TS] uses /dev/rfcomm0, [AF]). Web Bluetooth cannot open SPP; an OS-paired SPP port opened with Web Serial at 9600 baud would carry the same frames (**unverified**, no source tried it).

### 2.2 Wired serial

DL24 and DL24P have a micro USB port with a CH340 bridge (1a86:7523), 9600 baud 8N1, with the same FF 55 frames ([ORD], [TS], [RT]); DT24 and UD18 variants have a TTL serial output at 9600 baud ([WR]); the DL24M board exposes the BLE module UART on J5 ([FT]). Not needed for a BLE driver; recorded for a later serial profile.

## 3. Frame formats

### 3.1 General layout

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 (0x00) | 2 | header `FF 55` | |
| 2 (0x02) | 1 | message type | 0x01 report (device to host, 36 bytes), 0x02 reply (device to host, 8 bytes), 0x11 command (host to device, 10 bytes) |
| 3 (0x03) | 1 | device type (report, command) or reply type (reply) | section 1.1 |
| 4 (0x04) | n | payload | report 31 bytes, reply 3 bytes, command 5 bytes |
| last | 1 | checksum | section 3.2 |

There is no length byte and no end marker; the message type defines the length ([NL] protocol-design.md "Packet layout" and "Type indicator", [SY] `assemble`, [TS], [LP]). Commands of any other length are dropped without a reply ([LP]).

### 3.2 Checksum

checksum = (sum of bytes 2 .. n-2) mod 256, XOR 0x44, where n is the frame length. The covered bytes start at the message type byte and end at the byte before the checksum; the header `FF 55` is not covered ([NL] "Checksum Algorithm", [SY] `crc`, [TS], [LP], [BK]; the decompiled app computes exactly this for its commands: [FT], [LP]).

Worked example ([NL]): `FF 55 11 03 31 00 00 00 00 01`: 0x11 + 0x03 + 0x31 = 0x45; 0x45 XOR 0x44 = 0x01.

Devices whose reports carry a valid checksum: DL24 firmware V5.1 and DL24-BLE ([SY] docs/pdus, issue 10), DT3010 ([SY] docs/pdus), AT3010 (all 37 frames of [SY] issue 94), UD18 (321 of 321 BLE frames of [LP], 91 of 91 SPP frames of the [NL] capture), J7-H ([DV]), the [NL] samples. Replies carry a valid checksum in every source.

Devices whose last byte is **not** a valid checksum (a driver must still accept their reports, section 11.2):

| Device | Behaviour | Sources |
| --- | --- | --- |
| DL24M firmware 2.0 and 2.1 ("Purple") | identical payload with a different last byte every second, i.e. not computed | [SY] issues 59, 76, README ("requires a disabled CRC check"); [FT] frames |
| DT24TW-300A, DL24 sold in 2025 | last byte 0x23 in every frame while the content changes | [SY] issue 73, discussion 107 |
| DT24PW | needs `check_crc: false` in syssi; no frame published | [SY] README, issue 104 (**unverified**) |
| S1 AC meter | 12 of 12 frames fail | [SY] issue 60, tests/esp32-atorch-s1.yaml |
| J7-C | 12 of 12 ([SY] docs/pdus/atorch-j7-c.txt) and 5 of 5 ([AF]) frames fail; a search over additive sums, XOR sums and all CRC-8 polynomials (init 0x00 or 0xFF, reflected or not, any final XOR) over every range starting at bytes 0..4 and ending at bytes 26..34 found no rule (this research) | [SY] README, [AF], [KO] `checksum_ok` |
| J7-C (another unit) | last byte = (sum of bytes **3** .. 34) XOR 0x44, i.e. the standard rule without the message type byte; the source claims 639 frames (one frame published) | [DW] CHANGELOG 0.1.1, `decode_usb_meter` (**unverified**, single source) |

A random byte matches the checksum with probability 1/256, so one matching frame proves nothing; [KO] treats a meter as checksum-capable only after 5 matching reports in a row (`CHECKSUM_PROOF`).

### 3.3 Reassembly

- Reports arrive as one 36-byte notification (large MTU) or split: 20 + 16 bytes ([SY] issues 10, 73, 94; [DV]), 30 + 6 bytes ([SY] issue 33); replies as 4 + 4 bytes ([SY] issue 33). Notifications may also contain the tail of one frame and the start of the next ([KO] test data "a stream that starts in the middle of a frame and has a reply between two reports").
- Find `FF 55`, read the message type, wait for the full length (36, 8 or 10), then validate. On an unknown message type or a failed validation, skip the `FF` and search again from the next byte; `FF 55` may occur inside data. syssi instead clears its buffer at every notification that starts with `FF 55` and drops unknown types ([SY] `assemble`).
- A host never receives type 0x11 frames, but [WH] accepts them in its parser; treat them as noise.
- The BLE module itself may inject ASCII text such as `AT+BDUD18_SPP` into the stream after it received text (section 12); skip bytes that do not start a frame.
- When PX100 frames (section 3.5) are used, their answers `6F` and `CA CB d1 d2 d3 CE CF` arrive on the same notification stream ([WH] `handleData`). Interpret them only while a PX100 request is pending and only when they are not inside an FF 55 frame.

### 3.4 Command frame (host to device)

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | `FF 55` | |
| 2 | 1 | 0x11 | message type command |
| 3 | 1 | device type | must equal the type byte of the reports, otherwise the reply status is 0x02 ([LP]); syssi falls back to 0x02 before the first report ([SY] atorch_button.cpp `press_action`) |
| 4 | 1 | opcode | section 5.2 |
| 5 | 4 | value, u32 BE | 0 when unused; the decompiled app leaves byte 5 at zero and writes a 24-bit value to bytes 6..8 ([FT], [LP]), identical frames for every value it can send |
| 9 | 1 | checksum | over bytes 2..8 |

[DV] describes the value bytes as `a3 00 a4 a5` and the price as little-endian; both decompilations of [FT] and [LP] contradict that, and [NL] writes u32 BE. Use u32 BE.

### 3.5 PX100 frames (DL24 family only)

| Frame | Bytes | Notes |
| --- | --- | --- |
| request | `B1 B2 cmd d1 d2 B6` (6 bytes) | no checksum, fixed prefix and suffix |
| set acknowledgement | `6F` (1 byte) | answer to commands 0x01..0x05 |
| query reply | `CA CB d1 d2 d3 CE CF` (7 bytes) | answer to queries 0x10..0x19, value = u24 BE `d1 d2 d3` |

Invalid commands get no answer; the request times out ([TS]). Sources: [TS] section "PX100 protocol" and "transaction examples", [RT] Request.cs, CommandType.cs, QueryType.cs, AtorchDevice.cs, [WH] DL24Protocol.kt and BleManager.kt, and the older protocol description misdoro/Electronic_load_px100 "protocol_PX-100_2_70.md" cited by [TS].

## 4. Session flow

### 4.1 BLE (FF 55)

1. Connect, discover service 0xFFE0, take 0xFFE1, start notifications. Look up 0xFFE2 but do not require it.
2. Do not write anything. Reports arrive about once per second ([LP], [TS], [MS], [FT]; [SY] issue 94 log: 22:04:16, 22:04:17, 22:04:18).
3. The first report that passes section 11.2 fixes the device type; decode every following report with that layout.
4. Commands: one at a time, 10 bytes, device type of the reports, written to 0xFFE1. Wait for the reply (8 bytes, status 0x01) up to about 2 s, then give up without retrying (key presses are not idempotent, [LP]). Keep at least 200–300 ms between commands ([JC] debounce 300 ms, [WH] 200 ms between sequential writes).
5. Before a command, check that reports still arrive: [LP] observed UD18 units whose notification path stops while writes are still acknowledged; a command sent then has an effect nobody can confirm. [LP] waits up to 12 s for a live report and otherwise does not send.
6. Expect missing replies: the DT24PW logged no reply to reset all and kept counting ([SY] issue 104); the reply rate of a UD18 decays with use since power on ([LP]).

### 4.2 PX100 on the same link (DL24 family, unverified over BLE)

1. Only after the FF 55 reports identified a DC meter named as a DL24 or DL24P. A DL24M is never asked: its PX100 support is unknown (section 1.1).
2. Send one PX100 request, wait up to about 1 s for `6F` (set) or `CA CB .. CE CF` (query), then continue. [WH] polls the load state (0x10) every 5 s and also queries the presets 0x17..0x19.
3. Changing the current, cutoff or timer while the load runs is what the front panel does too; ubms must still confirm every write with the user (section 7).

## 5. Commands

### 5.1 FF 55 opcodes

| Opcode | Name (`name` in the vectors) | Value | Effect and support | Sources |
| --- | --- | --- | --- | --- |
| 0x01 | `resetEnergy` | 0 | clears accumulated energy (app text "accumulated energy will be cleared"; on AC and DC models also CO2 and cost, which the app computes from energy) | [NL], [SY], [DV], [LP], [AS], [ORD] |
| 0x02 | `resetCapacity` | 0 | clears accumulated capacity; **S1-B: toggles the internal relay** ([BK], **unverified**) | [NL], [SY], [DV], [LP], [AS] |
| 0x03 | `resetRuntime` | 0 | clears the duration counter (verified on a DL24: next report 0:00:00, [SY] issue 33; on a UD18, [LP]) | [NL], [SY], [LP], [AS] |
| 0x04 | none | | no reaction on a DL24 | [AS] |
| 0x05 | `resetAll` | 0 | clears energy, capacity and duration (DL24: [AS] "timing, energy, cap reset", although the frame printed there carries checksum 0x54 instead of 0x5C); the app never sends it to a UD18 ([LP]) | [NL], [SY], [AS], [ORD] |
| 0x06 | none | | no reaction on a DL24, but the frame of [AS] carries checksum 0x55 instead of 0x5D | [AS] |
| 0x11 | `plus` | 0 | [+] key for AC and DC meters per [NL]; no effect on a DL24M Purple ([SY] issue 76); unsupported on a UD18 ([LP]) | [NL], [SY] |
| 0x12 | `minus` | 0 | [-] key for AC and DC meters per [NL]; same limits as 0x11 | [NL], [SY] |
| 0x21 | `setBacklight` | 0–60 s | backlight time; 0 = always off, 60 = always on; unsupported on a UD18 ([LP]); [DV] reads the app range as 1–59 | [NL], [SY], [DV] |
| 0x22 | `setPrice` | 1–999999 | price per kWh in 0.01 units ([NL] UI sends price × 100); unsupported on a UD18 | [NL], [SY], [DV] |
| 0x31 | `setup` | 0 | Setup key (DL24: move cursor / settings; works on DL24M Purple) | [NL], [SY], [AS], [ORD], [LP] |
| 0x32 | `enter` | 0 | Enter key; on the DL24 family the ON/OFF key, which **toggles** the load | [NL], [AS], [TS], [JC], [ORD], [LP] |
| 0x33 | `plusUsb` | 0 | [+] key for USB meters per [NL]; the vendor apps send 0x33 for [+] on DL24, DL24P, DL24M and J7-H too ([FT] and [DV] decompiles, [ORD], [SY] issue 76 btsnoop) | [NL], [MS], [LP], [FT], [DV], [ORD] |
| 0x34 | `minusUsb` | 0 | [-] key, same remarks as 0x33 | same |

Recommendation: send 0x33 / 0x34 for [+] / [-] on every device type (that is what the vendor apps do); 0x11 / 0x12 only as an option for AC meters (**unverified** on any AC meter).

### 5.2 FF 55 command frames

Checksums computed with section 3.2 and checked by the vector script. Frames that a source shows byte for byte are marked in the vectors with `expectedComputed: false`.

| Opcode | Action | AC meter (0x01) | DC meter / DL24 (0x02) | USB meter (0x03) |
| --- | --- | --- | --- | --- |
| 0x01 | Reset energy | `FF 55 11 01 01 00 00 00 00 57` | `FF 55 11 02 01 00 00 00 00 50` | `FF 55 11 03 01 00 00 00 00 51` |
| 0x02 | Reset capacity | `FF 55 11 01 02 00 00 00 00 50` | `FF 55 11 02 02 00 00 00 00 51` | `FF 55 11 03 02 00 00 00 00 52` |
| 0x03 | Reset duration | `FF 55 11 01 03 00 00 00 00 51` | `FF 55 11 02 03 00 00 00 00 52` | `FF 55 11 03 03 00 00 00 00 53` |
| 0x05 | Reset all | `FF 55 11 01 05 00 00 00 00 53` | `FF 55 11 02 05 00 00 00 00 5C` | `FF 55 11 03 05 00 00 00 00 5D` |
| 0x11 | [+] (0x11) | `FF 55 11 01 11 00 00 00 00 67` | `FF 55 11 02 11 00 00 00 00 60` | `FF 55 11 03 11 00 00 00 00 61` |
| 0x12 | [-] (0x12) | `FF 55 11 01 12 00 00 00 00 60` | `FF 55 11 02 12 00 00 00 00 61` | `FF 55 11 03 12 00 00 00 00 62` |
| 0x31 | Setup | `FF 55 11 01 31 00 00 00 00 07` | `FF 55 11 02 31 00 00 00 00 00` | `FF 55 11 03 31 00 00 00 00 01` |
| 0x32 | Enter (DL24: load toggle) | `FF 55 11 01 32 00 00 00 00 00` | `FF 55 11 02 32 00 00 00 00 01` | `FF 55 11 03 32 00 00 00 00 02` |
| 0x33 | [+] (0x33) | `FF 55 11 01 33 00 00 00 00 01` | `FF 55 11 02 33 00 00 00 00 02` | `FF 55 11 03 33 00 00 00 00 03` |
| 0x34 | [-] (0x34) | `FF 55 11 01 34 00 00 00 00 02` | `FF 55 11 02 34 00 00 00 00 03` | `FF 55 11 03 34 00 00 00 00 0C` |
| 0x21 | Backlight 30 s | `FF 55 11 01 21 00 00 00 1E 15` | `FF 55 11 02 21 00 00 00 1E 16` | `FF 55 11 03 21 00 00 00 1E 17` |
| 0x21 | Backlight always on (60) | `FF 55 11 01 21 00 00 00 3C 2B` | `FF 55 11 02 21 00 00 00 3C 34` | `FF 55 11 03 21 00 00 00 3C 35` |
| 0x22 | Price 1.00 (raw 100) | `FF 55 11 01 22 00 00 00 64 DC` | `FF 55 11 02 22 00 00 00 64 DD` | `FF 55 11 03 22 00 00 00 64 DE` |

Seen byte for byte in sources: every 0x01 column frame with value 0 and `FF 55 11 01 21 00 00 00 01 70`, `FF 55 11 01 22 00 00 00 01 71` ([SY] button/__init__.py comments); in the 0x02 column 0x01, 0x05, 0x31, 0x32, 0x33, 0x34 ([ORD], Windows app), 0x01, 0x02, 0x03, 0x04, 0x31, 0x32, 0x33, 0x34 ([AS], E-test app), 0x03 ([SY] issue 33), 0x11, 0x12, 0x33, 0x34, 0x31 ([SY] issue 76), `FF 55 11 02 FF 00 00 00 00 56` (unknown opcode, [TS]); in the 0x03 column 0x01, 0x02, 0x03, 0x05, 0x31, 0x32, 0x33, 0x34 ([MS], [BK], [TS]) and `FF 55 11 03 31 00 00 00 00 01` ([NL] checksum example). All of them agree with section 3.2, except two frames of [AS]: opcode 0x05 with checksum 0x54 and opcode 0x06 with 0x55 (the rule gives 0x5C and 0x5D). They look extrapolated from the 0x50..0x53 of opcodes 0x01..0x04; since [AS] reports that 0x05 reset everything, either that table was typed by hand or the DL24 does not check command checksums (**unverified**). Always send the correct checksum.

### 5.3 PX100 requests (DL24 family)

| Cmd | Request | Meaning | Answer | Sources |
| --- | --- | --- | --- | --- |
| 0x01 | `B1 B2 01 01 00 B6` / `B1 B2 01 00 00 B6` | load on / load off (explicit, not a toggle) | `6F` | [TS], [RT] `ToggleLoad` with `LoadState.On/Off`, [WH] `directOutput` |
| 0x02 | `B1 B2 02 <A> <cA> B6` | set load current: d1 = whole amperes, d2 = hundredths 0–99 (binary); 1.50 A = `B1 B2 02 01 32 B6` | `6F` | [TS], [RT] `DoubleToByteArray`, [WH] `directCurrent` (slider 0–20 A) |
| 0x03 | `B1 B2 03 <V> <cV> B6` | set cutoff voltage, same encoding; 10.50 V = `B1 B2 03 0A 32 B6` | `6F` | [TS], [RT], [WH] (slider 0–200 V) |
| 0x04 | `B1 B2 04 <hi> <lo> B6` | set timer, u16 BE seconds; 3600 s = `B1 B2 04 0E 10 B6`; the device keeps whole minutes ([WH], **unverified**) | `6F` | [TS], [RT] `TimespanToByteArray`, [WH] `directTimer` |
| 0x05 | `B1 B2 05 00 00 B6` | reset counters | `6F` | [TS], [RT] |
| 0x10 | `B1 B2 10 00 00 B6` | query load state | d3 = 0 off, 1 on (`CA CB 00 00 00 CE CF` = off, [TS] transaction) | [TS], [RT], [WH] |
| 0x11 | `B1 B2 11 00 00 B6` | query voltage | u24 mV | [TS], [RT] (/1000) |
| 0x12 | `B1 B2 12 00 00 B6` | query current | u24 mA | [TS], [RT] |
| 0x13 | `B1 B2 13 00 00 B6` | query elapsed time | d1 h, d2 min, d3 s | [TS], [RT] |
| 0x14 | `B1 B2 14 00 00 B6` | query capacity | u24 mAh | [TS], [RT] |
| 0x15 | `B1 B2 15 00 00 B6` | query energy | u24 mWh | [TS], [RT] |
| 0x16 | `B1 B2 16 00 00 B6` | query MOSFET temperature | u24 °C | [TS], [RT] |
| 0x17 | `B1 B2 17 00 00 B6` | query current setting | u24 in 10 mA (150 = 1.50 A) | [TS] "10s mA", [RT] (/100), [WH] |
| 0x18 | `B1 B2 18 00 00 B6` | query cutoff voltage setting | u24 in 10 mV | [TS] "10s mV", [RT] (/100), [WH] |
| 0x19 | `B1 B2 19 00 00 B6` | query timer setting | d1 h, d2 min, d3 s | [TS], [RT], [WH] |

The FF 55 report stays the primary data source; the PX100 queries give finer resolution (mV, mA, mAh, mWh) than the report (0.1 V, 1 mA, 10 mAh, 10 Wh).

## 6. Responses

### 6.1 AC meter report (device type 0x01), 36 bytes

| Offset | Type | Field | Scale | Notes | Sources |
| --- | --- | --- | --- | --- | --- |
| 0 (0x00) | 2 | header `FF 55` | | | all |
| 2 (0x02) | u8 | message type 0x01 | | | all |
| 3 (0x03) | u8 | device type 0x01 | | | all |
| 4 (0x04) | u24 | `voltage` | 0.1 V | | [NL], [DV], [FT], [SY] |
| 7 (0x07) | u24 | `current` | 0.001 A | | [NL], [DV], [FT], [SY] |
| 10 (0x0A) | u24 | `power` | 0.1 W | active power; on the AT3010 frame of the vectors 232.2 V × 2.506 A × PF 0.947 = 551.0 W matches the raw 5510. syssi decodes these bytes as capacity (0.01 Ah) for AC too, which is wrong | [NL], [DV], [FT] decompile; [SY] |
| 13 (0x0D) | u32 | `energy` | 0.01 kWh (10 Wh) | the app prints raw / 100 as "KWH" ([FT], [DV]); on the AT3010 of the vectors the counter stays unchanged from 22:04:16 to at least 22:04:45 at about 550 W and has advanced by one raw unit at 22:04:56, which fits 10 Wh per unit (about 65 s at 550 W) and rules out 0.01 Wh (15 steps per second). [NL] says "W·h / 100", which is wrong by a factor of 1000. syssi publishes raw × 10 Wh | [FT], [DV], [SY]; [SY] issue 94 log |
| 17 (0x11) | u24 | `price` | 0.01 per kWh | currency free | [NL], [DV], [SY] |
| 20 (0x14) | u16 | `frequency` | 0.1 Hz | | [NL], [DV], [FT], [SY] |
| 22 (0x16) | u16 | `powerFactor` | 0.001 | | [NL], [DV], [FT], [SY] |
| 24 (0x18) | u16 | `temperature` | 1 °C | internal sensor | [NL], [DV], [FT], [SY] |
| 26 (0x1A) | u16 | runtime hours | 1 h | `runtime` = hours × 3600 + minutes × 60 + seconds; always zero on the AT3010 | [NL], [SY]; [SY] issue 94 |
| 28 (0x1C) | u8 | runtime minutes | | | [NL], [SY] |
| 29 (0x1D) | u8 | runtime seconds | | | [NL], [SY] |
| 30 (0x1E) | u8 | `backlight` | 1 s | 0 = always off, 60 = always on, otherwise seconds | [NL] `FormattedBacklightTime`, [DV], [LP] |
| 31 (0x1F) | 4 | unused | | zero in every frame | [SY] ("Unknown") |
| 35 (0x23) | u8 | checksum | | section 3.2; not valid on the S1 | |

### 6.2 DC meter and electronic load report (device type 0x02), 36 bytes

| Offset | Type | Field | Scale | Notes | Sources |
| --- | --- | --- | --- | --- | --- |
| 0..3 | | `FF 55 01 02` | | | all |
| 4 (0x04) | u24 | `voltage` | 0.1 V | the DL24M display shows 0.01 V, the frame keeps 0.1 V ([SY] issue 76 table) | [SY], [NL], [FT], [DV], [JC], [WH] |
| 7 (0x07) | u24 | `current` | 0.001 A | no sign: the DT24TW-300A shows a negative current on its display while the frame does not change ([SY] issue 73) | same |
| 10 (0x0A) | u24 | `capacity` | 0.01 Ah | DL24 3.2 V × 51.14 Ah ≈ 170 Wh; DL24M 0.08 Ah with display 80 mAh ([FT]). [NL] documents these bytes as "Watt / 10", which the [NL] DC sample contradicts (123.6 W at 28.2 V × 0.06 A). On the DT24TW-300A the value decreases during discharge (remaining capacity of a battery monitor mode, **unverified**) | [SY], [FT] and [DV] decompiles, [JC], [WH] |
| 13 (0x0D) | u32 | `energy` | 0.01 kWh (10 Wh) | syssi publishes raw × 10 Wh; the app prints raw / 100 kWh ([FT]); [NL] "W·h / 100" is wrong. Always zero on DL24M firmware 2.0 ([SY] issue 91); [WH] calls it unreliable on some DL24 firmware and integrates locally | [SY], [FT], [DV], [WH] |
| 17 (0x11) | u24 | `price` | 0.01 per kWh | 1.00 on the DL24 (2025) and DT3010, 0.52 on the DT24TW-300A | [NL], [DV], [SY] discussion 107 |
| 20 (0x14) | 4 | unknown | | zero in every frame | [NL] ("unknown value") |
| 24 (0x18) | u16 | `temperature` | 1 °C | heatsink / MOSFET on the DL24 | [SY], [NL], [FT], [JC], [WH] |
| 26 (0x1A) | u16 | runtime hours | 1 h | counts while the load runs; always zero on DT3010 and DL24M firmware 2.0; fixed at 10:00:00 over 37 frames of a DL24 (2025) (may be the timer preset, **unverified**) | [SY] tests and issues 91, discussion 107 |
| 28 (0x1C) | u8 | runtime minutes | | | [SY], [NL] |
| 29 (0x1D) | u8 | runtime seconds | | syssi derives "running" from a change of this byte between reports | [SY] `decode_ac_and_dc_` |
| 30 (0x1E) | u8 | `backlight` | 1 s | 0 = always off, 60 = always on; 0 on the DL24M of [FT], 30 on a DL24 (2025) | [SY], [NL], [DV] |
| 31 (0x1F) | 4 | unused | | zero in every frame | [SY] |
| 35 (0x23) | u8 | checksum | | section 3.2; constant or random on several models | |

Power is not transmitted for type 0x02: `power` = `voltage` × `current` ([SY], [FT], [WH], [JC]). The load set current, cutoff voltage, timer preset, mode (CC, CR, CP, CV) and load on/off state are **not** in the report; the load state can be inferred from the runtime seconds changing ([SY]) or from current > 0 ([JC]), or read with PX100 query 0x10 (section 5.3).

### 6.3 USB meter report (device type 0x03), 36 bytes

| Offset | Type | Field | Scale | Notes | Sources |
| --- | --- | --- | --- | --- | --- |
| 0..3 | | `FF 55 01 03` | | | all |
| 4 (0x04) | u24 | `voltage` | 0.01 V | | [MS], [NL], [LP], [DV], [SY], [AF] display |
| 7 (0x07) | u24 | `current` | 0.01 A | | same |
| 10 (0x0A) | u24 | `capacity` | 0.001 Ah (1 mAh) | J7-C display 776 mAh = raw 776 ([AF]); UD18 display 46.7 Ah ([LP]) | same |
| 13 (0x0D) | u32 | `energy` | 0.01 Wh | J7-C display 3.67 Wh = raw 367 ([AF]) | same |
| 17 (0x11) | u16 | `dataMinus` | 0.01 V | USB D- line voltage; order **unverified**, see below | [MS], [NL], [SY], [LP] (provisional) |
| 19 (0x13) | u16 | `dataPlus` | 0.01 V | USB D+ line voltage | same |
| 21 (0x15) | u16 | `temperature` | 1 °C | the app prints it as °C and °F ([LP]); reads 0 on a UD18 | [NL], [SY], [LP], [DV], [AF] display 31 °C |
| 23 (0x17) | u16 | runtime hours | 1 h | 16-bit hours, no days byte ([DW] 0.1.2 confirmed with the E-test app; UD18 at 198 h, [LP]) | [NL], [SY], [LP], [DW] |
| 25 (0x19) | u8 | runtime minutes | | | same |
| 26 (0x1A) | u8 | runtime seconds | | increments once per report ([LP]) | same |
| 27 (0x1B) | u8 | `backlight` | 1 s | 0 = always off, 60 = always on | [LP] decompile, [NL] |
| 28 (0x1C) | 7 | unused / unknown | | zero on the UD18 and never read by the app ([LP]); non-zero and constant on the J7 family (`0D AC 01 2C 03 20 00`, `0D AC 01 22 03 20 00`, `0D AC 00 00 03 E8 64`, `0C 80 00 00 03 20 00`), meaning unknown | [LP], [AF], [SY], [DV], [DW] |
| 35 (0x23) | u8 | checksum | | section 3.2; not valid on the J7-C | |

`power` = `voltage` × `current` (not transmitted, [LP]).

Order of the data lines: [MS], [NL], [SY] and [LP] (following them) put D- at 17 and D+ at 19; [DV] and [DW] put D+ at 17. The decompiled app does not name them ([LP]). One frame of [BK] taken at 8.99 V shows 0.75 V at 17 and 3.27 V at 19, which matches Quick Charge 2.0 signalling for 9 V (D+ 3.3 V, D- 0.6 V) and therefore D- at 17 (vector `usb-qc2-9v-bukys`, plausibility argument of this research, **unverified**).

### 6.4 Reply (8 bytes)

| Offset | Type | Field | Notes |
| --- | --- | --- | --- |
| 0 | 2 | `FF 55` | |
| 2 | u8 | message type 0x02 | |
| 3 | u8 | `replyType` | 0x01 in every observed reply, also when the command carried device type 0x02 ([SY] issue 33); 0x00 only in the unexplained [NL] sample `FF 55 02 00 00 00 00 46` |
| 4 | u8 | `status` | section 9.3 |
| 5 | 2 | zero | |
| 7 | u8 | checksum | over bytes 2..6 |

| Frame | Meaning | Sources |
| --- | --- | --- |
| `FF 55 02 01 01 00 00 40` | OK | [NL] `ReplyType.OK`, [MS] (after WH reset), [TS] (after 0x32), [SY] issue 33, [LP] |
| `FF 55 02 01 02 00 00 41` | failed ([SY] `COMMAND_FAILED`) or wrong device type ([LP]) | [SY], [LP] (**unverified**) |
| `FF 55 02 01 03 00 00 42` | unsupported command | [NL], [SY], [TS] (after opcode 0xFF), [LP] |
| `FF 55 02 01 05 00 00 4C` | wrong message class (byte 2 not 0x11) | [LP] (**unverified**) |
| `FF 55 02 01 06 00 00 4D` | malformed frame (well-formed envelope, wrong length) | [LP] (**unverified**) |

[NL] protocol-design.md writes the OK state as "02 01"; that pair is bytes 2 and 4, the frames themselves are as above. A command frame of a length other than 10 is dropped without any reply ([LP]).

### 6.5 PX100 answers

- `6F`: a set command (0x01..0x05) was accepted ([TS] `PROTO_SHORTACK`, [RT] `OkResponse`, [WH]).
- `CA CB d1 d2 d3 CE CF`: query answer, value = u24 BE (scales in section 5.3). [WH] accepts it only as a whole notification that starts with `CA CB` and ends with `CE CF` while a query is pending.
- No answer: unknown command ([TS]).

## 7. Settings

### 7.1 What can be written

| Setting | Mechanism | Encoding and range | Read back | Evidence |
| --- | --- | --- | --- | --- |
| Backlight time | FF 55 opcode 0x21 | value 0–60 s; 0 = always off, 60 = always on | report byte 30 (types 0x01, 0x02) or 27 (type 0x03) | encoding: [NL], [SY] comment, [DV] decompile; a UD18 answers unsupported ([LP]); no capture of an accepted write: **unverified** effect |
| Price per kWh | FF 55 opcode 0x22 | value 1–999999 in 0.01 units (0.01–9999.99) | report bytes 17..19 (types 0x01, 0x02 only) | encoding: [NL] (UI sends price × 100), [SY] comment, [DV]; a UD18 answers unsupported; **unverified** effect |
| Load current (DL24 family) | PX100 0x02 | whole amperes and hundredths; DL24 0.2–20 A ([ORD]), DL24P up to 25 A ([JC] README) | PX100 query 0x17 (10 mA units) | [TS], [RT] (serial and SPP), [WH] (BLE, **unverified**) |
| Cutoff voltage (DL24 family) | PX100 0x03 | whole volts and hundredths, 0–200 V ([WH] slider) | PX100 query 0x18 (10 mV units) | same |
| Timer (DL24 family) | PX100 0x04 | u16 seconds, device keeps whole minutes ([WH]) | PX100 query 0x19 (h, min, s) | same |

Everything else (load mode CC / CR / CP / CV, protections, cutoff by capacity or energy, display pages) is reachable only through the key opcodes 0x31..0x34, i.e. by remote-controlling the menu; there is no addressable register ([AS], [JC], [ORD], [FT]).

### 7.2 Recommended ubms schema

- `atorch.backlight` (number, s, 0–60, step 1): writable for device types 0x01 and 0x02, shown read-only for 0x03 (the UD18 rejects it). Value comes from every report; after a write, the next reports must show the new value, otherwise report failure. Show 0 as "always off" and 60 as "always on".
- `atorch.price` (number, 0.01–9999.99, 2 decimals): writable for device types 0x01 and 0x02, verified through report bytes 17..19 like the backlight.
- `atorch.load_current` (A, 2 decimals), `atorch.cutoff_voltage` (V, 2 decimals), `atorch.timer` (s, multiples of 60): only for type 0x02 devices named as a DL24 or DL24P (a DL24M is never queried, section 1.1), marked experimental, written with PX100, confirmed by the user (`danger`), then read back with queries 0x17, 0x18, 0x19. Missing `6F` within about 1 s means failure; keep the field read-only for the rest of the connection.
- Everything decoded from the report is read-only. No setting exists for AC meters beyond backlight and price, and none for USB meters.

## 8. Controls and actions

### 8.1 FF 55 actions

| Action id (proposal) | Frame | Applies to | Notes |
| --- | --- | --- | --- |
| `atorch.reset_energy` | opcode 0x01 | all types | irreversible, confirm; also clears the app-side CO2 and cost |
| `atorch.reset_capacity` | opcode 0x02 | types 0x02 and 0x03; hide for 0x01 | on an S1-B the same frame toggles the relay ([BK], **unverified**), so never offer it on AC meters |
| `atorch.reset_runtime` | opcode 0x03 | all types | verified on DL24 and UD18 |
| `atorch.reset_all` | opcode 0x05 | all types | verified on DL24 ([AS]); untested on UD18 ([LP]) |
| `atorch.key_setup`, `atorch.key_enter`, `atorch.key_plus`, `atorch.key_minus` | 0x31, 0x32, 0x33, 0x34 | all types | remote front panel keys, advanced group only; the host cannot see the menu state, never retry automatically |

### 8.2 Load on and off (DL24 family)

- FF 55 0x32 is the ON/OFF key and toggles; the protocol has no explicit state and the report has no state bit ([JC]: "the protocol only supports toggle"; [AS], [TS]). Do not offer it as a switch.
- PX100 0x01 with d1 = 1 / 0 switches explicitly; PX100 query 0x10 reads the state ([TS], [RT], [WH]). Offer `atorch.load` as a switch only when PX100 answered at least once on this connection (for example the 0x10 query), with `danger` (the load drains the source under test).
- Without PX100, show the load state as a derived read-only value: running when the runtime seconds byte changes between reports ([SY]) or when current > 0 ([JC]).

## 9. Bits and enumerations

### 9.1 Message types (byte 2)

0x01 report (36 bytes, device to host), 0x02 reply (8 bytes, device to host), 0x11 command (10 bytes, host to device). Any other value: not a frame start.

### 9.2 Device types (byte 3 of reports and commands)

0x01 AC meter, 0x02 DC meter and electronic load, 0x03 USB meter. Other values were never seen; treat them as unsupported ([SY] logs "Unsupported device type", [KO] rejects them).

### 9.3 Reply status (byte 4 of a reply)

| Value | Meaning | Sources |
| --- | --- | --- |
| 0x01 | OK, command parsed and taken | [NL], [SY], [MS], [TS], [LP] |
| 0x02 | failed / wrong device type | [SY] `COMMAND_FAILED`, [LP] (**unverified**) |
| 0x03 | unsupported command | [NL], [SY], [TS], [LP] |
| 0x05 | wrong message class | [LP] (**unverified**) |
| 0x06 | malformed frame | [LP] (**unverified**) |

### 9.4 Backlight byte

0 = always off ("Normally Closed" in [NL]), 1..59 = timeout in seconds, 60 = always on ("Normally Open" in [NL]); [LP] confirms the three cases in the decompiled app, [DV] calls them "long black" and "long bright".

### 9.5 PX100 codes

Commands 0x01 load on / off, 0x02 current, 0x03 cutoff voltage, 0x04 timer, 0x05 reset counters; queries 0x10 load state, 0x11 voltage, 0x12 current, 0x13 elapsed time, 0x14 capacity, 0x15 energy, 0x16 MOSFET temperature, 0x17 current setting, 0x18 cutoff setting, 0x19 timer setting (section 5.3).

## 10. Device information

The protocol has no device information, version or serial number frame and no request for it ([NL], [SY], [LP], [FT]). Firmware versions appear only in the device menu (DL24 "V5.1", DL24M "2.0" and "2.1", [SY] issues 10, 59, 76, 91).

Recommended `DeviceInfo`: `vendor` "Atorch"; `model` from the advertised name with the `_BLE` / `-BLE` suffix removed ("DL24M_BLE" gives "DL24M"; "UC96_BLE" is a J7-C, [KO], adlerweb J7-C_UC96_BLE_Logger); `protocol` "Atorch FF 55" plus the device class from byte 3. The BLE module sets the names at boot with `AT+BD<name>` (SPP) and `AT+BM<name>` (BLE) ([FT]: `AT+BDDL24M_SPP`, `AT+BMDL24M_BLE`; [TS]: `AT+BMDL24_BLE`), so the names are fixed per model rather than user defined.

## 11. Detection

### 11.1 BLE scan

Observed advertised names: `DL24_BLE`, `DL24-BLE`, `DL24M_BLE` ([SY] issues 10, 76; adlerweb DL24_BLE_Logger; [FT]), `DT24PW_BLE` ([SY] issue 104), `AT3010-BLE` ([SY] issue 94), `UD18_BLE` ([LP]), `UD18-BLE` and `AT24-BLE` ([NL] protocol-design.md), `UC96_BLE` for the J7-C ([KO], adlerweb), `JDY-19` for the J7-H ([DV]), `S1BP_BLE` and `S1WP_BLE` (S1 loggers of tiede and meneerthijs). Reported without a capture: `DL24P_BLE` (serdar dl24_ble docstring), `UD24-BLE` ([KO] test list only).

Chooser filters: `namePrefixes` DL24, DT24, DT3010, AT24, AT3010, UD18, UD24, UC96, S1BP, S1WP, J7; `optionalServices` 0xFFE0. Ranking pattern: `/^(DL24|DT24|DT3010|AT24|AT3010|UD18|UD24|UC96|S1[A-Z]{0,3}|T18|J7)[A-Z0-9-]*[-_]BLE$/i`. `JDY-19` is a generic module name and must not raise the rank on its own.

Other device families behind 0xFFE0 / 0xFFE1 (from [jk.md](jk.md) section 11.1): JK BMS (frames `55 AA EB 90` only after requests), ANT BMS new protocol (`7E A1 ... AA 55`), NEEY / Heltec balancers (`AA 55 11 01` commands, `55 AA 11 01` answers, advertise 0xFEE7 like newer Atorch modules). Atorch devices are the only ones of these that push data without a request.

### 11.2 Passive probe

Detection must not write: every FF 55 opcode changes something on an Atorch device (key press or counter reset), and the same bytes sent to a JK, ANT or NEEY device are meaningless at best.

1. Connect, start notifications on 0xFFE1, send nothing.
2. Feed every notification into the reassembler of section 3.3 for up to 3 s (about three reports).
3. **Accept, high confidence**: a 36-byte frame `FF 55 01 <type>` with type 0x01..0x03 whose checksum (section 3.2) is valid.
4. **Accept, lower confidence** (models without a valid checksum, section 3.2): two 36-byte frames `FF 55 01 <type>` with the same type 0x01..0x03 that arrive 0.5–2 s apart and pass the plausibility checks: runtime minutes and seconds bytes ≤ 59, backlight byte ≤ 60, for types 0x01 and 0x02 bytes 31..34 zero, for type 0x02 bytes 20..23 zero (all 53 report frames of this research pass these checks). Use the name pattern of 11.1 as a tie breaker.
5. Otherwise not Atorch (time out and let the next driver probe).
6. Checksum policy for the session, after [KO] `ReportStream`: once 5 reports in a row passed the checksum, reject later reports that fail it; if the device never passed, accept structurally valid reports and keep a flag `checksum: false` for the protocol log. Optionally accept the [DW] variant (sum from byte 3) as a second rule learned the same way.
7. Order relative to the other BLE drivers: run the Atorch listener before any driver that writes a probe request (JK 0x97, ANT `7E A1`, NEEY), or listen in parallel from the moment notifications are enabled. Whether an Atorch meter reacts to foreign frames is not documented; the meter only parses frames that start with `FF 55` and drops other lengths ([LP]), so a JK or ANT request should be ignored (**unverified**).

### 11.3 Variant

`variant` = `AC_METER`, `DC_METER` or `USB_METER` from byte 3 of the accepted report. Capability flags kept by the driver: `checksumValid` (learned, 11.2 step 6), `px100` (type 0x02 and a DL24 or DL24P name, not DL24M, confirmed by the first PX100 answer).

## 12. Pitfalls and quirks

1. Shared UUIDs with JK BMS, ANT BMS and NEEY balancers: detection must be passive (section 11.2); manufacturer data `88 A0 ...` is a module trait shared with JK (section 2.1).
2. Many devices do not compute the checksum (DL24M, DT24TW-300A, DL24 of 2025, DT24PW, S1, J7-C); syssi needs `check_crc: false` for them ([SY] README). A strict checksum check makes these devices undetectable.
3. Energy units differ: 0.01 kWh (10 Wh) on AC and DC reports, 0.01 Wh on USB reports. [NL] protocol-design.md gives "W·h / 100" for AC and DC and "Watt" for DC bytes 10..12; both are wrong (sections 6.1, 6.2). The resolution of 10 Wh makes the DL24 energy counter coarse; [WH] integrates energy locally.
4. Bytes 10..12 are power on AC reports and capacity on DC reports; syssi decodes capacity for both.
5. Power is transmitted only by AC meters; compute V × I for DC and USB.
6. Current has no sign on any device; a DC meter showing a negative current on its display still sends a positive value ([SY] issue 73). Model current as a magnitude and never derive charging or discharging from it.
7. Runtime is zero on DT3010, AT3010 and DL24M firmware 2.0 and stuck at 10:00:00 on a DL24 of 2025; it counts only while a DL24 load runs.
8. D- / D+ order of the USB report conflicts between sources (section 6.3).
9. Backlight 0 and 60 are states, not durations.
10. Two opcode pairs for [+] / [-]: 0x11 / 0x12 ([NL] for AC and DC) do nothing on a DL24M and are unsupported on a UD18; 0x33 / 0x34 are what the vendor apps send.
11. Enter (0x32) toggles the DL24 load; a lost reply plus a retry switches it twice. Never retry key presses.
12. Replies are not guaranteed: the notification path of a UD18 can stall while writes are acknowledged, and the reply rate decays with use until a power cycle ([LP]); the DT24PW logged no reply ([SY] issue 104).
13. A command frame must be exactly 10 bytes; other lengths are silently dropped, and the status 0x06 reply only comes for a well-formed envelope of the wrong length ([LP]).
14. Never write text (for example `AT\r\n`) to 0xFFE1: the module answers itself (`AT+BDUD18_SPP`) and keeps interleaving text into the stream until the meter is power cycled ([LP]).
15. The device type byte of a command must match the reports (status 0x02 otherwise, [LP]); syssi falls back to 0x02 before the first report, which is wrong for AC and USB meters.
16. 0xFFE2 is missing on some units (J7-H); syssi requires it and then cannot send commands ([SY] `gattc_event_handler`). Use 0xFFE1.
17. Some sources disagree on the value bytes of a command (section 3.4); use u32 BE.
18. Reset capacity (0x02) toggles the relay of an S1-B ([BK], **unverified**); do not send 0x02 to AC meters.
19. The DT24TW-300A capacity value decreases during discharge and its energy counter keeps rising while charging (frames of [SY] issue 73); treat DT24 capacity as device-defined (**unverified**).
20. The bytes 28..34 of J7 family USB reports are non-zero and constant; do not use them for plausibility checks of type 0x03 frames.
21. AC meters report energy that may be very large (1668 kWh on the AT3010 of [SY] issue 94); u32 in 10 Wh units covers about 42.9 GWh, no overflow handling needed.
22. Report temperatures are integers in °C; the UD18 of [LP] reports 0, so a 0 °C USB temperature may mean "not available".

## 13. References

All URLs as read on 2026-11-18 and 2026-11-19; line numbers refer to the copies read then.

[SY] syssi/esphome-atorch-dl24, https://github.com/syssi/esphome-atorch-dl24
- components/atorch_dl24/atorch_dl24.cpp: constants L16-L35 (`DL24_COMMAND_CHARACTERISTIC_UUID` = 0xFFE2 at L33), `crc` L38-L46, `write_register` L48-L75, `gattc_event_handler` L98-L179, sample frames L182-L208, `assemble` L209-L260, `decode` L262-L324 (reply status L272-L292), `decode_ac_and_dc_` L326-L401 (running heuristic L390-L394), `decode_usb_` L403-L471
- components/atorch_dl24/button/__init__.py L11-L23 (command frame comments), L36-L47 (`BUTTONS`); button/atorch_button.cpp L15-L23 (`press_action`, device type fallback 0x02)
- docs/protocol-design.md (copy of the [NL] document), docs/pdus/atorch-dl24.txt, atorch-dt3010.txt, atorch-j7-c.txt
- tests/components/atorch_dl24/common.h (DC_FRAME_1, DC_FRAME_2, AC_FRAME_1, USB_FRAME_1, REPLY_FRAME_SUCCESS), atorch_dl24_test.cpp (all `TEST` cases); tests/esp32-atorch-s1.yaml L55 and tests/esp32-atorch-j7-c.yaml L55 (`check_crc: false`), tests/esp32-atorch-dt3010.yaml
- README.md (supported devices and `check_crc` notes, GATT log with FFE1 properties 0x1C)
- issues 10 (comments 1025167646, 1048539984, 1048553131, 1048555566: DL24_BLE and DL24-BLE advertising, GATT tables, split frames), 33 (reset runtime command, 30 + 6 and 4 + 4 splits), 48 and pull request 49 (J7-C), 59 (DL24M random checksum), 60 (comments 1981739302, 1981768794: S1 frames), 73 (comments 2049483329, 2049976827, 2050119755, 2050121798: DT24TW-300A), 76 (comments 2161626142, 2161645632, 2162971542: DL24M Purple, plus / minus opcodes), 91 (DL24M ver2.0, energy and runtime zero), 94 (attachment logs_at3010_work.txt: AT3010 advertising, GATT, 37 frames), 104 (DT24PW, reset all without reply), 110 (Tuya based model); discussion 107 (comment 15467593: DL24 of 2025, constant last byte)

[NL] NiceLabs/atorch-console, https://github.com/NiceLabs/atorch-console (also published as CursedHardware/atorch-console)
- docs/protocol-design.md (sections "Bluetooth LE", "Packet layout", "Type indicator", report tables, "Command", "Reply", "Checksum Algorithm"), README.md (supported meters)
- src/service/atorch-packet/packet-command.ts L6-L13 (`makeCommandPacket`), L28-L45 (opcodes, `setPlus` / `setMinus` choose 0x11 / 0x33 by type), types.ts L10-L19 (`MessageType`, `ReplyType`), packet-meter-ac.ts, packet-meter-dc.ts, packet-meter-usb.ts, packet-reply.ts, *.spec.ts (sample frames)
- src/components/AtorchConsole/PrintReport/index.tsx L97-L117 (price × 100, backlight 0–60), L128-L136 (`FormattedBacklightTime`)
- docs/UD18-SPP.pcap (91 UD18 reports over SPP, all with a valid checksum)

[MS] msillano/UD18-protocol-and-node-red, https://github.com/msillano/UD18-protocol-and-node-red, UD18_protocol.txt (command frames, OK reply, report map with D- at 0x11 and D+ at 0x13)

[LP] lispnik/ud18, https://github.com/lispnik/ud18
- README.md: "What the device is" L32-L50 (name UD18_BLE, FFE1 / FFE2, one report per second), "Protocol" L131-L175 (checksum verified on 321 frames, report table), "Where the field meanings come from" L176-L200 (E-test 2.0 decompile, backlight cases), "What is not known" L228-L237 (D- / D+ order), "Commands" L238-L348 (10-byte length, reply status table, command set, app `send` code), "Replies are unreliable" L370-L462, "Do not write text to 0xFFE1" L463-L475
- src/protocol.lisp L31-L80 (layout comments), captures/ud18-2026-08-19.hex (321 frames)

[DV] devanlai/webvoltmeter, https://github.com/devanlai/webvoltmeter/blob/master/REVERSE.md (J7-H advertising and GATT, mode 1 / 2 / 3 report formats, command framing and command table from the decompiled app)

[FT] Flaviu Tamas, "ATorch DL24 electronic load reversing" (DL24M), https://flaviutamas.com/2022/dl24m-reversing (sections "Hardware", "Communications", "Reading data" with 11 frames and display values, decompiled parser, "Sending commands" with the decompiled `send` method)

[TS] Shaddack, sw_dl24, https://www.improwis.com/projects/sw_dl24/ (README sections "protocol", "PX100 protocol", "Atorch protocol", "transaction examples"; dl24.py L12-L14 default port /dev/rfcomm0 at 9600 baud, L335-L345 checksum and `AT+BMDL24_BLE`)

[WH] whisker73, DL24 Android Monitor (GitHub user whisker73; Linux sibling https://github.com/whisker73/bl24_linux): app/src/main/java/com/dl24/monitor/ble/BleConstants.kt L5-L49, DL24Protocol.kt (`ProtocolParser`, `CommandBuilder.buildDirect`, `directCurrent`, `directVoltageCutoff`, `directTimer`), BleManager.kt L183-L198 (PX100 answers on the notification stream), README.md "Direktsteuerung (B1 B2 Protokoll)" L123-L135 and "PX100 Query-Protokoll" L136-L150

[RT] RobThree/LibAtorch, https://github.com/RobThree/LibAtorch: LibAtorch/Request.cs L42-L56 (`ToFrame`, `DoubleToByteArray`, `TimespanToByteArray`), CommandType.cs, QueryType.cs, LoadState.cs, AtorchDevice.cs L16-L18 and L104-L263 (commands, queries and scales), L426-L432 (`6F`, `CA CB .. CE CF`)

[KO] koedame/usbmeter, https://github.com/koedame/usbmeter: cli/src/protocol.rs L43-L48 (`checksum_of`), L181-L205 (`CHECKSUM_PROOF`, `ReportStream`), src/protocol.test.ts L14-L26 (J7-C frames from [AF]), src/bluetooth.ts L12 (name prefixes, J7-C = UC96_BLE), testdata/protocol.json

[DW] dallanwagz/atorch-ble, https://github.com/dallanwagz/atorch-ble: CHANGELOG.md 0.1.1 (checksum from byte 3, 639 frames) and 0.1.2 (16-bit hours), src/atorch_ble/_decoder.py `decode_usb_meter` L60-L133, tests/fixtures/known_frames.py L236-L257 (`REAL_CAPTURED_FRAME`)

[JC] jakubcizek/atorch-dl24-dashboard (DL24P over Web Bluetooth): dl24.html L903-L911 (UUIDs), L1209-L1227 (decoder), L1426-L1497 (commands, 0x32 toggle, 0x33 / 0x34, 0x31), Claude.md (layout and command notes), README.md (DL24P 200 V, 25 A, 180 W)

[ORD] ordinoscope.net, Atorch DL24P, https://www.ordinoscope.net/index.php/Electronique/Hardware/Outils/Atorch/DL24P (specifications, serial 9600 8N1, Python decoder, table "Touches (app Windows)")

[AS] auto-scripting.com, "Atorch DL24 hack 1", archived at https://web.archive.org/web/20220116222351/https://auto-scripting.com/2020/05/03/atorch-dl24-hack-1/ (DL24-BLE, FFE1 notifications and FFE2 writes, 20 + 16 byte notifications, table "Analysis of the captures communication data" with opcodes 0x01..0x06 and 0x31..0x34)

[BK] bukys.eu, "Android application: Power monitor for Atorch", http://bukys.eu/project/powermon/start (commands for UD18 / UD24 and S1-B, data table, checksum example frame); source https://github.com/lixas/PowerMonF7

[WR] Werner Rothschopf, "Atorch DT24 HD IPS / UD18 (Serial)", https://werner.rothschopf.net/microcontroller/202204_atorch_dt24hd_power_sensor_en.htm (serial at 9600 baud, sample frames)

[AF] Arduino forum, "USB Digital Tester (BT) Protocol", https://forum.arduino.cc/t/usb-digital-tester-bt-protocol/943891 (J7-C raw frames with display values, BLE and SPP at the same time)

Other projects read for cross-checks: adlerweb/DL24_BLE_Logger (expects the name DL24_BLE) and J7-C_UC96_BLE_Logger, misdoro/Electronic_load_px100 protocol_PX-100_2_70.md (cited by [TS], not read), serdar dl24_ble (DC decoder with energy × 10 Wh), tiede DL-24 / S1BP logger (energy × 10 Wh for AC and DC), meneerthijs S1WP_BLE logger, village-elder Atorch tools, done.land DL24 page (front panel settings), https://github.com/lanrat/usb-meter (J7-C).
