/**
 * Translation runtime. English source strings are the keys (gettext style): code calls
 * `t('Cell overvoltage protection')`, translation catalogs map that English text to the target
 * language, and missing translations fall back to the English text itself.
 *
 * Plurals: a catalog value may be an object keyed by Intl.PluralRules categories
 * (`zero`, `one`, `two`, `few`, `many`, `other`); the count comes from `params.count`.
 * Interpolation: `{name}` placeholders are replaced from `params`.
 *
 * Context: when the same English text needs different translations, the key may carry a context
 * prefix separated by `|`, for example `t('noun|Charge')`. The English fallback drops the prefix.
 *
 * This module has no DOM dependency and runs in Node tests.
 *
 * @typedef {string | Partial<Record<Intl.LDMLPluralRule, string>>} CatalogValue
 * @typedef {Record<string, CatalogValue>} Catalog
 */

export function createI18n({ fallback = 'en' } = {}) {
  /** @type {Map<string, Catalog>} */
  const catalogs = new Map();
  /** @type {Set<(locale: string) => void>} */
  const listeners = new Set();
  /** @type {Map<string, Intl.PluralRules>} */
  const pluralCache = new Map();
  /** @type {Map<string, Intl.NumberFormat>} */
  const numberCache = new Map();
  let locale = fallback;

  /** @param {string} loc */
  function plural(loc) {
    let p = pluralCache.get(loc);
    if (!p) {
      p = new Intl.PluralRules(loc);
      pluralCache.set(loc, p);
    }
    return p;
  }

  /**
   * Translate.
   * @param {string} key English text (optionally `context|text`)
   * @param {Record<string, any>} [params]
   * @returns {string}
   */
  function t(key, params) {
    let entry = catalogs.get(locale)?.[key];
    let loc = locale;
    if (entry === undefined || entry === '') {
      entry = catalogs.get(fallback)?.[key];
      loc = fallback;
    }
    if (entry === undefined || entry === '') {
      const bar = key.indexOf('|');
      entry = bar > 0 && !key.slice(0, bar).includes(' ') ? key.slice(bar + 1) : key;
      loc = fallback;
    }
    let text;
    if (typeof entry === 'object') {
      const n = Number(params?.count ?? 0);
      const cat = plural(loc).select(n);
      text = entry[cat] ?? entry.other ?? Object.values(entry)[0] ?? key;
    } else {
      text = entry;
    }
    return params ? interpolate(text, params) : text;
  }

  /**
   * Add or extend a catalog.
   * @param {string} loc
   * @param {Catalog} catalog
   */
  function register(loc, catalog) {
    catalogs.set(loc, { ...(catalogs.get(loc) ?? {}), ...catalog });
  }

  /** @param {string} loc */
  function setLocale(loc) {
    if (loc === locale) return;
    locale = loc;
    numberCache.clear();
    if (typeof document !== 'undefined') document.documentElement.lang = loc;
    for (const fn of [...listeners]) fn(loc);
  }

  /** @param {(locale: string) => void} fn */
  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Locale aware number formatting.
   * @param {number | undefined | null} value
   * @param {{ decimals?: number, minDecimals?: number, signed?: boolean, grouping?: boolean }} [opts]
   */
  function formatNumber(value, { decimals = 2, minDecimals, signed = false, grouping = true } = {}) {
    if (value === undefined || value === null || !Number.isFinite(value)) return t('n/a');
    const min = minDecimals ?? decimals;
    const k = `${min}:${decimals}:${signed}:${grouping}`;
    let f = numberCache.get(k);
    if (!f) {
      f = new Intl.NumberFormat(locale, {
        minimumFractionDigits: min,
        maximumFractionDigits: decimals,
        signDisplay: signed ? 'exceptZero' : 'auto',
        useGrouping: grouping,
      });
      numberCache.set(k, f);
    }
    return f.format(value);
  }

  /**
   * @param {number | Date} value
   * @param {Intl.DateTimeFormatOptions} [opts]
   */
  function formatDate(value, opts = { dateStyle: 'medium', timeStyle: 'medium' }) {
    return new Intl.DateTimeFormat(locale, opts).format(value);
  }

  return {
    t,
    register,
    setLocale,
    onChange,
    formatNumber,
    formatDate,
    get locale() {
      return locale;
    },
    get fallback() {
      return fallback;
    },
    /** @param {string} loc */
    catalog(loc) {
      return catalogs.get(loc) ?? {};
    },
    locales() {
      return [...catalogs.keys()];
    },
  };
}

/**
 * @param {string} text
 * @param {Record<string, any>} params
 */
export function interpolate(text, params) {
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/**
 * Pick the best supported locale for the user's preferences.
 * @param {string[]} supported for example ['en', 'uk', 'ru', 'de', 'fr']
 * @param {readonly string[]} [preferred] for example navigator.languages
 * @param {string} [fallback]
 */
export function negotiateLocale(supported, preferred = [], fallback = 'en') {
  for (const p of preferred) {
    const lc = p.toLowerCase();
    const exact = supported.find((s) => s.toLowerCase() === lc);
    if (exact) return exact;
    const base = supported.find((s) => s.toLowerCase() === lc.split('-')[0]);
    if (base) return base;
  }
  return fallback;
}

/** Shared app-wide instance. */
export const i18n = createI18n();
export const t = i18n.t;
