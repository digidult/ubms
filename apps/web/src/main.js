import { applyGlobalStyles, i18n } from '@ubms/ui';
import { AppController } from './controller.js';
import { registerTranslations } from './locales/index.js';
import './app.js';

applyGlobalStyles();
registerTranslations(i18n);

const ctrl = new AppController();
ctrl.init();

// Create the root element only after the controller exists (connectedCallback needs it).
const app = /** @type {any} */ (document.createElement('ubms-app'));
app.ctrl = ctrl;
/** @type {HTMLElement} */ (document.getElementById('app')).replaceChildren(app);

// Handy for debugging from the browser console; not used by the app itself.
/** @type {any} */ (window).ubms = ctrl;

// Installable app with offline cache when served over https (the single file opened from disk
// skips this: there is no manifest or service worker next to it).
if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = './manifest.webmanifest';
  document.head.append(manifest);
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service worker not registered', err));
}

// Dev helper: #/connect?demo=jk-ble starts a demo session directly (used by the smoke test).
const demo = new URLSearchParams(location.hash.split('?')[1] ?? '').get('demo');
if (demo) ctrl.connectDemo(demo).catch((err) => console.error(err));
