import { describe, it, expect, beforeAll } from "vitest";
import { callNarrator, NARRATOR_FALLBACK } from "../src/llm/narrator";
import type { AIProvider } from "../src/llm/provider";
import type { ExecutorResult, ProductSearchResult } from "../src/types";
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
  evalEnv = await createEvalEnv({ groqKey: env.GROQ_API_KEY });
}, 60000);

function getChat(): AIProvider | null {
  return evalEnv?.chat ?? null;
}

function makeResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    actions: [{ type: "no_action", success: true }],
    cart: [],
    cartTotal: 0,
    errors: [],
    stateChanges: {},
    ...overrides,
  };
}

function teeProduct(): ProductSearchResult {
  return {
    productId: "TEE-BLACK-001",
    name: "Black Classic Tee",
    description: "Soft cotton black tee",
    price: 79900,
    category: "Tees",
    stock: 50,
    score: 0.9,
  };
}

// Lenient prose assertions — LLM output varies, so check OR-groups of keywords
const saidAny = (reply: string, ...keywords: string[]) => {
  const lower = reply.toLowerCase();
  return keywords.some((k) => lower.includes(k));
};

describe("Narrator (Groq)", () => {
  it("successful add mentions product name and price in rupees", async () => {
    if (!getChat()) { console.warn("Skipped: Groq/Ollama unavailable"); return; }
    const result = makeResult({
      actions: [{ type: "add", productId: "TEE-BLACK-001", productName: "Black Classic Tee", quantity: 1, success: true, price: 79900 }],
      cart: [{ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900, quantity: 1 }],
      cartTotal: 79900,
    });
    const reply = await callNarrator(getChat()!, {
      userMessage: "add the black tee",
      executorResult: result,
      history: [],
      cart: result.cart,
      cartTotal: result.cartTotal,
      pendingIntent: null,
    });
    console.log("add-success reply:", reply);
    expect(reply.toLowerCase()).toContain("black classic tee");
    // Price in rupees (₹799), never paise
    expect(/₹\s*799|799 rupees/i.test(reply)).toBe(true);
    expect(reply).not.toContain("79900");
    expect(reply).not.toContain("799.00 paise");
  });

  it("out-of-stock failure acknowledged with next step", async () => {
    if (!getChat()) return;
    const result = makeResult({
      actions: [{ type: "add", productId: "JACKET-WARM-001", productName: "Winter Warm Puffer Jacket", quantity: 1, success: false, error: "Out of stock" }],
      errors: ["Out of stock: JACKET-WARM-001"],
    });
    const reply = await callNarrator(getChat()!, {
      userMessage: "add the warm jacket",
      executorResult: result,
      history: [],
      cart: [],
      cartTotal: 0,
      pendingIntent: null,
    });
    console.log("oos reply:", reply);
    // Must NOT claim the add succeeded
    expect(saidAny(reply, "added to your cart", "i've added", "i have added")).toBe(false);
    expect(saidAny(reply, "out of stock", "unavailable", "sorry", "currently not")).toBe(true);
  });

  it("search presents available products", async () => {
    if (!getChat()) return;
    const results = [
      teeProduct(),
      { ...teeProduct(), productId: "TEE-WHITE-002", name: "White Oversized Tee", price: 89900 },
    ];
    const result = makeResult({ actions: [{ type: "search", success: true }] });
    const reply = await callNarrator(getChat()!, {
      userMessage: "show me tees",
      executorResult: result,
      history: [],
      cart: [],
      cartTotal: 0,
      pendingIntent: null,
      searchResults: results,
    });
    console.log("search reply:", reply);
    expect(saidAny(reply, "black classic tee", "white oversized")).toBe(true);
    expect(saidAny(reply, "₹")).toBe(true);
  });

  it("confirm_checkout acknowledged warmly", async () => {
    if (!getChat()) return;
    const result = makeResult({ actions: [{ type: "confirm_checkout", success: true }] });
    const reply = await callNarrator(getChat()!, {
      userMessage: "yes",
      executorResult: result,
      history: [],
      cart: [{ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900, quantity: 1 }],
      cartTotal: 79900,
      pendingIntent: null,
    });
    console.log("checkout reply:", reply);
    expect(saidAny(reply, "checkout", "order", "payment", "get you checked")).toBe(true);
  });

  it("cancel_confirmed reassures cart is saved", async () => {
    if (!getChat()) return;
    const result = makeResult({ actions: [{ type: "cancel_confirmed", success: true }] });
    const reply = await callNarrator(getChat()!, {
      userMessage: "no",
      executorResult: result,
      history: [],
      cart: [{ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900, quantity: 1 }],
      cartTotal: 79900,
      pendingIntent: null,
    });
    console.log("cancel reply:", reply);
    expect(saidAny(reply, "saved", "whenever", "still there", "keep", "ready")).toBe(true);
  });

  it("empty cart after no_action suggests browsing", async () => {
    if (!getChat()) return;
    const result = makeResult({});
    const reply = await callNarrator(getChat()!, {
      userMessage: "hello",
      executorResult: result,
      history: [],
      cart: [],
      cartTotal: 0,
      pendingIntent: null,
    });
    console.log("empty-cart reply:", reply);
    expect(reply.length).toBeGreaterThan(10);
    expect(saidAny(reply, "looking", "browse", "help", "find", "popular", "interested", "search")).toBe(true);
  });
});

describe("Narrator fallback (pure)", () => {
  const baseParams = {
    userMessage: "add something",
    history: [],
    cart: [],
    cartTotal: 0,
    pendingIntent: null,
  };

  it("returns fallback when the provider call throws", async () => {
    const failing: AIProvider = {
      chat: async () => { throw new Error("boom"); },
      embed: async () => [],
    };
    const reply = await callNarrator(failing, {
      ...baseParams,
      executorResult: makeResult(),
    });
    expect(reply).toBe(NARRATOR_FALLBACK);
  });

  it("returns fallback when the model returns empty string", async () => {
    const empty: AIProvider = {
      chat: async () => "",
      embed: async () => [],
    };
    const reply = await callNarrator(empty, {
      ...baseParams,
      executorResult: makeResult(),
    });
    expect(reply).toBe(NARRATOR_FALLBACK);
  });

  it("strips code fences and wrapping quotes from prose output", async () => {
    const fenced: AIProvider = {
      chat: async () => '``` \n"Got it! Added the Black Classic Tee."\n```',
      embed: async () => [],
    };
    const reply = await callNarrator(fenced, {
      ...baseParams,
      executorResult: makeResult({
        actions: [{ type: "add", productName: "Black Classic Tee", quantity: 1, success: true, price: 79900 }],
        cartTotal: 79900,
      }),
    });
    expect(reply).not.toContain("```");
    expect(reply.startsWith('"')).toBe(false);
    expect(reply).toContain("Black Classic Tee");
  });
});
