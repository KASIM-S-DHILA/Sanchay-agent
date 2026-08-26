import type { Env } from "../types";
import { validateSession } from "../middleware/session";
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
  const q = String(bodyParams.q ?? url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(Number(bodyParams.limit ?? url.searchParams.get("limit")) || 5, 20);

  const { status, body } = await searchCatalog(env, session?.id ?? "", q, limit);
  return Response.json(body, { status });
}
