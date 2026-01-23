import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { EntityFact } from '@pkg/entities';
import { ExtractedFact } from './fact-extraction.service';
import { EmbeddingService } from '../embedding/embedding.service';
import {
  SEMANTIC_SIMILARITY_THRESHOLD,
  formatEmbeddingForQuery,
} from '../../common/utils/similarity.utils';

export interface DeduplicationResult {
  action: 'create' | 'update' | 'skip' | 'supersede';
  existingFactId?: string;
  reason: string;
}

/**
 * Deduplicates facts before saving to database.
 * Handles:
 * - Exact duplicates (skip)
 * - Similar facts (boost confidence)
 * - Temporal updates (close old, create new)
 */
@Injectable()
export class FactDeduplicationService {
  private readonly logger = new Logger(FactDeduplicationService.name);

  // Similarity threshold for fuzzy matching
  private readonly SIMILARITY_THRESHOLD = 0.8;

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    @Optional()
    private embeddingService: EmbeddingService | null,
  ) {}

  /**
   * Check if extracted fact is duplicate and determine action
   */
  async checkDuplicate(
    entityId: string,
    newFact: ExtractedFact,
  ): Promise<DeduplicationResult> {
    // Find existing facts of same type for this entity
    const existingFacts = await this.factRepo.find({
      where: {
        entityId,
        factType: newFact.factType,
        validUntil: IsNull(), // Only active facts
      },
      order: { createdAt: 'DESC' },
    });

    if (existingFacts.length === 0) {
      return { action: 'create', reason: 'No existing facts of this type' };
    }

    // Check for exact match
    const exactMatch = existingFacts.find(
      (f) => f.value && this.normalizeValue(f.value) === this.normalizeValue(newFact.value),
    );

    if (exactMatch) {
      return {
        action: 'skip',
        existingFactId: exactMatch.id,
        reason: 'Exact duplicate exists',
      };
    }

    // Check for similar match (fuzzy)
    for (const existing of existingFacts) {
      if (!existing.value) continue;

      const similarity = this.calculateSimilarity(
        this.normalizeValue(existing.value),
        this.normalizeValue(newFact.value),
      );

      if (similarity >= this.SIMILARITY_THRESHOLD) {
        // Similar but not exact - might be an update
        if (this.isTemporalUpdate(existing.factType, existing.value, newFact.value)) {
          return {
            action: 'supersede',
            existingFactId: existing.id,
            reason: `Temporal update detected (similarity: ${similarity.toFixed(2)})`,
          };
        }

        // Just similar - might be same fact with different wording
        return {
          action: 'update',
          existingFactId: existing.id,
          reason: `Similar fact exists (similarity: ${similarity.toFixed(2)})`,
        };
      }
    }

    // No match - create new
    return { action: 'create', reason: 'No similar facts found' };
  }

  /**
   * Check for semantic duplicate using embeddings.
   * More accurate than Levenshtein for semantically similar but differently worded facts.
   *
   * Example: "Работает в Сбере" vs "Сотрудник Сбербанка"
   * - Levenshtein: ~20% similar (fails)
   * - Semantic: ~95% similar (detects duplicate)
   *
   * @returns DeduplicationResult with action and optional existing fact ID
   */
  async checkSemanticDuplicate(
    entityId: string,
    newFactValue: string,
    factType?: string,
  ): Promise<DeduplicationResult> {
    if (!this.embeddingService) {
      this.logger.warn('EmbeddingService not available, falling back to text-based dedup');
      return { action: 'create', reason: 'Semantic dedup unavailable' };
    }

    try {
      // 1. Generate embedding for new fact value
      const embedding = await this.embeddingService.generate(newFactValue);
      const embeddingStr = formatEmbeddingForQuery(embedding);

      // 2. Build query to find similar facts using pgvector cosine distance
      // Note: pgvector <=> returns distance (0 = identical), we convert to similarity
      let query = `
        SELECT id, value, fact_type, 1 - (embedding <=> $1::vector) as similarity
        FROM entity_facts
        WHERE entity_id = $2
          AND valid_until IS NULL
          AND embedding IS NOT NULL
          AND 1 - (embedding <=> $1::vector) > $3
      `;
      const params: (string | number)[] = [
        embeddingStr,
        entityId,
        SEMANTIC_SIMILARITY_THRESHOLD,
      ];

      // Optionally filter by fact type
      if (factType) {
        query += ` AND fact_type = $4`;
        params.push(factType);
      }

      query += ` ORDER BY similarity DESC LIMIT 1`;

      const similar = await this.factRepo.query(query, params);

      // 3. Return result
      if (similar.length > 0) {
        const match = similar[0];
        const similarity = parseFloat(match.similarity);

        this.logger.debug(
          `Semantic duplicate found: "${newFactValue}" ≈ "${match.value}" (similarity: ${similarity.toFixed(3)})`,
        );

        return {
          action: 'skip',
          existingFactId: match.id,
          reason: `Semantic duplicate (similarity: ${similarity.toFixed(2)})`,
        };
      }

      return { action: 'create', reason: 'No semantic duplicates found' };
    } catch (error: any) {
      this.logger.error(`Semantic dedup failed: ${error.message}`, error.stack);
      // Fallback to allowing creation on error
      return { action: 'create', reason: 'Semantic dedup error, allowing creation' };
    }
  }

  /**
   * Hybrid deduplication: first check text-based, then semantic if needed.
   * This is more efficient as text-based check is cheaper.
   */
  async checkDuplicateHybrid(
    entityId: string,
    newFact: ExtractedFact,
  ): Promise<DeduplicationResult> {
    // First, quick text-based check
    const textResult = await this.checkDuplicate(entityId, newFact);

    // If text-based found a match, use it
    if (textResult.action !== 'create') {
      return textResult;
    }

    // If no text match found, try semantic check
    const semanticResult = await this.checkSemanticDuplicate(
      entityId,
      newFact.value,
      newFact.factType,
    );

    return semanticResult;
  }

  /**
   * Process batch of extracted facts with deduplication
   */
  async processBatch(
    entityId: string,
    facts: ExtractedFact[],
  ): Promise<{
    toCreate: ExtractedFact[];
    toSupersede: Array<{ newFact: ExtractedFact; oldFactId: string }>;
    skipped: number;
  }> {
    const toCreate: ExtractedFact[] = [];
    const toSupersede: Array<{ newFact: ExtractedFact; oldFactId: string }> = [];
    let skipped = 0;

    // Also deduplicate within the batch itself
    const seenInBatch = new Map<string, ExtractedFact>();

    for (const fact of facts) {
      const key = `${fact.factType}:${this.normalizeValue(fact.value)}`;

      // Check within batch
      if (seenInBatch.has(key)) {
        const existing = seenInBatch.get(key)!;
        // Keep the one with higher confidence
        if (fact.confidence > existing.confidence) {
          seenInBatch.set(key, fact);
        }
        skipped++;
        continue;
      }

      seenInBatch.set(key, fact);

      // Check against database
      const result = await this.checkDuplicate(entityId, fact);

      switch (result.action) {
        case 'create':
          toCreate.push(fact);
          break;
        case 'supersede':
          toSupersede.push({ newFact: fact, oldFactId: result.existingFactId! });
          break;
        case 'update':
          // Boost confidence of existing fact instead of creating new
          skipped++;
          this.logger.debug(`Skipping similar fact: ${fact.factType}=${fact.value}`);
          break;
        case 'skip':
          skipped++;
          break;
      }
    }

    this.logger.log(
      `Deduplication: ${toCreate.length} create, ${toSupersede.length} supersede, ${skipped} skipped`,
    );

    return { toCreate, toSupersede, skipped };
  }

  /**
   * Normalize value for comparison
   */
  private normalizeValue(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s@.+-]/g, ''); // Keep alphanumeric, spaces, and common symbols
  }

  /**
   * Calculate similarity between two strings (Levenshtein-based)
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const longer = a.length > b.length ? a : b;
    const shorter = a.length > b.length ? b : a;

    // Quick check: if length difference is too big, not similar
    if (longer.length - shorter.length > longer.length * 0.5) {
      return 0;
    }

    const editDistance = this.levenshteinDistance(shorter, longer);
    return 1 - editDistance / longer.length;
  }

  /**
   * Levenshtein distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1, // insertion
            matrix[i - 1][j] + 1, // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Check if this is a temporal update (e.g., job change)
   */
  private isTemporalUpdate(
    factType: string,
    oldValue: string,
    newValue: string,
  ): boolean {
    // Temporal fact types - these change over time
    const temporalTypes = ['position', 'company', 'department', 'location', 'status'];

    if (!temporalTypes.includes(factType)) {
      return false;
    }

    // Different values suggest a change
    const similarity = this.calculateSimilarity(
      this.normalizeValue(oldValue),
      this.normalizeValue(newValue),
    );

    // Similar but not the same - likely an update
    return similarity >= 0.3 && similarity < 0.95;
  }

  /**
   * Close old fact and prepare for new one (temporal update)
   */
  async supersedeFact(oldFactId: string): Promise<void> {
    await this.factRepo.update(oldFactId, {
      validUntil: new Date(),
    });
    this.logger.debug(`Superseded fact ${oldFactId}`);
  }
}
