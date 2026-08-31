import type { Env } from "../types";
import { logApiCall } from "../middleware/audit";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { startSession, endSession, setBudget, getPurchaseHistory } from "./logic";

export async function handleSessionStart(request: Request, env: Env): Promise<Response> {
  // No session/auth exists yet at this point (this endpoint CREATES the
  // session), so the only caller identity available is IP. Guards against
  // a scripted loop flooding the sessions table / D1 write quota — set
  // deliberately high since a real page load only calls this once, but a
  // shared office/NAT IP with several genuine shoppers loading the page
  // around the same time must never be mistaken for abuse.
  const ipLimit = await checkRateLimit(env, `session_start:ip:${clientIp(request)}`, 60, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  let body: { user_email?: string; budget?: number } = {};
  try {
    body = await request.json();
  } catch { }

  const params = {
    user_email: body.user_email?.trim() || undefined,
    budget: typeof body.budget === "number" ? body.budget : undefined,
  };

  const started = Date.now();
  try {
    const result = await startSession(env, params);
    await logApiCall(env, {
      sessionId: result.sessionId,
      endpoint: "/api/session/start",
      method: "POST",
      params,
      response: { success: true, data: { sessionId: result.sessionId } },
      status: "ok",
      durationMs: Date.now() - started,
    });
    return Response.json({ success: true, data: { sessionId: result.sessionId, userPreferences: result.userPreferences } });
  } catch (e) {
    console.error("session/start failed:", e);
    return Response.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

export async function handleSessionEnd(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/session/end");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const started = Date.now();
  await endSession(env, session.id);
  await logApiCall(env, {
    sessionId: session.id,
    endpoint: "/api/session/end",
    method: "POST",
    params: null,
    response: { success: true },
    status: "ok",
    durationMs: Date.now() - started,
  });

  return Response.json({ success: true });
}

/**
 * Sets, changes, or clears the session's spending cap — used by both the
 * browser's cap form and the Gemini Live `set_budget` voice tool (see
 * useGeminiLive.ts). Delegates entirely to setBudget(), so a budget typed
 * on screen and a budget spoken aloud get identical validation, identical
 * rejection messages, and identical audit rows. No validation is
 * duplicated here on purpose. The cap is always session-scoped — it never
 * touches the account, so it is never "permanent": a fresh session (new
 * browser, new sign-in, or just after this one ends) starts uncapped.
 */
export async function handleSessionBudget(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/session/budget");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Loosely throttled — a shopper genuinely might adjust a spoken budget
  // several times in one conversation ("actually make it 3000", "no,
  // 2500"), so this exists to catch a runaway loop, not normal back-and-forth.
  const limit = await checkRateLimit(env, `set_budget:session:${session.id}`, 20, 60);
  if (!limit.allowed) return rateLimitedResponse();

  let body: { budget?: unknown; clear?: boolean } = {};
  try {
    body = await request.json();
  } catch { }

  const result = await setBudget(env, session.id, body.budget, body.clear === true);
  return Response.json(result.body, { status: result.status });
}

/**
 * Last 2 paid orders for this session's account — see getPurchaseHistory
 * in api/logic.ts for why this reads `orders` directly rather than
 * user_preferences.purchase_history. Used by useGeminiLive.ts to greet a
 * returning shopper with something like "last time you got a hoodie" —
 * read-only, no rate limiting needed beyond the shared per-session
 * request pattern every other GET here already has.
 */
export async function handleSessionHistory(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/session/history");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const history = await getPurchaseHistory(env, session.id);
  return Response.json({ success: true, data: { orders: history } });
}
