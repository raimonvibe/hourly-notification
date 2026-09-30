/* Hourly Bell — service worker.
 * Hourly chimes are delivered by Web Push from the Cloudflare Worker.
 * Local Cache state only drives the on-screen countdown. */

const STATE_URL = "/__hourly-state";
const STATE_CACHE = "hourly-state-v1";

async function readState() {
  const cache = await caches.open(STATE_CACHE);
  const res = await cache.match(STATE_URL);
  return res ? res.json() : { enabled: false, nextDue: 0 };
}

async function writeState(state) {
  const cache = await caches.open(STATE_CACHE);
  await cache.put(STATE_URL, new Response(JSON.stringify(state)));
}

function announce(nextDue) {
  return self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    clients.forEach((c) => c.postMessage({ type: "state", nextDue }));
  });
}

async function notify(bodyText) {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  await self.registration.showNotification("The Hour Has Struck", {
    body: bodyText || `It is now ${time}. Take a moment to look up from your work.`,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "hourly-bell",
    renotify: true,
    data: { url: "/" },
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let nextDue = Date.now() + 3600 * 1000;
      try {
        const data = event.data ? event.data.json() : {};
        if (typeof data.nextDue === "number") nextDue = data.nextDue;
      } catch {
        /* empty or non-json payload */
      }
      await writeState({ enabled: true, nextDue });
      await notify();
      announce(nextDue);
    })()
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "set-state") {
    event.waitUntil(
      writeState(event.data.state).then(() => announce(event.data.state.nextDue))
    );
  } else if (type === "stop") {
    event.waitUntil(
      writeState({ enabled: false, nextDue: 0 }).then(() => announce(0))
    );
  } else if (type === "get-state") {
    event.waitUntil(readState().then((s) => announce(s.enabled ? s.nextDue : 0)));
  } else if (type === "test") {
    event.waitUntil(notify("A trial chime — the real bell still arrives hourly."));
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    })
  );
});
