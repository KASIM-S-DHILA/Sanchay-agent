import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

let env: any;
const START = "https://test/api/session/start";

async function startSession(body: Record<string, unknown> = {}): Promise<{ sessionId: string; data: any }> {
  const res = await SELF.fetch(START, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  return { sessionId: json.data?.sessionId, data: json };
}

async function addProduct(sessionId: string, productId: string, quantity = 1) {
  return SELF.fetch("https://test/api/cart/add", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ product_id: productId, quantity }),
  });
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("API: Session", () => {
  it("POST /api/session/start creates a session", async () => {
    const res = await SELF.fetch(START, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_email: "sess-create@example.com" }),
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.sessionId).toBeTruthy();
    expect(data.data.userPreferences).toBeDefined();
  });

  it("POST /api/session/start with budget stores budget", async () => {
    const res = await SELF.fetch(START, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_email: "sess-budget@example.com", budget: 200000 }),
    });
    const data: any = await res.json();
    expect(data.success).toBe(true);
    const row: any = await env.DB.prepare(
      "SELECT budget_paise FROM sessions WHERE id = ?",
    )
      .bind(data.data.sessionId)
      .first();
    expect(row?.budget_paise).toBe(200000);
  });

  it("session/end marks the session ended and writes back preferences", async () => {
    const { sessionId } = await startSession({ user_email: "sess-end@example.com", budget: 100000 });
    await addProduct(sessionId, "TEE-BLACK-001");

    const res = await SELF.fetch("https://test/api/session/end", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ confirmed_checkout: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).success).toBe(true);

    const row: any = await env.DB.prepare("SELECT status FROM sessions WHERE id = ?")
      .bind(sessionId)
      .first();
    expect(row?.status).toBe("ended");

    // previousProducts written back from final cart
    const prefs: any = await env.DB.prepare(
      "SELECT previous_products FROM user_preferences WHERE user_id = 'sess-end@example.com'",
    ).first();
    expect(JSON.parse(prefs?.previous_products || "[]")).toContain("TEE-BLACK-001");

    // Session is now invalid for further API calls
    const cartRes = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": sessionId },
    });
    expect(cartRes.status).toBe(401);
  });
});

describe("API: Catalog", () => {
  it("GET /api/catalog returns all products", async () => {
    const res = await SELF.fetch("https://test/api/catalog");
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.products.length).toBeGreaterThan(0);
    // paise integers
    expect(data.data.products[0].price).toBeGreaterThan(100);
  });

  it("GET /api/catalog?q=hoodie returns hoodie products (semantic or LIKE)", async () => {
    const res = await SELF.fetch("https://test/api/catalog?q=hoodie");
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(
      data.data.products.some((p: any) => p.name.toLowerCase().includes("hood")),
    ).toBe(true);
  });
});

describe("API: Cart", () => {
  let sessionId: string;

  beforeAll(async () => {
    ({ sessionId } = await startSession());
  });

  it("POST /api/cart/add adds a product with D1-snapshotted price", async () => {
    const res = await addProduct(sessionId, "TEE-BLACK-001");
    const data: any = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.items.length).toBe(1);
    expect(data.data.total).toBe(79900);
    expect(data.data.items[0].name).toBe("Black Classic Tee");
  });

  it("adding the same product again merges quantities", async () => {
    await addProduct(sessionId, "TEE-BLACK-001");
    const res = await addProduct(sessionId, "TEE-BLACK-001");
    const data: any = await res.json();
    expect(data.data.items.length).toBe(1);
    expect(data.data.items[0].quantity).toBe(3); // 1 + 1 + 1
  });

  it("invalid product fails", async () => {
    const res = await addProduct(sessionId, "FAKE-PRODUCT");
    const data: any = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("not found");
  });

  it("budget-exceeded add fails and leaves the cart untouched", async () => {
    const { sessionId: budgetSid } = await startSession({ budget: 50000 }); // ₹500
    const res = await addProduct(budgetSid, "TEE-BLACK-001"); // ₹799
    const data: any = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("budget");

    const cartRes = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": budgetSid },
    });
    const cartData: any = await cartRes.json();
    expect(cartData.data.items.length).toBe(0);
  });

  it("remove deletes the line item", async () => {
    await addProduct(sessionId, "TEE-WHITE-002");
    const res = await SELF.fetch("https://test/api/cart/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: "TEE-WHITE-002" }),
    });
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.items.some((i: any) => i.productId === "TEE-WHITE-002")).toBe(false);
  });

  it("partial remove decrements quantity", async () => {
    await addProduct(sessionId, "HOODIE-GRAY-001", 3);
    const res = await SELF.fetch("https://test/api/cart/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: "HOODIE-GRAY-001", quantity: 2 }),
    });
    const data: any = await res.json();
    const item = data.data.items.find((i: any) => i.productId === "HOODIE-GRAY-001");
    expect(item.quantity).toBe(1);
  });

  it("GET /api/cart returns current cart", async () => {
    const res = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": sessionId },
    });
    const data: any = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data.items)).toBe(true);
  });

  it("cart endpoints without session → 401", async () => {
    const addRes = await addProduct("no-such-session", "TEE-BLACK-001");
    expect(addRes.status).toBe(401);
    const getRes = await SELF.fetch("https://test/api/cart", {
      headers: { "x-session-id": "no-such-session" },
    });
    expect(getRes.status).toBe(401);
  });
});

