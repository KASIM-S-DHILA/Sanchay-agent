import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { validateSessionWithAuth, getAuthUser } from "../middleware/auth";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { isUnsubstitutedPlaceholder, placeholderError } from "../middleware/placeholders";
import { logApiCall } from "../middleware/audit";
import { checkoutCart, getOrderStatus } from "./logic";

export async function handleCheckout(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/checkout");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // If the caller presents a bearer token, it must actually own this
  // session — guest checkout (no header at all) is unaffected.
  const authCheck = await validateSessionWithAuth(request, env, session);
  if (!authCheck.ok) {
    await logAuthFailure(env, request, "/api/checkout");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Payment requires a REAL, OTP-verified sign-in — a valid bearer token,
  // not merely session.userId being non-null. session.userId can also be
  // set by the older, unauthenticated startSession({ user_email }) path
  // (see startSession in logic.ts — it writes sessions.user_id directly
  // from whatever email string the caller passes, with no OTP check at
  // all, purely so a guest can optionally tag a session for order-history
  // lookups). Gating on session.userId alone would let anyone bypass
  // sign-in just by starting a session with any email string. A verified
  // JWT (see handleAuthOtpVerify) is the only proof that this caller
  // actually completed OTP sign-in, so that's what's checked here.
  //
  // Browsing, searching, and building a cart all work fine as a guest;
  // this is the one gate that specifically requires having signed in, so
  // the cart survives the sign-in prompt rather than being lost — see the
  // "isSignedIn" flag on GET /api/cart, which lets both the browser and
  // the voice agent know this BEFORE calling checkout and hitting this
  // rejection as a surprise. Logged directly (not via logAuthFailure,
  // which is specifically for invalid/expired sessions and always writes
  // sessionId: null) since this session IS valid — it's a real,
  // attributable "blocked" call, not an auth failure.
  const authedUserId = await getAuthUser(request, env);
  if (!authedUserId) {
    const message = "Sign in to complete your purchase — your cart is saved and won't be lost.";
    await logApiCall(env, {
      sessionId: session.id,
      endpoint: "/api/checkout",
      method: request.method,
      params: null,
      response: { success: false, error: message },
      status: "blocked",
      durationMs: 0,
    }).catch((e) => console.error("api_call_log write failed:", e));
    return Response.json({ success: false, error: message }, { status: 403 });
  }

  // Two limits: tight per-session (retries, a runaway agent loop) and
  // looser per-IP. Session creation needs no auth, so a per-session-only
  // limit is trivially bypassed by opening a new session per attempt —
  // the per-IP cap catches that case. Set well above what any real shared
  // IP's legitimate traffic would hit, since a proxied/NATed IP can serve
  // many unrelated shoppers.
  const sessionLimit = await checkRateLimit(env, `checkout:session:${session.id}`, 5, 60);
  if (!sessionLimit.allowed) return rateLimitedResponse();
  const ipLimit = await checkRateLimit(env, `checkout:ip:${clientIp(request)}`, 30, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  const result = await checkoutCart(env, session.id);
  return Response.json(result.body, { status: result.status });
}

export async function handleOrderStatus(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/order");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Accept the order id from a JSON body as well as the URL path. Every other
  // voice tool is a plain POST with a JSON body; requiring this one to
  // template a path segment made it the odd one out in the tool editor and the
  // easiest of the seven to misconfigure.
  let bodyOrderId: unknown;
  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown>;
      bodyOrderId = body.order_id ?? body.orderId;
    } catch { /* no body — fall back to the path */ }
  }

  const pathTail = url.pathname.split("/").pop() ?? "";
  const fromPath = pathTail === "order" ? "" : pathTail; // POST /api/order carries no id
  const orderId = String(bodyOrderId ?? fromPath ?? "").trim();

  if (isUnsubstitutedPlaceholder(orderId)) {
    return Response.json({ success: false, error: placeholderError("order id") }, { status: 400 });
  }
  if (!orderId) {
    return Response.json({ success: false, error: "order_id is required" }, { status: 400 });
  }

  const result = await getOrderStatus(env, session.id, orderId);
  return Response.json(result.body, { status: result.status });
}
