import { canonicalUuid } from '@ubms/transport';

/**
 * Registry of driver definitions and the matching logic used for device selection and detection.
 *
 * @typedef {import('./driver.js').DriverDefinition} DriverDefinition
 * @typedef {import('./driver.js').BleProfile} BleProfile
 * @typedef {import('./driver.js').SerialProfile} SerialProfile
 */
export class DriverRegistry {
  /** @param {DriverDefinition[]} [definitions] */
  constructor(definitions = []) {
    /** @type {Map<string, DriverDefinition>} */
    this.byId = new Map();
    for (const d of definitions) this.register(d);
  }

  /** @param {DriverDefinition} def */
  register(def) {
    if (this.byId.has(def.id)) throw new Error(`Driver ${def.id} is already registered`);
    this.byId.set(def.id, def);
    return this;
  }

  /** @param {string} id */
  get(id) {
    return this.byId.get(id);
  }

  /** @returns {DriverDefinition[]} */
  list() {
    return [...this.byId.values()];
  }

  /** Brand families in registration order: [{ id, vendor, drivers }]. */
  families() {
    /** @type {Map<string, { id: string, vendor: string, drivers: DriverDefinition[] }>} */
    const m = new Map();
    for (const d of this.byId.values()) {
      if (!m.has(d.family)) m.set(d.family, { id: d.family, vendor: d.vendor, drivers: [] });
      m.get(d.family)?.drivers.push(d);
    }
    return [...m.values()];
  }

  /**
   * Definitions selected by a user choice: 'auto', a whole family ('family:jk') or one driver
   * ('jk-ble'). A bare family id ('jk') also selects the family when no driver has that id; use the
   * 'family:' prefix whenever a driver id equals its family id (for example 'ant').
   * @param {string} [selection]
   * @param {'ble'|'serial'} [kind] only definitions supporting this link kind
   */
  select(selection = 'auto', kind) {
    let list = this.list();
    if (selection.startsWith('family:')) {
      const family = selection.slice(7);
      list = list.filter((d) => d.family === family);
    } else if (selection !== 'auto') {
      const exact = this.byId.get(selection);
      list = exact ? [exact] : list.filter((d) => d.family === selection);
    }
    if (kind) list = list.filter((d) => !!d.links[kind]);
    return list;
  }

  /**
   * Options for the Web Bluetooth chooser.
   * With `showAll` every device is listed (still granting access to all known services).
   * When filtering is impossible for the selection, `filterable` is false so the UI can say so.
   * @param {{ selection?: string, showAll?: boolean }} [opts]
   */
  bleRequest({ selection = 'auto', showAll = false } = {}) {
    const defs = this.select(selection, 'ble');
    const optionalServices = new Set();
    /** @type {import('@ubms/transport/web-bluetooth').BleFilter[]} */
    const filters = [];
    const optionalManufacturerData = new Set();
    for (const d of defs) {
      const ble = /** @type {import('./driver.js').BleRequirements} */ (d.links.ble);
      for (const p of ble.profiles) optionalServices.add(canonicalUuid(p.service));
      for (const extra of ble.optionalServices ?? []) optionalServices.add(canonicalUuid(extra));
      for (const prefix of ble.namePrefixes ?? []) filters.push({ namePrefix: prefix });
      for (const s of ble.advertisedServices ?? []) filters.push({ services: [s] });
      for (const id of ble.manufacturerIds ?? []) {
        filters.push({ manufacturerData: [{ companyIdentifier: id }] });
        optionalManufacturerData.add(id);
      }
    }
    // Deduplicate filters.
    const seen = new Set();
    const unique = filters.filter((f) => {
      const k = JSON.stringify(f);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const filterable = unique.length > 0;
    return {
      filterable,
      request: {
        acceptAllDevices: showAll || !filterable,
        filters: showAll || !filterable ? undefined : unique,
        optionalServices: [...optionalServices],
        optionalManufacturerData: [...optionalManufacturerData],
      },
    };
  }

  /**
   * Rank (definition, profile) candidates for a connected BLE device.
   * @param {{ name?: string, services?: string[], selection?: string }} device
   * @returns {Array<{ definition: DriverDefinition, profile: BleProfile, score: number }>}
   */
  bleCandidates({ name = '', services, selection = 'auto' }) {
    const available = services ? new Set(services.map((s) => canonicalUuid(s))) : null;
    /** @type {Array<{ definition: DriverDefinition, profile: BleProfile, score: number }>} */
    const out = [];
    for (const def of this.select(selection, 'ble')) {
      const ble = /** @type {import('./driver.js').BleRequirements} */ (def.links.ble);
      const nameMatch =
        (ble.namePatterns ?? []).some((re) => re.test(name)) || (ble.namePrefixes ?? []).some((p) => name.startsWith(p));
      for (const profile of ble.profiles) {
        if (available && !available.has(canonicalUuid(profile.service))) continue;
        out.push({ definition: def, profile, score: (nameMatch ? 10 : 0) + (selection !== 'auto' ? 5 : 0) });
      }
    }
    // Stable sort keeps registration order among equal scores.
    return out.map((c, i) => ({ c, i })).sort((a, b) => b.c.score - a.c.score || a.i - b.i).map(({ c }) => c);
  }

  /**
   * Serial candidates in trial order.
   * @param {{ selection?: string }} [opts]
   * @returns {Array<{ definition: DriverDefinition, profile: SerialProfile }>}
   */
  serialCandidates({ selection = 'auto' } = {}) {
    /** @type {Array<{ definition: DriverDefinition, profile: SerialProfile }>} */
    const out = [];
    for (const def of this.select(selection, 'serial')) {
      for (const profile of def.links.serial?.profiles ?? []) out.push({ definition: def, profile });
    }
    return out;
  }
}
