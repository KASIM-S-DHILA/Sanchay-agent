import { useCallback, useEffect, useState } from "react";

interface AuditEvent {
  source?: "do" | "d1";
  id?: string | number;
  ts?: number;
  action: string;
  status: string;
  reason?: string;
  detail?: string;
  actor?: string;
  sku?: string;
  order_id?: string;
  payment_id?: string;
  amount_paise?: number;
  bound_paise?: number;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

export function AuditTrail({ sessionId }: { sessionId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/audit?sid=${encodeURIComponent(sessionId)}`);
      if (res.status === 200) {
        const data: { events?: AuditEvent[] } = await res.json();
        setEvents(data.events ?? []);
      } else {
        setEvents([]);
      }
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setLoading(true);
    refresh();
    // Auto-refresh every 3 seconds
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [sessionId, refresh]);

  return (
    <div className="audit-trail">
      <h2>Audit Trail</h2>
      {loading ? (
        <p>Loading…</p>
      ) : events.length === 0 ? (
        <p>No audited events yet for this session.</p>
      ) : (
        <ul>
          {events.map((e, i) => (
            <li key={`${e.source}-${e.id ?? i}`}>
              <span className={`badge badge-${e.source ?? "do"}`}>{e.source?.toUpperCase() ?? "DO"}</span>{" "}
              <strong>{e.action}</strong> — {e.status}
              {typeof e.amount_paise === "number" && <> · {rupees(e.amount_paise)}</>}
              {typeof e.bound_paise === "number" && <> · Budget: {rupees(e.bound_paise)}</>}
              {e.sku && <> · {e.sku}</>}
              {e.order_id && <> · order {e.order_id.slice(0, 18)}</>}
              {e.reason && <div className="audit-reason">{e.reason}{e.detail ? ` — ${e.detail}` : ""}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
