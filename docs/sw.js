// Fonctionne hors ligne : coquille de l'app en cache, polices en cache à la volée. La météo n'est jamais mise en cache ici
// (l'app garde elle-même la dernière prévision).
const CACHE = 'rrr-shell-v2';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'js/main.js', 'js/core.js', 'js/store.js', 'js/weather.js', 'js/ics.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== location.origin && !isFont) return; // API météo : réseau direct
  // Fichiers de l'app : réseau d'abord (les mises à jour se voient tout de suite), cache en secours hors ligne.
  // Polices : cache d'abord.
  if (!isFont) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
        return res;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) caches.open(CACHE).then((c) => c.put(e.request, res.clone()));
      return res;
    }))
  );
});
