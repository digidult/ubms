import { Store } from './store.js';

/**
 * Hash router (`#/settings/cell_voltage`). Hash routing works from a single local HTML file,
 * from any static host and inside a Tauri webview without server configuration.
 *
 * @typedef {{ name: string, path: string }} RouteDef  path like '/settings/:group?'
 * @typedef {{ name: string, params: Record<string, string>, path: string, query: Record<string, string> }} Route
 */
export class HashRouter extends Store {
  /**
   * @param {RouteDef[]} routes
   * @param {string} fallbackPath used for unknown hashes
   */
  constructor(routes, fallbackPath) {
    super(/** @type {{ route: Route }} */ ({ route: { name: '', params: {}, path: '', query: {} } }));
    this.routes = routes.map((r) => ({ ...r, ...compile(r.path) }));
    this.fallbackPath = fallbackPath;
    this.onHash = () => this.#sync();
    if (typeof window !== 'undefined') window.addEventListener('hashchange', this.onHash);
    this.#sync();
  }

  get route() {
    return this.get().route;
  }

  /** @param {string} hashPath path without '#', for example '/cells' */
  resolve(hashPath) {
    const [path, qs = ''] = hashPath.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs));
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      /** @type {Record<string, string>} */
      const params = {};
      r.keys.forEach((k, i) => {
        if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]);
      });
      return { name: r.name, params, path, query };
    }
    return null;
  }

  #sync() {
    const hash = typeof location !== 'undefined' ? location.hash.replace(/^#/, '') : '';
    const route = this.resolve(hash || this.fallbackPath) ?? this.resolve(this.fallbackPath);
    if (route) this.set({ route });
  }

  /**
   * @param {string} path
   * @param {{ replace?: boolean }} [opts]
   */
  navigate(path, { replace = false } = {}) {
    if (typeof location === 'undefined') {
      const route = this.resolve(path);
      if (route) this.set({ route });
      return;
    }
    const url = `#${path}`;
    if (replace) {
      history.replaceState(null, '', url);
      this.#sync();
    } else if (location.hash !== url) {
      location.hash = url;
    }
  }

  back(fallback = this.fallbackPath) {
    if (typeof history !== 'undefined' && history.length > 1) history.back();
    else this.navigate(fallback, { replace: true });
  }

  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('hashchange', this.onHash);
  }
}

/** @param {string} path */
function compile(path) {
  /** @type {string[]} */
  const keys = [];
  const pattern = path
    .split('/')
    .filter(Boolean)
    .map((seg) => {
      const m = /^:(\w+)(\?)?$/.exec(seg);
      if (!m) return `/${seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
      keys.push(m[1]);
      return m[2] ? '(?:/([^/]+))?' : '/([^/]+)';
    })
    .join('');
  return { keys, regex: new RegExp(`^${pattern || '/'}/?$`) };
}
