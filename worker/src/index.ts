import { buildPushPayload } from "@block65/webcrypto-web-push";
import type { PushSubscription as WebPushSubscription } from "@block65/webcrypto-web-push";

export interface Env {
  SUBSCRIPTIONS: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  ALLOWED_ORIGIN: string;
}

const HOUR_MS = 3600 * 1000;

type StoredSub = {
  subscription: WebPushSubscription;
  nextDue: number;
  enabled: boolean;
};

function corsHeaders(origin: string, allowed: string): HeadersInit {
  const ok = !origin || origin === allowed || allowed === "*";
  return {
    "Access-Control-Allow-Origin": ok ? origin || allowed : allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data: unknown, init: ResponseInit = {}, cors: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...cors,
      ...(init.headers || {}),
    },
  });
}

async function subId(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(endpoint)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function advanceNextDue(from: number, now: number): number {
  let next = from > 0 ? from : now + HOUR_MS;
  while (next <= now) next += HOUR_MS;
  return next;
}

function isPushSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== "object") return false;
  const s = value as WebPushSubscription;
  return (
    typeof s.endpoint === "string" &&
    !!s.keys &&
    typeof s.keys.auth === "string" &&
    typeof s.keys.p256dh === "string"
  );
}

async function sendPush(env: Env, record: StoredSub): Promise<"ok" | "gone" | "error"> {
  try {
    const payload = await buildPushPayload(
      {
        data: {
          title: "The Hour Has Struck",
          nextDue: record.nextDue,
        },
        options: { ttl: 60 * 60, urgency: "high" },
      },
      record.subscription,
      {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      }
    );

    const res = await fetch(record.subscription.endpoint, payload);
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) {
      console.error("push failed", res.status, await res.text());
      return "error";
    }
    return "ok";
  } catch (err) {
    console.error("push exception", err);
    return "error";
  }
}

async function deliverDue(env: Env): Promise<{ sent: number; removed: number }> {
  const now = Date.now();
  let sent = 0;
  let removed = 0;
  let cursor: string | undefined;

  do {
    const page = await env.SUBSCRIPTIONS.list({ cursor, limit: 1000 });
    cursor = page.list_complete ? undefined : page.cursor;

    for (const key of page.keys) {
      const record = await env.SUBSCRIPTIONS.get<StoredSub>(key.name, "json");
      if (!record?.enabled || !record.subscription) continue;
      if (record.nextDue > now) continue;

      record.nextDue = advanceNextDue(record.nextDue || now, now);
      const result = await sendPush(env, record);

      if (result === "gone") {
        await env.SUBSCRIPTIONS.delete(key.name);
        removed += 1;
        continue;
      }

      await env.SUBSCRIPTIONS.put(key.name, JSON.stringify(record));
      if (result === "ok") sent += 1;
    }
  } while (cursor);

  return { sent, removed };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/vapid-public-key") {
      return json({ publicKey: env.VAPID_PUBLIC_KEY }, {}, cors);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true }, {}, cors);
    }

    if (request.method === "POST" && url.pathname === "/subscribe") {
      let body: { subscription?: unknown };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, { status: 400 }, cors);
      }
      if (!isPushSubscription(body.subscription)) {
        return json({ error: "invalid subscription" }, { status: 400 }, cors);
      }

      const id = await subId(body.subscription.endpoint);
      const existing = await env.SUBSCRIPTIONS.get<StoredSub>(id, "json");
      const now = Date.now();

      // Keep an existing future schedule; otherwise start one hour from now.
      const nextDue =
        existing?.enabled && existing.nextDue > now
          ? existing.nextDue
          : now + HOUR_MS;

      const record: StoredSub = {
        subscription: body.subscription,
        nextDue,
        enabled: true,
      };
      await env.SUBSCRIPTIONS.put(id, JSON.stringify(record));
      return json({ ok: true, nextDue: record.nextDue }, {}, cors);
    }

    if (request.method === "POST" && url.pathname === "/unsubscribe") {
      let body: { endpoint?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, { status: 400 }, cors);
      }
      if (!body.endpoint) {
        return json({ error: "endpoint required" }, { status: 400 }, cors);
      }
      await env.SUBSCRIPTIONS.delete(await subId(body.endpoint));
      return json({ ok: true }, {}, cors);
    }

    if (request.method === "POST" && url.pathname === "/sync") {
      let body: { endpoint?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, { status: 400 }, cors);
      }
      if (!body.endpoint) {
        return json({ error: "endpoint required" }, { status: 400 }, cors);
      }
      const record = await env.SUBSCRIPTIONS.get<StoredSub>(
        await subId(body.endpoint),
        "json"
      );
      if (!record?.enabled) {
        return json({ enabled: false, nextDue: 0 }, {}, cors);
      }
      return json({ enabled: true, nextDue: record.nextDue }, {}, cors);
    }

    // Manual trigger for testing (same logic as cron).
    if (request.method === "POST" && url.pathname === "/run-due") {
      const result = await deliverDue(env);
      return json(result, {}, cors);
    }

    return json({ error: "not found" }, { status: 404 }, cors);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(deliverDue(env).then((r) => console.log("cron", r)));
  },
};
