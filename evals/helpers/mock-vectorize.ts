export class MockVectorizeIndex {
  private vectors: Map<string, { values: number[]; metadata: Record<string, unknown> }> = new Map();

  async upsert(entries: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) {
    for (const entry of entries) {
      this.vectors.set(entry.id, { values: entry.values, metadata: entry.metadata ?? {} });
    }
  }

  async query(queryVector: number[], options: { topK?: number; returnMetadata?: "all" | "none" } = {}) {
    const topK = options.topK ?? 5;
    const results: { id: string; score: number; metadata?: Record<string, unknown> }[] = [];
    for (const [id, entry] of this.vectors) {
      const score = this.cosineSimilarity(queryVector, entry.values);
      results.push({ id, score, metadata: options.returnMetadata === "all" ? entry.metadata : undefined });
    }
    results.sort((a, b) => b.score - a.score);
    return { matches: results.slice(0, topK) };
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // For testing: clear all vectors
  clear() {
    this.vectors.clear();
  }

  size(): number {
    return this.vectors.size;
  }
}
