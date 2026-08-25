import { useCallback, useEffect, useState } from "react";

interface AuditEvent {
  id?: number;
  ts?: number;
  action: string;
  status: string;
  reason?: string;
}

// ponytail: /audit returns not_implemented until Phase 9 — renders empty gracefully
export function AuditTrail() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/audit");
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
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="audit-trail">
      <h2>Audit Trail</h2>
      {loading ? (
        <p>Loading…</p>
      ) : events.length === 0 ? (
        <p>Audit trail coming in Phase 9</p>
      ) : (
        <ul>
          {events.map((e, i) => (
            <li key={i}>
              {e.action} — {e.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
