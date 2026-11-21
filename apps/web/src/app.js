import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t, HashRouter } from '@ubms/ui';
import './views/connect.js';
import './views/overview.js';
import './views/cells.js';
import './views/settings.js';
import './views/info.js';
import './views/log.js';
import './views/charts.js';
import './views/prefs.js';
import './views/plugins.js';
import './views/more.js';

/** Routes that need a connected device. */
const DEVICE_ROUTES = new Set(['overview', 'cells', 'settings', 'info']);

export const router = new HashRouter(
  [
    { name: 'connect', path: '/connect' },
    { name: 'overview', path: '/overview' },
    { name: 'cells', path: '/cells' },
    { name: 'charts', path: '/charts' },
    { name: 'settings', path: '/settings/:group?' },
    { name: 'info', path: '/info' },
    { name: 'log', path: '/log' },
    { name: 'prefs', path: '/prefs' },
    { name: 'plugins', path: '/plugins' },
    { name: 'more', path: '/more' },
  ],
  '/connect',
);

export class UbmsApp extends UiElement {
  static properties = {
    ctrl: { attribute: false },
    tick: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        min-height: 100vh;
        min-height: 100dvh;
      }
      .layout {
        padding-bottom: calc(var(--ui-nav-height) + env(safe-area-inset-bottom));
      }
      header {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: var(--ui-header-height);
        padding: env(safe-area-inset-top) 16px 0;
        padding-left: max(16px, env(safe-area-inset-left));
        padding-right: max(16px, env(safe-area-inset-right));
        background: color-mix(in srgb, var(--ui-bg) 88%, transparent);
        backdrop-filter: blur(10px);
        border-bottom: 1px solid transparent;
      }
      header.scrolled {
        border-bottom-color: var(--ui-border);
      }
      .titles {
        flex: 1;
        min-width: 0;
      }
      .title {
        font-weight: 700;
        font-size: 1.12rem;
        letter-spacing: -0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .subtitle {
        font-size: 0.8rem;
        color: var(--ui-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .live {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: currentColor;
        animation: blink 1.6s ease-in-out infinite;
      }
      @keyframes blink {
        50% {
          opacity: 0.25;
        }
      }
      main {
        padding: 8px 16px 24px;
        padding-left: max(16px, env(safe-area-inset-left));
        padding-right: max(16px, env(safe-area-inset-right));
        max-width: 1280px;
        margin: 0 auto;
      }
      @media (min-width: 900px) {
        .layout {
          padding-bottom: 0;
          padding-left: var(--ui-rail-width);
        }
        header {
          padding: 0 28px;
        }
        main {
          padding: 12px 28px 40px;
        }
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('./controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
    this.tick = 0;
    this.scrolled = false;
    this.onScroll = () => {
      const s = window.scrollY > 4;
      if (s !== this.scrolled) {
        this.scrolled = s;
        this.requestUpdate();
      }
    };
  }

  connectedCallback() {
    super.connectedCallback();
    this.app = new StoreController(this, this.ctrl.store, (s) => ({
      state: s.state,
      device: s.device,
      soc: s.snapshot?.soc,
      alarms: s.snapshot?.alarms?.filter((a) => a.severity !== 'info').length ?? 0,
      worst: worstSeverity(s.snapshot?.alarms),
      // Meters (Atorch and similar) have no cells: hide the Cells tab for them.
      hasCells: !!s.snapshot?.cells?.length || (s.device?.deviceType ?? 'bms') !== 'meter',
      info: s.info,
    }));
    this.nav = new StoreController(this, router, (s) => s.route);
    // A new screen or settings group starts at the top (matters on phones after long lists).
    this.unsubRoute = router.subscribe((s, prev) => {
      if (s.route.path !== prev.route.path) window.scrollTo({ top: 0 });
    });
    this.timer = setInterval(() => (this.tick = (this.tick + 1) % 1e6), 1000);
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.unsub = this.ctrl.store.subscribe((s, prev) => {
      // Move to the dashboard after connecting, back to the connect screen after disconnecting.
      if (s.state === 'connected' && prev.state !== 'connected' && prev.state !== 'reconnecting') router.navigate('/overview');
      if (s.state === 'idle' && prev.state !== 'idle' && DEVICE_ROUTES.has(router.route.name)) router.navigate('/connect');
    });
  }

  disconnectedCallback() {
    clearInterval(this.timer);
    window.removeEventListener('scroll', this.onScroll);
    this.unsub?.();
    this.unsubRoute?.();
    super.disconnectedCallback();
  }

  get #connected() {
    const st = this.ctrl.state.state;
    return st === 'connected' || st === 'reconnecting';
  }

  #navItems() {
    const route = router.route.name;
    const { alarms, worst } = this.app.value;
    const connected = this.#connected;
    /** @type {any[]} */
    const items = [];
    const charts = { id: 'charts', label: t('Charts'), icon: 'chart', href: '#/charts' };
    // At most five items fit the bottom bar: while connected the protocol log moves into More.
    if (connected) {
      items.push(
        { id: 'overview', label: t('Overview'), icon: 'gauge', href: '#/overview', badge: alarms || undefined, tone: worst === 'fault' || worst === 'protection' ? 'danger' : 'warn' },
        ...(this.app.value.hasCells ? [{ id: 'cells', label: t('Cells'), icon: 'cells', href: '#/cells' }] : []),
        charts,
        { id: 'settings', label: t('Settings'), icon: 'sliders', href: '#/settings' },
      );
    } else {
      items.push({ id: 'connect', label: t('Connect'), icon: 'link', href: '#/connect' }, charts, { id: 'log', label: t('Log'), icon: 'terminal', href: '#/log' });
    }
    items.push({ id: 'more', label: t('More'), icon: 'more', href: '#/more' });
    const inMore = route === 'info' || route === 'prefs' || route === 'plugins' || (route === 'log' && connected);
    const active = inMore ? 'more' : route;
    return { items, active };
  }

  #title() {
    const route = router.route.name;
    const titles = {
      connect: t('Connect'),
      overview: t('Overview'),
      cells: t('Cells'),
      charts: t('Charts'),
      settings: t('Settings'),
      info: t('Device information'),
      log: t('Protocol log'),
      prefs: t('Preferences'),
      plugins: t('Plugins'),
      more: t('More'),
    };
    return /** @type {Record<string, string>} */ (titles)[route] ?? 'ubms';
  }

  #status() {
    const st = this.ctrl.state;
    const fresh = st.state === 'connected' && Date.now() - this.ctrl.session.lastDataAt < Math.max(8000, st.prefs.pollMs * 4);
    switch (st.state) {
      case 'connected':
        return fresh
          ? html`<span class="chip ok status"><span class="live"></span>${Number.isFinite(this.app.value.soc) ? `${Math.round(this.app.value.soc)} %` : t('Live')}</span>`
          : html`<span class="chip warn status">${icon('clock', { size: 14 })}${t('No data')}</span>`;
      case 'connecting':
      case 'detecting':
        return html`<span class="chip info status">${t('Connecting…')}</span>`;
      case 'reconnecting':
        return html`<span class="chip warn status">${t('Reconnecting…')}</span>`;
      case 'error':
        return html`<span class="chip danger status">${t('Error')}</span>`;
      default:
        return html`<span class="chip status">${t('Offline')}</span>`;
    }
  }

