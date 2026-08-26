import type { Env } from "../types";
import { AGENT_TOOL_SCHEMAS } from "../voice/toolSchema";
import openApiSpecYaml from "../../openapi.yaml";

/**
 * Machine-readable description of the commerce operations an AI
 * buyer/agent can invoke — either as the tool set registered with Sarvam's
 * voice runtime, or by calling the equivalent plain HTTP endpoint directly
 * (see openapi.yaml for full request/response detail on those endpoints).
 *
 * Unauthenticated and side-effect free by design: it only describes the
 * API surface, matching /openapi.yaml's public/no-auth exposure.
 */
export async function handleOpenApiSpec(_request: Request, _env: Env): Promise<Response> {
  return new Response(openApiSpecYaml, {
    headers: { "Content-Type": "application/yaml; charset=utf-8" },
  });
}

export async function handleGetTools(_request: Request, _env: Env): Promise<Response> {
  return Response.json({
    success: true,
    data: {
      tools: AGENT_TOOL_SCHEMAS,
      openapi_spec_url: "/openapi.yaml",
      notes: [
        "All monetary amounts in tool results are paise (1/100 INR) unless the field name ends in _display.",
        "Business failures (out of stock, budget exceeded, item not in cart, empty cart) are returned as { success: false, error } — they are not exceptions and do not indicate the call itself failed.",
        "add_to_cart and remove_from_cart enforce the same 1-99 integer quantity rule and the same live stock/budget checks regardless of whether they are invoked as a voice tool call or the equivalent HTTP endpoint.",
      ],
    },
  });
}
