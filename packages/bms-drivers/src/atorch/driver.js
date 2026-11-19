import { BaseDriver, deriveSnapshot, fieldMap, msg } from '@ubms/bms-core';
import { FrameChannel, sleep } from '@ubms/transport';
import {
  ChecksumPolicy,
  DEVICE,
  LISTEN_MS,
  OP,
  OP_NAMES,
  PX100,
  ReportDetector,
  STATUS,
  createHostAssembler,
  describe,
  encodeCommand,
  isPx100Ack,
  isPx100Reply,
  isReplyFrame,
  isReportFrame,
  parsePx100Reply,
  parseReply,
  parseReport,
  px100Load,
  px100Query,
  px100SetCurrent,
  px100SetCutoff,
  px100SetTimer,
} from './protocol.js';
import { PX100_PRESETS, buildAtorchSchema, meterRawValue, reportShows } from './settings.js';
import { createAtorchSimulator } from './simulator.js';

/**
 * Atorch driver (docs/protocols/atorch.md): meters and electronic loads that push a 36 byte FF 55
 * report about once per second over a transparent BLE UART bridge (service FFE0, FFE1 for
 * notifications and writes). Detection is passive: the driver listens and never writes a probe.
 * Commands go out one at a time with the device type of the reports, 300 ms apart, without
 * automatic retries (key presses are not idempotent). The DL24 family also gets the PX100 frames
 * for load control, experimental and only after a PX100 answer on this connection.
 *
 * @typedef {import('@ubms/bms-core/driver').DriverDefinition} DriverDefinition
 * @typedef {import('@ubms/bms-core/driver').DriverContext} DriverContext
 * @typedef {import('@ubms/bms-core/model').BmsSnapshot} BmsSnapshot
 * @typedef {import('@ubms/bms-core/model').DeviceInfo} DeviceInfo
 * @typedef {import('@ubms/bms-core/model').ExtraValue} ExtraValue
 * @typedef {import('./protocol.js').AtorchReport} AtorchReport
 * @typedef {import('./settings.js').Px100State} Px100State
 */

export const ATORCH_VENDOR = 'Atorch';

/** Chooser name prefixes (spec 11.1). JK, ANT and NEEY names do not start with any of them. */
export const NAME_PREFIXES = Object.freeze(['DL24', 'DT24', 'DT3010', 'AT24', 'AT3010', 'UD18', 'UD24', 'UC96', 'S1BP', 'S1WP', 'J7']);

/** Ranking pattern (spec 11.1). `JDY-19` (J7-H) is a generic module name and deliberately not matched. */
export const NAME_PATTERN = /^(DL24|DT24|DT3010|AT24|AT3010|UD18|UD24|UC96|S1[A-Z]{0,3}|T18|J7)[A-Z0-9-]*[-_]BLE$/i;

/** Wait this long for the reply of a command (spec 4.1 step 4). */
const REPLY_TIMEOUT_MS = 2000;
/** Minimum gap between two commands ([JC] debounce 300 ms, [WH] 200 ms). */
const COMMAND_SPACING_MS = 300;
/** Wait this long for `6F` or `CA CB .. CE CF` (spec 4.2 step 2). */
const PX100_TIMEOUT_MS = 1000;
/** A report younger than this counts as live (spec 4.1 step 5). */
const LIVE_REPORT_MS = 2500;
/** Before a command, wait at most this long for a live report. */
const LIVE_WAIT_MS = 4000;
/** After a backlight or price write, look for the new value in the reports for this long. */
const READBACK_MS = 3500;
/** Watchdog: no report for this long is a poll error. */
const STALL_MS = 5000;
/** A PX100 load state answer is used instead of the derived state for this long. */
const PX100_FRESH_MS = 10000;
/** Connections give up asking PX100 after this many unanswered first queries. */
const PX100_MAX_ATTEMPTS = 2;

/** Device class labels (spec 1.1). */
const CLASS_LABELS = /** @type {Record<number, string>} */ ({
  [DEVICE.AC]: msg('AC meter'),
  [DEVICE.DC]: msg('DC meter or electronic load'),
  [DEVICE.USB]: msg('USB meter'),
});

