// firebase-messaging-sw.js — MUST live at the root of your site
// This file handles both background push notifications AND PWA offline caching.
//
// IMPORTANT: Copy your Firebase config values here (same as firebase-config.js).

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBQ9Trao2B-ZTX6Sz2J1kPEndLZ9gUj3S0",
  authDomain: "where-we-booling.firebaseapp.com",
  projectId: "where-we-booling",
  storageBucket: "where-we-booling.firebasestorage.app",
  messagingSenderId: "38000700009",
  appId: "1:38000700009:web:df2d92f67eab423607d0f8",
  
});

const messaging = firebase.messaging();

// ── Background push notifications ────────────────────────────────────────────
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification ?? {};
  self.registration.showNotification(title ?? 'Where We Booling? 🎉', {
    body:    body ?? '',
    icon:    '/icon.svg',
    badge:   '/icon.svg',
    vibrate: [200, 100, 200],
    data:    { url: self.location.origin },
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url ?? self.location.origin;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ── PWA offline cache ─────────────────────────────────────────────────────────
const CACHE   = 'booling-v1';
const PRECACHE = ['/', '/index.html', '/styles.css', '/app.js', '/firebase-config.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Only cache same-origin GET requests; skip Firebase/gstatic API calls
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.hostname !== self.location.hostname) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    caches.match(event.request).then(cached => cached ?? fetch(event.request))
  );
});
