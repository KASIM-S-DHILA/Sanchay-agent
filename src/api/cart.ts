import type { Env } from "../types";
import { validateSession } from "../middleware/session";
import { addToCart, removeFromCart, getCart } from "./logic";

export async function handleCartAdd(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

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

  // Quantity range/integer validation happens inside removeFromCart, so HTTP
  // and voice tool calls get identical enforcement from one place.
  const result = await removeFromCart(env, session.id, productId, body.quantity);
  return Response.json(result.body, { status: result.status });
}

export async function handleCartGet(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  const result = await getCart(env, session.id);
  return Response.json(result.body, { status: result.status });
}
