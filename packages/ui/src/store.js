/**
 * Small observable store. State is replaced immutably; subscribers are notified synchronously.
 * @template {Record<string, any>} S
 */
export class Store {
  /** @param {S} initial */
  constructor(initial) {
    /** @type {S} */
    this.state = initial;
    /** @type {Set<(state: S, prev: S) => void>} */
    this.listeners = new Set();
  }

  /** @returns {S} */
  get() {
    return this.state;
  }

  /**
   * Shallow-merge a patch (or the result of a patch function) into the state.
   * @param {Partial<S> | ((s: S) => Partial<S>)} patch
   */
  set(patch) {
    const prev = this.state;
    const next = typeof patch === 'function' ? patch(prev) : patch;
    this.state = { ...prev, ...next };
    for (const fn of [...this.listeners]) fn(this.state, prev);
  }

  /**
   * @param {(state: S, prev: S) => void} fn
   * @returns {() => void}
   */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Lit reactive controller: re-renders the host when the selected slice of a store changes
 * (shallow comparison of the selector result).
 * @template {Record<string, any>} S
 * @template T
 */
export class StoreController {
  /**
   * @param {import('lit').ReactiveControllerHost} host
   * @param {Store<S>} store
   * @param {(s: S) => T} [selector]
   */
  constructor(host, store, selector) {
    this.host = host;
    this.store = store;
    this.selector = selector ?? ((/** @type {S} */ s) => /** @type {any} */ (s));
    /** @type {T} */
    this.value = this.selector(store.get());
    /** @type {(() => void) | null} */
    this.unsubscribe = null;
    host.addController(this);
  }

  hostConnected() {
    this.value = this.selector(this.store.get());
    this.unsubscribe = this.store.subscribe((s) => {
      const next = this.selector(s);
      if (!shallowEqual(next, this.value)) {
        this.value = next;
        this.host.requestUpdate();
      }
    });
  }

  hostDisconnected() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** @param {any} a @param {any} b */
export function shallowEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}
