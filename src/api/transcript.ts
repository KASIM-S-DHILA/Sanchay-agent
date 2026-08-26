import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { validateSession } from "../middleware/session";

/**
 * Returns the saved voice transcript for a session — same session-gating
 * convention as /api/audit (caller must authenticate as the exact session
 * it's asking about; no cross-session read). Lets the frontend hydrate the
 * "Counter tape" panel with prior turns after a reload or reconnect,
 * instead of only ever showing the current in-memory 20-entry buffer.
 */
export async function handleGetTranscript(request: Request, env: Env, url: URL): Promise<Response> {
  const sessionId = url.searchParams.get("session_id");

  return withApiLogging(
    env,
    { sessionId, endpoint: "/api/voice/transcript", method: "GET", params: { session_id: sessionId } },
    async (): Promise<ApiResult> => {
      if (!sessionId) {
        return json({ success: false, error: "Missing session_id parameter" }, 400);
      }

      const caller = await validateSession(env, request);
      if (!caller || caller.id !== sessionId) {
        return json({ success: false, error: "Invalid or expired session" }, 401);
      }

      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS voice_transcripts (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
          text TEXT NOT NULL, created_at TEXT NOT NULL)`,
      ).run();

      const rows: any[] = (
        await env.DB.prepare(
          "SELECT id, role, text, created_at FROM voice_transcripts WHERE session_id = ? ORDER BY created_at ASC",
        )
          .bind(sessionId)
          .all()
      ).results ?? [];

      const turns = rows.map((r) => ({
        id: r.id as string,
        role: r.role as "user" | "agent",
        text: r.text as string,
        ts: new Date(r.created_at as string).getTime(),
      }));

      return json({ success: true, data: { sessionId, turns } });
    },
  );
}
