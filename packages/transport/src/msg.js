/**
 * Marks an English user-facing string for translation without translating it here.
 * Packages stay free of any UI dependency; the UI translates the text when it is shown, and the
 * i18n checker (scripts/i18n-check.mjs) extracts every `msg('...')` literal.
 *
 * @template {string} T
 * @param {T} text
 * @returns {T}
 */
export const msg = (text) => text;
