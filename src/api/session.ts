import type { Env, UserPreferences } from "../types";
import { json, withApiLogging, logApiCall, type ApiResult } from "../middleware/audit";
import { validateSession } from "../middleware/session";

const PREFERENCES_DDL = `
  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY,
    preferred_categories TEXT,
    budget_preference INTEGER,
    previous_products TEXT,
    purchase_history TEXT,
    session_count INTEGER DEFAULT 0,
    last_active TEXT,
    updated_at TEXT
  );
`;

export async function handleSessionStart(request: Request, env: Env): Promise<Response> {
  let body: { user_email?: string; budget?: number } = {};
  try {
    body = await request.json();
  } catch {}

  const email = body.user_email?.trim() || null;
  const budgetPaise =
    typeof body.budget === "number" && Number.isFinite(body.budget) && body.budget > 0
      ? Math.round(body.budget)
      : null;

  const started = Date.now();
  let resultBody: Record<string, unknown>;
  let httpStatus = 200;
  const sessionId = crypto.randomUUID();
  const now = new Date();
  // 24h session window — carts and payment links stay reachable
  const expiresAt = new Date(now.getTime() + 24 * 3_600_000).toISOString();

  try {
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, status, expires_at, created_at, budget_paise) VALUES (?, ?, 'active', ?, ?, ?)",
    )
      .bind(sessionId, email, expiresAt, now.toISOString(), budgetPaise)
      .run();

    let userPreferences: UserPreferences | null = null;
    if (email) {
      userPreferences = await loadOrCreatePreferences(env, email);
    }

    resultBody = {
      success: true,
      data: { sessionId, userPreferences },
    };
  } catch (e) {
    console.error("session/start failed:", e);
    resultBody = { success: false, error: "Internal server error" };
    httpStatus = 500;
  }

  // Log attributed to the newly created session — it IS the first audit entry
  await logApiCall(env, {
    sessionId,
    endpoint: "/api/session/start",
    method: "POST",
    params: { user_email: email, budget: budgetPaise },
    response: resultBody,
    status: httpStatus === 200 ? "ok" : "error",
    durationMs: Date.now() - started,
  }).catch(() => {});

  return Response.json(resultBody, { status: httpStatus });
}

export async function loadOrCreatePreferences(env: Env, userId: string): Promise<UserPreferences> {
  await env.DB.prepare(PREFERENCES_DDL).run();

  const row: any = await env.DB.prepare("SELECT * FROM user_preferences WHERE user_id = ?")
    .bind(userId)
    .first();

  let prefs: UserPreferences;
  if (row) {
    prefs = {
      preferredCategories: JSON.parse(row.preferred_categories || "[]"),
      budgetPreference: row.budget_preference ?? null,
      previousProducts: JSON.parse(row.previous_products || "[]"),
      purchaseHistory: JSON.parse(row.purchase_history || "[]"),
      sessionCount: row.session_count || 0,
      lastActive: row.last_active ?? null,
    };
  } else {
    prefs = {
      preferredCategories: [],
      budgetPreference: null,
      previousProducts: [],
      purchaseHistory: [],
      sessionCount: 0,
      lastActive: null,
    };
    await env.DB.prepare(
      `INSERT INTO user_preferences (user_id, preferred_categories, budget_preference, previous_products, purchase_history, session_count, last_active, updated_at)
       VALUES (?, '[]', NULL, '[]', '[]', 0, NULL, ?)`,
    )
      .bind(userId, nowIso())
      .run();
  }
  return prefs;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function handleSessionEnd(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, request);

  return withApiLogging(
    env,
    {
      sessionId: session?.id ?? null,
      endpoint: "/api/session/end",
      method: "POST",
      params: { confirmed_checkout: undefined, call_disposition: undefined },
    },
    async () => {
      if (!session) return json({ success: false, error: "Invalid or expired session" }, 401);

      await env.DB.prepare("UPDATE sessions SET status = 'ended' WHERE id = ?")
        .bind(session.id)
        .run();

      // Write back cross-session memory from the final cart state
      if (session.userId) {
        await env.DB.prepare(PREFERENCES_DDL).run();
        const cartRows: any[] = (
          await env.DB.prepare(
            "SELECT product_id FROM cart_items WHERE session_id = ?",
          )
            .bind(session.id)
            .all()
        ).results ?? [];
        const productIds = cartRows.map((r) => r.product_id);

        const prefsRow: any = await env.DB.prepare(
          "SELECT preferred_categories, budget_preference, previous_products, purchase_history, session_count FROM user_preferences WHERE user_id = ?",
        )
          .bind(session.userId)
          .first();

        if (prefsRow) {
          const existingPrevious: string[] = JSON.parse(prefsRow.previous_products || "[]");
          const mergedPrevious = [...new Set([...existingPrevious, ...productIds])];
          await env.DB.prepare(
            "UPDATE user_preferences SET previous_products = ?, budget_preference = COALESCE(?, budget_preference), updated_at = ? WHERE user_id = ?",
          )
            .bind(JSON.stringify(mergedPrevious), session.budgetPaise, nowIso(), session.userId)
            .run();
        }
      }

      return json({ success: true });
    },
  );
}

