import type { AIProvider } from "./provider";

export class OllamaProvider implements AIProvider {
  constructor(private baseUrl = "http://localhost:11434") {}

  async chat(_model: string, _messages: { role: string; content: string }[], _opts?: { temperature?: number; max_tokens?: number }): Promise<string> {
    throw new Error("Ollama is only used for embeddings in this project. Use GroqProvider for chat.");
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    // Map Workers AI model names to Ollama model names (nomic-embed-text = 768 dims)
    const ollamaModel = model.includes("bge-base") ? "nomic-embed-text" : model;
    const results: number[][] = [];
    for (const text of texts) {
      const res = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: ollamaModel, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
      const data: any = await res.json();
      results.push(data.embedding);
    }
    return results;
  }
}
