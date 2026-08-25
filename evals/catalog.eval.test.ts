import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { searchProducts } from "../src/catalog/search";
import { createEvalEnv, withMockVectorize, type EvalEnv } from "./helpers/eval-env";

// Cloudflare bindings — available only in cloudflare pool
let env: any;
let evalEnv: EvalEnv | null = null;
// Mock env: real D1 + MockVectorizeIndex — used for local semantic search tests
let mockEnv: any = null;

beforeAll(async () => {
  try {
    const mod: any = await import("cloudflare:test");
    env = mod.env;
  } catch {
    return;
  }

  // Seed FIRST so createEvalEnv can pre-populate the mock index
  await seedCatalog(env);

  evalEnv = await createEvalEnv({ groqKey: env.GROQ_API_KEY, db: env.DB });
  if (evalEnv) {
    mockEnv = withMockVectorize(env, evalEnv.vectorize);
    console.log(`Using Groq chat + Ollama embeddings + MockVectorize (${evalEnv.vectorize.size()} vectors)`);
  }
}, 60000);

describe("Catalog seeding", () => {
  it("seedCatalog populates the products table (count > 0)", async () => {
    await seedCatalog(env);
    const result: any = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM products`).first();
    expect(result?.cnt).toBeGreaterThan(0);
  });

  it("seedCatalog is idempotent (calling twice doesn't duplicate)", async () => {
    await seedCatalog(env);
    const before: any = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM products`).first();
    await seedCatalog(env);
    const after: any = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM products`).first();
    expect(after?.cnt).toBe(before?.cnt);
  });
});

describe("Semantic search (Ollama embeddings + MockVectorize)", () => {
  it("searchProducts('black tee', 5) returns tee-related product", async () => {
    if (!mockEnv) {
      console.warn("Skipped: GROQ_API_KEY/Ollama unavailable");
      return;
    }
    const results = await searchProducts(mockEnv, "black tee", 5, evalEnv!.embed);
    expect(results.length).toBeGreaterThan(0);
    const hasTee = results.some((r) => r.name.toLowerCase().includes("tee") || r.category.toLowerCase().includes("tee"));
    expect(hasTee).toBe(true);
  });

  it("searchProducts('warm jacket for winter', 3) returns semantic results", async () => {
    if (!mockEnv) {
      console.warn("Skipped: GROQ_API_KEY/Ollama unavailable");
      return;
    }
    const results = await searchProducts(mockEnv, "warm jacket for winter", 3, evalEnv!.embed);
    expect(results.length).toBeGreaterThan(0);
    const hasJacket = results.some(
      (r) =>
        r.name.toLowerCase().includes("jacket") ||
        r.description.toLowerCase().includes("warm") ||
        r.category.toLowerCase().includes("jacket")
    );
    expect(hasJacket).toBe(true);
  });
});

describe("Catalog HTTP", () => {
  it("GET /catalog.json returns all products", async () => {
    await seedCatalog(env);
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://example.com/catalog.json");
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    const first = data[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("price");
  });

  it("GET /catalog.json?q=hoodie returns filtered results", async () => {
    await seedCatalog(env);
    const { SELF } = await import("cloudflare:test");
    const res = await SELF.fetch("http://example.com/catalog.json?q=hoodie");
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    const hasHoodie = data.some(
      (p: any) => p.name.toLowerCase().includes("hoodie") || p.category.toLowerCase().includes("hoodie")
    );
    expect(hasHoodie).toBe(true);
  });
});
