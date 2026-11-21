/**
 * EXAMPLE PLUGIN for the ubms desktop app (docs/plugins.md). It is a teaching example: the
 * "EXB1" protocol below is made up and no real device speaks it. Copy this file into the
 * `plugins` folder next to the app to try it: the app then offers "Example BMS" in the device
 * type list, in automatic detection and as a demo (Connect, Demo, Example BMS).
 *
 * A plugin is one self-contained ES module. It cannot import anything; everything it needs comes
 * from the `api` object passed to its default export `register(api)`.
 *
 * Toy protocol EXB1 (all numbers big endian):
 *
 *   offset 0  0xEB 0x90         start of frame
 *   offset 2  command           requests 0x01..0x04, answers have bit 7 set (0x81..0x84)
 *   offset 3  N                 payload length, 0..200
 *   offset 4  payload           N bytes
 *   offset 4+N  CRC-16/MODBUS   of bytes 0..3+N, low byte first
 *
 *   0x01 status    -> 0x81: voltage u16 (10 mV), current i16 (10 mA, POSITIVE WHILE
 *                     DISCHARGING, the app wants the opposite), SOC u8 (%), flags u8 (bit 0
 *                     charge MOSFET, bit 1 discharge MOSFET, bit 2 balancing), alarms u16,
 *                     remaining u16 (0.1 Ah), full u16 (0.1 Ah), cycles u16, cell count u8,
 *                     cells u16 (mV) each, sensor count u8, temperatures i16 (0.1 degrees C) each
 *   0x02 info      -> 0x82: model (16 bytes ASCII), firmware (8), serial number (16)
 *   0x03 settings  -> 0x83: one u16 per register, see REGISTERS
 *   0x04 write     payload register u8, value u16 -> 0x84: register u8, value u16, status u8
 *                     (0 written, 1 unknown register, 2 out of range)
 */
