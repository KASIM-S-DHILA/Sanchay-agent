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

/**
 * Builds the agent_variables payload for the Sarvam voice interaction,
 * matching the app's current 12-key schema (see src/voice/bridge.ts). Only
 * fields we actually have real data for are populated — everything else is
 * sent as an empty string rather than a fabricated value, since Sarvam's
 * own SDK example ships these as literal "<placeholder>" strings and we
 * don't want to echo that back as if it were real data.
 *
 * Known equivalences, not inventions:
 *  - cart_id: this app has no separate cart-id concept — cart_items is
 *    keyed directly by session_id, so session_id doubles as the cart
 *    identifier. Sending it under both keys is accurate, not a guess.
 *  - order_id: the session's most recent order (created/attempted/paid),
 *    if one exists — lets a returning caller's agent reference "your
 *    order" without the shopper repeating the id.
 *  - previous_categories: derived from user_preferences.previous_products
 *    (the field endSession actually writes) by looking up each product's
 *    category — NOT from preferred_categories, which nothing in this
 *    codebase ever writes and would always resolve to an empty, silently
 *    fabricated-looking signal. Same pattern as getCrossSellSuggestions.
 *  - products_discussed: sourced from user_preferences.previous_products
 *    directly (requires the session to have an associated email;
 *    anonymous sessions get empty strings here).
 *
 * Fields with no real source in this app (call_disposition, call_summary,
 * final_cart_total, gender, user_name, visitor_intent) are intentionally
 * left as "" — those look like fields the agent itself populates over the
 * course of a call, not something Sanchay can know at interaction_start.
 */