  render() {
    const route = router.route;
    const { items, active } = this.#navItems();
    const device = this.app.value.device;
    const connected = this.#connected;
    let name = route.name;
    if (DEVICE_ROUTES.has(name) && !connected) name = 'connect';
    const subtitle = device ? `${this.app.value.info?.name || device.deviceName} · ${device.vendor}` : '';
    return html`
      <ui-nav .items=${items} .active=${active} brand="ubms"></ui-nav>
      <div class="layout">
        <header class=${this.scrolled ? 'scrolled' : ''}>
          <div class="titles">
            <div class="title">${this.#title()}</div>
            ${subtitle ? html`<div class="subtitle">${subtitle}</div>` : nothing}
          </div>
          ${this.#status()}
        </header>
        <main>${this.#view(name, route)}</main>
      </div>
    `;
  }

  /** @param {string} name @param {import('@ubms/ui/router').Route} route */
  #view(name, route) {
    const c = this.ctrl;
    switch (name) {
      case 'overview':
        return html`<view-overview .ctrl=${c}></view-overview>`;
      case 'cells':
        return html`<view-cells .ctrl=${c}></view-cells>`;
      case 'charts':
        return html`<view-charts .ctrl=${c}></view-charts>`;
      case 'settings':
        return html`<view-settings .ctrl=${c} .group=${route.params.group ?? ''}></view-settings>`;
      case 'info':
        return html`<view-info .ctrl=${c}></view-info>`;
      case 'log':
        return html`<view-log .ctrl=${c}></view-log>`;
      case 'prefs':
        return html`<view-prefs .ctrl=${c}></view-prefs>`;
      case 'plugins':
        return html`<view-plugins .ctrl=${c}></view-plugins>`;
      case 'more':
        return html`<view-more .ctrl=${c}></view-more>`;
      default:
        return html`<view-connect .ctrl=${c}></view-connect>`;
    }
  }
}
define('ubms-app', UbmsApp);

/** @param {Array<{ severity?: string }> | undefined} alarms */
function worstSeverity(alarms) {
  if (!alarms?.length) return '';
  const order = ['fault', 'protection', 'warning', 'info'];
  let best = 'info';
  for (const a of alarms) if (order.indexOf(a.severity ?? 'warning') < order.indexOf(best)) best = a.severity ?? 'warning';
  return best === 'info' ? '' : best;
}
