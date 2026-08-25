import type { Env } from "../types";
import type { AIProvider } from "../llm/provider";
import { WorkersAIProvider } from "../llm/workers-ai-provider";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const BATCH_SIZE = 10;

export async function embedProducts(env: Env, provider?: AIProvider): Promise<void> {
  const aiProvider = provider ?? new WorkersAIProvider(env.AI);
  // Fetch products needing embeddings
  const result = await env.DB.prepare(
    `SELECT id, name, description, category, price FROM products WHERE embedding_id IS NULL`
  ).all<{ id: string; name: string; description: string; category: string; price: number }>();

  const products = result.results ?? [];
  if (products.length === 0) return;

  // Process in chunks of 10 — batch AI call per chunk
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const chunk = products.slice(i, i + BATCH_SIZE);
    const texts = chunk.map((p) => `${p.name}. ${p.description}. Category: ${p.category}.`);

    let vectors: number[][] | null = null;
    try {
      vectors = await aiProvider.embed(EMBED_MODEL, texts);
      if (!vectors || vectors.length === 0) {
        console.warn(`No vectors returned for chunk ${i / BATCH_SIZE}, skipping`);
        continue;
      }
    } catch (e) {
      console.error(`Failed to embed chunk ${i / BATCH_SIZE}:`, e);
      continue;
    }

    // Upsert each product in chunk
    for (let j = 0; j < chunk.length; j++) {
      const product = chunk[j];
      const vector = vectors?.[j];
      if (!vector || vector.length !== 768) {
        if (!vector) {
          console.warn(`No vector for product ${product.id}, skipping`);
          continue;
        }
        console.warn(`Vector dimension mismatch for ${product.id}: ${vector.length} expected 768`);
        if (vector.length !== 768) continue;
      }
      try {
        await env.VECTOR_INDEX.upsert([
          {
            id: product.id,
            values: vector,
            metadata: { name: product.name, category: product.category, price: product.price },
          },
        ]);
        await env.DB.prepare(`UPDATE products SET embedding_id = ? WHERE id = ?`)
          .bind(product.id, product.id)
          .run();
      } catch (e) {
        console.error(`Failed to upsert product ${product.id}:`, e);
      }
    }
  }
}