export async function getVoiceAgentVariables(
  env: Env,
  sessionId: string,
): Promise<Record<string, string>> {
  const empty: Record<string, string> = {
    budget: "",
    call_disposition: "",
    call_summary: "",
    cart_id: sessionId,
    final_cart_total: "",
    gender: "",
    order_id: "",
    previous_categories: "",
    products_discussed: "",
    session_id: sessionId,
    user_name: "",
    visitor_intent: "",
  };

  try {
    const sess: any = await env.DB.prepare("SELECT user_id, budget_paise FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first();
    if (!sess) return empty;

    const email = sess.user_id as string | null;
    const budgetPaise = sess.budget_paise as number | null;
    if (budgetPaise != null) {
      empty.budget = `₹${(budgetPaise / 100).toLocaleString("en-IN")}`;
    }

    if (email) {
      try {
        const prefs: any = await env.DB.prepare(
          "SELECT previous_products FROM user_preferences WHERE user_id = ?",
        )
          .bind(email)
          .first();
        if (prefs) {
          const products: string[] = JSON.parse(prefs.previous_products || "[]");
          empty.products_discussed = Array.isArray(products) ? products.join(", ") : "";

          if (Array.isArray(products) && products.length > 0) {
            const placeholders = products.map(() => "?").join(",");
            const catRows: any[] = (
              await env.DB.prepare(`SELECT DISTINCT category FROM products WHERE id IN (${placeholders})`)
                .bind(...products)
                .all()
            ).results ?? [];
            const categories = catRows.map((r) => r.category as string).filter(Boolean);
            empty.previous_categories = categories.join(", ");
          }
        }
      } catch (e) {
        console.error("getVoiceAgentVariables: preferences lookup failed:", e);
      }
    }

    try {
      const activeOrder: any = await env.DB.prepare(
        "SELECT razorpay_order_id FROM orders WHERE session_id = ? AND status IN ('created','attempted','paid') ORDER BY created_at DESC LIMIT 1",
      )
        .bind(sessionId)
        .first();
      if (activeOrder?.razorpay_order_id) {
        empty.order_id = activeOrder.razorpay_order_id;
      }
    } catch (e) {
      console.error("getVoiceAgentVariables: order lookup failed:", e);
    }
  } catch (e) {
    console.error("getVoiceAgentVariables: session lookup failed:", e);
  }

  return empty;
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
    const result = await env.DB.prepare("SELECT id, name, price, stock, category, image_url FROM products").all<any>();
    // Renamed id -> productId so this branch's shape matches searchProducts'
    // exactly. Previously a browse-all response used "id" while a real
    // search used "productId" for the same value, so a tool consumer (the
    // voice agent, told to pass back "the id field") could find no id field
    // at all after a real search and pick or invent the wrong product_id.
    // price_display so the agent speaks "₹1,999", not "199900 paise"
    products = (result.results ?? []).map((p: any) => {
      const { id, ...rest } = p;
      return {
        ...rest,
        productId: id,
        price_display: `₹${(p.price / 100).toLocaleString("en-IN")}`,
      };
    });
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

/**
 * Minimal cross-sell signal — "you might also like" driven entirely by data
 * this app already has and actually writes (no fabricated recommendation
 * model):
 *  1. Categories of what's currently in the cart (the most direct signal —
 *     the classic "people buying X also buy Y in the same category").
 *  2. Falls back to categories of the shopper's previous_products
 *     (written by endSession) and purchase_history (written by the
 *     Razorpay webhook on payment.captured) when the cart alone gives no
 *     signal yet (e.g. cart just emptied, or anonymous session with an
 *     empty cart). Deliberately NOT using user_preferences.
 *     preferred_categories — that field has no writer anywhere in this
 *     codebase and would always be an empty fabricated signal.
 * Returns [] rather than guessing when there's truly no real signal.
 */
async function getCrossSellSuggestions(
  env: Env,
  sessionId: string,
): Promise<Array<{ productId: string; name: string; price: number; price_display: string; category: string; image_url: string | null }>> {
  try {
    const cartRows: any[] = (
      await env.DB.prepare("SELECT product_id FROM cart_items WHERE session_id = ?")
        .bind(sessionId)
        .all()
    ).results ?? [];
    const cartProductIds: string[] = cartRows.map((r) => r.product_id as string);

    let categories: string[] = [];
    if (cartProductIds.length > 0) {
      const placeholders = cartProductIds.map(() => "?").join(",");
      const catRows: any[] = (
        await env.DB.prepare(`SELECT DISTINCT category FROM products WHERE id IN (${placeholders})`)
          .bind(...cartProductIds)
          .all()
      ).results ?? [];
      categories = catRows.map((r) => r.category as string).filter(Boolean);
    }

    if (categories.length === 0) {
      const sess: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?")
        .bind(sessionId)
        .first();
      if (sess?.user_id) {
        const prefs: any = await env.DB.prepare(
          "SELECT previous_products, purchase_history FROM user_preferences WHERE user_id = ?",
        )
          .bind(sess.user_id)
          .first();
        if (prefs) {
          const priorProductIds = [
            ...new Set<string>([
              ...(JSON.parse(prefs.previous_products || "[]") as string[]),
              ...(JSON.parse(prefs.purchase_history || "[]") as string[]),
            ]),
          ];
          if (priorProductIds.length > 0) {
            const placeholders = priorProductIds.map(() => "?").join(",");
            const catRows: any[] = (
              await env.DB.prepare(`SELECT DISTINCT category FROM products WHERE id IN (${placeholders})`)
                .bind(...priorProductIds)
                .all()
            ).results ?? [];
            categories = catRows.map((r) => r.category as string).filter(Boolean);
          }
        }
      }
    }

    if (categories.length === 0) return [];

    const excludeIds = cartProductIds.length > 0 ? cartProductIds : ["__none__"];
    const catPlaceholders = categories.map(() => "?").join(",");
    const excludePlaceholders = excludeIds.map(() => "?").join(",");
    const rows: any[] = (
      await env.DB.prepare(
        `SELECT id, name, price, category, image_url FROM products
         WHERE category IN (${catPlaceholders}) AND stock > 0 AND id NOT IN (${excludePlaceholders})
         LIMIT 3`,
      )
        .bind(...categories, ...excludeIds)
        .all()
    ).results ?? [];

    return rows.map((r) => ({
      productId: r.id as string,
      name: r.name as string,
      price: r.price as number,
      price_display: `₹${(r.price / 100).toLocaleString("en-IN")}`,
      category: r.category as string,
      image_url: (r.image_url ?? null) as string | null,
    }));
  } catch (e) {
    // Cross-sell is a nice-to-have on top of the cart response — a failure
    // here must never break add-to-cart or get-cart.
    console.error("getCrossSellSuggestions failed:", e);
    return [];
  }
}

async function getBudget(env: Env, sessionId: string): Promise<number | null> {
  const row: any = await env.DB.prepare("SELECT budget_paise FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first();
  return row?.budget_paise ?? null;
}

/**
 * Sets or updates the session's budget mid-conversation. Exists because the
 * voice persona is expected to acknowledge and enforce a budget the
 * shopper states verbally (e.g. "keep me under 2000 rupees") — without
 * this tool, budget_paise could only ever be set once at session start,
 * so a spoken budget had no real backend effect even though the persona
 * described handling it.
 *
 * Rejects a budget lower than what's already committed in the cart rather
 * than silently accepting a number that would make the existing cart
 * invalid — the shopper is told to remove items first instead.
 */
export async function setBudget(
  env: Env,
  sessionId: string,
  budgetInput: unknown,
): Promise<LogicResult> {
  const budget = Number(budgetInput);
  if (!Number.isFinite(budget) || budget <= 0) {
    const body = { success: false, error: "budget must be a positive number" };
    await logCall(env, sessionId, "/api/session/budget", { budget: budgetInput }, body);
    return { status: 400, body };
  }
  const budgetPaise = Math.round(budget * 100);

  const cart = await getCartPayload(env, sessionId);
  if (cart.total > budgetPaise) {
    const body = {
      success: false,
      error: `Current cart total is ₹${(cart.total / 100).toLocaleString("en-IN")}, which already exceeds ₹${budget.toLocaleString("en-IN")} — remove something first or choose a higher budget`,
    };
    await logCall(env, sessionId, "/api/session/budget", { budget: budgetInput }, body);
    return { status: 200, body };
  }

  await env.DB.prepare("UPDATE sessions SET budget_paise = ? WHERE id = ?").bind(budgetPaise, sessionId).run();

  const body = {
    success: true as const,
    data: {
      budget: budgetPaise,
      budget_display: `₹${budget.toLocaleString("en-IN")}`,
      budgetRemaining: Math.max(0, budgetPaise - cart.total),
    },
  };
  await logCall(env, sessionId, "/api/session/budget", { budget: budgetInput }, body);
  return { status: 200, body };
}

export async function getCart(env: Env, sessionId: string): Promise<LogicResult> {
  const cart = await getCartPayload(env, sessionId);
  const budget = await getBudget(env, sessionId);
  const youMightAlsoLike = await getCrossSellSuggestions(env, sessionId);
  const body = {
    success: true as const,
    data: {
      ...cart,
      budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total),
      youMightAlsoLike,
    },
  };
  await logCall(env, sessionId, "/api/cart", null, body);
  return { status: 200, body };
}

/**
 * Validates a raw quantity value from either an HTTP request body or a
 * voice tool call param. `undefined`/`null`/`""` means "not provided" and is
 * left to the caller to default; anything else must be an integer 1-99 —
 * this is the single source of truth so HTTP and voice enforce identically.
 */
function parseQuantityInput(raw: unknown): { ok: true; value?: number } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 99) return { ok: false };
  return { ok: true, value: n };
}

