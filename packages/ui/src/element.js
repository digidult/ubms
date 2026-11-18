import { LitElement } from 'lit';
import { i18n } from './i18n.js';

/**
 * Base class for all components: re-renders on locale changes so `t()` calls stay current.
 * Reactive properties must be declared in `static properties` and initialised in the
 * constructor (class fields would shadow Lit accessors).
 */
export class UiElement extends LitElement {
  connectedCallback() {
    super.connectedCallback();
    this.__offLocale = i18n.onChange(() => this.requestUpdate());
  }

  disconnectedCallback() {
    this.__offLocale?.();
    super.disconnectedCallback();
  }

  /**
   * Dispatch a bubbling, composed custom event.
   * @param {string} type
   * @param {any} [detail]
   */
  fire(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }
}

/**
 * Register a custom element once (safe for HMR and duplicate imports).
 * @param {string} tag
 * @param {CustomElementConstructor} ctor
 */
export function define(tag, ctor) {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) customElements.define(tag, ctor);
}
