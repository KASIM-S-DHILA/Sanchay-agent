import type {
  Env,
  TurnPlan,
  TurnAction,
  ProductSearchResult,
  CartItem,
  TurnRecord,
  PendingIntent,
} from "../types";
import type { AIProvider } from "./provider";
import { WorkersAIProvider } from "./workers-ai-provider";

export interface PlannerParams {
  userMessage: string;
  searchResults: ProductSearchResult[];
  cart: CartItem[];
  history: TurnRecord[];
  lastDiscussedProductId: string | null;
  pendingIntent: PendingIntent | null;
}

// Safe defaults
function safeDefault(reasoning: string): TurnPlan {
  return {
    actions: [{ type: "no_action" }],
    requestConfirm: false,
    requestCancel: false,
    reasoning,
    reply: "I didn't understand that. Could you rephrase?",
  };
}

function formatSearchResults(results: ProductSearchResult[]): string {
  if (results.length === 0) return "(no products found)";
  const header = "| productId | name | price (₹) | stock |";
  const separator = "|---|---|---|---|";
  const rows = results.map((p) => {
    const priceRupees = (p.price / 100).toFixed(2);
    return `| ${p.productId} | ${p.name} | ${priceRupees} | ${p.stock} |`;
  });
  return [header, separator, ...rows].join("\n");
}

function formatCart(cart: CartItem[]): string {
  if (cart.length === 0) return "(empty)";
  const header = "| productId | name | price (₹) | quantity |";
  const separator = "|---|---|---|---|";
  const rows = cart.map((c) => {
    const priceRupees = (c.price / 100).toFixed(2);
    return `| ${c.productId} | ${c.name} | ${priceRupees} | ${c.quantity} |`;
  });
  return [header, separator, ...rows].join("\n");
}

function formatHistory(history: TurnRecord[]): string {
  if (history.length === 0) return "(no history)";
  const last8 = history.slice(-8);
  return last8
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

function buildPrompt(params: PlannerParams): string {
  const { userMessage, searchResults, cart, history, lastDiscussedProductId, pendingIntent } = params;

  return `You are a shopping assistant planner. Your job is to understand what the user wants and produce a structured plan.

You receive:
- User message
- Relevant products from the catalog (search results)
- Current cart contents
- Conversation history (last 8 turns)
- The last product discussed (for resolving "it", "that", "one more")
- A pending budget intent (if the user specified a budget)

Rules:
1. Only use product IDs from the search results or cart. Never invent products.
2. "it", "that", "one more", "this one" refer to the lastDiscussedProductId. If null, ask for clarification.
3. "remove it", "take it out", "delete" → remove action for the lastDiscussedProductId or the only item in cart.
4. "checkout", "buy", "purchase", "pay" → set requestConfirm: true.
5. "cancel", "forget it", "never mind" → set requestCancel: true.
6. If the user specifies a quantity, use it. Default to 1 for add actions.
7. If the user says "replace" or "instead", set replace: true on the add action.
8. If the user asks to see/search/browse, output a search action with their query.
9. If the user's message is unclear, output no_action and a clarifying reply.

Output ONLY valid JSON. No markdown, no code fences, no explanation.

Examples:

User: "add the black tee"
Search results: [{productId:"TEE-BLK-M", name:"Black Classic Tee", price:129900}, ...]
Cart: []
Last discussed: null
→ {"actions":[{"type":"add","productId":"TEE-BLK-M","quantity":1}],"requestConfirm":false,"requestCancel":false,"reasoning":"User wants the black tee","reply":"Adding Black Classic Tee"}

User: "show me hoodies"
Search results: [{productId:"HOOD-GRY", name:"Gray Pullover Hoodie", ...}, {productId:"HOOD-BLK", name:"Black Zip Hoodie", ...}]
Cart: []
→ {"actions":[{"type":"search","query":"hoodies"}],"requestConfirm":false,"requestCancel":false,"reasoning":"User wants to browse hoodies","reply":"Here are the hoodies"}

User: "add one more"
Cart: [{productId:"TEE-BLK-M", name:"Black Classic Tee", quantity:1}]
Last discussed: "TEE-BLK-M"
→ {"actions":[{"type":"add","productId":"TEE-BLK-M","quantity":1}],"requestConfirm":false,"requestCancel":false,"reasoning":"One more of the last discussed product","reply":"Adding another Black Classic Tee"}

User: "checkout"
Cart: [{productId:"TEE-BLK-M", name:"Black Classic Tee", price:129900, quantity:2}]
→ {"actions":[{"type":"no_action"}],"requestConfirm":true,"requestCancel":false,"reasoning":"User wants to checkout","reply":"Ready to checkout?"}

---

Search results:
${formatSearchResults(searchResults)}

Cart:
${formatCart(cart)}

History:
${formatHistory(history)}

Last discussed productId: ${lastDiscussedProductId ?? "null"}

Pending budget intent: ${formatPendingIntent(pendingIntent)}

User message: "${userMessage}"
`;
}

export function parsePlan(raw: string): TurnPlan {
  let cleaned = raw.trim();

  // Strip markdown code fences if present
  // Handles ```json ... ``` , ``` ... ``` , and surrounding fences
  if (cleaned.startsWith("```")) {
    // Remove opening fence line and closing fence
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }
  // Also handle case where fences are on same line or extra text
  // Extract JSON object between first { and last }
  // If cleaned still not valid JSON, try to extract
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to extract JSON object substring
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
      try {
        parsed = JSON.parse(jsonSlice);
      } catch {
        return safeDefault("Failed to parse planner output");
      }
    } else {
      return safeDefault("Failed to parse planner output");
    }
  }

  // Validate structure
  if (!parsed || typeof parsed !== "object") {
    return safeDefault("Invalid plan structure");
  }

  const { actions, requestConfirm, requestCancel, reasoning, reply } = parsed;

  // actions must be array
  if (!Array.isArray(actions)) {
    return safeDefault("Invalid plan structure");
  }

  const validTypes = new Set(["search", "add", "remove", "no_action"]);
  for (const action of actions) {
    if (!action || typeof action !== "object" || typeof action.type !== "string" || !validTypes.has(action.type)) {
      return safeDefault("Invalid plan structure");
    }
    if (action.type === "add") {
      if (typeof action.productId !== "string" || action.productId.trim() === "") {
        return safeDefault("Invalid plan structure");
      }
      if (typeof action.quantity !== "number" || !Number.isInteger(action.quantity) || action.quantity <= 0) {
        return safeDefault("Invalid plan structure");
      }
      // replace is optional boolean, no validation needed
    } else if (action.type === "remove") {
      if (typeof action.productId !== "string" || action.productId.trim() === "") {
        return safeDefault("Invalid plan structure");
      }
      if (action.quantity !== undefined) {
        if (typeof action.quantity !== "number" || !Number.isInteger(action.quantity) || action.quantity <= 0) {
          return safeDefault("Invalid plan structure");
        }
      }
    } else if (action.type === "search") {
      if (typeof action.query !== "string" || action.query.trim() === "") {
        return safeDefault("Invalid plan structure");
      }
    } else if (action.type === "no_action") {
      // No extra fields required
    }
  }

  // Validate booleans and strings, fallback to defaults if missing
  const safeActions: TurnAction[] = actions;
  const safeRequestConfirm = typeof requestConfirm === "boolean" ? requestConfirm : false;
  const safeRequestCancel = typeof requestCancel === "boolean" ? requestCancel : false;
  const safeReasoning = typeof reasoning === "string" ? reasoning : "No reasoning provided";
  const safeReply = typeof reply === "string" && reply.trim() !== "" ? reply : "I didn't understand that. Could you rephrase?";

  return {
    actions: safeActions,
    requestConfirm: safeRequestConfirm,
    requestCancel: safeRequestCancel,
    reasoning: safeReasoning,
    reply: safeReply,
  };
}

