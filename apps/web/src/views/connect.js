import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t } from '@ubms/ui';
import { msg } from '@ubms/bms-core';
import { ago } from '../format.js';

const REASONS = {
  ble: {
    unsupported: msg('This browser cannot use Bluetooth devices. Use Chrome or Edge on a computer or Android phone. On iPhone and iPad use the Bluefy browser.'),
    'insecure-context': msg('Device access needs a secure page: open the app over https, from localhost or as a local file.'),
    'adapter-unavailable': msg('Bluetooth is switched off or no Bluetooth adapter was found.'),
    'not-tauri': msg('Native Bluetooth is only available in the desktop app.'),
  },
  serial: {
    unsupported: msg('This browser cannot open serial ports. Use Chrome or Edge on a computer (Android Chrome supports it in recent versions).'),
    'insecure-context': msg('Device access needs a secure page: open the app over https, from localhost or as a local file.'),
    'not-tauri': msg('Native serial ports are only available in the desktop app.'),
  },
};

export class ViewConnect extends UiElement {
  static properties = { ctrl: { attribute: false } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        max-width: 680px;
        margin: 0 auto;
      }
      .hero {
        display: flex;
        gap: 14px;
        align-items: center;
        margin: 8px 2px 16px;
      }
      .logo {
        flex: none;
        width: 52px;
        height: 52px;
        border-radius: 16px;
        display: grid;
        place-items: center;
        background: var(--ui-primary);
        color: #fff;
      }
      .hero p {
        margin: 2px 0 0;
        color: var(--ui-text-muted);
      }
      .card {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      label.field {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-weight: 600;
        font-size: 0.9rem;
      }
      .check {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        font-size: 0.92rem;
        cursor: pointer;
      }
      .check input {
        width: 20px;
        height: 20px;
        margin: 1px 0 0;
        accent-color: var(--ui-primary);
        flex: none;
      }
      .note {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 10px 12px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface-2);
        color: var(--ui-text-muted);
        font-size: 0.88rem;
      }
      .note svg {
        flex: none;
        margin-top: 1px;
      }
      .note.warn {
        background: var(--ui-warn-soft);
        color: var(--ui-warn);
      }
      .note.danger {
        background: var(--ui-danger-soft);
        color: var(--ui-danger);
      }
      .go {
        min-height: 52px;
        font-size: 1.02rem;
      }
      .progress {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 28px 16px;
        text-align: center;
      }
      .spinner {
        width: 44px;
        height: 44px;
        border-radius: 50%;
        border: 4px solid var(--ui-surface-3);
        border-top-color: var(--ui-primary);
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .steps {
        color: var(--ui-text-muted);
        font-size: 0.9rem;
      }
      .recent {
        padding: 6px;
      }
      .recent-row {
        display: flex;
        align-items: center;
      }
      .recent-row ui-list-row {
        flex: 1;
        cursor: pointer;
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
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({
      prefs: s.prefs,
      availability: s.availability,
      state: s.state,
      error: s.error,
      detect: s.detect,
      recent: s.recent,
      env: s.env,
    }));
  }

  render() {
    const v = this.sc.value;
    const busy = v.state === 'connecting' || v.state === 'detecting';
    return html`
      <div class="hero">
        <div class="logo">${icon('battery', { size: 28, stroke: 2 })}</div>
        <div>
          <h1 style="font-size:1.35rem">ubms</h1>
          <p>${t('Monitor and configure your battery management system.')}</p>
        </div>
      </div>
      ${busy ? this.#progress() : this.#form()}
      ${v.state === 'error' && v.error ? this.#error(v.error) : nothing}
      ${!busy && v.recent.length ? this.#recent() : nothing}
    `;
  }

