import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t } from '@ubms/ui';

export class ViewMore extends UiElement {
  static properties = { ctrl: { attribute: false } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        max-width: 760px;
      }
      .card {
        padding: 6px;
        margin-bottom: 12px;
      }
      .about {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .about p {
        margin: 0;
        color: var(--ui-text-muted);
        font-size: 0.9rem;
      }
      .ver {
        font-family: var(--ui-mono);
        font-size: 0.82rem;
        color: var(--ui-text-faint);
      }
      .danger-row {
        padding: 10px;
      }
      .danger-row .btn {
        width: 100%;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('../controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
  }

  connectedCallback() {
    super.connectedCallback();
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({ state: s.state, device: s.device }));
  }

  render() {
    const { state, device } = this.sc.value;
    const connected = state === 'connected' || state === 'reconnecting';
    const env = this.ctrl.state.env;
    return html`
      <div class="card">
        ${connected
          ? html`<ui-list-row href="#/info" icon="info" heading=${t('Device information')} text=${device ? `${device.vendor}, ${t(device.protocol)}` : ''}></ui-list-row>`
          : nothing}
        <ui-list-row href="#/prefs" icon="cog" heading=${t('Preferences')} text=${t('Language, theme, refresh interval')}></ui-list-row>
        <ui-list-row href="#/log" icon="terminal" heading=${t('Protocol log')} text=${t('Raw and decoded traffic, export for bug reports')}></ui-list-row>
      </div>
      ${connected
        ? html`<div class="card danger-row">
            <button class="btn danger" @click=${() => this.ctrl.disconnect()}>${icon('unlink', { size: 18 })}${t('Disconnect')}</button>
          </div>`
        : nothing}
      <div class="section-title">${t('About')}</div>
      <div class="card about">
        <div class="row"><b>ubms</b><span class="ver">${__APP_VERSION__} (${__APP_REVISION__}, ${__BUILD_DATE__})</span></div>
        <p>${t('Open source viewer and configurator for battery management systems. Works offline: the whole app is a single HTML file and talks to the device directly from the browser.')}</p>
        <p>${t('Supported now: JK BMS, ANT BMS and Daly BMS over Bluetooth and serial (UART, RS485).')}</p>
        <p>${t('Changing BMS settings is at your own risk. Wrong values can damage cells, the BMS or connected equipment.')}</p>
        <p class="faint" style="font-size:.8rem">
          ${t('Browser support')}: Bluetooth ${env.webBluetooth ? '✓' : '✗'} · ${t('Serial')} ${env.webSerial ? '✓' : '✗'} · ${env.tauri ? 'Tauri' : env.platform}
        </p>
      </div>
    `;
  }
}
define('view-more', ViewMore);
