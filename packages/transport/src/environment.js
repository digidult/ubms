import { isTauri } from './tauri.js';

/**
 * Snapshot of what the current runtime can do, for capability notices in the UI.
 * @returns {{
 *   secureContext: boolean,
 *   webBluetooth: boolean,
 *   webSerial: boolean,
 *   tauri: boolean,
 *   platform: 'ios'|'android'|'desktop'|'unknown',
 *   standalone: boolean,
 *   fileProtocol: boolean,
 * }}
 */
export function detectEnvironment() {
  const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
  const win = /** @type {any} */ (typeof window !== 'undefined' ? window : {});
  const ua = String(nav.userAgent ?? '');
  const ios = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  return {
    secureContext: win.isSecureContext !== false,
    webBluetooth: !!nav.bluetooth,
    webSerial: !!nav.serial,
    tauri: isTauri(),
    platform: ios ? 'ios' : android ? 'android' : ua ? 'desktop' : 'unknown',
    standalone: !!(win.matchMedia?.('(display-mode: standalone)')?.matches || nav.standalone),
    fileProtocol: win.location?.protocol === 'file:',
  };
}
