import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t, pickFile, toast, copyText } from '@ubms/ui';
import { ProtocolLog, hex } from '@ubms/transport';

const KINDS = /** @type {const} */ (['tx', 'rx', 'frame', 'event', 'warn', 'error', 'debug']);
const PAGE = 300;

/**
 * Does a log entry match the filter text? The text is searched in the name and the text of the
 * entry. Only a query that is hex itself (an even number of hex digits, spaces, commas, colons
 * and 0x allowed) is also searched in the bytes, byte by byte: "read" must not find the nibbles
 * EAD, and "E5" must not find the bytes 4E 57.
 * @param {import('@ubms/transport').LogEntry} e
 * @param {string} query
 */
export function entryMatches(e, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  if (e.name?.toLowerCase().includes(q) || e.text?.toLowerCase().includes(q)) return true;
  if (e.bytes) {
    const digits = q.replace(/0x|[\s,:]/g, '');
    if (digits.length >= 2 && digits.length % 2 === 0 && /^[0-9a-f]+$/.test(digits)) {
      const needle = /** @type {string[]} */ (digits.toUpperCase().match(/../g)).join(' ');
      if (hex(e.bytes, ' ').includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Protocol log viewer: live list with filters, expandable entries (hex dump + decoded fields),
 * pause, export (JSON with decoded frames, or text) and opening saved logs.
 */
export class ViewLog extends UiElement {
  static properties = {
    ctrl: { attribute: false },
    paused: { state: true },
    filters: { state: true },
    expanded: { state: true },
    limit: { state: true },
    query: { state: true },
    imported: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 10px;
      }
      .filters {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }
      .filters button {
        border: 1px solid var(--ui-border);
        background: var(--ui-surface);
        color: var(--ui-text-muted);
        border-radius: 999px;
        padding: 4px 12px;
        min-height: 32px;
        font: 600 0.8rem var(--ui-font);
        cursor: pointer;
      }
      .filters button[aria-pressed='true'] {
        background: var(--ui-primary-soft);
        border-color: var(--ui-primary);
        color: var(--ui-primary);
      }
      .search {
        flex: 1;
        min-width: 160px;
        max-width: 320px;
      }
      .list {
        font: 0.82rem/1.45 var(--ui-mono);
        border: 1px solid var(--ui-border);
        border-radius: var(--ui-radius);
        background: var(--ui-surface);
        overflow: hidden;
      }
      .entry {
        border-top: 1px solid var(--ui-border);
      }
      .entry:first-child {
        border-top: 0;
      }
      .head {
        display: grid;
        grid-template-columns: 7.5ch 5.5ch minmax(0, 1fr);
        gap: 8px;
        align-items: baseline;
        padding: 6px 10px;
        cursor: pointer;
      }
      .head:hover {
        background: var(--ui-surface-2);
      }
      .time {
        color: var(--ui-text-faint);
      }
      .kind {
        font-weight: 700;
      }
      .k-tx {
        color: var(--ui-primary);
      }
      .k-rx {
        color: var(--ui-info);
      }
      .k-frame {
        color: var(--ui-ok);
      }
      .k-event {
        color: var(--ui-text-muted);
      }
      .k-warn {
        color: var(--ui-warn);
      }
      .k-error {
        color: var(--ui-danger);
      }
      .k-debug {
        color: var(--ui-text-faint);
      }
      .text {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--ui-text);
      }
      .text .name {
        font-weight: 700;
        margin-right: 6px;
      }
      .text .bytes {
        color: var(--ui-text-muted);
      }
      .detail {
        padding: 8px 12px 12px;
        background: var(--ui-surface-2);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .detail pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: 0.8rem/1.45 var(--ui-mono);
      }
      .detail .actions {
        display: flex;
        gap: 6px;
        font-family: var(--ui-font);
      }
      .more {
        display: flex;
        justify-content: center;
        padding: 10px;
      }
      .banner {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 12px;
        margin-bottom: 10px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-info-soft);
        color: var(--ui-info);
        font-size: 0.88rem;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('../controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
    this.paused = false;
    /** @type {Record<string, boolean>} */
    this.filters = { tx: true, rx: false, frame: true, event: true, warn: true, error: true, debug: false };
    /** @type {Set<number>} */
    this.expanded = new Set();
    this.limit = PAGE;
    this.query = '';
    /** @type {{ name: string, entries: import('@ubms/transport').LogEntry[] } | null} */
    this.imported = null;
    this.frozen = /** @type {import('@ubms/transport').LogEntry[] | null} */ (null);
    this.raf = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this.prefs = new StoreController(this, this.ctrl.store, (s) => ({ logRaw: s.prefs.logRaw }));
    this.filters = { ...this.filters, rx: this.ctrl.state.prefs.logRaw };
    const schedule = () => {
      if (this.paused || this.imported || this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        this.requestUpdate();
      });
    };
    this.offEntry = this.ctrl.log.on('entry', schedule);
    this.offClear = this.ctrl.log.on('clear', schedule);
  }

  disconnectedCallback() {
    this.offEntry?.();
    this.offClear?.();
    if (this.raf) cancelAnimationFrame(this.raf);
    super.disconnectedCallback();
  }

  #source() {
    if (this.imported) return this.imported.entries;
    if (this.paused) return this.frozen ?? [];
    return this.ctrl.log.list;
  }

  /** @param {import('@ubms/transport').LogEntry} e */
  #matches(e) {
    return !!this.filters[e.kind] && entryMatches(e, this.query);
  }

  render() {
    const all = this.#source();
    const t0 = all[0]?.t;
    const shown = [];
    for (let i = all.length - 1; i >= 0 && shown.length < this.limit; i--) {
      if (this.#matches(all[i])) shown.push(all[i]);
    }
    const hidden = all.filter((e) => this.#matches(e)).length - shown.length;
    return html`
      ${this.imported
        ? html`<div class="banner">${icon('file', { size: 18 })}<span style="flex:1">${t('Viewing file {name}', { name: this.imported.name })}</span>
            <button class="btn small" @click=${() => (this.imported = null)}>${t('Back to live log')}</button></div>`
        : nothing}
      <div class="toolbar">
        ${!this.imported
          ? html`<button class="btn small" @click=${this.#togglePause}>${icon(this.paused ? 'play' : 'pause', { size: 16 })}${this.paused ? t('Resume') : t('Pause')}</button>
              <button class="btn small" @click=${() => this.ctrl.log.clear()}>${icon('trash', { size: 16 })}${t('Clear')}</button>`
          : nothing}
        <button class="btn small" @click=${() => this.ctrl.exportLog()} title=${t('JSON with raw bytes and decoded frames')}>${icon('download', { size: 16 })}${t('Export')}</button>
        <button class="btn small" @click=${() => this.ctrl.exportLogText()}>${icon('file', { size: 16 })}${t('Text')}</button>
        <button class="btn small" @click=${this.#open}>${icon('upload', { size: 16 })}${t('Open')}</button>
        <input class="input search" type="search" placeholder=${t('Filter: text or hex')} .value=${this.query} @input=${(/** @type {any} */ e) => (this.query = e.target.value)} />
      </div>
      <div class="filters" role="group" aria-label=${t('Entry types')}>
        ${KINDS.map(
          (k) => html`<button aria-pressed=${this.filters[k] ? 'true' : 'false'} @click=${() => this.#toggleFilter(k)}>${this.#kindLabel(k)}</button>`,
        )}
      </div>
      ${shown.length
        ? html`<div class="list">${shown.map((e) => this.#entry(e, t0))}</div>
            ${hidden > 0
              ? html`<div class="more"><button class="btn small" @click=${() => (this.limit += PAGE)}>${t('Show {count} older entries', { count: Math.min(PAGE, hidden) })}</button></div>`
              : nothing}`
        : html`<ui-empty icon="terminal" heading=${t('No log entries')} text=${t('Traffic between the app and the device appears here, down to single bytes.')}></ui-empty>`}
    `;
  }

  /** @param {string} k */
  #kindLabel(k) {
    return /** @type {Record<string, string>} */ ({
      tx: t('Sent'),
      rx: t('Raw received'),
      frame: t('Frames'),
      event: t('Events'),
      warn: t('Warnings'),
      error: t('Errors'),
      debug: t('Debug'),
    })[k];
  }

  /** @param {string} k */
  #toggleFilter(k) {
    this.filters = { ...this.filters, [k]: !this.filters[k] };
    if (k === 'rx') this.ctrl.setPref('logRaw', this.filters.rx);
  }

  #togglePause() {
    this.paused = !this.paused;
    this.frozen = this.paused ? this.ctrl.log.entries() : null;
  }

  /**
   * @param {import('@ubms/transport').LogEntry} e
   * @param {number | undefined} t0
   */
  #entry(e, t0) {
    const open = this.expanded.has(e.id);
    const time = t0 !== undefined ? `+${((e.t - t0) / 1000).toFixed(3)}` : '';
    const preview = e.bytes ? hex(e.bytes.subarray(0, 48), ' ') + (e.bytes.length > 48 ? ' …' : '') : '';
    return html`<div class="entry">
      <div class="head" role="button" tabindex="0" aria-expanded=${open ? 'true' : 'false'} @click=${() => this.#toggle(e.id)} @keydown=${activateOnKey}>
        <span class="time">${time}</span>
        <span class="kind k-${e.kind}">${e.kind === 'frame' ? 'FRM' : e.kind === 'event' ? 'EVT' : e.kind === 'debug' ? 'DBG' : e.kind.toUpperCase()}</span>
        <span class="text">
          ${e.name ? html`<span class="name">${e.name}</span>` : nothing}${e.text ? html`<span>${e.text}</span> ` : nothing}
          ${e.bytes ? html`<span class="bytes">[${e.bytes.length}] ${preview}</span>` : nothing}
        </span>
      </div>
      ${open ? this.#detail(e) : nothing}
    </div>`;
  }

  /** @param {import('@ubms/transport').LogEntry} e */
  #detail(e) {
    const decoded = ProtocolLog.decoded(e);
    return html`<div class="detail">
      <div class="faint">${new Date(e.t).toISOString()}${e.source ? ` · ${e.source}` : ''}</div>
      ${e.text ? html`<pre>${e.text}</pre>` : nothing}
      ${e.bytes ? html`<ui-hexview .bytes=${e.bytes}></ui-hexview>` : nothing}
      ${decoded !== undefined ? html`<pre>${JSON.stringify(decoded, replacer, 2)}</pre>` : nothing}
      <div class="actions">
        ${e.bytes ? html`<button class="btn small" @click=${() => this.#copy(hex(e.bytes ?? new Uint8Array(), ' '))}>${icon('copy', { size: 14 })}${t('Copy hex')}</button>` : nothing}
        ${decoded !== undefined ? html`<button class="btn small" @click=${() => this.#copy(JSON.stringify(decoded, replacer, 2))}>${icon('copy', { size: 14 })}${t('Copy decoded')}</button>` : nothing}
      </div>
    </div>`;
  }

  /** @param {number} id */
  #toggle(id) {
    const next = new Set(this.expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded = next;
  }

  /** @param {string} text */
  async #copy(text) {
    if (await copyText(text)) toast(t('Copied'), { tone: 'ok', timeout: 1500 });
  }

  #open = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const { entries } = ProtocolLog.parseExport(file.text);
      this.imported = { name: file.name, entries };
      this.limit = PAGE;
    } catch {
      // Not JSON, not a log export, or broken entries: the parser's English text would not help.
      toast(t('The file is not a ubms protocol log.'), { tone: 'danger' });
    }
  };
}
define('view-log', ViewLog);

/** Enter and Space expand an entry head like a click. @param {KeyboardEvent} e */
function activateOnKey(e) {
  if ((e.key !== 'Enter' && e.key !== ' ') || e.repeat) return;
  e.preventDefault();
  /** @type {HTMLElement} */ (e.currentTarget).click();
}

/** JSON replacer that keeps byte arrays readable. @param {string} _k @param {any} v */
function replacer(_k, v) {
  if (v instanceof Uint8Array) return hex(v, ' ');
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e6) / 1e6;
  return v;
}