  #progress() {
    const { state, detect } = this.sc.value;
    const step =
      state === 'connecting'
        ? t('Connecting to the device…')
        : detect
          ? t('Trying {protocol} ({index} of {total})…', { protocol: detect.protocol, index: detect.index + 1, total: detect.total })
          : t('Identifying the device…');
    return html`<div class="card progress" role="status" aria-live="polite">
      <div class="spinner"></div>
      <h2>${t('Connecting…')}</h2>
      <div class="steps">${step}</div>
      <button class="btn" @click=${() => this.ctrl.cancel()}>${t('Cancel')}</button>
    </div>`;
  }

  /** @param {string} error */
  #error(error) {
    return html`<div class="note danger" style="margin-top:12px" role="alert">
      ${icon('alert', { size: 20 })}
      <div style="flex:1">
        <div style="font-weight:600">${t('Connection failed')}</div>
        <div>${t(error)}</div>
        ${this.ctrl.session.target
          ? html`<button class="btn small" style="margin-top:8px" @click=${() => this.ctrl.reconnect()}>${icon('refresh', { size: 16 })}${t('Try again')}</button>`
          : nothing}
      </div>
    </div>`;
  }

  #form() {
    const { prefs, availability } = this.sc.value;
    const transport = prefs.transport;
    const reg = this.ctrl.registry;
    const hasDemo = reg.list().some((d) => /** @type {any} */ (d).demo);
    const tabs = [
      { value: 'ble', label: t('Bluetooth'), icon: 'bluetooth' },
      { value: 'serial', label: t('Serial'), icon: 'usb' },
      ...(hasDemo ? [{ value: 'demo', label: t('Demo'), icon: 'play' }] : []),
    ];
    const avail = transport === 'demo' ? { available: true } : availability[transport];
    return html`<div class="card">
      <ui-segmented .options=${tabs} .value=${transport} label=${t('Connection type')} @change=${(/** @type {any} */ e) => this.ctrl.setPref('transport', e.detail.value)}></ui-segmented>
      ${transport === 'demo' ? this.#demoOptions() : html`${this.#typeSelect(transport)}${this.#protocolNotes(transport)}`}
      ${transport === 'ble' ? this.#bleOptions() : nothing} ${transport === 'serial' ? this.#serialOptions() : nothing}
      ${!avail.available && avail.reason ? this.#unavailable(transport, avail.reason) : nothing}
      <button class="btn primary go" ?disabled=${!avail.available} @click=${this.#connect}>
        ${icon(transport === 'ble' ? 'bluetooth' : transport === 'serial' ? 'usb' : 'play')}
        ${transport === 'ble' ? t('Search for devices') : transport === 'serial' ? t('Choose serial port') : t('Start demo')}
      </button>
    </div>`;
  }

  /** @param {'ble'|'serial'} kind */
  #typeSelect(kind) {
    const { prefs } = this.sc.value;
    const families = this.ctrl.registry.families().filter((f) => f.drivers.some((d) => d.links[kind]));
    return html`<label class="field">
      ${t('BMS type')}
      <select @change=${(/** @type {any} */ e) => this.ctrl.setPref('selection', e.target.value)} .value=${prefs.selection}>
        <option value="auto" ?selected=${prefs.selection === 'auto'}>${t('Detect automatically')}</option>
        ${families.map(
          (f) => html`<optgroup label=${f.vendor}>
            <option value=${f.id} ?selected=${prefs.selection === f.id}>${t('{vendor}, any protocol', { vendor: f.vendor })}</option>
            ${f.drivers
              .filter((d) => d.links[kind])
              .map((d) => html`<option value=${d.id} ?selected=${prefs.selection === d.id}>${t(d.protocol)}</option>`)}
          </optgroup>`,
        )}
      </select>
    </label>`;
  }

  /** Descriptions and wiring notes of the selected protocols. @param {'ble'|'serial'} kind */
  #protocolNotes(kind) {
    const { prefs } = this.sc.value;
    if (prefs.selection === 'auto') return nothing;
    const defs = this.ctrl.registry.select(prefs.selection, kind);
    const notes = [];
    for (const d of defs) {
      if (d.description) notes.push(html`<div><b>${t(d.protocol)}</b>: ${t(d.description)}</div>`);
      if (kind === 'serial' && d.links.serial?.note) notes.push(html`<div>${t(d.links.serial.note)}</div>`);
    }
    if (!notes.length) return nothing;
    return html`<div class="note">${icon('info', { size: 18 })}<div style="display:flex;flex-direction:column;gap:6px">${notes}</div></div>`;
  }

  #bleOptions() {
    const { prefs } = this.sc.value;
    const info = this.ctrl.bleFilterInfo();
    return html`
      <label class="check">
        <input type="checkbox" .checked=${prefs.showAllBle} @change=${(/** @type {any} */ e) => this.ctrl.setPref('showAllBle', e.target.checked)} />
        <span>${t('Show all Bluetooth devices')}<br /><span class="faint">${t('Use this when your BMS has a custom name.')}</span></span>
      </label>
      ${!info.filterable && !prefs.showAllBle
        ? html`<div class="note warn">${icon('info', { size: 18 })}<span>${t('Devices of this type cannot be filtered by name or service, so all nearby devices are listed.')}</span></div>`
        : nothing}
      <div class="note">${icon('info', { size: 18 })}<span>${t('Wake the BMS up and close the vendor app: most BMS accept only one Bluetooth connection at a time.')}</span></div>
    `;
  }

  #serialOptions() {
    const { prefs } = this.sc.value;
    return html`
      <label class="check">
        <input type="checkbox" .checked=${prefs.adaptersOnly} @change=${(/** @type {any} */ e) => this.ctrl.setPref('adaptersOnly', e.target.checked)} />
        <span>${t('List only known USB-UART adapters')}<br /><span class="faint">CH340, CP210x, FTDI, PL2303</span></span>
      </label>
      <div class="note">${icon('info', { size: 18 })}<span>${t('The browser cannot tell which device is behind a USB adapter, so ports cannot be filtered by BMS type. Automatic detection tries every protocol and baud rate; choosing the type makes it faster.')}</span></div>
    `;
  }

  #demoOptions() {
    const { prefs } = this.sc.value;
    const demos = this.ctrl.registry.list().filter((d) => /** @type {any} */ (d).demo);
    return html`<label class="field">
        ${t('Simulated device')}
        <select @change=${(/** @type {any} */ e) => this.ctrl.setPref('demoDriver', e.target.value)}>
          ${demos.map((d) => html`<option value=${d.id} ?selected=${prefs.demoDriver === d.id}>${d.vendor}, ${t(d.protocol)}</option>`)}
        </select>
      </label>
      <div class="note">${icon('info', { size: 18 })}<span>${t('The demo runs a simulated BMS that speaks the real protocol, so every screen and the protocol log work without hardware.')}</span></div>`;
  }

  /** @param {'ble'|'serial'|'demo'} kind @param {string} reason */
  #unavailable(kind, reason) {
    const text = /** @type {any} */ (REASONS)[kind]?.[reason] ?? reason;
    return html`<div class="note warn">${icon('warning', { size: 18 })}<span>${t(text)}</span></div>`;
  }

  #recent() {
    const { recent } = this.sc.value;
    return html`<div class="section-title">${t('Recent devices')}</div>
      <div class="card recent">
        ${recent.map(
          (r) => html`<div class="recent-row">
            <ui-list-row
              icon=${r.kind === 'ble' ? 'bluetooth' : 'usb'}
              heading=${r.name}
              text=${`${this.ctrl.registry.get(r.driverId ?? '')?.protocol ?? ''} · ${ago(r.at)}`}
              @click=${() => this.ctrl.connectRecent(r)}
            ></ui-list-row>
            <button class="btn ghost icon" title=${t('Forget')} aria-label=${t('Forget')} @click=${() => this.ctrl.forgetRecent(r)}>${icon('close', { size: 18 })}</button>
          </div>`,
        )}
      </div>`;
  }

  #connect = async () => {
    const transport = this.ctrl.state.prefs.transport;
    if (transport === 'ble') await this.ctrl.connectBle();
    else if (transport === 'serial') await this.ctrl.connectSerial();
    else await this.ctrl.connectDemo();
  };
}
define('view-connect', ViewConnect);
