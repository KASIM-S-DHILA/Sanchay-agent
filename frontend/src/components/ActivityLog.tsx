import { useMemo, useState } from "react";
import { toTimeline, type AuditEvent } from "../lib/billTimeline";

/**
 * What the counter did, newest first.
 *
 * Two readings of the same feed: shoppers get plain sentences, and anyone who
 * wants proof can flip to the raw call log. Both come from the one audit
 * poller in useAuditFeed, so they can never disagree.
 */
export function ActivityLog({ events }: { events: AuditEvent[] }) {
  const [raw, setRaw] = useState(false);

  const entries = useMemo(() => toTimeline(events).slice().reverse(), [events]);
  const rawEvents = useMemo(() => events.slice().reverse(), [events]);

  return (
    <section className="panel" aria-label="Activity">
      <div className="panel-head">
        <h2 className="panel-title">{raw ? "Call log" : "Activity"}</h2>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => setRaw((v) => !v)}
          aria-pressed={raw}
        >
          {raw ? "Plain view" : "Raw log"}
        </button>
      </div>

      {raw ? (
        rawEvents.length === 0 ? (
          <div className="empty">
            <p>No calls yet on this counter.</p>
          </div>
        ) : (
          <ul className="raw-list">
            {rawEvents.map((e) => (
              <li key={e.id} className={`raw-row is-${e.status}`}>
                <div className="raw-head">
                  <span className={`raw-badge is-${e.status}`}>{e.status}</span>
                  <span className="raw-ep">
                    {e.method} {e.endpoint}
                  </span>
                  {typeof e.duration_ms === "number" && <span className="raw-ms">{e.duration_ms}ms</span>}
                </div>
                {(e.params || e.response) && (
                  <details>
                    <summary>params and response</summary>
                    {e.params && <pre className="raw-pre">{JSON.stringify(e.params, null, 2)}</pre>}
                    {e.response && <pre className="raw-pre">{JSON.stringify(e.response, null, 2)}</pre>}
                  </details>
                )}
              </li>
            ))}
          </ul>
        )
      ) : entries.length === 0 ? (
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
