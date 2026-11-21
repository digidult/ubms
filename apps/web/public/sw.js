/*
 * Offline support when ubms is served over https (for example https://ubms-html.vercel.app) and
 * installed as an app. The whole app is index.html, so the cache holds just a few files.
 *
 * Strategy: network first. Online, every load gets the current build (a deployment is visible on
 * the next load, not only on the one after); the response also refreshes the cache. When the
 * network fails or does not answer within NETWORK_TIMEOUT_MS, the cached copy is served, so the
 * installed app still opens offline. The single-file build opened from disk does not use this
 * worker.
 */
const CACHE = 'ubms-v2';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-maskable.svg'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const network = fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      try {
        return await Promise.race([
          network,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
        ]);
      } catch {
        const cached = await cache.match(req, { ignoreSearch: true });
        return cached ?? network;
      }
    })(),
  );
});