/** @param {unknown} name */
const cleanName = (name) =>
  String(name ?? '')
    .trim()
    .replace(/\s*\([^)]*\)$/, '');

/** The advertised name looks like an Atorch device (pattern or prefix of spec 11.1). @param {unknown} name */
export function isAtorchName(name) {
  const n = cleanName(name);
  return NAME_PATTERN.test(n) || NAME_PREFIXES.some((p) => n.toUpperCase().startsWith(p));
}

/** DL24 family load (DL24, DL24P, DL24M); the only hint that load control exists (spec 1.3). @param {unknown} name */
export const isLoadName = (name) => /^DL24/i.test(cleanName(name));

/** PX100 is documented for DL24 and DL24P; DL24M support is unknown (spec 1.1). @param {unknown} name */
export const isPx100Name = (name) => /^DL24(?!M)/i.test(cleanName(name));

/** Load current limit of the PX100 field: DL24P up to 25 A ([JC]), DL24 20 A ([ORD]). @param {unknown} name */
export const maxLoadCurrent = (name) => (/^DL24P/i.test(cleanName(name)) ? 25 : 20);

/**
 * Model from the advertised name without the `_BLE` / `-BLE` suffix (spec 10): DL24M_BLE gives
 * DL24M, UC96_BLE is a J7-C. Names that are not Atorch names (JDY-19, a plain link) give none.
 * @param {unknown} name
 * @returns {string | undefined}
 */
export function modelFromName(name) {
  const n = cleanName(name);
  if (!n || !isAtorchName(n)) return undefined;
  const m = /^(.+?)[-_ ]?(BLE|SPP)$/i.exec(n);
  const model = (m ? m[1] : n).replace(/[-_ ]+$/, '');
  return /^UC96$/i.test(model) ? 'J7-C' : model;
}

/** Duration as h:mm:ss (hours are not limited to 24). @param {number} seconds */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** @param {number} b backlight byte (spec 9.4) @returns {ExtraValue} */
function backlightExtra(b) {
  if (b === 0) return { label: msg('Backlight'), value: msg('Always off') };
  if (b === 60) return { label: msg('Backlight'), value: msg('Always on') };
  return { label: msg('Backlight'), value: b, unit: 's', decimals: 0 };
}

/**
 * Unified snapshot of a report (spec 6). The current is a magnitude: no device sends a sign, so
 * no charging or discharging state is derived from it (spec 12 item 6).
 * @param {AtorchReport} r
 * @param {Object} [opts]
 * @param {boolean} [opts.load] DL24 family load: MOSFET temperature, load values
 * @param {boolean} [opts.showTemperature] false hides the temperature (USB meters reading 0)
 * @param {boolean} [opts.checksumOk] the report passed the learned checksum rule
 * @param {boolean} [opts.loadRunning]
 * @param {{ current?: number, cutoffVoltage?: number, timer?: number }} [opts.px100] last PX100 answers
 * @returns {Omit<BmsSnapshot, 'timestamp'>}
 */
