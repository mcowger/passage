const CACHE_NAME = "passage-shell-v1";
const STATIC_SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // NEVER cache API requests, WebSockets, or daemon endpoints
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws") || event.request.method !== "GET") {
    return;
  }

  // Network-first with cache fallback for shell navigation, stale-while-revalidate for static assets
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const shell = await caches.match("/index.html");
          if (shell) return shell;
        }
        return new Response("Offline - Passage daemon is unavailable", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Web Push: every push must surface a visible notification (Apple enforces
// userVisibleOnly). Payload is { title, body, tag, url, workspaceId, agentId }.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === "string" && data.title ? data.title.slice(0, 128) : "Passage";
  const body = typeof data.body === "string" && data.body ? data.body.slice(0, 512) : "Something needs your attention.";
  const tag = typeof data.tag === "string" ? data.tag : "passage-push";
  const url = typeof data.url === "string" ? data.url : "/?source=push";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      data: { url, workspaceId: data.workspaceId, agentId: data.agentId },
      icon: "/icon.svg",
      badge: "/icon.svg",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/?source=push";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = new URL(url, self.location.origin).href;
      for (const client of windows) {
        // Focus an existing tab on the same origin and navigate it to the agent.
        if ("navigate" in client && "focus" in client) {
          try {
            await client.navigate(target);
            return client.focus();
          } catch {
            // Fall through to opening a new window.
          }
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return undefined;
    })()
  );
});
