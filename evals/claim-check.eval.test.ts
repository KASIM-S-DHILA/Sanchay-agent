import { describe, it, expect } from "vitest";
import { buildFacts, formatPrice, type Fact } from "../src/claim-check/facts";
import { claimsConsistent } from "../src/claim-check/index";
import { renderFallback } from "../src/claim-check/templates";
import { neverSilentGuard } from "../src/claim-check/never-silent";
import type { ExecutorResult, ExecutedAction } from "../src/types";

function mkExecutor(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
  return {
    actions: [],
    cart: [],
    cartTotal: 0,
    errors: [],
    stateChanges: {},
    ...overrides,
  };
}

function fact(overrides: Partial<Fact> & { type: Fact["type"] }): Fact {
  return { value: overrides.value ?? "x", ...overrides } as Fact;
}

describe("buildFacts", () => {
  it("successful add → product_added with correct name", () => {
    const facts = buildFacts(
      mkExecutor({
        actions: [
          { type: "add", productId: "TEE-BLACK-001", productName: "Black Classic Tee", quantity: 1, success: true, price: 79900 },
        ],
      }),
    );
    const f = facts.find((x) => x.type === "product_added");
    expect(f).toBeDefined();
    expect(f!.value).toBe("Black Classic Tee");
    expect(f!.productId).toBe("TEE-BLACK-001");
    expect(f!.amountPaise).toBe(79900);
  });

  it("failed action → product_failed with error", () => {
    const facts = buildFacts(
      mkExecutor({
        actions: [{ type: "add", productId: "JACKET-1", productName: "Puffer Jacket", quantity: 1, success: false, error: "Out of stock" }],
      }),
    );
    const f = facts.find((x) => x.type === "product_failed");
    expect(f).toBeDefined();
    expect(f!.value).toBe("Puffer Jacket");
    expect(f!.error).toBe("Out of stock");
  });

  it("non-empty cart → cart_total with correct price format", () => {
    const facts = buildFacts(mkExecutor({ cartTotal: 129900 }));
    const f = facts.find((x) => x.type === "cart_total");
    expect(f).toBeDefined();
    expect(f!.value).toBe("₹1,299");
    expect(f!.amountPaise).toBe(129900);
  });

  it("empty cart → cart_empty fact", () => {
    const facts = buildFacts(mkExecutor({ cart: [], cartTotal: 0 }));
    expect(facts.some((f) => f.type === "cart_empty")).toBe(true);
  });

  it("confirm_armed action → confirm_armed fact", () => {
    const acts: ExecutedAction[] = [{ type: "confirm_armed", success: true }];
    expect(buildFacts(mkExecutor({ actions: acts })).some((f) => f.type === "confirm_armed" && f.value === "armed")).toBe(true);
  });

  it("cancel_confirmed action → cancel_confirmed fact", () => {
    const acts: ExecutedAction[] = [{ type: "cancel_confirmed", success: true }];
    expect(buildFacts(mkExecutor({ actions: acts })).some((f) => f.type === "cancel_confirmed")).toBe(true);
  });

  it("formatPrice uses Indian grouping", () => {
    expect(formatPrice(129900)).toBe("₹1,299");
    expect(formatPrice(15000000)).toBe("₹1,50,000");
    expect(formatPrice(79900)).toBe("₹799");
  });
});

