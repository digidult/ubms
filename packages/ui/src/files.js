/**
 * File helpers that work from a local HTML file, a static host and a Tauri webview.
 */

/**
 * @typedef {(name: string, blob: Blob) => Promise<any>} FileSaver
 */

/** @type {FileSaver | null} */
let saver = null;

/**
 * Replace the browser download with an app specific saver, for example a desktop app that writes
 * the file through a native command (blob downloads do not work in every webview). Pass null to
 * restore the browser download.
 * @param {FileSaver | null} fn
 */
export function setFileSaver(fn) {
  saver = typeof fn === 'function' ? fn : null;
}

/**
 * Offer data as a file download, or hand it to the saver set with `setFileSaver()`.
 * @param {string} filename
 * @param {string | Blob} data
 * @param {string} [type]
 * @returns {Promise<any>} the saver's promise (for example the saved path); resolves at once for
 *   a browser download
 */
export function downloadFile(filename, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  if (saver) {
    try {
      return Promise.resolve(saver(filename, blob));
    } catch (err) {
      return Promise.reject(err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Promise.resolve();
}

/**
 * Let the user pick a file and read it as text.
 * @param {string} [accept] for example '.json,application/json'
 * @returns {Promise<{ name: string, text: string } | null>}
 */
export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, text: await file.text() });
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea where the async API is missing.
 * @param {string} text
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}
