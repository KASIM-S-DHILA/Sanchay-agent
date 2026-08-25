import { WorkersAIProvider } from "./workers-ai-provider";
import { GroqProvider } from "./groq-provider";
import { OllamaProvider } from "./ollama-provider";
import type { AIProvider } from "./provider";
import type { Env } from "../types";

export function createChatProvider(env: Env): AIProvider {
  // Production path: Workers AI via binding
  return new WorkersAIProvider(env.AI);
}

export function createEmbeddingProvider(env: Env): AIProvider {
  return new WorkersAIProvider(env.AI);
}

// For evals — Groq for chat + Ollama for embeddings. Returns null when either
// prerequisite is missing so callers can skip AI-dependent tests cleanly.
export async function createEvalProviders(opts?: {
  groqKey?: string;
  db?: D1Database;
}): Promise<{ chat: AIProvider; embed: AIProvider } | null> {
  let groqKey = opts?.groqKey ?? "";
  // ponytail: nodejs_compat's process.env is empty in workerd — prefer the
  // explicit/.dev.vars binding path, but honor real node env when present
  if (!groqKey && typeof process !== "undefined") {
    groqKey = process.env.GROQ_API_KEY ?? "";
  }
  if (!groqKey || groqKey.startsWith("gsk_your")) return null;

  // Validate Ollama availability for embeddings
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
  } catch {
    return null;
  }

  return {
    chat: new GroqProvider(groqKey),
    embed: new OllamaProvider(),
  };
}