let cartUniqueIndexEnsured = false;

/**
 * The atomic upsert in addToCart relies on a UNIQUE(session_id, product_id)
 * constraint to make ON CONFLICT race-safe — without it, concurrent adds for
 * the same product each see "no existing row" and insert separate rows
 * instead of contending for one. Self-heals on first use per isolate;
 * memoized so it isn't re-run on every call.
 */
async function ensureCartUniqueIndex(env: Env): Promise<void> {
  if (cartUniqueIndexEnsured) return;
  try {
    await env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_session_product ON cart_items(session_id, product_id)`,
    ).run();
    cartUniqueIndexEnsured = true;
  } catch (e) {
    // Only fails if pre-existing duplicate (session_id, product_id) rows
    // exist from before this index was introduced — log but don't block the
    // request; the ON CONFLICT upsert degrades to a plain insert in that
    // case rather than crashing checkout.
    console.error("failed to create cart unique index:", e);
  }
}

async function ensureIdempotencyTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS idempotency_keys (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ).run();
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_unique ON idempotency_keys(session_id, endpoint, idempotency_key)`,
  ).run();
}

/** Returns a cached result for a previously-completed call with this key, or null if unseen. */
async function getIdempotentReplay(
  env: Env,
  sessionId: string,
  endpoint: string,
  idempotencyKey: string,
): Promise<LogicResult | null> {
  await ensureIdempotencyTable(env);
  const row: any = await env.DB.prepare(
    "SELECT status_code, response_json FROM idempotency_keys WHERE session_id = ? AND endpoint = ? AND idempotency_key = ?",
  )
    .bind(sessionId, endpoint, idempotencyKey)
    .first();
  if (!row) return null;
  const body = JSON.parse(row.response_json);
  // Log the replay explicitly so a deduped retry is visible in the audit
  // trail, not silently swallowed.
  await logCall(env, sessionId, endpoint, { idempotent_replay: idempotencyKey }, body);
  return { status: row.status_code, body };
}