describe("claimsConsistent", () => {
  const addFacts: Fact[] = [
    fact({ type: "product_added", value: "black classic tee", productId: "TEE-BLACK-001", amountPaise: 79900 }),
    fact({ type: "cart_total", value: "₹799", amountPaise: 79900 }),
  ];

  it("matching reply + facts → consistent true", () => {
    const r = claimsConsistent(
      "Got it! I've added the Black Classic Tee to your cart. Your total is ₹799.",
      addFacts,
      { knownProductNames: ["Black Classic Tee"] },
    );
    // note: "got it" implies add — backed by product_added; price matches
    expect(r.consistent).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("wrong price (₹1,299 vs actual ₹1,598) → violation", () => {
    const facts: Fact[] = [
      fact({ type: "product_added", value: "black tee", amountPaise: 79900 }),
      fact({ type: "cart_total", value: "₹1,598", amountPaise: 159800 }),
    ];
    const r = claimsConsistent("Your total is ₹1,299.", facts);
    expect(r.consistent).toBe(false);
    expect(r.violations.some((v) => v.includes("₹1,299"))).toBe(true);
  });

  it("hallucinated product name → violation", () => {
    const r = claimsConsistent("I've added the Blue Hoodie to your cart!", addFacts, {
      knownProductNames: ["Blue Hoodie"],
    });
    expect(r.consistent).toBe(false);
    expect(r.violations.some((v) => v.includes("Blue Hoodie"))).toBe(true);
  });

  it("implied successful add when add failed → violation", () => {
    const facts: Fact[] = [
      fact({ type: "product_failed", value: "puffer jacket", error: "Out of stock" }),
      fact({ type: "cart_empty", value: "empty" }),
    ];
    const r = claimsConsistent("I've added the Puffer Jacket to your cart!", facts, {
      knownProductNames: ["Puffer Jacket"],
    });
    expect(r.consistent).toBe(false);
    expect(r.violations.some((v) => v.includes("added"))).toBe(true);
  });

  it("unjustified past-tense verb (refunded) → violation", () => {
    const r = claimsConsistent("You've been refunded ₹500.", []);
    expect(r.consistent).toBe(false);
    expect(r.violations.some((v) => v.includes("'refunded'"))).toBe(true);
  });

  it("future/gerund phrasing does not trigger verb check", () => {
    // "I'll process" and "Processing" must NOT match \bprocessed\b
    const r = claimsConsistent("I'll process your order shortly. Processing now…", []);
    // no past-tense verbs present → no verb violations
    expect(r.violations.filter((v) => v.startsWith("Claim '"))).toEqual([]);
  });

  it("search reply prices justified by displayed-product facts", () => {
    const facts: Fact[] = [
      fact({ type: "search_results", value: "displayed" }),
      fact({ type: "search_results", value: "gray pullover hoodie", productId: "HOODIE-GRAY-001", amountPaise: 199900 }),
    ];
    const r = claimsConsistent("We have a Gray Pullover Hoodie for ₹1,999.", facts, {
      knownProductNames: ["Gray Pullover Hoodie"],
    });
    expect(r.consistent).toBe(true);
  });

  it("checkout mention without confirm facts → violation", () => {
    const r = claimsConsistent("Your order is ready for checkout!", []);
    expect(r.consistent).toBe(false);
  });
});

describe("renderFallback", () => {
  it("add + total facts produce a reply mentioning both", () => {
    const out = renderFallback([
      fact({ type: "product_added", value: "Black Classic Tee" }),
      fact({ type: "cart_total", value: "₹1,299" }),
    ]);
    expect(out).toContain("Added Black Classic Tee");
    expect(out).toContain("Cart total: ₹1,299");
  });

  it("failure facts mention the failure reason", () => {
    const out = renderFallback([
      fact({ type: "product_failed", value: "Winter Warm Puffer Jacket", error: "Out of stock" }),
    ]);
    expect(out).toContain("Couldn't add Winter Warm Puffer Jacket — Out of stock.");
  });

  it("confirm_armed produces 'Ready to checkout?'", () => {
    const out = renderFallback([fact({ type: "confirm_armed", value: "armed" })]);
    expect(out).toContain("Ready to checkout? Say 'yes' to proceed.");
  });

  it("no facts at all still returns something", () => {
    expect(renderFallback([])).toBe("Got it! What else can I help with?");
  });
});

describe("neverSilentGuard", () => {
  it("valid reply returned unchanged", () => {
    expect(neverSilentGuard("Hello there!")).toBe("Hello there!");
  });

  it("null returns fallback", () => {
    expect(neverSilentGuard(null)).toBe("Got it! What else can I help with?");
  });

  it("whitespace-only returns fallback", () => {
    expect(neverSilentGuard("   ")).toBe("Got it! What else can I help with?");
  });
});
