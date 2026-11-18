/**
 * File helpers that work from a local HTML file, a static host and a Tauri webview.
 */

/**
 * Offer data as a file download.
 * @param {string} filename
 * @param {string | Blob} data
 * @param {string} [type]
 */
export function downloadFile(filename, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
