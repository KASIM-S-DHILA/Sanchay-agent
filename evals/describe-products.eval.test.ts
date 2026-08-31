import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers POST /api/describe-products (src/api/describeProducts.ts) — the
 * vision tool backing describe_product_images. Deliberately does NOT
 * assert on the content of a real Gemini vision response (that would make
 * these tests dependent on live network access, a real product image
 * being reachable, and Gemini API behavior/cost on every test run) —
 * instead exercises every path that resolves BEFORE the actual vision
 * call: auth, input validation, id resolution/self-heal, and the cap,
 * which is where the actual bugs worth regression-testing live. The one
 * true end-to-end path (a real product id with a real reachable image) is
 * exercised loosely — checking it doesn't throw / auth-reject, not
 * asserting specific description text.
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

async function describeProducts(sessionId: string, body: Record<string, unknown>) {
  const res = await SELF.fetch("https://test/api/describe-products", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as any };
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Describe products: input validation (resolved before any vision call)", () => {
  it("no product_ids at all is rejected with a clear 'nothing to describe' error", async () => {
    const sessionId = await startSession();
    const { status, data } = await describeProducts(sessionId, {});
    expect(status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error.toLowerCase()).toContain("nothing to describe");
  });

  it("an empty product_ids array is treated the same as omitting it", async () => {
    const sessionId = await startSession();
    const { status, data } = await describeProducts(sessionId, { product_ids: [] });
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("all-nonexistent ids fail with 404 before any image fetch is attempted", async () => {
    const sessionId = await startSession();
    const { status, data } = await describeProducts(sessionId, { product_ids: ["fake-1", "fake-2"] });
    expect(status).toBe(404);
    expect(data.success).toBe(false);
  });

  it("caps at 4 ids per call even if more are sent — matches the floating-window cap", async () => {
    const sessionId = await startSession();
    // 6 fake ids — since none exist, this resolves to a 404 before ever
    // reaching image fetching/vision, but the params logged still prove
    // the id LIST itself was capped to 4, not passed through unbounded.
    await describeProducts(sessionId, {
      product_ids: ["fake-1", "fake-2", "fake-3", "fake-4", "fake-5", "fake-6"],
    });

    const rows: any[] = (
      await env.DB.prepare(
        "SELECT params_json FROM api_call_log WHERE session_id = ? AND endpoint = '/api/describe-products' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(sessionId)
        .all()
    ).results ?? [];
    expect(rows).toHaveLength(1);
    const params = JSON.parse(rows[0].params_json);
    expect(params.product_ids).toHaveLength(4);
  });

  it("duplicate ids are deduplicated before the cap is applied", async () => {
    const sessionId = await startSession();
    await describeProducts(sessionId, { product_ids: ["fake-1", "fake-1", "fake-1"] });

    const rows: any[] = (
      await env.DB.prepare(
        "SELECT params_json FROM api_call_log WHERE session_id = ? AND endpoint = '/api/describe-products' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(sessionId)
        .all()
    ).results ?? [];
    const params = JSON.parse(rows[0].params_json);
    expect(params.product_ids).toEqual(["fake-1"]);
  });

  it("401s without a session", async () => {
    const res = await SELF.fetch("https://test/api/describe-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: ["red-sports-tee"] }),
    });
    expect(res.status).toBe(401);
  });

  it("a mix of a real id and fake ids at least resolves the real product before attempting its image (doesn't 404 the whole batch for one bad id)", async () => {
    const sessionId = await startSession();
    // red-sports-tee is real; if its image happens to be unreachable in
    // this test environment, the endpoint should report that via
    // failedToLoad / a 502, NOT a 404 (404 means "no product row found",
    // which is wrong here since one was found).
    const { status } = await describeProducts(sessionId, { product_ids: ["red-sports-tee", "fake-1"] });
    expect(status).not.toBe(404);
  });
});

describe("Describe products: rate limited generously (per explicit product decision — vision is core to the shopping experience)", () => {
  it("has a materially higher session rate limit than other tool-backed endpoints", async () => {
    const sessionId = await startSession();
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`describe_products:session:${sessionId}`).run();

    let callsBeforeLimit = 0;
    for (let i = 0; i < 45; i++) {
      const { status } = await describeProducts(sessionId, { product_ids: ["fake-1"] }); // 404s fast, no network cost
      if (status === 429) break;
      callsBeforeLimit++;
    }
    // Other tool-backed endpoints (e.g. account_profile, product_details)
    // are limited to 20-40/min; describe-products should allow at least
    // that many before throttling, confirming the "higher rate limit"
    // decision actually took effect rather than reusing a default.
    expect(callsBeforeLimit).toBeGreaterThanOrEqual(39);
  });
});
