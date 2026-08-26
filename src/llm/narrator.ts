import type { AIProvider } from "./provider";
import type { CartItem, ExecutorResult, PendingIntent, ProductSearchResult, TurnRecord, UserPreferences } from "../types";

export interface NarratorParams {
  userMessage: string;
  executorResult: ExecutorResult; // what actually happened
  history: TurnRecord[]; // last 8 turns
  cart: CartItem[]; // current cart after execution
  cartTotal: number; // paise
  pendingIntent: PendingIntent | null;
  // ponytail deviation: spec's example #3 shows search results in the prompt but
  // omits them from NarratorParams — without them rule 3 is unsatisfiable
  searchResults?: ProductSearchResult[];
  userPreferences?: UserPreferences | null;
}

const NARRATOR_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
export const NARRATOR_FALLBACK = "Got it! Your cart has been updated. What else can I help with?";

function formatActions(result: ExecutorResult): string {
  if (result.actions.length === 0) return "(no actions executed)";
  return result.actions
    .map((a) => {
      const status = a.success ? "SUCCESS" : `FAILED (${a.error ?? "unknown error"})`;
      const parts = [`- ${a.type}`];
      if (a.productName) parts.push(`"${a.productName}"`);
      if (a.quantity !== undefined) parts.push(`x${a.quantity}`);
      if (a.price !== undefined) parts.push(`price: ${a.price} paise (₹${(a.price / 100).toFixed(2)})`);
      parts.push(`→ ${status}`);
      return parts.join(" ");
    })
    .join("\n");
}

function formatCart(cart: CartItem[]): string {
  if (cart.length === 0) return "(empty)";
  const header = "| name | quantity | price (₹) |";
  const separator = "|---|---|---|";
  const rows = cart.map((c) => `| ${c.name} | ${c.quantity} | ${(c.price / 100).toFixed(2)} |`);
  return [header, separator, ...rows].join("\n");
}

function formatSearchResults(results?: ProductSearchResult[]): string {
  if (!results || results.length === 0) return "(none)";
  return results
    .map((r) => `- ${r.name} (${r.productId}) — ₹${(r.price / 100).toFixed(2)}, stock: ${r.stock}`)
    .join("\n");
}

function formatHistory(history: TurnRecord[]): string {
  const last4 = history.slice(-4);
  if (last4.length === 0) return "(no history)";
  return last4
    .map((t, i) => {
      const truncated = t.content.length > 200 ? t.content.slice(0, 200) + "..." : t.content;
      return `${i + 1}. ${t.role}: ${truncated}`;
    })
    .join("\n");
}

function formatPendingIntent(pending: PendingIntent | null): string {
  if (!pending) return "none";
  return JSON.stringify(pending);
}

export function buildNarratorPrompt(params: NarratorParams): string {
  const { executorResult, cart, cartTotal, history, pendingIntent, searchResults, userPreferences } = params;

  return `You are a warm, friendly shopping assistant. Your job is to tell the user what happened in a natural, conversational way.

You receive:
- The user's original message
- A list of actions that were executed (with results — success or failure)
- The current cart contents
- The conversation history
- Cross-session user context (if known)

Rules:
1. Only mention things that actually happened. The actions list tells you what succeeded and what failed.
2. If an action failed, explain why simply and offer a next step.
3. If the user asked to search, present the available products naturally.
4. If items were added to the cart, confirm what was added and mention the running total.
5. If items were removed, acknowledge the removal.
6. If the cart is empty, you can suggest popular items or ask what they're looking for.
7. Keep replies concise — 2-3 sentences max unless the user asks for details.
8. Use a warm, helpful tone. Vary your phrasing — don't repeat the same patterns.
9. Never mention prices in paise — convert to rupees (divide by 100).
10. If the user confirmed a checkout, acknowledge it warmly and explain the next step.
11. If the user cancelled, reassure them their cart is saved.
12. If the user is returning (session count > 1), you can be slightly more familiar — "Welcome back!" or reference their preferences naturally.
13. Don't be creepy — don't list their entire history. Use it subtly.

Examples:

Actions: [{type:"add", productName:"Black Classic Tee", quantity:1, success:true, price:129900}]
Cart: [{name:"Black Classic Tee", quantity:1}]
Cart total: 129900
→ "Got it! I've added the Black Classic Tee to your cart. Your total is ₹1,299. Anything else you'd like?"

Actions: [{type:"add", productName:"Winter Puffer Jacket", quantity:1, success:false, error:"Out of stock"}]
Cart: []
→ "Sorry, the Winter Puffer Jacket is currently out of stock. Would you like to see similar jackets we have available?"

Actions: [{type:"search"}]
Search results: [{name:"Black Classic Tee", price:129900}, {name:"White Essential Tee", price:99900}]
→ "Here's what I found — we have a Black Classic Tee at ₹1,299 and a White Essential Tee at ₹999. Which one catches your eye?"

Actions: [{type:"confirm_checkout", success:true}]
→ "Great, let's get you checked out! I'll prepare your order now. You'll see a payment link shortly."

Actions: [{type:"cancel_confirmed", success:true}]
→ "No problem at all! Your cart is saved whenever you're ready. Just let me know if you'd like to continue shopping."

---

User's message: "${params.userMessage}"

Actions executed:
${formatActions(executorResult)}

Search results (if the action was a search):
${formatSearchResults(searchResults)}

Current cart:
${formatCart(cart)}

Cart total: ${cartTotal} paise (₹${(cartTotal / 100).toFixed(2)})

Conversation history:
${formatHistory(history)}

Pending budget intent: ${formatPendingIntent(pendingIntent)}

User context:
${formatNarratorContext(userPreferences)}

Write your reply now. Plain conversational prose only — no JSON, no markdown, no lists.`;
}

function formatNarratorContext(prefs?: UserPreferences | null): string {
  if (!prefs) return "(no prior history)";
  const lines: string[] = [];
  lines.push(
    `- This is session #${prefs.sessionCount}${prefs.sessionCount > 1 ? " (returning user)" : ""}`,
  );
  if (prefs.preferredCategories.length > 0) {
    lines.push(`- They've previously shown interest in: ${prefs.preferredCategories.join(", ")}`);
  }
  if (prefs.budgetPreference != null) {
    lines.push(`- Their usual budget is around ₹${(prefs.budgetPreference / 100).toLocaleString("en-IN")}`);
  }
  return lines.join("\n");
}

export async function callNarrator(provider: AIProvider, params: NarratorParams): Promise<string> {
  try {
    const prompt = buildNarratorPrompt(params);
    const raw = await provider.chat(
      NARRATOR_MODEL,
      [
        { role: "system", content: prompt },
        { role: "user", content: params.userMessage },
      ],
      { temperature: 0.3, max_tokens: 256 }
    );
    // Defensive fence-strip — prose models occasionally wrap output anyway
    let reply = raw.trim();
    if (reply.startsWith("```")) {
      reply = reply.replace(/^```(?:[a-z]*)\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
    }
    // Strip surrounding quotes some models add
    if (reply.length >= 2 && reply.startsWith('"') && reply.endsWith('"')) {
      reply = reply.slice(1, -1).trim();
    }
    return reply || NARRATOR_FALLBACK;
  } catch {
    return NARRATOR_FALLBACK;
  }
}
