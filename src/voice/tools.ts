/**
 * Declares which voice/agent tools exist and what params each takes — the
 * source of truth toolSchema.ts builds the public AGENT_TOOL_SCHEMAS from
 * (see /api/tools, /openapi.yaml). Kept deliberately data-only: an earlier
 * in-process tool-call dispatcher (executeToolCall) lived here too, built
 * for a Sarvam-hosted voice runtime that called tools directly rather than
 * over HTTP. That runtime was replaced by the browser-side Gemini Live
 * integration (useGeminiLive.ts), which calls the plain REST endpoints
 * directly — the dispatcher had zero callers and was removed. This list
 * itself is still real: it's what an external AI agent's tool-calling
 * schema is generated from, independent of which voice runtime (if any)
 * exercises it.
 */
export const VOICE_TOOLS = [
  { name: "search_catalog", params: ["query"] },
  { name: "add_to_cart", params: ["product_id", "quantity?", "idempotency_key?"] },
  { name: "remove_from_cart", params: ["product_id", "quantity?"] },
  { name: "get_cart", params: [] },
  { name: "checkout", params: [] },
  { name: "get_order_status", params: ["order_id"] },
  { name: "set_budget", params: ["budget"] },
  { name: "propose_add_to_cart", params: ["product_id", "quantity?"] },
  { name: "propose_remove_from_cart", params: ["product_id", "quantity?"] },
  { name: "confirm_action", params: ["action_token"] },
] as const;
