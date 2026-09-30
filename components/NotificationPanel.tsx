"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "loading" | "unsupported" | "idle" | "denied" | "active" | "error";

const PUSH_API =
  process.env.NEXT_PUBLIC_PUSH_API_URL?.replace(/\/$/, "") || "";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (!PUSH_API) throw new Error("Push API URL is not configured");
  const res = await fetch(`${PUSH_API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`API ${path} failed (${res.status})`);
  return res.json() as Promise<T>;
}

export default function NotificationPanel() {
  const [status, setStatus] = useState<Status>("loading");
  const [nextDue, setNextDue] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  const endpointRef = useRef<string | null>(null);

  const post = useCallback(async (type: string, extra?: Record<string, unknown>) => {
    const reg = regRef.current ?? (await navigator.serviceWorker.ready);
    (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type, ...extra });
  }, []);

  const syncFromServer = useCallback(async (endpoint: string) => {
    const data = await api<{ enabled: boolean; nextDue: number }>("/sync", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    });
    if (!data.enabled) {
      setStatus("idle");
      setNextDue(0);
      await post("stop");
      return false;
    }
    setNextDue(data.nextDue);
    setStatus("active");
    await post("set-state", { state: { enabled: true, nextDue: data.nextDue } });
    return true;
  }, [post]);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("Notification" in window) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (!PUSH_API) {
      setStatus("error");
      setError("Push server is not configured yet (NEXT_PUBLIC_PUSH_API_URL).");
      return;
    }

    let cancelled = false;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== "state") return;
      setNextDue(e.data.nextDue);
      setStatus(e.data.nextDue ? "active" : "idle");
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    (async () => {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      if (cancelled) return;
      regRef.current = reg;

      if (Notification.permission === "denied") return setStatus("denied");

      const existing = await reg.pushManager.getSubscription();
      if (Notification.permission === "granted" && existing) {
        endpointRef.current = existing.endpoint;
        try {
          const ok = await syncFromServer(existing.endpoint);
          if (!ok) setStatus("idle");
        } catch {
          const cache = await caches.open("hourly-state-v1");
          const res = await cache.match("/__hourly-state");
          const state = res ? await res.json() : null;
          if (state?.enabled && state.nextDue) {
            setNextDue(state.nextDue);
            setStatus("active");
          } else {
            setStatus("idle");
          }
        }
        return;
      }
      setStatus("idle");
    })();

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [syncFromServer]);

  useEffect(() => {
    if (status !== "active") return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [status]);

  // Re-sync schedule when returning to the app (survives SW death).
  useEffect(() => {
    if (status !== "active") return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && endpointRef.current) {
        syncFromServer(endpointRef.current).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [status, syncFromServer]);

  const enable = async () => {
    setError("");
    try {
      const result = await Notification.requestPermission();
      if (result !== "granted") return setStatus(result === "denied" ? "denied" : "idle");

      const reg = regRef.current ?? (await navigator.serviceWorker.ready);
      const { publicKey } = await api<{ publicKey: string }>("/vapid-public-key");

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      endpointRef.current = sub.endpoint;
      const data = await api<{ ok: boolean; nextDue: number }>("/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });

      setNextDue(data.nextDue);
      setStatus("active");
      await post("set-state", { state: { enabled: true, nextDue: data.nextDue } });
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not enable the bell.");
    }
  };

  const disable = async () => {
    setError("");
    try {
      const reg = regRef.current ?? (await navigator.serviceWorker.ready);
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api("/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } catch {
      /* still clear local state */
    }
    endpointRef.current = null;
    await post("stop");
    setStatus("idle");
    setNextDue(0);
  };

  const remaining = Math.max(0, nextDue - now);
  const mm = Math.floor(remaining / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  const countdown = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;

  return (
    <section className="panel" aria-live="polite">
      {status === "loading" && <p className="note">Consulting the register&hellip;</p>}

      {status === "unsupported" && (
        <p className="note">
          This browser does not support push notifications. Kindly try Chrome on
          Android, or install this page to your home screen.
        </p>
      )}

      {status === "denied" && (
        <p className="note">
          Notifications have been declined. To reverse this, open your
          browser&rsquo;s site settings and permit notifications for this page.
        </p>
      )}

      {status === "error" && (
        <>
          <p className="note">{error || "Something went amiss."}</p>
          <button className="btn" onClick={enable}>
            Try Again
          </button>
        </>
      )}

      {status === "idle" && (
        <>
          <button className="btn" onClick={enable}>
            Begin the Hourly Chime
          </button>
          <p className="note">Your browser will ask for permission to send notifications.</p>
        </>
      )}

      {status === "active" && (
        <>
          <p className="label">The Bell Is Tolling</p>
          <p className="countdown" aria-label="Time until next chime">{countdown}</p>
          <p className="note">until the next chime</p>
          <div className="actions">
            <button className="btn secondary" onClick={() => post("test")}>
              Sound a Trial Chime
            </button>
            <button className="btn secondary" onClick={disable}>
              Silence the Bell
            </button>
          </div>
          <p className="note small">
            Chimes are sent by a small cloud bell even when this page is closed.
            For best results on Android, use &ldquo;Add to Home screen.&rdquo;
          </p>
        </>
      )}
    </section>
  );
}
