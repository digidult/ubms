# @ubms/transport

Generic device link layer for web apps that talk to hardware: Web Bluetooth, Web Serial, a Tauri
bridge for desktop builds, in-memory links for tests and simulators, frame reassembly,
request/response helpers, checksums and a protocol log. It contains nothing specific to battery
management systems and is meant to move to its own repository.

## Concepts

| Piece | Purpose |
| --- | --- |
| `WebBluetoothProvider`, `WebSerialProvider`, `TauriBleProvider`, `TauriSerialProvider` | Availability checks and device selection (browser chooser, granted devices, native scan or port list). |
| `WebBleDevice` | A selected BLE device: `connect()`, `discover()`, `openChannel(profile)`, `disconnect()` (also cancels a connect in progress), `disconnect` event. |
| `WebSerialPort` | A selected serial port: `openLink(serialOptions)`. |
| `Link` | An open byte channel: `write(bytes, meta)`, events `data`, `state`, `close`. Writes are serialized and chunked. |
| `MemoryLink`, `createLinkPair()` | Two connected in-memory links, optional delivery chunking to imitate BLE. |
| `FrameAssembler` | Turns arbitrary chunks into validated frames (sync patterns, length from header, checksum, resync, stale data handling). |
| `FrameChannel` | Link plus assembler: serialized `send`, `request` (with `retries`), `requestMany` (one write, no retries), `waitFor`, frame events, frame logging. |
| `ProtocolLog` | Bounded observable log (`tx`, `rx`, `frame`, `event`, `warn`, `error`, `debug`) with lazy decoding and JSON export. |
| `bytes.js`, `checksum.js` | Hex helpers, integer readers with bounds checks, `ByteReader`, UUID helpers, sum8/xor8/CRC16. |

## Example

```js
import { WebBluetoothProvider, FrameChannel, FrameAssembler, ProtocolLog, sum8 } from '@ubms/transport';

const log = new ProtocolLog();
const ble = new WebBluetoothProvider({ log });
const device = await ble.request({ filters: [{ namePrefix: 'MyDev' }], optionalServices: [0xffe0] });
await device.connect();
const link = await device.openChannel({ service: 0xffe0, notify: 0xffe1, write: 0xffe1 });

const channel = new FrameChannel(link, {
  createAssembler: ({ onFrame, onDiscard }) =>
    new FrameAssembler({
      sync: [[0xa5, 0x5a]],
      length: (buf) => (buf.length < 3 ? 0 : buf[2] + 4),
      validate: (f) => sum8(f, 0, f.length - 1) === f[f.length - 1],
      onFrame,
      onDiscard,
    }),
  describe: (frame) => ({ name: `Reply 0x${frame[3].toString(16)}` }),
}).start();

const reply = await channel.request(Uint8Array.of(0xa5, 0x5a, 0x00, 0xff), { match: (f) => f[3] === 0x01, timeout: 1000 });
```

## Rules

- No dependencies, no DOM access at import time (browser APIs are touched only when called), so
  everything is testable in Node.
- User facing error messages are English and wrapped in `msg()` so apps can translate them.
