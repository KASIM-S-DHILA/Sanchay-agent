import type { AIProvider } from "./provider";

export class WorkersAIProvider implements AIProvider {
  constructor(private ai: Ai) {}

  async chat(model: string, messages: { role: string; content: string }[], opts?: { temperature?: number; max_tokens?: number }): Promise<string> {
    const result: any = await this.ai.run(model as any, { messages, ...opts } as any);
    if (typeof result === "string") return result;
    // Strict typeof guards — newer Workers AI models (e.g. llama-3.1-8b-fast-v2)
    // return OpenAI-compatible {choices:[...]} AND a legacy `response` key that
    // may be a non-string object; never return a non-string from here.
    if (typeof result?.response === "string") return result.response;
    if (typeof result?.text === "string") return result.text;
    const content = result?.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (result?.response != null) return JSON.stringify(result.response);
    return "";
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    const result: any = await this.ai.run(model as any, { text: texts } as any);
    if (result.data) return result.data;
    if (result.embeddings) return result.embeddings;
    if (Array.isArray(result) && Array.isArray(result[0])) return result;
    return [];
  }
}
