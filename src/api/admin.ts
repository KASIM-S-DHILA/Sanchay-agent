import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { seedCatalog, replaceCatalog } from "../catalog/seed";
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

/**
 * Destructive: deletes every existing product (and any cart_items/Vectorize
 * entries referencing them) and reinserts CATALOG from scratch — see
 * replaceCatalog in catalog/seed.ts for exactly what's touched and what's
 * deliberately left alone (past orders' items_json). Gated behind
 * checkAdminToken like every other /admin/* route; there is no legitimate
 * end-user caller for this.
 */
export async function handleReplaceCatalog(request: Request, env: Env): Promise<Response> {
  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/admin/replace-catalog", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      const result = await replaceCatalog(env);
      await embedProducts(env);
      return json({
        success: true,
        data: { status: "ok", message: `Removed ${result.removed} products, inserted ${result.inserted}`, ...result },
      });
    },
  );
}

