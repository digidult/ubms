import { html, css, nothing } from 'lit';
import { UiElement, define } from '../element.js';
import { sharedStyles } from '../theme.js';
import { icon } from '../icons.js';
import { t } from '../i18n.js';

/**
 * Modal dialog on top of the native <dialog> element (focus handling, Escape, backdrop).
 * Renders as a bottom sheet on narrow screens.
 */
export class UiDialog extends UiElement {
  static properties = {
    heading: { type: String },
    open: { type: Boolean, reflect: true },
    wide: { type: Boolean },
  };

  static styles = [
    sharedStyles,
    css`
      dialog {
        border: 0;
        padding: 0;
        max-width: min(560px, calc(100vw - 32px));
        width: 100%;
        border-radius: 18px;
        background: var(--ui-surface);
        color: var(--ui-text);
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35);
      }
      dialog.wide {
        max-width: min(860px, calc(100vw - 32px));
      }
      dialog::backdrop {
        background: var(--ui-scrim);
      }
      header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 16px 12px 6px 20px;
      }
      h2 {
        flex: 1;
        font-size: 1.1rem;
      }
      .body {
        padding: 6px 20px 12px;
        max-height: min(70vh, 640px);
        overflow: auto;
      }
      footer {
        display: flex;
        flex-wrap: wrap;
        justify-content: flex-end;
        gap: 8px;
        padding: 10px 20px 18px;
      }
      @media (max-width: 599px) {
        dialog {
          margin: auto 0 0 0;
          max-width: 100vw;
          border-radius: 20px 20px 0 0;
          padding-bottom: env(safe-area-inset-bottom);
        }
        dialog.wide {
          max-width: 100vw;
        }
        footer ::slotted(*) {
          flex: 1;
        }
      }
    `,
  ];

  constructor() {
    super();
    this.heading = '';
    this.open = false;
    this.wide = false;
  }

  /** @returns {HTMLDialogElement | null} */
  get dialog() {
    return this.renderRoot?.querySelector('dialog') ?? null;
  }

  updated(changed) {
    const d = this.dialog;
    if (!d || !changed.has('open')) return;
    if (this.open && !d.open) d.showModal();
    if (!this.open && d.open) d.close();
  }

  render() {
    return html`<dialog class=${this.wide ? 'wide' : ''} @close=${this.#onClose} @click=${this.#onBackdrop}>
      <header>
        <h2>${this.heading}</h2>
        <button class="btn ghost icon" @click=${() => this.close()} aria-label=${t('Close')}>${icon('close')}</button>
      </header>
      <div class="body"><slot></slot></div>
      <footer><slot name="footer"></slot></footer>
    </dialog>`;
  }

  close() {
    this.open = false;
  }

  #onClose() {
    if (this.open) this.open = false;
    this.fire('close');
  }

  /** @param {MouseEvent} e */
  #onBackdrop(e) {
    if (e.target === this.dialog) {
      const r = this.dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) this.close();
    }
  }
}
define('ui-dialog', UiDialog);

/**
 * Ask for confirmation. Resolves true when confirmed.
 * @param {{ title: string, message?: string, details?: string[], confirmLabel?: string, cancelLabel?: string, danger?: boolean }} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, message = '', details = [], confirmLabel, cancelLabel, danger = false }) {
  return new Promise((resolve) => {
    const el = /** @type {UiDialog} */ (document.createElement('ui-dialog'));
    el.heading = title;
    let result = false;
    const body = document.createElement('div');
    if (message) {
      const p = document.createElement('p');
      p.textContent = message;
      p.style.margin = '0 0 8px';
      body.append(p);
    }
    if (details.length) {
      const ul = document.createElement('ul');
      ul.style.cssText = 'margin:0;padding-left:20px;font-variant-numeric:tabular-nums';
      for (const d of details) {
        const li = document.createElement('li');
        li.textContent = d;
        ul.append(li);
      }
      body.append(ul);
    }
    el.append(body);
    const mk = (/** @type {string} */ label, /** @type {string} */ cls, /** @type {boolean} */ value) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.slot = 'footer';
      b.className = cls;
      b.style.cssText =
        'font:inherit;font-weight:600;min-height:44px;padding:0 18px;border-radius:9px;cursor:pointer;border:1px solid var(--ui-border);' +
        (value
          ? danger
            ? 'background:var(--ui-danger);border-color:var(--ui-danger);color:#fff'
            : 'background:var(--ui-primary);border-color:var(--ui-primary);color:#fff'
          : 'background:var(--ui-surface);color:var(--ui-text)');
      b.addEventListener('click', () => {
        result = value;
        el.close();
      });
      return b;
    };
    el.append(mk(cancelLabel ?? t('Cancel'), 'cancel', false), mk(confirmLabel ?? t('Confirm'), 'confirm', true));
    el.addEventListener('close', () => {
      el.remove();
      resolve(result);
    });
    document.body.append(el);
    requestAnimationFrame(() => (el.open = true));
  });
}

