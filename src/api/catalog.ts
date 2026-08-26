import type { Env } from "../types";
import { validateSession } from "../middleware/session";
import { logApiCall } from "../middleware/audit";
import { isUnsubstitutedPlaceholder, placeholderError } from "../middleware/placeholders";
import { searchCatalog } from "./logic";

export async function handleCatalogSearch(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  // Sarvam tools POST with a JSON body; frontend uses query params. Accept both.
  let bodyParams: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      bodyParams = (await request.json()) as Record<string, unknown>;
    } catch {
      bodyParams = {};
    }
  }
  // Sarvam's LLM fills `query`; the frontend sends `q`. Accept both names.
  const rawQuery = bodyParams.q ?? bodyParams.query ?? url.searchParams.get("q") ?? "";
  const limit = Math.min(Number(bodyParams.limit ?? url.searchParams.get("limit")) || 5, 20);

  // Refuse to search for a literal "{{query}}". Previously this returned 200
  // with fallback matches, so the agent thought the lookup had succeeded and
  // recommended whatever came back. Failing loudly is the honest outcome, and
  // the error text tells whoever reads it how to fix the tool config.
  if (isUnsubstitutedPlaceholder(rawQuery)) {
    const body = { success: false, error: placeholderError("search query") };
    await logApiCall(env, {
      sessionId: session?.id ?? null,
      endpoint: "/api/catalog",
      method: request.method,
      params: { rejected: "unsubstituted_template_in_query", query_supplied: String(rawQuery).slice(0, 40) },
      response: body,
      status: "blocked",
      durationMs: 0,
    }).catch((e) => console.error("api_call_log write failed:", e));
    return Response.json(body, { status: 400 });
  }

  const q = String(rawQuery).trim();
  const { status, body } = await searchCatalog(env, session?.id ?? "", q, limit);
  return Response.json(body, { status });
}
