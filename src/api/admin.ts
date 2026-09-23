import type { Env } from "../types";
import { json, withApiLogging, type ApiResult } from "../middleware/audit";
import { seedCatalog, replaceCatalog } from "../catalog/seed";
import { embedProducts } from "../catalog/embed";
import { generateVisualDescriptions } from "../catalog/visualDescribe";

// TEMPORARY, one-time-use route — accepts Meta's Llama 3.2 Community
// License + Acceptable Use Policy on this Cloudflare account, required
// once before @cf/meta/llama-3.2-11b-vision-instruct will run (see
// catalog/visualDescribe.ts). Same account-level gate as this pattern
// covers: submit the literal string "agree" to the model once. Delete
// this route after it's been called successfully — it has no ongoing
// purpose once the account has accepted.
export async function handleAcceptVisionLicense(request: Request, env: Env): Promise<Response> {
  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/admin/accept-vision-license", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      const result: any = await env.AI.run("@cf/meta/llama-3.2-11b-vision-instruct" as any, { prompt: "agree" } as any);
      return json({ success: true, data: { result } });
    },
  );
}

export async function handleSeedCatalog(request: Request, env: Env): Promise<Response> {
  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/admin/seed-catalog", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      await seedCatalog(env);
      await embedProducts(env);
      // Visual descriptions (see catalog/visualDescribe.ts) are NOT
      // generated here at all — a scheduled() cron trigger (see
      // src/index.ts and triggers.crons in wrangler.jsonc) runs every
      // minute and backfills whatever products still have a NULL
      // visual_description, a handful at a time. This used to try to run
      // synchronously (too slow) and then via ctx.waitUntil (had a real
      // ceiling that got hit mid-catalog) before landing on a cron —
      // fully decoupled from any request's lifetime, so it can't be
      // starved by how long THIS response takes. Give it a few minutes
      // after seeding before expecting every product to have a
      // description; check D1's visual_description column for progress.
      return json({
        success: true,
        data: { status: "ok", message: "Catalog seeded; visual descriptions backfill automatically in the background" },
      });
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
      // See handleSeedCatalog's comment — same reasoning, the cron
      // trigger backfills visual descriptions on its own schedule.
      return json({
        success: true,
        data: {
          status: "ok",
          message: `Removed ${result.removed} products, inserted ${result.inserted}; visual descriptions backfill automatically in the background`,
          ...result,
        },
      });
    },
  );
}

/**
 * Manual/diagnostic trigger for one visual-description batch — the same
 * work the cron does every minute (see catalog/visualDescribe.ts),
 * exposed here so an operator can nudge progress immediately after a
 * seed/replace instead of waiting for the next tick, or check whether a
 * batch is succeeding without needing to tail logs.
 */
export async function handleRunVisualDescriptions(request: Request, env: Env): Promise<Response> {
  return withApiLogging(
    env,
    { sessionId: null, endpoint: "/admin/run-visual-descriptions", method: "POST", params: null },
    async (): Promise<ApiResult> => {
      const result = await generateVisualDescriptions(env);
      return json({ success: true, data: { status: "ok", ...result } });
    },
  );
}
