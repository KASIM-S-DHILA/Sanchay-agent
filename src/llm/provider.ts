export interface AIProvider {
  chat(model: string, messages: { role: string; content: string }[], opts?: { temperature?: number; max_tokens?: number }): Promise<string>;
  embed(model: string, texts: string[]): Promise<number[][]>;
}
