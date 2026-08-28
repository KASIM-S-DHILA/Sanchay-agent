import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers a real bug found in production testing: nothing ever removed
 * cart_items after a successful payment (checkoutCart reserves stock and
 * creates an order, but never clears the cart) — so reloading after
 * paying showed the already-purchased items still in the cart, and
 * checking out again created a fresh Razorpay order for the same items,
 * which is exactly what caused the "payment window keeps reappearing"
 * symptom too. See clearPaidItemsFromCart / reconcilePaidOrders in
 * src/api/logic.ts and the webhook fix in src/api/webhook.ts.
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

/** Inserts a paid order directly, mirroring what checkoutCart→webhook would
 *  have produced, without spending Razorpay's test-mode quota. */
async function insertPaidOrder(
  sessionId: string,
  items: { productId: string; quantity: number; name?: string; price?: number }[],
  amountPaise: number,
): Promise<string> {
  const orderId = `order_reconcile_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at)
     VALUES (?, ?, ?, ?, 'INR', 'paid', ?, ?)`,
  )
    .bind(crypto.randomUUID(), sessionId, orderId, amountPaise, JSON.stringify(items), new Date().toISOString())
    .run();
  return orderId;
}

async function insertActiveOrder(sessionId: string, amountPaise: number, status: "created" | "attempted" = "created"): Promise<string> {
  const orderId = `order_active_${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, payment_url, created_at)
     VALUES (?, ?, ?, ?, 'INR', ?, '[]', ?, ?)`,
  )
    .bind(crypto.randomUUID(), sessionId, orderId, amountPaise, status, "https://razorpay.example/pay/xyz", new Date().toISOString())
    .run();
  return orderId;
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Checkout reconciliation: paid items disappear from the cart", () => {
  it("a paid order's items are removed from the cart on the very next read", async () => {
    const sessionId = await startSession();
    const addRes = await addProduct(sessionId, "TEE-BLACK-001", 1);
    expect(addRes.success).toBe(true);

    // Simulate what the webhook would have marked paid — self-heal (not
    // the webhook path) is what's under test here.
    await env.DB.prepare("UPDATE cart_items SET quantity = quantity").run(); // no-op, keep cart as-is
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);

    const cart = await getCart(sessionId);
    expect(cart.success).toBe(true);
    expect(cart.data.items.find((i: any) => i.productId === "TEE-BLACK-001")).toBeUndefined();
  });

  it("only the paid quantity is removed, not extra added after checkout", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001", 3);

    // Paid order only covers 1 of the 3 currently in the cart — as if 2
    // more were added to the cart after this order was created.
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);

    const cart = await getCart(sessionId);
    const line = cart.data.items.find((i: any) => i.productId === "TEE-BLACK-001");
    expect(line).toBeDefined();
    expect(line.quantity).toBe(2);
  });

  it("a second paid order for the same product removes it entirely, not negative", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001", 1);
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);
    // First read reconciles and removes it.
    await getCart(sessionId);

    // A second, unrelated paid order somehow referencing the same product
    // (edge case — shouldn't happen in practice, but must not crash or go
    // negative) finds nothing left to remove and is a no-op.
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);
    const cart = await getCart(sessionId);
    expect(cart.success).toBe(true);
    expect(cart.data.items.find((i: any) => i.productId === "TEE-BLACK-001")).toBeUndefined();
  });

  it("an unrelated item added after the paid order stays in the cart", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001", 1);
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);
    // Shopper adds something new after paying for the first item.
    await addProduct(sessionId, "TEE-WHITE-002", 1);

    const cart = await getCart(sessionId);
    expect(cart.data.items.find((i: any) => i.productId === "TEE-BLACK-001")).toBeUndefined();
    expect(cart.data.items.find((i: any) => i.productId === "TEE-WHITE-002")).toBeDefined();
  });

  it("re-checking out after paying does not find a reusable idempotent order for the paid one", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001", 1);
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);
    await getCart(sessionId); // triggers reconciliation, cart is now empty

    const res = await SELF.fetch("https://test/api/checkout", {
      method: "POST",
      headers: { "x-session-id": sessionId },
    });
    const data: any = await res.json();
    // Empty cart now (paid item reconciled away, nothing re-added) —
    // checkout correctly reports nothing to buy, rather than creating a
    // fresh order for an already-paid item or erroring unexpectedly.
    expect(data.success).toBe(false);
    expect(data.error).toContain("empty");
  });
});

describe("Checkout reconciliation: pending (unpaid) order surfaces for resume", () => {
  it("GET /api/cart reports a pendingOrder when an active order exists", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001", 1);
    const orderId = await insertActiveOrder(sessionId, 79900, "created");

    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeTruthy();
    expect(cart.data.pendingOrder.orderId).toBe(orderId);
    expect(cart.data.pendingOrder.amountPaise).toBe(79900);
  });

  it("pendingOrder is null once the order is paid (and reconciled)", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001", 1);
    await insertPaidOrder(sessionId, [{ productId: "TEE-BLACK-001", quantity: 1 }], 79900);

    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeNull();
  });

  it("pendingOrder is null when there is no order at all", async () => {
    const sessionId = await startSession();
    const cart = await getCart(sessionId);
    expect(cart.data.pendingOrder).toBeNull();
  });

  it("a different session never sees another session's pending order", async () => {
    const sessionA = await startSession();
    await insertActiveOrder(sessionA, 50000, "created");
    const sessionB = await startSession();
    const cartB = await getCart(sessionB);
    expect(cartB.data.pendingOrder).toBeNull();
  });
});
