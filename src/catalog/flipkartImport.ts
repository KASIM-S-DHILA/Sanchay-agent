import type { Env } from "../types";
import flipkartCurated from "./flipkart-curated.json";

/**
 * Curated Flipkart product subset, pre-processed offline by
 * scripts/curate-flipkart-catalog.mjs from the raw 20k-row CSV. That script
 * already handles: price parsing/validation, https image normalization,
 * HTML/control-char stripping, length capping, and de-duplication — this
 * module re-validates defensively (the JSON ships in the repo and could be
 * hand-edited or regenerated incorrectly) but does not re-derive any of it.
 *
 * Separate from seedCatalog/CATALOG on purpose: CATALOG's price field mixes
 * rupees and paise and seedCatalog guesses which based on magnitude. The
 * curated JSON always stores exact paise, so this import path writes prices
 * directly — no heuristic, no ambiguity.
 */
interface FlipkartCuratedProduct {
  sku: string;
  name: string;
  description: string;
  price: number; // paise, exact — no conversion needed
  category: string;
  stock: number;
  // Local category placeholder — the dataset's original CDN (img5a/img6a
  // .flixcart.com, a 2016 crawl) was verified dead (403 on every sampled
  // URL, even with a browser User-Agent), so image_url always points at a
  // local /products/categories/*.svg asset, never the dead CDN.
  image_url: string;
  // Original (dead) Flipkart CDN URL, kept for provenance only — never
  // rendered.
  source_image_url?: string;
}

function isValidCuratedProduct(p: any): p is FlipkartCuratedProduct {
  return (
    typeof p?.sku === "string" &&
    p.sku.length > 0 &&
    typeof p.name === "string" &&
    p.name.length > 0 &&
    p.name.length <= 200 &&
    typeof p.description === "string" &&
    Number.isInteger(p.price) &&
    p.price > 0 &&
    typeof p.category === "string" &&
    Number.isInteger(p.stock) &&
    p.stock >= 0 &&
    typeof p.image_url === "string" &&
    p.image_url.startsWith("/products/") // local asset only, never an external URL
  );
}

export interface FlipkartImportResult {
  imported: number;
  skippedInvalid: number;
  total: number;
}

export async function importFlipkartCatalog(env: Env): Promise<FlipkartImportResult> {
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
    )`,
  ).run();

  const candidates = (flipkartCurated as unknown[]).filter(isValidCuratedProduct);
  const skippedInvalid = (flipkartCurated as unknown[]).length - candidates.length;

  let imported = 0;
  for (const product of candidates) {
    // INSERT OR IGNORE — never overwrites an existing row (price/stock are
    // live commerce state once a product exists; a re-run of this import
    // must not reset them).
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO products (id, name, description, price, category, stock, image_url, embedding_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(product.sku, product.name, product.description, product.price, product.category, product.stock, product.image_url, null)
      .run();
    if (res.meta.changes > 0) imported++;
  }

  return { imported, skippedInvalid, total: candidates.length };
}
