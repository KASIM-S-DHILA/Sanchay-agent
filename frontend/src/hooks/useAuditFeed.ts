import { useCallback, useEffect, useState } from "react";
import type { AuditEvent } from "../lib/billTimeline";

/**
 * One poller for the session's audit log, shared by everything that needs it:
 * the friendly activity list, the raw machine view, the shelf (which follows
 * the agent's own catalog lookups) and the payment trigger.
 *
 * Previously the friendly view and the raw view each polled independently and
 * had to coordinate so the parent wasn't notified twice about the same event.
 * A single feed removes that class of bug entirely.
 *
 * Events are returned in chronological order — oldest first — which is how
 * the API sends them. Views reverse for display; logic that cares about
 * "what happened next" reads them forwards.
 */
export function useAuditFeed(sessionId: string | null, intervalMs = 3000) {
  const [events, setEvents] = useState<AuditEvent[]>([]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/audit?session_id=${encodeURIComponent(sessionId)}`, {
        headers: { "x-session-id": sessionId },
      });
      if (res.status !== 200) return;
      const data: any = await res.json();
      const incoming: AuditEvent[] = data.data?.events ?? data.events ?? [];
      setEvents(incoming);
    } catch {
      // Transient poll failure — keep the previous list rather than blanking
      // a log the shopper may be reading.
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      return;
    }
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [sessionId, refresh, intervalMs]);

  return { events, refresh };
}
