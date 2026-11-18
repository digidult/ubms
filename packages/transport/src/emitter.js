/**
 * Minimal synchronous event emitter used across all packages.
 * Listener errors are caught and reported so one faulty listener cannot break a protocol stream.
 */
export class Emitter {
  /** @type {Map<string, Set<(payload: any) => void>>} */
  #handlers = new Map();

  /**
   * Subscribe to an event.
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void} unsubscribe function
   */
  on(type, fn) {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(fn);
    return () => this.off(type, fn);
  }

  /**
   * Subscribe for a single emission.
   * @param {string} type
   * @param {(payload: any) => void} fn
   * @returns {() => void}
   */
  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  /**
   * @param {string} type
   * @param {(payload: any) => void} fn
   */
  off(type, fn) {
    this.#handlers.get(type)?.delete(fn);
  }

  /**
   * @param {string} type
   * @param {any} [payload]
   */
  emit(type, payload) {
    const set = this.#handlers.get(type);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[emitter] listener for "${type}" failed`, err);
      }
    }
  }

  /** @param {string} type */
  listenerCount(type) {
    return this.#handlers.get(type)?.size ?? 0;
  }

  removeAllListeners() {
    this.#handlers.clear();
  }
}
