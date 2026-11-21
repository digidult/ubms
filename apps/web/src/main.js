import { applyGlobalStyles, i18n } from '@ubms/ui';
import * as transport from '@ubms/transport';
import { AppController } from './controller.js';
import { loadDesktopPlugins } from './plugins.js';
import { registerTranslations } from './locales/index.js';
import './app.js';

applyGlobalStyles();
registerTranslations(i18n);

const ctrl = new AppController();
ctrl.init();

// Handy for debugging from the browser console and for test harnesses (for example a mocked
// Tauri bridge that feeds a protocol simulator); not used by the app itself.
/** @type {any} */ (window).ubms = ctrl;
/** @type {any} */ (window).ubmsDebug = { transport };

function mount() {
  // Create the root element only after the controller exists (connectedCallback needs it).
  const app = /** @type {any} */ (document.createElement('ubms-app'));
  app.ctrl = ctrl;
  /** @type {HTMLElement} */ (document.getElementById('app')).replaceChildren(app);

  // Dev helper: #/connect?demo=jk-ble starts a demo session directly (used by the smoke test).
  const demo = new URLSearchParams(location.hash.split('?')[1] ?? '').get('demo');
  if (demo) ctrl.connectDemo(demo).catch((err) => console.error(err));
}

// The desktop app loads its plugins (docs/plugins.md) before the first screen, so their drivers
// are in the type list, the detection and the demo list from the start. Loading never throws and
// gives up on a plugin after a few seconds; the browser has no plugins and starts at once.
if (transport.isTauri()) {
  loadDesktopPlugins(ctrl, { appVersion: __APP_VERSION__ })
    .catch((err) => ctrl.log.warn(`Plugins: ${err instanceof Error ? err.message : String(err)}`))
    .finally(mount);
} else {
  mount();
}

// Installable app with offline cache when served over https (the single file opened from disk
// skips this: there is no manifest or service worker next to it).
if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = './manifest.webmanifest';
  document.head.append(manifest);
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker not registered', err));
}
