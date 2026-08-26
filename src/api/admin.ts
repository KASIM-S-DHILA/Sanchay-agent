import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { seedCatalog } from "../catalog/seed";
import { embedProducts } from "../catalog/embed";

export async function handleSeedCatalog(request: Request, env: Env): Promise<Response> {
  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/admin/seed-catalog", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      await seedCatalog(env);
      await embedProducts(env);
      return json({ success: true, data: { status: "ok", message: "Catalog seeded" } });
    },
  );
}

