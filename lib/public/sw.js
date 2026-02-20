var CACHE_NAME = "braigi-v1";
var CACHEABLE = /\.(css|js|woff2?|ttf|png|jpg|jpeg|gif|webp|svg|ico)$/;

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  // Clean up old caches
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_NAME; })
          .map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Cache-first for static assets, network-first for everything else
self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);

  // Only cache same-origin GET requests for static assets
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (!CACHEABLE.test(url.pathname)) return;

  // Skip API and WebSocket paths
  if (url.pathname.indexOf("/api/") !== -1) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(event.request).then(function (cached) {
        var fetched = fetch(event.request).then(function (response) {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        }).catch(function () {
          return cached || new Response("", { status: 503, statusText: "Offline" });
        });
        return cached || fetched;
      });
    })
  );
});

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data.json(); } catch (e) { return; }

  var options = {
    body: data.body || "",
    tag: data.tag || "braigi",
    data: data,
  };

  if (data.type === "permission_request") {
    options.requireInteraction = true;
    options.tag = "perm-" + data.requestId;
  } else if (data.type === "done") {
    options.tag = data.tag || "claude-done";
  } else if (data.type === "ask_user") {
    options.requireInteraction = true;
    options.tag = "claude-ask";
  } else if (data.type === "error") {
    options.requireInteraction = true;
    options.tag = "claude-error";
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      // Skip notification if app is focused (user is already looking at it)
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].focused || clientList[i].visibilityState === "visible") return;
      }
      return self.registration.showNotification(data.title || "Braigi", options);
    }).catch(function () {})
  );
});

self.addEventListener("notificationclick", function (event) {
  var data = event.notification.data || {};
  event.notification.close();

  // Default click: focus existing window or open new one
  // Use the service worker's scope as the base URL for this project
  var scopeUrl = self.registration.scope || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].visibilityState !== "hidden") {
          return clientList[i].focus();
        }
      }
      if (clientList.length > 0) return clientList[0].focus();
      return self.clients.openWindow(scopeUrl);
    })
  );
});