/** Stores the result of a call under its idempotency key for future replay. */
async function storeIdempotentResult(
  env: Env,
  sessionId: string,
  endpoint: string,
  idempotencyKey: string,
  statusCode: number,
  body: Record<string, unknown>,
): Promise<void> {
  await ensureIdempotencyTable(env);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys (id, session_id, endpoint, idempotency_key, status_code, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), sessionId, endpoint, idempotencyKey, statusCode, JSON.stringify(body), new Date().toISOString())
    .run();
}

export async function addToCart(
  env: Env,
  sessionId: string,
  productId: string,
  quantityInput?: unknown,
  idempotencyKey?: string,
): Promise<LogicResult> {
  const parsedQty = parseQuantityInput(quantityInput);
  if (!parsedQty.ok) {
    const body = { success: false, error: "quantity must be an integer 1-99" };
    await logCall(env, sessionId, "/api/cart/add", { product_id: productId, quantity: quantityInput }, body);
    return { status: 400, body };
  }
  const qty = parsedQty.value ?? 1;
  const params = { product_id: productId, quantity: qty };

  // Idempotency — an exact retry with the same key (e.g. a Sarvam tool-call
  // timeout retry) replays the stored result instead of adding the item
  // again.
  if (idempotencyKey) {
    const replay = await getIdempotentReplay(env, sessionId, "/api/cart/add", idempotencyKey);
    if (replay) return replay;
  }
  const remember = async (statusCode: number, body: Record<string, unknown>) => {
    if (idempotencyKey) await storeIdempotentResult(env, sessionId, "/api/cart/add", idempotencyKey, statusCode, body);
  };

  const product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
    .bind(productId)
    .first<any>();
  if (!product) {
    const body = { success: false, error: "Product not found" };
    await logCall(env, sessionId, "/api/cart/add", params, body);
    await remember(404, body);
    return { status: 404, body };
  }
  if (product.stock <= 0) {
    const body = { success: false, error: "Out of stock" };
    await logCall(env, sessionId, "/api/cart/add", params, body);
    await remember(200, body);
    return { status: 200, body };
  }

  const budget = await getBudget(env, sessionId);

  // Fast pre-check for a friendly, specific error message in the common
  // (non-racing) case. The actual guarantee against overselling/overspending
  // comes from the atomic upsert below.
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
      await remember(200, body);
      return { status: 200, body };
    }
  }

  const existing: any = await env.DB.prepare(
    "SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
  )
    .bind(sessionId, productId)
    .first();
  if (existing && existing.quantity + qty > product.stock) {
    const available = Math.max(0, product.stock - existing.quantity);
    const body = {
      success: false as const,
      error: available === 0 ? "No more stock available" : `Only ${available} more available (stock limit ${product.stock})`,
    };
    await logCall(env, sessionId, "/api/cart/add", params, body);
    await remember(200, body);
    return { status: 200, body };
  }
  if (!existing && qty > product.stock) {
    const body = {
      success: false as const,
      error: `Only ${product.stock} available`,
    };
    await logCall(env, sessionId, "/api/cart/add", params, body);
    await remember(200, body);
    return { status: 200, body };
  }

  // Atomic upsert — a real UNIQUE(session_id, product_id) constraint means
  // two concurrent adds for the same product race for the SAME row (via
  // ON CONFLICT), not two independent inserts. The stock/budget re-check
  // happens inside the same statement as the write, against live values,
  // so a concurrent add that changed stock or the cart total between the
  // soft pre-checks above and this write cannot cause an oversell or
  // budget overrun — the DB either applies the whole write or none of it.
  await ensureCartUniqueIndex(env);
  const res = await env.DB.prepare(
    `INSERT INTO cart_items (id, session_id, product_id, product_name, price, quantity, added_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE ?6 <= (SELECT stock FROM products WHERE id = ?3)
       AND (
         (SELECT budget_paise FROM sessions WHERE id = ?2) IS NULL
         OR (SELECT COALESCE(SUM(price * quantity), 0) FROM cart_items WHERE session_id = ?2) + (?5 * ?6) <= (SELECT budget_paise FROM sessions WHERE id = ?2)
       )
     ON CONFLICT(session_id, product_id) DO UPDATE SET
       quantity = cart_items.quantity + excluded.quantity
     WHERE cart_items.quantity + excluded.quantity <= (SELECT stock FROM products WHERE id = cart_items.product_id)
       AND (
         (SELECT budget_paise FROM sessions WHERE id = cart_items.session_id) IS NULL
         OR (SELECT COALESCE(SUM(price * quantity), 0) FROM cart_items WHERE session_id = cart_items.session_id) + (cart_items.price * excluded.quantity) <= (SELECT budget_paise FROM sessions WHERE id = cart_items.session_id)
       )`,
  )
    .bind(crypto.randomUUID(), sessionId, productId, product.name, product.price, qty, new Date().toISOString())
    .run();
  const changed = res.meta.changes;

  if (changed === 0) {
    // Lost a race against a concurrent add between the pre-check above and
    // this write — re-check live state to report the real reason instead of
    // a generic failure.
    const freshProduct = await env.DB.prepare("SELECT stock FROM products WHERE id = ?")
      .bind(productId)
      .first<any>();
    const freshBudget = await getBudget(env, sessionId);
    let body: Record<string, unknown>;
    if (!freshProduct || freshProduct.stock <= 0) {
      body = { success: false, error: "Out of stock" };
    } else if (freshBudget != null) {
      const cur: any = await env.DB.prepare(
        "SELECT COALESCE(SUM(price * quantity), 0) AS total FROM cart_items WHERE session_id = ?",
      )
        .bind(sessionId)
        .first();
      body =
        (cur?.total ?? 0) > freshBudget
          ? { success: false, error: `Exceeds budget of ₹${(freshBudget / 100).toLocaleString("en-IN")}` }
          : { success: false, error: "Only limited stock available — please try again" };
    } else {
      body = { success: false, error: "Only limited stock available — please try again" };
    }
    await logCall(env, sessionId, "/api/cart/add", params, body);
    await remember(200, body);
    return { status: 200, body };
  }

  const cart = await getCartPayload(env, sessionId);
  const youMightAlsoLike = await getCrossSellSuggestions(env, sessionId);
  const body = {
    success: true as const,
    data: { ...cart, budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total), youMightAlsoLike },
  };
  await logCall(env, sessionId, "/api/cart/add", params, body);
  await remember(200, body);
  return { status: 200, body };
}

