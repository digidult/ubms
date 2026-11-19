import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t, i18n, confirmDialog } from '@ubms/ui';
import { LANGUAGES, HISTORY_INTERVALS, HISTORY_RETENTION_DAYS } from '../controller.js';

export class ViewPrefs extends UiElement {
  static properties = { ctrl: { attribute: false } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        max-width: 760px;
      }
      .card {
        padding: 4px 0;
        margin-bottom: 12px;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 16px;
        border-top: 1px solid var(--ui-border);
      }
      .item:first-child {
        border-top: 0;
      }
      .item > svg {
        flex: none;
        color: var(--ui-text-muted);
      }
      .txt {
        flex: 1;
        min-width: 0;
      }
      .title {
        font-weight: 600;
      }
      .sub {
        font-size: 0.83rem;
        color: var(--ui-text-muted);
      }
      select {
        width: auto;
        min-width: 150px;
      }
      ui-segmented {
        min-width: 240px;
      }
      @media (max-width: 560px) {
        .item.stack {
          flex-wrap: wrap;
        }
        .item.stack ui-segmented,
        .item.stack select {
          width: 100%;
          flex-basis: 100%;
        }
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
    this.sc = new StoreController(this, this.ctrl.store, (s) => s.prefs);
    this.hc = new StoreController(this, this.ctrl.store, (s) => ({ info: s.historyInfo }));
    if (!this.ctrl.state.historyInfo) this.ctrl.refreshHistoryInfo();
  }

