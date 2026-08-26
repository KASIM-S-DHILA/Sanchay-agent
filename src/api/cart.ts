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

  let qty: number | undefined;
  if (body.quantity != null && body.quantity !== "") {
    const n = Number(body.quantity);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      return Response.json({ success: false, error: "quantity must be an integer 1-99" }, { status: 400 });
    }
    qty = n;
  }
  const result = await addToCart(env, session.id, productId, qty ?? 1);
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

  let qty: number | undefined;
  if (body.quantity != null && body.quantity !== "") {
    const n = Number(body.quantity);
    if (!Number.isInteger(n) || n < 1 || n > 99) {
      return Response.json({ success: false, error: "quantity must be an integer 1-99" }, { status: 400 });
    }
    qty = n;
  }
  const result = await removeFromCart(env, session.id, productId, qty);
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
