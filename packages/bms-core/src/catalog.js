import { msg } from './msg.js';

/**
 * Shared vocabulary for settings and alarms, so the same concept looks and translates the same
 * on every BMS. Drivers reference these ids and only add protocol details (register, scaling,
 * limits). Ids that are unique to one device family use a driver prefix instead (for example
 * `jk.smart_sleep_hours`) and bring their own label.
 */

/**
 * Settings groups in display order.
 * @type {Record<string, { label: string, icon: string, description?: string }>}
 */
export const SETTING_GROUPS = {
  cell_voltage: { label: msg('Cell voltage'), icon: 'cell', description: msg('Cell over- and undervoltage protection and recovery') },
  pack_voltage: { label: msg('Pack voltage'), icon: 'battery', description: msg('Total pack voltage limits') },
  charging: { label: msg('Charging'), icon: 'bolt', description: msg('Charge voltage requests and charge behaviour') },
  current: { label: msg('Current protection'), icon: 'current', description: msg('Charge, discharge and short circuit protection') },
  temperature: { label: msg('Temperature'), icon: 'thermometer', description: msg('Temperature protection for charging, discharging and the MOSFETs') },
  balancing: { label: msg('Balancing'), icon: 'balance', description: msg('Cell balancer behaviour') },
  capacity: { label: msg('Capacity and SOC'), icon: 'gauge', description: msg('Capacity, state of charge and cycle settings') },
  controls: { label: msg('Switches'), icon: 'power', description: msg('MOSFET and feature switches') },
  system: { label: msg('System'), icon: 'chip', description: msg('Cell count, sensors, sleep and communication') },
  identity: { label: msg('Device identity'), icon: 'tag', description: msg('Name, passwords and production data') },
  calibration: { label: msg('Calibration'), icon: 'ruler', description: msg('Voltage, current and SOC calibration') },
  wire_resistance: { label: msg('Wire resistance'), icon: 'cable', description: msg('Compensation of cell connection resistance') },
  advanced: { label: msg('Advanced'), icon: 'sliders', description: msg('Rarely used parameters') },
  actions: { label: msg('Maintenance'), icon: 'wrench', description: msg('Restart, reset and other one-off actions') },
};

/**
 * Canonical settings. `unit` and `decimals` are defaults, drivers may override every property.
 * @type {Record<string, { label: string, group: string, unit?: string, decimals?: number, description?: string, type?: 'number'|'boolean'|'enum'|'text'|'action' }>}
 */
