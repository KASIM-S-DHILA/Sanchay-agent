import type { Env } from "../types";
import { validateSession, logAuthFailure } from "../middleware/session";
import { getAuthUser } from "../middleware/auth";
import { isUnsubstitutedPlaceholder, placeholderError } from "../middleware/placeholders";
import { checkRateLimit, clientIp, maybeCleanupExpiredRows, rateLimitedResponse } from "../middleware/rateLimit";
import {
  addToCart,
  removeFromCart,
  getCart,
  proposeAddToCart,
  proposeRemoveFromCart,
  confirmCartAction,
} from "./logic";

export async function handleCartAdd(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/cart/add");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Unthrottled cart mutations were a real gap: since addToCart reserves
  // actual stock, a scripted caller with just a session id (no bearer
  // token required — see cart.ts's session-only trust model) could hammer
  // this endpoint to exhaust stock on popular SKUs, or just flood D1
  // writes. Deliberately set WAY above any realistic voice/manual usage
  // (a shopper or the agent on their behalf adding a couple dozen items a
  // minute is already an extreme session) — this exists to catch a
  // scripted flood, not to ever be felt by a real shopper.
  const sessionLimit = await checkRateLimit(env, `cart_add:session:${session.id}`, 120, 60);
  if (!sessionLimit.allowed) return rateLimitedResponse();
  const ipLimit = await checkRateLimit(env, `cart_add:ip:${clientIp(request)}`, 300, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  let body: { product_id?: string; productId?: string; quantity?: number | string } = {};
  try {
    body = await request.json();
  } catch { }

  // Accept both snake_case and camelCase — Sarvam LLM emits either
  const productId = body.product_id ?? body.productId;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

  // Optional idempotency key — a client-supplied retry token (e.g. an LLM
  // tool-call timeout retry) replays the original result instead of adding
  // the item twice. Accepted via header (REST convention) or body (Sarvam
  // tool params can't set custom headers).
  const idempotencyKey =
    request.headers.get("Idempotency-Key") ?? (body as any).idempotency_key ?? undefined;

  // Quantity range/integer validation happens inside addToCart, so HTTP and
  // voice tool calls get identical enforcement from one place.
  const result = await addToCart(env, session.id, productId, body.quantity, idempotencyKey);
  return Response.json(result.body, { status: result.status });
}

export async function handleCartRemove(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/cart/remove");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  // Same reasoning and same deliberately generous ceiling as handleCartAdd
  // — this guards against a scripted flood, not normal voice/manual use.
  const sessionLimit = await checkRateLimit(env, `cart_remove:session:${session.id}`, 120, 60);
  if (!sessionLimit.allowed) return rateLimitedResponse();
  const ipLimit = await checkRateLimit(env, `cart_remove:ip:${clientIp(request)}`, 300, 60);
  if (!ipLimit.allowed) return rateLimitedResponse();

  let body: { product_id?: string; productId?: string; quantity?: number | string } = {};
  try {
    body = await request.json();
  } catch { }

  const productId = body.product_id ?? body.productId;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

  // Quantity range/integer validation happens inside removeFromCart, so HTTP
  // and voice tool calls get identical enforcement from one place.
  const result = await removeFromCart(env, session.id, productId, body.quantity);
  return Response.json(result.body, { status: result.status });
}

export async function handlePropseAddToCart(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/cart/propose-add");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }
  let body: { product_id?: string; productId?: string; quantity?: number | string } = {};
  try {
    body = await request.json();
  } catch { }
  const productId = body.product_id ?? body.productId;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }
  if (isUnsubstitutedPlaceholder(productId)) {
    return Response.json({ success: false, error: placeholderError("product id") }, { status: 400 });
  }
  const result = await proposeAddToCart(env, session.id, productId, body.quantity);
  return Response.json(result.body, { status: result.status });
}

export async function handleProposeRemoveFromCart(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/cart/propose-remove");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }
  let body: { product_id?: string; productId?: string; quantity?: number | string } = {};
  try {
    body = await request.json();
  } catch { }
  const productId = body.product_id ?? body.productId;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }
  if (isUnsubstitutedPlaceholder(productId)) {
    return Response.json({ success: false, error: placeholderError("product id") }, { status: 400 });
  }
  const result = await proposeRemoveFromCart(env, session.id, productId, body.quantity);
  return Response.json(result.body, { status: result.status });
}

export async function handleConfirmCartAction(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/cart/confirm");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }
  let body: { action_token?: string } = {};
  try {
    body = await request.json();
  } catch { }
  if (!body.action_token) {
    return Response.json({ success: false, error: "action_token is required" }, { status: 400 });
  }
  if (isUnsubstitutedPlaceholder(body.action_token)) {
    return Response.json({ success: false, error: placeholderError("action_token") }, { status: 400 });
  }
  const result = await confirmCartAction(env, session.id, body.action_token);
  return Response.json(result.body, { status: result.status });
}

export async function handleCartGet(request: Request, env: Env): Promise<Response> {
  // GET /api/cart is polled every 3 seconds by EVERY active session,
  // regardless of whether the audit/activity panel is even visible — the
  // one guaranteed-frequent endpoint in this app, which makes it the right
  // place for maybeCleanupExpiredRows' opportunistic sweep to actually run
  // often enough to matter. otp/send alone (its only other caller) never
  // fires at all for a shopper who never signs in, which is exactly how
  // api_call_log grew to ~4,000 rows for one real session with no cleanup
  // ever triggering — see that table's cleanup comment in rateLimit.ts.
  void maybeCleanupExpiredRows(env);

  const session = await validateSession(env, request);
  if (!session) {
    await logAuthFailure(env, request, "/api/cart");
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const result = await getCart(env, session.id);
  // isSignedIn reflects a REAL, OTP-verified bearer token — not merely
  // session.userId being set (that can also come from the older,
  // unauthenticated startSession({user_email}) path; see the matching
  // comment in handleCheckout for why that's not proof of sign-in).
  // Overwritten here rather than inside getCart because only the request
  // layer has the Authorization header — getCart only ever sees sessionId.
  const authedUserId = await getAuthUser(request, env);
  if (result.body.success && result.body.data) {
    (result.body.data as any).isSignedIn = !!authedUserId;
  }
  return Response.json(result.body, { status: result.status });
}
