/**
 * Protocol independent battery model used by the device simulators (demo mode and tests).
 * It produces plausible, slowly changing values: a load and charge profile, SOC integration,
 * LFP or NMC open circuit voltage with internal resistance, cell spread, balancing, temperatures.
 * Deterministic for a given seed, so tests can rely on it.
 */

/** LFP open circuit voltage by SOC (%), per cell. */
const LFP_OCV = [
  [0, 2.8],
  [3, 3.0],
  [8, 3.18],
  [15, 3.23],
  [25, 3.27],
  [40, 3.295],
  [60, 3.315],
  [75, 3.33],
  [90, 3.345],
  [97, 3.38],
  [100, 3.45],
];

/** NMC open circuit voltage by SOC (%), per cell. */
const NMC_OCV = [
  [0, 3.0],
  [5, 3.35],
  [15, 3.5],
  [30, 3.62],
  [50, 3.72],
  [70, 3.88],
  [85, 4.0],
  [100, 4.15],
];

/** @param {number[][]} table @param {number} soc */
function interp(table, soc) {
  if (soc <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (soc <= table[i][0]) {
      const [s0, v0] = table[i - 1];
      const [s1, v1] = table[i];
      return v0 + ((v1 - v0) * (soc - s0)) / (s1 - s0);
    }
  }
  return table[table.length - 1][1];
}

/** Small deterministic PRNG (mulberry32). @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimBattery {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.cells]
   * @param {number} [opts.capacityAh]
   * @param {'lfp'|'nmc'} [opts.chemistry]
   * @param {number} [opts.soc]
   * @param {number} [opts.tempSensors]
   * @param {number} [opts.seed]
   * @param {number} [opts.maxCurrent] peak charge/discharge current of the profile, A
   */
  constructor({ cells = 16, capacityAh = 280, chemistry = 'lfp', soc = 68, tempSensors = 2, seed = 7, maxCurrent = 45 } = {}) {
    this.random = rng(seed);
    this.cellCount = cells;
    this.capacityAh = capacityAh;
    this.chemistry = chemistry;
    this.soc = soc;
    this.maxCurrent = maxCurrent;
    this.tempSensorCount = tempSensors;
    this.time = 0;
    this.current = 0;
    this.cycles = 37;
    this.cycleAh = 37 * capacityAh;
    this.mosTemp = 24;
    this.temps = Array.from({ length: tempSensors }, (_, i) => 21 + i * 0.6);
    this.ambient = 21;
    /** per cell SOC offsets (%) and resistance (milliohm) */
    this.cellOffset = Array.from({ length: cells }, () => (this.random() - 0.5) * 1.2);
    this.cellResistance = Array.from({ length: cells }, () => 0.18 + this.random() * 0.08);
    this.wireResistance = Array.from({ length: cells }, () => 0.9 + this.random() * 0.6);
    /** @type {boolean[]} */
    this.balancing = Array.from({ length: cells }, () => false);
    this.balanceCurrent = 0;
    this.switches = { charge: true, discharge: true, balance: true, heater: false };
    this.uptime = 3 * 86400 + 4523;
  }

  get ocvTable() {
    return this.chemistry === 'nmc' ? NMC_OCV : LFP_OCV;
  }

  /** Advance the simulation. @param {number} dt seconds */
  step(dt) {
    this.time += dt;
    this.uptime += dt;
    // Profile: alternating charge and discharge phases with some noise.
    const phase = Math.sin(this.time / 90);
    let i = this.maxCurrent * 0.75 * phase + (this.random() - 0.5) * 2.4;
    if (Math.abs(phase) < 0.08) i = (this.random() - 0.5) * 0.2;
    if (this.soc > 99 && i > 0) i *= 0.05;
    if (this.soc < 3 && i < 0) i *= 0.05;
    if (!this.switches.charge && i > 0) i = 0;
    if (!this.switches.discharge && i < 0) i = 0;
    this.current = Math.round(i * 100) / 100;
    const dAh = (this.current * dt) / 3600;
    this.soc = Math.max(0, Math.min(100, this.soc + (dAh / this.capacityAh) * 100));
    if (dAh < 0) this.cycleAh += -dAh;
    this.cycles = Math.floor(this.cycleAh / this.capacityAh);
    // Temperatures follow I^2 heating slowly.
    const heat = (this.current * this.current) / (this.maxCurrent * this.maxCurrent);
    this.mosTemp += (this.ambient + 3 + heat * 18 - this.mosTemp) * Math.min(1, dt / 60);
    this.temps = this.temps.map((t, k) => t + (this.ambient + k * 0.6 + heat * 6 - t) * Math.min(1, dt / 120));
    // Balancing: during charge above the knee, bleed the highest cells.
    const v = this.cellVoltages();
    const max = Math.max(...v);
    const min = Math.min(...v);
    const active = this.switches.balance && max - min > 0.008 && max > (this.chemistry === 'nmc' ? 3.9 : 3.36);
    this.balancing = v.map((x) => active && x > min + 0.006);
    this.balanceCurrent = active ? 0.6 + this.random() * 0.2 : 0;
    if (active) {
      for (let k = 0; k < this.cellCount; k++) if (this.balancing[k]) this.cellOffset[k] -= 0.002 * dt;
    }
  }

  /** @returns {number[]} cell voltages in V */
  cellVoltages() {
    return this.cellOffset.map((off, k) => {
      const ocv = interp(this.ocvTable, Math.max(0, Math.min(100, this.soc + off)));
      const ir = (this.current * (this.cellResistance[k] + 0.4)) / 1000;
      return Math.round((ocv + ir + (this.random() - 0.5) * 0.0015) * 1000) / 1000;
    });
  }

  get voltage() {
    return this.cellVoltages().reduce((a, b) => a + b, 0);
  }

  get remainingAh() {
    return (this.capacityAh * this.soc) / 100;
  }
}
