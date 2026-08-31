import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";
import { signIn } from "./helpers/auth";

/**
 * Covers the payment lifecycle work added after the checkout-reconcile fix:
 * - payment.failed marks an order 'attempted' and releases stock immediately
 *   (src/api/webhook.ts: handlePaymentFailed)
 * - stock is never released twice for the same order (stock_released guard)
 * - both 'created' and 'attempted' orders expire at RESERVATION_TIMEOUT_MS
 *   (src/api/logic.ts: reconcileExpiredOrders)
 * - getPendingOrder's expiresInSeconds/lastAttemptFailed fields
 * - order.paid / payment_link.paid webhook variants converge on the same
 *   handlePaymentCaptured path as payment.captured
 *
 * No live Razorpay calls — webhook payloads are POSTed directly against
 * /webhooks/razorpay with a valid signature computed against
 * env.RAZORPAY_WEBHOOK_SECRET, and time-based expiry is tested by inserting
 * orders with a backdated created_at rather than waiting 15 real minutes.
 */

let env: any;

async function startSession(body: Record<string, unknown> = {}): Promise<string> {
  const res = await SELF.fetch("https://test/api/session/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json();
  return json.data.sessionId;
}

async function addProduct(sessionId: string, productId: string, quantity = 1) {
  return (
    await SELF.fetch("https://test/api/cart/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: productId, quantity }),
    })
  ).json() as Promise<any>;
}

async function getCart(sessionId: string) {
  const res = await SELF.fetch("https://test/api/cart", { headers: { "x-session-id": sessionId } });
  return res.json() as Promise<any>;
}

async function getProductStock(productId: string): Promise<number> {
  const row: any = await env.DB.prepare("SELECT stock FROM products WHERE id = ?").bind(productId).first();
  return row.stock;
}

/** Inserts an active order with a controllable age, mirroring what
 *  checkoutCart would have produced, without spending Razorpay's test-mode
 *  quota or waiting on a real clock. */
async function insertActiveOrder(
  sessionId: string,
  amountPaise: number,
  opts: {
    status?: "created" | "attempted";
    ageMs?: number;
    items?: { productId: string; quantity: number; name?: string; price?: number }[];
  } = {},
): Promise<{ orderId: string; dbId: string }> {
  const orderId = `order_lifecycle_${crypto.randomUUID().slice(0, 8)}`;
  const dbId = crypto.randomUUID();
  const createdAt = new Date(Date.now() - (opts.ageMs ?? 0)).toISOString();
  await env.DB.prepare(
    `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, payment_url, created_at, stock_released)
     VALUES (?, ?, ?, ?, 'INR', ?, ?, ?, ?, 0)`,
  )
    .bind(
      dbId,
      sessionId,
      orderId,
      amountPaise,
      opts.status ?? "created",
      JSON.stringify(opts.items ?? []),
      "https://razorpay.example/pay/xyz",
      createdAt,
    )
    .run();
  return { orderId, dbId };
}

async function getOrderRow(dbId: string): Promise<any> {
  return env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(dbId).first();
}

