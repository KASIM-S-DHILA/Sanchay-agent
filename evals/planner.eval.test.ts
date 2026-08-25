import { describe, it, expect, beforeAll } from "vitest";
import { callPlanner, parsePlan } from "../src/llm/planner";
import type { ProductSearchResult } from "../src/types";
import type { AIProvider } from "../src/llm/provider";
import { createEvalEnv, type EvalEnv } from "./helpers/eval-env";

let env: any;
let evalEnv: EvalEnv | null = null;

beforeAll(async () => {
  try {
    const mod: any = await import("cloudflare:test");
    env = mod.env;
  } catch {
    return;
  }
  // GROQ_API_KEY comes from .dev.vars via the worker env binding
  evalEnv = await createEvalEnv({ groqKey: env.GROQ_API_KEY });
}, 60000);

function getChatProvider(): AIProvider | null {
  return evalEnv?.chat ?? null;
}

function mockSearchResult(overrides: Partial<ProductSearchResult> & { productId: string }): ProductSearchResult {
  return {
    productId: overrides.productId,
    name: overrides.name ?? "Mock Product",
    description: overrides.description ?? "A mock product",
    price: overrides.price ?? 100000,
    category: overrides.category ?? "Tees",
    stock: overrides.stock ?? 50,
    score: overrides.score ?? 0.9,
  };
}

describe("Planner AI (skippable on quota)", () => {
  it("add the black tee -> add action with TEE-BLK-M", async () => {
    if (!getChatProvider()) { console.warn("Skipped: Groq/Ollama env unavailable"); return; }
    const searchResults = [mockSearchResult({ productId: "TEE-BLK-M", name: "Black Classic Tee", price: 129900, description: "Black tee" })];
    const plan = await callPlanner(getChatProvider()!, {
      userMessage: "add the black tee",
      searchResults,
      cart: [],
      history: [],
      lastDiscussedProductId: null,
      pendingIntent: null,
    });
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions[0].type).toBe("add");
    if (plan.actions[0].type === "add") {
      expect(plan.actions[0].productId).toBe("TEE-BLK-M");
      expect(plan.actions[0].quantity).toBe(1);
    }
    expect(plan.requestConfirm).toBe(false);
    expect(plan.requestCancel).toBe(false);
  });

  it("show me hoodies -> search action", async () => {
    if (!getChatProvider()) { console.warn("Skipped: Groq/Ollama env unavailable"); return; }
    const searchResults = [
      mockSearchResult({ productId: "HOOD-GRY", name: "Gray Pullover Hoodie", category: "Hoodies" }),
      mockSearchResult({ productId: "HOOD-BLK", name: "Black Zip Hoodie", category: "Hoodies" }),
    ];
    const plan = await callPlanner(getChatProvider()!, {
      userMessage: "show me hoodies",
      searchResults,
      cart: [],
      history: [],
      lastDiscussedProductId: null,
      pendingIntent: null,
    });
    expect(plan.actions[0].type).toBe("search");
    if (plan.actions[0].type === "search") {
      expect(plan.actions[0].query.toLowerCase()).toContain("hoodie");
    }
  });

  it("checkout -> requestConfirm true", async () => {
    if (!getChatProvider()) { console.warn("Skipped: Groq/Ollama env unavailable"); return; }
    const plan = await callPlanner(getChatProvider()!, {
      userMessage: "checkout",
      searchResults: [],
      cart: [{ productId: "TEE-BLK-M", name: "Black Classic Tee", price: 129900, quantity: 2 }],
      history: [],
      lastDiscussedProductId: "TEE-BLK-M",
      pendingIntent: null,
    });
    expect(plan.requestConfirm).toBe(true);
    expect(plan.actions[0].type).toBe("no_action");
  });

  it("cancel -> requestCancel true", async () => {
    if (!getChatProvider()) { console.warn("Skipped: Groq/Ollama env unavailable"); return; }
    const plan = await callPlanner(getChatProvider()!, {
      userMessage: "cancel",
      searchResults: [],
      cart: [],
      history: [],
      lastDiscussedProductId: null,
      pendingIntent: null,
    });
    expect(plan.requestCancel).toBe(true);
  });

  it("add one more with lastDiscussedProductId -> add that product", async () => {
    if (!getChatProvider()) { console.warn("Skipped: Groq/Ollama env unavailable"); return; }
    const plan = await callPlanner(getChatProvider()!, {
      userMessage: "add one more",
      searchResults: [],
      cart: [{ productId: "TEE-BLK-M", name: "Black Classic Tee", price: 129900, quantity: 1 }],
      history: [{ role: "user", content: "add the black tee", timestamp: new Date().toISOString() }],
      lastDiscussedProductId: "TEE-BLK-M",
      pendingIntent: null,
    });
    expect(plan.actions[0].type).toBe("add");
    if (plan.actions[0].type === "add") {
      expect(plan.actions[0].productId).toBe("TEE-BLK-M");
    }
  });

  it("empty search and cart -> no_action", async () => {
    if (!getChatProvider()) { console.warn("Skipped: Groq/Ollama env unavailable"); return; }
    const plan = await callPlanner(getChatProvider()!, {
      userMessage: "asdfgh jkl",
      searchResults: [],
      cart: [],
      history: [],
      lastDiscussedProductId: null,
      pendingIntent: null,
    });
    expect(plan.actions[0].type).toBe("no_action");
  });
});

