import { describe, it, expect, beforeAll } from "vitest";
import { extractBudgetIntent } from "../src/mandates/index";
import { issueIntentMandate, verifyMandate, __resetMandateKeysForTest } from "../src/mandates/jwt";

// Cloudflare env for D1 tests — only available in cloudflare pool
let env: any;

describe("Budget extractor", () => {
  it('under 500 -> detected, value 50000 paise', () => {
    const r = extractBudgetIntent("show me hoodies under 500");
    expect(r.detected).toBe(true);
    expect(r.value).toBe(50000);
    expect(r.span).toBeDefined();
    expect(r.span!.toLowerCase()).toContain("under 500");
  });

  it('budget of 2k -> detected, value 200000 paise', () => {
    const r = extractBudgetIntent("budget of 2k");
    expect(r.detected).toBe(true);
    expect(r.value).toBe(200000);
    expect(r.span!.toLowerCase()).toContain("budget of 2k");
  });

  it('spend up to 1.5 lakh -> detected, value 15000000 paise', () => {
    const r = extractBudgetIntent("spend up to 1.5 lakh");
    expect(r.detected).toBe(true);
    expect(r.value).toBe(15000000);
    expect(r.span!.toLowerCase()).toContain("spend up to 1.5 lakh");
  });

  it('below 2k detects as 200000', () => {
    const r = extractBudgetIntent("shirts below 2k please");
    expect(r.detected).toBe(true);
    expect(r.value).toBe(200000);
  });

  it('max 2000 detects', () => {
    const r = extractBudgetIntent("max 2000");
    expect(r.detected).toBe(true);
    expect(r.value).toBe(200000);
  });

  it('show me shirts -> not detected', () => {
    const r = extractBudgetIntent("show me shirts");
    expect(r.detected).toBe(false);
    expect(r.value).toBeUndefined();
  });
});

describe("Mandate JWT round-trip", () => {
  beforeAll(async () => {
    try {
      const mod = await import("cloudflare:test");
      env = (mod as any).env;
    } catch {
      // Fallback for node pool — create mock env with in-memory D1?
      env = null;
    }
    // Reset cached keys for clean test
    __resetMandateKeysForTest();
    // Ensure env has required fields for fallback
    if (!env) {
      const { env: cenv } = await import("cloudflare:test").catch(() => ({ env: null }));
      env = cenv;
    }
  });

  it("issue -> verify -> correct claims", async () => {
    if (!env?.DB) {
      console.warn("Skipping JWT D1 test — no D1 binding in this pool, testing with mock DB");
      // Create mock env with in-memory DB stub
      const mockDB = {
        prepare: (sql: string) => ({
          bind: (..._args: any[]) => ({
            run: async () => ({}),
            first: async () => null,
          }),
          run: async () => ({}),
          first: async () => null,
        }),
      };
      const mockEnv = { DB: mockDB, JWT_SIGNING_KEY: "test-key" } as any;
      const jwt = await issueIntentMandate(mockEnv, "sess-123", 50000, "under 500");
      expect(typeof jwt).toBe("string");
      expect(jwt.split(".").length).toBe(3);
      const claims = await verifyMandate(mockEnv, jwt);
      expect(claims.sub).toBe("sess-123");
      expect(claims.intent).toBe("budget");
      expect(claims.value).toBe(50000);
      return;
    }

    const jwt = await issueIntentMandate(env, "sess-123", 50000, "under 500");
    expect(typeof jwt).toBe("string");
    expect(jwt.split(".").length).toBe(3);

    const claims = await verifyMandate(env, jwt);
    expect(claims.sub).toBe("sess-123");
    expect(claims.intent).toBe("budget");
    expect(claims.value).toBe(50000);

    // Verify span and sub via DB persistence check
    const row = await env.DB.prepare(`SELECT * FROM intent_mandates WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind("sess-123")
      .first();
    expect(row).toBeDefined();
    if (row) {
      expect((row as any).budget_value).toBe(50000);
      expect((row as any).span).toBe("under 500");
    }
  });

  it("budget of 2k JWT stores correct paise", async () => {
    const mockDB = env?.DB
      ? env.DB
      : {
          prepare: () => ({
            bind: () => ({ run: async () => ({}), first: async () => null }),
            run: async () => ({}),
            first: async () => null,
          }),
        };
    const mockEnv = env?.DB ? env : ({ DB: mockDB, JWT_SIGNING_KEY: env?.JWT_SIGNING_KEY ?? "test-key" } as any);
    __resetMandateKeysForTest();
    const jwt = await issueIntentMandate(mockEnv, "sess-2k", 200000, "budget of 2k");
    const claims = await verifyMandate(mockEnv, jwt);
    expect(claims.value).toBe(200000);
  });

  it("spend up to 1.5 lakh JWT stores 15000000", async () => {
    const mockDB = env?.DB
      ? env.DB
      : {
          prepare: () => ({
            bind: () => ({ run: async () => ({}), first: async () => null }),
            run: async () => ({}),
            first: async () => null,
          }),
        };
    const mockEnv = env?.DB ? env : ({ DB: mockDB, JWT_SIGNING_KEY: env?.JWT_SIGNING_KEY ?? "test-key" } as any);
    __resetMandateKeysForTest();
    const jwt = await issueIntentMandate(mockEnv, "sess-lakh", 15000000, "spend up to 1.5 lakh");
    const claims = await verifyMandate(mockEnv, jwt);
    expect(claims.value).toBe(15000000);
  });
});
