import { useMemo } from "react";
import { toTimeline, type AuditEvent } from "../lib/billTimeline";

/**
 * What the counter did, newest first — in plain sentences only.
 *
 * There used to be a "Raw log" toggle here that rendered the audit feed
 * verbatim: method, endpoint, duration, and the full params/response JSON
 * of every call (/api/viewed-products, /api/product-details, checkout
 * bodies, and so on). It was useful while building, but it put internal API
 * shapes and payloads on screen for anyone looking at the page — over a
 * shoulder, in a screen share, in a demo recording — so it's gone. The
 * shopper-facing reading of the same feed is what remains.
 *
 * Reads the one audit poller in useAuditFeed, same as before.
 */
export function ActivityLog({ events }: { events: AuditEvent[] }) {
  const entries = useMemo(() => toTimeline(events).slice().reverse(), [events]);

  return (
    <section className="panel" aria-label="Activity">
      <div className="panel-head">
        <h2 className="panel-title">Activity</h2>
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          <p className="empty-lead">Nothing has happened yet</p>
          <p>Every search, add, cap and payment shows up here as it happens.</p>
        </div>
      ) : (
        <ul className="log-list">
          {entries.map((e) => (
            <li key={e.id} className={`log-row is-${e.tone}`}>
              <span className="log-dot" aria-hidden />
              <span className="log-text">{e.text}</span>
              <span className="log-time">
                {new Date(e.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
