import { useCallback, useEffect, useRef, useState } from "react";
import { toTimeline, type AuditEvent, type TimelineEntry } from "../lib/billTimeline";
import { AuditTrail } from "./AuditTrail";

export function BillTimeline({
  sessionId,
  onEvent,
}: {
  sessionId: string;
  onEvent?: (event: AuditEvent) => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const lastSeenRef = useRef<Set<string>>(new Set());
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/audit?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { "x-session-id": sessionId },
      });
      if (res.status !== 200) {
        setEntries([]);
        return;
      }
      const data: any = await res.json();
      const incoming: AuditEvent[] = data.data?.events ?? data.events ?? [];

      // Surface new events to the parent (e.g. to trigger the Razorpay modal)
      // regardless of which view is showing — the raw AuditTrail view below
      // does its own separate polling/notification when active, so skip
      // double-notifying while it's mounted.
      if (!showRaw && onEventRef.current) {
        for (const e of incoming) {
          if (!lastSeenRef.current.has(e.id)) {
            lastSeenRef.current.add(e.id);
            onEventRef.current(e);
          }
        }
      }
      setEntries(toTimeline(incoming).reverse()); // newest first
    } catch {
      // transient poll failure — keep previous state
    }
  }, [sessionId, showRaw]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toggle = (
    <button
      type="button"
      className="bill-toggle"
      onClick={() => setShowRaw((v) => !v)}
      aria-pressed={showRaw}
    >
      {showRaw ? "Show friendly view" : "Show technical audit"}
    </button>
  );

  if (showRaw) {
    return (
      <div className="bill-timeline bill-timeline-raw">
        {toggle}
        <AuditTrail sessionId={sessionId} onEvent={onEvent} />
      </div>
    );
  }

  return (
    <div className="bill-timeline">
      <div className="bill-timeline-head">
        <h2>Bill Timeline</h2>
        {toggle}
      </div>
      {entries.length === 0 ? (
        <p className="bill-timeline-empty">Nothing on the tape yet.</p>
      ) : (
        <ul className="bill-timeline-list">
          {entries.map((e) => (
            <li key={e.id} className={`bill-entry bill-${e.tone}`}>
              <span className="bill-entry-text">{e.text}</span>
              <span className="bill-entry-time">
                {new Date(e.ts).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
