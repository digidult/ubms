import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, icon, t } from '@ubms/ui';
import { SEVERITY_ORDER } from '@ubms/bms-core';
import { num } from '../format.js';

/** Compact bar chart of all cell voltages (relative to the pack min/max). */
export class BmsCellBars extends UiElement {
  static properties = {
    cells: { type: Array },
    balancing: { type: Array },
    height: { type: Number },
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
    .bars {
      display: flex;
      align-items: flex-end;
      gap: 3px;
      height: var(--h, 64px);
    }
    .bar {
      flex: 1;
      min-width: 3px;
      border-radius: 3px 3px 1px 1px;
      background: var(--ui-primary);
      opacity: 0.75;
      position: relative;
    }
    .bar.min {
      background: var(--ui-info);
      opacity: 1;
    }
    .bar.max {
      background: var(--ui-danger);
      opacity: 1;
    }
    .bar.bal::after {
      content: '';
      position: absolute;
      left: 50%;
      top: -7px;
      width: 4px;
      height: 4px;
      margin-left: -2px;
      border-radius: 50%;
      background: var(--ui-warn);
    }
  `;

  constructor() {
    super();
    /** @type {number[]} */
    this.cells = [];
    /** @type {boolean[]} */
    this.balancing = [];
    this.height = 64;
  }

  render() {
    const cells = this.cells ?? [];
    if (!cells.length) return nothing;
    let lo = Math.min(...cells);
    let hi = Math.max(...cells);
    const span = Math.max(hi - lo, 0.01);
    lo -= span * 0.6;
    hi += span * 0.1;
    const minI = cells.indexOf(Math.min(...cells));
    const maxI = cells.indexOf(Math.max(...cells));
    return html`<div class="bars" style="--h:${this.height}px" role="img" aria-label=${t('Cell voltages')}>
      ${cells.map((v, i) => {
        const h = Math.max(6, ((v - lo) / (hi - lo)) * 100);
        const cls = `bar ${i === minI ? 'min' : ''} ${i === maxI ? 'max' : ''} ${this.balancing?.[i] ? 'bal' : ''}`;
        return html`<div class=${cls} style="height:${h}%" title=${`#${i + 1}: ${num(v, 3)} V`}></div>`;
      })}
    </div>`;
  }
}
define('bms-cell-bars', BmsCellBars);

/** List of active alarms, most severe first. */
export class BmsAlarmList extends UiElement {
  static properties = { alarms: { type: Array } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      li {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .label {
        flex: 1;
        min-width: 0;
        font-weight: 550;
      }
      .src {
        font-size: 0.75rem;
      }
      .ok {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--ui-ok);
        font-weight: 600;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('@ubms/bms-core/model').AlarmState[]} */
    this.alarms = [];
  }

  render() {
    const list = [...(this.alarms ?? [])].sort(
      (a, b) => (SEVERITY_ORDER[a.severity ?? 'warning'] ?? 9) - (SEVERITY_ORDER[b.severity ?? 'warning'] ?? 9),
    );
    if (!list.length) return html`<div class="ok">${icon('check-circle', { size: 20 })}${t('No active alarms')}</div>`;
    const tone = { fault: 'danger', protection: 'danger', warning: 'warn', info: 'info' };
    const name = { fault: t('Fault'), protection: t('Protection'), warning: t('Warning'), info: t('Info') };
    return html`<ul>
      ${list.map((a) => {
        const sev = a.severity ?? 'warning';
        return html`<li>
          <span class="chip ${/** @type {any} */ (tone)[sev]}">${/** @type {any} */ (name)[sev]}</span>
          <span class="label">${t(a.label ?? a.id)}</span>
          ${a.source ? html`<span class="src faint mono">${a.source}</span>` : nothing}
        </li>`;
      })}
    </ul>`;
  }
}
define('bms-alarm-list', BmsAlarmList);

/** Temperature readings. */
export class BmsTempList extends UiElement {
  static properties = { temps: { type: Array } };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
        gap: 8px;
      }
      .t {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface-2);
        min-width: 0;
      }
      .t svg {
        flex: none;
        color: var(--ui-text-muted);
      }
      .lbl {
        font-size: 0.78rem;
        color: var(--ui-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .val {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .hot .val {
        color: var(--ui-danger);
      }
      .warm .val {
        color: var(--ui-warn);
      }
      .cold .val {
        color: var(--ui-info);
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('@ubms/bms-core/model').TemperatureReading[]} */
    this.temps = [];
  }

  render() {
    const temps = this.temps ?? [];
    if (!temps.length) return html`<span class="muted">${t('No temperature sensors reported')}</span>`;
    return html`<div class="grid">
      ${temps.map((x) => {
        const cls = x.value >= 60 ? 'hot' : x.value >= 45 ? 'warm' : x.value <= 0 ? 'cold' : '';
        return html`<div class="t ${cls}">
          ${icon(x.kind === 'mos' ? 'chip' : x.kind === 'heater' ? 'flame' : 'thermometer', { size: 18 })}
          <div style="min-width:0">
            <div class="lbl">${t(x.label)}</div>
            <div class="val">${num(x.value, 1)} °C</div>
          </div>
        </div>`;
      })}
    </div>`;
  }
}
define('bms-temp-list', BmsTempList);
