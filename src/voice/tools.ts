import type { Env } from "../types";

/**
 * In-process tool execution for Sarvam voice tool calls.
 * Calls the same logic functions as the HTTP routes — identical enforcement
 * (stock, budget, idempotency) and identical api_call_log audit entries.
 */

export type ToolResult = Record<string, unknown>;

export async function executeToolCall(
  env: Env,
  sessionId: string,
  toolName: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  // Lazy imports keep the module graph flat and avoid cycles
  const logic = await import("../api/logic");

  switch (toolName) {
    case "search_catalog":
      return (await logic.searchCatalog(env, sessionId, String(params.query ?? ""))).body;
    case "add_to_cart":
      // Quantity range/integer validation happens inside addToCart, so
      // voice calls get identical enforcement to the HTTP cart routes.
      // idempotency_key lets Sarvam safely retry a tool call that timed out
      // without double-adding the item.
      return (
        await logic.addToCart(
          env,
          sessionId,
          String(params.product_id),
          params.quantity,
          params.idempotency_key ? String(params.idempotency_key) : undefined,
        )
      ).body;
    case "remove_from_cart":
      return (
        await logic.removeFromCart(env, sessionId, String(params.product_id), params.quantity)
      ).body;
    case "get_cart":
      return (await logic.getCart(env, sessionId)).body;
    case "checkout":
      return (await logic.checkoutCart(env, sessionId)).body;
    case "get_order_status":
      return (
        await logic.getOrderStatus(env, sessionId, String(params.order_id ?? ""))
      ).body;
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

export const VOICE_TOOLS = [
  { name: "search_catalog", params: ["query"] },
  { name: "add_to_cart", params: ["product_id", "quantity?", "idempotency_key?"] },
  { name: "remove_from_cart", params: ["product_id", "quantity?"] },
  { name: "get_cart", params: [] },
  { name: "checkout", params: [] },
  { name: "get_order_status", params: ["order_id"] },
] as const;
