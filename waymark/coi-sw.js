// Lets the co-pilot use all CPU cores: browsers only allow multi-threaded
// WebAssembly on "cross-origin isolated" pages, which needs two response headers
// GitHub Pages can't send. This service worker adds them to page loads. It uses
// the "credentialless" mode, so maps, videos and scripts from other sites keep
// working; browsers without that mode simply stay single-threaded.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  // the page itself, and the scripts of its worker threads, need the headers
  if (e.request.mode !== 'navigate' && !['worker', 'sharedworker'].includes(e.request.destination)) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (!res.ok || res.status === 0) return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(() => fetch(e.request)));
});
