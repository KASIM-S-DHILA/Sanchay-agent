import type { Env, Session } from "../types";

/** Validates a raw session id against D1. Returns null when missing/expired/ended. */
export async function validateSessionId(env: Env, sessionId: string | null | undefined): Promise<Session | null> {
  if (!sessionId) return null;

  const row = await env.DB.prepare(
    "SELECT id, user_id, status, budget_paise, expires_at, created_at FROM sessions WHERE id = ? AND status = 'active' AND expires_at > ?",
  )
    .bind(sessionId, new Date().toISOString())
    .first<any>();

  if (!row) return null;

  return {
    id: row.id as string,
    userId: row.user_id as string | null,
    status: row.status as string,
    budgetPaise: (row.budget_paise ?? null) as number | null,
    expiresAt: row.expires_at as string,
    createdAt: row.created_at as string,
  };
}

/** Extracts and validates x-session-id. Returns null when missing/expired/ended. */
export async function validateSession(env: Env, request: Request): Promise<Session | null> {
  return validateSessionId(env, request.headers.get("x-session-id"));
}

export const UNAUTHORIZED = (): { body: Record<string, unknown>; status: number } => ({
  body: { success: false, error: "Invalid or expired session" },
  status: 401,
});

/**
 * Records a rejected call so an auth failure is visible instead of silent.
 *
 * Handlers return 401 before their normal logging runs, so a caller with a
 * missing or stale session id produced no api_call_log row at all. That made a
 * real failure indistinguishable from "the agent never tried": Sarvam's voice
 * tools were 401ing on every cart operation while the audit trail showed
 * nothing, and diagnosing it needed direct database access.
 *
 * The attempted session id is recorded so a stale-vs-absent id can be told
 * apart. Best-effort: a logging failure must never turn a 401 into a 500.
 */
export async function logAuthFailure(
  env: Env,
  request: Request,
  endpoint: string,
): Promise<void> {
  const attempted = request.headers.get("x-session-id");
  const { isUnsubstitutedPlaceholder } = await import("./placeholders");
  // Naming this case separately turns a mystery 401 into an instruction.
  const reason = isUnsubstitutedPlaceholder(attempted)
    ? "unsubstituted_template_in_x_session_id"
    : "invalid_or_expired_session";
  try {
    const { logApiCall } = await import("./audit");
    await logApiCall(env, {
      // Column is nullable, and an invalid id must not be written as if it
      // were a real session — it's reported in params instead.
      sessionId: null,
      endpoint,
      method: request.method,
      params: {
        rejected: reason,
        session_id_supplied: attempted ? `${attempted.slice(0, 20)}…` : null,
        user_agent: request.headers.get("user-agent")?.slice(0, 120) ?? null,
      },
      response: { success: false, error: "Invalid or expired session" },
      // Matches withApiLogging's convention of mapping 401/403 to "blocked".
      status: "blocked",
      durationMs: 0,
    });
  } catch (e) {
    console.error("logAuthFailure failed:", e);
  }
}
