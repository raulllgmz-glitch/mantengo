'use strict';
// Deja abrir la liga del técnico sin internet (después de haberla abierto una vez con conexión).
const SHELL = 'mg-shell-v1';
const IMGS = 'mg-img-v1';
const FILES = ['/t.html', '/assets/logo.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, IMGS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Página del técnico: primero red (siempre la versión nueva); sin red, la guardada.
  if (url.origin === location.origin && url.pathname.startsWith('/t/')) {
    e.respondWith(
      fetch(req).then((r) => {
        if (r.ok) caches.open(SHELL).then((c) => c.put('/t.html', r.clone()));
        return r;
      }).catch(() => caches.match('/t.html'))
    );
    return;
  }
  if (url.origin === location.origin && url.pathname === '/assets/logo.png') {
    e.respondWith(caches.match(req).then((m) => m || fetch(req)));
    return;
  }
  // Fachada guardada (la liga de Airtable caduca, pero la copia local no).
  if (req.destination === 'image' && url.origin !== location.origin) {
    e.respondWith(caches.open(IMGS).then((c) => c.match(req.url).then((m) => m || fetch(req))));
  }
});
