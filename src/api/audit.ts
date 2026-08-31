import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { validateSession } from "../middleware/session";

export async function handleAudit(request: Request, env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");
  // Optional incremental cursor — see useAuditFeed.ts. When present, only
  // rows strictly newer than this timestamp are returned, which is what
  // every poll AFTER the first one actually needs: the frontend already
  // holds every event it's seen and only cares about what's new since
  // then. Without this, a long-lived session polling every 3 seconds
  // re-fetched and re-JSON-parsed up to AUDIT_ROW_LIMIT full rows on EVERY
  // single tick regardless of whether anything had actually happened —
  // measured at ~900ms average, spiking past a second, for a session that
  // had accumulated a few thousand rows over one long testing session.
  // Omit it (or pass an invalid value) to get the normal "most recent
  // batch" behavior — used for the very first load of a session, when
  // there's nothing to compare against yet.
  const sinceParam = url.searchParams.get("since");
  const sinceMs = sinceParam ? Number(sinceParam) : NaN;
  const hasSince = Number.isFinite(sinceMs) && sinceMs > 0;

  return withApiLogging(
    env,
    { sessionId, endpoint: "/api/audit", method: "GET", params: { session_id: sessionId, since: hasSince ? sinceMs : null } },
    async (): Promise<ApiResult> => {
      if (!sessionId) {
        return json({ success: false, error: "Missing session_id parameter" }, 400);
      }

      // Every other commerce endpoint gates access with a validated
      // x-session-id header — the audit trail is per-session data and must
      // follow the same rule, not just accept whatever session_id string
      // is on the query string. The caller must present the SAME session
      // it's asking to read the audit trail for; there is no cross-session
      // audit read, by design.
      const caller = await validateSession(env, request);
      if (!caller || caller.id !== sessionId) {
        return json({ success: false, error: "Invalid or expired session" }, 401);
      }

      // Webhook rows are attributed to the session at write time, so one
      // query covers API calls + payment events.
      //
      // Capped to the most recent AUDIT_ROW_LIMIT rows even on the
      // no-cursor path — a real production bug: this had no limit at all
      // before, and a single long-lived session accumulated ~4,000 rows,
      // at which point every poll (parsing every row's
      // params_json/response_json twice per row in JS) started exceeding
      // the Worker's CPU time limit outright, taking other requests down
      // with it under the same overloaded isolate. Nothing legitimate
      // needs a session's entire lifetime history in one response.
      const AUDIT_ROW_LIMIT = 60;
      const rows: any[] = hasSince
        ? // Incremental path — bounded by "since", not by row count, since a
        // genuinely quiet 3-second gap returns 0-3 rows regardless of how
        // large the session's total history has grown.
        (
          await env.DB.prepare(
            "SELECT id, endpoint, method, params_json, response_json, status, duration_ms, created_at FROM api_call_log WHERE session_id = ? AND created_at > ? ORDER BY created_at ASC",
          )
            .bind(sessionId, new Date(sinceMs).toISOString())
            .all()
        ).results ?? []
        : (
          (
            await env.DB.prepare(
              "SELECT id, endpoint, method, params_json, response_json, status, duration_ms, created_at FROM api_call_log WHERE session_id = ? ORDER BY created_at DESC LIMIT ?",
            )
              .bind(sessionId, AUDIT_ROW_LIMIT)
              .all()
          ).results ?? []
        ).reverse(); // DESC for the LIMIT to keep the MOST RECENT rows; reversed back to chronological (ASC) for display

      const events = rows.map((r) => ({
        id: r.id as string,
        ts: new Date(r.created_at as string).getTime(),
        endpoint: r.endpoint as string,
        method: r.method as string,
        params: safeParse(r.params_json),
        response: safeParse(r.response_json),
        status: r.status as string,
        duration_ms: r.duration_ms as number,
      }));

      return json({ success: true, data: { events, sessionId } });
    },
  );
}

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

