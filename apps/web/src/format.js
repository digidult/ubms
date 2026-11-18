import { i18n, t } from '@ubms/ui';

/**
 * Number with locale decimals ("3,305" in uk/ru/de/fr).
 * @param {number | undefined | null} v
 * @param {number} [decimals]
 * @param {{ signed?: boolean }} [opts]
 */
export function num(v, decimals = 2, { signed = false } = {}) {
  return i18n.formatNumber(v, { decimals, signed });
}

/**
 * Decimals that keep a value readable: fewer for large magnitudes.
 * @param {number | undefined} v
 * @param {number} base
 */
export function autoDecimals(v, base = 2) {
  if (v === undefined || !Number.isFinite(v)) return base;
  const a = Math.abs(v);
  if (a >= 1000) return 0;
  if (a >= 100) return Math.min(base, 1);
  return base;
}

/**
 * Human duration from seconds, localized through Intl.DurationFormat when available.
 * @param {number | undefined} seconds
 */
export function duration(seconds) {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return t('n/a');
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = d > 0 ? { days: d, hours: h } : h > 0 ? { hours: h, minutes: m } : m > 0 ? { minutes: m } : { seconds: s % 60 };
  const DF = /** @type {any} */ (Intl).DurationFormat;
  if (DF) {
    try {
      return new DF(i18n.locale, { style: 'narrow' }).format(parts);
    } catch {
      /* fall back below */
    }
  }
  if (d > 0) return t('{d} d {h} h', { d, h });
  if (h > 0) return t('{h} h {m} min', { h, m });
  if (m > 0) return t('{m} min', { m });
  return t('{s} s', { s: s % 60 });
}

/** @param {number | undefined} hours */
export function hoursDuration(hours) {
  return hours === undefined || !Number.isFinite(hours) ? t('n/a') : duration(hours * 3600);
}

/**
 * Relative time like "5 s ago".
 * @param {number} ts epoch ms
 */
export function ago(ts) {
  const diff = Math.max(0, (Date.now() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(i18n.locale, { numeric: 'auto', style: 'short' });
  if (diff < 60) return rtf.format(-Math.round(diff), 'second');
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

/**
 * Format a value of a settings field for display (used in change summaries).
 * @param {import('@ubms/bms-core/settings').SettingField} f
 * @param {any} v
 */
export function fieldValue(f, v) {
  if (v === undefined || v === null) return t('n/a');
  if (f.type === 'boolean') return v ? t('On') : t('Off');
  if (f.type === 'enum') {
    const o = f.options?.find((x) => String(x.value) === String(v));
    return o ? t(o.label) : String(v);
  }
  if (f.type === 'number') return `${num(v, f.decimals ?? 3)}${f.unit ? ` ${f.unit}` : ''}`;
  return String(v);
}
