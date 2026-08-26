import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { validateSession } from "../middleware/session";

export async function handleAudit(request: Request, env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");

  return withApiLogging(
    env,
    { sessionId, endpoint: "/api/audit", method: "GET", params: { session_id: sessionId } },
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
      const rows: any[] = (
        await env.DB.prepare(
          "SELECT id, endpoint, method, params_json, response_json, status, duration_ms, created_at FROM api_call_log WHERE session_id = ? ORDER BY created_at ASC",
        )
          .bind(sessionId)
          .all()
      ).results ?? [];

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

