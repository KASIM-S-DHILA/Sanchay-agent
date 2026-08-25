import type { ExecutorResult, ProductSearchResult } from "../types";

export interface Fact {
  type:
    | "product_added"
    | "product_removed"
    | "product_failed"
    | "cart_total"
    | "cart_empty"
    | "search_results"
    | "confirm_armed"
    | "confirm_executed"
    | "cancel_confirmed"
    | "cart_cleared"
    | "error";
  value: string; // human-readable, e.g. "Black Classic Tee", "₹1,299", "out of stock"
  productId?: string;
  // ponytail additions (spec allows "separate field"): machine-readable extras so
  // claimsConsistent can compare numbers and templates can show failure reasons
  error?: string;
  amountPaise?: number;
}

// ponytail: hand-rolled Indian grouping — avoids Intl locale variance in workerd
export function formatPrice(paise: number): string {
  const rupees = Math.round(Math.abs(paise) / 100);
  const s = String(rupees);
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
  }
  return `${paise < 0 ? "-₹" : "₹"}${grouped}`;
}

export function buildFacts(
  executorResult: ExecutorResult,
  searchResults?: ProductSearchResult[]
): Fact[] {
  const facts: Fact[] = [];

  let sawSearch = false;
  let sawConfirmArmed = false;
  let sawConfirmExecuted = false;
  let sawCancelConfirmed = false;
  let sawCartCleared = false;

  for (const action of executorResult.actions) {
    if (action.success && action.type === "add") {
      facts.push({
        type: "product_added",
        value: action.productName ?? action.productId ?? "item",
        productId: action.productId,
        amountPaise: action.price,
      });
    } else if (action.success && action.type === "remove") {
      facts.push({
        type: "product_removed",
        value: action.productName ?? action.productId ?? "item",
        productId: action.productId,
      });
    } else if (!action.success && action.type !== "no_action") {
      facts.push({
        type: "product_failed",
        value: action.productName ?? action.productId ?? "item",
        productId: action.productId,
        error: action.error ?? "unavailable",
      });
    }

    if (action.type === "search" && !sawSearch) {
      sawSearch = true;
      facts.push({ type: "search_results", value: "displayed" });
      // Per-product display facts carry names + amounts so the claim-check
      // can verify prices/product mentions in search replies
      for (const r of searchResults ?? []) {
        facts.push({
          type: "search_results",
          value: r.name,
          productId: r.productId,
          amountPaise: r.price,
        });
      }
    }
    if (action.type === "confirm_armed" && !sawConfirmArmed) {
      sawConfirmArmed = true;
      facts.push({ type: "confirm_armed", value: "armed" });
    }
    if (action.type === "confirm_checkout" && !sawConfirmExecuted) {
      sawConfirmExecuted = true;
      facts.push({ type: "confirm_executed", value: "confirmed" });
    }
    if (action.type === "cancel_confirmed" && !sawCancelConfirmed) {
      sawCancelConfirmed = true;
      facts.push({ type: "cancel_confirmed", value: "cancelled" });
    }
    if (action.type === "cart_cleared" && !sawCartCleared) {
      sawCartCleared = true;
      facts.push({ type: "cart_cleared", value: "cleared" });
    }
  }

  if (executorResult.cartTotal > 0) {
    facts.push({
      type: "cart_total",
      value: formatPrice(executorResult.cartTotal),
      amountPaise: executorResult.cartTotal,
    });
  }

  if (executorResult.cart.length === 0) {
    facts.push({ type: "cart_empty", value: "empty" });
  }

  if (executorResult.errors.length > 0) {
    facts.push({ type: "error", value: executorResult.errors.join("; ") });
  }

  return facts;
}
