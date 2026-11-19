import { buildSchema, field, msg } from '@ubms/bms-core';
import { BACKLIGHT, DEVICE, OP, PRICE_RAW, PX100 } from './protocol.js';

/**
 * Settings and actions of the Atorch driver (spec 7, 8). Only what the spec confirms is writable:
 * backlight and price over FF 55 (AC and DC meters, checked against the next reports), and for
 * DL24 / DL24P loads that answered a PX100 query on this connection the load switch, current,
 * cutoff voltage and timer (experimental, read back with PX100 queries). Load mode and
 * protections are only reachable through the front panel keys; everything on USB meters is read
 * only (a UD18 rejects backlight and price).
 *
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {import('@ubms/bms-core/settings').SettingsSchema} SettingsSchema
 * @typedef {'unknown'|'unanswered'|'available'|'failed'} Px100State
 */

/** Driver specific groups, in display order. */
export const ATORCH_GROUPS = Object.freeze({
  atorch_load: {
    label: msg('Electronic load'),
    icon: 'bolt',
    description: msg('Load switch, current, cutoff voltage and timer, sent with the PX100 commands of the DL24 family (experimental)'),
  },
  atorch_meter: { label: msg('Meter'), icon: 'gauge', description: msg('Backlight and energy price of the meter') },
  atorch_counters: { label: msg('Counters'), icon: 'refresh', description: msg('Energy, capacity and duration counters of the device') },
  atorch_keys: {
    label: msg('Remote keys'),
    icon: 'sliders',
    description: msg('Front panel keys pressed remotely. The app cannot see the device menu, so every press is blind. Load mode and protections can only be changed this way.'),
  },
});

/** PX100 presets: query, key of the parsed answer, setting id (spec 5.3). */
export const PX100_PRESETS = Object.freeze([
  { query: PX100.Q_CURRENT_SETTING, key: /** @type {'current'} */ ('current'), id: 'atorch.load_current' },
  { query: PX100.Q_CUTOFF_SETTING, key: /** @type {'cutoffVoltage'} */ ('cutoffVoltage'), id: 'atorch.cutoff_voltage' },
  { query: PX100.Q_TIMER_SETTING, key: /** @type {'timer'} */ ('timer'), id: 'atorch.timer' },
]);

const PX100_FAILED = msg('The load did not acknowledge a PX100 command on this connection, so the load settings are read only.');
const WRITE_FAILED = msg('The device did not take this setting on this connection, so it is read only now.');

/** Lowest cutoff voltage that still protects a battery under test (warning only). */
const LOW_CUTOFF_V = 1;

/**
 * @param {Object} opts
 * @param {number} opts.deviceType report device type (1 AC, 2 DC, 3 USB)
 * @param {boolean} [opts.load] the name says DL24 family (DL24, DL24P, DL24M) and the reports are type 0x02
 * @param {boolean} [opts.px100Capable] DL24 or DL24P (PX100 documented; unknown for DL24M)
 * @param {Px100State} [opts.px100] PX100 state on this connection
 * @param {number} [opts.maxLoadCurrent] A
 * @param {ReadonlySet<string>} [opts.readOnly] ids made read only by a failed write
 * @param {ReadonlySet<string>} [opts.unreadable] PX100 settings whose query has not answered
 * @returns {SettingsSchema}
 */
