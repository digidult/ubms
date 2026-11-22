import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t } from '@ubms/ui';

/**
 * Plugins of the desktop app (docs/plugins.md): the folders that are read, every loaded plugin
 * with its drivers, and every file that was not loaded with the reason.
 */
export class ViewPlugins extends UiElement {
  static properties = { ctrl: { attribute: false } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        max-width: 760px;
      }
      .card {
        padding: 14px 16px;
        margin-bottom: 12px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .card p {
        margin: 0;
      }
      .note {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 10px 12px;
        margin-bottom: 12px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-warn-soft);
        color: var(--ui-warn);
        font-size: 0.9rem;
      }
      .note svg {
        flex: none;
        margin-top: 1px;
      }
      ul {
        margin: 0;
        padding: 0;
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      code {
        font-family: var(--ui-mono);
        font-size: 0.85rem;
        word-break: break-all;
        user-select: all;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px 10px;
      }
      .head b {
        font-size: 1.02rem;
      }
      .driver {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-top: 10px;
        border-top: 1px solid var(--ui-border);
      }
      .driver .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        font-size: 0.85rem;
        color: var(--ui-text-muted);
      }
      .failure {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-top: 10px;
        border-top: 1px solid var(--ui-border);
      }
      .failure:first-child {
        padding-top: 0;
        border-top: 0;
      }
      .failure span {
        color: var(--ui-danger);
        font-size: 0.9rem;
        word-break: break-word;
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
    this.sc = new StoreController(this, this.ctrl.store, (s) => s.plugins);
  }

  render() {
    if (!this.ctrl.state.env.tauri) {
      return html`<div class="card"><p class="muted">${t('Plugins are available in the desktop app only.')}</p></div>`;
    }
    const { dirs, plugins, failures } = this.sc.value;
    return html`
      <div class="note">${icon('warning', { size: 18 })}<span>${t('A plugin runs with the full rights of the app. Install only plugins you trust.')}</span></div>
      <div class="section-title">${t('Plugin folders')}</div>
      <div class="card">
        <p class="muted">${t('Each plugin is one .js file in one of these folders. Restart the app after adding or removing a file.')}</p>
        ${dirs.length ? html`<ul>${dirs.map((d) => html`<li><code>${d}</code></li>`)}</ul>` : html`<p class="faint">${t('No plugin folder was found.')}</p>`}
      </div>
      <div class="section-title">${t('Loaded plugins')}</div>
      ${plugins.length
        ? plugins.map((p) => this.#plugin(p))
        : html`<div class="card"><p class="muted">${t('No plugins are loaded.')}</p></div>`}
      ${failures.length
        ? html`<div class="section-title">${t('Not loaded')}</div>
            <div class="card">
              ${failures.map(
                (f) => html`<div class="failure">
                  <code>${f.file || t('Plugin list')}</code>
                  <span>${t(f.message, f.params?.error !== undefined ? { ...f.params, error: t(String(f.params.error)) } : f.params)}</span>
                </div>`,
              )}
            </div>`
        : nothing}
    `;
  }

  /** @param {import('../plugins.js').LoadedPlugin} p */
  #plugin(p) {
    return html`<div class="card">
      <div class="head">
        <b>${p.name}</b>
        ${p.version ? html`<span class="chip">${t('Version {version}', { version: p.version })}</span>` : nothing}
        <code class="faint">${p.file}</code>
      </div>
      ${p.drivers.map((id) => {
        const d = /** @type {any} */ (this.ctrl.registry.get(id));
        if (!d) return nothing;
        const links = [d.links.ble ? t('Bluetooth') : '', d.links.serial ? t('Serial') : '', d.demo ? t('Demo') : ''].filter(Boolean);
        return html`<div class="driver">
          <span>${d.vendor}, ${t(d.protocol)}</span>
          <span class="meta"><code>${id}</code><span>${links.join(' · ')}</span></span>
        </div>`;
      })}
    </div>`;
  }
}
define('view-plugins', ViewPlugins);
