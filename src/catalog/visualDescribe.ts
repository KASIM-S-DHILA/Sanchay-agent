import type { Env } from "../types";

// Cloudflare Workers AI's own vision model — not Gemini, not Groq. Both
// external providers hit real rate-limit walls on a batch as small as 20
// products (Gemini's vision quota 429'd after 1 request; Groq's free tier
// for a vision-capable model measured 8000 TPM / 7000 ITPM, room for only
// 2-3 requests per rolling minute). @cf/meta/llama-3.2-11b-vision-instruct
// runs on Cloudflare's own infrastructure via the SAME `env.AI` binding
// already used for embeddings (see catalog/embed.ts) — no external API
// key, no separate quota to manage, billed under Workers AI's own
// Neuron-based pricing instead of a third-party per-minute rate limit.
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const FETCH_TIMEOUT_MS = 8000;
// Kept small on purpose. This is called from a cron trigger (see the
// scheduled() handler in src/index.ts, and triggers.crons in
// wrangler.jsonc) rather than from an HTTP request's ctx.waitUntil —
// ctx.waitUntil turned out to have a real ceiling that a background job
// covering the whole catalog reliably exceeded (confirmed live:
// "waitUntil() tasks did not complete within the allowed time... and have
// been cancelled" after only part of a 20-product catalog). A cron
// invocation has its own separate execution budget and simply runs again
// next minute if there's more to do — no chaining, no fire-and-forget
// HTTP calls to itself, nothing that can silently drop. Small batches
// keep each individual cron tick comfortably fast regardless.
const BATCH_SIZE = 5;

interface ProductRow {
  id: string;
  name: string;
  category: string;
  image_url: string | null;
}

/**
 * Fetches the product photo and returns it as a plain byte array — the
 * format Workers AI's vision models expect for the `image` input (NOT a
 * base64 string; passing base64 text here fails to decode on Cloudflare's
 * side). Capped at 8MB same as the old external-vision path was, to keep
 * a single oversized image from blowing up memory during the fetch.
 */
async function fetchImageBytes(url: string): Promise<number[] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 8 * 1024 * 1024) return null;
    return Array.from(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/**
 * Asks Workers AI's vision model to write ONE thorough, structured
 * description of a single product photo — deliberately more detailed
 * than a live per-question prompt would need to be, since this is the
 * ONLY chance this product will ever be looked at. A shopper's later
 * question (e.g. "does it have a collar") is answered at conversation
 * time by handing THIS text (not the photo) to a cheap text completion —
 * see api/describeProducts.ts — so anything not captured here can never
 * be answered later. Covers color, material/texture, pattern, and
 * concrete construction details (buttons, collar, pockets, sleeves, hem,
 * closures) specifically because those are the kinds of things shoppers
 * actually ask about.
 */
async function describeOneImage(env: Env, product: ProductRow): Promise<string | null> {
  if (!product.image_url) return null;
  const imageBytes = await fetchImageBytes(product.image_url);
  if (!imageBytes) return null;

  const promptText =
    `Write a thorough visual description of this product photo — color(s), visible material/texture, ` +
    `pattern, and every concrete construction detail you can see (buttons, collar, pockets, sleeves, ` +
    `hem, zippers, laces, straps, etc.). This is a "${product.name}" (${product.category}). ` +
    `4-6 sentences. Be specific and factual about what's actually visible — no marketing language, ` +
    `no guessing at anything not shown in the photo. A shopper's later questions about this item will ` +
    `be answered from this description alone, without looking at the photo again, so be thorough.`;

  try {
    // Workers AI's type for this model exposes two input shapes: a
    // "prompt" form ({ prompt, image }) and a "messages" form. The
    // sibling top-level `image` field pairs with the PROMPT form — a
    // messages array with plain string content plus a top-level image
    // was rejected live with "no user-supplied nor system-supplied
    // messages", so this uses the simpler, documented-compatible shape.
    const response: any = await env.AI.run(VISION_MODEL as any, {
      prompt: promptText,
      image: imageBytes,
    } as any);
    const text: string = typeof response === "string" ? response : (response?.response ?? response?.description ?? "");
    return text.trim() || null;
  } catch (e) {
    console.warn(`visualDescribe: Workers AI call failed for ${product.id}:`, e);
    return null;
  }
}

/**
 * Processes ONE small batch of whatever products still need a
 * visual_description — same "WHERE <marker> IS NULL, safe to re-run"
 * shape as embedProducts in catalog/embed.ts. Called every minute from
 * the scheduled() cron handler in src/index.ts, so:
 *   - a fresh catalog seed/replace (which leaves every new product's
 *     visual_description NULL) gets backfilled automatically within a
 *     few minutes, with zero admin interaction beyond the seed/replace
 *     call itself;
 *   - if the backlog is bigger than one tick can clear, the NEXT tick
 *     just picks up where this one left off — no chaining logic needed,
 *     the cron itself IS the loop.
 *
 * Best-effort per product: one failed call (a dead image URL, a
 * malformed response) never blocks the rest of the batch — that
 * product's visual_description just stays NULL and is retried by a
 * later tick, exactly like a failed embedding already is.
 */
export async function generateVisualDescriptions(env: Env): Promise<{ described: number; skipped: number }> {
  const rows: ProductRow[] = (
    await env.DB.prepare(
      `SELECT id, name, category, image_url FROM products WHERE visual_description IS NULL AND image_url IS NOT NULL LIMIT ?`,
    )
      .bind(BATCH_SIZE)
      .all<ProductRow>()
  ).results ?? [];

  let described = 0;
  let skipped = 0;
  for (const row of rows) {
    const description = await describeOneImage(env, row);
    if (!description) {
      skipped++;
      continue;
    }
    await env.DB.prepare(`UPDATE products SET visual_description = ? WHERE id = ?`)
      .bind(description, row.id)
      .run();
    described++;
  }
  return { described, skipped };
}
