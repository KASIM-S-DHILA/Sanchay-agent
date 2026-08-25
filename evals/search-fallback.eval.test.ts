import { describe, it, expect, beforeAll } from "vitest";
import { searchProducts } from "../src/catalog/search";
import { seedCatalog } from "../src/catalog/seed";
import { createEvalEnv, withMockVectorize, type EvalEnv } from "./helpers/eval-env";

let env: any;
let evalEnv: EvalEnv | null = null;
let mockEnv: any = null;

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await seedCatalog(env);
  evalEnv = await createEvalEnv({ groqKey: env.GROQ_API_KEY, db: env.DB });
  if (evalEnv) {
    mockEnv = withMockVectorize(env, evalEnv.vectorize);
    console.log(`Using Ollama embeddings + MockVectorize (${evalEnv.vectorize.size()} vectors) for semantic tests`);
  }
}, 60000);

describe("Search fallback", () => {
  it("fallback LIKE search works when Vectorize returns empty", async () => {
    // Mock env with Vectorize returning empty
    const mockEnv: any = {
      ...env,
      VECTOR_INDEX: {
        query: async () => ({ matches: [] }),
        upsert: async () => {},
      },
      AI: {
        // Return valid 768-dim vector to pass embedding step
        run: async () => ({ data: [Array(768).fill(0.01)] }),
      },
    };
    const results = await searchProducts(mockEnv, "black tee", 5);
    expect(results.length).toBeGreaterThan(0);
    // Fallback should return tee via LIKE
    const hasTee = results.some((r) => r.name.toLowerCase().includes("tee"));
    expect(hasTee).toBe(true);
    // Fallback scores are 0
    expect(results[0].score).toBe(0);
  });

  it("fallback handles special characters gracefully", async () => {
    const mockEnv: any = {
      ...env,
      VECTOR_INDEX: {
        query: async () => {
          throw new Error("Vectorize error");
        },
        upsert: async () => {},
      },
      AI: {
        run: async () => ({ data: [Array(768).fill(0.01)] }),
      },
    };
    const specialQueries = ["100% cotton", "tee's", "black_tee", "hoodie\\test", "a%_b"];
    for (const q of specialQueries) {
      const results = await searchProducts(mockEnv, q, 5);
      // Should not throw, return array (may be empty)
      expect(Array.isArray(results)).toBe(true);
    }
  });

  it("fallback handles Vectorize error gracefully", async () => {
    const mockEnv: any = {
      ...env,
      VECTOR_INDEX: {
        query: async () => {
          throw new Error("Vectorize unavailable");
        },
        upsert: async () => {},
      },
      AI: {
        run: async () => ({ data: [Array(768).fill(0.02)] }),
      },
    };
    const results = await searchProducts(mockEnv, "hoodie", 5);
    expect(Array.isArray(results)).toBe(true);
    // Should fallback to LIKE and find hoodie
    expect(results.length).toBeGreaterThan(0);
  });

  it("fallback handles AI error gracefully", async () => {
    const mockEnv: any = {
      ...env,
      AI: {
        run: async () => {
          throw new Error("AI quota exhausted");
        },
      },
      VECTOR_INDEX: {
        query: async () => ({ matches: [] }),
        upsert: async () => {},
      },
    };
    const results = await searchProducts(mockEnv, "hoodie", 5);
    expect(Array.isArray(results)).toBe(true);
    // Should fallback to LIKE
    expect(results.length).toBeGreaterThan(0);
  });
});

// Semantic path with real Ollama embeddings against the in-memory index —
// proves vector search works end-to-end without Workers AI/Vectorize.
describe("Semantic search via Ollama + MockVectorize (local)", () => {
  it("finds hoodie semantically through cosine similarity", async () => {
    if (!mockEnv) {
      console.warn("Skipped: GROQ_API_KEY/Ollama unavailable");
      return;
    }
    const results = await searchProducts(mockEnv, "cozy hoodie for cold days", 5, evalEnv!.embed);
    expect(results.length).toBeGreaterThan(0);
    const hasHoodie = results.some(
      (r) => r.name.toLowerCase().includes("hoodie") || r.category.toLowerCase().includes("hoodie")
    );
    expect(hasHoodie).toBe(true);
    // Vector results carry real similarity scores, not the LIKE fallback's 0
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("scores exact-name match higher than unrelated product", async () => {
    if (!mockEnv) return;
    const results = await searchProducts(mockEnv, "black tee", 12, evalEnv!.embed);
    expect(results.length).toBeGreaterThan(1);
    const blackTee = results.find((r) => r.productId === "TEE-BLACK-001");
    const sneakers = results.find((r) => r.productId === "SNEAKERS-WHITE-001");
    expect(blackTee).toBeDefined();
    expect(sneakers).toBeDefined();
    if (blackTee && sneakers) {
      expect(blackTee.score!).toBeGreaterThan(sneakers.score!);
    }
  });
});
