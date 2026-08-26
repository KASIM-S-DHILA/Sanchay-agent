import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { seedCatalog } from "../catalog/seed";
import { embedProducts } from "../catalog/embed";
import { importFlipkartCatalog } from "../catalog/flipkartImport";

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
 * Imports the curated Flipkart product subset (see
 * scripts/curate-flipkart-catalog.mjs and src/catalog/flipkart-curated.json)
 * on top of the existing 12-SKU seed catalog. Idempotent — re-running never
 * overwrites existing rows or their live stock/price. Embedding is a
 * separate, optional step (?embed=true) since embedding 200+ products makes
 * many Workers AI calls and is slow relative to the import itself.
 */
export async function handleImportFlipkartCatalog(request: Request, env: Env, url: URL): Promise<Response> {
  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/admin/import-flipkart", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      const result = await importFlipkartCatalog(env);
      if (url.searchParams.get("embed") === "true") {
        await embedProducts(env);
      }
      return json({
        success: true,
        data: {
          status: "ok",
          message: `Imported ${result.imported} new products (${result.total - result.imported} already present, ${result.skippedInvalid} invalid rows skipped)`,
          ...result,
        },
      });
    },
  );
}

