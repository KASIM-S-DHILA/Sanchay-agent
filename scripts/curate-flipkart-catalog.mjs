#!/usr/bin/env node
/**
 * Curates a small, clean product subset from the raw Flipkart CSV
 * (flipkart_com-ecommerce_sample.csv) into a JSON file the Worker can import
 * as a static catalog extension — see src/catalog/flipkartCatalog.ts.
 *
 * This is an OFFLINE script (run manually, not part of the Worker bundle).
 * It exists because the raw CSV is 38MB / 20k rows with real-world data
 * problems (missing/non-numeric prices, dead http image links, duplicate
 * products, Ruby-hash specifications, oversized descriptions). Shipping the
 * CSV or a general-purpose parser into the Worker would be wasteful and
 * risky; curating once, offline, into a small trusted JSON file is safer.
 *
 * Usage:
 *   node scripts/curate-flipkart-catalog.mjs
 *
 * Output:
 *   src/catalog/flipkart-curated.json
 */
import { createReadStream, writeFileSync } from "node:fs";
import { parse } from "csv-parse";

const SOURCE_CSV = new URL("../flipkart_com-ecommerce_sample.csv", import.meta.url);
const OUTPUT_JSON = new URL("../src/catalog/flipkart-curated.json", import.meta.url);

// Categories chosen to fit a general apparel/lifestyle storefront (matches
// the existing 12-SKU seed catalog's theme) rather than importing every
// Flipkart department (electronics, furniture, automotive, etc.) wholesale.
const ALLOWED_CATEGORIES = new Map([
  ["Clothing", "Clothing"],
  ["Footwear", "Footwear"],
  ["Bags, Wallets & Belts", "Bags & Accessories"],
  ["Watches", "Watches"],
  ["Sunglasses", "Sunglasses"],
  ["Sports & Fitness", "Sports & Fitness"],
]);

const MAX_PER_CATEGORY = 40; // ~6 categories x 40 = up to 240 products
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 400;
const DEFAULT_STOCK = 25;

// IMPORTANT: verified by hand (fetching a sample with a browser User-Agent)
// that the raw dataset's legacy img5a/img6a.flixcart.com CDN links all
// return 403 — this is a 2016 crawl and that CDN path appears fully
// retired, not just spotty. Using the raw `image` column as image_url would
// silently degrade every imported product to the generic placeholder in
// the UI. Instead, each category gets its own local placeholder graphic so
// imported products are still visually distinguishable by category. The
// original (dead) CDN URL is kept as source_image_url for provenance only
// — never rendered.
const CATEGORY_PLACEHOLDER = new Map([
  ["Clothing", "/products/categories/clothing.svg"],
  ["Footwear", "/products/categories/footwear.svg"],
  ["Bags & Accessories", "/products/categories/bags.svg"],
  ["Watches", "/products/categories/watches.svg"],
  ["Sunglasses", "/products/categories/sunglasses.svg"],
  ["Sports & Fitness", "/products/categories/sports-fitness.svg"],
]);

function topLevelCategory(categoryTreeRaw) {
  try {
    const tree = JSON.parse(categoryTreeRaw);
    const first = Array.isArray(tree) ? tree[0] : "";
    return String(first).split(">>")[0].trim();
  } catch {
    return "";
  }
}

/**
 * First image URL from the JSON-array `image` column, normalized to https,
 * or null. Kept only as source_image_url provenance metadata — the dataset's
 * CDN is dead (see CATEGORY_PLACEHOLDER note above), so this is never used
 * as the rendered image_url.
 */
function firstImageUrlForProvenance(imageRaw) {
  let urls;
  try {
    urls = JSON.parse(imageRaw);
  } catch {
    return null;
  }
  if (!Array.isArray(urls) || urls.length === 0) return null;
  const raw = String(urls[0]).trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Strips HTML tags/control chars and caps length. Defense in depth — the
 * frontend also escapes text on render, but stored data shouldn't carry
 * markup or unbounded length regardless of how it's later consumed. */
function sanitizeText(raw, maxLength) {
  if (typeof raw !== "string") return "";
  const stripped = raw
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength - 1).trim()}…` : stripped;
}

function parsePriceToPaise(row) {
  const rupees = Number(row.discounted_price) > 0 ? Number(row.discounted_price) : Number(row.retail_price);
  if (!Number.isFinite(rupees) || rupees <= 0) return null;
  // Reject absurd outliers (e.g. mispriced luxury/bulk listings) that would
  // make a voice-shopping demo confusing.
  if (rupees > 50_000) return null;
  return Math.round(rupees * 100);
}

function normalizeDedupeKey(name, brand) {
  return `${(brand || "").toLowerCase().trim()}::${name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

async function main() {
  const parser = createReadStream(SOURCE_CSV).pipe(
    parse({ columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true }),
  );

  const perCategory = new Map(); // display category -> array of curated products
  const seenDedupeKeys = new Set();
  let scanned = 0;
  let rejectedPrice = 0;
  let rejectedImage = 0;
  let rejectedDuplicate = 0;
  let rejectedName = 0;

  for await (const row of parser) {
    scanned++;
    const rawCategory = topLevelCategory(row.product_category_tree);
    const displayCategory = ALLOWED_CATEGORIES.get(rawCategory);
    if (!displayCategory) continue;

    const bucket = perCategory.get(displayCategory) ?? [];
    if (bucket.length >= MAX_PER_CATEGORY) continue; // category already full

    const name = sanitizeText(row.product_name, MAX_NAME_LENGTH);
    if (!name) {
      rejectedName++;
      continue;
    }

    const priceInPaise = parsePriceToPaise(row);
    if (priceInPaise === null) {
      rejectedPrice++;
      continue;
    }

    const sourceImageUrl = firstImageUrlForProvenance(row.image);
    if (!sourceImageUrl) {
      rejectedImage++;
      continue;
    }

    const dedupeKey = normalizeDedupeKey(name, row.brand);
    if (seenDedupeKeys.has(dedupeKey)) {
      rejectedDuplicate++;
      continue;
    }

    const description =
      sanitizeText(row.description, MAX_DESCRIPTION_LENGTH) || `${name}. ${displayCategory}.`;

    const sku = `FK-${String(row.uniq_id || "").slice(0, 16).toUpperCase()}`;
    if (!row.uniq_id) continue;

    seenDedupeKeys.add(dedupeKey);
    bucket.push({
      sku,
      name,
      description,
      price: priceInPaise,
      category: displayCategory,
      stock: DEFAULT_STOCK,
      image_url: CATEGORY_PLACEHOLDER.get(displayCategory),
      source_image_url: sourceImageUrl,
    });
    perCategory.set(displayCategory, bucket);
  }

  const curated = [...perCategory.values()].flat();

  writeFileSync(OUTPUT_JSON, JSON.stringify(curated, null, 2) + "\n", "utf8");

  console.log(`Scanned ${scanned} rows.`);
  console.log(`Rejected — no name: ${rejectedName}, bad/outlier price: ${rejectedPrice}, no source image: ${rejectedImage}, duplicate: ${rejectedDuplicate}`);
  console.log(`Curated ${curated.length} products across ${perCategory.size} categories:`);
  for (const [cat, items] of perCategory) {
    console.log(`  ${items.length.toString().padStart(4)}  ${cat}`);
  }
  console.log(`Wrote ${OUTPUT_JSON.pathname}`);
}

main().catch((e) => {
  console.error("curation failed:", e);
  process.exit(1);
});
