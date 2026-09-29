"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "loading" | "unsupported" | "idle" | "denied" | "active";

export default function NotificationPanel() {
  const [status, setStatus] = useState<Status>("loading");
  const [nextDue, setNextDue] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const regRef = useRef<ServiceWorkerRegistration | null>(null);

  const post = useCallback(async (type: string) => {
    const reg = regRef.current ?? (await navigator.serviceWorker.ready);
    (reg.active ?? navigator.serviceWorker.controller)?.postMessage({ type });
  }, []);

  // Register the worker and restore prior state.
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("Notification" in window)) {
      setStatus("unsupported");
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
      if (Notification.permission === "granted") {
        const cache = await caches.open("hourly-state-v1");
        const res = await cache.match("/__hourly-state");
        const state = res ? await res.json() : null;
        if (state?.enabled) {
          setNextDue(state.nextDue);
          setStatus("active");
          post("ping");
          return;
        }
      }
      setStatus("idle");
    })();

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, [post]);

  // Heartbeat keeps the worker's timer honest while the page is open.
  useEffect(() => {
    if (status !== "active") return;
    const heartbeat = setInterval(() => post("ping"), 15_000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(heartbeat);
      clearInterval(clock);
    };
  }, [status, post]);

  // Best-effort background wake-ups (installed Android PWA only).
  const registerPeriodicSync = async () => {
    try {
      const reg = regRef.current as unknown as {
        periodicSync?: { register: (tag: string, opts: { minInterval: number }) => Promise<void> };
      };
      await reg?.periodicSync?.register("hourly-bell", { minInterval: 3600 * 1000 });
    } catch {
      /* unsupported or not permitted; the in-worker timer still runs */
    }
  };

  const enable = async () => {
    const result = await Notification.requestPermission();
    if (result !== "granted") return setStatus(result === "denied" ? "denied" : "idle");
    await post("start");
    await registerPeriodicSync();
    setStatus("active");
  };

  const disable = async () => {
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
          This browser does not support notifications. Kindly try Chrome on
          Android, or install this page to your home screen.
        </p>
      )}

      {status === "denied" && (
        <p className="note">
          Notifications have been declined. To reverse this, open your
          browser&rsquo;s site settings and permit notifications for this page.
        </p>
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
            For the most reliable delivery on Android, use &ldquo;Add to Home
            screen&rdquo; and leave the page installed.
          </p>
        </>
      )}
    </section>
  );
}
