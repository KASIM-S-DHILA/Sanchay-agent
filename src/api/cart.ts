import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { validateSession, UNAUTHORIZED } from "../middleware/session";

interface CartPayload {
  items: { productId: string; name: string; price: number; quantity: number }[];
  total: number;
  count: number;
  budgetRemaining?: number | null;
}

async function getCart(env: Env, sessionId: string): Promise<CartPayload> {
  const rows: any[] = (
    await env.DB.prepare(
      "SELECT product_id, product_name, price, quantity FROM cart_items WHERE session_id = ? ORDER BY added_at ASC",
    )
      .bind(sessionId)
      .all()
  ).results ?? [];

  const items = rows.map((r) => ({
    productId: r.product_id as string,
    name: r.product_name as string,
    price: r.price as number,
    quantity: r.quantity as number,
  }));
  const total = rows.reduce((sum, r) => sum + r.price * r.quantity, 0);
  return { items, total, count: rows.reduce((sum, r) => sum + (r.quantity as number), 0) };
}

async function getBudgetRemaining(
  env: Env,
  sessionId: string,
  budgetPaise: number | null,
  cartTotal: number,
): Promise<number | null> {
  if (budgetPaise == null) return null;
  return Math.max(0, budgetPaise - cartTotal);
}

export async function handleCartAdd(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  let body: { product_id?: string; quantity?: number } = {};
  try {
    body = await request.json();
  } catch {}

  const productId = body.product_id;
  const quantity =
    typeof body.quantity === "number" && Number.isInteger(body.quantity) && body.quantity > 0
      ? body.quantity
      : 1;

  return withApiLogging(
    env,
    {
      sessionId: session?.id ?? null,
      endpoint: "/api/cart/add",
      method: "POST",
      params: { product_id: productId, quantity },
    },
    async (): Promise<ApiResult> => {
      if (!session) return UNAUTHORIZED();
      if (!productId) return json({ success: false, error: "product_id is required" }, 400);

      const product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
        .bind(productId)
        .first<any>();
      if (!product) {
        return json({ success: false, error: "Product not found" }, 404);
      }
      if (product.stock <= 0) {
        return json({ success: false, error: "Out of stock" });
      }

      // Budget enforcement against current cart total
      if (session.budgetPaise != null) {
        const currentTotalRow: any = await env.DB.prepare(
          "SELECT COALESCE(SUM(price * quantity), 0) AS total FROM cart_items WHERE session_id = ?",
        )
          .bind(session.id)
          .first();
        const newTotal = (currentTotalRow?.total ?? 0) + product.price * quantity;
        if (newTotal > session.budgetPaise) {
          return json({
            success: false,
            error: `Exceeds budget of ₹${(session.budgetPaise / 100).toLocaleString("en-IN")}`,
          });
        }
      }

      // Merge with existing line item or insert fresh (price snapshotted from D1)
      const existing: any = await env.DB.prepare(
        "SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
      )
        .bind(session.id, productId)
        .first();

      if (existing) {
        await env.DB.prepare("UPDATE cart_items SET quantity = quantity + ? WHERE id = ?")
          .bind(quantity, existing.id)
          .run();
      } else {
        await env.DB.prepare(
          "INSERT INTO cart_items (id, session_id, product_id, product_name, price, quantity, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(crypto.randomUUID(), session.id, productId, product.name, product.price, quantity, new Date().toISOString())
          .run();
      }

      const cart = await getCart(env, session.id);
      const budgetRemaining = await getBudgetRemaining(env, session.id, session.budgetPaise, cart.total);
      return json({ success: true, data: { ...cart, budgetRemaining } });
    },
  );
}

export async function handleCartRemove(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);
  let body: { product_id?: string; quantity?: number } = {};
  try {
    body = await request.json();
  } catch {}
  const productId = body.product_id;

  return withApiLogging(
    env,
    {
      sessionId: session?.id ?? null,
      endpoint: "/api/cart/remove",
      method: "POST",
      params: { product_id: productId, quantity: body.quantity },
    },
    async (): Promise<ApiResult> => {
      if (!session) return UNAUTHORIZED();
      if (!productId) return json({ success: false, error: "product_id is required" }, 400);

      const existing: any = await env.DB.prepare(
        "SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
      )
        .bind(session.id, productId)
        .first();

      if (!existing) {
        return json({ success: false, error: "Item not in cart" });
      }

      const requested = typeof body.quantity === "number" && body.quantity > 0 ? body.quantity : existing.quantity;
      if (requested >= existing.quantity) {
        await env.DB.prepare("DELETE FROM cart_items WHERE id = ?").bind(existing.id).run();
      } else {
        await env.DB.prepare("UPDATE cart_items SET quantity = quantity - ? WHERE id = ?")
          .bind(requested, existing.id)
          .run();
      }

      const cart = await getCart(env, session.id);
      const budgetRemaining = await getBudgetRemaining(env, session.id, session.budgetPaise, cart.total);
      return json({ success: true, data: { ...cart, budgetRemaining } });
    },
  );
}

export async function handleCartGet(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);

  return withApiLogging(
    env,
    { sessionId: session?.id ?? null, endpoint: "/api/cart", method: "GET", params: null },
    async (): Promise<ApiResult> => {
      if (!session) return UNAUTHORIZED();
      const cart = await getCart(env, session.id);
      const budgetRemaining = await getBudgetRemaining(env, session.id, session.budgetPaise, cart.total);
      return json({ success: true, data: { ...cart, budgetRemaining } });
    },
  );
}

