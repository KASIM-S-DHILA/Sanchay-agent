import type { Env } from "../types";
import { validateSession } from "../middleware/session";
import { searchCatalog } from "./logic";

export async function handleCatalogSearch(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, request);
  const q = url.searchParams.get("q")?.trim() || "";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 5, 20);

  const { status, body } = await searchCatalog(env, session?.id ?? "", q, limit);
  return Response.json(body, { status });
}
