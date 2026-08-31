import { useCallback, useEffect, useRef, useState } from "react";
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
// Capped client-side too — mirrors the backend's own AUDIT_ROW_LIMIT, so a
// very long-lived tab's accumulated event list doesn't grow forever in
// memory/render cost even though incremental fetching keeps each individual
// poll cheap.
const MAX_EVENTS_HELD = 200;

export function useAuditFeed(sessionId: string | null, active = true, intervalMs = 3000) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  // True once the FIRST fetch for the current sessionId has resolved (success
  // or failure) — distinct from events.length === 0, which is also true for
  // a genuinely brand-new session with no history yet. Consumers (App.tsx's
  // "don't replay history as new" guard) need to tell those two apart: a
  // consumer that reacts the instant events go from [] to [] (the initial
  // render, before any real fetch has happened) would consume its one-time
  // "this is history, not new" pass on nothing, and then treat the actual
  // first real batch — the session's whole past — as brand new.
  const [loaded, setLoaded] = useState(false);
  // Timestamp (ms) of the newest event this hook has actually seen — once
  // set, every SUBSEQUT poll asks the backend for only events newer than
  // this (see the `since` param in api/audit.ts), instead of re-fetching
  // and re-parsing the same recent batch every 3 seconds regardless of
  // whether anything actually happened. Reset on session change, same as
  // `loaded` — a different session's history has nothing to do with this
  // cursor.
  const cursorRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const since = cursorRef.current;
      const url = since
        ? `/api/audit?session_id=${encodeURIComponent(sessionId)}&since=${since}`
        : `/api/audit?session_id=${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, { headers: { "x-session-id": sessionId } });
      if (res.status !== 200) return; // transient/401 — retried by the next interval tick, loaded stays whatever it was
      const data: any = await res.json();
      const incoming: AuditEvent[] = data.data?.events ?? data.events ?? [];

      if (since) {
        // Incremental — MERGE, don't replace. incoming is only what's new
        // since the cursor; the rest of the timeline the shopper may be
        // reading must not vanish just because this particular poll had
        // nothing new to add.
        if (incoming.length > 0) {
          setEvents((prev) => [...prev, ...incoming].slice(-MAX_EVENTS_HELD));
          cursorRef.current = Math.max(...incoming.map((e) => e.ts));
        }
      } else {
        // First load for this session (or a cursor-less refresh) — this IS
        // the full recent batch, so replace outright.
        setEvents(incoming);
        if (incoming.length > 0) cursorRef.current = Math.max(...incoming.map((e) => e.ts));
      }
      // Only a GENUINELY successful fetch counts as "loaded" — this used
      // to be in a `finally` block, which ran even when the fetch above
      // failed or returned non-200, meaning a single transient failure
      // (session validation still settling, a network blip) could flip
      // `loaded` true while `events` was still []. App.tsx's "treat the
      // first real batch as history, not new" guard reads `loaded` to
      // decide when it's safe to start reacting to events — if that flag
      // went true on an EMPTY failed attempt, the guard consumed itself on
      // nothing, and the very next successful poll (which returns this
      // session's ENTIRE real history, always) got treated as all brand
      // new — including an old, already-resolved checkout event, which is
      // exactly what reopened the Razorpay modal for a stale/expired order
      // on some refreshes but not others, intermittently, depending purely
      // on whether that first poll happened to succeed or fail.
      setLoaded(true);
    } catch {
      // Transient poll failure — keep the previous list rather than blanking
      // a log the shopper may be reading, and do NOT flip loaded here (see
      // above) — an unloaded state just means the next interval tick tries
      // again, which is what should happen on a real failure.
    }
  }, [sessionId]);

  // Reset on session change only — independent of `active` so that
  // switching sessions always gets a fresh "history vs new" boundary
  // regardless of whether polling happens to be paused (tab hidden / no
  // call live) at that exact moment.
  useEffect(() => {
    if (!sessionId) {
      setEvents([]);
      setLoaded(false);
      cursorRef.current = null;
      return;
    }
    setLoaded(false); // a session switch needs its own fresh "history vs new" boundary
    cursorRef.current = null; // a different session's history has nothing to do with this cursor
  }, [sessionId]);

  // The actual polling — gated on `active` (caller decides what that means;
  // App.tsx passes "a voice call is live AND the tab is visible"). This is
  // the fix for a real production incident: a tab left open with no call
  // running polled this endpoint every 3s indefinitely, which is how one
  // long-lived session accumulated thousands of audit rows and eventually
  // tripped the Worker's CPU limit. There is nothing for this feed to
  // usefully report when no call is live — nothing but the shopper's own
  // manual clicks (which already update state directly) can change
  // anything — so there's no reason to keep asking.
  //
  // Firing `refresh()` immediately whenever `active` flips true (not just
  // on session change) means resuming a call or refocusing the tab catches
  // up instantly instead of waiting up to `intervalMs` for the first poll.
  useEffect(() => {
    if (!sessionId || !active) return;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [sessionId, active, refresh, intervalMs]);

  return { events, refresh, loaded };
}
