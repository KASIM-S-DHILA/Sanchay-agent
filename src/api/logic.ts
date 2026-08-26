import type { Env, UserPreferences } from "../types";
import { searchProducts } from "../catalog/search";
import { createOrder, createPaymentLink } from "../razorpay";

/**
 * Core commerce logic shared by HTTP routes (src/api/*.ts) and voice tool
 * calls (src/voice/tools.ts). Each function:
 *  - enforces its own safety boundaries (stock, budget, idempotency)
 *  - writes exactly one api_call_log entry, so the audit trail is identical
 *    whether the caller is an HTTP route or the voice bridge
 */

type LogicResult = { status: number; body: Record<string, unknown> };

async function logCall(
  env: Env,
  sessionId: string,
  endpoint: string,
  params: Record<string, unknown> | null,
  body: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO api_call_log (id, session_id, endpoint, method, params_json, response_json, status, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      sessionId,
      endpoint,
      "TOOL",
      params ? JSON.stringify(params) : null,
      JSON.stringify(body),
      body.success === false ? "error" : "ok",
      0,
      new Date().toISOString(),
    )
    .run();
}

export async function startSession(
  env: Env,
  params: { user_email?: string; budget?: number },
): Promise<{ sessionId: string; userPreferences: UserPreferences | null }> {
  const email = params.user_email?.trim() || null;
  const budgetPaise =
    typeof params.budget === "number" && Number.isFinite(params.budget) && params.budget > 0
      ? Math.round(params.budget)
      : null;

  const sessionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 3_600_000).toISOString();

  await env.DB.prepare(
    "INSERT INTO sessions (id, user_id, status, expires_at, created_at, budget_paise) VALUES (?, ?, 'active', ?, ?, ?)",
  )
    .bind(sessionId, email, expiresAt, nowIso, budgetPaise)
    .run();

  let userPreferences: UserPreferences | null = null;
  if (email) {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY, preferred_categories TEXT,
        budget_preference INTEGER, previous_products TEXT, purchase_history TEXT,
        session_count INTEGER DEFAULT 0, last_active TEXT, updated_at TEXT)`,
    ).run();
    const row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?")
      .bind(email)
      .first();
    userPreferences = row
      ? {
          preferredCategories: JSON.parse(row.preferred_categories || "[]"),
          budgetPreference: row.budget_preference ?? null,
          previousProducts: JSON.parse(row.previous_products || "[]"),
          purchaseHistory: JSON.parse(row.purchase_history || "[]"),
          sessionCount: row.session_count || 0,
          lastActive: row.last_active ?? null,
        }
      : {
          preferredCategories: [],
          budgetPreference: null,
          previousProducts: [],
          purchaseHistory: [],
          sessionCount: 0,
          lastActive: null,
        };
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         session_count = session_count + 1,
         last_active = excluded.last_active,
         updated_at = excluded.updated_at`,
    )
      .bind(
        email,
        JSON.stringify(userPreferences.preferredCategories),
        userPreferences.budgetPreference,
        JSON.stringify(userPreferences.previousProducts),
        JSON.stringify(userPreferences.purchaseHistory),
        0,
        userPreferences.lastActive,
        nowIso,
      )
      .run();
  }

  return { sessionId, userPreferences };
}

export async function endSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").bind(sessionId).run();

  const sess: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first();
  if (!sess?.user_id) return;

  const cartRows: any[] = (
    await env.DB.prepare("SELECT product_id FROM cart_items WHERE session_id = ?")
      .bind(sessionId)
      .all()
  ).results ?? [];
  const ids = cartRows.map((r) => r.product_id);
  if (ids.length === 0) return;

  await env.DB.prepare(
    "UPDATE user_preferences SET previous_products = ?, updated_at = ? WHERE user_id = ?",
  )
    .bind(JSON.stringify(ids), new Date().toISOString(), sess.user_id)
    .run();
}

export async function searchCatalog(
  env: Env,
  sessionId: string,
  query: string,
  limit = 5,
): Promise<LogicResult> {
  let products: Record<string, unknown>[];
  if (query.trim()) {
    const results = await searchProducts(env, query, limit);
    products = results.map((p: any) => ({
      ...p,
      price_display: `₹${(p.price / 100).toLocaleString("en-IN")}`,
    }));
  } else {
    const result = await env.DB.prepare("SELECT id, name, price, stock, category FROM products").all<any>();
    // price_display so the agent speaks "₹1,999", not "199900 paise"
    products = (result.results ?? []).map((p: any) => ({
      ...p,
      price_display: `₹${(p.price / 100).toLocaleString("en-IN")}`,
    }));
  }
  const body = { success: true as const, data: { query, products } };
  await logCall(env, sessionId, "/api/catalog", { query, limit }, body);
  return { status: 200, body };
}