  /** Where the chart history is kept, as shown under "Storage location". */
  #historyPlace() {
    const info = this.hc.value.info;
    if (!info) return '';
    if (info.kind === 'file') return `${info.dir ?? ''} (${info.portable ? t('Portable') : t('User profile')})`;
    if (info.kind === 'indexeddb') return t('Browser storage on this device');
    return t('This browser cannot store the history: it is lost when the page closes.');
  }

  render() {
    const p = this.sc.value;
    const info = this.hc.value.info;
    const set = (/** @type {any} */ k, /** @type {any} */ v) => this.ctrl.setPref(k, v);
    return html`
      <div class="section-title">${t('Appearance')}</div>
      <div class="card">
        <div class="item stack">
          ${icon('globe')}
          <div class="txt"><div class="title">${t('Language')}</div></div>
          <select @change=${(/** @type {any} */ e) => set('lang', e.target.value)}>
            ${LANGUAGES.map((l) => html`<option value=${l.code} ?selected=${p.lang === l.code}>${l.name}</option>`)}
          </select>
        </div>
        <div class="item stack">
          ${icon('contrast')}
          <div class="txt"><div class="title">${t('Theme')}</div></div>
          <ui-segmented
            .options=${[
              { value: 'auto', label: t('theme|System') },
              { value: 'light', label: t('Light') },
              { value: 'dark', label: t('Dark') },
            ]}
            .value=${p.theme}
            label=${t('Theme')}
            @change=${(/** @type {any} */ e) => set('theme', e.detail.value)}
          ></ui-segmented>
        </div>
      </div>

      <div class="section-title">${t('Monitoring')}</div>
      <div class="card">
        <div class="item">
          ${icon('refresh')}
          <div class="txt">
            <div class="title">${t('Refresh interval')}</div>
            <div class="sub">${t('How often live data is requested. Some BMS push data on their own.')}</div>
          </div>
          <select @change=${(/** @type {any} */ e) => set('pollMs', Number(e.target.value))}>
            ${[500, 1000, 2000, 5000, 10000].map((ms) => html`<option value=${ms} ?selected=${p.pollMs === ms}>${t('{s} s', { s: i18n.formatNumber(ms / 1000, { decimals: 1, minDecimals: 0 }) })}</option>`)}
          </select>
        </div>
        <div class="item">
          ${icon('sun')}
          <div class="txt">
            <div class="title">${t('Keep the screen on')}</div>
            <div class="sub">${t('While a device is connected and the app is visible.')}</div>
          </div>
          <ui-switch .checked=${p.keepAwake} label=${t('Keep the screen on')} @change=${(/** @type {any} */ e) => set('keepAwake', e.detail.checked)}></ui-switch>
        </div>
        <div class="item">
          ${icon('sliders')}
          <div class="txt">
            <div class="title">${t('Show advanced settings')}</div>
            <div class="sub">${t('Rarely needed BMS parameters such as calibration and factory values.')}</div>
          </div>
          <ui-switch .checked=${p.showAdvanced} label=${t('Show advanced settings')} @change=${(/** @type {any} */ e) => set('showAdvanced', e.detail.checked)}></ui-switch>
        </div>
      </div>

      <div class="section-title">${t('History')}</div>
      <div class="card">
        <div class="item">
          ${icon('chart')}
          <div class="txt">
            <div class="title">${t('Save chart history')}</div>
            <div class="sub">${t('Readings are kept between sessions, for every device. When off, the charts show only the current connection.')}</div>
          </div>
          <ui-switch .checked=${p.historyEnabled} label=${t('Save chart history')} @change=${(/** @type {any} */ e) => set('historyEnabled', e.detail.checked)}></ui-switch>
        </div>
        <div class="item">
          ${icon('clock')}
          <div class="txt">
            <div class="title">${t('Recording interval')}</div>
            <div class="sub">${t('Time between two stored readings.')}</div>
          </div>
          <select @change=${(/** @type {any} */ e) => set('historyIntervalMs', Number(e.target.value))}>
            ${HISTORY_INTERVALS.map(
              (ms) => html`<option value=${ms} ?selected=${p.historyIntervalMs === ms}>${t('{s} s', { s: i18n.formatNumber(ms / 1000, { decimals: 0 }) })}</option>`,
            )}
          </select>
        </div>
        <div class="item">
          ${icon('trash')}
          <div class="txt">
            <div class="title">${t('Keep history')}</div>
            <div class="sub">${t('Older readings of a device are deleted when it connects.')}</div>
          </div>
          <select @change=${(/** @type {any} */ e) => set('historyRetentionDays', Number(e.target.value))}>
            ${HISTORY_RETENTION_DAYS.map(
              (days) => html`<option value=${days} ?selected=${p.historyRetentionDays === days}>${days ? t('{count} days', { count: days }) : t('Forever')}</option>`,
            )}
          </select>
        </div>
        <div class="item">
          ${icon('save')}
          <div class="txt" title=${info?.reason ?? ''}>
            <div class="title">${t('Storage location')}</div>
            <div class="sub" style="overflow-wrap:anywhere">${this.#historyPlace()}</div>
            ${info?.kind === 'indexeddb' && info.persisted === false ? html`<div class="sub">${t('The browser may delete it when storage space runs low.')}</div>` : nothing}
          </div>
        </div>
      </div>

      <div class="section-title">${t('Protocol log')}</div>
      <div class="card">
        <div class="item">
          ${icon('terminal')}
          <div class="txt">
            <div class="title">${t('Log size')}</div>
            <div class="sub">${t('Number of entries kept in memory.')}</div>
          </div>
          <select @change=${(/** @type {any} */ e) => set('logCapacity', Number(e.target.value))}>
            ${[1000, 5000, 20000, 50000].map((n) => html`<option value=${n} ?selected=${p.logCapacity === n}>${n.toLocaleString()}</option>`)}
          </select>
        </div>
      </div>

      <div class="section-title">${t('Storage')}</div>
      <div class="card">
        <div class="item">
          ${icon('trash')}
          <div class="txt">
            <div class="title">${t('Reset preferences')}</div>
            <div class="sub">${t('Preferences and the list of recent devices are stored only in this browser.')}</div>
          </div>
          <button class="btn small danger" @click=${this.#reset}>${t('Reset')}</button>
        </div>
      </div>
    `;
  }

  #reset = async () => {
    const ok = await confirmDialog({ title: t('Reset preferences?'), confirmLabel: t('Reset'), danger: true });
    if (ok) this.ctrl.resetPrefs();
  };
}
define('view-prefs', ViewPrefs);
