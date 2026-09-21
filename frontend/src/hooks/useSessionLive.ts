import { useEffect, useRef } from "react";

/**
 * Opens a WebSocket to this session's SessionHub Durable Object (see
 * src/durable/SessionHub.ts, /api/live in src/index.ts) exactly when
 * `active` is true — the SAME condition App.tsx already computes as
 * `pollingActive` (a voice call is live AND the tab is visible). Calls
 * `onChanged()` the instant the DO reports "something changed", so the
 * caller can re-fetch immediately instead of waiting for its next timer
 * tick.
 *
 * Deliberately does NOT replace polling — it's a fast path layered on
 * top. If the socket fails to open, drops, or the browser doesn't support
 * it for some reason, `connected` stays false and the caller's own
 * existing timer-based polling (still running independently) is exactly
 * today's behavior, not a broken one. This hook never being able to
 * connect at all should degrade to "exactly as before push existed", not
 * to "silently stops updating".
 *
 * One connection per session, shared by both the cart effect and
 * useAuditFeed via the single `onChanged` callback App.tsx passes in —
 * not two separate sockets for two separate consumers of the same signal.
 */
export function useSessionLive(sessionId: string | null, active: boolean, onChanged: () => void) {
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!sessionId || !active) return;

    let cancelled = false;
    // wss:// in production (the site is served over https), ws:// only
    // for local http dev — matching the page's own protocol rather than
    // hardcoding one, since a hardcoded wss:// would fail against
    // `wrangler dev`'s plain http.
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/live?session_id=${encodeURIComponent(sessionId)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // New WebSocket() throwing synchronously (malformed URL, browser
      // policy) — nothing to clean up, caller's own polling carries on.
      return;
    }
    wsRef.current = ws;

    ws.addEventListener("message", () => {
      if (cancelled) return;
      onChangedRef.current();
    });
    // No onerror handling beyond letting it close — a socket that fails
    // to connect fires close on its own; there is deliberately no retry
    // loop here, since the polling this sits alongside already covers
    // "push isn't working right now" with no special-casing needed.

    return () => {
      cancelled = true;
      wsRef.current = null;
      try {
        ws.close();
      } catch {
        // Already closed/closing.
      }
    };
    // Only session id and `active` matter for whether a connection should
    // exist at all — onChanged is read through the ref above so a new
    // function identity on every render (the common case for an inline
    // callback) never tears down and reopens the socket unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, active]);
}
