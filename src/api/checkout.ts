import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { validateSessionWithAuth } from "../middleware/auth";
import { checkRateLimit, clientIp, rateLimitedResponse } from "../middleware/rateLimit";
import { isUnsubstitutedPlaceholder, placeholderError } from "../middleware/placeholders";
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
