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
          Notifications are delivered by a service worker in your own browser.
          No account is kept; no record is made.
        </footer>
      </article>
    </main>
  );
}