describe("API: Checkout", () => {
  it("empty cart fails", async () => {
    const { sessionId } = await startSession();
    const res = await SELF.fetch("https://test/api/checkout", {
      method: "POST",
      headers: { "x-session-id": sessionId },
    });
    const data: any = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("empty");
  });

  it("checkout creates an order (or fails gracefully on gateway limits)", async () => {
    const { sessionId } = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001");

    const res = await SELF.fetch("https://test/api/checkout", {
      method: "POST",
      headers: { "x-session-id": sessionId },
    });
    const data: any = await res.json();
    if (data.success) {
      expect(data.data.orderId).toBeTruthy();
      expect(data.data.amount).toBe(79900);
      expect(data.data.status).toBe("created");
    } else {
      // Test-mode payment_link quota (30 ever) exhausted → graceful failure
      expect(data.error).toBeTruthy();
    }
  });

  it("idempotent — active order returned instead of duplicate", async () => {
    const { sessionId } = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001");

    // Seed an active order so checkout takes the idempotency path without
    // touching Razorpay (quota-proof)
    const rzpOrderId = `order_idem_${Date.now()}`;
    await env.DB.prepare(
      "INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at) VALUES (?, ?, ?, ?, 'INR', 'created', ?, ?)",
    )
      .bind(crypto.randomUUID(), sessionId, rzpOrderId, 79900, "[]", new Date().toISOString())
      .run();

    const res1 = await SELF.fetch("https://test/api/checkout", {
      method: "POST",
      headers: { "x-session-id": sessionId },
    });
    const res2 = await SELF.fetch("https://test/api/checkout", {
      method: "POST",
      headers: { "x-session-id": sessionId },
    });
    const d1: any = await res1.json();
    const d2: any = await res2.json();
    expect(d1.success).toBe(true);
    expect(d1.data.orderId).toBe(rzpOrderId);
    expect(d2.data.orderId).toBe(rzpOrderId);
  });

  it("order status endpoint scopes to the session", async () => {
    const { sessionId } = await startSession();
    const rzpOrderId = `order_scope_${Date.now()}`;
    await env.DB.prepare(
      "INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at) VALUES (?, ?, ?, ?, 'INR', 'created', '[]', ?)",
    )
      .bind(crypto.randomUUID(), sessionId, rzpOrderId, 79900, new Date().toISOString())
      .run();

    const ok = await SELF.fetch(`https://test/api/order/${rzpOrderId}`, {
      headers: { "x-session-id": sessionId },
    });
    expect(ok.status).toBe(200);
    const body: any = await ok.json();
    expect(body.data.orderId).toBe(rzpOrderId);

    // Other session cannot see it
    const other = await startSession();
    const denied = await SELF.fetch(`https://test/api/order/${rzpOrderId}`, {
      headers: { "x-session-id": other.sessionId },
    });
    expect(denied.status).toBe(404);
  });
});

describe("API: Audit", () => {
  it("returns call log for the session, chronological", async () => {
    const { sessionId } = await startSession();

    await SELF.fetch("https://test/api/catalog?q=hoodie");
    await addProduct(sessionId, "TEE-BLACK-001");
    await SELF.fetch("https://test/api/cart", { headers: { "x-session-id": sessionId } });

    const res = await SELF.fetch(`https://test/api/audit?session_id=${sessionId}`, {
      headers: { "x-session-id": sessionId },
    });
    const data: any = await res.json();
    expect(data.success).toBe(true);

    const events = data.data.events;
    expect(events.some((e: any) => e.endpoint === "/api/session/start")).toBe(true);
    expect(events.some((e: any) => e.endpoint === "/api/cart/add")).toBe(true);

    for (let i = 1; i < events.length; i++) {
      expect(events[i].ts).toBeGreaterThanOrEqual(events[i - 1].ts);
    }
  });

  it("failed calls are logged as errors", async () => {
    const { sessionId } = await startSession();
    await addProduct(sessionId, "FAKE-PRODUCT");

    const events: any = (await (
      await SELF.fetch(`https://test/api/audit?session_id=${sessionId}`, {
        headers: { "x-session-id": sessionId },
      })
    ).json() as any).data.events;
    const failedAdd = events.find((e: any) => e.endpoint === "/api/cart/add" && e.status === "error");
    expect(failedAdd).toBeDefined();
  });
});







