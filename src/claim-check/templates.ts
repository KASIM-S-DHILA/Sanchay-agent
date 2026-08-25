import type { Fact } from "./facts";

/**
 * Deterministic, fact-only reply used when the narrator fails the claim-check.
 * Less conversational than the narrator but always truthful.
 */
export function renderFallback(facts: Fact[]): string {
  const parts: string[] = [];

  const adds = facts.filter((f) => f.type === "product_added");
  const removes = facts.filter((f) => f.type === "product_removed");
  const failures = facts.filter((f) => f.type === "product_failed");
  const total = facts.find((f) => f.type === "cart_total");
  const empty = facts.find((f) => f.type === "cart_empty");
  const confirmArmed = facts.find((f) => f.type === "confirm_armed");
  const confirmExecuted = facts.find((f) => f.type === "confirm_executed");
  const cancel = facts.find((f) => f.type === "cancel_confirmed");
  const cleared = facts.find((f) => f.type === "cart_cleared");
  const error = facts.find((f) => f.type === "error");

  if (adds.length > 0) {
    parts.push(`Added ${adds.map((f) => f.value).join(" and ")} to your cart.`);
  }
  if (removes.length > 0) {
    parts.push(`Removed ${removes.map((f) => f.value).join(" and ")} from your cart.`);
  }
  if (failures.length > 0) {
    parts.push(
      `Couldn't add ${failures.map((f) => f.value).join(", ")} — ${failures[0].error ?? failures[0].value}.`,
    );
  } else if (error) {
    parts.push(`${error.value}.`);
  }
  if (total) {
    parts.push(`Cart total: ${total.value}.`);
  }
  if (empty) {
    parts.push("Your cart is empty.");
  }
  if (confirmArmed) {
    parts.push("Ready to checkout? Say 'yes' to proceed.");
  }
  if (confirmExecuted) {
    parts.push("Checkout initiated! You'll receive a payment link shortly.");
  }
  if (cancel) {
    parts.push("Cancelled. Your cart is saved for later.");
  }
  if (cleared) {
    parts.push("Cart cleared.");
  }

  return parts.join(" ") || "Got it! What else can I help with?";
}