async function getCartPayload(env: Env, sessionId: string) {
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
    price_display: `₹${(r.price / 100).toLocaleString("en-IN")}`,
    quantity: r.quantity as number,
  }));
  const total = rows.reduce((s, r) => s + r.price * r.quantity, 0);
  const count = rows.reduce((s, r) => s + r.quantity, 0);
  const total_display = `₹${(total / 100).toLocaleString("en-IN")}`;
  return { items, total, total_display, count };
}

async function getBudget(env: Env, sessionId: string): Promise<number | null> {
  const row: any = await env.DB.prepare("SELECT budget_paise FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first();
  return row?.budget_paise ?? null;
}

export async function getCart(env: Env, sessionId: string): Promise<LogicResult> {
  const cart = await getCartPayload(env, sessionId);
  const budget = await getBudget(env, sessionId);
  const body = {
    success: true as const,
    data: {
      ...cart,
      budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total),
    },
  };
  await logCall(env, sessionId, "/api/cart", null, body);
  return { status: 200, body };
}

export async function addToCart(
  env: Env,
  sessionId: string,
  productId: string,
  quantity: number,
): Promise<LogicResult> {
  const qty =
    typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  const params = { product_id: productId, quantity: qty };

  const product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
    .bind(productId)
    .first<any>();
  if (!product) {
    const body = { success: false, error: "Product not found" };
    await logCall(env, sessionId, "/api/cart/add", params, body);
    return { status: 404, body };
  }
  if (product.stock <= 0) {
    const body = { success: false, error: "Out of stock" };
    await logCall(env, sessionId, "/api/cart/add", params, body);
    return { status: 200, body };
  }

  // Budget enforcement against live cart total
  const budget = await getBudget(env, sessionId);
  if (budget != null) {
    const cur: any = await env.DB.prepare(
      "SELECT COALESCE(SUM(price * quantity), 0) AS total FROM cart_items WHERE session_id = ?",
    )
      .bind(sessionId)
      .first();
    if ((cur?.total ?? 0) + product.price * qty > budget) {
      const body = {
        success: false,
        error: `Exceeds budget of ₹${(budget / 100).toLocaleString("en-IN")}`,
      };
      await logCall(env, sessionId, "/api/cart/add", params, body);
      return { status: 200, body };
    }
  }

  const existing: any = await env.DB.prepare(
    "SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
  )
    .bind(sessionId, productId)
    .first();
  if (existing) {
    if (existing.quantity + qty > product.stock) {
      const available = Math.max(0, product.stock - existing.quantity);
      const body = {
        success: false as const,
        error: available === 0 ? "No more stock available" : `Only ${available} more available (stock limit ${product.stock})`,
      };
      await logCall(env, sessionId, "/api/cart/add", params, body);
      return { status: 200, body };
    }
    await env.DB.prepare("UPDATE cart_items SET quantity = quantity + ? WHERE id = ?")
      .bind(qty, existing.id)
      .run();
  } else {
    if (qty > product.stock) {
      const body = {
        success: false as const,
        error: `Only ${product.stock} available`,
      };
      await logCall(env, sessionId, "/api/cart/add", params, body);
      return { status: 200, body };
    }
    await env.DB.prepare(
      "INSERT INTO cart_items (id, session_id, product_id, product_name, price, quantity, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), sessionId, productId, product.name, product.price, qty, new Date().toISOString())
      .run();
  }

  const cart = await getCartPayload(env, sessionId);
  const body = {
    success: true as const,
    data: { ...cart, budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total) },
  };
  await logCall(env, sessionId, "/api/cart/add", params, body);
  return { status: 200, body };
}

export async function removeFromCart(
  env: Env,
  sessionId: string,
  productId: string,
  quantity?: number,
): Promise<LogicResult> {
  const existing: any = await env.DB.prepare(
    "SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
  )
    .bind(sessionId, productId)
    .first();

  if (!existing) {
    const body = { success: false, error: "Item not in cart" };
    await logCall(env, sessionId, "/api/cart/remove", { product_id: productId }, body);
    return { status: 200, body };
  }

  const requested =
    typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0
      ? quantity
      : existing.quantity;
  if (requested >= existing.quantity) {
    await env.DB.prepare("DELETE FROM cart_items WHERE id = ?").bind(existing.id).run();
  } else {
    await env.DB.prepare("UPDATE cart_items SET quantity = quantity - ? WHERE id = ?")
      .bind(requested, existing.id)
      .run();
  }

  const cart = await getCartPayload(env, sessionId);
  const budget = await getBudget(env, sessionId);
  const body = {
    success: true as const,
    data: { ...cart, budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total) },
  };
  await logCall(env, sessionId, "/api/cart/remove", { product_id: productId, quantity: requested }, body);
  return { status: 200, body };
}

