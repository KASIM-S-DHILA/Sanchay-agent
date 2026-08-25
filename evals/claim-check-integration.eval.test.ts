import { describe, it, expect, beforeAll } from "vitest";
import { executeTurn } from "../src/executor/index";
import { callNarrator } from "../src/llm/narrator";
import { buildFacts } from "../src/claim-check/facts";
import { claimsConsistent } from "../src/claim-check/index";
import { renderFallback } from "../src/claim-check/templates";
import { neverSilentGuard } from "../src/claim-check/never-silent";
import { seedCatalog } from "../src/catalog/seed";
import type { AIProvider } from "../src/llm/provider";
import type { ExecutorResult, ProductSearchResult, TurnPlan, AgentState } from "../src/types";

let env: any;
let evalEnv: any = null;

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await seedCatalog(env);
  evalEnv = await createEval();
}, 60000);

async function createEval() {
  const { createEvalEnv } = await import("./helpers/eval-env");
  return createEvalEnv({ groqKey: env.GROQ_API_KEY });
}

function teeSearch(): ProductSearchResult[] {
  return [
    {
      productId: "TEE-BLACK-001",
      name: "Black Classic Tee",
      description: "Soft cotton black tee",
      price: 79900,
      category: "Tees",
      stock: 50,
      score: 0.9,
    },
  ];
}

function addPlan(): TurnPlan {
  return {
    reply: "internal note",
    actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 1 }],
    requestConfirm: false,
    requestCancel: false,
    reasoning: "test",
  };
}

const emptyState: AgentState = {
  cart: [],
  history: [],
  lastDiscussedProductId: null,
  pendingIntent: null,
  confirmArmed: false,
  sessionMeta: null,
};

describe("Claim-check integration (full turn)", () => {
  it("valid add → narrator reply passes claim-check", async () => {
    if (!evalEnv) { console.warn("Skipped: Groq/Ollama unavailable"); return; }
    const searchResults = teeSearch();

    // Real executor against D1
    const executorResult = await executeTurn({
      env,
      turnPlan: addPlan(),
      agentState: emptyState,
      searchResults,
      userMessage: "add the black tee",
    });
    expect(executorResult.actions[0].success).toBe(true);

    // Real Groq narrator
    const narratorReply = await callNarrator(evalEnv.chat, {
      userMessage: "add the black tee",
      executorResult,
      history: [],
      cart: executorResult.cart,
      cartTotal: executorResult.cartTotal,
      pendingIntent: null,
      searchResults,
    });

    const facts = buildFacts(executorResult, searchResults);
    const check = claimsConsistent(narratorReply, facts, {
      knownProductNames: ["Black Classic Tee"],
    });
    console.log("narrator:", narratorReply, "| violations:", check.violations);
    expect(check.consistent).toBe(true);

    const finalReply = neverSilentGuard(narratorReply);
    expect(finalReply.length).toBeGreaterThan(0);
  });

  it("deliberately wrong narrator (bad price) → claim-check discards → template fallback", async () => {
    // Real executor for real facts
    const executorResult: ExecutorResult = await executeTurn({
      env,
      turnPlan: addPlan(),
      agentState: emptyState,
      searchResults: teeSearch(),
      userMessage: "add the black tee",
    });

    // Narrator mock that lies about the price
    const lyingNarrator: AIProvider = {
      chat: async () =>
        "I've added the Black Classic Tee to your cart. Your total is ₹99. Anything else?",
      embed: async () => [],
    };
    const narratorReply = await callNarrator(lyingNarrator, {
      userMessage: "add the black tee",
      executorResult,
      history: [],
      cart: executorResult.cart,
      cartTotal: executorResult.cartTotal,
      pendingIntent: null,
      searchResults: teeSearch(),
    });

    const facts = buildFacts(executorResult, teeSearch());
    const check = claimsConsistent(narratorReply, facts, {
      knownProductNames: ["Black Classic Tee"],
    });
    expect(check.consistent).toBe(false);
    expect(check.violations.some((v) => v.includes("₹99"))).toBe(true);

    // Fallback template is factually correct
    let finalReply = renderFallback(facts);
    finalReply = neverSilentGuard(finalReply);
    expect(finalReply).toContain("Added Black Classic Tee");
    expect(finalReply).toContain("₹799");
    expect(finalReply).not.toContain("₹99");
  });
});
