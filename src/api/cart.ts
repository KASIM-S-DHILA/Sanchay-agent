import type { Env } from "../types";
import { validateSession } from "../middleware/session";
import {
  searchCatalog,
  addToCart,
  removeFromCart,
  getCart,
} from "./logic";

export async function handleCatalogSearch(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  const q = url.searchParams.get("q")?.trim() || "";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);

  const { status, body } = await searchCatalog(env, session?.id ?? "", q, limit);
  return Response.json(body, { status });
}

export async function handleCartAdd(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  let body: { product_id?: string; quantity?: number } = {};
  try {
    body = await request.json();
  } catch {}

  const productId = body.product_id;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

  const result = await addToCart(env, session.id, productId, body.quantity ?? 1);
  return Response.json(result.body, { status: result.status });
}

export async function handleCartRemove(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  if (!session) {
    return Response.json({ success: false, error: "Invalid or expired session" }, { status: 401 });
  }

  let body: { product_id?: string; quantity?: number } = {};
  try {
    body = await request.json();
  } catch {}

  const productId = body.product_id;
  if (!productId) {
    return Response.json({ success: false, error: "product_id is required" }, { status: 400 });
  }

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