export default function register(api) {
  const { BaseDriver, msg, field, buildSchema, relation, fieldMap, alarm } = api.core;
  const { FrameAssembler, FrameChannel, crc16Modbus, u16be, i16be, ascii, asciiBytes, hex } = api.transport;
  const { SimBattery } = api.drivers;

  const VENDOR = 'Example';
  const VARIANT = 'EXB1';
  const START = [0xeb, 0x90];
  const CMD = { STATUS: 0x01, INFO: 0x02, SETTINGS: 0x03, WRITE: 0x04 };
  const COMMAND_NAMES = { 1: 'Status', 2: 'Info', 3: 'Settings', 4: 'Write setting' };
  const MAX_PAYLOAD = 200;

  // ----- Framing -------------------------------------------------------------------------------

  /** @param {number} command @param {ArrayLike<number>} [payload] */
  function encode(command, payload = []) {
    const frame = new Uint8Array(payload.length + 6);
    frame.set(START, 0);
    frame[2] = command;
    frame[3] = payload.length;
    frame.set(payload, 4);
    const crc = crc16Modbus(frame, 0, payload.length + 4);
    frame[payload.length + 4] = crc & 0xff;
    frame[payload.length + 5] = crc >> 8;
    return frame;
  }

  /** @param {Uint8Array} frame */
  const payloadOf = (frame) => frame.subarray(4, frame.length - 2);

  /** Reassembles frames from any chunking; a bad checksum drops one byte and searches again. */
  function createAssembler({ onFrame, onDiscard }) {
    return new FrameAssembler({
      sync: [START],
      length: (buf) => (buf.length < 4 ? 0 : buf[3] > MAX_PAYLOAD ? -1 : buf[3] + 6),
      validate: (frame) => crc16Modbus(frame, 0, frame.length - 2) === (frame[frame.length - 2] | (frame[frame.length - 1] << 8)),
      onFrame,
      onDiscard,
      maxLength: MAX_PAYLOAD + 6,
    });
  }

  /** Names and lazy decoders for the protocol log. @param {Uint8Array} frame */
  function describe(frame) {
    const command = frame[2] & 0x7f;
    const answer = (frame[2] & 0x80) !== 0;
    const name = `${COMMAND_NAMES[command] ?? `Command ${hex([command])}`}${answer ? ' answer' : ' request'}`;
    if (answer && command === CMD.STATUS) return { name, decode: () => parseStatus(payloadOf(frame)) };
    if (answer && command === CMD.INFO) return { name, decode: () => parseInfo(payloadOf(frame)) };
    return { name, decode: () => ({ payload: hex(payloadOf(frame), ' ') }) };
  }

  // ----- Parsing -------------------------------------------------------------------------------

  /** @param {Uint8Array} p */
  function parseStatus(p) {
    const cellCount = p[14];
    const cells = [];
    for (let i = 0; i < cellCount; i++) cells.push(u16be(p, 15 + i * 2) / 1000);
    const at = 15 + cellCount * 2;
    const temperatures = [];
    for (let i = 0; i < p[at]; i++) temperatures.push(i16be(p, at + 1 + i * 2) / 10);
    return {
      voltage: u16be(p, 0) / 100,
      dischargeCurrent: i16be(p, 2) / 100,
      soc: p[4],
      flags: p[5],
      alarms: u16be(p, 6),
      remaining: u16be(p, 8) / 10,
      full: u16be(p, 10) / 10,
      cycles: u16be(p, 12),
      cells,
      temperatures,
    };
  }

  /** @param {Uint8Array} p */
  const parseInfo = (p) => ({ model: ascii(p, 0, 16), firmware: ascii(p, 16, 8), serial: ascii(p, 24, 16) });

  /** Alarm bits of the status answer, in catalog ids so they look like every other BMS. */
  const ALARM_BITS = ['cell_overvoltage', 'cell_undervoltage', 'charge_overcurrent', 'discharge_overcurrent', 'charge_overtemperature', 'cell_voltage_difference'];

  /** The unified snapshot (packages/bms-core/src/model.js). @param {ReturnType<typeof parseStatus>} st */
  function snapshot(st) {
    return {
      voltage: st.voltage,
      // The app's rule: current is positive while charging. This device counts the other way
      // (0 - x instead of -x keeps an idle pack at 0 A, not -0 A).
      current: 0 - st.dischargeCurrent,
      soc: st.soc,
      capacityRemaining: st.remaining,
      capacityFull: st.full,
      cycles: st.cycles,
      cells: st.cells,
      balancingActive: (st.flags & 4) !== 0,
      // Labels are English; the app translates the ones it knows, such as "Temperature 1".
      temperatures: st.temperatures.map((value, i) => ({ id: `t${i + 1}`, label: `Temperature ${i + 1}`, value, kind: 'cell' })),
      switches: { charge: (st.flags & 1) !== 0, discharge: (st.flags & 2) !== 0, balance: (st.flags & 4) !== 0 },
      alarms: ALARM_BITS.filter((_, bit) => (st.alarms >> bit) & 1).map((id) => alarm(id, { source: 'EXB1 alarm bits' })),
    };
  }

  // ----- Settings ------------------------------------------------------------------------------

  /** Register number and scale (raw = value * scale) of every setting, in register order. */
  const REGISTERS = [
    { id: 'cell.ovp', scale: 1000 },
    { id: 'cell.ovpr', scale: 1000 },
    { id: 'cell.uvp', scale: 1000 },
    { id: 'cell.uvpr', scale: 1000 },
    { id: 'charge.ocp', scale: 10 },
    { id: 'switch.buzzer', scale: 1 },
    { id: 'exb.sleep_minutes', scale: 1 },
  ];

  // Canonical ids (catalog.js) bring their English label, unit, decimals and group. A setting of
  // this device only gets the family prefix and its own label.
  const FIELDS = [
    field('cell.ovp', { min: 3.2, max: 4.3, validate: relation('cell.ovp', '>', 'cell.ovpr', msg('Protection must be above recovery')) }),
    field('cell.ovpr', { min: 3.1, max: 4.2 }),
    field('cell.uvp', { min: 2.0, max: 3.2, validate: relation('cell.uvp', '<', 'cell.uvpr', msg('Protection must be below recovery')) }),
    field('cell.uvpr', { min: 2.1, max: 3.3 }),
    field('charge.ocp', { min: 1, max: 300 }),
    field('switch.buzzer'),
    field('exb.sleep_minutes', { label: msg('Sleep after idle'), group: 'system', type: 'number', unit: 'min', decimals: 0, min: 0, max: 240, description: msg('0 keeps the BMS awake') }),
  ].map((f, register) => ({ ...f, meta: { register, scale: REGISTERS[register].scale } }));
  const SCHEMA = buildSchema(FIELDS);
  const FIELD_BY_ID = fieldMap(SCHEMA);

  // ----- Driver --------------------------------------------------------------------------------

  class ExampleDriver extends BaseDriver {
    constructor(definition, ctx) {
      super(definition, ctx);
      this.channel = new FrameChannel(ctx.link, { createAssembler, describe, log: ctx.log, source: definition.id }).start();
    }

    get capabilities() {
      return { settings: true, writeSettings: true, streaming: false, pollIntervalMs: 1000, minPollIntervalMs: 500 };
    }

    /**
     * One request and its answer (the channel sends one request at a time).
     * @param {number} command @param {number[]} [payload] @param {number} [timeout] @param {number} [retries]
     */
    async request(command, payload = [], timeout = 1500, retries = 0) {
      const frame = await this.channel.request(encode(command, payload), {
        match: (f) => f[2] === (command | 0x80),
        timeout,
        retries,
        name: `${COMMAND_NAMES[command]} request`,
      });
      return payloadOf(frame);
    }

    /** Identify the device with a read only status request: a probe must not change anything. */
    async probe({ timeout = 2500 } = {}) {
      try {
        const st = parseStatus(await this.request(CMD.STATUS, [], Math.max(300, Math.floor(timeout / 2)), 1));
        if (!st.cells.length) return null;
      } catch (err) {
        // Silence or a garbled answer means "not this protocol"; other errors (a closed link)
        // go to the session, which logs them and tries the next candidate.
        if (err?.code === 'TIMEOUT' || err instanceof RangeError) return null;
        throw err;
      }
      this.setVariant(VARIANT);
      return { variant: VARIANT, confidence: 1 };
    }

    async poll() {
      this.publish(snapshot(parseStatus(await this.request(CMD.STATUS))));
    }

    async readInfo() {
      const info = parseInfo(await this.request(CMD.INFO));
      return this.publishInfo({ vendor: VENDOR, model: info.model, softwareVersion: info.firmware, serialNumber: info.serial, protocol: VARIANT });
    }

    getSettingsSchema() {
      return SCHEMA;
    }

    async readSettings() {
      const p = await this.request(CMD.SETTINGS);
      const values = {};
      for (const f of FIELDS) {
        if (p.length < f.meta.register * 2 + 2) continue;
        const raw = u16be(p, f.meta.register * 2);
        values[f.id] = f.type === 'boolean' ? raw !== 0 : raw / f.meta.scale;
      }
      return values;
    }

    async writeSetting(id, value) {
      const f = FIELD_BY_ID.get(id);
      if (!f) throw new Error(msg('Unknown setting'));
      const raw = f.type === 'boolean' ? (value ? 1 : 0) : Math.round(value * f.meta.scale);
      const answer = await this.request(CMD.WRITE, [f.meta.register, raw >> 8, raw & 0xff]);
      if (answer[3] === 1) throw new Error(msg('The device does not know this setting'));
      if (answer[3] !== 0) throw new Error(msg('The device refused the value'));
    }

    dispose() {
      this.channel.stop();
      super.dispose();
    }
  }

  // ----- Simulator (demo mode and tests) -------------------------------------------------------

  /** The device side of EXB1 on an in-memory link. @param {import('@ubms/transport').Link} link */
  function createSimulator(link) {
    const battery = new SimBattery({ cells: 8, capacityAh: 100, soc: 72, tempSensors: 2, seed: 11, maxCurrent: 30 });
    const settings = [3650, 3450, 2600, 2900, 1000, 1, 30];
    const LIMITS = [[3200, 4300], [3100, 4200], [2000, 3200], [2100, 3300], [10, 3000], [0, 1], [0, 240]];
    const timer = setInterval(() => battery.step(1), 1000);
    const be = (v) => [(v >> 8) & 0xff, v & 0xff];

    const status = () => {
      const cells = battery.cellVoltages().map((v) => Math.round(v * 1000));
      const flags = (battery.switches.charge ? 1 : 0) | (battery.switches.discharge ? 2 : 0) | (battery.balanceCurrent > 0 ? 4 : 0);
      const alarms = Math.max(...cells) - Math.min(...cells) > 30 ? 1 << 5 : 0;
      return [
        ...be(Math.round(cells.reduce((a, b) => a + b, 0) / 10)),
        ...be(Math.round(-battery.current * 100) & 0xffff),
        Math.round(battery.soc),
        flags,
        ...be(alarms),
        ...be(Math.round(battery.remainingAh * 10)),
        ...be(Math.round(battery.capacityAh * 10)),
        ...be(battery.cycles),
        cells.length,
        ...cells.flatMap(be),
        battery.temps.length,
        ...battery.temps.flatMap((t) => be(Math.round(t * 10) & 0xffff)),
      ];
    };

    const answer = (frame) => {
      const p = payloadOf(frame);
      switch (frame[2]) {
        case CMD.STATUS:
          return encode(0x81, status());
        case CMD.INFO:
          return encode(0x82, [...asciiBytes('EXB-8S100', 16), ...asciiBytes('1.2.0', 8), ...asciiBytes('EXB2026000042', 16)]);
        case CMD.SETTINGS:
          return encode(0x83, settings.flatMap(be));
        case CMD.WRITE: {
          const register = p[0];
          const value = (p[1] << 8) | p[2];
          let result = 0;
          if (register >= settings.length) result = 1;
          else if (value < LIMITS[register][0] || value > LIMITS[register][1]) result = 2;
          else settings[register] = value;
          return encode(0x84, [register, ...be(settings[register] ?? 0), result]);
        }
        default:
          return null;
      }
    };

    const assembler = createAssembler({ onFrame: (frame) => {
      const reply = answer(frame);
      if (reply) link.write(reply).catch(() => {});
    } });
    const off = link.on('data', (chunk) => assembler.push(chunk));
    return {
      battery,
      stop() {
        clearInterval(timer);
        off();
      },
    };
  }

  // ----- Definition ----------------------------------------------------------------------------

  const definition = {
    id: 'example-bms',
    family: 'example',
    vendor: VENDOR,
    protocol: msg('EXB1 example protocol'),
    deviceType: 'bms',
    experimental: true,
    description: msg('Example plugin with a made up protocol. Use it as a template; no real device speaks it.'),
    links: {
      ble: {
        profiles: [
          {
            id: 'exb-ble',
            label: 'EXB1 GATT service',
            service: '5ea1c0de-e7b1-4c00-8000-00000000e7b0',
            notify: '5ea1c0de-e7b1-4c00-8000-00000000e7b1',
            write: '5ea1c0de-e7b1-4c00-8000-00000000e7b2',
            writeMode: 'auto',
            chunkSize: 20,
          },
        ],
        namePrefixes: ['EXB-'],
        namePatterns: [/^EXB-\d+S/],
      },
      serial: {
        profiles: [{ id: 'exb-9600', label: 'UART 9600 8N1', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' }],
        note: msg('The example protocol runs at 9600 baud, 8N1.'),
      },
    },
    create: (ctx) => new ExampleDriver(definition, ctx),
    demo: { name: 'EXB-8S100 (example plugin demo)', chunkSize: 20, create: (link) => createSimulator(link) },
  };

  return { name: 'Example BMS', version: '1.0.0', drivers: [definition] };
}
