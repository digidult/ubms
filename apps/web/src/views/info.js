import { html, css } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t, copyText, toast } from '@ubms/ui';
import { shortUuid } from '@ubms/transport';
import { num, duration, linkKindLabel } from '../format.js';

export class ViewInfo extends UiElement {
  static properties = { ctrl: { attribute: false } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        max-width: 760px;
      }
      .card {
        padding: 6px 16px;
        margin-bottom: 12px;
      }
      dl {
        margin: 0;
      }
      .item {
        display: grid;
        grid-template-columns: minmax(120px, 40%) 1fr;
        gap: 12px;
        padding: 11px 0;
        border-top: 1px solid var(--ui-border);
      }
      .item:first-child {
        border-top: 0;
      }
      dt {
        color: var(--ui-text-muted);
      }
      dd {
        margin: 0;
        font-weight: 600;
        word-break: break-word;
        font-variant-numeric: tabular-nums;
      }
      .toolbar {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
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
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({ info: s.info, device: s.device }));
  }

  #rows() {
    const { info, device } = this.sc.value;
    /** @type {Array<[string, string]>} */
    const dev = [];
    const i = info ?? {};
    const push = (/** @type {string} */ k, /** @type {any} */ v) => {
      if (v !== undefined && v !== null && v !== '') dev.push([k, String(v)]);
    };
    push(t('Vendor'), i.vendor ?? device?.vendor);
    push(t('Model'), i.model);
    push(t('Device name'), i.name);
    push(t('Hardware version'), i.hardwareVersion);
    push(t('Software version'), i.softwareVersion);
    push(t('Serial number'), i.serialNumber);
    push(t('Manufacture date'), i.manufactureDate);
    if (i.uptime !== undefined) push(t('Uptime'), duration(i.uptime));
    if (i.powerOnCount !== undefined) push(t('Power-on count'), num(i.powerOnCount, 0));
    for (const e of Object.values(i.extra ?? {})) {
      push(t(e.label), typeof e.value === 'number' ? `${num(e.value, e.decimals ?? 2)}${e.unit ? ` ${e.unit}` : ''}` : t(String(e.value)));
    }
    /** @type {Array<[string, string]>} */
    const link = [];
    if (device) {
      link.push([t('Protocol'), `${t(device.protocol)}${device.variant ? ` (${device.variant})` : ''}`]);
      link.push([t('Driver'), device.driverId]);
    }
    const l = /** @type {any} */ (this.ctrl.session.link?.describe() ?? {});
    if (l.kind) link.push([t('Connection'), linkKindLabel(l.kind)]);
    if (l.name) link.push([t('Port or device'), l.name]);
    if (l.service) link.push([t('GATT service'), shortUuid(l.service)]);
    if (l.notify) link.push([t('Notify characteristic'), shortUuid(l.notify)]);
    if (l.write) link.push([t('Write characteristic'), shortUuid(l.write)]);
    if (l.baudRate) link.push([t('Baud rate'), String(l.baudRate)]);
    const lk = this.ctrl.session.link;
    if (lk) link.push([t('Traffic'), t('{in} B in, {out} B out', { in: num(lk.bytesIn, 0), out: num(lk.bytesOut, 0) })]);
    return { dev, link };
  }

  render() {
    const { dev, link } = this.#rows();
    return html`
      <div class="toolbar">
        <button class="btn small" @click=${() => this.ctrl.session.refreshInfo().catch(() => {})}>${icon('refresh', { size: 16 })}${t('Refresh')}</button>
        <button class="btn small" @click=${this.#copy}>${icon('copy', { size: 16 })}${t('Copy')}</button>
      </div>
      <div class="section-title">${t('Device')}</div>
      <div class="card">
        ${dev.length
          ? html`<dl>${dev.map(([k, v]) => html`<div class="item"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`
          : html`<p class="muted">${t('The device has not reported its identity yet.')}</p>`}
      </div>
      <div class="section-title">${t('Connection')}</div>
      <div class="card">
        <dl>${link.map(([k, v]) => html`<div class="item"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      </div>
    `;
  }

  #copy = async () => {
    const { dev, link } = this.#rows();
    const text = [...dev, ...link].map(([k, v]) => `${k}: ${v}`).join('\n');
    if (await copyText(text)) toast(t('Copied'), { tone: 'ok', timeout: 1500 });
  };
}
define('view-info', ViewInfo);