async function postWebhook(event: any) {
  const body = JSON.stringify(event);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.RAZORPAY_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const signature = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const res = await SELF.fetch("https://test/webhooks/razorpay", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-razorpay-signature": signature },
    body,
  });
  return res.json() as Promise<any>;
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("payment.failed webhook", () => {
  it("marks the order 'attempted', releases stock immediately, and sets stock_released", async () => {
    const sessionId = await startSession();
    const stockBefore = await getProductStock("red-sports-tee");
    await addProduct(sessionId, "red-sports-tee", 2);

    // checkoutCart would have decremented stock by 2 at order creation —
    // mirror that here since this test inserts the order directly.
    await env.DB.prepare("UPDATE products SET stock = stock - 2 WHERE id = ?").bind("red-sports-tee").run();
    const { orderId, dbId } = await insertActiveOrder(sessionId, 79900 * 2, {
      status: "created",
      items: [{ productId: "red-sports-tee", quantity: 2 }],
    });

    const result = await postWebhook({
      event: "payment.failed",
      payload: {
        payment: {
          entity: { id: "pay_failed_1", order_id: orderId, error_description: "Card declined" },
        },
      },
    });
    expect(result.success).toBe(true);

    const row = await getOrderRow(dbId);
    expect(row.status).toBe("attempted");
    expect(row.stock_released).toBe(1);

    const stockAfter = await getProductStock("red-sports-tee");
    expect(stockAfter).toBe(stockBefore); // fully restored
  });

  it("checkoutCart reuses the SAME order after a failed attempt instead of creating a new one", async () => {
    const sessionId = await startSession();
    const token = await signIn(env, sessionId, "lifecycle-retry@example.com");
    await addProduct(sessionId, "red-sports-tee", 1);

    const checkoutRes: any = await (
      await SELF.fetch("https://test/api/checkout", {
        method: "POST",
        headers: { "x-session-id": sessionId, Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(checkoutRes.success).toBe(true);
    const firstOrderId = checkoutRes.data.orderId;

    await postWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_failed_2", order_id: firstOrderId, error_description: "Insufficient funds" } } },
    });

    const retryRes: any = await (
      await SELF.fetch("https://test/api/checkout", {
        method: "POST",
        headers: { "x-session-id": sessionId, Authorization: `Bearer ${token}` },
      })
    ).json();
    expect(retryRes.success).toBe(true);
    expect(retryRes.data.orderId).toBe(firstOrderId);
    expect(retryRes.data.status).toBe("attempted");
  });

  it("a duplicate payment.failed delivery for an already-settled order is a no-op, not a double release", async () => {
    const sessionId = await startSession();
    const { orderId, dbId } = await insertActiveOrder(sessionId, 10000, {
      status: "created",
      items: [{ productId: "red-sports-tee", quantity: 1 }],
    });
    await env.DB.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").bind(dbId).run();
    const stockBefore = await getProductStock("red-sports-tee");

    const result = await postWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_dup", order_id: orderId, error_description: "late failure notice" } } },
    });
    expect(result.success).toBe(true);

    const stockAfter = await getProductStock("red-sports-tee");
    expect(stockAfter).toBe(stockBefore); // untouched — order was already paid
  });
});

describe("expiry reconciliation: both 'created' and 'attempted' orders expire at 15 minutes", () => {
  it("a 'created' order older than 15 minutes is cancelled and its stock released on cart read", async () => {
    const sessionId = await startSession();
    await env.DB.prepare("UPDATE products SET stock = stock - 1 WHERE id = ?").bind("white-cotton-shirt").run();
    const stockBefore = await getProductStock("white-cotton-shirt");
    const { dbId } = await insertActiveOrder(sessionId, 50000, {
      status: "created",
      ageMs: 16 * 60 * 1000, // 16 minutes old
      items: [{ productId: "white-cotton-shirt", quantity: 1 }],
    });

    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeNull();

    const row = await getOrderRow(dbId);
    expect(row.status).toBe("cancelled");
    expect(row.stock_released).toBe(1);
    expect(await getProductStock("white-cotton-shirt")).toBe(stockBefore + 1);
  });

  it("an 'attempted' order older than 15 minutes also expires (not just 'created')", async () => {
    const sessionId = await startSession();
    const { dbId } = await insertActiveOrder(sessionId, 30000, {
      status: "attempted",
      ageMs: 16 * 60 * 1000,
      items: [],
    });

    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeNull();

    const row = await getOrderRow(dbId);
    expect(row.status).toBe("cancelled");
  });

  it("an order failed via payment.failed (stock already released) is not double-released on later expiry", async () => {
    const sessionId = await startSession();
    await env.DB.prepare("UPDATE products SET stock = stock - 1 WHERE id = ?").bind("red-sports-tee").run();
    const stockAfterReserve = await getProductStock("red-sports-tee");
    const { orderId, dbId } = await insertActiveOrder(sessionId, 79900, {
      status: "created",
      items: [{ productId: "red-sports-tee", quantity: 1 }],
    });

    // Fails immediately — releases stock once, marks attempted.
    await postWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_x", order_id: orderId } } },
    });
    const stockAfterFail = await getProductStock("red-sports-tee");
    expect(stockAfterFail).toBe(stockAfterReserve + 1);

    // Backdate it past expiry and let reconciliation see it too.
    await env.DB.prepare("UPDATE orders SET created_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), dbId)
      .run();

    await getCart(sessionId); // triggers reconcileExpiredOrders

    const stockAfterExpiry = await getProductStock("red-sports-tee");
    expect(stockAfterExpiry).toBe(stockAfterFail); // unchanged — no double release

    const row = await getOrderRow(dbId);
    expect(row.status).toBe("cancelled"); // status still moves to cancelled even though stock was already back
  });

  it("an order well within the 15-minute window is NOT expired", async () => {
    const sessionId = await startSession();
    const { orderId } = await insertActiveOrder(sessionId, 20000, {
      status: "created",
      ageMs: 2 * 60 * 1000, // 2 minutes old
    });

    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeTruthy();
    expect(cart.data.pendingOrder.orderId).toBe(orderId);
  });
});