export function reportSnapshot(r, { load = false, showTemperature = true, checksumOk = r.checksumValid, loadRunning = false, px100 } = {}) {
  const usb = r.deviceType === DEVICE.USB;
  /** @type {Record<string, ExtraValue>} */
  const extra = {
    energy: { label: msg('Energy'), value: r.energy, unit: 'Wh', decimals: usb ? 2 : 0 },
  };
  if (r.capacity !== undefined) extra.capacity = { label: msg('Capacity'), value: r.capacity, unit: 'Ah', decimals: usb ? 3 : 2 };
  extra.duration = { label: msg('Duration'), value: formatDuration(r.runtime) };
  if (r.price !== undefined) extra.price = { label: msg('Price per kWh'), value: r.price, decimals: 2 };
  if (r.frequency !== undefined) extra.frequency = { label: msg('Frequency'), value: r.frequency, unit: 'Hz', decimals: 1 };
  if (r.powerFactor !== undefined) extra.powerFactor = { label: msg('Power factor'), value: r.powerFactor, decimals: 3 };
  if (r.dataMinus !== undefined && r.dataPlus !== undefined) {
    // D- at offset 17 and D+ at 19 follow [MS], [NL], [SY], [LP]; [DV] and [DW] say the reverse (spec 6.3).
    extra.dataMinus = { label: msg('USB D- (order unverified)'), value: r.dataMinus, unit: 'V', decimals: 2 };
    extra.dataPlus = { label: msg('USB D+ (order unverified)'), value: r.dataPlus, unit: 'V', decimals: 2 };
  }
  if (load) {
    extra.loadRunning = { label: msg('Load running'), value: !!loadRunning };
    if (px100?.current !== undefined) extra.loadCurrentSetting = { label: msg('Load current setting'), value: px100.current, unit: 'A', decimals: 2 };
    if (px100?.cutoffVoltage !== undefined) extra.cutoffVoltageSetting = { label: msg('Cutoff voltage'), value: px100.cutoffVoltage, unit: 'V', decimals: 2 };
    if (px100?.timer !== undefined) extra.timerSetting = { label: msg('Timer'), value: px100.timer, unit: 's', decimals: 0 };
  }
  extra.backlight = backlightExtra(r.backlight);
  extra.checksumValid = { label: msg('Checksum valid'), value: checksumOk };
  return {
    voltage: r.voltage,
    current: r.current,
    power: r.power,
    ...(showTemperature
      ? {
          temperatures: [
            {
              id: 'internal',
              label: load ? msg('MOSFET temperature') : msg('Internal temperature'),
              value: r.temperature,
              kind: /** @type {'mos'|'board'} */ (load ? 'mos' : 'board'),
            },
          ],
        }
      : {}),
    extra,
  };
}

/** @param {unknown} err */
const isTimeout = (err) => /** @type {any} */ (err)?.code === 'TIMEOUT';

/**
 * @typedef {Object} Px100Values
 * @property {Px100State} state
 * @property {number} attempts unanswered first queries
 * @property {boolean} [load]
 * @property {number} loadAt
 * @property {number} [current] set current, A
 * @property {number} [cutoffVoltage] V
 * @property {number} [timer] s
 * @property {Set<string>} unread settings whose query did not answer
 */

export class AtorchDriver extends BaseDriver {
  /**
   * @param {DriverDefinition} definition
   * @param {DriverContext} ctx
   */
  constructor(definition, ctx) {
    super(definition, ctx);
    this.deviceName = String(ctx.link?.name ?? '');
    this.policy = new ChecksumPolicy();
    /** Kind of the PX100 request in flight; the assembler accepts PX100 answers only then. @type {'set'|'query'|null} */
    this.px100Pending = null;
    this.channel = new FrameChannel(ctx.link, {
      createAssembler: (handlers) =>
        createHostAssembler({ ...handlers, policy: this.policy, px100: () => this.px100Pending, onRule: (rule) => this.#onRule(rule) }),
      describe,
      log: ctx.log,
    });
    this.detector = new ReportDetector({ nameMatch: isAtorchName(this.deviceName) });
    /** @type {import('./protocol.js').DetectionResult | null} */
    this.detection = null;
    /** @type {((d: import('./protocol.js').DetectionResult | null) => void) | null} */
    this.onDetect = null;
    /** Device type locked by the first accepted report (spec 4.1 step 3). @type {number | undefined} */
    this.deviceType = undefined;
    /** @type {AtorchReport | null} */
    this.report = null;
    /** @type {AtorchReport | null} */
    this.previous = null;
    this.reportAt = 0;
    this.usbTemperatureSeen = false;
    this.streaming = false;
    this.startedAt = 0;
    /** @type {Px100Values} */
    this.px100 = { state: 'unknown', attempts: 0, loadAt: 0, unread: new Set() };
    /** Settings made read only by a failed write on this connection. @type {Set<string>} */
    this.readOnlyIds = new Set();
    this.lastCommandAt = 0;
    /** @type {Set<{ check: (r: AtorchReport) => void, cancel: () => void }>} */
    this.reportWaiters = new Set();
    /** @type {{ key: string, schema: import('@ubms/bms-core/settings').SettingsSchema } | null} */
    this.schemaCache = null;
    this.offFrame = this.channel.on('frame', (/** @type {Uint8Array} */ f) => this.#onFrame(f));
    this.channel.start();
  }

  /** @returns {import('@ubms/bms-core/driver').DriverCapabilities} */
  get capabilities() {
    // Streaming device: poll() is only a watchdog.
    return { settings: true, writeSettings: true, streaming: true, pollIntervalMs: 1000, minPollIntervalMs: 1000 };
  }

  /** Type 0x02 reports and a DL24 family name. */
  #isLoad() {
    return this.deviceType === DEVICE.DC && isLoadName(this.deviceName);
  }

  /** Type 0x02 reports and a DL24 / DL24P name (spec 11.3 `px100`). */
  #px100Capable() {
    return this.deviceType === DEVICE.DC && isPx100Name(this.deviceName);
  }

  /** @param {'standard'|'from3'} rule */
  #onRule(rule) {
    this.log?.event(
      rule === 'standard'
        ? 'Atorch: 5 reports in a row with a valid checksum, reports with a wrong checksum are dropped from now on'
        : 'Atorch: 5 reports in a row match the checksum from byte 3 (J7-C variant), other reports are dropped from now on',
      { source: this.definition.id },
    );
  }

