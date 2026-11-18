import { html, css, nothing } from 'lit';
import { UiElement, define, sharedStyles, StoreController, icon, t, confirmDialog, toast, pickFile } from '@ubms/ui';
import { coerce, validateValue, validateAll, fieldMap } from '@ubms/bms-core';
import { num, fieldValue, ago } from '../format.js';
import { router } from '../app.js';

/**
 * @typedef {import('@ubms/bms-core/settings').SettingField} SettingField
 * @typedef {{ raw: string, value: any }} Edit
 */

export class ViewSettings extends UiElement {
  static properties = {
    ctrl: { attribute: false },
    group: { type: String },
    edits: { state: true },
    busy: { state: true },
    results: { state: true },
    query: { state: true },
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
        align-items: center;
        gap: 8px;
        margin-bottom: 12px;
      }
      .toolbar .meta {
        flex: 1;
        min-width: 140px;
        font-size: 0.82rem;
        color: var(--ui-text-muted);
      }
      .search {
        flex: 1 1 200px;
        max-width: 360px;
        min-height: 36px;
      }
      .results .section-title:first-child {
        margin-top: 4px;
      }
      .layout {
        display: grid;
        gap: 14px;
      }
      .groups {
        padding: 6px;
        align-self: start;
      }
      .fields-pane {
        min-width: 0;
      }
      .back {
        margin: 0 0 8px -8px;
      }
      @media (max-width: 899px) {
        .layout.has-group .groups {
          display: none;
        }
        .layout:not(.has-group) .fields-pane {
          display: none;
        }
      }
      @media (min-width: 900px) {
        .layout {
          grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
        }
        .back {
          display: none;
        }
        .groups {
          position: sticky;
          top: calc(var(--ui-header-height) + 8px);
        }
      }
      .group-head h2 {
        font-size: 1.15rem;
      }
      .group-head p {
        margin: 4px 0 12px;
        color: var(--ui-text-muted);
        font-size: 0.9rem;
      }
      .card.fields {
        padding: 4px 0;
      }
      .row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px 14px;
        align-items: center;
        padding: 12px 16px;
        border-top: 1px solid var(--ui-border);
      }
      .row:first-child {
        border-top: 0;
      }
      .row.dirty {
        background: color-mix(in srgb, var(--ui-primary-soft) 45%, transparent);
      }
      .label {
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .label .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--ui-primary);
        flex: none;
      }
      .desc {
        font-size: 0.82rem;
        color: var(--ui-text-muted);
      }
      .hint {
        font-size: 0.78rem;
        color: var(--ui-text-faint);
      }
      .err {
        grid-column: 1 / -1;
        font-size: 0.82rem;
        color: var(--ui-danger);
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .res-ok {
        grid-column: 1 / -1;
        font-size: 0.8rem;
        color: var(--ui-ok);
      }
      .res-warn {
        grid-column: 1 / -1;
        font-size: 0.8rem;
        color: var(--ui-warn);
      }
      .control {
        display: flex;
        align-items: center;
        gap: 6px;
        justify-content: flex-end;
      }
      .numwrap {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .numwrap .input {
        width: 120px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
      .unit {
        min-width: 22px;
        color: var(--ui-text-muted);
        font-size: 0.88rem;
      }
      .control select {
        min-width: 160px;
      }
      .control .input.text {
        width: 200px;
      }
      .ro {
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      @media (max-width: 520px) {
        .row {
          grid-template-columns: 1fr;
        }
        .control {
          justify-content: flex-start;
        }
        .numwrap .input,
        .control select,
        .control .input.text {
          width: 100%;
          flex: 1;
        }
        .numwrap {
          width: 100%;
        }
      }
      .applybar {
        position: sticky;
        bottom: calc(var(--ui-nav-height) + env(safe-area-inset-bottom) + 8px);
        z-index: 5;
        margin-top: 14px;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: var(--ui-radius);
        background: var(--ui-surface);
        border: 1px solid var(--ui-primary);
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.18);
      }
      @media (min-width: 900px) {
        .applybar {
          bottom: 16px;
        }
      }
      .applybar .count {
        flex: 1;
        font-weight: 650;
      }
      .warning {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        padding: 10px 12px;
        margin-bottom: 12px;
        border-radius: var(--ui-radius-sm);
        background: var(--ui-warn-soft);
        color: var(--ui-warn);
        font-size: 0.86rem;
      }
      .loading {
        padding: 40px 0;
      }
    `,
  ];

  constructor() {
    super();
    /** @type {import('../controller.js').AppController} */
    this.ctrl = /** @type {any} */ (null);
    this.group = '';
    /** @type {Record<string, Edit>} */
    this.edits = {};
    this.busy = false;
    /** @type {Record<string, import('@ubms/bms-core/session').WriteResult>} */
    this.results = {};
    this.requested = false;
    this.query = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.sc = new StoreController(this, this.ctrl.store, (s) => ({ settings: s.settings, showAdvanced: s.prefs.showAdvanced, state: s.state }));
  }

  updated() {
    const { settings, state } = this.sc.value;
    const caps = this.ctrl.session.driver?.capabilities;
    if (!this.requested && state === 'connected' && caps?.settings && !settings.values && !settings.loading) {
      this.requested = true;
      this.ctrl.loadSettings();
    }
  }

  get #schema() {
    return this.sc.value.settings.schema ?? this.ctrl.session.driver?.getSettingsSchema() ?? null;
  }

  /** @param {SettingField} f */
  #visible(f) {
    return !f.advanced || this.sc.value.showAdvanced;
  }

  render() {
    const caps = this.ctrl.session.driver?.capabilities;
    if (!caps?.settings) {
      return html`<ui-empty icon="sliders" heading=${t('No settings')} text=${t('This device or protocol does not expose configurable settings.')}></ui-empty>`;
    }
    const { settings } = this.sc.value;
    const schema = this.#schema;
    if (!settings.values) {
      if (settings.error) {
        return html`<ui-empty icon="alert" tone="danger" heading=${t('Could not read settings')} text=${t(settings.error)}>
          <button slot="actions" class="btn primary" @click=${() => this.ctrl.loadSettings()}>${icon('refresh', { size: 18 })}${t('Try again')}</button>
        </ui-empty>`;
      }
      return html`<ui-empty class="loading" icon="clock" heading=${t('Reading settings…')} text=${t('This can take a few seconds.')}></ui-empty>`;
    }
    if (!schema) return nothing;
    const groups = schema.groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => this.#visible(f)) }))
      .filter((g) => g.fields.length);
    const current = groups.find((g) => g.id === this.group) ?? groups[0];
    const hasGroup = !!this.group && !!groups.find((g) => g.id === this.group);
    const dirty = Object.keys(this.edits).length;
    if (this.query.trim()) {
      return html`${this.#toolbar(settings)}${this.#searchResults(groups)}${dirty ? this.#applyBar(dirty) : nothing}`;
    }
    return html`
      ${this.#toolbar(settings)}
      <div class="layout ${hasGroup ? 'has-group' : ''}">
        <div class="card groups">
          ${groups.map((g) => {
            const n = g.fields.filter((f) => f.id in this.edits).length;
            return html`<ui-list-row
              href=${`#/settings/${g.id}`}
              icon=${g.icon ?? 'sliders'}
              heading=${t(g.label)}
              text=${g.description ? t(g.description) : ''}
              trailing=${n ? `● ${n}` : String(g.fields.length)}
              ?active=${current?.id === g.id && hasGroup}
            ></ui-list-row>`;
          })}
        </div>
        <div class="fields-pane">${current ? this.#group(current) : nothing}</div>
      </div>
      ${dirty ? this.#applyBar(dirty) : nothing}
    `;
  }

  /** @param {import('@ubms/bms-core/session').SettingsState} settings */
  #toolbar(settings) {
    const writable = this.ctrl.session.driver?.capabilities.writeSettings;
    return html`<div class="toolbar">
      <input
        class="input search"
        type="search"
        placeholder=${t('Search settings')}
        aria-label=${t('Search settings')}
        .value=${this.query}
        @input=${(/** @type {any} */ e) => (this.query = e.target.value)}
      />
      <span class="meta">${settings.readAt ? t('Read {time}', { time: ago(settings.readAt) }) : ''}${!writable ? html` · ${t('read only')}` : nothing}</span>
      <button class="btn small" ?disabled=${settings.loading} @click=${() => this.ctrl.loadSettings()} title=${t('Read again from the device')}>
        ${icon('refresh', { size: 16 })}${t('Reload')}
      </button>
      <button class="btn small" @click=${() => this.ctrl.exportSettings()} title=${t('Save all settings to a file')}>${icon('download', { size: 16 })}${t('Export')}</button>
      ${writable
        ? html`<button class="btn small" @click=${this.#import} title=${t('Load settings from a file')}>${icon('upload', { size: 16 })}${t('Import')}</button>`
        : nothing}
    </div>`;
  }

  /** @param {import('@ubms/bms-core/settings').SettingGroup[]} groups */
  #searchResults(groups) {
    const q = this.query.trim().toLowerCase();
    const values = this.sc.value.settings.values ?? {};
    const errors = validateAll(/** @type {any} */ (this.#schema), this.#mergedValues());
    const hit = (/** @type {SettingField} */ f) =>
      [f.id, f.label, t(f.label), f.description ?? '', f.description ? t(f.description) : ''].some((x) => x.toLowerCase().includes(q));
    const matches = groups.map((g) => ({ g, fields: g.fields.filter(hit) })).filter((m) => m.fields.length);
    if (!matches.length) return html`<ui-empty icon="search" heading=${t('Nothing found')} text=${t('No setting matches "{query}".', { query: this.query })}></ui-empty>`;
    return html`<div class="results">
      ${matches.map(
        ({ g, fields }) => html`<div class="section-title">${t(g.label)}</div>
          <div class="card fields">${fields.map((f) => this.#row(f, values[f.id], errors[f.id]))}</div>`,
      )}
    </div>`;
  }

  /** @param {import('@ubms/bms-core/settings').SettingGroup} g */
  #group(g) {
    const values = this.sc.value.settings.values ?? {};
    const merged = this.#mergedValues();
    const errors = validateAll(/** @type {any} */ (this.#schema), merged);
    return html`
      <button class="btn ghost small back" @click=${() => router.navigate('/settings')}>${icon('back', { size: 18 })}${t('All groups')}</button>
      <div class="group-head">
        <h2>${t(g.label)}</h2>
        ${g.description ? html`<p>${t(g.description)}</p>` : nothing}
      </div>
      ${this.ctrl.session.driver?.capabilities.writeSettings
        ? html`<div class="warning">${icon('warning', { size: 18 })}<span>${t('Wrong settings can damage the battery or the BMS. Change values only when you know what they do.')}</span></div>`
        : nothing}
      <div class="card fields">${g.fields.map((f) => this.#row(f, values[f.id], errors[f.id]))}</div>
    `;
  }

  #mergedValues() {
    const merged = { ...(this.sc.value.settings.values ?? {}) };
    for (const [id, e] of Object.entries(this.edits)) if (e.value !== undefined) merged[id] = e.value;
    return merged;
  }

  /**
   * @param {SettingField} f
   * @param {any} value
   * @param {string} [crossError]
   */
  #row(f, value, crossError) {
    const edit = this.edits[f.id];
    const dirty = !!edit;
    const writable = this.ctrl.session.driver?.capabilities.writeSettings && !f.readOnly;
    const single = edit ? validateValue(f, edit.value) : null;
    const error = edit ? (single ? t(single.message, single.params) : crossError ? t(crossError) : '') : '';
    const result = this.results[f.id];
    const range =
      f.type === 'number' && f.min !== undefined && f.max !== undefined ? `${num(f.min, f.decimals ?? 3)}–${num(f.max, f.decimals ?? 3)}${f.unit ? ` ${f.unit}` : ''}` : '';
    return html`<div class="row ${dirty ? 'dirty' : ''}">
      <div>
        <div class="label">${dirty ? html`<span class="dot"></span>` : nothing}${t(f.label)}</div>
        ${f.description ? html`<div class="desc">${t(f.description)}</div>` : nothing}
        ${range && writable ? html`<div class="hint">${range}</div>` : nothing}
      </div>
      <div class="control">${f.type === 'action' ? this.#action(f) : writable ? this.#control(f, value, edit) : html`<span class="ro">${fieldValue(f, value)}</span>`}</div>
      ${error ? html`<div class="err">${icon('alert', { size: 15 })}${error}</div>` : nothing}
      ${!dirty && result
        ? result.ok && result.verified !== false
          ? html`<div class="res-ok">${t('Saved')}</div>`
          : result.ok
            ? html`<div class="res-warn">${t('Written, but the device reports {value}', { value: fieldValue(f, result.actual) })}</div>`
            : html`<div class="err">${icon('alert', { size: 15 })}${t(result.error ?? 'Failed')}</div>`
        : nothing}
    </div>`;
  }

  /**
   * @param {SettingField} f
   * @param {any} value
   * @param {Edit | undefined} edit
   */
  #control(f, value, edit) {
    switch (f.type) {
      case 'boolean':
        return html`<ui-switch .checked=${edit ? !!edit.value : !!value} label=${t(f.label)} @change=${(/** @type {any} */ e) => this.#set(f, e.detail.checked, value)}></ui-switch>`;
      case 'enum':
        return html`<select @change=${(/** @type {any} */ e) => this.#set(f, e.target.value, value)}>
          ${value === undefined && !edit ? html`<option value="" selected disabled>${t('n/a')}</option>` : nothing}
          ${(f.options ?? []).map((o) => {
            const sel = String(edit ? edit.value : value) === String(o.value);
            return html`<option value=${String(o.value)} ?selected=${sel}>${t(o.label)}</option>`;
          })}
        </select>`;
      case 'text':
        return html`<input
          class="input text"
          type="text"
          maxlength=${f.maxLength ?? 64}
          .value=${edit ? edit.raw : value ?? ''}
          @input=${(/** @type {any} */ e) => this.#set(f, e.target.value, value)}
        />`;
      default: {
        const shown = edit ? edit.raw : value === undefined ? '' : num(value, f.decimals ?? 3).replace(/\s/g, '');
        return html`<span class="numwrap"
          ><input
            class="input"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            .value=${shown}
            @input=${(/** @type {any} */ e) => this.#set(f, e.target.value, value)}
          /><span class="unit">${f.unit ?? ''}</span></span
        >`;
      }
    }
  }

  /**
   * @param {SettingField} f
   * @param {any} raw
   * @param {any} current
   */
  #set(f, raw, current) {
    const value = coerce(f, raw);
    const edits = { ...this.edits };
    const same = value !== undefined && current !== undefined && (f.type === 'number' ? Math.abs(value - current) < 1e-9 : String(value) === String(current));
    if (same) delete edits[f.id];
    else edits[f.id] = { raw: String(raw), value };
    this.edits = edits;
    if (this.results[f.id]) {
      const r = { ...this.results };
      delete r[f.id];
      this.results = r;
    }
  }

  /** @param {SettingField} f */
  #action(f) {
    return html`<button class="btn small ${f.danger ? 'danger' : ''}" ?disabled=${this.busy} @click=${() => this.#runAction(f)}>${icon(f.danger ? 'warning' : 'wrench', { size: 16 })}${t('Run')}</button>`;
  }

  /** @param {SettingField} f */
  async #runAction(f) {
    const ok = await confirmDialog({
      title: t(f.label),
      message: f.description ? t(f.description) : t('Run this action on the device?'),
      confirmLabel: t('Run'),
      danger: !!f.danger,
    });
    if (!ok) return;
    this.busy = true;
    try {
      await this.ctrl.runAction(f.id);
    } finally {
      this.busy = false;
    }
  }

  /** @param {number} count */
  #applyBar(count) {
    const fields = fieldMap(this.#schema);
    const merged = this.#mergedValues();
    const crossErrors = validateAll(/** @type {any} */ (this.#schema), merged);
    const invalid = Object.entries(this.edits).some(([id, e]) => {
      const f = fields.get(id);
      return !f || validateValue(f, e.value) || crossErrors[id];
    });
    return html`<div class="applybar" role="region" aria-label=${t('Pending changes')}>
      <span class="count">${t('{count} change(s)', { count })}</span>
      <button class="btn small ghost" ?disabled=${this.busy} @click=${() => (this.edits = {})}>${t('Discard')}</button>
      <button class="btn small primary" ?disabled=${this.busy || invalid} @click=${this.#apply}>${icon('save', { size: 16 })}${this.busy ? t('Writing…') : t('Apply')}</button>
    </div>`;
  }

  #apply = async () => {
    const fields = fieldMap(this.#schema);
    const values = this.sc.value.settings.values ?? {};
    const changes = Object.entries(this.edits).map(([id, e]) => ({ id, value: e.value }));
    const details = changes.map(({ id, value }) => {
      const f = /** @type {SettingField} */ (fields.get(id));
      return `${t(f.label)}: ${fieldValue(f, values[id])} → ${fieldValue(f, value)}`;
    });
    const ok = await confirmDialog({
      title: t('Write {count} setting(s) to the device?', { count: changes.length }),
      details,
      confirmLabel: t('Write'),
      danger: changes.some(({ id }) => fields.get(id)?.danger),
    });
    if (!ok) return;
    this.busy = true;
    try {
      const results = await this.ctrl.writeSettings(changes);
      /** @type {Record<string, any>} */
      const map = {};
      const edits = { ...this.edits };
      for (const r of results) {
        map[r.id] = r;
        if (r.ok) delete edits[r.id];
      }
      this.results = map;
      this.edits = edits;
    } finally {
      this.busy = false;
    }
  };

  #import = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const { changes, skipped, sameDriver } = this.ctrl.parseSettingsImport(file.text);
      if (!changes.length) {
        toast(t('The file contains no differences to the current settings.'), { tone: 'info' });
        return;
      }
      if (!sameDriver) toast(t('The file was saved from a different BMS type. Check every value before applying.'), { tone: 'warn', timeout: 8000 });
      const fields = fieldMap(this.#schema);
      /** @type {Record<string, Edit>} */
      const edits = { ...this.edits };
      for (const c of changes) {
        const f = fields.get(c.id);
        edits[c.id] = { raw: f?.type === 'number' ? num(c.value, f.decimals ?? 3).replace(/\s/g, '') : String(c.value), value: c.value };
      }
      this.edits = edits;
      toast(t('{count} change(s) loaded from the file. Review and apply them.', { count: changes.length }) + (skipped.length ? `\n${t('Skipped: {list}', { list: skipped.join(', ') })}` : ''), {
        tone: 'ok',
        timeout: 8000,
      });
    } catch (err) {
      toast(t(err instanceof Error ? err.message : String(err)), { tone: 'danger' });
    }
  };
}
define('view-settings', ViewSettings);
