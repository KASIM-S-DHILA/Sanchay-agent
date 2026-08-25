import type { Env, TurnPlan, AgentState, ProductSearchResult, ExecutorResult, ExecutedAction, CartItem } from "../types";
import { decideTurn } from "./decide-turn";
import { createOrder, createPaymentLink } from "../razorpay";

export interface ExecutorParams {
  env: Env;
  turnPlan: TurnPlan;
  agentState: AgentState;
  searchResults: ProductSearchResult[];
  userMessage: string;
  sessionId?: string;
}

function calculateCartTotal(cart: CartItem[]): number {
  return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

function cloneCart(cart: CartItem[]): CartItem[] {
  return cart.map((c) => ({ ...c }));
}

function isClearCartPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("clear my cart") ||
    lower.includes("clear cart") ||
    lower.includes("empty cart") ||
    lower.includes("remove everything") ||
    lower.includes("clear everything")
  );
}

export async function executeTurn(params: ExecutorParams): Promise<ExecutorResult> {
  const { env, turnPlan, agentState, searchResults, userMessage, sessionId } = params;
  const mode = decideTurn(turnPlan, agentState, userMessage).mode;

  // Prepare initial state copies
  let newCart = cloneCart(agentState.cart);
  let newLastDiscussed = agentState.lastDiscussedProductId;
  let newConfirmArmed = agentState.confirmArmed;
  const executed: ExecutedAction[] = [];
  const errors: string[] = [];

  // Create lookup for search results
  const searchMap = new Map<string, ProductSearchResult>();
  for (const r of searchResults) {
    searchMap.set(r.productId, r);
  }
  const cartMap = new Map<string, CartItem>();
  for (const c of agentState.cart) {
    cartMap.set(c.productId, c);
  }

  if (mode === "actions") {
    for (const action of turnPlan.actions) {
      if (action.type === "search") {
        executed.push({ type: "search", success: true });
        continue;
      }

      if (action.type === "add") {
        const productId = action.productId;
        const quantity = action.quantity;
        const replace = action.replace === true;

        // Validate productId exists in searchResults OR cart
        if (!searchMap.has(productId) && !cartMap.has(productId)) {
          executed.push({ type: "add", productId, quantity, success: false, error: "Product not found in catalog" });
          errors.push(`Product not found in catalog: ${productId}`);
          continue;
        }

        // Fetch from D1
        const row = await env.DB.prepare(`SELECT name, price, stock FROM products WHERE id = ?`)
          .bind(productId)
          .first<{ name: string; price: number; stock: number }>();

        if (!row) {
          executed.push({ type: "add", productId, quantity, success: false, error: "Product not found in catalog" });
          errors.push(`Product not found in catalog: ${productId}`);
          continue;
        }

        if (row.stock === 0) {
          executed.push({ type: "add", productId, productName: row.name, quantity, success: false, error: "Out of stock" });
          errors.push(`Out of stock: ${productId}`);
          continue;
        }

        // Handle replace: remove all items NOT same productId
        if (replace) {
          newCart = newCart.filter((c) => c.productId === productId);
        }

        // Budget check
        if (agentState.pendingIntent?.budgetValue !== undefined && agentState.pendingIntent.budgetValue !== null) {
          const budget = agentState.pendingIntent.budgetValue;
          // Compute new total after add
          const existing = newCart.find((c) => c.productId === productId);
          const currentQty = existing ? existing.quantity : 0;
          const newQty = existing ? currentQty + quantity : quantity;
          // Calculate total with newCart after replace already applied, plus new item
          let tempCart = cloneCart(newCart);
          const idx = tempCart.findIndex((c) => c.productId === productId);
          if (idx >= 0) {
            tempCart[idx] = { ...tempCart[idx], quantity: newQty };
          } else {
            tempCart.push({ productId, name: row.name, price: row.price, quantity });
          }
          const newTotal = calculateCartTotal(tempCart);
          if (newTotal > budget) {
            executed.push({
              type: "add",
              productId,
              productName: row.name,
              quantity,
              success: false,
              error: `Exceeds budget of ₹${(budget / 100).toFixed(2)}`,
            });
            errors.push(`Exceeds budget of ₹${(budget / 100).toFixed(2)}`);
            continue;
          }
        }

        // All checks pass — add to cart
        const existingIdx = newCart.findIndex((c) => c.productId === productId);
        if (existingIdx >= 0) {
          newCart[existingIdx] = {
            ...newCart[existingIdx],
            quantity: newCart[existingIdx].quantity + quantity,
          };
        } else {
          newCart.push({ productId, name: row.name, price: row.price, quantity });
        }
        // Update cartMap for subsequent actions in same turn
        cartMap.set(productId, newCart.find((c) => c.productId === productId)!);
        newLastDiscussed = productId;

        executed.push({
          type: "add",
          productId,
          productName: row.name,
          quantity,
          success: true,
          price: row.price,
        });
        continue;
      }

      if (action.type === "remove") {
        const productId = action.productId;
        const existingIdx = newCart.findIndex((c) => c.productId === productId);
        if (existingIdx === -1) {
          executed.push({ type: "remove", productId, success: false, error: "Item not in cart" });
          errors.push(`Item not in cart: ${productId}`);
          continue;
        }
        const existing = newCart[existingIdx];
        const productName = existing.name;
        if (action.quantity !== undefined) {
          const qtyToRemove = Math.max(1, action.quantity);
          if (qtyToRemove >= existing.quantity) {
            // Remove entirely
            newCart.splice(existingIdx, 1);
            cartMap.delete(productId);
          } else {
            newCart[existingIdx] = { ...existing, quantity: existing.quantity - qtyToRemove };
            cartMap.set(productId, newCart[existingIdx]);
          }
        } else {
          // Remove entirely
          newCart.splice(existingIdx, 1);
          cartMap.delete(productId);
        }
        // Do NOT update lastDiscussedProductId on removals
        executed.push({ type: "remove", productId, productName, quantity: action.quantity, success: true });
        continue;
      }

      if (action.type === "no_action") {
        executed.push({ type: "no_action", success: true });
        continue;
      }

      // Unknown type — treat as error
      executed.push({ type: (action as any).type ?? "unknown", success: false, error: "Unknown action type" });
      errors.push(`Unknown action type: ${(action as any).type}`);
    }

    const cartTotal = calculateCartTotal(newCart);
    const stateChanges: ExecutorResult["stateChanges"] = {};
    // Only include cart if changed
    if (JSON.stringify(newCart) !== JSON.stringify(agentState.cart)) {
      stateChanges.cart = newCart;
    }
    if (newLastDiscussed !== agentState.lastDiscussedProductId) {
      stateChanges.lastDiscussedProductId = newLastDiscussed;
    }
    // confirmArmed unchanged in actions mode

    return {
      actions: executed,
      cart: newCart,
      cartTotal,
      errors,
      stateChanges,
    };
  }

  if (mode === "confirm") {
    if (agentState.confirmArmed) {
      // User confirmed checkout — create Razorpay order + payment link
      const cartTotal = agentState.cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
      try {
        const order = await createOrder(env, cartTotal, `${sessionId ?? "session"}-${Date.now()}`);

        await env.DB.prepare(
          "INSERT INTO orders (id, session_id, razorpay_order_id, amount, currency, status, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(
            crypto.randomUUID(),
            sessionId ?? "unknown",
            order.id,
            cartTotal,
            "INR",
            "created",
            JSON.stringify(agentState.cart),
            new Date().toISOString(),
          )
          .run();

        // Email: captured at init handshake when present
        const customerEmail = agentState.sessionMeta?.userId || "guest@example.com";
        const paymentUrl = await createPaymentLink(env, order.id, customerEmail);

        return {
          actions: [{ type: "checkout_initiated", success: true, orderId: order.id, paymentUrl }],
          cart: agentState.cart,
          cartTotal,
          errors: [],
          stateChanges: { confirmArmed: false },
        };
      } catch (e) {
        console.error("Checkout failed:", e);
        return {
          actions: [{ type: "checkout_initiated", success: false, error: "Payment gateway error" }],
          cart: agentState.cart,
          cartTotal,
          errors: ["Failed to create order"],
          stateChanges: { confirmArmed: true }, // keep armed so the user can retry
        };
      }
    } else {
      // Arm confirm state
      newConfirmArmed = true;
      return {
        actions: [{ type: "confirm_armed", success: true }],
        cart: newCart,
        cartTotal: calculateCartTotal(newCart),
        errors: [],
        stateChanges: { confirmArmed: true },
      };
    }
  }

  if (mode === "cancel") {
    if (agentState.confirmArmed) {
      // Disarm, cart preserved
      return {
        actions: [{ type: "cancel_confirmed", success: true }],
        cart: newCart,
        cartTotal: calculateCartTotal(newCart),
        errors: [],
        stateChanges: { confirmArmed: false },
      };
    } else {
      // Not armed — check for specific cancel intents
      // If planner issued remove actions alongside cancel, process them
      const hasRemove = turnPlan.actions.some((a) => a.type === "remove");
      if (hasRemove) {
        // Process remove actions as in actions mode
        for (const action of turnPlan.actions) {
          if (action.type !== "remove") continue;
          const productId = (action as any).productId;
          const existingIdx = newCart.findIndex((c) => c.productId === productId);
          if (existingIdx === -1) {
            executed.push({ type: "remove", productId, success: false, error: "Item not in cart" });
            errors.push(`Item not in cart: ${productId}`);
            continue;
          }
          const existing = newCart[existingIdx];
          newCart.splice(existingIdx, 1);
          executed.push({ type: "remove", productId, productName: existing.name, success: true });
        }
        const cartTotal = calculateCartTotal(newCart);
        const stateChanges: ExecutorResult["stateChanges"] = {};
        if (JSON.stringify(newCart) !== JSON.stringify(agentState.cart)) {
          stateChanges.cart = newCart;
        }
        return {
          actions: executed.length > 0 ? executed : [{ type: "no_action", success: true }],
          cart: newCart,
          cartTotal,
          errors,
          stateChanges,
        };
      }

      if (isClearCartPhrase(userMessage)) {
        newCart = [];
        return {
          actions: [{ type: "cart_cleared", success: true }],
          cart: [],
          cartTotal: 0,
          errors: [],
          stateChanges: { cart: [] },
        };
      }

      return {
        actions: [{ type: "no_action", success: true }],
        cart: newCart,
        cartTotal: calculateCartTotal(newCart),
        errors: [],
        stateChanges: {},
      };
    }
  }

  // idle
  return {
    actions: [{ type: "no_action", success: true }],
    cart: newCart,
    cartTotal: calculateCartTotal(newCart),
    errors: [],
    stateChanges: {},
  };
}