export async function checkoutCart(env: Env, sessionId: string): Promise<LogicResult> {
  // Idempotency — active order for this session is returned as-is
  const activeOrder: any = await env.DB.prepare(
    "SELECT razorpay_order_id, amount, payment_url, status FROM orders WHERE session_id = ? AND status IN ('created', 'attempted') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(sessionId)
    .first();
  if (activeOrder) {
    const body = {
      success: true as const,
      data: {
        orderId: activeOrder.razorpay_order_id,
        amount: activeOrder.amount,
        paymentUrl: activeOrder.payment_url ?? undefined,
        status: activeOrder.status,
      },
    };
    await logCall(env, sessionId, "/api/checkout", { idempotent: true }, body);
    return { status: 200, body };
  }

  const rows: any[] = (
    await env.DB.prepare(
      "SELECT product_id, product_name, price, quantity FROM cart_items WHERE session_id = ? ORDER BY added_at ASC",
    )
      .bind(sessionId)
      .all()
  ).results ?? [];
  if (rows.length === 0) {
    const body = { success: false, error: "Cart is empty" };
    await logCall(env, sessionId, "/api/checkout", null, body);
    return { status: 200, body };
  }

  // Re-validate stock; drop vanished items and fail this attempt
  for (const row of rows) {
    const p = await env.DB.prepare("SELECT name, stock FROM products WHERE id = ?")
      .bind(row.product_id)
      .first<any>();
    if (!p || p.stock <= 0) {
      await env.DB.prepare("DELETE FROM cart_items WHERE session_id = ? AND product_id = ?")
        .bind(sessionId, row.product_id)
        .run();
      const body = { success: false, error: `${row.product_name} is no longer available` };
      await logCall(env, sessionId, "/api/checkout", { removed: row.product_id }, body);
      return { status: 200, body };
    }
  }

  const total = rows.reduce((s, r) => s + r.price * r.quantity, 0);
  const cartItems = rows.map((r) => ({
    productId: r.product_id as string,
    name: r.product_name as string,
    price: r.price as number,
    quantity: r.quantity as number,
  }));

  try {
    const order = await createOrder(env, total, `${sessionId.slice(0, 12)}-${Date.now()}`);
    const sess: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first();
    let paymentUrl: string | undefined;
    try {
      paymentUrl = await createPaymentLink(env, order.id, sess?.user_id || "guest@example.com");
    } catch (e) {
      console.error("payment link failed (order kept):", e);
    }

    await env.DB.prepare(
      "INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, payment_url, created_at) VALUES (?, ?, ?, ?, 'INR', 'created', ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), sessionId, order.id, total, JSON.stringify(cartItems), paymentUrl ?? null, new Date().toISOString())
      .run();

    const body = {
      success: true as const,
      data: { orderId: order.id, amount: total, paymentUrl, status: "created" },
    };
    await logCall(env, sessionId, "/api/checkout", { amount: total }, body);
    return { status: 200, body };
  } catch (e) {
    console.error("checkout gateway error:", e);
    const body = { success: false, error: "Payment gateway error" };
    await logCall(env, sessionId, "/api/checkout", null, body);
    return { status: 502, body };
  }
}

export async function getOrderStatus(
  env: Env,
  sessionId: string,
  orderId: string,
): Promise<LogicResult> {
  const row: any = await env.DB.prepare(
    "SELECT razorpay_order_id, status, amount, items_json FROM orders WHERE razorpay_order_id = ? AND session_id = ?",
  )
    .bind(orderId, sessionId)
    .first();

  if (!row) {
    const body = { success: false, error: "Order not found" };
    await logCall(env, sessionId, "/api/order", { order_id: orderId }, body);
    return { status: 404, body };
  }

  const body = {
    success: true as const,
    data: {
      orderId: row.razorpay_order_id,
      status: row.status,
      amount: row.amount,
      items: JSON.parse(row.items_json || "[]"),
    },
  };
  await logCall(env, sessionId, "/api/order", { order_id: orderId }, body);
  return { status: 200, body };
}
