import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { decideTurn, isConfirmPhrase, isCancelPhrase } from "../src/executor/decide-turn";
import { executeTurn } from "../src/executor/index";
import { seedCatalog } from "../src/catalog/seed";
import { getProductStock, resetProductStock } from "./helpers/db";
import type { TurnPlan, AgentState, ProductSearchResult } from "../src/types";

let env: any;
let gatewayAvailable = true;

beforeAll(async () => {
  const mod: any = await import("cloudflare:test");
  env = mod.env;
  await seedCatalog(env);
  // Local D1 needs the orders table for checkout persistence
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT, razorpay_order_id TEXT, amount INTEGER, currency TEXT, status TEXT, items_json TEXT, created_at TEXT)",
  ).run();
  // Probe Razorpay gateway auth for checkout tests
  try {
    const { createOrder } = await import("../src/razorpay");
    await createOrder(env, 10000, `probe-${Date.now()}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
      gatewayAvailable = false;
      console.warn("Razorpay auth failed — checkout tests will skip:", msg.slice(0, 200));
    }
  }
}, 60000);

afterEach(async () => {
  // Restore stock for products that may have been set to 0
  const productsToReset = ["TEE-BLACK-001", "TEE-WHITE-002", "TEE-BLUE-003", "HOODIE-GRAY-001", "HOODIE-BLACK-002", "JACKET-WARM-001"];
  for (const id of productsToReset) {
    try {
      await resetProductStock(env, id, 50);
    } catch {}
  }
});

function makeProduct(overrides: Partial<ProductSearchResult> & { productId: string }): ProductSearchResult {
  return {
    productId: overrides.productId,
    name: overrides.name ?? "Test Product",
    description: overrides.description ?? "Test description",
    price: overrides.price ?? 100000,
    category: overrides.category ?? "Tees",
    stock: overrides.stock ?? 50,
    score: overrides.score ?? 0.9,
  };
}

function makeAgentState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    cart: [],
    history: [],
    lastDiscussedProductId: null,
    pendingIntent: null,
    confirmArmed: false,
    sessionMeta: null,
    ...overrides,
  };
}

function makeTurnPlan(overrides: Partial<TurnPlan> = {}): TurnPlan {
  return {
    actions: [{ type: "no_action" }],
    requestConfirm: false,
    requestCancel: false,
    reasoning: "test",
    reply: "test reply",
    ...overrides,
  };
}

// 1-7 decideTurn pure tests
describe("decideTurn", () => {
  it("requestConfirm true with confirmArmed false → confirm", () => {
    const plan = makeTurnPlan({ requestConfirm: true, actions: [{ type: "no_action" }] });
    const state = makeAgentState({ confirmArmed: false });
    expect(decideTurn(plan, state).mode).toBe("confirm");
  });

  it("confirmArmed true + confirm phrase → confirm", () => {
    const plan = makeTurnPlan({ requestConfirm: false, actions: [{ type: "no_action" }] });
    const state = makeAgentState({ confirmArmed: true });
    expect(decideTurn(plan, state, "yes go ahead").mode).toBe("confirm");
    expect(decideTurn(plan, state, "confirm please").mode).toBe("confirm");
    expect(decideTurn(plan, state, "do it").mode).toBe("confirm");
  });

  it("confirmArmed true + cancel phrase → cancel", () => {
    const plan = makeTurnPlan({ requestConfirm: false, actions: [{ type: "no_action" }] });
    const state = makeAgentState({ confirmArmed: true });
    expect(decideTurn(plan, state, "no cancel").mode).toBe("cancel");
    expect(decideTurn(plan, state, "never mind").mode).toBe("cancel");
    expect(decideTurn(plan, state, "forget it").mode).toBe("cancel");
  });

  it("requestCancel true → cancel", () => {
    const plan = makeTurnPlan({ requestCancel: true, actions: [{ type: "no_action" }] });
    const state = makeAgentState({ confirmArmed: false });
    expect(decideTurn(plan, state).mode).toBe("cancel");
  });

  it("actions with add/remove/search → actions", () => {
    const planAdd = makeTurnPlan({ actions: [{ type: "add", productId: "X", quantity: 1 }] });
    expect(decideTurn(planAdd, makeAgentState()).mode).toBe("actions");
    const planRemove = makeTurnPlan({ actions: [{ type: "remove", productId: "X" }] });
    expect(decideTurn(planRemove, makeAgentState()).mode).toBe("actions");
    const planSearch = makeTurnPlan({ actions: [{ type: "search", query: "hoodies" }] });
    expect(decideTurn(planSearch, makeAgentState()).mode).toBe("actions");
  });

  it("only no_action → idle", () => {
    const plan = makeTurnPlan({ actions: [{ type: "no_action" }], requestConfirm: false, requestCancel: false });
    expect(decideTurn(plan, makeAgentState()).mode).toBe("idle");
  });

  it("requestConfirm + requestCancel both true → confirm wins", () => {
    const plan = makeTurnPlan({ requestConfirm: true, requestCancel: true, actions: [{ type: "no_action" }] });
    expect(decideTurn(plan, makeAgentState()).mode).toBe("confirm");
    const armed = makeAgentState({ confirmArmed: true });
    expect(decideTurn(plan, armed, "yes").mode).toBe("confirm");
  });
});

describe("isConfirmPhrase / isCancelPhrase", () => {
  it("isConfirmPhrase matches confirm phrases", () => {
    const confirms = ["yes", "confirm", "go ahead", "do it", "proceed", "checkout", "buy", "Yes please", "CONFIRM", "Go Ahead"];
    for (const phrase of confirms) {
      expect(isConfirmPhrase(phrase)).toBe(true);
    }
  });

  it("isCancelPhrase matches cancel phrases", () => {
    const cancels = ["no", "cancel", "never mind", "forget it", "stop", "No thanks", "CANCEL"];
    for (const phrase of cancels) {
      expect(isCancelPhrase(phrase)).toBe(true);
    }
  });

  it("neither for normal query", () => {
    expect(isConfirmPhrase("show me hoodies")).toBe(false);
    expect(isCancelPhrase("show me hoodies")).toBe(false);
    expect(isConfirmPhrase("what is the price?")).toBe(false);
    expect(isCancelPhrase("what is the price?")).toBe(false);
  });
});

// 11-21 executeTurn tests
describe("executeTurn", () => {
  it("11. Add valid product (from search results) → cart updated, lastDiscussed set", async () => {
    const searchResults = [makeProduct({ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900 })];
    const plan = makeTurnPlan({ actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 1 }] });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: [] }),
      searchResults,
      userMessage: "add the black tee",
    });
    expect(result.actions[0].success).toBe(true);
    expect(result.cart.length).toBe(1);
    expect(result.cart[0].productId).toBe("TEE-BLACK-001");
    expect(result.cartTotal).toBe(79900);
    expect(result.stateChanges.cart).toBeDefined();
    expect(result.stateChanges.lastDiscussedProductId).toBe("TEE-BLACK-001");
  });

  it("12. Add invalid product (not in search results or cart) → success false, cart unchanged", async () => {
    const searchResults = [makeProduct({ productId: "TEE-BLACK-001" })];
    const plan = makeTurnPlan({ actions: [{ type: "add", productId: "INVALID-999", quantity: 1 }] });
    const initialCart = [{ productId: "TEE-WHITE-002", name: "White Tee", price: 89900, quantity: 1 }];
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart }),
      searchResults,
      userMessage: "add invalid",
    });
    expect(result.actions[0].success).toBe(false);
    expect(result.actions[0].error).toBe("Product not found in catalog");
    expect(result.cart).toEqual(initialCart);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("13. Add out-of-stock product → success false, error Out of stock", async () => {
    // Set stock to 0
    await env.DB.prepare("UPDATE products SET stock = 0 WHERE id = ?").bind("TEE-BLACK-001").run();
    const searchResults = [makeProduct({ productId: "TEE-BLACK-001" })];
    const plan = makeTurnPlan({ actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 1 }] });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: [] }),
      searchResults,
      userMessage: "add black tee",
    });
    expect(result.actions[0].success).toBe(false);
    expect(result.actions[0].error).toBe("Out of stock");
    expect(result.cart.length).toBe(0);
    // Cleanup done in afterEach
  });

  it("14. Add product that exceeds budget mandate → success false, error mentions budget", async () => {
    const searchResults = [makeProduct({ productId: "TEE-BLACK-001", price: 79900 })];
    const plan = makeTurnPlan({ actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 1 }] });
    const agentState = makeAgentState({
      cart: [],
      pendingIntent: { type: "confirm", budgetValue: 50000, span: "under 500" }, // ₹500 budget
    });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState,
      searchResults,
      userMessage: "add black tee",
    });
    expect(result.actions[0].success).toBe(false);
    expect(result.actions[0].error).toMatch(/Exceeds budget/);
    expect(result.cart.length).toBe(0);
  });

  it("15. Remove product in cart → cart updated, lastDiscussed NOT changed", async () => {
    const initialCart = [{ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900, quantity: 2 }];
    const plan = makeTurnPlan({ actions: [{ type: "remove", productId: "TEE-BLACK-001" }] });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart, lastDiscussedProductId: "TEE-BLACK-001" }),
      searchResults: [],
      userMessage: "remove it",
    });
    expect(result.actions[0].success).toBe(true);
    expect(result.cart.length).toBe(0);
    expect(result.stateChanges.lastDiscussedProductId).toBeUndefined();
    // lastDiscussed should not be in stateChanges
    expect(result.stateChanges.cart).toBeDefined();
  });

  it("16. Remove product not in cart → success false", async () => {
    const plan = makeTurnPlan({ actions: [{ type: "remove", productId: "TEE-BLACK-001" }] });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: [] }),
      searchResults: [],
      userMessage: "remove black tee",
    });
    expect(result.actions[0].success).toBe(false);
    expect(result.actions[0].error).toBe("Item not in cart");
  });

  it("17. replace:true add → old items removed, new item added", async () => {
    const initialCart = [
      { productId: "TEE-WHITE-002", name: "White Tee", price: 89900, quantity: 1 },
      { productId: "HOODIE-GRAY-001", name: "Gray Hoodie", price: 199900, quantity: 1 },
    ];
    const searchResults = [makeProduct({ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900 })];
    const plan = makeTurnPlan({ actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 1, replace: true }] });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart }),
      searchResults,
      userMessage: "replace with black tee",
    });
    expect(result.actions[0].success).toBe(true);
    expect(result.cart.length).toBe(1);
    expect(result.cart[0].productId).toBe("TEE-BLACK-001");
  });

  it("18. Add same product twice → quantity increments (not duplicated)", async () => {
    const searchResults = [makeProduct({ productId: "TEE-BLACK-001", price: 79900 })];
    const plan1 = makeTurnPlan({ actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 1 }] });
    const state1 = makeAgentState({ cart: [] });
    const result1 = await executeTurn({ env, turnPlan: plan1, agentState: state1, searchResults, userMessage: "add black tee" });
    expect(result1.cart[0].quantity).toBe(1);

    const plan2 = makeTurnPlan({ actions: [{ type: "add", productId: "TEE-BLACK-001", quantity: 2 }] });
    const state2 = makeAgentState({ cart: result1.cart, lastDiscussedProductId: "TEE-BLACK-001" });
    const result2 = await executeTurn({ env, turnPlan: plan2, agentState: state2, searchResults, userMessage: "add 2 more" });
    expect(result2.cart.length).toBe(1);
    expect(result2.cart[0].quantity).toBe(3);
  });

  it("19. Confirm arm → confirmArmed true in stateChanges, no cart mutation", async () => {
    const plan = makeTurnPlan({ actions: [{ type: "no_action" }], requestConfirm: true });
    const initialCart = [{ productId: "TEE-BLACK-001", name: "Black Tee", price: 79900, quantity: 1 }];
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart, confirmArmed: false }),
      searchResults: [],
      userMessage: "checkout",
    });
    expect(result.actions[0].type).toBe("confirm_armed");
    expect(result.actions[0].success).toBe(true);
    expect(result.stateChanges.confirmArmed).toBe(true);
    expect(result.cart).toEqual(initialCart);
  });

  it("20. Cancel when armed → confirmArmed false, cart preserved", async () => {
    const initialCart = [{ productId: "TEE-BLACK-001", name: "Black Tee", price: 79900, quantity: 1 }];
    const plan = makeTurnPlan({ actions: [{ type: "no_action" }], requestCancel: true });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart, confirmArmed: true }),
      searchResults: [],
      userMessage: "cancel",
    });
    expect(result.actions[0].type).toBe("cancel_confirmed");
    expect(result.stateChanges.confirmArmed).toBe(false);
    expect(result.cart).toEqual(initialCart);
  });

  it("21. Idle (no_action only) → empty result, no state changes", async () => {
    const plan = makeTurnPlan({ actions: [{ type: "no_action" }], requestConfirm: false, requestCancel: false });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: [] }),
      searchResults: [],
      userMessage: "hello",
    });
    expect(result.actions[0].type).toBe("no_action");
    expect(result.actions[0].success).toBe(true);
    expect(result.errors.length).toBe(0);
    expect(Object.keys(result.stateChanges).length).toBe(0);
  });

  it("cancel with clear cart phrase → cart cleared", async () => {
    const initialCart = [
      { productId: "TEE-BLACK-001", name: "Black Tee", price: 79900, quantity: 1 },
      { productId: "HOODIE-GRAY-001", name: "Hoodie", price: 199900, quantity: 1 },
    ];
    const plan = makeTurnPlan({ actions: [{ type: "no_action" }], requestCancel: true });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart, confirmArmed: false }),
      searchResults: [],
      userMessage: "clear my cart",
    });
    expect(result.actions[0].type).toBe("cart_cleared");
    expect(result.cart.length).toBe(0);
    expect(result.cartTotal).toBe(0);
  });

  it("remove with quantity → partial removal", async () => {
    const initialCart = [{ productId: "TEE-BLACK-001", name: "Black Tee", price: 79900, quantity: 3 }];
    const plan = makeTurnPlan({ actions: [{ type: "remove", productId: "TEE-BLACK-001", quantity: 1 }] });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart: initialCart }),
      searchResults: [],
      userMessage: "remove one",
    });
    expect(result.actions[0].success).toBe(true);
    expect(result.cart[0].quantity).toBe(2);
  });

  it("confirm mode with confirmArmed + non-empty cart → checkout_initiated", async () => {
    if (!gatewayAvailable) { console.warn("Skipped: Razorpay gateway unavailable"); return; }
    const cart = [{ productId: "TEE-BLACK-001", name: "Black Classic Tee", price: 79900, quantity: 2 }];
    const plan = makeTurnPlan({ actions: [], requestConfirm: true, requestCancel: false });
    const result = await executeTurn({
      env,
      turnPlan: plan,
      agentState: makeAgentState({ cart, confirmArmed: true }),
      searchResults: [],
      userMessage: "yes",
      sessionId: "rzp-test-session",
    });

    const action = result.actions[0];
    expect(action.type).toBe("checkout_initiated");
    expect(action.success).toBe(true);
    expect(action.orderId).toMatch(/^order_/);
    expect(action.paymentUrl).toBeTruthy();
    expect(result.stateChanges.confirmArmed).toBe(false);
    // Order persisted in D1
    const row: any = await env.DB.prepare("SELECT status, amount FROM orders WHERE razorpay_order_id = ?")
      .bind(action.orderId)
      .first();
    expect(row?.status).toBe("created");
    expect(row?.amount).toBe(159800);
  });
});
