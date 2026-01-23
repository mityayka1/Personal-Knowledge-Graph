/**
 * Semantic Similarity Utilities
 *
 * Functions for calculating similarity between embeddings and text.
 * Used for deduplication of facts and events.
 */

/**
 * Default threshold for semantic similarity.
 * Values above this are considered duplicates.
 */
export const SEMANTIC_SIMILARITY_THRESHOLD = 0.85;

/**
 * Calculate cosine similarity between two embedding vectors.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Similarity score between 0 and 1 (1 = identical)
 *
 * @example
 * const sim = cosineSimilarity([1, 0, 0], [1, 0, 0]); // 1.0
 * const sim = cosineSimilarity([1, 0, 0], [0, 1, 0]); // 0.0
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimensions must match: ${a.length} vs ${b.length}`,
    );
  }

  if (a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);

  if (magnitude === 0) {
    return 0;
  }

  return dotProduct / magnitude;
}

/**
 * Convert pgvector cosine distance to similarity score.
 * pgvector's <=> operator returns distance (0 = identical, 2 = opposite)
 *
 * @param distance - Cosine distance from pgvector (0-2)
 * @returns Similarity score (0-1)
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

/**
 * Check if two embeddings are semantically similar.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @param threshold - Similarity threshold (default: 0.85)
 * @returns true if similarity >= threshold
 */
export function areSemanticallySimlar(
  a: number[],
  b: number[],
  threshold: number = SEMANTIC_SIMILARITY_THRESHOLD,
): boolean {
  return cosineSimilarity(a, b) >= threshold;
}

/**
 * Format embedding array for pgvector query parameter.
 * Converts number[] to string format expected by pgvector.
 *
 * @param embedding - Embedding vector
 * @returns String representation for SQL query
 *
 * @example
 * formatEmbeddingForQuery([0.1, 0.2, 0.3]) // "[0.1,0.2,0.3]"
 */
export function formatEmbeddingForQuery(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
