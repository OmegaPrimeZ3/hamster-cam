// app/web/public/sw-push.js
//
// Web Push event handlers imported by the main service worker via importScripts.
// Keep this file small — no build step, plain JS that runs in the SW context.
//
// push          → parse payload JSON, show a notification.
// notificationclick → close notification + focus/open the target URL.

self.addEventListener('push', function (event) {
  var payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    // Non-JSON payload — use whatever text is there.
    payload = {
      title: 'Hamster Cam',
      body: event.data ? event.data.text() : 'Something happened!',
    };
  }

  var title = payload.title || 'Hamster Cam';
  var options = {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || undefined,
    data: { url: payload.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var targetUrl =
    (event.notification.data && event.notification.data.url)
      ? event.notification.data.url
      : '/';

  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(targetUrl);
      }),
  );
});
