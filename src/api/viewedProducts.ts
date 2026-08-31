import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkRateLimit, rateLimitedResponse } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";
import { logViewedProduct, getViewedProducts } from "./logic";

/**
 * POST /api/viewed-products — logs a single product as "seen". Called from
 * the frontend's useProductWindows hook once a floating detail window has
 * stayed open past the dwell-time debounce (MIN_DWELL_MS) — see
 * logViewedProduct's own comment for why that debounce matters. This
 * endpoint itself does no debouncing; by the time it's called, the
 * frontend has already decided the view was real.
 *
 * Rate-limited generously (this fires at most once per window-open, and a
 * shopper opening windows quickly is normal behavior, not abuse) but still
 * capped so a runaway frontend bug can't hammer D1 with writes.
 */
export async function handleLogViewedProduct(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/viewed-products");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const limit = await checkRateLimit(env, `viewed_products:session:${session.id}`, 60, 60);
  if (!limit.allowed) return rateLimitedResponse();

  let body: { product_id?: string } = {};
  try { body = await request.json(); } catch { }
  const productId = String(body.product_id ?? "").trim();
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

  const started = Date.now();
  await logViewedProduct(env, session.id, productId);
  const responseBody = { success: true };
  await logApiCall(env, {
    sessionId: session.id,
    endpoint: "/api/viewed-products",
    method: "POST",
    params: { product_id: productId },
    response: responseBody,
    status: "ok",
    durationMs: Date.now() - started,
  }).catch((e) => console.error("api_call_log write failed:", e));

  return Response.json(responseBody);
}

/**
 * GET /api/viewed-products — recently seen products for THIS session,
 * capped and newest-first (see getViewedProducts). Read-only, no
 * commerce action possible, so no bearer-token gate the way checkout or
 * account profile need — a guest browsing anonymously still has a
 * legitimate "what have I looked at this session" to read back.
 */
export async function handleGetViewedProducts(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/viewed-products");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const viewed = await getViewedProducts(env, session.id);
  return Response.json({ success: true, data: { viewed } });
}
