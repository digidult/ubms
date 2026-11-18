import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t } from '@ubms/ui';
import { num } from '../format.js';

export class ViewCells extends UiElement {
  static properties = {
    ctrl: { attribute: false },
    mode: { state: true },
  };

  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
        gap: 8px;
        margin-bottom: 12px;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 4px 0 10px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
        gap: 8px;
      }
      .cell {
        position: relative;
        padding: 10px 10px 12px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-surface);
        border: 1px solid var(--ui-border);
        overflow: hidden;
        min-width: 0;
      }
      .cell.min {
        border-color: var(--ui-info);
        box-shadow: inset 0 0 0 1px var(--ui-info);
      }
      .cell.max {
        border-color: var(--ui-danger);
        box-shadow: inset 0 0 0 1px var(--ui-danger);
      }
      .idx {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.75rem;
        font-weight: 700;
        color: var(--ui-text-muted);
      }
      .v {
        font-size: 1.2rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
        margin-top: 2px;
      }
      .v small {
        font-size: 0.75rem;
        color: var(--ui-text-muted);
        font-weight: 600;
      }
      .dev {
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        color: var(--ui-text-faint);
      }
      .dev.pos {
        color: var(--ui-danger);
      }
      .dev.neg {
        color: var(--ui-info);
      }
      .meter {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 4px;
        background: var(--ui-primary);
        opacity: 0.55;
      }
      .min .meter {
        background: var(--ui-info);
        opacity: 1;
      }
      .max .meter {
        background: var(--ui-danger);
        opacity: 1;
      }
      .bal {
        color: var(--ui-warn);
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }
      .res {
        font-size: 0.72rem;
        color: var(--ui-text-faint);
        margin-top: 2px;
      }
      .legend {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 14px;
        font-size: 0.8rem;
        color: var(--ui-text-muted);
      }
      .legend span {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .sw {
        width: 10px;
        height: 10px;
        border-radius: 3px;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('../controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
    /** @type {'voltage'|'deviation'} */
    this.mode = 'voltage';
  }

  connectedCallback() {
    super.connectedCallback();
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({ snapshot: s.snapshot }));
  }

  render() {
    const s = this.sc.value.snapshot;
    const cells = s?.cells ?? [];
    const st = s?.cellStats;
    if (!s || !cells.length || !st) {
      return html`<ui-empty icon="cells" heading=${t('No cell data yet')} text=${t('Cell voltages appear here as soon as the BMS reports them.')}></ui-empty>`;
    }
    const lo = st.min - 0.002;
    const hi = st.max + 0.002;
    const res = s.cellResistances ?? [];
    return html`
      <div class="summary">
        <ui-stat compact label=${t('Cells')} .value=${String(st.count)}></ui-stat>
        <ui-stat compact label=${t('Average')} .value=${num(st.avg, 3)} unit="V"></ui-stat>
        <ui-stat compact label=${t('Min')} .value=${num(st.min, 3)} unit="V" hint=${`#${st.minIndex + 1}`}></ui-stat>
        <ui-stat compact label=${t('Max')} .value=${num(st.max, 3)} unit="V" hint=${`#${st.maxIndex + 1}`}></ui-stat>
        <ui-stat compact label=${t('Delta')} .value=${num(st.delta * 1000, 0)} unit="mV" tone=${st.delta > 0.05 ? 'danger' : st.delta > 0.02 ? 'warn' : 'ok'}></ui-stat>
        ${s.balancingActive !== undefined
          ? html`<ui-stat
              compact
              label=${t('Balancer')}
              .value=${s.balancingActive ? t('Active') : t('Idle')}
              hint=${s.balanceCurrent !== undefined ? `${num(s.balanceCurrent, 3, { signed: true })} A` : ''}
              tone=${s.balancingActive ? 'warn' : ''}
            ></ui-stat>`
          : nothing}
      </div>
      <div class="toolbar">
        <ui-segmented
          .options=${[
            { value: 'voltage', label: t('Voltage') },
            { value: 'deviation', label: t('Deviation') },
          ]}
          .value=${this.mode}
          label=${t('Display')}
          @change=${(/** @type {any} */ e) => (this.mode = e.detail.value)}
        ></ui-segmented>
      </div>
      <div class="grid">
        ${cells.map((v, i) => {
          const cls = i === st.minIndex ? 'min' : i === st.maxIndex ? 'max' : '';
          const dev = (v - st.avg) * 1000;
          const pct = Math.max(4, Math.min(100, ((v - lo) / Math.max(hi - lo, 1e-6)) * 100));
          const balancing = s.balancing?.[i];
          return html`<div class="cell ${cls}" title=${`${t('Cell')} ${i + 1}`}>
            <div class="idx"><span>#${i + 1}</span>${balancing ? html`<span class="bal" title=${t('Balancing')}>${icon('balance', { size: 14 })}</span>` : nothing}</div>
            ${this.mode === 'voltage'
              ? html`<div class="v">${num(v, 3)}<small> V</small></div>
                  <div class="dev ${dev > 0.5 ? 'pos' : dev < -0.5 ? 'neg' : ''}">${num(dev, 0, { signed: true })} mV</div>`
              : html`<div class="v ${dev > 0.5 ? 'pos' : dev < -0.5 ? 'neg' : ''}">${num(dev, 1, { signed: true })}<small> mV</small></div>
                  <div class="dev">${num(v, 3)} V</div>`}
            ${Number.isFinite(res[i]) ? html`<div class="res">${num(res[i], 1)} mΩ</div>` : nothing}
            <div class="meter" style="width:${pct}%"></div>
          </div>`;
        })}
      </div>
      <div class="legend">
        <span><i class="sw" style="background:var(--ui-info)"></i>${t('Lowest cell')}</span>
        <span><i class="sw" style="background:var(--ui-danger)"></i>${t('Highest cell')}</span>
        ${s.balancing ? html`<span>${icon('balance', { size: 14 })}${t('Balancing')}</span>` : nothing}
        ${res.length ? html`<span>${t('mΩ: cell connection resistance')}</span>` : nothing}
      </div>
    `;
  }
}
define('view-cells', ViewCells);