export async function removeFromCart(
  env: Env,
  sessionId: string,
  productId: string,
  quantityInput?: unknown,
): Promise<LogicResult> {
  const parsedQty = parseQuantityInput(quantityInput);
  if (!parsedQty.ok) {
    const body = { success: false, error: "quantity must be an integer 1-99" };
    await logCall(env, sessionId, "/api/cart/remove", { product_id: productId, quantity: quantityInput }, body);
    return { status: 400, body };
  }

  const existing: any = await env.DB.prepare(
    "SELECT id, quantity, product_name FROM cart_items WHERE session_id = ? AND product_id = ?",
  )
    .bind(sessionId, productId)
    .first();

  if (!existing) {
    const body = { success: false, error: "Item not in cart" };
    await logCall(env, sessionId, "/api/cart/remove", { product_id: productId }, body);
    return { status: 200, body };
  }

  const requested = parsedQty.value ?? existing.quantity;
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
  // product_name is logged in params (not the response body) purely so the
  // friendly Bill Timeline can name a fully-removed item, which no longer
  // appears in data.items by the time this call is logged.
  await logCall(
    env,
    sessionId,
    "/api/cart/remove",
    { product_id: productId, quantity: requested, product_name: existing.product_name },
    body,
  );
  return { status: 200, body };
}

