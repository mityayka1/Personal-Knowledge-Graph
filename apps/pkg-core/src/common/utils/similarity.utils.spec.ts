import {
  cosineSimilarity,
  distanceToSimilarity,
  areSemanticallySimlar,
  formatEmbeddingForQuery,
  SEMANTIC_SIMILARITY_THRESHOLD,
} from './similarity.utils';

describe('similarity.utils', () => {
  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];
      expect(cosineSimilarity(a, b)).toBe(1);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosineSimilarity(a, b)).toBe(-1);
    });

    it('should handle normalized vectors correctly', () => {
      // Normalized vectors at 45 degrees
      const a = [1 / Math.sqrt(2), 1 / Math.sqrt(2), 0];
      const b = [1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.sqrt(2), 10);
    });

    it('should handle high-dimensional vectors (1536 dims)', () => {
      const dim = 1536;
      const a = Array(dim).fill(1 / Math.sqrt(dim));
      const b = Array(dim).fill(1 / Math.sqrt(dim));
      expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
    });

    it('should return 0 for zero vectors', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('should throw error for mismatched dimensions', () => {
      const a = [1, 2, 3];
      const b = [1, 2];
      expect(() => cosineSimilarity(a, b)).toThrow(
        'Embedding dimensions must match',
      );
    });

    it('should return 0 for empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it('should be symmetric', () => {
      const a = [0.5, 0.3, 0.8];
      const b = [0.2, 0.9, 0.1];
      expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
    });
  });

  describe('distanceToSimilarity', () => {
    it('should convert distance 0 to similarity 1', () => {
      expect(distanceToSimilarity(0)).toBe(1);
    });

    it('should convert distance 1 to similarity 0', () => {
      expect(distanceToSimilarity(1)).toBe(0);
    });

    it('should convert distance 0.15 to similarity 0.85', () => {
      expect(distanceToSimilarity(0.15)).toBeCloseTo(0.85, 10);
    });
  });

  describe('areSemanticallySimlar', () => {
    it('should return true for identical vectors', () => {
      const a = [1, 0, 0];
      expect(areSemanticallySimlar(a, a)).toBe(true);
    });

    it('should return false for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(areSemanticallySimlar(a, b)).toBe(false);
    });

    it('should use default threshold', () => {
      // Create vectors with ~0.86 similarity
      const a = [1, 0];
      const b = [0.86, Math.sqrt(1 - 0.86 * 0.86)]; // cos(theta) = 0.86
      expect(areSemanticallySimlar(a, b)).toBe(true);
    });

    it('should respect custom threshold', () => {
      const a = [1, 0];
      const b = [0.8, 0.6]; // cos(theta) = 0.8
      expect(areSemanticallySimlar(a, b, 0.75)).toBe(true);
      expect(areSemanticallySimlar(a, b, 0.85)).toBe(false);
    });
  });

  describe('formatEmbeddingForQuery', () => {
    it('should format simple vector', () => {
      expect(formatEmbeddingForQuery([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
    });

    it('should handle empty vector', () => {
      expect(formatEmbeddingForQuery([])).toBe('[]');
    });

    it('should handle single element', () => {
      expect(formatEmbeddingForQuery([0.5])).toBe('[0.5]');
    });

    it('should handle negative numbers', () => {
      expect(formatEmbeddingForQuery([-0.1, 0.2, -0.3])).toBe(
        '[-0.1,0.2,-0.3]',
      );
    });
  });

  describe('SEMANTIC_SIMILARITY_THRESHOLD', () => {
    it('should be 0.85', () => {
      expect(SEMANTIC_SIMILARITY_THRESHOLD).toBe(0.85);
    });
  });
});