// Primary new signature: provider + params, plus backward compat for Env
export async function callPlanner(provider: AIProvider, params: PlannerParams): Promise<TurnPlan>;
export async function callPlanner(env: Env, params: PlannerParams): Promise<TurnPlan>;
export async function callPlanner(params: PlannerParams & { env: Env }): Promise<TurnPlan>;
export async function callPlanner(
  envOrProviderOrParams: Env | AIProvider | (PlannerParams & { env?: Env }),
  maybeParams?: PlannerParams
): Promise<TurnPlan> {
  let provider: AIProvider;
  let params: PlannerParams;

  if (maybeParams) {
    // Two-arg form: first is Env or AIProvider
    const first: any = envOrProviderOrParams as any;
    if (first && typeof first.chat === "function" && typeof first.embed === "function") {
      provider = first as AIProvider;
    } else if (first && first.AI) {
      provider = new WorkersAIProvider(first.AI);
    } else {
      throw new Error("Invalid callPlanner first argument");
    }
    params = maybeParams;
  } else {
    const candidate: any = envOrProviderOrParams as any;
    if (candidate && typeof candidate.chat === "function" && typeof candidate.embed === "function") {
      throw new Error("callPlanner requires PlannerParams as second argument");
    }
    if (candidate && candidate.AI && candidate.DB) {
      throw new Error("callPlanner requires PlannerParams as second argument");
    }
    if (candidate && candidate.env && candidate.env.AI) {
      provider = new WorkersAIProvider(candidate.env.AI);
      const { env: _, ...rest } = candidate;
      params = rest as PlannerParams;
    } else if (candidate && candidate.userMessage !== undefined) {
      // No provider/env — try cloudflare:test fallback for backward compat
      try {
        const mod: any = await import("cloudflare:test");
        if (mod.env && mod.env.AI) {
          provider = new WorkersAIProvider(mod.env.AI);
          params = candidate as PlannerParams;
        } else {
          throw new Error("callPlanner requires Env or AIProvider");
        }
      } catch {
        throw new Error("callPlanner requires Env or AIProvider as first argument");
      }
    } else {
      throw new Error("Invalid callPlanner arguments");
    }
  }

  const prompt = buildPrompt(params);

  const raw = await provider.chat(
    "@cf/meta/llama-3.1-8b-instruct-fast",
    [
      { role: "system", content: prompt },
      { role: "user", content: params.userMessage },
    ],
    { temperature: 0, max_tokens: 512 }
  );

  return parsePlan(raw);
}
