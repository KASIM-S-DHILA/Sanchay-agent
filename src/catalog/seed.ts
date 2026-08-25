import { CATALOG } from "../catalog";
import type { Env } from "../types";

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
  }
}
