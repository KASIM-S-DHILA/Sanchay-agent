import type { AIProvider } from "../../src/llm/provider";
import { GroqProvider } from "../../src/llm/groq-provider";
import { OllamaProvider } from "../../src/llm/ollama-provider";
import { MockVectorizeIndex } from "./mock-vectorize";

export interface EvalEnv {
  chat: AIProvider;
  embed: AIProvider;
  vectorize: MockVectorizeIndex;
}

/**
 * Builds eval providers (Groq chat + Ollama embeddings) and an in-memory
 * Vectorize mock. Returns null when prerequisites are missing so callers
 * can skip AI-dependent tests with a clear message instead of failing.
 *
 * groqKey resolution order: explicit → env binding (.dev.vars) → process.env.
 * Pass `db` to pre-populate the mock Vectorize from the products table.
 */
export async function createEvalEnv(opts?: {
  groqKey?: string;
  db?: D1Database;
}): Promise<EvalEnv | null> {
  let groqKey = opts?.groqKey ?? "";
  if (!groqKey && typeof process !== "undefined") {
    groqKey = process.env.GROQ_API_KEY ?? "";
  }
  if (!groqKey || groqKey.startsWith("gsk_your")) {
    console.warn("Skipped: GROQ_API_KEY not set (add it to .dev.vars)");
    return null;
  }

  // Check Ollama availability for embeddings
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
  } catch {
    console.warn("Skipped: Ollama not available on localhost:11434");
    return null;
  }

  const chat = new GroqProvider(groqKey);
  const embed = new OllamaProvider();
  const vectorize = new MockVectorizeIndex();

  // Validate the Groq key with a tiny request before declaring success
  try {
    await chat.chat(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      [{ role: "user", content: "Reply with the single word: ok" }],
      { temperature: 0, max_tokens: 50 }
    );
  } catch (e) {
    console.warn("Skipped: Groq probe failed:", String(e).slice(0, 300));
    return null;
  }

  // Pre-populate mock Vectorize with catalog embeddings via Ollama
  if (opts?.db) {
    try {
      const result: any = await opts.db.prepare("SELECT id, name, description, category FROM products").all();
      for (const product of result.results ?? []) {
        const text = `${product.name}. ${product.description}. Category: ${product.category}`;
        try {
          const [embedding] = await embed.embed("@cf/baai/bge-base-en-v1.5", [text]);
          if (embedding && embedding.length === 768) {
            await vectorize.upsert([
              { id: product.id as string, values: embedding, metadata: { name: product.name, category: product.category } },
            ]);
          }
        } catch (e) {
          console.warn(`Failed to embed product ${product.id} into mock Vectorize:`, String(e).slice(0, 200));
        }
      }
    } catch (e) {
      console.warn("Failed to pre-populate mock Vectorize:", String(e).slice(0, 300));
    }
  }

  return { chat, embed, vectorize };
}

/** Convenience: build a test Env whose VECTOR_INDEX is the mock. */
export function withMockVectorize<T extends Record<string, any>>(realEnv: T, vectorize: MockVectorizeIndex): T {
  return { ...realEnv, VECTOR_INDEX: vectorize as unknown as VectorizeIndex };
}
