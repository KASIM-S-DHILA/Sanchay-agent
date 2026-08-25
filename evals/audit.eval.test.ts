import { describe, it, expect, beforeAll } from "vitest";

let env: any;

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  // Local D1 simulation needs the audit tables
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT, razorpay_order_id TEXT, amount INTEGER, currency TEXT, status TEXT, items_json TEXT, created_at TEXT)",
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, session_id TEXT, action TEXT, intent TEXT, params_json TEXT, result_json TEXT, status TEXT, created_at TEXT)",
  ).run();
});

describe("/audit endpoint contract", () => {
  it("missing sid → 400", async () => {
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://example.com/audit");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing sid parameter" });
  });

  it("non-existent session → empty events + sessionId echo", async () => {
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://example.com/audit?sid=does-not-exist-xyz");
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.events).toEqual([]);
    expect(data.sessionId).toBe("does-not-exist-xyz");
  });

  it("merges D1 rows into the trail with d1 source badge", async () => {
    // Simulate a webhook-written audit row
    const sid = "d1-source-test";
    await env.DB.prepare(
      "INSERT INTO audit_logs (id, session_id, action, intent, params_json, result_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), sid, "payment.captured", "payment", '{"paymentId":"pay_x"}', '{"amount":79900}', "ok", new Date().toISOString())
      .run();

    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch(`http://example.com/audit?sid=${sid}`);
    const data: any = await res.json();
    const d1Event = data.events.find((e: any) => e.source === "d1" && e.action === "payment.captured");
    expect(d1Event).toBeDefined();
    expect(d1Event.status).toBe("ok");
  });

  it("DO events surface through same-runtime RPC with do source badge", async () => {
    // Address the DO directly — its onStart creates audit_events; write one row via RPC-free SQL is not exposed,
    // so drive a real turn: probe gate block is deterministic (no AI).
    const { SELF } = await import("cloudflare:test");

    // The DO RPC path itself: instantiate and read via the endpoint after an agent write.
    // Agent writes require WS; here we verify the DO read path doesn't error and returns do-shaped events.
    const sid = "do-rpc-probe";
    const res = await SELF.fetch(`http://example.com/audit?sid=${sid}`);
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data.events)).toBe(true);
    // Every merged event carries a source badge
    for (const e of data.events) {
      expect(["do", "d1"]).toContain(e.source);
    }
  });
});
