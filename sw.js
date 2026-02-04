const CACHE_NAME = 'cleanup-v2';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  // Only serve the APP SHELL from cache. 
  // Never cache the SCRIPT_URL (Google Data) so we always get fresh data.
  if (e.request.url.includes('google.com') || e.request.url.includes('exec')) {
      return fetch(e.request);
  }
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});