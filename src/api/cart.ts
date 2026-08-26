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
  } catch {}

  // Accept both snake_case and camelCase — Sarvam LLM emits either
  const productId = body.product_id ?? body.productId;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

  const result = await addToCart(env, session.id, productId, Number(body.quantity) || 1);
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
  } catch {}

  const productId = body.product_id ?? body.productId;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

  const qty = body.quantity != null ? Number(body.quantity) : undefined;
  const result = await removeFromCart(
    env,
    session.id,
    productId,
    qty != null && Number.isInteger(qty) && qty > 0 ? qty : undefined,
  );
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
