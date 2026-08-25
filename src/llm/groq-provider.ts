import type { AIProvider } from "./provider";

export class GroqProvider implements AIProvider {
  constructor(
    private apiKey: string,
    // ponytail: direct Groq by default — swap in AI Gateway URL later without code changes
    private baseUrl = "https://api.groq.com/openai/v1"
  ) {}

  async chat(model: string, messages: { role: string; content: string }[], opts?: { temperature?: number; max_tokens?: number }): Promise<string> {
    const groqModel = this.mapModel(model);
    // gpt-oss models spend tokens on hidden reasoning before content — ensure headroom
    const isReasoningModel = groqModel.includes("gpt-oss");
    const maxTokens = isReasoningModel ? Math.max(opts?.max_tokens ?? 1024, 768) : opts?.max_tokens ?? 512;

    // ponytail: free-tier TPM throttles bursty suites (429) — 4 attempts,
    // honoring Retry-After when present, else growing delay capped at 12s
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          messages,
          temperature: opts?.temperature ?? 0,
          max_tokens: maxTokens,
        }),
      });
      if (res.ok) {
        const data: any = await res.json();
        return data.choices?.[0]?.message?.content ?? "";
      }
      lastError = new Error(`Groq chat error: ${res.status} ${await res.text()}`);
      // Only retry transient failures — bad key / bad model won't heal
      if (res.status !== 429 && res.status < 500) break;
      if (attempt < 4) {
        const retryAfter = parseFloat(res.headers.get("retry-after") ?? "");
        const delay = Number.isFinite(retryAfter)
          ? Math.min(retryAfter * 1000, 12000)
          : Math.min(2000 * attempt, 12000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError ?? new Error("Groq chat failed");
  }

  async embed(_model: string, _texts: string[]): Promise<number[][]> {
    throw new Error("Groq does not support embeddings. Use OllamaProvider for embeddings.");
  }

  private mapModel(model: string): string {
    // Live Groq catalog (Aug 2026): llama-3.3-70b-versatile and mixtral are retired.
    // gpt-oss-120b follows JSON instructions reliably and separates reasoning from content.
    if (model.includes("gpt-oss")) return model; // already a Groq id
    if (model.includes("qwen")) return "qwen/qwen3.6-27b";
    // Default capable model for Workers AI names (llama-3.1-8b-instruct-fast etc.)
    return "openai/gpt-oss-120b";
  }
}
