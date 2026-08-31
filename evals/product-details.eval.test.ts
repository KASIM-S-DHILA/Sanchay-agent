import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers POST /api/product-details (src/api/productDetails.ts) — backs
 * the show_product_detail voice tool that opens floating detail windows.
 * Read-only, direct-by-id lookup (never a search) with the same
 * partial-success + self-heal-via-cached-search behavior add_to_cart
 * already relies on (see lookupCachedProductId in src/api/logic.ts).
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

async function getDetails(sessionId: string, productIds: unknown) {
  const res = await SELF.fetch("https://test/api/product-details", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ product_ids: productIds }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function searchCatalog(sessionId: string, q: string) {
  const res = await SELF.fetch(`https://test/api/catalog?q=${encodeURIComponent(q)}`, {
    headers: { "x-session-id": sessionId },
  });
  return (await res.json()) as any;
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Product details: basic lookup", () => {
  it("returns full detail for a real product id", async () => {
    const sessionId = await startSession();
    const { status, data } = await getDetails(sessionId, ["red-sports-tee"]);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.products).toHaveLength(1);
    const p = data.data.products[0];
    expect(p.productId).toBe("red-sports-tee");
    expect(p.name).toBe("Red Sports Tee");
    expect(p.price).toBe(79900);
    expect(p.price_display).toBe("₹799");
    expect(p.category).toBe("Tees");
    expect(typeof p.stock).toBe("number");
    expect(data.data.notFound).toEqual([]);
  });

  it("looks up several ids in one call", async () => {
    const sessionId = await startSession();
    const { data } = await getDetails(sessionId, ["red-sports-tee", "white-cotton-shirt", "black-leather-bag"]);
    expect(data.data.products).toHaveLength(3);
    const ids = data.data.products.map((p: any) => p.productId);
    expect(ids).toContain("red-sports-tee");
    expect(ids).toContain("white-cotton-shirt");
    expect(ids).toContain("black-leather-bag");
  });

  it("a mix of good and bad ids returns detail for the good ones and lists the bad ones separately, not a whole-batch failure", async () => {
    const sessionId = await startSession();
    const { status, data } = await getDetails(sessionId, ["red-sports-tee", "totally-fake-id"]);
    expect(status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.products).toHaveLength(1);
    expect(data.data.products[0].productId).toBe("red-sports-tee");
    expect(data.data.notFound).toEqual(["totally-fake-id"]);
  });

  it("all-bad ids still succeeds at the HTTP level, with an empty products list and everything in notFound", async () => {
    const sessionId = await startSession();
    const { data } = await getDetails(sessionId, ["fake-1", "fake-2"]);
    expect(data.success).toBe(true);
    expect(data.data.products).toEqual([]);
    expect(data.data.notFound).toEqual(["fake-1", "fake-2"]);
  });

  it("self-heals a wrong id against this session's last search_catalog results, same as add_to_cart", async () => {
    const sessionId = await startSession();
    await searchCatalog(sessionId, "tee"); // populates search_result_cache with red-sports-tee among results

    // A model might send a case/punctuation-mangled version of the real id
    // rather than the exact cached value — the self-heal path (see
    // lookupCachedProductId) should still resolve it against what was
    // actually shown, exactly like add_to_cart already does.
    const { data } = await getDetails(sessionId, ["RED-SPORTS-TEE"]);
    expect(data.data.products.some((p: any) => p.productId === "red-sports-tee")).toBe(true);
    expect(data.data.notFound).toEqual([]);
  });
});

describe("Product details: input validation and caps", () => {
  it("empty product_ids is rejected with 400", async () => {
    const sessionId = await startSession();
    const { status, data } = await getDetails(sessionId, []);
    expect(status).toBe(400);
    expect(data.success).toBe(false);
  });

  it("missing product_ids entirely is rejected with 400", async () => {
    const sessionId = await startSession();
    const res = await SELF.fetch("https://test/api/product-details", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("caps at 4 ids per call even if more are sent — matches the floating-window cap", async () => {
    const sessionId = await startSession();
    const { data } = await getDetails(sessionId, [
      "red-sports-tee", "white-cotton-shirt", "black-leather-bag", "ocean-blue-shirt", "classic-varsity-top",
    ]);
    // 5 requested, capped at 4 total ids actually looked up.
    expect(data.data.products.length + data.data.notFound.length).toBeLessThanOrEqual(4);
  });

  it("duplicate ids in the request are deduplicated, not looked up twice", async () => {
    const sessionId = await startSession();
    const { data } = await getDetails(sessionId, ["red-sports-tee", "red-sports-tee", "red-sports-tee"]);
    expect(data.data.products).toHaveLength(1);
  });

  it("401s without a session", async () => {
    const res = await SELF.fetch("https://test/api/product-details", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_ids: ["red-sports-tee"] }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Product details: rate limited", () => {
  it("throttles rapid repeated lookups on one session", async () => {
    const sessionId = await startSession();
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`product_details:session:${sessionId}`).run();

    let sawRateLimit = false;
    for (let i = 0; i < 45; i++) {
      const { status } = await getDetails(sessionId, ["red-sports-tee"]);
      if (status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
