import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { EntityFact, FactSource } from '@pkg/entities';
import { CreateFactDto } from '../dto/create-entity.dto';
import { EmbeddingService } from '../../embedding/embedding.service';
import {
  SEMANTIC_SIMILARITY_THRESHOLD,
  formatEmbeddingForQuery,
} from '../../../common/utils/similarity.utils';

export interface CreateFactResult {
  fact: EntityFact;
  action: 'created' | 'skipped' | 'updated';
  reason?: string;
  existingFactId?: string;
}

@Injectable()
export class EntityFactService {
  private readonly logger = new Logger(EntityFactService.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    @Optional()
    private embeddingService: EmbeddingService | null,
  ) {}

  /**
   * Create a new fact with semantic deduplication.
   * Returns the fact and action taken (created, skipped, or updated).
   */
  async create(entityId: string, dto: CreateFactDto): Promise<EntityFact> {
    const result = await this.createWithDedup(entityId, dto);
    return result.fact;
  }

  /**
   * Create a new fact with semantic deduplication check.
   * Returns detailed result including action taken.
   */
  async createWithDedup(
    entityId: string,
    dto: CreateFactDto,
    options?: { skipSemanticCheck?: boolean },
  ): Promise<CreateFactResult> {
    // If we have a text value and embedding service, check for semantic duplicates
    if (dto.value && this.embeddingService && !options?.skipSemanticCheck) {
      const dupResult = await this.checkSemanticDuplicate(entityId, dto.value, dto.type);

      if (dupResult.isDuplicate && dupResult.existingFact) {
        this.logger.debug(
          `Semantic duplicate found for "${dto.value}" - existing fact: ${dupResult.existingFact.id}`,
        );

        // If new source has higher confidence potential (e.g., EXTRACTED), we might want to update
        // For now, just skip and return existing
        return {
          fact: dupResult.existingFact,
          action: 'skipped',
          reason: dupResult.reason,
          existingFactId: dupResult.existingFact.id,
        };
      }
    }

    // Create the fact first
    const fact = this.factRepo.create({
      entityId,
      factType: dto.type,
      category: dto.category,
      value: dto.value,
      valueDate: dto.valueDate,
      valueJson: dto.valueJson,
      source: dto.source || FactSource.MANUAL,
      validFrom: new Date(),
    });

    // Generate embedding for the fact value
    let hasEmbedding = false;
    if (dto.value && this.embeddingService) {
      try {
        const embedding = await this.embeddingService.generate(dto.value);
        fact.embedding = embedding;
        hasEmbedding = true;
      } catch (error: any) {
        this.logger.warn(`Failed to generate embedding for fact: ${error.message}`);
        // Continue without embedding - fact will still be created
      }
    }

    const savedFact = await this.factRepo.save(fact);

    return {
      fact: savedFact,
      action: 'created',
      reason: hasEmbedding ? 'Created with embedding' : 'Created without embedding',
    };
  }

  /**
   * Check for semantic duplicate using embeddings.
   */
  private async checkSemanticDuplicate(
    entityId: string,
    value: string,
    factType?: string,
  ): Promise<{
    isDuplicate: boolean;
    existingFact?: EntityFact;
    similarity?: number;
    reason?: string;
  }> {
    if (!this.embeddingService) {
      return { isDuplicate: false, reason: 'Embedding service not available' };
    }

    try {
      // Generate embedding for the new value
      const embedding = await this.embeddingService.generate(value);
      const embeddingStr = formatEmbeddingForQuery(embedding);

      // Build query to find similar facts
      let query = `
        SELECT id, entity_id, fact_type, category, value, value_date, value_json,
               source, confidence, embedding, source_interaction_id,
               valid_from, valid_until, created_at, updated_at,
               1 - (embedding <=> $1::vector) as similarity
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

      const results = await this.factRepo.query(query, params);

      if (results.length > 0) {
        const match = results[0];
        const similarity = parseFloat(match.similarity);

        // Fetch the full entity to get proper relations
        const existingFact = await this.factRepo.findOne({
          where: { id: match.id },
        });

        if (existingFact) {
          return {
            isDuplicate: true,
            existingFact,
            similarity,
            reason: `Semantic duplicate (similarity: ${similarity.toFixed(2)})`,
          };
        }
      }

      return { isDuplicate: false, reason: 'No semantic duplicates found' };
    } catch (error: any) {
      this.logger.error(`Semantic duplicate check failed: ${error.message}`);
      return { isDuplicate: false, reason: `Check failed: ${error.message}` };
    }
  }

  async findByEntity(entityId: string, includeHistory = false) {
    const where: any = { entityId };

    if (!includeHistory) {
      where.validUntil = IsNull();
    }

    return this.factRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async moveToEntity(fromEntityId: string, toEntityId: string) {
    const result = await this.factRepo.update(
      { entityId: fromEntityId },
      { entityId: toEntityId },
    );
    return result.affected || 0;
  }

  async invalidate(factId: string) {
    const result = await this.factRepo.update(factId, {
      validUntil: new Date(),
    });
    return result.affected === 1;
  }
}