describe("parsePlan pure function", () => {
  it("handles malformed JSON gracefully", () => {
    const result = parsePlan("not json at all {{{");
    expect(result.actions[0].type).toBe("no_action");
    expect(result.reasoning).toBe("Failed to parse planner output");
    expect(result.reply).toBe("I didn't understand that. Could you rephrase?");
  });

  it("handles markdown code fences", () => {
    const raw = '```json\n{"actions":[{"type":"search","query":"hoodies"}],"requestConfirm":false,"requestCancel":false,"reasoning":"test","reply":"hi"}\n```';
    const result = parsePlan(raw);
    expect(result.actions[0].type).toBe("search");
    if (result.actions[0].type === "search") {
      expect(result.actions[0].query).toBe("hoodies");
    }
  });

  it("handles markdown fences without json tag", () => {
    const raw = '```\n{"actions":[{"type":"no_action"}],"requestConfirm":false,"requestCancel":false,"reasoning":"x","reply":"y"}\n```';
    const result = parsePlan(raw);
    expect(result.actions[0].type).toBe("no_action");
  });

  it("validates action structure (rejects add without productId)", () => {
    const raw = JSON.stringify({
      actions: [{ type: "add", quantity: 1 }],
      requestConfirm: false,
      requestCancel: false,
      reasoning: "bad",
      reply: "hi",
    });
    const result = parsePlan(raw);
    expect(result.actions[0].type).toBe("no_action");
    expect(result.reasoning).toBe("Invalid plan structure");
  });

  it("validates add quantity must be positive integer", () => {
    const raw = JSON.stringify({
      actions: [{ type: "add", productId: "X", quantity: 0 }],
      requestConfirm: false,
      requestCancel: false,
      reasoning: "bad",
      reply: "hi",
    });
    const result = parsePlan(raw);
    expect(result.actions[0].type).toBe("no_action");
  });

  it("validates remove must have productId", () => {
    const raw = JSON.stringify({
      actions: [{ type: "remove" }],
      requestConfirm: false,
      requestCancel: false,
      reasoning: "bad",
      reply: "hi",
    });
    const result = parsePlan(raw);
    expect(result.actions[0].type).toBe("no_action");
  });

  it("parses valid JSON correctly", () => {
    const raw = JSON.stringify({
      actions: [{ type: "add", productId: "TEE-BLK-M", quantity: 2 }],
      requestConfirm: false,
      requestCancel: true,
      reasoning: "test reasoning",
      reply: "Adding product",
    });
    const result = parsePlan(raw);
    expect(result.actions[0].type).toBe("add");
    expect(result.requestCancel).toBe(true);
    expect(result.reasoning).toBe("test reasoning");
    expect(result.reply).toBe("Adding product");
  });
});


