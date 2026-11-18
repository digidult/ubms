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

// Dev helper: #/connect?demo=jk-ble starts a demo session directly (used by the smoke test).
const demo = new URLSearchParams(location.hash.split('?')[1] ?? '').get('demo');
if (demo) ctrl.connectDemo(demo).catch((err) => console.error(err));