// Fallback ceiling if MERCHANT_MAX_ORDER_PAISE is unset — ₹50,000. Chosen so
// a real demo/test-mode order never accidentally exceeds it, while still
// being low enough to be meaningfully testable (see the "exact boundary"
// coverage in evals). This is a hardcoded safety net, not a business
// decision — a real merchant would configure MERCHANT_MAX_ORDER_PAISE.
const DEFAULT_MERCHANT_MAX_ORDER_PAISE = 50_000_00;

function getMerchantMaxOrderPaise(env: Env): number {
  const raw = env.MERCHANT_MAX_ORDER_PAISE;
  if (raw === undefined) return DEFAULT_MERCHANT_MAX_ORDER_PAISE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`MERCHANT_MAX_ORDER_PAISE="${raw}" is not a valid positive number — falling back to default`);
    return DEFAULT_MERCHANT_MAX_ORDER_PAISE;
  }
  return parsed;
}

// An order left in "created" with no payment for this long is treated as
// abandoned: its reserved stock is released back and a fresh checkout
// attempt can proceed. There's no background job in this Worker to expire
// reservations proactively — this lazily reclaims them the next time the
// same session calls checkout, which is the only place a stale reservation
// actually blocks anything.
const RESERVATION_TIMEOUT_MS = 15 * 60 * 1000;

/** Restores stock for every item in a cancelled/abandoned order — the exact inverse of the reservation decrement below. */
async function releaseOrderStock(env: Env, itemsJson: string | null): Promise<void> {
  if (!itemsJson) return;
  let items: { productId: string; quantity: number }[];
  try {
    items = JSON.parse(itemsJson);
  } catch {
    return;
  }
  if (items.length === 0) return;
  await env.DB.batch(
    items.map((item) =>
      env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(item.quantity, item.productId),
    ),
  );
}

