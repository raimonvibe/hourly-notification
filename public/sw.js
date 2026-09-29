/* Hourly Bell — service worker.
 * Fires one notification every HOUR_MS. State lives in the Cache API so it
 * survives the browser stopping and restarting this worker. */

const HOUR_MS = 3600 * 1000;
const STATE_URL = "/__hourly-state";
const STATE_CACHE = "hourly-state-v1";

let timer = null;

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

async function notify() {
  const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  await self.registration.showNotification("The Hour Has Struck", {
    body: `It is now ${time}. Take a moment to look up from your work.`,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: "hourly-bell",
    renotify: true,
    data: { url: "/" },
  });
}

/* Fire if due, then arm the next timeout. Safe to call at any wake-up. */
async function tick() {
  clearTimeout(timer);
  const state = await readState();
  if (!state.enabled) return;

  const now = Date.now();
  if (now >= state.nextDue) {
    await notify();
    state.nextDue = now + HOUR_MS;
    await writeState(state);
  }
  announce(state.nextDue);
  timer = setTimeout(tick, Math.max(1000, state.nextDue - Date.now()));
}

async function start() {
  const state = await readState();
  if (!state.enabled) {
    await writeState({ enabled: true, nextDue: Date.now() + HOUR_MS });
  }
  await tick();
}

async function stop() {
  clearTimeout(timer);
  await writeState({ enabled: false, nextDue: 0 });
  announce(0);
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim().then(tick)));

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "start") event.waitUntil(start());
  else if (type === "stop") event.waitUntil(stop());
  else if (type === "ping") event.waitUntil(tick()); // heartbeat from an open page
  else if (type === "test") event.waitUntil(notify());
});

// Chrome on Android may wake the worker for installed PWAs.
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "hourly-bell") event.waitUntil(tick());
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
