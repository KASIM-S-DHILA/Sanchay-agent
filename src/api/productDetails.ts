import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { checkRateLimit, rateLimitedResponse } from "../middleware/rateLimit";
import { logApiCall } from "../middleware/audit";
import { getProductDetails } from "./logic";

const MAX_IDS_PER_CALL = 4; // matches the floating-window cap — see useProductWindows.ts

/**
 * POST /api/product-details — full data for one or more products by id,
 * backing the show_product_detail voice tool (opens floating detail
 * window(s) on the frontend). Read-only; the cap on how many windows can
 * be OPEN at once is frontend UI state (see useProductWindows.ts) and is
 * deliberately not enforced here beyond a flat per-request id limit —
 * this endpoint has no concept of "windows", only "give me detail for
 * these ids".
 */
export async function handleProductDetails(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/product-details");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const limit = await checkRateLimit(env, `product_details:session:${session.id}`, 40, 60);
  if (!limit.allowed) return rateLimitedResponse();

  let body: { product_ids?: unknown } = {};
  try { body = await request.json(); } catch { }
  const rawIds = Array.isArray(body.product_ids) ? body.product_ids : [];
  const productIds = [...new Set(rawIds.map((v) => String(v).trim()).filter(Boolean))].slice(0, MAX_IDS_PER_CALL);

  const started = Date.now();
  if (productIds.length === 0) {
    const res = { success: false, error: "product_ids is required (at least one)." };
    await logApiCall(env, {
      sessionId: session.id, endpoint: "/api/product-details", method: "POST",
      params: { product_ids: [] }, response: res, status: "error", durationMs: Date.now() - started,
    }).catch((e) => console.error("api_call_log write failed:", e));
    return Response.json(res, { status: 400 });
  }

  const { found, notFound } = await getProductDetails(env, session.id, productIds);
  const responseBody = { success: true, data: { products: found, notFound } };
  await logApiCall(env, {
    sessionId: session.id, endpoint: "/api/product-details", method: "POST",
    params: { product_ids: productIds }, response: responseBody, status: "ok", durationMs: Date.now() - started,
  }).catch((e) => console.error("api_call_log write failed:", e));

  return Response.json(responseBody);
}