  /** @param {Uint8Array} frame */
  #onFrame(frame) {
    // Replies and PX100 answers are consumed by request waiters; command echoes are noise (spec 3.3).
    if (isReportFrame(frame)) this.#onReport(frame);
  }

  /** @param {Uint8Array} frame */
  #onReport(frame) {
    const now = Date.now();
    if (!this.detection) {
      const d = this.detector.push(frame, now);
      if (!d) return;
      this.detection = d;
      this.deviceType = d.deviceType;
      this.log?.event(
        d.checksum ? `Atorch: ${d.variant} report with a valid checksum` : `Atorch: two plausible ${d.variant} reports, the device does not send a valid checksum`,
        { source: this.definition.id },
      );
      this.onDetect?.(d);
    }
    // The layout follows the type byte, never the name: the class of the AT24 / AT2401 is
    // unverified (spec 1.1).
    if (frame[3] !== this.deviceType) {
      this.log?.warn(`Atorch: report of device type ${frame[3]} ignored, this connection is locked to type ${this.deviceType}`, { source: this.definition.id });
      return;
    }
    const r = parseReport(frame);
    this.previous = this.report;
    this.report = r;
    this.reportAt = now;
    if (r.deviceType === DEVICE.USB && r.temperature !== 0) this.usbTemperatureSeen = true;
    if (this.streaming) this.publish(this.#snapshot(r));
    for (const w of [...this.reportWaiters]) w.check(r);
  }

  /** @param {AtorchReport} r */
  #snapshot(r) {
    const load = this.#isLoad();
    const px = this.px100;
    const answered = px.state === 'available' || px.state === 'failed';
    return reportSnapshot(r, {
      load,
      // A UD18 reports 0 degC because it has no sensor (spec 12 item 22).
      showTemperature: r.deviceType !== DEVICE.USB || this.usbTemperatureSeen,
      checksumOk: this.policy.rule === 'from3' ? r.checksumFrom3Valid : r.checksumValid,
      loadRunning: load ? this.#loadRunning(r) : false,
      px100: answered ? { current: px.current, cutoffVoltage: px.cutoffVoltage, timer: px.timer } : undefined,
    });
  }

  /**
   * Load state: a recent PX100 answer, otherwise derived from the reports, running when the
   * runtime seconds byte changed ([SY]) or current flows ([JC]) (spec 8.2).
   * @param {AtorchReport} r
   */
  #loadRunning(r) {
    const px = this.px100;
    if (px.load !== undefined && Date.now() - px.loadAt <= PX100_FRESH_MS) return px.load;
    if (r.current > 0) return true;
    return !!this.previous && this.previous !== r && this.previous.runtimeSeconds !== r.runtimeSeconds;
  }

  /**
   * Publish without a derived charging state: the current of every Atorch device is a magnitude.
   * @param {Omit<BmsSnapshot, 'timestamp'> & { timestamp?: number }} s
   */
  publish(s) {
    const snap = deriveSnapshot({ ...s, timestamp: s.timestamp ?? Date.now() });
    delete snap.state;
    delete snap.timeToFull;
    delete snap.timeToEmpty;
    this.lastSnapshot = snap;
    this.emit('snapshot', snap);
    return snap;
  }

  /**
   * Passive probe (spec 11.2): listen for up to 3 s, never write. The listener runs from the
   * moment the channel started, so reports that arrived before this call count too.
   * @param {{ timeout?: number }} [opts]
   */
  async probe({ timeout = LISTEN_MS } = {}) {
    const d =
      this.detection ??
      (await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.onDetect = null;
          resolve(null);
        }, Math.max(LISTEN_MS, timeout));
        this.onDetect = (det) => {
          clearTimeout(timer);
          this.onDetect = null;
          resolve(det);
        };
      }));
    if (!d) return null;
    this.setVariant(d.variant);
    return { variant: d.variant, confidence: d.confidence, info: this.#info() };
  }

  async start() {
    this.streaming = true;
    this.startedAt = Date.now();
    if (this.report) this.publish(this.#snapshot(this.report));
  }

  /** Watchdog only: the device streams by itself. */
  async poll() {
    if (!this.streaming) return;
    if (Date.now() - Math.max(this.reportAt, this.startedAt) > STALL_MS) throw new Error(msg('No reports from the device for several seconds'));
  }

  async stop() {
    this.streaming = false;
  }

  /** @returns {DeviceInfo} */
  #info() {
    const model = modelFromName(this.deviceName);
    /** @type {DeviceInfo} */
    const info = { vendor: ATORCH_VENDOR, protocol: this.definition.protocol };
    if (model) info.model = model;
    // No version, serial or device information frame exists (spec 10).
    if (this.deviceType) info.extra = { deviceClass: { label: msg('Device class'), value: CLASS_LABELS[this.deviceType] } };
    return info;
  }

  async readInfo() {
    this.lastInfo = this.#info();
    return this.lastInfo;
  }

  getSettingsSchema() {
    if (!this.deviceType) return null;
    const px = this.px100;
    const key = [this.deviceType, px.state, [...this.readOnlyIds].sort().join(','), [...px.unread].sort().join(',')].join('|');
    if (this.schemaCache?.key !== key) {
      this.schemaCache = {
        key,
        schema: buildAtorchSchema({
          deviceType: this.deviceType,
          load: this.#isLoad(),
          px100Capable: this.#px100Capable(),
          px100: px.state,
          maxLoadCurrent: maxLoadCurrent(this.deviceName),
          readOnly: this.readOnlyIds,
          unreadable: px.unread,
        }),
      };
    }
    return this.schemaCache.schema;
  }

  async readSettings() {
    const r = this.report ?? (await this.#waitForReport(() => true, LIVE_WAIT_MS));
    if (!r) throw new Error(msg('No reports from the device'));
    /** @type {Record<string, any>} */
    const values = { 'atorch.backlight': r.backlight };
    if (r.price !== undefined) values['atorch.price'] = r.price;
    if (this.#isLoad()) {
      if (this.#px100Capable()) await this.#refreshPx100();
      const px = this.px100;
      const answered = px.state === 'available' || px.state === 'failed';
      // Same rule as the snapshots: a PX100 answer counts only while it is fresh, otherwise the
      // reports decide. A load that stopped answering 0x10 must not keep an old state here, where
      // the settings switch and the read back of a write would contradict the reports.
      values['atorch.load'] = this.#loadRunning(this.report ?? r);
      if (answered) {
        for (const p of PX100_PRESETS) if (px[p.key] !== undefined && !px.unread.has(p.id)) values[p.id] = px[p.key];
      }
    }
    return values;
  }

  /**
   * Query the PX100 load state and presets (0x10, 0x17, 0x18, 0x19). Read only; a load that
   * never answers is asked at most PX100_MAX_ATTEMPTS times per connection.
   */
  async #refreshPx100() {
    const px = this.px100;
    if (px.state === 'unanswered' && px.attempts >= PX100_MAX_ATTEMPTS) return;
    const state = await this.#px100Query(PX100.Q_LOAD);
    if (!state) {
      if (px.state === 'unknown' || px.state === 'unanswered') {
        px.attempts++;
        px.state = 'unanswered';
        this.log?.event(`Atorch: no PX100 answer (attempt ${px.attempts}), the load settings stay read only`, { source: this.definition.id });
      }
      return;
    }
    if (px.state !== 'failed') px.state = 'available';
    px.load = state.loadOn;
    px.loadAt = Date.now();
    for (const p of PX100_PRESETS) {
      const a = await this.#px100Query(p.query);
      if (a && a[p.key] !== undefined) {
        px[p.key] = a[p.key];
        px.unread.delete(p.id);
      } else if (px[p.key] === undefined) {
        px.unread.add(p.id);
      }
    }
  }

  /**
   * @param {string} id
   * @param {any} value engineering units
   */
  async writeSetting(id, value) {
    const f = fieldMap(this.getSettingsSchema()).get(id);
    if (!f || f.type === 'action') throw new Error(msg('Unknown setting'));
    if (f.readOnly) throw new Error(msg('This value is read only'));
    // The schema limits are the only guard of the load: the PX100 encoders accept up to 255.99 A
    // or V, so a caller that skips the session validation must not get past them either.
    if (f.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || (f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) throw new Error(msg('Invalid value'));
    }
    const meta = f.meta ?? {};
    if (meta.kind === 'ff55') return this.#writeMeterSetting(id, meta.opcode, Number(value));
    if (meta.kind === 'px100') return this.#writeLoadSetting(id, meta.query, value);
    throw new Error(msg('Unknown setting'));
  }

  /**
   * Backlight (0x21) or price (0x22), confirmed by the next reports (spec 7.2). A reply 03 or
   * reports that keep the old value make the setting read only for this connection.
   * @param {string} id
   * @param {number} opcode
   * @param {number} value
   */
  async #writeMeterSetting(id, opcode, value) {
    if (this.deviceType !== DEVICE.AC && this.deviceType !== DEVICE.DC) throw new Error(msg('This value is read only'));
    /** @type {number} */
    let raw;
    try {
      raw = meterRawValue(id, value);
    } catch {
      throw new Error(msg('Invalid value'));
    }
    const reply = await this.#command(opcode, raw);
    if (reply?.status === STATUS.UNSUPPORTED) {
      this.#makeReadOnly(id, 'the device answered "unsupported"');
      throw new Error(msg('The device does not support this setting, so it is read only from now on'));
    }
    if (reply && reply.status !== STATUS.OK) throw new Error(msg('The device rejected the command'));
    const shown = await this.#waitForReport((r) => reportShows(id, r, raw), READBACK_MS);
    if (!shown) {
      this.#makeReadOnly(id, 'the reports do not show the new value');
      throw new Error(msg('The reports do not show the new value, so the setting is read only from now on'));
    }
  }

  /**
   * PX100 load setting (spec 7.1, 8.2), then the read back query. No `6F` within about 1 s makes
   * every load setting read only for this connection.
   * @param {string} id
   * @param {number} query
   * @param {any} value
   */
  async #writeLoadSetting(id, query, value) {
    if (this.px100.state !== 'available' || !this.#px100Capable()) throw new Error(msg('This value is read only'));
    const n = Number(value);
    if (id === 'atorch.timer' && (!Number.isInteger(n) || n % 60 !== 0)) throw new Error(msg('The timer is set in whole minutes'));
    /** @type {Uint8Array} */
    let bytes;
    try {
      bytes =
        id === 'atorch.load'
          ? px100Load(value === true || value === 1 || value === 'true')
          : id === 'atorch.load_current'
            ? px100SetCurrent(n)
            : id === 'atorch.cutoff_voltage'
              ? px100SetCutoff(n)
              : px100SetTimer(n);
    } catch {
      throw new Error(msg('Invalid value'));
    }
    await this.#requireLiveReports();
    const ack = await this.#px100Exchange(bytes, 'set');
    if (!ack) {
      this.px100.state = 'failed';
      this.log?.event('Atorch: no PX100 acknowledgement (6F), the load settings are read only for this connection', { source: this.definition.id });
      throw new Error(msg('The load did not acknowledge the command, so the load settings are read only for this connection'));
    }
    const answer = await this.#px100Query(query);
    if (!answer) return;
    const px = this.px100;
    if (query === PX100.Q_LOAD) {
      px.load = answer.loadOn;
      px.loadAt = Date.now();
      return;
    }
    const preset = PX100_PRESETS.find((p) => p.query === query);
    if (preset && answer[preset.key] !== undefined) {
      px[preset.key] = answer[preset.key];
      px.unread.delete(preset.id);
    }
  }

  /**
   * @param {string} id
   * @param {string} reason English, for the log
   */
  #makeReadOnly(id, reason) {
    this.readOnlyIds.add(id);
    this.log?.event(`Atorch: ${id} is read only for this connection (${reason})`, { source: this.definition.id });
  }

  /**
   * Run an action field: counter resets and front panel keys, each sent once (spec 8.1).
   * @param {string} id
   * @param {any} [_arg]
   */
  async runAction(id, _arg) {
    const f = fieldMap(this.getSettingsSchema()).get(id);
    if (!f || f.type !== 'action' || f.meta?.kind !== 'action') throw new Error(msg('Unknown action'));
    const opcode = f.meta.opcode;
    // Never on AC meters: the same frame toggles the relay of an S1-B (spec 8.1, 12 item 18).
    if (opcode === OP.RESET_CAPACITY && this.deviceType === DEVICE.AC) throw new Error(msg('Unknown action'));
    const reply = await this.#command(opcode, 0);
    if (!reply) throw new Error(msg('No reply from the device. The command may still have been taken, so check the device before trying again.'));
    if (reply.status === STATUS.UNSUPPORTED) throw new Error(msg('The device does not support this command'));
    if (reply.status !== STATUS.OK) throw new Error(msg('The device rejected the command'));
  }

  /**
   * Send one FF 55 command with the device type of the reports and wait for its reply. Returns the
   * parsed reply, or null when none came: replies are not guaranteed (spec 4.1 step 6), and the
   * command is never repeated (spec 12 item 11).
   * @param {number} opcode
   * @param {number} value
   */
  async #command(opcode, value) {
    if (!this.deviceType) throw new Error(msg('Not connected'));
    await this.#requireLiveReports();
    const bytes = encodeCommand(this.deviceType, opcode, value);
    const d = describe(bytes);
    return this.channel.exclusive(async () => {
      await this.#spacing();
      try {
        const frame = await this.channel.requestUnqueued(bytes, { match: isReplyFrame, timeout: REPLY_TIMEOUT_MS, retries: 0, name: d?.name, decode: d?.decode });
        return parseReply(frame);
      } catch (err) {
        if (!isTimeout(err)) throw err;
        this.log?.warn(`Atorch: no reply to ${OP_NAMES[/** @type {keyof typeof OP_NAMES} */ (opcode)] ?? `opcode ${opcode}`}`, { source: this.definition.id });
        return null;
      } finally {
        this.lastCommandAt = Date.now();
      }
    });
  }

  /**
   * One PX100 request; resolves with the answer frame or null after about 1 s.
   * @param {Uint8Array} bytes
   * @param {'set'|'query'} kind
   * @returns {Promise<Uint8Array | null>}
   */
  #px100Exchange(bytes, kind) {
    const d = describe(bytes);
    return this.channel.exclusive(async () => {
      await this.#spacing();
      this.px100Pending = kind;
      try {
        return await this.channel.requestUnqueued(bytes, {
          match: kind === 'set' ? isPx100Ack : isPx100Reply,
          timeout: PX100_TIMEOUT_MS,
          retries: 0,
          name: d?.name,
          decode: d?.decode,
        });
      } catch (err) {
        if (!isTimeout(err)) throw err;
        this.log?.warn(`Atorch: no answer to ${d?.name ?? 'PX100 request'}`, { source: this.definition.id });
        return null;
      } finally {
        this.px100Pending = null;
        this.lastCommandAt = Date.now();
      }
    });
  }

  /** @param {number} query */
  async #px100Query(query) {
    const frame = await this.#px100Exchange(px100Query(query), 'query');
    return frame ? parsePx100Reply(frame, query) : null;
  }

  async #spacing() {
    const wait = this.lastCommandAt + COMMAND_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /**
   * Commands only go out while reports arrive: a UD18 can stop notifying while it still takes
   * writes, and then nobody could confirm the effect (spec 4.1 step 5).
   */
  async #requireLiveReports() {
    if (this.report && Date.now() - this.reportAt <= LIVE_REPORT_MS) return;
    const r = await this.#waitForReport(() => true, LIVE_WAIT_MS);
    if (!r) throw new Error(msg('The device sends no reports right now, so the command was not sent'));
  }

  /**
   * Next report (arriving after this call) accepted by `pred`, or null after `timeout`.
   * @param {(r: AtorchReport) => boolean} pred
   * @param {number} timeout
   * @returns {Promise<AtorchReport | null>}
   */
  #waitForReport(pred, timeout) {
    return new Promise((resolve) => {
      /** @type {ReturnType<typeof setTimeout>} */
      let timer;
      /** @param {AtorchReport | null} r */
      const done = (r) => {
        clearTimeout(timer);
        this.reportWaiters.delete(waiter);
        resolve(r);
      };
      const waiter = { check: (/** @type {AtorchReport} */ r) => void (pred(r) && done(r)), cancel: () => done(null) };
      timer = setTimeout(() => done(null), timeout);
      this.reportWaiters.add(waiter);
    });
  }

  dispose() {
    for (const w of [...this.reportWaiters]) w.cancel();
    this.onDetect?.(null);
    this.offFrame?.();
    this.channel.stop();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------------------------

/**
 * GATT profile (spec 2.1): service FFE0, FFE1 for notifications and commands. 'auto' writes with
 * response when FFE1 offers it, so a lost command can be told from an ignored one ([LP]); FFE2
 * is never required (missing on the J7-H). There is no serial profile yet: reading the SPP side
 * through Web Serial at 9600 baud was not tried by any source (spec 2.1, unverified).
 */
const BLE_PROFILE = {
  id: 'atorch-ffe0',
  label: 'FFE0/FFE1',
  service: 0xffe0,
  notify: 0xffe1,
  write: 0xffe1,
  writeMode: /** @type {const} */ ('auto'),
  chunkSize: 20,
};

/** @type {import('../index.js').DriverDefinitionWithDemo} */
export const atorchDefinition = {
  id: 'atorch',
  family: 'atorch',
  vendor: ATORCH_VENDOR,
  protocol: msg('Atorch FF 55 (Bluetooth)'),
  deviceType: 'meter',
  experimental: true,
  description: msg('Atorch meters, USB testers and DL24 electronic loads that push a report every second over Bluetooth LE. Detection only listens and never writes.'),
  links: {
    ble: {
      profiles: [BLE_PROFILE],
      namePrefixes: [...NAME_PREFIXES],
      namePatterns: [NAME_PATTERN],
    },
  },
  create: (ctx) => new AtorchDriver(atorchDefinition, ctx),
  demo: { name: 'DL24-BLE (demo)', chunkSize: 20, create: (link) => createAtorchSimulator(link, { load: true }) },
};
