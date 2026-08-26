import type { Env, ProductSearchResult } from "../types";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export async function searchProducts(env: Env, query: string, topK: number = 5): Promise<ProductSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  try {
    // Embed query
    const embeddingResponse: any = await env.AI.run(EMBED_MODEL, { text: [trimmed] });

    let queryVector: number[] | null = null;
    if (embeddingResponse?.data && Array.isArray(embeddingResponse.data)) {
      const d = embeddingResponse.data;
      if (Array.isArray(d[0])) queryVector = d[0] as number[];
      else queryVector = d as number[];
    } else if (embeddingResponse?.embeddings && Array.isArray(embeddingResponse.embeddings)) {
      queryVector = embeddingResponse.embeddings[0] as number[];
    }

    if (queryVector && queryVector.length === 768) {
      const vectorResults = await env.VECTOR_INDEX.query(queryVector, {
        topK,
        returnMetadata: "all",
      });

      const matches = (vectorResults as any)?.matches ?? (vectorResults as any)?.results ?? [];
      if (matches.length > 0) {
        const results: ProductSearchResult[] = [];
        for (const match of matches) {
          const id = match.id ?? match.vectorId ?? match.productId;
          if (!id) continue;
          const score = match.score ?? 0;
          const row = await env.DB.prepare(
            `SELECT id, name, description, price, category, stock, image_url FROM products WHERE id = ?`
          )
            .bind(id)
            .first<{ id: string; name: string; description: string; price: number; category: string; stock: number; image_url: string | null }>();
          if (row) {
            results.push({
              productId: row.id,
              name: row.name,
              description: row.description,
              price: row.price,
              category: row.category,
              stock: row.stock,
              image_url: row.image_url,
              score,
            });
          }
        }
        if (results.length > 0) return results;
      }
    }
  } catch (e) {
    console.warn("Vectorize search failed, falling back to LIKE:", e);
  }

  // Fallback: D1 LIKE search (handles special chars by escaping)
  return fallbackSearch(env, trimmed, topK);
}

async function fallbackSearch(env: Env, query: string, topK: number): Promise<ProductSearchResult[]> {
  // Escape LIKE wildcards % and _ , and handle special chars gracefully
  const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

  // For multi-word queries (e.g. "warm jacket for winter"), split into tokens
  // and search for any token — this makes fallback useful for semantic queries
  // when Vectorize is unavailable (local dev). Spec's simple LIKE is %query%,
  // but that fails for "warm jacket for winter" vs "warm puffer jacket for winter".
  const words = query
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

  // If single word, use simple LIKE; if multi-word, build OR per token
  try {
    if (words.length <= 1) {
      const likePattern = `%${escapeLike(query)}%`;
      const result = await env.DB.prepare(
        `SELECT id, name, description, price, category, stock, image_url FROM products WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' LIMIT ?`
      )
        .bind(likePattern, likePattern, topK)
        .all<{ id: string; name: string; description: string; price: number; category: string; stock: number; image_url: string | null }>();
      const rows = result.results ?? [];
      return rows.map((row) => ({
        productId: row.id,
        name: row.name,
        description: row.description,
        price: row.price,
        category: row.category,
        stock: row.stock,
        image_url: row.image_url,
        score: 0,
      }));
    }

    // Multi-word: OR LIKE per word (ignore very short tokens like "for", "a")
    const filteredWords = words.filter((w) => w.length > 2);
    const searchWords = filteredWords.length > 0 ? filteredWords : words;

    const conditions = searchWords.map(() => `(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`).join(" OR ");
    const sql = `SELECT id, name, description, price, category, stock, image_url FROM products WHERE ${conditions} LIMIT ?`;
    const params: any[] = [];
    for (const w of searchWords) {
      const pat = `%${escapeLike(w)}%`;
      params.push(pat, pat);
    }
    params.push(topK);

    const result = await env.DB.prepare(sql)
      .bind(...params)
      .all<{ id: string; name: string; description: string; price: number; category: string; stock: number; image_url: string | null }>();

    const rows = result.results ?? [];
    // If word-based still returns 0, fallback to whole-query LIKE as last resort
    if (rows.length === 0) {
      const likePattern = `%${escapeLike(query)}%`;
      const fallback = await env.DB.prepare(
        `SELECT id, name, description, price, category, stock, image_url FROM products WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' LIMIT ?`
      )
        .bind(likePattern, likePattern, topK)
        .all<{ id: string; name: string; description: string; price: number; category: string; stock: number; image_url: string | null }>();
      const fbRows = fallback.results ?? [];
      return fbRows.map((row) => ({
        productId: row.id,
        name: row.name,
        description: row.description,
        price: row.price,
        category: row.category,
        stock: row.stock,
        image_url: row.image_url,
        score: 0,
      }));
    }

    return rows.map((row) => ({
      productId: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      category: row.category,
      stock: row.stock,
      image_url: row.image_url,
      score: 0,
    }));
  } catch (e) {
    console.error("Fallback search failed:", e);
    return [];
  }
}
