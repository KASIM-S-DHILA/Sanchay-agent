import type { Fact } from "./facts";

export interface ClaimCheckResult {
  consistent: boolean;
  violations: string[];
}

// Action verbs that imply the system completed an action.
// Each maps to the fact types that justify it; an empty array means the verb
// can never be justified yet (no such subsystem exists) — always a violation.
const ACTION_VERB_FACTS: Record<string, Fact["type"][]> = {
  added: ["product_added"],
  removed: ["product_removed", "cart_cleared"],
  applied: [], // no discount system yet
  processed: ["confirm_executed"],
  shipped: [], // no shipping system
  refunded: [], // no refund system
  discounted: [], // no discount system
  cancelled: ["cancel_confirmed"],
  confirmed: ["confirm_executed", "confirm_armed"],
  reserved: [], // no reservation system
  ordered: ["confirm_executed"],
  charged: ["confirm_executed"],
  paid: ["confirm_executed"],
  cleared: ["cart_cleared"],
  emptied: ["cart_cleared"],
};

export function claimsConsistent(
  narratorReply: string,
  facts: Fact[],
  opts?: { knownProductNames?: string[] }
): ClaimCheckResult {
  const violations: string[] = [];
  const reply = narratorReply ?? "";
  const lower = reply.toLowerCase();
  const has = (t: Fact["type"]) => facts.some((f) => f.type === t);

  // ---- Price check -------------------------------------------------------
  // Every ₹ amount must be backed by a fact carrying amountPaise
  // (cart_total, product_added unit price, or a displayed search result).
  // Tolerance: within ₹1 (100 paise) for rounding.
  const validAmounts = facts
    .map((f) => f.amountPaise)
    .filter((n): n is number => typeof n === "number");

  for (const match of reply.matchAll(/₹\s*([\d,]+(?:\.\d{1,2})?)/g)) {
    const paise = Math.round(parseFloat(match[1].replace(/,/g, "")) * 100);
    const ok = validAmounts.some((v) => Math.abs(v - paise) <= 100);
    if (!ok) {
      const total = facts.find((f) => f.type === "cart_total");
      violations.push(
        `Price ${match[0].trim()} not supported by executed actions${total ? ` (cart total is ${total.value})` : ""}`,
      );
    }
  }

  // ---- Product mention check ---------------------------------------------
  // Names backed by facts this turn (added/removed/failed/displayed).
  const factNames = new Set(
    facts
      .filter((f) => f.type === "search_results" || f.type.startsWith("product_"))
      .map((f) => f.value.toLowerCase())
  );
  // A search turn justifies naming anything that was displayed.
  const searchJustifies = has("search_results");

  for (const name of opts?.knownProductNames ?? []) {
    const n = name.toLowerCase();
    if (!n || !lower.includes(n)) continue;
    if (!factNames.has(n) && !searchJustifies) {
      violations.push(`Product "${name}" mentioned but not backed by any executed action`);
    }
  }

  // ---- Positive implication checks ----------------------------------------
  // Reply phrases imply outcomes that must exist in the facts.
  if (/\badded\b|got it/i.test(reply) && !has("product_added")) {
    violations.push("Reply implies items were added but no successful add was executed");
  }
  if (/\b(removed|took out|deleted)\b/i.test(reply) && !has("product_removed") && !has("cart_cleared")) {
    violations.push("Reply implies items were removed but no removal was executed");
  }
  if (/\b(sorry|out of stock|unavailable|couldn't|could not)\b/i.test(reply) && !has("product_failed")) {
    violations.push("Reply implies a failure but every executed action succeeded");
  }
  if (/\b(empty|nothing in|no items)\b/i.test(reply) && !has("cart_empty")) {
    violations.push("Reply claims the cart is empty but it is not");
  }
  if (/\b(checkout|order|payment)\b/i.test(reply) && !has("confirm_executed") && !has("confirm_armed")) {
    violations.push("Reply mentions checkout/payment but no confirm action was executed");
  }
  if (/\b(cancelled|canceled|no problem|saved)\b/i.test(reply) && !has("cancel_confirmed")) {
    violations.push("Reply implies cancellation was confirmed but none was executed");
  }

  // ---- Negative action-verb check -----------------------------------------
  // Past-tense completion verbs must be justified by a corresponding fact.
  for (const [verb, justifying] of Object.entries(ACTION_VERB_FACTS)) {
    const re = new RegExp(`\\b${verb}\\b`, "i");
    if (!re.test(reply)) continue;
    const justified = justifying.some((t) => has(t));
    if (justifying.length === 0 || !justified) {
      violations.push(`Claim '${verb}' not supported by any executed action`);
    }
  }

  return { consistent: violations.length === 0, violations };
}
