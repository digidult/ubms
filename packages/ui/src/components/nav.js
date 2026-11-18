import { html, css } from 'lit';
import { UiElement, define } from '../element.js';
import { sharedStyles } from '../theme.js';
import { icon } from '../icons.js';

/**
 * Primary navigation. Bottom tab bar on phones, a labelled side rail on wide screens.
 *
 * @typedef {{ id: string, label: string, icon: string, href: string, badge?: string | number, tone?: 'danger'|'warn'|'ok', disabled?: boolean }} NavItem
 */
export class UiNav extends UiElement {
  static properties = {
    items: { type: Array },
    active: { type: String },
    brand: { type: String },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      nav {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 20;
        display: flex;
        justify-content: space-around;
        background: color-mix(in srgb, var(--ui-surface) 92%, transparent);
        backdrop-filter: blur(10px);
        border-top: 1px solid var(--ui-border);
        padding-bottom: env(safe-area-inset-bottom);
      }
      .brand {
        display: none;
      }
      a {
        flex: 1;
        max-width: 120px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 2px;
        min-height: var(--ui-nav-height);
        color: var(--ui-text-muted);
        text-decoration: none;
        font-size: 0.72rem;
        font-weight: 600;
        position: relative;
      }
      a[aria-current='page'] {
        color: var(--ui-primary);
      }
      a[aria-current='page'] .pill {
        background: var(--ui-primary-soft);
      }
      a[aria-disabled='true'] {
        opacity: 0.35;
        pointer-events: none;
      }
      .pill {
        display: grid;
        place-items: center;
        width: 52px;
        height: 30px;
        border-radius: 999px;
        transition: background 0.15s;
      }
      .label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 100%;
        padding: 0 2px;
      }
      .badge {
        position: absolute;
        top: 6px;
        left: calc(50% + 8px);
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--ui-primary);
        color: #fff;
        font-size: 0.68rem;
        line-height: 18px;
        text-align: center;
      }
      .badge.danger {
        background: var(--ui-danger);
      }
      .badge.warn {
        background: var(--ui-warn);
      }
      .badge.ok {
        background: var(--ui-ok);
      }
      @media (min-width: 900px) {
        nav {
          top: 0;
          right: auto;
          width: var(--ui-rail-width);
          flex-direction: column;
          justify-content: flex-start;
          gap: 2px;
          padding: 12px 10px;
          border-top: 0;
          border-right: 1px solid var(--ui-border);
          background: var(--ui-surface);
          backdrop-filter: none;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px 18px;
          font-weight: 750;
          font-size: 1.1rem;
          letter-spacing: -0.02em;
        }
        .brand-mark {
          width: 30px;
          height: 30px;
          border-radius: 9px;
          display: grid;
          place-items: center;
          background: var(--ui-primary);
          color: #fff;
        }
        a {
          flex: none;
          max-width: none;
          flex-direction: row;
          justify-content: flex-start;
          gap: 12px;
          min-height: 46px;
          padding: 0 8px;
          border-radius: var(--ui-radius-sm);
          font-size: 0.95rem;
        }
        a:hover {
          background: var(--ui-surface-2);
        }
        a[aria-current='page'] {
          background: var(--ui-primary-soft);
        }
        a[aria-current='page'] .pill {
          background: transparent;
        }
        .pill {
          width: 30px;
          height: 30px;
        }
        .badge {
          position: static;
          margin-left: auto;
        }
      }
    `,
  ];

  constructor() {
    super();
    /** @type {NavItem[]} */
    this.items = [];
    this.active = '';
    this.brand = '';
  }

  render() {
    return html`<nav aria-label="Main">
      <div class="brand"><span class="brand-mark">${icon('battery', { size: 18, stroke: 2.2 })}</span>${this.brand}</div>
      ${this.items.map(
        (it) => html`<a
          href=${it.href}
          aria-current=${it.id === this.active ? 'page' : 'false'}
          aria-disabled=${it.disabled ? 'true' : 'false'}
          title=${it.label}
        >
          <span class="pill">${icon(it.icon)}</span>
          <span class="label">${it.label}</span>
          ${it.badge !== undefined && it.badge !== '' && it.badge !== 0
            ? html`<span class="badge ${it.tone ?? ''}">${it.badge}</span>`
            : ''}
        </a>`,
      )}
    </nav>`;
  }
}
define('ui-nav', UiNav);
