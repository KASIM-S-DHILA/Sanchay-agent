import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { logApiCall } from "../middleware/audit";

function normalizeName(input: string): string | null {
  const m = input.trim().match(/([A-Za-z\u0900-\u097F]{2,30})/);
  if (!m) return null;
  const n = m[1].trim();
  // \p{L} alone matches Unicode LETTERS only — it excludes combining marks
  // (category Mc/Mn), which is exactly what Devanagari vowel signs (matras)
  // are: e.g. "कासिम" is क + ा(Mc) + स + ि(Mn) + म, so \p{L} alone rejected
  // every Hindi name containing a matra as "not 2-30 letters" even though
  // it plainly is one. \p{M} adds those combining marks back in.
  if (!/^[\p{L}\p{M} ]{2,30}$/u.test(n)) return null;
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

export async function handleSaveName(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/user/name");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // user_preferences is keyed by sessions.user_id (an email — see
  // startSession in api/logic.ts, and userMigration.ts for why). A session
  // with no user_id yet (created before the first startSession-with-email
  // ever ran) has nowhere to persist a name; it's acknowledged but dropped,
  // matching this endpoint's previous no-persistence-for-guest behavior.
  const userId = session.userId;

  if (request.method === "GET") {
    if (!userId) return Response.json({ success: true, data: { name: null } });
    const row = await env.DB.prepare("SELECT name FROM user_preferences WHERE user_id = ?")
      .bind(userId)
      .first<{ name: string | null }>();
    return Response.json({ success: true, data: { name: row?.name ?? null } });
  }

  const started = Date.now();
  let body: { name?: string } = {};
  try { body = await request.json(); } catch { }
  const raw = String(body.name ?? "").trim();
  const name = normalizeName(raw);

  // This endpoint previously wrote nothing to api_call_log — every call,
  // success or failure, was invisible to the Activity/Bill Timeline and to
  // /api/audit entirely, which made a save_user_name tool call that failed
  // (e.g. Gemini invoking it with an empty/garbled name argument) look
  // exactly like it never happened. Every branch below logs, mirroring how
  // every other mutating endpoint in this codebase behaves.
  if (!name) {
    const responseBody = { success: false, error: "Please tell me your first name (2-30 letters)" };
    await logApiCall(env, {
      sessionId: session.id,
      endpoint: "/api/user/name",
      method: "POST",
      params: { name: raw },
      response: responseBody,
      status: "error",
      durationMs: Date.now() - started,
    });
    return Response.json(responseBody, { status: 400 });
  }

  if (!userId) {
    const responseBody = { success: true, data: { name, persisted: false } };
    await logApiCall(env, {
      sessionId: session.id,
      endpoint: "/api/user/name",
      method: "POST",
      params: { name },
      response: responseBody,
      status: "ok",
      durationMs: Date.now() - started,
    });
    return Response.json(responseBody);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user_preferences (user_id, name, previous_products, purchase_history, session_count, last_active, updated_at)
     VALUES (?, ?, '[]', '[]', 0, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  )
    .bind(userId, name, now, now)
    .run();

  const responseBody = { success: true, data: { name, persisted: true } };
  await logApiCall(env, {
    sessionId: session.id,
    endpoint: "/api/user/name",
    method: "POST",
    params: { name },
    response: responseBody,
    status: "ok",
    durationMs: Date.now() - started,
  });
  return Response.json(responseBody);
}
