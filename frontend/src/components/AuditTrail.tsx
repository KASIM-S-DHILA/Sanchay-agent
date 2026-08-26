import { useCallback, useEffect, useRef, useState } from "react";

interface AuditEvent {
  id: string;
  ts: number;
  endpoint: string;
  method: string;
  params?: Record<string, unknown> | null;
  response?: Record<string, unknown> | null;
  status: string; // ok | error | blocked
  duration_ms?: number;
}

export function AuditTrail({
  sessionId,
  onEvent,
}: {
  sessionId: string;
  onEvent?: (event: AuditEvent) => void;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const lastSeenRef = useRef<Set<string>>(new Set());
  // Keep callback in a ref so poll interval doesn't reset on every render
  // (inline onEvent props change identity each render → tight polling loop)
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/audit?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { "x-session-id": sessionId },
      });
      if (res.status !== 200) {
        setEvents([]);
        return;
      }
      const data: any = await res.json();
      const incoming: AuditEvent[] = data.data?.events ?? data.events ?? [];

      // Surface new events to the parent (e.g. to trigger the Razorpay modal)
      if (onEventRef.current) {
        for (const e of incoming) {
          if (!lastSeenRef.current.has(e.id)) {
            lastSeenRef.current.add(e.id);
            onEventRef.current(e);
          }
        }
      }
      setEvents(incoming.reverse()); // newest first
    } catch {
      // transient poll failure — keep previous state
    }
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="audit-trail">
      <h2>API Call Log</h2>
      {events.length === 0 ? (
        <p>No API calls yet for this session.</p>
      ) : (
        <ul>
          {events.map((e) => (
            <li key={e.id} className={`audit-entry audit-${e.status}`}>
              <div className="audit-head">
                <span className={`badge badge-${e.status}`}>{e.status.toUpperCase()}</span>{" "}
                <strong>
                  {e.method} {e.endpoint}
                </strong>
                {typeof e.duration_ms === "number" && (
                  <span className="audit-duration"> {e.duration_ms}ms</span>
                )}
              </div>
              {(e.params || e.response) && (
                <details>
                  <summary>details</summary>
                  {e.params && <pre>{JSON.stringify(e.params, null, 2)}</pre>}
                  {e.response && <pre>{JSON.stringify(e.response, null, 2)}</pre>}
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
