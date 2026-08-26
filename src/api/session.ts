import type { Env } from "../types";
import { logApiCall } from "../middleware/audit";
import { validateSession } from "../middleware/session";
import { startSession, endSession, setBudget } from "./logic";

export async function handleSessionStart(request: Request, env: Env): Promise<Response> {
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
 * Sets a spending cap on the live session from the browser UI.
 *
 * Delegates entirely to setBudget() — the same function the `set_budget`
 * voice tool dispatches to — so a budget typed on screen and a budget spoken
 * aloud get identical validation, identical rejection messages, and identical
 * audit rows. No validation is duplicated here on purpose.
 */
export async function handleSessionBudget(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  let body: { budget?: unknown } = {};
  try {
    body = await request.json();
  } catch { }

  const result = await setBudget(env, session.id, body.budget);
  return Response.json(result.body, { status: result.status });
}
