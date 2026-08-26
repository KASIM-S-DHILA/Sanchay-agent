import { VOICE_TOOLS } from "./tools";

/**
 * Machine-readable tool schema for AI buyers/agents — describes the same
 * six operations `executeToolCall` (tools.ts) actually implements, in a
 * shape compatible with common LLM tool-calling formats (OpenAI/Anthropic-
 * style JSON Schema function parameters).
 *
 * `VOICE_TOOLS` in tools.ts is the source of truth for which tools exist
 * and which params they take; this file adds human/LLM-facing descriptions
 * on top of that list. TOOL_DETAILS is validated against VOICE_TOOLS at
 * module load (see the check below) so this document cannot silently drift
 * out of sync if a tool is added to tools.ts and forgotten here — the
 * Worker fails to start instead of shipping a stale schema.
 */

interface ToolParamDetail {
  type: "string" | "number" | "integer";
  description: string;
}

interface ToolDetail {
  description: string;
  /** The equivalent plain HTTP endpoint — useful for an agent that talks
   *  REST directly rather than through the voice bridge's tool-call path. */
  httpEquivalent: string;
  params: Record<string, ToolParamDetail>;
}

const TOOL_DETAILS: Record<(typeof VOICE_TOOLS)[number]["name"], ToolDetail> = {
  search_catalog: {
    description:
      "Search the product catalog by free text (semantic search over name/description/category, falling back to keyword matching). Returns products with price_display pre-formatted for speech (e.g. \"₹1,999\"), plus paise amounts for exact math.",
    httpEquivalent: "GET /api/catalog?q={query}",
    params: {
      query: { type: "string", description: "Free-text search, e.g. \"gray hoodie\" or \"warm jacket for winter\"." },
    },
  },
  add_to_cart: {
    description:
      "Add a product to the shopper's cart. Stock and any session budget are enforced atomically against live state, so this can fail with a business error (not an exception) if the item is out of stock or would exceed the budget — always check the `success` field of the result, not just whether the call completed. On success the result also includes youMightAlsoLike (up to 3 in-stock cross-sell suggestions from the same category) — a good moment to offer one, not a hard sell.",
    httpEquivalent: "POST /api/cart/add",
    params: {
      product_id: { type: "string", description: "Catalog product id, e.g. \"HOODIE-GRAY-001\"." },
      quantity: { type: "integer", description: "1-99. Defaults to 1 if omitted. Values outside 1-99 or non-integers are rejected with an error, not silently clamped." },
      idempotency_key: { type: "string", description: "Optional. Pass the same value on a retry of an add that may have already succeeded (e.g. after a timeout) to avoid adding the item twice — the original result is replayed instead." },
    },
  },
  remove_from_cart: {
    description:
      "Remove a product from the cart, in whole or in part. Omitting quantity removes the entire line item. Removing a product that isn't in the cart is a normal outcome (returns success: false with an explanatory error), not an exception.",
    httpEquivalent: "POST /api/cart/remove",
    params: {
      product_id: { type: "string", description: "Catalog product id to remove." },
      quantity: { type: "integer", description: "1-99. Omit to remove the whole line item regardless of its current quantity." },
    },
  },
  get_cart: {
    description:
      "Get the current cart: line items, total, remaining budget (null if the session has no budget set), and youMightAlsoLike (up to 3 in-stock cross-sell suggestions). Use this to confirm what's in the cart before checkout or when the shopper asks what's in their bag.",
    httpEquivalent: "GET /api/cart",
    params: {},
  },
  checkout: {
    description:
      "Start checkout for the current cart. Automatically idempotent — calling this again while an order is already created/attempted returns that same order instead of creating a duplicate, so it's safe to call again if the result of a previous call is unclear. Fails gracefully (success: false) if the cart is empty, an item's stock vanished since it was added, or a concurrent checkout in another session won a race for the last unit of stock — in each case the affected item is removed from the cart and checkout must be retried. Every order is also checked against a merchant-configured maximum order amount, independent of any budget the caller declared — exceeding it is a graceful failure, not an exception.",
    httpEquivalent: "POST /api/checkout",
    params: {},
  },
  get_order_status: {
    description: "Look up the status of a previously created order by its order id. Scoped to the current session — an order id from a different session will not be found.",
    httpEquivalent: "GET /api/order/{orderId}",
    params: {
      order_id: { type: "string", description: "The orderId returned by checkout." },
    },
  },
  set_budget: {
    description:
      "Set or update the shopper's budget for this session, in rupees (not paise). Call this whenever the shopper states or changes a budget out loud — without calling this, a spoken budget is never enforced against add_to_cart or checkout. Fails gracefully if the requested budget is already below the current cart total; the error explains the shortfall so the shopper can be offered to remove something or raise the budget.",
    httpEquivalent: "N/A — session-scoped, no direct HTTP equivalent exists yet.",
    params: {
      budget: { type: "number", description: "Budget in rupees, e.g. 2000 for two thousand rupees. Not paise." },
    },
  },
};

// Fail fast at module load if TOOL_DETAILS and VOICE_TOOLS ever disagree on
// which tools exist, rather than silently serving an incomplete/stale
// schema to callers.
for (const tool of VOICE_TOOLS) {
  if (!TOOL_DETAILS[tool.name]) {
    throw new Error(`toolSchema.ts is missing details for voice tool "${tool.name}" — update TOOL_DETAILS.`);
  }
}
for (const name of Object.keys(TOOL_DETAILS)) {
  if (!VOICE_TOOLS.some((t) => t.name === name)) {
    throw new Error(`toolSchema.ts has details for "${name}", which is not in VOICE_TOOLS — remove or add it there too.`);
  }
}

export interface AgentToolSchema {
  name: string;
  description: string;
  http_equivalent: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function buildToolSchemas(): AgentToolSchema[] {
  return VOICE_TOOLS.map((tool) => {
    const detail = TOOL_DETAILS[tool.name];
    const required = tool.params.filter((p) => !p.endsWith("?"));
    const properties: Record<string, { type: string; description: string }> = {};
    for (const paramSpec of tool.params) {
      const paramName = paramSpec.endsWith("?") ? paramSpec.slice(0, -1) : paramSpec;
      const paramDetail = detail.params[paramName];
      if (!paramDetail) {
        throw new Error(`toolSchema.ts: missing param detail for "${tool.name}.${paramName}".`);
      }
      properties[paramName] = { type: paramDetail.type, description: paramDetail.description };
    }
    return {
      name: tool.name,
      description: detail.description,
      http_equivalent: detail.httpEquivalent,
      parameters: { type: "object" as const, properties, required },
    };
  });
}

/** Computed once at module load — VOICE_TOOLS/TOOL_DETAILS are both static. */
export const AGENT_TOOL_SCHEMAS: AgentToolSchema[] = buildToolSchemas();
