import NotificationPanel from "@/components/NotificationPanel";

export default function Home() {
  return (
    <main className="page">
      <article className="folio">
        <p className="eyebrow">Est. MMXXVI &middot; A Society for Punctuality</p>
        <h1>The Hourly Bell</h1>
        <div className="rule" aria-hidden="true">
          <span>&#10086;</span>
        </div>
        <p className="lede">
          A modest instrument that rings once each hour, that the scholar may
          be reminded to rise, stretch, and consider the passing of time.
        </p>
        <NotificationPanel />
        <footer className="colophon">
          Hourly chimes are delivered by Web Push from a small Cloudflare
          Worker. Only your browser&rsquo;s push subscription is stored — no
          account, no personal profile.
        </footer>
      </article>
    </main>
  );
}
