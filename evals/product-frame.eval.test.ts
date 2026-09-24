import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers POST /api/product-frame (src/api/productFrame.ts) — the
 * allowlisted photo-byte endpoint behind the look_at_product voice tool.
 * Deliberately exercises only paths that resolve BEFORE the image fetch:
 * auth, input validation, and the D1 allowlist. The one true end-to-end
 * path (real id → real CDN bytes) is verified live, not here — asserting
 * on it would couple every test run to network access and CDN behavior.
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

async function productFrame(sessionId: string | null, body: Record<string, unknown>) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["x-session-id"] = sessionId;
  const res = await SELF.fetch("https://test/api/product-frame", {
    method: "POST",
    headers,
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

describe("Product frame: input validation (resolved before any image fetch)", () => {
  it("401s without a session", async () => {
    const { status, data } = await productFrame(null, { product_id: "red-sports-tee" });
    expect(status).toBe(401);
    expect(data.success).toBe(false);
  });

  it("missing product_id is rejected, never reaching D1", async () => {
    const sessionId = await startSession();
    const { status, data } = await productFrame(sessionId, {});
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("an id with no product row 404s — the allowlist rejects non-catalog ids", async () => {
    const sessionId = await startSession();
    const { status, data } = await productFrame(sessionId, { product_id: "not-a-product" });
    expect(status).toBe(404);
    expect(data.success).toBe(false);
  });

  it("every call is audit-logged with the product_id param", async () => {
    const sessionId = await startSession();
    await productFrame(sessionId, { product_id: "not-a-product" });

    const rows: any[] = (
      await env.DB.prepare(
        "SELECT params_json FROM api_call_log WHERE session_id = ? AND endpoint = '/api/product-frame' ORDER BY created_at DESC LIMIT 1",
      )
        .bind(sessionId)
        .all()
    ).results ?? [];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].params_json).product_id).toBe("not-a-product");
  });
});

describe("Product frame: rate limited like describe-products (frames cost context per call)", () => {
  it("has a materially higher session rate limit than default tool endpoints", async () => {
    const sessionId = await startSession();
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`product_frame:session:${sessionId}`).run();

    let callsBeforeLimit = 0;
    for (let i = 0; i < 45; i++) {
      const { status } = await productFrame(sessionId, { product_id: "fake-1" }); // 404s fast, no network cost
      if (status === 429) break;
      callsBeforeLimit++;
    }
    expect(callsBeforeLimit).toBeGreaterThanOrEqual(39);
  });
});
