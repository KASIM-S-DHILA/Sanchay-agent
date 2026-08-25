import { describe, it, expect, beforeAll } from "vitest";
import { createOrder, verifyPayment } from "../src/razorpay";
import { hmacSHA256 } from "../src/crypto";

let env: any;
let gatewayAvailable = true;

beforeAll(async () => {
  try {
    const mod: any = await import("cloudflare:test");
    env = mod.env;
    // Local D1 simulation starts empty — create webhook-dependent tables
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT, razorpay_order_id TEXT, amount INTEGER, currency TEXT, status TEXT, items_json TEXT, created_at TEXT)",
    ).run();
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, session_id TEXT, action TEXT, intent TEXT, params_json TEXT, result_json TEXT, status TEXT, created_at TEXT)",
    ).run();
    // Probe gateway auth with a harmless order — 401 means keys invalid
    try {
      await createOrder(env, 10000, `probe-${Date.now()}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
        gatewayAvailable = false;
        console.warn("Razorpay auth failed — API tests will skip:", msg.slice(0, 200));
      }
    }
  } catch {
    gatewayAvailable = false;
  }
}, 60000);

describe("createOrder (real Razorpay test-mode)", () => {
  it("returns an order with id and status", async () => {
    if (!gatewayAvailable) { console.warn("Skipped: Razorpay gateway unavailable"); return; }
    const order = await createOrder(env, 79900, `sanchay-test-${Date.now()}`);
    expect(order.id).toMatch(/^order_/);
    expect(order.amount).toBe(79900);
    expect(order.currency).toBe("INR");
    expect(order.status).toBeDefined();
    expect(order.receipt).toContain("sanchay-test");
  });
});

describe("verifyPayment (pure HMAC)", () => {
  it("correct signature returns true", async () => {
    const orderId = "order_Test123";
    const paymentId = "pay_Test456";
    const signature = await hmacSHA256(`${orderId}|${paymentId}`, env.RAZORPAY_WEBHOOK_SECRET);
    const ok = await verifyPayment(env, paymentId, orderId, signature);
    expect(ok).toBe(true);
  });

  it("incorrect signature returns false", async () => {
    const ok = await verifyPayment(env, "pay_Test456", "order_Test123", "deadbeef");
    expect(ok).toBe(false);
  });
});

describe("Webhook handler (/webhooks/razorpay)", () => {
  it("valid signature processes payment.captured → {status:'ok'} + D1 updated", async () => {
    const secret = env.RAZORPAY_WEBHOOK_SECRET as string;
    // Seed an order row so the UPDATE has something to hit
    const rzpOrderId = `order_wh_${Date.now()}`;
    await env.DB.prepare(
      "INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), "wh-test-session", rzpOrderId, 79900, "INR", "created", "[]", new Date().toISOString())
      .run();

    const body = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: { id: "pay_wh_test", order_id: rzpOrderId, amount: 79900 },
        },
      },
    });
    const signature = await hmacSHA256(body, secret);

    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://example.com/webhooks/razorpay", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": signature },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    // Order marked paid
    const row: any = await env.DB.prepare("SELECT status FROM orders WHERE razorpay_order_id = ?")
      .bind(rzpOrderId)
      .first();
    expect(row?.status).toBe("paid");

    // Audit row written directly to D1 audit_logs
    const audit: any = await env.DB.prepare(
      "SELECT action, status FROM audit_logs WHERE action = 'payment.captured' ORDER BY created_at DESC LIMIT 1",
    ).first();
    expect(audit?.status).toBe("ok");
  });

  it("invalid signature returns 400", async () => {
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://example.com/webhooks/razorpay", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": "deadbeef" },
      body: JSON.stringify({ event: "payment.captured" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Invalid signature");
  });
});
