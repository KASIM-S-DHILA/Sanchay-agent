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
