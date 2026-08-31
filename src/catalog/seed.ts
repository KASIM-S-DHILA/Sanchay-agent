import { CATALOG } from "../catalog";
import type { Env } from "../types";

/**
 * Fully swaps the product catalog for CATALOG — used once, deliberately, to
 * cut over from the original 12-SKU placeholder catalog to the curated
 * apparel.csv set (see catalog.ts). Unlike seedCatalog (INSERT OR IGNORE,
 * additive, safe to call repeatedly), this DELETES every existing product
 * first. Three things must happen together for the cutover to be clean:
 *
 * 1. products — deleted and reinserted. Existing rows keep their live
 *    stock/price if seedCatalog were used instead, which is exactly wrong
 *    here: we WANT last catalog's prices/stock gone, not preserved.
 * 2. cart_items referencing a SKU that no longer exists — deleted. A cart
 *    row survives its product being removed (no FK cascade is enforced by
 *    D1/SQLite here), and would otherwise dangle: a shopper's next /api/cart
 *    read would show a line item with no matching product to display.
 * 3. Vectorize entries for the old SKUs — deleted by id. Leaving them would
 *    let semantic search return a product id that no longer exists in D1,
 *    which searchProducts already tolerates (it skips ids with no matching
 *    row) but is still dead weight worth cleaning up rather than leaving to
 *    accumulate across future catalog swaps.
 *
 * orders.items_json is deliberately left untouched — it's a snapshot of
 * name/price/quantity at the time of that order (see getPurchaseHistory's
 * own comment on why it never re-joins products), so historical order
 * display keeps working even after the referenced SKU is gone.
 */
export async function replaceCatalog(env: Env): Promise<{ removed: number; inserted: number }> {
  const oldIds: any[] = (await env.DB.prepare(`SELECT id FROM products`).all()).results ?? [];

  // D1/SQLite caps bound parameters per statement (~100), and the existing
  // catalog can be well past that after a bulk import — chunk both the
  // cart_items cleanup and the Vectorize delete rather than binding every
  // old id in one IN (...) clause.
  const CHUNK = 50;
  const oldIdValues = oldIds.map((r) => r.id as string);
  for (let i = 0; i < oldIdValues.length; i += CHUNK) {
    const chunk = oldIdValues.slice(i, i + CHUNK);
    // cart_items.product_id carries a FOREIGN KEY to products(id) — must be
    // cleared BEFORE the products delete, not after, or D1 rejects the
    // products delete with SQLITE_CONSTRAINT_FOREIGNKEY.
    const placeholders = chunk.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM cart_items WHERE product_id IN (${placeholders})`)
      .bind(...chunk)
      .run();
  }
  await env.DB.prepare(`DELETE FROM products`).run();
  for (let i = 0; i < oldIdValues.length; i += CHUNK) {
    const chunk = oldIdValues.slice(i, i + CHUNK);
    try {
      await env.VECTOR_INDEX.deleteByIds(chunk);
    } catch (e) {
      // Best-effort — a Vectorize hiccup must not block the D1 cutover,
      // which is the part that actually matters for correctness. Stale
      // vector entries are harmless (searchProducts skips ids with no
      // matching product row) and can be cleaned up on a retry.
      console.warn("replaceCatalog: Vectorize cleanup failed, continuing:", e);
    }
  }

  await seedCatalog(env);
  return { removed: oldIds.length, inserted: CATALOG.length };
}

export async function seedCatalog(env: Env): Promise<void> {
  // Ensure products table exists (for vitest isolated D1 and fresh local DBs)
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      price INTEGER,
      category TEXT,
      stock INTEGER,
      image_url TEXT,
      embedding_id TEXT
    )`
  ).run();

  for (const product of CATALOG) {
    // Convert price to paise if not already (heuristic: <10000 is rupees)
    let pricePaise = product.price;
    if (pricePaise < 10000) {
      pricePaise = Math.round(pricePaise * 100);
    }
    const stock = product.stock ?? 50;
    const imageUrl = product.image_url ?? null;

    await env.DB.prepare(
      `INSERT OR IGNORE INTO products (id, name, description, price, category, stock, image_url, embedding_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(product.sku, product.name, product.description, pricePaise, product.category, stock, imageUrl, null)
      .run();

    // INSERT OR IGNORE is a no-op for products that already exist, so a
    // re-seed (e.g. after adding curated images) would never update their
    // image_url. Only image_url is safe to backfill here — price/stock are
    // live commerce state and must not be clobbered by a reseed.
    if (imageUrl) {
      await env.DB.prepare(
        `UPDATE products SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url != ?)`
      )
        .bind(imageUrl, product.sku, imageUrl)
        .run();
    }
  }
}
