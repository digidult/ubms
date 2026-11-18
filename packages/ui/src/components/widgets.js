import { html, css, svg, nothing } from 'lit';
import { UiElement, define } from '../element.js';
import { sharedStyles } from '../theme.js';
import { icon } from '../icons.js';

/** Metric tile: label, big value with unit, optional hint line and tone. */
export class UiStat extends UiElement {
  static properties = {
    label: { type: String },
    value: { type: String },
    unit: { type: String },
    hint: { type: String },
    icon: { type: String },
    tone: { type: String, reflect: true },
    compact: { type: Boolean, reflect: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .tile {
        height: 100%;
        padding: 12px 14px;
        border-radius: var(--ui-radius);
        background: var(--ui-surface);
        border: 1px solid var(--ui-border);
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.78rem;
        font-weight: 600;
        color: var(--ui-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .value {
        font-size: 1.45rem;
        font-weight: 700;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .unit {
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--ui-text-muted);
        margin-left: 3px;
      }
      .hint {
        font-size: 0.78rem;
        color: var(--ui-text-faint);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      :host([compact]) .tile {
        padding: 8px 10px;
      }
      :host([compact]) .value {
        font-size: 1.12rem;
      }
      :host([compact]) .label {
        font-size: 0.72rem;
      }
      :host([tone='ok']) .value {
        color: var(--ui-ok);
      }
      :host([tone='warn']) .value {
        color: var(--ui-warn);
      }
      :host([tone='danger']) .value {
        color: var(--ui-danger);
      }
      :host([tone='charge']) .value {
        color: var(--ui-charge);
      }
      :host([tone='discharge']) .value {
        color: var(--ui-discharge);
      }
    `,
  ];

  constructor() {
    super();
    this.label = '';
    this.value = '';
    this.unit = '';
    this.hint = '';
    this.icon = '';
    this.tone = '';
    this.compact = false;
  }

  render() {
    return html`<div class="tile">
      <div class="label">${this.icon ? icon(this.icon, { size: 15 }) : nothing}<span>${this.label}</span></div>
      <div class="value">${this.value}${this.unit ? html`<span class="unit">${this.unit}</span>` : nothing}</div>
      ${this.hint ? html`<div class="hint">${this.hint}</div>` : html`<slot name="hint"></slot>`}
    </div>`;
  }
}
define('ui-stat', UiStat);

/** Ring gauge (0 to 100) with centered content slot. */
export class UiRing extends UiElement {
  static properties = {
    value: { type: Number },
    size: { type: Number },
    thickness: { type: Number },
    tone: { type: String },
    indeterminate: { type: Boolean },
  };

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    :host {
      display: inline-block;
      position: relative;
    }
    svg {
      display: block;
      transform: rotate(-90deg);
    }
    .track {
      stroke: var(--ui-surface-3);
    }
    .bar {
      stroke: var(--ring-color, var(--ui-primary));
      transition: stroke-dashoffset 0.6s ease, stroke 0.3s;
    }
    .center {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      text-align: center;
    }
  `;

  constructor() {
    super();
    this.value = 0;
    this.size = 168;
    this.thickness = 14;
    this.tone = '';
    this.indeterminate = false;
  }

  render() {
    const r = (this.size - this.thickness) / 2;
    const c = 2 * Math.PI * r;
    const v = Math.max(0, Math.min(100, Number.isFinite(this.value) ? this.value : 0));
    const color =
      this.tone === 'danger' ? 'var(--ui-danger)' : this.tone === 'warn' ? 'var(--ui-warn)' : this.tone === 'ok' ? 'var(--ui-ok)' : 'var(--ui-primary)';
    return html`<svg width=${this.size} height=${this.size} viewBox="0 0 ${this.size} ${this.size}" style="--ring-color:${color}">
        <circle class="track" cx=${this.size / 2} cy=${this.size / 2} r=${r} fill="none" stroke-width=${this.thickness}></circle>
        <circle
          class="bar"
          cx=${this.size / 2}
          cy=${this.size / 2}
          r=${r}
          fill="none"
          stroke-width=${this.thickness}
          stroke-linecap="round"
          stroke-dasharray=${c}
          stroke-dashoffset=${c * (1 - v / 100)}
        ></circle>
      </svg>
      <div class="center"><slot></slot></div>`;
  }
}
define('ui-ring', UiRing);

/** Minimal line chart for recent history. `points` is [{ t, v }]. */
export class UiSparkline extends UiElement {
  static properties = {
    points: { type: Array },
    height: { type: Number },
    tone: { type: String },
    zero: { type: Boolean },
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
    svg {
      display: block;
      width: 100%;
    }
    .line {
      fill: none;
      stroke: var(--spark-color, var(--ui-primary));
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
      stroke-linejoin: round;
    }
    .area {
      fill: var(--spark-color, var(--ui-primary));
      opacity: 0.12;
    }
    .zero {
      stroke: var(--ui-border);
      stroke-dasharray: 3 3;
      vector-effect: non-scaling-stroke;
    }
  `;

  constructor() {
    super();
    /** @type {Array<{ t: number, v: number }>} */
    this.points = [];
    this.height = 56;
    this.tone = '';
    this.zero = false;
  }

  render() {
    const pts = this.points ?? [];
    const w = 300;
    const h = this.height;
    if (pts.length < 2) return html`<svg viewBox="0 0 ${w} ${h}" height=${h} preserveAspectRatio="none"></svg>`;
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (this.zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    if (hi - lo < 1e-9) {
      hi += 0.5;
      lo -= 0.5;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const x = (/** @type {number} */ t) => ((t - t0) / Math.max(1, t1 - t0)) * w;
    const y = (/** @type {number} */ v) => h - ((v - lo) / (hi - lo)) * h;
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const area = `${line}L${x(t1).toFixed(1)},${h}L0,${h}Z`;
    const color =
      this.tone === 'charge' ? 'var(--ui-charge)' : this.tone === 'discharge' ? 'var(--ui-discharge)' : this.tone === 'warn' ? 'var(--ui-warn)' : 'var(--ui-primary)';
    return html`<svg viewBox="0 0 ${w} ${h}" height=${h} preserveAspectRatio="none" style="--spark-color:${color}" aria-hidden="true">
      ${svg`<path class="area" d=${area}></path><path class="line" d=${line}></path>`}
      ${this.zero && lo < 0 && hi > 0 ? svg`<line class="zero" x1="0" x2=${w} y1=${y(0)} y2=${y(0)}></line>` : nothing}
    </svg>`;
  }
}
define('ui-sparkline', UiSparkline);

/** Accessible toggle switch. Fires `change` with detail { checked }. */
export class UiSwitch extends UiElement {
  static properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
    label: { type: String },
  };

  static styles = css`
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }
    :host {
      display: inline-flex;
      vertical-align: middle;
    }
    button {
      appearance: none;
      border: 0;
      padding: 0;
      margin: 0;
      width: 52px;
      height: 32px;
      border-radius: 16px;
      background: var(--ui-surface-3);
      position: relative;
      cursor: pointer;
      transition: background 0.15s;
    }
    button::after {
      content: '';
      position: absolute;
      top: 3px;
      left: 3px;
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      transition: transform 0.15s;
    }
    :host([checked]) button {
      background: var(--ui-ok);
    }
    :host([checked]) button::after {
      transform: translateX(20px);
    }
    :host([disabled]) button {
      opacity: 0.45;
      cursor: default;
    }
    :host([busy]) button::after {
      animation: pulse 0.9s ease-in-out infinite;
    }
    button:focus-visible {
      outline: 2px solid var(--ui-primary);
      outline-offset: 2px;
    }
    @keyframes pulse {
      50% {
        opacity: 0.4;
      }
    }
  `;

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.busy = false;
    this.label = '';
  }

  render() {
    return html`<button
      role="switch"
      aria-checked=${this.checked ? 'true' : 'false'}
      aria-label=${this.label}
      ?disabled=${this.disabled || this.busy}
      @click=${this.#toggle}
    ></button>`;
  }

  #toggle() {
    if (this.disabled || this.busy) return;
    this.fire('change', { checked: !this.checked });
  }
}
define('ui-switch', UiSwitch);

/** Segmented control. `options` is [{ value, label, icon? }]. Fires `change` with { value }. */
export class UiSegmented extends UiElement {
  static properties = {
    options: { type: Array },
    value: { type: String },
    label: { type: String },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .seg {
        display: flex;
        gap: 4px;
        padding: 4px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface-2);
        border: 1px solid var(--ui-border);
        overflow-x: auto;
        scrollbar-width: none;
      }
      button {
        flex: 1;
        min-height: 38px;
        padding: 0 12px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--ui-text-muted);
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        white-space: nowrap;
      }
      button[aria-pressed='true'] {
        background: var(--ui-surface);
        color: var(--ui-text);
        box-shadow: var(--ui-shadow);
      }
    `,
  ];

  constructor() {
    super();
    /** @type {Array<{ value: string, label: string, icon?: string }>} */
    this.options = [];
    this.value = '';
    this.label = '';
  }

  render() {
    return html`<div class="seg" role="group" aria-label=${this.label}>
      ${this.options.map(
        (o) => html`<button aria-pressed=${String(o.value) === String(this.value) ? 'true' : 'false'} @click=${() => this.fire('change', { value: o.value })}>
          ${o.icon ? icon(o.icon, { size: 18 }) : nothing}${o.label}
        </button>`,
      )}
    </div>`;
  }
}
define('ui-segmented', UiSegmented);

/** Empty / status placeholder with icon, title, text and an actions slot. */
export class UiEmpty extends UiElement {
  static properties = {
    icon: { type: String },
    heading: { type: String },
    text: { type: String },
    tone: { type: String },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .box {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 10px;
        padding: 32px 20px;
      }
      .ic {
        width: 64px;
        height: 64px;
        border-radius: 20px;
        display: grid;
        place-items: center;
        background: var(--ui-primary-soft);
        color: var(--ui-primary);
      }
      :host([tone='danger']) .ic {
        background: var(--ui-danger-soft);
        color: var(--ui-danger);
      }
      :host([tone='warn']) .ic {
        background: var(--ui-warn-soft);
        color: var(--ui-warn);
      }
      p {
        margin: 0;
        max-width: 46ch;
        color: var(--ui-text-muted);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        justify-content: center;
        margin-top: 6px;
      }
    `,
  ];

  constructor() {
    super();
    this.icon = 'info';
    this.heading = '';
    this.text = '';
    this.tone = '';
  }

  render() {
    return html`<div class="box">
      <div class="ic">${icon(this.icon, { size: 30 })}</div>
      ${this.heading ? html`<h2>${this.heading}</h2>` : nothing}
      ${this.text ? html`<p>${this.text}</p>` : nothing}
      <slot></slot>
      <div class="actions"><slot name="actions"></slot></div>
    </div>`;
  }
}
define('ui-empty', UiEmpty);

/** Navigation row for lists (settings groups, "more" menu). */
export class UiListRow extends UiElement {
  static properties = {
    href: { type: String },
    icon: { type: String },
    heading: { type: String },
    text: { type: String },
    trailing: { type: String },
    active: { type: Boolean, reflect: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      a,
      .static {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 14px;
        min-height: 60px;
        color: inherit;
        text-decoration: none;
        border-radius: var(--ui-radius-sm);
      }
      a:hover {
        background: var(--ui-surface-2);
      }
      :host([active]) a {
        background: var(--ui-primary-soft);
      }
      .ic {
        flex: none;
        width: 38px;
        height: 38px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        background: var(--ui-surface-2);
        color: var(--ui-text-muted);
      }
      :host([active]) .ic {
        background: var(--ui-primary);
        color: #fff;
      }
      .txt {
        flex: 1;
        min-width: 0;
      }
      .title {
        font-weight: 600;
      }
      .sub {
        font-size: 0.85rem;
        color: var(--ui-text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .trail {
        color: var(--ui-text-faint);
        font-size: 0.85rem;
        display: flex;
        align-items: center;
        gap: 4px;
        white-space: nowrap;
      }
    `,
  ];

  constructor() {
    super();
    this.href = '';
    this.icon = '';
    this.heading = '';
    this.text = '';
    this.trailing = '';
    this.active = false;
  }

  render() {
    const body = html`${this.icon ? html`<span class="ic">${icon(this.icon, { size: 20 })}</span>` : nothing}
      <span class="txt"><div class="title">${this.heading}</div>${this.text ? html`<div class="sub">${this.text}</div>` : nothing}<slot></slot></span>
      <span class="trail">${this.trailing}<slot name="trailing"></slot>${this.href ? icon('forward', { size: 18 }) : nothing}</span>`;
    return this.href ? html`<a href=${this.href}>${body}</a>` : html`<div class="static">${body}</div>`;
  }
}
define('ui-list-row', UiListRow);