describe("getPendingOrder: expiresInSeconds and lastAttemptFailed", () => {
  it("expiresInSeconds counts down from 15 minutes and is never negative", async () => {
    const sessionId = await startSession();
    await insertActiveOrder(sessionId, 20000, { status: "created", ageMs: 5 * 60 * 1000 });

    const cart = await getCart(sessionId);
    const secs = cart.data.pendingOrder.expiresInSeconds;
    // 10 minutes remain (15 - 5) — allow slack for test execution time.
    expect(secs).toBeGreaterThan(9 * 60);
    expect(secs).toBeLessThanOrEqual(10 * 60);
  });

  it("lastAttemptFailed is false for a fresh 'created' order", async () => {
    const sessionId = await startSession();
    await insertActiveOrder(sessionId, 20000, { status: "created" });
    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder.lastAttemptFailed).toBe(false);
  });

  it("lastAttemptFailed is true once the order is 'attempted' (post payment.failed)", async () => {
    const sessionId = await startSession();
    const { orderId } = await insertActiveOrder(sessionId, 20000, { status: "created", items: [] });
    await postWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_y", order_id: orderId } } },
    });
    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder.lastAttemptFailed).toBe(true);
    expect(cart.data.pendingOrder.orderId).toBe(orderId); // same order, reused
  });
});

describe("webhook variants converge on the same 'paid' handling", () => {
  it("order.paid marks the order paid and clears matching cart items", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "red-sports-tee", 1);
    const { orderId } = await insertActiveOrder(sessionId, 79900, {
      status: "created",
      items: [{ productId: "red-sports-tee", quantity: 1 }],
    });

    const result = await postWebhook({
      event: "order.paid",
      payload: {
        payment: { entity: { id: "pay_order_paid" } },
        order: { entity: { id: orderId, amount: 79900 } },
      },
    });
    expect(result.success).toBe(true);

    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeNull();
    expect(cart.data.items.find((i: any) => i.productId === "red-sports-tee")).toBeUndefined();
  });

  it("payment_link.paid resolves the order via notes.order_id and clears the cart", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "red-sports-tee", 1);
    const { orderId } = await insertActiveOrder(sessionId, 79900, {
      status: "created",
      items: [{ productId: "red-sports-tee", quantity: 1 }],
    });

    const result = await postWebhook({
      event: "payment_link.paid",
      payload: {
        payment: { entity: { id: "pay_link_paid" } },
        payment_link: { entity: { notes: { order_id: orderId }, amount_paid: 79900 } },
      },
    });
    expect(result.success).toBe(true);

    const cart = await getCart(sessionId);
    expect(cart.data.items.find((i: any) => i.productId === "red-sports-tee")).toBeUndefined();
  });

  it("payment_link.paid with no linked order_id in notes is ignored, not an error", async () => {
    const result = await postWebhook({
      event: "payment_link.paid",
      payload: { payment: { entity: { id: "pay_orphan" } }, payment_link: { entity: { notes: {}, amount_paid: 1000 } } },
    });
    expect(result.success).toBe(true);
    expect(result.data.status).toBe("ignored");
  });

  it("a duplicate payment.captured delivery for an already-paid order is idempotent", async () => {
    const sessionId = await startSession();
    const { orderId } = await insertActiveOrder(sessionId, 5000, { status: "created", items: [] });

    const first = await postWebhook({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_dupcap", order_id: orderId, amount: 5000 } } },
    });
    expect(first.success).toBe(true);

    const second = await postWebhook({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_dupcap", order_id: orderId, amount: 5000 } } },
    });
    expect(second.success).toBe(true);
    expect(second.data.note).toContain("duplicate");
  });
});
