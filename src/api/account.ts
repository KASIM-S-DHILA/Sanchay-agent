import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { getAuthUser, validateSessionWithAuth } from "../middleware/auth";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";
import { getAccountProfile } from "./logic";

/**
 * GET /api/account/profile — full account profile for the shopper's OWN
 * account: name, email, member-since date, lifetime order count/spend,
 * favorite categories (derived from actual paid orders), and up to 10
 * recent paid orders. Backs both a "tell me my order history" voice tool
 * (check_account_profile in useGeminiLive.ts) and, in principle, a future
 * account page in the browser.
 *
 * Security — same treatment as handleCheckout's sign-in gate, applied
 * from the start rather than as a follow-up patch:
 *
 * 1. Requires a REAL, OTP-verified bearer token — not merely
 *    session.userId being non-null. session.userId can also be set by the
 *    older, unauthenticated startSession({user_email}) path (see
 *    startSession in logic.ts), which sets it from a bare, unverified
 *    email string with no OTP check at all. Gating on session.userId
 *    alone would let anyone read an arbitrary account's full order
 *    history and spend total just by starting a session with that
 *    person's email — a real information-disclosure bug, not a
 *    hypothetical one, since this endpoint returns far more than
 *    checkout ever did.
 * 2. The profile returned is ALWAYS the token's own subject (getAuthUser's
 *    return value) — there is no userId/email parameter accepted from the
 *    request anywhere in this handler or in getAccountProfile's
 *    signature, so there is no argument to tamper with to request
 *    someone else's data.
 * 3. Rate-limited per session — a read endpoint still deserves a limit
 *    here: without one, a caller holding a stale/expired token could
 *    hammer this to distinguish "valid session, invalid token" from
 *    "invalid session" timing, or simply to scrape it as fast as
 *    possible once compromised.
 * 4. Logged like every other endpoint — a rejection here is a real,
 *    session-attributed "blocked" audit row, not a silent 401/403.
 */
export async function handleAccountProfile(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/account/profile");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const sessionLimit = await checkRateLimit(env, `account_profile:session:${session.id}`, 20, 60);
  if (!sessionLimit.allowed) return rateLimitedResponse();
  const ipLimit = await checkRateLimit(env, `account_profile:ip:${clientIp(request)}`, 60, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  // The presented bearer token must actually own THIS session — without
  // this, a caller holding any valid token (their own, from an unrelated
  // account) could present it against someone else's session id and still
  // pass getAuthUser below, logging the read as if that session made the
  // call. Same check handleCheckout already applies for the identical
  // reason.
  const authCheck = await validateSessionWithAuth(request, env, session);
  if (!authCheck.ok) {
    await logAuthFailure(env, request, "/api/account/profile");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const authedUserId = await getAuthUser(request, env);
  if (!authedUserId) {
    const message = "Sign in to see your order history and preferences.";
    await logApiCall(env, {
      sessionId: session.id,
      endpoint: "/api/account/profile",
      method: request.method,
      params: null,
      response: { success: false, error: message },
      status: "blocked",
      durationMs: 0,
    }).catch((e) => console.error("api_call_log write failed:", e));
    return Response.json({ success: false, error: message }, { status: 403 });
  }

  const started = Date.now();
  const profile = await getAccountProfile(env, authedUserId);
  const responseBody = { success: true, data: profile };
  await logApiCall(env, {
    sessionId: session.id,
    endpoint: "/api/account/profile",
    method: request.method,
    params: null,
    response: responseBody,
    status: "ok",
    durationMs: Date.now() - started,
  }).catch((e) => console.error("api_call_log write failed:", e));

  return Response.json(responseBody);
}