export const SETTINGS = {
  // Cell voltage
  'cell.ovp': { label: msg('Cell overvoltage protection'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.ovpr': { label: msg('Cell overvoltage recovery'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.ovp_delay': { label: msg('Cell overvoltage delay'), group: 'cell_voltage', unit: 's', decimals: 0 },
  'cell.uvp': { label: msg('Cell undervoltage protection'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.uvpr': { label: msg('Cell undervoltage recovery'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.uvp_delay': { label: msg('Cell undervoltage delay'), group: 'cell_voltage', unit: 's', decimals: 0 },
  'cell.ov_alarm': { label: msg('Cell high voltage alarm'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.uv_alarm': { label: msg('Cell low voltage alarm'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.diff_alarm': { label: msg('Cell voltage difference alarm'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.diff_protection': { label: msg('Cell voltage difference protection'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  'cell.power_off_voltage': { label: msg('Power off voltage'), group: 'cell_voltage', unit: 'V', decimals: 3, description: msg('Cell voltage at which the BMS shuts down completely') },
  'cell.sleep_voltage': { label: msg('Sleep voltage'), group: 'cell_voltage', unit: 'V', decimals: 3 },
  // Pack voltage
  'pack.ovp': { label: msg('Pack overvoltage protection'), group: 'pack_voltage', unit: 'V', decimals: 1 },
  'pack.ovpr': { label: msg('Pack overvoltage recovery'), group: 'pack_voltage', unit: 'V', decimals: 1 },
  'pack.uvp': { label: msg('Pack undervoltage protection'), group: 'pack_voltage', unit: 'V', decimals: 1 },
  'pack.uvpr': { label: msg('Pack undervoltage recovery'), group: 'pack_voltage', unit: 'V', decimals: 1 },
  'pack.ov_alarm': { label: msg('Pack high voltage alarm'), group: 'pack_voltage', unit: 'V', decimals: 1 },
  'pack.uv_alarm': { label: msg('Pack low voltage alarm'), group: 'pack_voltage', unit: 'V', decimals: 1 },
  // Charging
  'charge.request_voltage': { label: msg('Charge request voltage (per cell)'), group: 'charging', unit: 'V', decimals: 3 },
  'charge.float_voltage': { label: msg('Float voltage (per cell)'), group: 'charging', unit: 'V', decimals: 3 },
  'charge.soc100_voltage': { label: msg('Cell voltage at 100 % SOC'), group: 'capacity', unit: 'V', decimals: 3 },
  'charge.soc0_voltage': { label: msg('Cell voltage at 0 % SOC'), group: 'capacity', unit: 'V', decimals: 3 },
  // Current
  'charge.ocp': { label: msg('Charge overcurrent protection'), group: 'current', unit: 'A', decimals: 1 },
  'charge.ocp_delay': { label: msg('Charge overcurrent delay'), group: 'current', unit: 's', decimals: 0 },
  'charge.ocp_recovery': { label: msg('Charge overcurrent recovery time'), group: 'current', unit: 's', decimals: 0 },
  'charge.oc_alarm': { label: msg('Charge overcurrent alarm'), group: 'current', unit: 'A', decimals: 1 },
  'discharge.ocp': { label: msg('Discharge overcurrent protection'), group: 'current', unit: 'A', decimals: 1 },
  'discharge.ocp_delay': { label: msg('Discharge overcurrent delay'), group: 'current', unit: 's', decimals: 0 },
  'discharge.ocp_recovery': { label: msg('Discharge overcurrent recovery time'), group: 'current', unit: 's', decimals: 0 },
  'discharge.oc_alarm': { label: msg('Discharge overcurrent alarm'), group: 'current', unit: 'A', decimals: 1 },
  'discharge.ocp2': { label: msg('Discharge overcurrent protection, level 2'), group: 'current', unit: 'A', decimals: 1 },
  'discharge.ocp2_delay': { label: msg('Discharge overcurrent delay, level 2'), group: 'current', unit: 'ms', decimals: 0 },
  'scp.delay': { label: msg('Short circuit protection delay'), group: 'current', unit: 'µs', decimals: 0 },
  'scp.recovery': { label: msg('Short circuit recovery time'), group: 'current', unit: 's', decimals: 0 },
  'scp.current': { label: msg('Short circuit protection current'), group: 'current', unit: 'A', decimals: 0 },
  // Temperature
  'charge.otp': { label: msg('Charge overtemperature protection'), group: 'temperature', unit: '°C', decimals: 1 },
  'charge.otpr': { label: msg('Charge overtemperature recovery'), group: 'temperature', unit: '°C', decimals: 1 },
  'charge.utp': { label: msg('Charge undertemperature protection'), group: 'temperature', unit: '°C', decimals: 1 },
  'charge.utpr': { label: msg('Charge undertemperature recovery'), group: 'temperature', unit: '°C', decimals: 1 },
  'discharge.otp': { label: msg('Discharge overtemperature protection'), group: 'temperature', unit: '°C', decimals: 1 },
  'discharge.otpr': { label: msg('Discharge overtemperature recovery'), group: 'temperature', unit: '°C', decimals: 1 },
  'discharge.utp': { label: msg('Discharge undertemperature protection'), group: 'temperature', unit: '°C', decimals: 1 },
  'discharge.utpr': { label: msg('Discharge undertemperature recovery'), group: 'temperature', unit: '°C', decimals: 1 },
  'mos.otp': { label: msg('MOSFET overtemperature protection'), group: 'temperature', unit: '°C', decimals: 1 },
  'mos.otpr': { label: msg('MOSFET overtemperature recovery'), group: 'temperature', unit: '°C', decimals: 1 },
  'temp.diff_alarm': { label: msg('Temperature difference alarm'), group: 'temperature', unit: '°C', decimals: 0 },
  // Balancing
  'balance.enabled': { label: msg('Balancer enabled'), group: 'balancing', type: 'boolean' },
  'balance.start_voltage': { label: msg('Balance start voltage'), group: 'balancing', unit: 'V', decimals: 3 },
  'balance.trigger_delta': { label: msg('Balance trigger voltage difference'), group: 'balancing', unit: 'V', decimals: 3 },
  'balance.max_current': { label: msg('Maximum balance current'), group: 'balancing', unit: 'A', decimals: 1 },
  'balance.charge_only': { label: msg('Balance only while charging'), group: 'balancing', type: 'boolean' },
  // Capacity
  'capacity.nominal': { label: msg('Nominal capacity'), group: 'capacity', unit: 'Ah', decimals: 1 },
  'capacity.remaining': { label: msg('Remaining capacity'), group: 'capacity', unit: 'Ah', decimals: 1 },
  'capacity.cycle': { label: msg('Cycle capacity'), group: 'capacity', unit: 'Ah', decimals: 1 },
  'soc.value': { label: msg('State of charge'), group: 'capacity', unit: '%', decimals: 0 },
  'soc.low_alarm': { label: msg('Low SOC alarm'), group: 'capacity', unit: '%', decimals: 0 },
  // Controls
  'switch.charge': { label: msg('Charge MOSFET'), group: 'controls', type: 'boolean' },
  'switch.discharge': { label: msg('Discharge MOSFET'), group: 'controls', type: 'boolean' },
  'switch.balance': { label: msg('Balancer'), group: 'controls', type: 'boolean' },
  'switch.heater': { label: msg('Heater'), group: 'controls', type: 'boolean' },
  'switch.buzzer': { label: msg('Buzzer'), group: 'controls', type: 'boolean' },
  'switch.display': { label: msg('Display always on'), group: 'controls', type: 'boolean' },
  // System
  'system.cell_count': { label: msg('Cell count'), group: 'system', decimals: 0 },
  'system.temp_sensor_count': { label: msg('Temperature sensor count'), group: 'system', decimals: 0 },
  'system.address': { label: msg('Device address'), group: 'system', decimals: 0 },
  'system.sleep_delay': { label: msg('Sleep delay'), group: 'system', unit: 's', decimals: 0 },
  'system.battery_type': { label: msg('Battery chemistry'), group: 'system', type: 'enum' },
  // Identity
  'identity.name': { label: msg('Device name'), group: 'identity', type: 'text' },
  'identity.password': { label: msg('Password'), group: 'identity', type: 'text' },
  // Calibration
  'calibration.voltage': { label: msg('Calibrate pack voltage'), group: 'calibration', unit: 'V', decimals: 2 },
  'calibration.current': { label: msg('Calibrate current'), group: 'calibration', unit: 'A', decimals: 2 },
};

/**
 * Canonical alarms. Severity is the default; drivers may report the same alarm as a warning
 * (pre-alarm, level 1) or a protection (MOSFET switched off, level 2).
 * @type {Record<string, { label: string, severity: 'info'|'warning'|'protection'|'fault' }>}
 */
export const ALARMS = {
  cell_overvoltage: { label: msg('Cell overvoltage'), severity: 'protection' },
  cell_undervoltage: { label: msg('Cell undervoltage'), severity: 'protection' },
  pack_overvoltage: { label: msg('Pack overvoltage'), severity: 'protection' },
  pack_undervoltage: { label: msg('Pack undervoltage'), severity: 'protection' },
  cell_voltage_difference: { label: msg('Cell voltage difference too high'), severity: 'warning' },
  charge_overcurrent: { label: msg('Charge overcurrent'), severity: 'protection' },
  discharge_overcurrent: { label: msg('Discharge overcurrent'), severity: 'protection' },
  short_circuit: { label: msg('Short circuit'), severity: 'protection' },
  charge_overtemperature: { label: msg('Charge overtemperature'), severity: 'protection' },
  charge_undertemperature: { label: msg('Charge undertemperature'), severity: 'protection' },
  discharge_overtemperature: { label: msg('Discharge overtemperature'), severity: 'protection' },
  discharge_undertemperature: { label: msg('Discharge undertemperature'), severity: 'protection' },
  mos_overtemperature: { label: msg('MOSFET overtemperature'), severity: 'protection' },
  ambient_overtemperature: { label: msg('Ambient overtemperature'), severity: 'warning' },
  ambient_undertemperature: { label: msg('Ambient undertemperature'), severity: 'warning' },
  temperature_difference: { label: msg('Temperature difference too high'), severity: 'warning' },
  soc_low: { label: msg('Low state of charge'), severity: 'warning' },
  cell_count_mismatch: { label: msg('Cell count mismatch'), severity: 'fault' },
  wire_resistance: { label: msg('Cell wire resistance too high'), severity: 'warning' },
  cell_wire_open: { label: msg('Cell sense wire disconnected'), severity: 'fault' },
  temperature_sensor_fault: { label: msg('Temperature sensor fault'), severity: 'fault' },
  voltage_sensor_fault: { label: msg('Voltage sensor fault'), severity: 'fault' },
  current_sensor_fault: { label: msg('Current sensor fault'), severity: 'fault' },
  charge_mos_fault: { label: msg('Charge MOSFET fault'), severity: 'fault' },
  discharge_mos_fault: { label: msg('Discharge MOSFET fault'), severity: 'fault' },
  precharge_fault: { label: msg('Precharge fault'), severity: 'fault' },
  afe_fault: { label: msg('Analog front end fault'), severity: 'fault' },
  eeprom_fault: { label: msg('Memory (EEPROM) fault'), severity: 'fault' },
  rtc_fault: { label: msg('Real time clock fault'), severity: 'fault' },
  communication_fault: { label: msg('Internal communication fault'), severity: 'fault' },
  balancer_fault: { label: msg('Balancer fault'), severity: 'fault' },
  heater_fault: { label: msg('Heater fault'), severity: 'fault' },
  charger_detected: { label: msg('Charger connected'), severity: 'info' },
  load_detected: { label: msg('Load connected'), severity: 'info' },
  manufacturer_mode: { label: msg('Manufacturer mode active'), severity: 'info' },
};

/** Severity order for sorting (most severe first). */
export const SEVERITY_ORDER = { fault: 0, protection: 1, warning: 2, info: 3 };

/**
 * Build an alarm state from a catalog id.
 * @param {string} id
 * @param {Partial<import('./model.js').AlarmState>} [extra]
 * @returns {import('./model.js').AlarmState}
 */
export function alarm(id, extra = {}) {
  const def = ALARMS[id];
  return { id, label: extra.label ?? def?.label ?? id, severity: extra.severity ?? def?.severity ?? 'warning', ...(extra.source ? { source: extra.source } : {}) };
}
