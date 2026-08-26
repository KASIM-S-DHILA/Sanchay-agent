import type { Env } from "../types";

/**
 * Shared-secret gate for /admin/* endpoints. These perform no per-caller
 * scoping (unlike session-based commerce endpoints) and have no legitimate
 * anonymous or end-user caller, so a single operator secret is the right
 * gate here — not a session token (see middleware/session.ts, used instead
 * for /api/audit, which IS a legitimate per-session end-user feature).
 *
 * If ADMIN_TOKEN is not configured, admin endpoints are rejected entirely
 * rather than left open — an unset secret must never be silently treated
 * as "no gate needed".
 *
 * Returns a Response to send immediately if the request should be
 * rejected, or null if it's authorized and the caller should proceed.
 */
export function checkAdminToken(env: Env, request: Request): Response | null {
  if (!env.ADMIN_TOKEN) {
    return Response.json(
      { success: false, error: "Admin endpoints are disabled (ADMIN_TOKEN not configured)" },
      { status: 503 },
    );
  }
  const provided = request.headers.get("X-Admin-Token");
  if (!provided || provided !== env.ADMIN_TOKEN) {
    return Response.json({ success: false, error: "Invalid or missing admin token" }, { status: 401 });
  }
  return null;
}
