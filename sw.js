// 오프라인 지원: 화면 파일·data JSON 모두 네트워크 우선(새 버전 즉시 반영), 실패 시 캐시
const CACHE = 'di-v12';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes('/data/')) {
    e.respondWith(fetch(e.request).then((r) => {
      const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request)));
  } else {
    // 화면 파일: 네트워크 우선(새 버전 즉시 반영), 오프라인이면 캐시
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok && e.request.method === 'GET' && url.origin === location.origin) {
        const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('./'))));
  }
});