/**
 * @typedef {{ id: number, message: string, tone: 'info'|'ok'|'warn'|'danger', timeout: number }} ToastItem
 */
export class UiToaster extends UiElement {
  static properties = { items: { state: true } };

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    :host {
      position: fixed;
      z-index: 50;
      left: 50%;
      transform: translateX(-50%);
      bottom: calc(var(--ui-nav-height) + 12px + env(safe-area-inset-bottom));
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: min(480px, calc(100vw - 24px));
      pointer-events: none;
    }
    @media (min-width: 900px) {
      :host {
        bottom: 20px;
        left: calc(50% + var(--ui-rail-width) / 2);
      }
    }
    .toast {
      pointer-events: auto;
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--ui-text);
      color: var(--ui-bg);
      font: 500 0.92rem/1.4 var(--ui-font);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
      animation: in 0.18s ease-out;
    }
    .toast.ok svg {
      color: var(--ui-ok);
    }
    .toast.warn svg {
      color: var(--ui-warn);
    }
    .toast.danger svg {
      color: var(--ui-danger);
    }
    .msg {
      flex: 1;
      white-space: pre-line;
    }
    button {
      border: 0;
      background: transparent;
      color: inherit;
      opacity: 0.7;
      cursor: pointer;
      padding: 0;
    }
    @keyframes in {
      from {
        opacity: 0;
        transform: translateY(8px);
      }
    }
  `;

  constructor() {
    super();
    /** @type {ToastItem[]} */
    this.items = [];
    this.seq = 0;
  }

  /** @param {string} message @param {{ tone?: ToastItem['tone'], timeout?: number }} [opts] */
  show(message, { tone = 'info', timeout = 4000 } = {}) {
    const item = { id: ++this.seq, message, tone, timeout };
    this.items = [...this.items.slice(-3), item];
    if (timeout > 0) setTimeout(() => this.dismiss(item.id), timeout);
  }

  /** @param {number} id */
  dismiss(id) {
    this.items = this.items.filter((i) => i.id !== id);
  }

  render() {
    const ic = { info: 'info', ok: 'check-circle', warn: 'warning', danger: 'alert' };
    return html`${this.items.map(
      (i) => html`<div class="toast ${i.tone}" role=${i.tone === 'danger' ? 'alert' : 'status'}>
        ${icon(ic[i.tone], { size: 20 })}<span class="msg">${i.message}</span>
        <button @click=${() => this.dismiss(i.id)} aria-label=${t('Close')}>${icon('close', { size: 18 })}</button>
      </div>`,
    )}`;
  }
}
define('ui-toaster', UiToaster);

/**
 * Show a toast message.
 * @param {string} message
 * @param {{ tone?: 'info'|'ok'|'warn'|'danger', timeout?: number }} [opts]
 */
export function toast(message, opts) {
  if (typeof document === 'undefined') return;
  let el = /** @type {UiToaster | null} */ (document.querySelector('ui-toaster'));
  if (!el) {
    el = /** @type {UiToaster} */ (document.createElement('ui-toaster'));
    document.body.append(el);
  }
  el.show(message, opts);
}

/** Hex dump with offsets and ASCII column. */
export class UiHexview extends UiElement {
  static properties = {
    bytes: { attribute: false },
    width: { type: Number },
  };

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    :host {
      display: block;
    }
    pre {
      margin: 0;
      font: 0.8rem/1.5 var(--ui-mono);
      overflow-x: auto;
      color: var(--ui-text);
      white-space: pre;
    }
    .off {
      color: var(--ui-text-faint);
    }
    .asc {
      color: var(--ui-text-muted);
    }
  `;

  constructor() {
    super();
    /** @type {Uint8Array | null} */
    this.bytes = null;
    this.width = 16;
  }

  render() {
    const b = this.bytes;
    if (!b?.length) return nothing;
    const rows = [];
    for (let off = 0; off < b.length; off += this.width) {
      const row = b.subarray(off, off + this.width);
      let h = '';
      let a = '';
      for (let i = 0; i < this.width; i++) {
        if (i < row.length) {
          h += row[i].toString(16).toUpperCase().padStart(2, '0') + ' ';
          a += row[i] >= 0x20 && row[i] < 0x7f ? String.fromCharCode(row[i]) : '.';
        } else h += '   ';
      }
      rows.push(html`<span class="off">${off.toString(16).toUpperCase().padStart(4, '0')}</span>  ${h} <span class="asc">${a}</span>\n`);
    }
    return html`<pre>${rows}</pre>`;
  }
}
define('ui-hexview', UiHexview);