export async function checkoutCart(env: Env, sessionId: string): Promise<LogicResult> {
  // Idempotency — active order for this session is returned as-is, UNLESS
  // it's a "created" order old enough to be abandoned, in which case its
  // reserved stock is released and checkout proceeds to create a new order.
  const activeOrder: any = await env.DB.prepare(
    "SELECT id, razorpay_order_id, amount, payment_url, status, items_json, created_at FROM orders WHERE session_id = ? AND status IN ('created', 'attempted') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(sessionId)
    .first();
  if (activeOrder) {
    const ageMs = Date.now() - new Date(activeOrder.created_at).getTime();
    if (activeOrder.status !== "created" || ageMs < RESERVATION_TIMEOUT_MS) {
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
    // Abandoned reservation — release stock and mark cancelled, then fall
    // through to create a fresh order below.
    await releaseOrderStock(env, activeOrder.items_json);
    await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(activeOrder.id).run();
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

  // Friendly pre-check: drop vanished items and fail this attempt with a
  // specific message. The actual oversell guarantee against a concurrent
  // checkout in a DIFFERENT session for the same product comes from the
  // atomic guarded reservation below, not this check.
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

  // Merchant-side spend ceiling — deliberately independent of and NOT
  // overridable by the session budget. A session's budget is declared by
  // whoever starts the session (including the AI buyer itself), so it
  // bounds nothing on its own; this ceiling exists specifically so no
  // single order — agent-placed or not — can exceed what the merchant
  // configured, regardless of what budget a caller claimed for itself.
  const merchantMaxOrder = getMerchantMaxOrderPaise(env);
  if (total > merchantMaxOrder) {
    const body = {
      success: false,
      error: `This order (₹${(total / 100).toLocaleString("en-IN")}) exceeds the maximum single order amount of ₹${(merchantMaxOrder / 100).toLocaleString("en-IN")} set by the merchant`,
    };
    await logCall(env, sessionId, "/api/checkout", { total, merchant_max_order_paise: merchantMaxOrder, blocked: "merchant_ceiling" }, body);
    return { status: 200, body };
  }

  // Reserve stock atomically at checkout time — this is what actually
  // closes the cross-session oversell race: two different shoppers each
  // holding the last unit in their own carts can no longer both pass
  // checkout, because each guarded UPDATE only succeeds if enough stock is
  // still live at the moment it runs. D1 batch() runs all statements in one
  // transaction but does NOT auto-rollback based on zero-row-affected
  // results, so a partial reservation (some items decremented, one lost the
  // race) is detected and manually compensated below before returning.
  const decrementResults = await env.DB.batch(
    cartItems.map((item) =>
      env.DB.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?").bind(
        item.quantity,
        item.productId,
        item.quantity,
      ),
    ),
  );
  const failedIndex = decrementResults.findIndex((r) => r.meta.changes === 0);
  if (failedIndex !== -1) {
    // Compensate: restore stock for every item that DID succeed before this
    // one, since the batch as a whole is not being committed as a unit here.
    const succeeded = cartItems.slice(0, failedIndex).filter((_, i) => decrementResults[i].meta.changes > 0);
    if (succeeded.length > 0) {
      await env.DB.batch(
        succeeded.map((item) =>
          env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(item.quantity, item.productId),
        ),
      );
    }
    const lostItem = cartItems[failedIndex];
    await env.DB.prepare("DELETE FROM cart_items WHERE session_id = ? AND product_id = ?")
      .bind(sessionId, lostItem.productId)
      .run();
    const body = { success: false, error: `${lostItem.name} sold out while checking out — please try again` };
    await logCall(env, sessionId, "/api/checkout", { removed: lostItem.productId, race_lost: true }, body);
    return { status: 200, body };
  }

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
    // Order creation failed upstream — release the stock we just reserved
    // rather than leaving it permanently locked with no order to show for it.
    await env.DB.batch(
      cartItems.map((item) =>
        env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(item.quantity, item.productId),
      ),
    );
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
