// Service worker for the Daily Tracker: lets check-in notifications have tap-able buttons.
// Put this file next to index.html in your repository.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let client = all.find(c => c.url.startsWith(self.registration.scope)) || all[0];
    if (client) await client.focus();
    else client = await self.clients.openWindow(self.registration.scope);
    if (client) client.postMessage({ type: 'nudge-action', action: e.action || '' });
  })());
});
