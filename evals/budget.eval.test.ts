import { SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import { seedCatalog } from "../src/catalog/seed";
import { bootstrapSchema } from "./helpers/bootstrap";

/**
 * Covers /api/session/budget (used by both the browser cap form and the
 * Gemini Live set_budget voice tool — see setBudget in src/api/logic.ts).
 * The core requirement under test: a budget is a per-VISIT (session)
 * setting, never an account-level preference — nothing about it should
 * survive into a fresh session, signed in or not.
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

async function setBudget(sessionId: string, body: Record<string, unknown>) {
  const res = await SELF.fetch("https://test/api/session/budget", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-session-id": sessionId },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

async function addProduct(sessionId: string, productId: string, quantity = 1) {
  return (
    await SELF.fetch("https://test/api/cart/add", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-session-id": sessionId },
      body: JSON.stringify({ product_id: productId, quantity }),
    })
  ).json() as Promise<any>;
}

async function getCart(sessionId: string) {
  const res = await SELF.fetch("https://test/api/cart", { headers: { "x-session-id": sessionId } });
  return res.json() as Promise<any>;
}

async function resetBudgetRateLimit(sessionId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(`set_budget:session:${sessionId}`).run();
}

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await bootstrapSchema(env.DB);
  await seedCatalog(env);
});

describe("Budget: basic set/change", () => {
  it("sets a budget and reports remaining correctly", async () => {
    const sessionId = await startSession();
    const res = await setBudget(sessionId, { budget: 3000 });
    expect(res.success).toBe(true);
    expect(res.data.budget).toBe(300000); // paise
    expect(res.data.budgetRemaining).toBe(300000);
  });

  it("changing an existing budget updates remaining against current cart", async () => {
    const sessionId = await startSession();
    await addProduct(sessionId, "TEE-BLACK-001");
    const cart = await getCart(sessionId);

    const res = await setBudget(sessionId, { budget: 5000 });
    expect(res.success).toBe(true);
    expect(res.data.budgetRemaining).toBe(500000 - cart.data.total);
  });
});

describe("Budget: rejects invalid input", () => {
  it("rejects zero", async () => {
    const sessionId = await startSession();
    const res = await setBudget(sessionId, { budget: 0 });
    expect(res.success).toBe(false);
  });

  it("rejects negative", async () => {
    const sessionId = await startSession();
    const res = await setBudget(sessionId, { budget: -500 });
    expect(res.success).toBe(false);
  });

  it("rejects non-numeric", async () => {
    const sessionId = await startSession();
    const res = await setBudget(sessionId, { budget: "three thousand" });
    expect(res.success).toBe(false);
  });

  it("rejects an absurdly large budget", async () => {
    const sessionId = await startSession();
    const res = await setBudget(sessionId, { budget: 50_000_000 });
    expect(res.success).toBe(false);
  });

  it("rejects a budget below the current cart total, leaving the old budget untouched", async () => {
    const sessionId = await startSession();
    await setBudget(sessionId, { budget: 3000 });
    await addProduct(sessionId, "TEE-BLACK-001");
    const cart = await getCart(sessionId);
    const tooLow = Math.floor(cart.data.total / 100) - 1; // rupees, definitely below cart total

    const res = await setBudget(sessionId, { budget: tooLow });
    expect(res.success).toBe(false);
    expect(res.error).toContain("already exceeds");

    // Old budget is still in effect — rejection doesn't clear it.
    const row: any = await env.DB.prepare("SELECT budget_paise FROM sessions WHERE id = ?").bind(sessionId).first();
    expect(row.budget_paise).toBe(300000);
  });
});

describe("Budget: clearing removes the cap entirely", () => {
  it("clear=true removes an existing cap", async () => {
    const sessionId = await startSession();
    await setBudget(sessionId, { budget: 3000 });

    const res = await setBudget(sessionId, { clear: true });
    expect(res.success).toBe(true);
    expect(res.data.budget).toBeNull();

    const row: any = await env.DB.prepare("SELECT budget_paise FROM sessions WHERE id = ?").bind(sessionId).first();
    expect(row.budget_paise).toBeNull();
  });

  it("clear=true on a session with no cap set is a harmless no-op", async () => {
    const sessionId = await startSession();
    const res = await setBudget(sessionId, { clear: true });
    expect(res.success).toBe(true);
    expect(res.data.budget).toBeNull();
  });

  it("after clearing, add_to_cart is unconstrained by the old budget", async () => {
    const sessionId = await startSession();
    await setBudget(sessionId, { budget: 100 }); // ₹100 — too low for most items
    await setBudget(sessionId, { clear: true });

    const res = await addProduct(sessionId, "TEE-BLACK-001", 5);
    // Should succeed on stock alone now that budget is cleared — not
    // rejected for exceeding a budget that no longer exists.
    expect(res.success).toBe(true);
  });
});

describe("Budget: session-scoped, never account-scoped", () => {
  it("a budget set on one session has no effect on a different session for the same email", async () => {
    const email = "budget-scope@example.com";
    const sessionA = await startSession({ user_email: email });
    await setBudget(sessionA, { budget: 1000 });

    const sessionB = await startSession({ user_email: email });
    const rowB: any = await env.DB.prepare("SELECT budget_paise FROM sessions WHERE id = ?").bind(sessionB).first();
    expect(rowB.budget_paise).toBeNull();

    // Confirms nothing budget-related ever landed on the account itself.
    const prefs: any = await env.DB.prepare("SELECT budget_preference FROM user_preferences WHERE user_id = ?")
      .bind(email)
      .first();
    expect(prefs?.budget_preference ?? null).toBeNull();
  });

  it("a fresh session for a signed-in-equivalent account starts uncapped even after a previous session set one", async () => {
    const email = "budget-persist-check@example.com";
    const first = await startSession({ user_email: email });
    await setBudget(first, { budget: 2000 });
    await setBudget(first, { budget: 4000 }); // change it once more, still session-only

    const second = await startSession({ user_email: email });
    const res = await setBudget(second, { budget: 1 }); // any positive number, cart is empty
    expect(res.success).toBe(true);
    expect(res.data.budget).toBe(100); // ₹1 accepted — nothing carried over from the first session's ₹4000
  });
});

describe("Budget: endpoints without a session are rejected", () => {
  it("401s without x-session-id", async () => {
    const res = await SELF.fetch("https://test/api/session/budget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget: 1000 }),
    });
    expect(res.status).toBe(401);
  });
});

describe("Budget: rate limited per session", () => {
  it("throttles rapid repeated budget changes on one session", async () => {
    const sessionId = await startSession();
    await resetBudgetRateLimit(sessionId);

    let sawRateLimit = false;
    for (let i = 0; i < 25; i++) {
      const res = await SELF.fetch("https://test/api/session/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-session-id": sessionId },
        body: JSON.stringify({ budget: 1000 + i }),
      });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});
