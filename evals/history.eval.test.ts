import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers GET /api/session/history (see getPurchaseHistory in
 * src/api/logic.ts) — the last-2-paid-orders lookup injected into
 * Gemini's system instruction so a returning shopper doesn't have to
 * re-describe what they usually buy.
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

async function getHistory(sessionId: string) {
  const res = await SELF.fetch("https://test/api/session/history", {
    headers: { "x-session-id": sessionId },
  });
  return res.json() as Promise<any>;
}

/** Inserts an order row directly — bypasses the real checkout/Razorpay
 *  flow entirely (already covered by evals/api.eval.test.ts), since this
 *  file only needs to exercise history's read-side filtering logic. */
async function insertOrder(
  sessionId: string,
  status: "created" | "attempted" | "paid",
  items: { name: string; quantity: number; productId?: string; price?: number }[],
  amountPaise: number,
  createdAt = new Date().toISOString(),
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at)
     VALUES (?, ?, ?, ?, 'INR', ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      sessionId,
      `order_${crypto.randomUUID().slice(0, 8)}`,
      amountPaise,
      status,
      JSON.stringify(items),
      createdAt,
    )
    .run();
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("History: basic retrieval", () => {
  it("returns a paid order's items", async () => {
    const sessionId = await startSession({ user_email: "history-basic@example.com" });
    await insertOrder(sessionId, "paid", [{ name: "Black Hoodie", quantity: 1 }], 129900);

    const res = await getHistory(sessionId);
    expect(res.success).toBe(true);
    expect(res.data.orders).toHaveLength(1);
    expect(res.data.orders[0].items[0].name).toBe("Black Hoodie");
    expect(res.data.orders[0].amountPaise).toBe(129900);
  });

  it("first-time buyer with no orders gets an empty array, not an error", async () => {
    const sessionId = await startSession({ user_email: "history-empty@example.com" });
    const res = await getHistory(sessionId);
    expect(res.success).toBe(true);
    expect(res.data.orders).toEqual([]);
  });
});

describe("History: only paid orders count", () => {
  it("excludes created (never completed) and attempted (abandoned) orders", async () => {
    const sessionId = await startSession({ user_email: "history-unpaid@example.com" });
    await insertOrder(sessionId, "created", [{ name: "Never Finished", quantity: 1 }], 50000);
    await insertOrder(sessionId, "attempted", [{ name: "Abandoned Checkout", quantity: 1 }], 60000);
    await insertOrder(sessionId, "paid", [{ name: "Actually Bought", quantity: 1 }], 70000);

    const res = await getHistory(sessionId);
    expect(res.data.orders).toHaveLength(1);
    expect(res.data.orders[0].items[0].name).toBe("Actually Bought");
  });
});

describe("History: capped and ordered", () => {
  it("returns at most the 2 most recent paid orders, newest first", async () => {
    const sessionId = await startSession({ user_email: "history-capped@example.com" });
    await insertOrder(sessionId, "paid", [{ name: "Oldest", quantity: 1 }], 10000, "2020-01-01T00:00:00.000Z");
    await insertOrder(sessionId, "paid", [{ name: "Middle", quantity: 1 }], 20000, "2021-01-01T00:00:00.000Z");
    await insertOrder(sessionId, "paid", [{ name: "Newest", quantity: 1 }], 30000, "2022-01-01T00:00:00.000Z");

    const res = await getHistory(sessionId);
    expect(res.data.orders).toHaveLength(2);
    expect(res.data.orders[0].items[0].name).toBe("Newest");
    expect(res.data.orders[1].items[0].name).toBe("Middle");
  });
});

describe("History: account-scoped, not session-scoped", () => {
  it("a different session for the same email sees the same history", async () => {
    const email = "history-cross-session@example.com";
    const sessionA = await startSession({ user_email: email });
    await insertOrder(sessionA, "paid", [{ name: "Bought On Session A", quantity: 1 }], 40000);

    const sessionB = await startSession({ user_email: email });
    const res = await getHistory(sessionB);
    expect(res.data.orders).toHaveLength(1);
    expect(res.data.orders[0].items[0].name).toBe("Bought On Session A");
  });

  it("a guest session (no email) always gets empty history, even with orders on other sessions", async () => {
    const guestSession = await startSession(); // no user_email
    const res = await getHistory(guestSession);
    expect(res.success).toBe(true);
    expect(res.data.orders).toEqual([]);
  });

  it("different accounts never see each other's history", async () => {
    const sessionOwner = await startSession({ user_email: "history-owner@example.com" });
    await insertOrder(sessionOwner, "paid", [{ name: "Owners Item", quantity: 1 }], 40000);

    const sessionOther = await startSession({ user_email: "history-other@example.com" });
    const res = await getHistory(sessionOther);
    expect(res.data.orders).toEqual([]);
  });
});

describe("History: malformed data doesn't crash the lookup", () => {
  it("a row with unparseable items_json returns an empty items array instead of throwing", async () => {
    const sessionId = await startSession({ user_email: "history-malformed@example.com" });
    await env.DB.prepare(
      `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at)
       VALUES (?, ?, ?, ?, 'INR', 'paid', ?, ?)`,
    )
      .bind(crypto.randomUUID(), sessionId, "order_broken", 10000, "{not valid json", new Date().toISOString())
      .run();

    const res = await getHistory(sessionId);
    expect(res.success).toBe(true);
    expect(res.data.orders).toHaveLength(1);
    expect(res.data.orders[0].items).toEqual([]);
  });
});

describe("History: requires a valid session", () => {
  it("401s without x-session-id", async () => {
    const res = await SELF.fetch("https://test/api/session/history");
    expect(res.status).toBe(401);
  });
});
