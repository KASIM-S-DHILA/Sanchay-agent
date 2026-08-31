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
        user_id TEXT PRIMARY KEY,
        previous_products TEXT, purchase_history TEXT,
        session_count INTEGER DEFAULT 0, last_active TEXT, updated_at TEXT)`,
    ).run();
    const row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?")
      .bind(email)
      .first();
    userPreferences = row
      ? {
        name: row.name ?? null,
        previousProducts: JSON.parse(row.previous_products || "[]"),
        purchaseHistory: JSON.parse(row.purchase_history || "[]"),
        sessionCount: row.session_count || 0,
        lastActive: row.last_active ?? null,
      }
      : {
        name: null,
        previousProducts: [],
        purchaseHistory: [],
        sessionCount: 0,
        lastActive: null,
      };
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, name, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         session_count = session_count + 1,
         last_active = excluded.last_active,
         updated_at = excluded.updated_at`,
    )
      .bind(
        email,
        userPreferences.name,
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
 *    category. Same pattern as getCrossSellSuggestions — a
 *    preferred_categories column would have been the more direct source
 *    but never had a writer and was removed as dead schema.
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

/**
 * Last N *paid* orders for the account behind a session — used to inject
 * "they previously bought X, Y" into Gemini's system instruction (see
 * useGeminiLive.ts), so a returning signed-in shopper doesn't have to
 * re-describe what they usually buy.
 *
 * Deliberately reads the orders table directly rather than
 * user_preferences.purchase_history: that column is only a deduped list of
 * product ids (written by the Razorpay webhook), with no order date or
 * amount, and de-duping loses "bought the same hoodie twice" as a signal.
 * orders.items_json already carries product names, so this needs no join
 * against products (which may have since changed price or gone out of
 * stock — the historical name is what actually shipped, not today's list).
 *
 * Scoped by session_id -> sessions.user_id, exactly like name/preferences,
 * so it reads identically for guest vs signed-in without special-casing:
 * a guest session (user_id null) has no account to look up and gets an
 * empty history, not an error.
 *
 * Only status='paid' counts — an abandoned or failed checkout was never a
 * purchase and would be a confusing thing for Sanchay to bring up ("last
 * time you bought a hoodie" when that checkout actually failed).
 */
export async function getPurchaseHistory(
  env: Env,
  sessionId: string,
  limit = 2,
): Promise<{ orderId: string; amountPaise: number; items: { name: string; quantity: number }[]; createdAt: string }[]> {
  const sess: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?").bind(sessionId).first();
  const userId = sess?.user_id as string | null;
  if (!userId) return [];

  const rows: any[] = (
    await env.DB.prepare(
      `SELECT o.razorpay_order_id, o.amount, o.items_json, o.created_at
       FROM orders o
       JOIN sessions s ON s.id = o.session_id
       WHERE s.user_id = ? AND o.status = 'paid'
       ORDER BY o.created_at DESC
       LIMIT ?`,
    )
      .bind(userId, limit)
      .all()
  ).results ?? [];

  return rows.map((r) => {
    let items: { name: string; quantity: number }[] = [];
    try {
      const parsed = JSON.parse(r.items_json || "[]");
      items = Array.isArray(parsed)
        ? parsed.map((i: any) => ({ name: String(i.name ?? "item"), quantity: Number(i.quantity) || 1 }))
        : [];
    } catch { /* malformed items_json — treat as no items rather than throw */ }
    return {
      orderId: r.razorpay_order_id as string,
      amountPaise: r.amount as number,
      items,
      createdAt: r.created_at as string,
    };
  });
}

/**
 * Full account profile for the "tell the shopper about their own history,
 * and use it to bias search toward what they actually like" tool
 * (check_account_profile in useGeminiLive.ts / GET /api/account/profile in
 * api/account.ts). Distinct from getPurchaseHistory (which only returns 2
 * orders for the greeting's background context) — this is the on-demand,
 * shopper-requested version: more orders, plus derived signals
 * (favoriteCategories, totalSpentPaise) getPurchaseHistory has no reason
 * to compute for a greeting line.
 *
 * favoriteCategories is derived the same way getCrossSellSuggestions
 * already does — categories of products actually appearing in PAID
 * orders' items_json, joined against products.category. An earlier
 * user_preferences.preferred_categories column would have been the
 * "obvious" source but was always empty (no writer ever existed) and was
 * removed as dead schema.
 *
 * Deliberately does NOT take a userId parameter from the caller — the
 * caller only ever gets ITS OWN account's profile, resolved from userId
 * (already validated as this account's real, OTP-verified identity by
 * handleAccountProfile before this is called). There is no "whose
 * profile" argument anywhere in this function's signature on purpose.
 */
export async function getAccountProfile(
  env: Env,
  userId: string,
): Promise<{
  email: string;
  name: string | null;
  memberSince: string | null;
  totalOrders: number;
  totalSpentPaise: number;
  favoriteCategories: string[];
  recentOrders: { orderId: string; amountPaise: number; items: { name: string; quantity: number }[]; createdAt: string }[];
}> {
  const ORDER_CAP = 10; // recentOrders is bounded — a shopper-requested summary, not a full account export

  const [userRow, prefsRow, totalsRow, orderRows] = await Promise.all([
    env.DB.prepare("SELECT email, created_at FROM users WHERE id = ?").bind(userId).first<any>(),
    env.DB.prepare("SELECT name FROM user_preferences WHERE user_id = ?").bind(userId).first<any>(),
    // True lifetime totals — computed separately from recentOrders below so
    // "total spent" reflects the WHOLE paid history, not just however many
    // of the most recent orders fit under the display cap.
    env.DB.prepare(
      `SELECT COUNT(*) as c, COALESCE(SUM(o.amount), 0) as total
       FROM orders o
       JOIN sessions s ON s.id = o.session_id
       WHERE s.user_id = ? AND o.status = 'paid'`,
    )
      .bind(userId)
      .first<any>(),
    (
      await env.DB.prepare(
        `SELECT o.razorpay_order_id, o.amount, o.items_json, o.created_at
         FROM orders o
         JOIN sessions s ON s.id = o.session_id
         WHERE s.user_id = ? AND o.status = 'paid'
         ORDER BY o.created_at DESC
         LIMIT ?`,
      )
        .bind(userId, ORDER_CAP)
        .all()
    ).results ?? [],
  ]);

  const recentOrders = (orderRows as any[]).map((r) => {
    let items: { name: string; quantity: number; productId?: string }[] = [];
    try {
      const parsed = JSON.parse(r.items_json || "[]");
      items = Array.isArray(parsed)
        ? parsed.map((i: any) => ({ name: String(i.name ?? "item"), quantity: Number(i.quantity) || 1, productId: i.productId }))
        : [];
    } catch { /* malformed items_json — treat as no items rather than throw */ }
    return {
      orderId: r.razorpay_order_id as string,
      amountPaise: r.amount as number,
      items: items.map(({ name, quantity }) => ({ name, quantity })),
      createdAt: r.created_at as string,
    };
  });

  const totalOrders = (totalsRow?.c as number) ?? 0;
  const totalSpentPaise = (totalsRow?.total as number) ?? 0;

  // Favorite categories — every distinct product id across all paid
  // orders (not just the capped recentOrders view above; this reruns the
  // same JOIN so the signal reflects full purchase history even beyond the
  // 10-order display cap).
  let favoriteCategories: string[] = [];
  try {
    const allItemsRows: any[] = (
      await env.DB.prepare(
        `SELECT o.items_json
         FROM orders o
         JOIN sessions s ON s.id = o.session_id
         WHERE s.user_id = ? AND o.status = 'paid'`,
      )
        .bind(userId)
        .all()
    ).results ?? [];
    const productIds = new Set<string>();
    for (const row of allItemsRows) {
      try {
        const parsed = JSON.parse(row.items_json || "[]");
        if (Array.isArray(parsed)) for (const i of parsed) if (i.productId) productIds.add(String(i.productId));
      } catch { /* skip malformed row */ }
    }
    if (productIds.size > 0) {
      const ids = [...productIds];
      const placeholders = ids.map(() => "?").join(",");
      const catRows: any[] = (
        await env.DB.prepare(`SELECT category, COUNT(*) as c FROM products WHERE id IN (${placeholders}) GROUP BY category ORDER BY c DESC`)
          .bind(...ids)
          .all()
      ).results ?? [];
      favoriteCategories = catRows.map((r) => r.category as string).filter(Boolean).slice(0, 5);
    }
  } catch (e) {
    console.error("getAccountProfile: favoriteCategories derivation failed:", e);
  }

  return {
    email: (userRow?.email as string) ?? userId,
    name: (prefsRow?.name as string | null) ?? null,
    memberSince: (userRow?.created_at as string | null) ?? null,
    totalOrders,
    totalSpentPaise,
    favoriteCategories,
    recentOrders,
  };
}

/** Distinct products logged as "seen" this session before a dwell-time
 *  debounce is applied — see logViewedProduct's own comment for why a
 *  fixed cap matters here the same way it does for purchase history. */
const VIEWED_PRODUCTS_CAP = 8;

/**
 * Records that a floating product-detail window for this product stayed
 * open long enough to count as a genuine "seen" signal — called from
 * handleLogViewedProduct (api/viewedProducts.ts) once the frontend's own
 * dwell-time debounce (MIN_DWELL_MS, see useProductWindows.ts) has already
 * elapsed, not on every open event. Without that debounce upstream, a
 * misfire (double-tap, or the model opening then immediately closing to
 * correct a wrong product_id) would log a "seen" that never really
 * happened and later get pitched back to the shopper as if it had.
 *
 * Upsert, not insert — reopening something already seen this session
 * bumps last_viewed_at instead of adding a duplicate row, so "recently
 * seen" reflects genuine recency rather than repeat-view noise.
 */
export async function logViewedProduct(env: Env, sessionId: string, productId: string): Promise<void> {
  const product = await env.DB.prepare("SELECT name FROM products WHERE id = ?").bind(productId).first<{ name: string }>();
  if (!product) return; // a hallucinated/stale id — nothing real to log

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO viewed_products (session_id, product_id, product_name, first_viewed_at, last_viewed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id, product_id) DO UPDATE SET last_viewed_at = excluded.last_viewed_at`,
  )
    .bind(sessionId, productId, product.name, now, now)
    .run();
}

/**
 * Recently seen products for THIS session, capped and newest-first — used
 * two ways: (1) injected into the greeting as background context (mirrors
 * fetchHistorySummary's purchase-history line — "never volunteer
 * unprompted" applies identically here, see useGeminiLive.ts), and (2)
 * available to check_account_profile-style tools so the agent can pitch
 * back something the shopper looked at but never bought, without needing
 * its own memory of the call to do so.
 *
 * Scoped by session_id directly (not through sessions.user_id like
 * getPurchaseHistory) — "seen" is meaningful even for a guest who never
 * signs in, unlike purchase history which requires a real account to
 * exist at all. If this session's user_id later changes via
 * migrateGuestSessionToUser, these rows are already attached to the same
 * session_id and need no separate merge step.
 */
export async function getViewedProducts(
  env: Env,
  sessionId: string,
  limit = VIEWED_PRODUCTS_CAP,
): Promise<{ productId: string; name: string; lastViewedAt: string }[]> {
  const rows: any[] = (
    await env.DB.prepare(
      "SELECT product_id, product_name, last_viewed_at FROM viewed_products WHERE session_id = ? ORDER BY last_viewed_at DESC LIMIT ?",
    )
      .bind(sessionId, limit)
      .all()
  ).results ?? [];
  return rows.map((r) => ({ productId: r.product_id as string, name: r.product_name as string, lastViewedAt: r.last_viewed_at as string }));
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

  // Remember what this session was just shown, so a subsequent add_to_cart
  // with a wrong id can be resolved against it (see addToCart below) instead
  // of only failing. Best-effort and never blocks the search response — a
  // cache-write failure must not turn a working search into an error.
  if (sessionId && products.length > 0) {
    await cacheSearchResults(env, sessionId, products).catch((e) =>
      console.error("search_result_cache write failed:", e),
    );
  }
  const body = { success: true as const, data: { query, products } };
  await logCall(env, sessionId, "/api/catalog", { query, limit }, body);
  return { status: 200, body };
}

/**
 * Removes exactly the items (and quantities) of a paid order from
 * cart_items — never the whole cart, since items added AFTER checkout
 * started (before payment completed) legitimately belong in the cart
 * still. Per product: if the cart quantity is <= what was paid for,
 * delete the line entirely; otherwise decrement by the paid quantity and
 * leave the remainder (extra added post-checkout).
 *
 * Shared between two call sites that both need this, for different
 * reasons:
 *  - the Razorpay webhook (fast path — clears the instant payment.captured
 *    arrives, which is the common case)
 *  - getCartPayload's self-heal below (safety net — webhook delivery is
 *    async and can be delayed or, per Razorpay's own docs, occasionally
 *    dropped; without this, a session that reloads before the webhook
 *    lands would see already-paid items sitting in the cart, and every
 *    later cart READ is a chance to notice and fix that instead of the
 *    correctness of the UI depending on webhook timing)
 */
export async function clearPaidItemsFromCart(
  env: Env,
  sessionId: string,
  itemsJson: string | null,
): Promise<void> {
  if (!itemsJson) return;
  let items: { productId: string; quantity: number }[];
  try {
    items = JSON.parse(itemsJson);
  } catch {
    return;
  }
  for (const item of items) {
    if (!item.productId || !item.quantity) continue;
    const row: any = await env.DB.prepare(
      "SELECT id, quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
    )
      .bind(sessionId, item.productId)
      .first();
    if (!row) continue;
    if (row.quantity <= item.quantity) {
      await env.DB.prepare("DELETE FROM cart_items WHERE id = ?").bind(row.id).run();
    } else {
      await env.DB.prepare("UPDATE cart_items SET quantity = quantity - ? WHERE id = ?")
        .bind(item.quantity, row.id)
        .run();
    }
  }
}

/**
 * Self-heal pass run on every cart read — cheap existence check first
 * (most reads find nothing to reconcile), only doing the per-item cleanup
 * work when this session actually has a paid order. Idempotent: once an
 * order's items are gone from cart_items, re-running this for the same
 * order is a no-op (clearPaidItemsFromCart finds no matching row and
 * skips it).
 */
async function reconcilePaidOrders(env: Env, sessionId: string): Promise<void> {
  // Only orders NOT yet cleared — without this filter, a paid order's
  // items were re-cleared on literally every future cart read forever,
  // which silently deleted a legitimate LATER add of the same product
  // (a normal repeat purchase) the moment the very next reconciliation
  // pass ran — see cart_cleared's own comment in schema.sql.
  const paidOrders: any[] = (
    await env.DB.prepare("SELECT id, items_json FROM orders WHERE session_id = ? AND status = 'paid' AND cart_cleared = 0")
      .bind(sessionId)
      .all()
  ).results ?? [];
  for (const row of paidOrders) {
    await clearPaidItemsFromCart(env, sessionId, row.items_json);
    await env.DB.prepare("UPDATE orders SET cart_cleared = 1 WHERE id = ?").bind(row.id).run();
  }
}

/**
 * Eagerly expires a stale created/attempted order on read, rather than only
 * lazily reclaiming it the next time checkoutCart happens to run (which is
 * what RESERVATION_TIMEOUT_MS originally only guarded). Without this, the
 * "pending payment" banner and its countdown had no actual trigger to
 * disappear on — the frontend would need to be trusted to hide it once its
 * own timer hit zero, but the order (and its stock reservation) would still
 * be alive server-side until the shopper happened to call checkout again.
 * Since GET /api/cart is already polled every few seconds by the frontend,
 * this makes expiry visible almost immediately after the real deadline,
 * without needing a scheduled Worker.
 *
 * Applies to BOTH 'created' (never attempted) and 'attempted' (tried and
 * failed/abandoned) orders — an attempted order sitting forever with no
 * expiry would lock its reserved stock indefinitely, the same problem this
 * exists to prevent for 'created' orders.
 */
async function reconcileExpiredOrders(env: Env, sessionId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RESERVATION_TIMEOUT_MS).toISOString();
  const stale: any[] = (
    await env.DB.prepare(
      "SELECT id, items_json, stock_released FROM orders WHERE session_id = ? AND status IN ('created','attempted') AND created_at < ?",
    )
      .bind(sessionId, cutoff)
      .all()
  ).results ?? [];
  for (const row of stale) {
    // stock_released=1 means a payment.failed webhook already returned
    // this order's stock (see handlePaymentFailed in api/webhook.ts) —
    // releasing it again here would credit phantom stock that was never
    // re-reserved.
    if (!row.stock_released) {
      await releaseOrderStock(env, row.items_json);
    }
    await env.DB.prepare("UPDATE orders SET status = 'cancelled', stock_released = 1 WHERE id = ?").bind(row.id).run();
  }
}

async function getCartPayload(env: Env, sessionId: string) {
  await reconcilePaidOrders(env, sessionId);
  await reconcileExpiredOrders(env, sessionId);
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
 *     empty cart). An earlier `preferred_categories` column existed on
 *     user_preferences but was always empty (nothing ever wrote it) and
 *     was removed as dead schema — this signal was always meant to come
 *     from real purchase/browse behavior, not a fabricated preference.
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
 * Sets, updates, or clears the session's budget mid-conversation. Exists
 * because the voice persona is expected to acknowledge and enforce a
 * budget the shopper states verbally (e.g. "keep me under 2000 rupees") —
 * without this tool, budget_paise could only ever be set once at session
 * start, so a spoken budget had no real backend effect even though the
 * persona described handling it.
 *
 * Deliberately session-scoped, never account-scoped: budget_paise lives
 * on `sessions`, not `user_preferences` (which has no budget column at
 * all — an earlier `budget_preference` column existed but was always
 * NULL and was removed as dead schema). A budget set today has no
 * bearing on tomorrow's session, signed in or not — every session starts
 * uncapped unless the shopper states one again. This is what makes "the
 * cap is temporary" true, not a policy this function has to enforce.
 *
 * Rejects a budget lower than what's already committed in the cart rather
 * than silently accepting a number that would make the existing cart
 * invalid — the shopper is told to remove items first instead.
 *
 * clearBudget=true removes the cap entirely (e.g. "remove my budget",
 * "no limit") — the one budget change that legitimately isn't "set to a
 * number", so it's a separate explicit path rather than overloading 0 or
 * a negative number to mean "no cap" (both are validation failures, and
 * should stay that way — a spoken "zero" is far more likely to be a
 * misheard number than an intentional "uncap me").
 */
export async function setBudget(
  env: Env,
  sessionId: string,
  budgetInput: unknown,
  clearBudget = false,
): Promise<LogicResult> {
  if (clearBudget) {
    await env.DB.prepare("UPDATE sessions SET budget_paise = NULL WHERE id = ?").bind(sessionId).run();
    const cart = await getCartPayload(env, sessionId);
    const body = {
      success: true as const,
      data: { budget: null, budget_display: null, budgetRemaining: null },
    };
    await logCall(env, sessionId, "/api/session/budget", { clear: true }, body);
    void cart; // no remaining-budget math needed once uncapped
    return { status: 200, body };
  }

  const budget = Number(budgetInput);
  if (!Number.isFinite(budget) || budget <= 0) {
    const body = { success: false, error: "budget must be a positive number" };
    await logCall(env, sessionId, "/api/session/budget", { budget: budgetInput }, body);
    return { status: 400, body };
  }
  // Guards against a budget so large it can't round-trip through
  // budget_paise (an INTEGER column) without overflow/precision loss —
  // ₹10 crore is already far beyond anything this catalog could ever
  // total, so this is a sanity ceiling, not a real business limit.
  if (budget > 10_000_000) {
    const body = { success: false, error: "budget must be ₹1,00,00,000 or less" };
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

/**
 * The session's most recent unpaid-but-still-active order (created or
 * attempted), if any — lets the frontend show "resume payment" immediately
 * on page load, before the shopper clicks Pay again. Without this, a
 * reload wipes the frontend's local payment-state (plain React state, not
 * persisted), so a shopper who started paying, closed the tab, and came
 * back would see a plain cart with no indication they already have an
 * order in flight — clicking Pay again is actually safe (checkoutCart's
 * idempotency reuses the same order), but nothing tells them that.
 */
async function getPendingOrder(
  env: Env,
  sessionId: string,
): Promise<{ orderId: string; amountPaise: number; paymentUrl: string | null; expiresInSeconds: number; lastAttemptFailed: boolean } | null> {
  const row: any = await env.DB.prepare(
    "SELECT razorpay_order_id, amount, payment_url, status, created_at FROM orders WHERE session_id = ? AND status IN ('created','attempted') ORDER BY created_at DESC LIMIT 1",
  )
    .bind(sessionId)
    .first();
  if (!row) return null;
  // Server-computed, not left for the frontend to guess from its own
  // clock — the countdown shown to the shopper (and reported to Gemini's
  // check_payment_status tool) must agree with when reconcileExpiredOrders
  // will actually act, or the UI could show time remaining on an order
  // that's already been expired-and-released.
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  const expiresInSeconds = Math.max(0, Math.round((RESERVATION_TIMEOUT_MS - ageMs) / 1000));
  return {
    orderId: row.razorpay_order_id,
    amountPaise: row.amount,
    paymentUrl: row.payment_url ?? null,
    expiresInSeconds,
    // 'attempted' status means a prior payment.failed webhook already
    // marked it — see handleRazorpayWebhook. Surfaced so the frontend can
    // show "your last attempt failed, try again" instead of the generic
    // "waiting for payment" banner for an order that hasn't actually been
    // tried yet.
    lastAttemptFailed: row.status === "attempted",
  };
}

/**
 * The session's single most recent order, of ANY status — not just an
 * active pending one. Exists specifically to fix an ambiguity in
 * check_payment_status (see useGeminiLive.ts): once a payment succeeds,
 * getPendingOrder correctly returns null (nothing left to resume), but
 * "no pending order" reads identically whether the shopper just paid,
 * had their reservation expire, or never checked out at all. Without this,
 * asking "did my payment go through" right after paying got back
 * {hasPendingPayment:false} with zero further signal, and the agent had no
 * basis to say anything but "no" — even though the true answer was "yes,
 * already paid".
 */
async function getMostRecentOrder(
  env: Env,
  sessionId: string,
): Promise<{ status: string; amountPaise: number } | null> {
  const row: any = await env.DB.prepare(
    "SELECT status, amount FROM orders WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(sessionId)
    .first();
  if (!row) return null;
  return { status: row.status as string, amountPaise: row.amount as number };
}

export async function getCart(env: Env, sessionId: string): Promise<LogicResult> {
  const cart = await getCartPayload(env, sessionId);
  const budget = await getBudget(env, sessionId);
  const youMightAlsoLike = await getCrossSellSuggestions(env, sessionId);
  const pendingOrder = await getPendingOrder(env, sessionId);
  const lastOrder = await getMostRecentOrder(env, sessionId);
  const body = {
    success: true as const,
    data: {
      ...cart,
      budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total),
      youMightAlsoLike,
      pendingOrder,
      lastOrder,
      // isSignedIn is deliberately NOT computed here from sessions.user_id —
      // handleCartGet fills it in from a verified bearer token instead. See
      // the comment on handleCheckout's auth gate for why user_id alone is
      // not proof of a real sign-in (the older startSession({user_email})
      // path sets it with no authentication at all).
      isSignedIn: false,
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

interface CachedSearchResult {
  productId: string;
  name: string;
}

async function cacheSearchResults(
  env: Env,
  sessionId: string,
  products: Record<string, unknown>[],
): Promise<void> {
  const slim: CachedSearchResult[] = products
    .map((p) => ({ productId: String(p.productId ?? ""), name: String(p.name ?? "") }))
    .filter((p) => p.productId);
  if (slim.length === 0) return;
  await env.DB.prepare(
    `INSERT INTO search_result_cache (session_id, results_json, created_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET results_json = excluded.results_json, created_at = excluded.created_at`,
  )
    .bind(sessionId, JSON.stringify(slim), new Date().toISOString())
    .run();
}

type CacheLookupResult =
  | { kind: "resolved"; productId: string }
  | { kind: "unresolved"; cached: CachedSearchResult[] }
  | { kind: "no_cache" };

/**
 * Checks a product_id that doesn't exist against what this session was
 * actually just shown by search_catalog.
 *
 * Deliberately does NOT fuzzy-match names — tested against the real case
 * that motivated this (a fabricated id "TSHIRT-BLK-001" for a product
 * actually named "Black Classic Tee"): word-overlap and trigram similarity
 * both score it at zero against the real name, because "tshirt"/"tee" and
 * "blk"/"black" are abbreviation pairs, not textually similar strings.
 * Guessing anyway risks silently adding the WRONG product for a genuinely
 * unrelated id, which is worse than the failure this exists to fix. So the
 * only auto-resolved case is an id that matches a cached one exactly once
 * case/punctuation is normalized away; anything else returns the cached
 * list so the caller can be told the real choices instead of a dead end.
 */
async function lookupCachedProductId(
  env: Env,
  sessionId: string,
  wrongId: string,
): Promise<CacheLookupResult> {
  const row = await env.DB.prepare("SELECT results_json FROM search_result_cache WHERE session_id = ?")
    .bind(sessionId)
    .first<{ results_json: string }>();
  if (!row) return { kind: "no_cache" };

  let cached: CachedSearchResult[];
  try {
    cached = JSON.parse(row.results_json);
  } catch {
    return { kind: "no_cache" };
  }
  if (cached.length === 0) return { kind: "no_cache" };

  const normalizeId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const target = normalizeId(wrongId);
  const idMatch = cached.find((p) => normalizeId(p.productId) === target);
  if (idMatch) return { kind: "resolved", productId: idMatch.productId };

  // The caller may have sent the product's spoken name instead of its id —
  // e.g. "Black Classic Tee" — which is not a guess, it's the exact value
  // this session was just shown. Exact (case/whitespace-insensitive) match
  // only; no partial or fuzzy matching, so an unrelated or ambiguous string
  // still falls through to "unresolved" rather than picking a wrong item.
  const normalizeName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  const target2 = normalizeName(wrongId);
  const nameMatch = cached.find((p) => normalizeName(p.name) === target2);
  if (nameMatch) return { kind: "resolved", productId: nameMatch.productId };

  return { kind: "unresolved", cached };
}

/**
 * Full product info for one or more ids, backing the "show floating detail
 * window(s)" voice tool (show_product_detail in useGeminiLive.ts /
 * handleProductDetails in api/productDetails.ts). Distinct from
 * searchCatalog: this is a direct-by-id lookup with no query/ranking, used
 * once the shopper (or model) already knows which specific products they
 * mean, not for discovery.
 *
 * Each requested id independently resolves or fails — a mix of good and
 * bad ids in one call returns detail for the good ones and lists the bad
 * ones separately, rather than failing the whole batch for one wrong id
 * (which the model recovers from the same way add_to_cart already does:
 * lookupCachedProductId self-heals a slightly-wrong id against this
 * session's last search_catalog results before giving up on it).
 */
export async function getProductDetails(
  env: Env,
  sessionId: string,
  productIds: string[],
): Promise<{
  found: { productId: string; name: string; description: string; price: number; price_display: string; category: string; stock: number; image_url: string | null }[];
  notFound: string[];
}> {
  const found: { productId: string; name: string; description: string; price: number; price_display: string; category: string; stock: number; image_url: string | null }[] = [];
  const notFound: string[] = [];

  for (const rawId of productIds) {
    let id = rawId;
    let row = await env.DB.prepare("SELECT id, name, description, price, category, stock, image_url FROM products WHERE id = ?")
      .bind(id)
      .first<any>();

    if (!row && sessionId) {
      const lookup = await lookupCachedProductId(env, sessionId, rawId);
      if (lookup.kind === "resolved") {
        id = lookup.productId;
        row = await env.DB.prepare("SELECT id, name, description, price, category, stock, image_url FROM products WHERE id = ?")
          .bind(id)
          .first<any>();
      }
    }

    if (!row) {
      notFound.push(rawId);
      continue;
    }

    found.push({
      productId: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      price_display: `₹${(row.price / 100).toLocaleString("en-IN")}`,
      category: row.category,
      stock: row.stock,
      image_url: row.image_url ?? null,
    });
  }

  return { found, notFound };
}

// ---------------------------------------------------------------------------
// Two-phase cart changes: propose (resolve + preview, no write) then confirm
// (redeem a token minted moments ago, then and only then mutate). See the
// comment on pending_actions in schema.sql for why this exists — it turns
// "the caller must construct a correct request" into "the caller must echo
// back a token we handed them seconds ago," which is a much smaller thing
// for a voice agent (or a misconfigured dashboard tool) to get right, and
// makes an abandoned proposal distinguishable from an executed one in the
// audit trail instead of the two looking identical.
// ---------------------------------------------------------------------------

const PENDING_ACTION_TTL_MS = 90 * 1000;

async function ensurePendingActionsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS pending_actions (
      token TEXT PRIMARY KEY, session_id TEXT NOT NULL, action TEXT NOT NULL,
      payload_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      consumed_at TEXT)`,
  ).run();
}

interface ProposedAdd {
  kind: "add";
  productId: string;
  name: string;
  price: number;
  price_display: string;
  quantity: number;
  correctedFrom?: string;
}
interface ProposedRemove {
  kind: "remove";
  productId: string;
  name: string;
  quantity: number; // the actual amount that will be removed (may be less than requested)
  wholeLine: boolean;
}

/**
 * Resolves and previews an add-to-cart WITHOUT writing to cart_items. Reuses
 * the exact same product lookup / cache resolution as addToCart so the two
 * paths can never disagree about what a given input resolves to — only the
 * final atomic write (guarded upsert) is skipped here.
 */
export async function proposeAddToCart(
  env: Env,
  sessionId: string,
  productIdInput: string,
  quantityInput?: unknown,
): Promise<LogicResult> {
  let productId = productIdInput;
  const parsedQty = parseQuantityInput(quantityInput);
  if (!parsedQty.ok) {
    const body = { success: false, error: "quantity must be an integer 1-99" };
    await logCall(env, sessionId, "/api/cart/propose-add", { product_id: productId, quantity: quantityInput }, body);
    return { status: 400, body };
  }
  const qty = parsedQty.value ?? 1;

  let product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
    .bind(productId)
    .first<any>();
  let resolvedFrom: string | null = null;

  if (!product) {
    const lookup = sessionId ? await lookupCachedProductId(env, sessionId, productId) : { kind: "no_cache" as const };
    if (lookup.kind === "resolved") {
      resolvedFrom = productId;
      productId = lookup.productId;
      product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
        .bind(productId)
        .first<any>();
    }
    if (!product) {
      const choices =
        lookup.kind === "unresolved"
          ? ` The last search in this session showed: ${lookup.cached.map((p) => `${p.name} (id "${p.productId}")`).join(", ")}.`
          : "";
      const body = {
        success: false,
        error: `No product with id "${productId}".${choices} Call search_catalog and use the exact productId field from its response.`,
      };
      await logCall(env, sessionId, "/api/cart/propose-add", { product_id: productId, quantity: qty }, body);
      return { status: 404, body };
    }
  }

  if (product.stock <= 0) {
    const body = { success: false, error: "Out of stock" };
    await logCall(env, sessionId, "/api/cart/propose-add", { product_id: productId, quantity: qty }, body);
    return { status: 200, body };
  }

  const existing: any = await env.DB.prepare(
    "SELECT quantity FROM cart_items WHERE session_id = ? AND product_id = ?",
  )
    .bind(sessionId, productId)
    .first();
  const already = existing?.quantity ?? 0;
  if (already + qty > product.stock) {
    const available = Math.max(0, product.stock - already);
    const body = {
      success: false,
      error: available === 0 ? "No more stock available" : `Only ${available} more available (stock limit ${product.stock})`,
    };
    await logCall(env, sessionId, "/api/cart/propose-add", { product_id: productId, quantity: qty }, body);
    return { status: 200, body };
  }

  const budget = await getBudget(env, sessionId);
  const currentTotal: any = await env.DB.prepare(
    "SELECT COALESCE(SUM(price * quantity), 0) AS total FROM cart_items WHERE session_id = ?",
  )
    .bind(sessionId)
    .first();
  const newTotal = (currentTotal?.total ?? 0) + product.price * qty;
  if (budget != null && newTotal > budget) {
    const body = {
      success: false,
      error: `Exceeds budget of ₹${(budget / 100).toLocaleString("en-IN")}`,
    };
    await logCall(env, sessionId, "/api/cart/propose-add", { product_id: productId, quantity: qty }, body);
    return { status: 200, body };
  }

  const payload: ProposedAdd = {
    kind: "add",
    productId,
    name: product.name,
    price: product.price,
    price_display: `₹${(product.price / 100).toLocaleString("en-IN")}`,
    quantity: qty,
    ...(resolvedFrom ? { correctedFrom: resolvedFrom } : {}),
  };
  const token = await mintPendingAction(env, sessionId, payload);

  const body = {
    success: true as const,
    data: {
      action_token: token,
      expires_in_seconds: PENDING_ACTION_TTL_MS / 1000,
      preview: {
        product_id: productId,
        name: product.name,
        quantity: qty,
        price_display: payload.price_display,
        line_total_display: `₹${((product.price * qty) / 100).toLocaleString("en-IN")}`,
        new_cart_total_display: `₹${(newTotal / 100).toLocaleString("en-IN")}`,
        ...(resolvedFrom ? { correctedProductId: { from: resolvedFrom, to: productId } } : {}),
      },
    },
  };
  await logCall(env, sessionId, "/api/cart/propose-add", { product_id: productId, quantity: qty }, body);
  return { status: 200, body };
}

/**
 * Resolves and previews a removal WITHOUT writing to cart_items. Mirrors
 * removeFromCart's cache-free resolution (matching against the CART itself,
 * not a search cache — the cart is ground truth for what can be removed).
 */
export async function proposeRemoveFromCart(
  env: Env,
  sessionId: string,
  productIdInput: string,
  quantityInput?: unknown,
): Promise<LogicResult> {
  let productId = productIdInput;
  const parsedQty = parseQuantityInput(quantityInput);
  if (!parsedQty.ok) {
    const body = { success: false, error: "quantity must be an integer 1-99" };
    await logCall(env, sessionId, "/api/cart/propose-remove", { product_id: productId, quantity: quantityInput }, body);
    return { status: 400, body };
  }

  const rows = (
    await env.DB.prepare("SELECT product_id, product_name, quantity FROM cart_items WHERE session_id = ?")
      .bind(sessionId)
      .all<any>()
  ).results ?? [];

  const normalizeId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const normalizeName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  const target = normalizeId(productId);
  const targetName = normalizeName(productId);
  const existing =
    rows.find((r: any) => normalizeId(r.product_id) === target) ??
    rows.find((r: any) => normalizeName(r.product_name) === targetName);

  if (!existing) {
    const body = {
      success: false,
      error: `"${productId}" isn't in the cart. Call get_cart to see the exact product_id and name of what's actually there.`,
    };
    await logCall(env, sessionId, "/api/cart/propose-remove", { product_id: productId }, body);
    return { status: 200, body };
  }

  const requested = parsedQty.value ?? existing.quantity;
  const removedQty = Math.min(requested, existing.quantity);
  const wholeLine = removedQty >= existing.quantity;

  const payload: ProposedRemove = {
    kind: "remove",
    productId: existing.product_id,
    name: existing.product_name,
    quantity: removedQty,
    wholeLine,
  };
  const token = await mintPendingAction(env, sessionId, payload);

  const body = {
    success: true as const,
    data: {
      action_token: token,
      expires_in_seconds: PENDING_ACTION_TTL_MS / 1000,
      preview: {
        product_id: existing.product_id,
        name: existing.product_name,
        quantity: removedQty,
        remaining_in_cart: wholeLine ? 0 : existing.quantity - removedQty,
      },
    },
  };
  await logCall(
    env,
    sessionId,
    "/api/cart/propose-remove",
    { product_id: existing.product_id, quantity: removedQty },
    body,
  );
  return { status: 200, body };
}

async function mintPendingAction(
  env: Env,
  sessionId: string,
  payload: ProposedAdd | ProposedRemove,
): Promise<string> {
  await ensurePendingActionsTable(env);
  const token = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO pending_actions (token, session_id, action, payload_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      token,
      sessionId,
      payload.kind,
      JSON.stringify(payload),
      new Date(now).toISOString(),
      new Date(now + PENDING_ACTION_TTL_MS).toISOString(),
    )
    .run();
  return token;
}

/**
 * Redeems a token minted by proposeAddToCart/proposeRemoveFromCart. This is
 * the ONLY path that actually mutates cart_items on the propose/confirm
 * side — a token that doesn't exist, was already consumed, expired, or
 * belongs to a different session all fail identically (no information about
 * WHY beyond "invalid or expired"), so a caller can't use this endpoint to
 * probe for other sessions' tokens.
 *
 * Re-resolves the underlying add/remove through the existing addToCart /
 * removeFromCart functions rather than duplicating their write logic — those
 * already contain the atomic, race-safe stock/budget guard, and every
 * safety property they have is inherited here for free. The token only ever
 * carries what was already validated at propose time; it does not bypass
 * addToCart's own live re-validation (stock or budget may have changed in
 * the seconds between propose and confirm, and that must still be caught).
 */
export async function confirmCartAction(
  env: Env,
  sessionId: string,
  token: string,
): Promise<LogicResult> {
  await ensurePendingActionsTable(env);
  const row: any = await env.DB.prepare(
    "SELECT session_id, action, payload_json, expires_at, consumed_at FROM pending_actions WHERE token = ?",
  )
    .bind(token)
    .first();

  const invalid = () => {
    const body = { success: false, error: "This action_token is invalid or has expired. Propose the change again." };
    return { status: 404, body };
  };

  if (!row || row.session_id !== sessionId || row.consumed_at) {
    const body = invalid().body;
    await logCall(env, sessionId, "/api/cart/confirm", { action_token: token }, body);
    return invalid();
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    const body = invalid().body;
    await logCall(env, sessionId, "/api/cart/confirm", { action_token: token }, body);
    return invalid();
  }

  // Mark consumed BEFORE executing the mutation. A token can only ever be
  // redeemed once even if the underlying add/remove itself fails (e.g.
  // stock vanished in the gap) — retrying means proposing again, which
  // re-previews against current state rather than blindly reusing a stale
  // preview.
  const claim = await env.DB.prepare(
    "UPDATE pending_actions SET consumed_at = ? WHERE token = ? AND consumed_at IS NULL",
  )
    .bind(new Date().toISOString(), token)
    .run();
  if (claim.meta.changes === 0) {
    // Lost a race against a concurrent confirm of the same token.
    const body = invalid().body;
    await logCall(env, sessionId, "/api/cart/confirm", { action_token: token }, body);
    return invalid();
  }

  const payload = JSON.parse(row.payload_json) as ProposedAdd | ProposedRemove;
  if (payload.kind === "add") {
    return addToCart(env, sessionId, payload.productId, payload.quantity);
  }
  return removeFromCart(env, sessionId, payload.productId, payload.quantity);
}

export async function addToCart(
  env: Env,
  sessionId: string,
  productIdInput: string,
  quantityInput?: unknown,
  idempotencyKey?: string,
): Promise<LogicResult> {
  // Reassigned below if the id is resolved against the session's last
  // search_catalog cache — see the not-found branch.
  let productId = productIdInput;

  const parsedQty = parseQuantityInput(quantityInput);
  if (!parsedQty.ok) {
    const body = { success: false, error: "quantity must be an integer 1-99" };
    await logCall(env, sessionId, "/api/cart/add", { product_id: productId, quantity: quantityInput }, body);
    return { status: 400, body };
  }
  const qty = parsedQty.value ?? 1;
  let params = { product_id: productId, quantity: qty };

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

  let product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
    .bind(productId)
    .first<any>();
  let resolvedFrom: string | null = null;

  if (!product) {
    // A wrong product_id here is almost always the caller inventing or
    // misremembering an id instead of using the exact value a prior
    // search_catalog call returned (observed live: "TSHIRT-BLK-001" sent for
    // a product actually named "Black Classic Tee", id "TEE-BLACK-001").
    // Check what this session was actually just shown before giving up —
    // this self-heals a wrong-case/punctuation id automatically, and for
    // anything else, hands back the real choices instead of a dead end.
    const lookup = sessionId ? await lookupCachedProductId(env, sessionId, productId) : { kind: "no_cache" as const };

    if (lookup.kind === "resolved") {
      resolvedFrom = productId;
      productId = lookup.productId; // everything below (upsert, insert, logging) must use the real id
      params = { product_id: productId, quantity: qty };
      product = await env.DB.prepare("SELECT id, name, price, stock FROM products WHERE id = ?")
        .bind(productId)
        .first<any>();
    }

    if (!product) {
      const choices =
        lookup.kind === "unresolved"
          ? ` The last search in this session showed: ${lookup.cached.map((p) => `${p.name} (id "${p.productId}")`).join(", ")}.`
          : "";
      const body = {
        success: false,
        error: `No product with id "${productId}".${choices} Call search_catalog and use the exact productId field from its response — never guess or construct an id from the product's name.`,
      };
      await logCall(env, sessionId, "/api/cart/add", params, body);
      await remember(404, body);
      return { status: 404, body };
    }
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
    data: {
      ...cart,
      budgetRemaining: budget == null ? null : Math.max(0, budget - cart.total),
      youMightAlsoLike,
      // Present only when the caller's product_id didn't exist and was
      // corrected against the session's last search results — surfaced so
      // the correction is visible (in the audit log and to the agent) rather
      // than silently substituting a different id than the one that was sent.
      ...(resolvedFrom ? { correctedProductId: { from: resolvedFrom, to: productId } } : {}),
    },
  };
  await logCall(env, sessionId, "/api/cart/add", params, body);
  await remember(200, body);
  return { status: 200, body };
}

export async function removeFromCart(
  env: Env,
  sessionId: string,
  productIdInput: string,
  quantityInput?: unknown,
): Promise<LogicResult> {
  let productId = productIdInput;

  const parsedQty = parseQuantityInput(quantityInput);
  if (!parsedQty.ok) {
    const body = { success: false, error: "quantity must be an integer 1-99" };
    await logCall(env, sessionId, "/api/cart/remove", { product_id: productId, quantity: quantityInput }, body);
    return { status: 400, body };
  }

  let existing: any = await env.DB.prepare(
    "SELECT id, product_id, quantity, product_name FROM cart_items WHERE session_id = ? AND product_id = ?",
  )
    .bind(sessionId, productId)
    .first();

  if (!existing) {
    // Resolve against what's actually IN THE CART right now — this is
    // stronger than the add_to_cart cache lookup, since the cart itself is
    // ground truth rather than a recent search. Matches on an id that only
    // differs by case/punctuation, or on the product's exact name as
    // currently shown in the cart. No fuzzy/partial matching, for the same
    // reason as add_to_cart: guessing risks removing the wrong line item.
    const rows = (
      await env.DB.prepare("SELECT id, product_id, quantity, product_name FROM cart_items WHERE session_id = ?")
        .bind(sessionId)
        .all<any>()
    ).results ?? [];

    const normalizeId = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const normalizeName = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
    const target = normalizeId(productId);
    const targetName = normalizeName(productId);

    const match =
      rows.find((r: any) => normalizeId(r.product_id) === target) ??
      rows.find((r: any) => normalizeName(r.product_name) === targetName);

    if (match) {
      existing = match;
      productId = match.product_id;
    }
  }

  if (!existing) {
    const body = {
      success: false,
      error: `"${productId}" isn't in the cart. Call get_cart to see the exact product_id and name of what's actually there.`,
    };
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

/** Restores stock for every item in a cancelled/abandoned/failed order —
 *  the exact inverse of the reservation decrement below. Exported so the
 *  webhook's payment.failed handler can release stock the instant an
 *  attempt definitively fails, rather than waiting for the next
 *  reconcileExpiredOrders pass. */
export async function releaseOrderStock(env: Env, itemsJson: string | null): Promise<void> {
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
  // Reconcile first — an active order older than RESERVATION_TIMEOUT_MS
  // (created OR attempted; see reconcileExpiredOrders) is released and
  // marked cancelled before the idempotency check below even runs, so a
  // checkout call after expiry always creates a genuinely fresh order
  // rather than checking an ageMs condition inline here that used to only
  // apply to 'created' orders (an 'attempted' order could sit forever).
  await reconcileExpiredOrders(env, sessionId);

  // Idempotency — a still-active (non-expired) order for this session is
  // returned as-is rather than creating a duplicate.
  const activeOrder: any = await env.DB.prepare(
    "SELECT id, razorpay_order_id, amount, payment_url, status, items_json, created_at FROM orders WHERE session_id = ? AND status IN ('created', 'attempted') ORDER BY created_at DESC LIMIT 1",
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
