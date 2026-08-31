import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers POST/GET /api/viewed-products (src/api/viewedProducts.ts) — the
 * "seen but not bought" signal logged once a floating product-detail
 * window has stayed open past the frontend's dwell-time debounce (see
 * useProductWindows.ts). The debounce itself is frontend timing and has no
 * eval coverage mechanism here; these tests exercise the backend contract
 * these calls land on: logViewedProduct/getViewedProducts in src/api/logic.ts.
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

async function logViewed(sessionId: string, productId: string) {
  const res = await SELF.fetch("https://test/api/viewed-products", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify({ product_id: productId }),
  });
  return { status: res.status, data: (await res.json()) as any };
}

async function getViewed(sessionId: string) {
  const res = await SELF.fetch("https://test/api/viewed-products", { headers: { "x-session-id": sessionId } });
  return (await res.json()) as any;
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Viewed products: basic logging and retrieval", () => {
  it("logs a real product and it shows up in the viewed list", async () => {
    const sessionId = await startSession();
    const { status, data } = await logViewed(sessionId, "red-sports-tee");
    expect(status).toBe(200);
    expect(data.success).toBe(true);

    const viewed = await getViewed(sessionId);
    expect(viewed.success).toBe(true);
    expect(viewed.data.viewed.map((v: any) => v.productId)).toContain("red-sports-tee");
    expect(viewed.data.viewed.find((v: any) => v.productId === "red-sports-tee").name).toBe("Red Sports Tee");
  });

  it("a hallucinated/nonexistent product id is silently ignored, not an error", async () => {
    const sessionId = await startSession();
    const { status, data } = await logViewed(sessionId, "not-a-real-product");
    expect(status).toBe(200);
    expect(data.success).toBe(true); // request itself succeeds...

    const viewed = await getViewed(sessionId);
    expect(viewed.data.viewed).toEqual([]); // ...but nothing fake was recorded
  });

  it("a session with nothing viewed gets an empty array, not an error", async () => {
    const sessionId = await startSession();
    const viewed = await getViewed(sessionId);
    expect(viewed.success).toBe(true);
    expect(viewed.data.viewed).toEqual([]);
  });

  it("missing product_id is rejected with 400", async () => {
    const sessionId = await startSession();
    const res = await SELF.fetch("https://test/api/viewed-products", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("401s without a session for both POST and GET", async () => {
    const postRes = await SELF.fetch("https://test/api/viewed-products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: "red-sports-tee" }),
    });
    expect(postRes.status).toBe(401);

    const getRes = await SELF.fetch("https://test/api/viewed-products");
    expect(getRes.status).toBe(401);
  });
});

describe("Viewed products: reopen bumps recency instead of duplicating", () => {
  it("logging the same product twice results in exactly one row, not two", async () => {
    const sessionId = await startSession();
    await logViewed(sessionId, "red-sports-tee");
    await logViewed(sessionId, "red-sports-tee");

    const rows: any[] = (
      await env.DB.prepare("SELECT COUNT(*) as c FROM viewed_products WHERE session_id = ? AND product_id = ?")
        .bind(sessionId, "red-sports-tee")
        .all()
    ).results ?? [];
    expect(rows[0].c).toBe(1);
  });

  it("re-viewing an older product brings it back to the front of the list", async () => {
    const sessionId = await startSession();
    await logViewed(sessionId, "red-sports-tee");
    await new Promise((r) => setTimeout(r, 5));
    await logViewed(sessionId, "white-cotton-shirt");

    let viewed = await getViewed(sessionId);
    expect(viewed.data.viewed[0].productId).toBe("white-cotton-shirt"); // most recent first

    await new Promise((r) => setTimeout(r, 5));
    await logViewed(sessionId, "red-sports-tee"); // re-view the older one

    viewed = await getViewed(sessionId);
    expect(viewed.data.viewed[0].productId).toBe("red-sports-tee"); // now most recent
  });
});

describe("Viewed products: capped and session-scoped", () => {
  it("returns at most 8 distinct products, newest first", async () => {
    const sessionId = await startSession();
    const ids = [
      "ocean-blue-shirt", "classic-varsity-top", "yellow-wool-jumper", "floral-white-top",
      "striped-silk-blouse", "classic-leather-jacket", "dark-denim-top", "navy-sport-jacket",
      "dark-winter-jacket", "black-leather-bag",
    ]; // 10 distinct ids, more than the cap of 8
    for (const id of ids) {
      await logViewed(sessionId, id);
      await new Promise((r) => setTimeout(r, 2));
    }

    const viewed = await getViewed(sessionId);
    expect(viewed.data.viewed).toHaveLength(8);
    expect(viewed.data.viewed[0].productId).toBe("black-leather-bag"); // most recently viewed
  });

  it("a different session never sees another session's viewed products", async () => {
    const sessionA = await startSession();
    await logViewed(sessionA, "red-sports-tee");

    const sessionB = await startSession();
    const viewedB = await getViewed(sessionB);
    expect(viewedB.data.viewed).toEqual([]);
  });

  it("is session-scoped, not account-scoped — two sessions for the same email don't share viewed products", async () => {
    const email = "viewed-scope-check@example.com";
    const sessionA = await startSession({ user_email: email });
    await logViewed(sessionA, "red-sports-tee");

    const sessionB = await startSession({ user_email: email });
    const viewedB = await getViewed(sessionB);
    expect(viewedB.data.viewed).toEqual([]); // viewed_products is keyed by session_id, not email
  });
});

describe("Viewed products: rate limited", () => {
  it("throttles rapid repeated logging on one session", async () => {
    const sessionId = await startSession();
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`viewed_products:session:${sessionId}`).run();

    let sawRateLimit = false;
    for (let i = 0; i < 65; i++) {
      const { status } = await logViewed(sessionId, "red-sports-tee");
      if (status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
