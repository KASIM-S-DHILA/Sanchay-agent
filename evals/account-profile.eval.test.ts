import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";
import { signIn } from "./helpers/auth";

/**
 * Covers GET /api/account/profile (src/api/account.ts) — the full account
 * profile backing the check_account_profile voice tool ("tell me my order
 * history", "what have I bought before", "how much have I spent").
 *
 * The central property under test, mirroring the checkout auth gate: this
 * endpoint requires a REAL, OTP-verified bearer token, not merely
 * sessions.user_id being set (which can also come from the older,
 * unauthenticated startSession({user_email}) path — see the comment in
 * account.ts for why that's not sufficient here either, and is arguably a
 * MORE serious gap for this endpoint than for checkout, since this
 * returns full order history and lifetime spend rather than just
 * unlocking a payment action).
 */

let env: any;
const START = "https://test/api/session/start";

async function startSession(body: Record<string, unknown> = {}): Promise<string> {
  const res = await SELF.fetch(START, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  return json.data.sessionId;
}

async function getProfile(sessionId: string, token?: string) {
  const res = await SELF.fetch("https://test/api/account/profile", {
    headers: { "x-session-id": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function insertPaidOrder(
  sessionId: string,
  items: { productId: string; name: string; quantity: number }[],
  amountPaise: number,
  createdAt = new Date().toISOString(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at)
     VALUES (?, ?, ?, ?, 'INR', 'paid', ?, ?)`,
  )
    .bind(crypto.randomUUID(), sessionId, `order_${crypto.randomUUID().slice(0, 8)}`, amountPaise, JSON.stringify(items), createdAt)
    .run();
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Account profile: authentication gate", () => {
  it("a guest (no bearer token) is rejected with 403, not given empty/fake data", async () => {
    const sessionId = await startSession();
    const { status, data } = await getProfile(sessionId);
    expect(status).toBe(403);
    expect(data.success).toBe(false);
    expect(data.error.toLowerCase()).toContain("sign in");
  });

  it("startSession({user_email}) alone (no OTP) does NOT unlock the profile — the exact bypass this gate must close", async () => {
    const sessionId = await startSession({ user_email: "profile-bypass@example.com" });
    const row: any = await env.DB.prepare("SELECT user_id FROM sessions WHERE id = ?").bind(sessionId).first();
    expect(row.user_id).toBe("profile-bypass@example.com"); // user_id IS set...

    const { status, data } = await getProfile(sessionId); // ...but no token presented
    expect(status).toBe(403);
    expect(data.success).toBe(false);
  });

  it("a bearer token for a DIFFERENT account is rejected (401), never returns the wrong account's data", async () => {
    const ownerSession = await startSession();
    await signIn(env, ownerSession, "profile-owner@example.com");

    const attackerSession = await startSession();
    const attackerToken = await signIn(env, attackerSession, "profile-attacker@example.com");

    // Attacker presents their OWN valid token against the OWNER's session id.
    const { status, data } = await getProfile(ownerSession, attackerToken);
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("a real sign-in unlocks the profile and returns exactly that account's own data", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-real@example.com");

    const { status, data } = await getProfile(sessionId, token);
    expect(status).not.toBe(403);
    expect(status).not.toBe(401);
    expect(data.success).toBe(true);
    expect(data.data.email).toBe("profile-real@example.com");
  });

  it("the guest rejection is a real, session-attributed audit row, not silently dropped", async () => {
    const sessionId = await startSession();
    await getProfile(sessionId);

    const rows: any[] = (
      await env.DB.prepare(
        "SELECT status, session_id FROM api_call_log WHERE session_id = ? AND endpoint = '/api/account/profile' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(sessionId)
        .all()
    ).results ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("blocked");
    expect(rows[0].session_id).toBe(sessionId);
  });
});

describe("Account profile: content correctness", () => {
  it("a first-time signed-in shopper with no orders gets zeroed totals, not an error", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-firsttime@example.com");
    const { data } = await getProfile(sessionId, token);
    expect(data.data.totalOrders).toBe(0);
    expect(data.data.totalSpentPaise).toBe(0);
    expect(data.data.recentOrders).toEqual([]);
    expect(data.data.favoriteCategories).toEqual([]);
  });

  it("totalSpentPaise reflects the account's FULL paid history, not just the capped recentOrders window", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-totals@example.com");

    // 12 paid orders — more than the 10-order recentOrders cap.
    for (let i = 0; i < 12; i++) {
      await insertPaidOrder(sessionId, [{ productId: "red-sports-tee", name: "Red Sports Tee", quantity: 1 }], 10000, new Date(Date.now() - i * 1000).toISOString());
    }

    const { data } = await getProfile(sessionId, token);
    expect(data.data.totalOrders).toBe(12);
    expect(data.data.totalSpentPaise).toBe(120000); // 12 * 10000 — full history
    expect(data.data.recentOrders).toHaveLength(10); // display capped
  });

  it("favoriteCategories reflects actual product categories from paid orders", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-favcat@example.com");
    // red-sports-tee is category "Tees" (see src/catalog.ts)
    await insertPaidOrder(sessionId, [{ productId: "red-sports-tee", name: "Red Sports Tee", quantity: 2 }], 159800);

    const { data } = await getProfile(sessionId, token);
    expect(data.data.favoriteCategories).toContain("Tees");
  });

  it("only paid orders count — created/attempted orders never appear or count toward totals", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-onlypaid@example.com");
    await env.DB.prepare(
      `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at)
       VALUES (?, ?, ?, ?, 'INR', 'created', '[]', ?)`,
    )
      .bind(crypto.randomUUID(), sessionId, "order_unpaid", 99999, new Date().toISOString())
      .run();

    const { data } = await getProfile(sessionId, token);
    expect(data.data.totalOrders).toBe(0);
    expect(data.data.totalSpentPaise).toBe(0);
  });

  it("recentOrders are newest first and capped at 10", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-order-cap@example.com");
    for (let i = 0; i < 15; i++) {
      await insertPaidOrder(
        sessionId,
        [{ productId: "red-sports-tee", name: `Order ${i}`, quantity: 1 }],
        10000,
        new Date(2020, 0, i + 1).toISOString(),
      );
    }

    const { data } = await getProfile(sessionId, token);
    expect(data.data.recentOrders).toHaveLength(10);
    expect(data.data.recentOrders[0].items[0].name).toBe("Order 14"); // newest first
  });

  it("name reflects user_preferences.name when it's been saved", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-name@example.com");
    await SELF.fetch("https://test/api/user/name", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "Kasim" }),
    });

    const { data } = await getProfile(sessionId, token);
    expect(data.data.name).toBe("Kasim");
  });
});

describe("Account profile: rate limited", () => {
  it("throttles rapid repeated profile reads on one session", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "profile-ratelimit@example.com");
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`account_profile:session:${sessionId}`).run();

    let sawRateLimit = false;
    for (let i = 0; i < 25; i++) {
      const { status } = await getProfile(sessionId, token);
      if (status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
