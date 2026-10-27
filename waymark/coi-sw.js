// Lets the co-pilot use all CPU cores: browsers only allow multi-threaded
// WebAssembly on "cross-origin isolated" pages, which needs two response headers
// GitHub Pages can't send. This service worker adds them to page loads. It uses
// the "credentialless" mode where the browser has it (Chrome, Firefox), so maps, videos and scripts from other
// sites keep working. Safari and every iPhone browser don't have that mode, so there it uses the strict
// "require-corp" mode: other sites' files then have to allow it (they do: the map tiles are loaded in CORS
// mode, and our own server sends the header). Add ?coi=0 to the address to switch the helper off.
const ua = self.navigator.userAgent;
const strict = /iPhone|iPad|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox|FxiOS/.test(ua)) || new URL(self.location.href).searchParams.get('mode') === 'strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  // the page itself, and the scripts of its worker threads, need the headers
  if (e.request.mode !== 'navigate' && !['worker', 'sharedworker'].includes(e.request.destination)) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (!res.ok || res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', strict ? 'require-corp' : 'credentialless');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(() => fetch(e.request)));
});
