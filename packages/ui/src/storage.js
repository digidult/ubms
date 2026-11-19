/**
 * Namespaced JSON storage on top of localStorage. Every access is guarded: private windows,
 * blocked storage or quota errors degrade to in-memory behaviour instead of breaking the app.
 * @param {string} namespace
 */
export function createStorage(namespace) {
  /** @type {Map<string, any>} */
  const memory = new Map();
  /**
   * Keys whose last write or removal failed: their in-memory state is newer than whatever
   * localStorage still holds, so reads must not return the stale persisted value.
   * @type {Set<string>}
   */
  const unsaved = new Set();
  const prefix = `${namespace}:`;

  /** @returns {Storage | null} */
  function ls() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null;
    }
  }

  return {
    /**
     * @template T
     * @param {string} key
     * @param {T} fallback
     * @returns {T}
     */
    get(key, fallback) {
      if (!unsaved.has(key)) {
        try {
          const raw = ls()?.getItem(prefix + key);
          if (raw !== null && raw !== undefined) return JSON.parse(raw);
        } catch {
          /* fall through */
        }
      }
      return memory.has(key) ? memory.get(key) : fallback;
    },
    /** @param {string} key @param {any} value */
    set(key, value) {
      memory.set(key, value);
      try {
        ls()?.setItem(prefix + key, JSON.stringify(value));
        unsaved.delete(key);
      } catch {
        /* keep the in-memory copy, it is newer than the persisted one */
        unsaved.add(key);
      }
    },
    /** @param {string} key */
    remove(key) {
      memory.delete(key);
      try {
        ls()?.removeItem(prefix + key);
        unsaved.delete(key);
      } catch {
        /* the persisted value may still be there: reads return the fallback */
        unsaved.add(key);
      }
    },
    /** Remove every key of this namespace. */
    clear() {
      memory.clear();
      try {
        const s = ls();
        if (!s) return;
        const keys = [];
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k?.startsWith(prefix)) keys.push(k);
        }
        for (const k of keys) s.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}
