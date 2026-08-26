import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";
import { executeToolCall } from "../src/voice/tools";

let env: any;

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Voice bridge endpoint", () => {
  it("GET /voice without WebSocket upgrade returns 426", async () => {
    const res = await SELF.fetch("https://example.com/voice");
    expect(res.status).toBe(426);
  });

  it("GET /voice with upgrade header reaches the bridge route", async () => {
    // The WS upgrade itself can't be fully tested via SELF.fetch in
    // vitest-pool-workers. We assert the route is reached (not 404/200 SPA)
    // by checking the response isn't the SPA fallback.
    const res = await SELF.fetch("https://example.com/voice", {
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    // Any status other than 200 proves the route matched (bridge attempted).
    // 500 = Sarvam auth failed upstream; 101 = WS pair created.
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(404);
  });
});

describe("Voice tool execution (in-process)", () => {
  it("search_catalog returns products", async () => {
    const result = await executeToolCall(env, "vt-search", "search_catalog", { query: "hoodie" });
    expect(result.success).toBe(true);
    const products = (result as any).data.products;
    expect(products.length).toBeGreaterThan(0);
  });

  it("add_to_cart adds product and logs audit", async () => {
    const result = await executeToolCall(env, "vt-add", "add_to_cart", {
      product_id: "TEE-BLACK-001",
      quantity: 1,
    });
    expect(result.success).toBe(true);

    // Verify audit trail written
    const events: any[] = (
      await env.DB.prepare(
        "SELECT * FROM api_call_log WHERE session_id = ? AND endpoint = '/api/cart/add'",
      )
        .bind("vt-add")
        .all()
    ).results ?? [];
    expect(events.length).toBeGreaterThan(0);
  });

  it("get_cart returns cart contents", async () => {
    await executeToolCall(env, "vt-cart", "add_to_cart", {
      product_id: "HOODIE-GRAY-001",
      quantity: 2,
    });
    const result = await executeToolCall(env, "vt-cart", "get_cart", {});
    expect(result.success).toBe(true);
    const data = (result as any).data;
    expect(data.items.some((i: any) => i.productId === "HOODIE-GRAY-001")).toBe(true);
    expect(data.total).toBeGreaterThan(0);
  });

  it("checkout returns order or graceful failure", async () => {
    await executeToolCall(env, "vt-checkout", "add_to_cart", {
      product_id: "TEE-BLACK-001",
      quantity: 1,
    });
    const result = await executeToolCall(env, "vt-checkout", "checkout", {});
    // May succeed with real Razorpay or fail gracefully on gateway limits
    if (result.success) {
      expect((result as any).data.orderId).toBeTruthy();
    } else {
      expect(result.error).toBeTruthy();
    }
  });

  it("unknown tool returns error", async () => {
    const result = await executeToolCall(env, "vt-unknown", "nonexistent_tool", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});