export function buildAtorchSchema({ deviceType, load = false, px100Capable = false, px100 = 'unknown', maxLoadCurrent = 20, readOnly = new Set(), unreadable = new Set() }) {
  /** @type {SettingField[]} */
  const fields = [];

  if (load && deviceType === DEVICE.DC) {
    const answered = px100Capable && (px100 === 'available' || px100 === 'failed');
    if (answered) {
      const locked = px100 === 'failed';
      /**
       * @param {string} id
       * @param {Partial<SettingField>} props
       * @param {number} command
       * @param {number} query
       */
      const px = (id, props, command, query) =>
        fields.push(
          field(id, {
            group: 'atorch_load',
            danger: true,
            ...props,
            readOnly: locked || readOnly.has(id),
            ...(unreadable.has(id) && !locked ? { writeOnly: true } : {}),
            ...(locked ? { description: PX100_FAILED } : {}),
            meta: { kind: 'px100', command, query },
          }),
        );
      px('atorch.load', { label: msg('Load on'), type: 'boolean', description: msg('Switches the load on or off (not a toggle). The load drains the source under test. Experimental: PX100 command, unverified over Bluetooth LE.') }, PX100.LOAD, PX100.Q_LOAD);
      px(
        'atorch.load_current',
        { label: msg('Load current'), unit: 'A', decimals: 2, min: 0.2, max: maxLoadCurrent, description: msg('Constant current of the load. Experimental: PX100 command, unverified over Bluetooth LE.') },
        PX100.SET_CURRENT,
        PX100.Q_CURRENT_SETTING,
      );
      px(
        'atorch.cutoff_voltage',
        {
          label: msg('Cutoff voltage'),
          unit: 'V',
          decimals: 2,
          min: 0,
          max: 200,
          description: msg('The load stops when the voltage falls below this value. Experimental: PX100 command, unverified over Bluetooth LE.'),
          warn: (values) => (Number(values['atorch.cutoff_voltage']) < LOW_CUTOFF_V ? msg('A cutoff this low does not protect the battery under test.') : null),
        },
        PX100.SET_CUTOFF,
        PX100.Q_CUTOFF_SETTING,
      );
      px(
        'atorch.timer',
        {
          label: msg('Timer'),
          unit: 's',
          decimals: 0,
          step: 60,
          min: 0,
          max: 65520,
          description: msg('Run time limit of the load in seconds, whole minutes only (the load keeps minutes). Experimental: PX100 command, unverified over Bluetooth LE.'),
          validate: (values) => (Number(values['atorch.timer']) % 60 !== 0 ? msg('The timer is set in whole minutes') : null),
        },
        PX100.SET_TIMER,
        PX100.Q_TIMER_SETTING,
      );
    } else {
      fields.push(
        field('atorch.load', {
          label: msg('Load running'),
          group: 'atorch_load',
          type: 'boolean',
          readOnly: true,
          description: px100Capable
            ? msg('Derived from the reports (the duration counts or current flows). Switching needs the PX100 commands, which this load has not answered.')
            : msg('Derived from the reports (the duration counts or current flows). No PX100 support is known for this model, so the load is not switched from the app.'),
          meta: { kind: 'derived' },
        }),
      );
    }
  }

  // Backlight and price (opcodes 0x21, 0x22): AC and DC meters only (spec 7.2).
  const meter = deviceType === DEVICE.AC || deviceType === DEVICE.DC;
  fields.push(
    field('atorch.backlight', {
      label: msg('Backlight time'),
      group: 'atorch_meter',
      unit: 's',
      decimals: 0,
      step: 1,
      min: BACKLIGHT.OFF,
      max: BACKLIGHT.MAX,
      readOnly: !meter || readOnly.has('atorch.backlight'),
      description: !meter
        ? msg('USB meters reject the backlight command, so the value is shown read only.')
        : readOnly.has('atorch.backlight')
          ? WRITE_FAILED
          : msg('0 keeps the backlight off, 60 keeps it on, other values switch it off after that many seconds.'),
      meta: { kind: 'ff55', opcode: OP.SET_BACKLIGHT },
    }),
  );
  if (meter) {
    fields.push(
      field('atorch.price', {
        label: msg('Energy price per kWh'),
        group: 'atorch_meter',
        decimals: 2,
        min: PRICE_RAW.MIN / 100,
        max: PRICE_RAW.MAX / 100,
        readOnly: readOnly.has('atorch.price'),
        description: readOnly.has('atorch.price') ? WRITE_FAILED : msg('The meter shows the cost of the measured energy with this price. The protocol carries no currency.'),
        meta: { kind: 'ff55', opcode: OP.SET_PRICE },
      }),
    );
  }

  /**
   * @param {string} id
   * @param {string} label
   * @param {number} opcode
   * @param {string} description
   */
  const counter = (id, label, opcode, description) =>
    fields.push(field(id, { label, group: 'atorch_counters', type: 'action', danger: true, description, meta: { kind: 'action', opcode } }));
  counter('atorch.reset_energy', msg('Reset energy counter'), OP.RESET_ENERGY, msg('Clears the accumulated energy, and with it the cost the meter derives from it.'));
  // Never on AC meters: the same frame toggles the relay of an S1-B smart socket (spec 8.1).
  if (deviceType !== DEVICE.AC) counter('atorch.reset_capacity', msg('Reset capacity counter'), OP.RESET_CAPACITY, msg('Clears the accumulated capacity (Ah).'));
  counter('atorch.reset_runtime', msg('Reset duration counter'), OP.RESET_RUNTIME, msg('Sets the duration counter back to 0:00:00.'));
  counter('atorch.reset_all', msg('Reset all counters'), OP.RESET_ALL, msg('Clears energy, capacity and duration.'));

  /**
   * @param {string} id
   * @param {string} label
   * @param {number} opcode
   * @param {string} description
   * @param {Partial<SettingField>} [props]
   */
  const key = (id, label, opcode, description, props = {}) =>
    fields.push(field(id, { label, group: 'atorch_keys', type: 'action', advanced: true, description, ...props, meta: { kind: 'action', opcode, key: true } }));
  // On a load the menu keys are the only way to the load current, cutoff, timer, mode and
  // protections on FF 55 (spec 1.2, 7.1), so a blind press can change what the load does: they
  // are confirmed like the PX100 writes.
  const loadKey = load ? { danger: true } : {};
  key(
    'atorch.key_setup',
    msg('Setup key'),
    OP.SETUP,
    load ? msg('Presses the Setup key once. On a load it moves through the settings menu, where + and - change the load current, cutoff, timer, mode and protections.') : msg('Presses the Setup key once.'),
    loadKey,
  );
  if (load) {
    key('atorch.key_enter', msg('ON/OFF key (toggles the load)'), OP.ENTER, msg('Presses the ON/OFF key once, which switches the load on or off. A lost reply is never retried, so check the load before pressing again.'), {
      danger: true,
    });
  } else {
    key('atorch.key_enter', msg('Enter key'), OP.ENTER, msg('Presses the Enter key once.'));
  }
  // 0x33 / 0x34 for every device type, as the vendor apps send them; 0x11 / 0x12 are never used (spec 5.1).
  key(
    'atorch.key_plus',
    msg('Plus key'),
    OP.PLUS_USB,
    load ? msg('Presses the + key once. On a load a press can raise a load setting such as the current, so check the display before each press.') : msg('Presses the + key once.'),
    loadKey,
  );
  key(
    'atorch.key_minus',
    msg('Minus key'),
    OP.MINUS_USB,
    load ? msg('Presses the - key once. On a load a press can lower a load setting such as the current, so check the display before each press.') : msg('Presses the - key once.'),
    loadKey,
  );

  return buildSchema(fields, ATORCH_GROUPS);
}

/**
 * Raw command value of a meter setting: backlight in whole seconds 0..60, price x 100 in
 * 1..999999 (spec 7.1). Throws a RangeError outside the range.
 * @param {string} id
 * @param {number} value
 */
export function meterRawValue(id, value) {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid value for ${id}`);
  if (id === 'atorch.backlight') {
    const raw = Math.round(value);
    if (raw < BACKLIGHT.OFF || raw > BACKLIGHT.MAX) throw new RangeError(`Backlight out of range: ${value}`);
    return raw;
  }
  if (id === 'atorch.price') {
    const raw = Math.round(value * 100);
    if (raw < PRICE_RAW.MIN || raw > PRICE_RAW.MAX) throw new RangeError(`Price out of range: ${value}`);
    return raw;
  }
  throw new RangeError(`Not a meter setting: ${id}`);
}

/**
 * Whether a report shows the raw value of a meter setting (read back of spec 7.1).
 * @param {string} id
 * @param {import('./protocol.js').AtorchReport} report
 * @param {number} raw
 */
export function reportShows(id, report, raw) {
  if (id === 'atorch.backlight') return report.backlight === raw;
  if (id === 'atorch.price') return report.price !== undefined && Math.round(report.price * 100) === raw;
  return false;
}
