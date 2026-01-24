import { Injectable, Logger, Optional, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, Not } from 'typeorm';
import { EntityFact, FactSource, FactCategory, EntityRecord } from '@pkg/entities';
import { EntityService } from '../entity.service';
import { CreateFactDto } from '../dto/create-entity.dto';
import { EmbeddingService } from '../../embedding/embedding.service';
import {
  SEMANTIC_SIMILARITY_THRESHOLD,
  formatEmbeddingForQuery,
} from '../../../common/utils/similarity.utils';
import { FactFusionService } from './fact-fusion.service';

export interface CreateFactResult {
  fact: EntityFact;
  action: 'created' | 'skipped' | 'updated';
  reason?: string;
  existingFactId?: string;
  /** For CONFLICT action - fact needs human review */
  needsReview?: boolean;
  /** For CONFLICT action - new fact data to create after resolution */
  newFactData?: CreateFactDto;
}

@Injectable()
export class EntityFactService {
  private readonly logger = new Logger(EntityFactService.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    @Optional()
    @Inject(EmbeddingService)
    private embeddingService: EmbeddingService | null,
    @Optional()
    @Inject(forwardRef(() => FactFusionService))
    private factFusionService: FactFusionService | null,
    @Optional()
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService | null,
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
    options?: {
      skipSemanticCheck?: boolean;
      skipFusion?: boolean;
      messageContext?: string;
    },
  ): Promise<CreateFactResult> {
    // If we have a text value and embedding service, check for semantic duplicates
    if (dto.value && this.embeddingService && !options?.skipSemanticCheck) {
      const dupResult = await this.checkSemanticDuplicate(entityId, dto.value, dto.type);

      if (dupResult.isDuplicate && dupResult.existingFact) {
        this.logger.debug(
          `Semantic duplicate found for "${dto.value}" - existing fact: ${dupResult.existingFact.id}`,
        );

        // Use LLM to decide fusion strategy
        if (!options?.skipFusion && this.factFusionService) {
          const decision = await this.factFusionService.decideFusion(
            dupResult.existingFact,
            dto.value,
            dto.source || FactSource.EXTRACTED,
            { messageContent: options?.messageContext },
          );

          this.logger.log(
            `Fusion decision for "${dto.value}": ${decision.action} (confidence: ${decision.confidence})`,
          );

          return this.factFusionService.applyDecision(
            dupResult.existingFact,
            dto,
            decision,
            entityId,
          );
        }

        // Fallback: simple skip (backward compatible)
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
      category: dto.category || FactCategory.PROFESSIONAL,
      value: dto.value,
      valueDate: dto.valueDate,
      valueJson: dto.valueJson,
      source: dto.source || FactSource.MANUAL,
      validFrom: new Date(),
    });

    // Generate embedding for the fact value
    let hasEmbedding = false;
    this.logger.debug(
      `Embedding generation check: value="${dto.value?.slice(0, 50)}", embeddingService=${!!this.embeddingService}`,
    );
    if (dto.value && this.embeddingService) {
      try {
        const embedding = await this.embeddingService.generate(dto.value);
        this.logger.debug(`Embedding generated: length=${embedding?.length}`);
        fact.embedding = embedding;
        hasEmbedding = true;
      } catch (error: any) {
        this.logger.warn(`Failed to generate embedding for fact: ${error.message}`);
        // Continue without embedding - fact will still be created
      }
    } else {
      this.logger.warn(
        `Skipping embedding: value=${!!dto.value}, embeddingService=${!!this.embeddingService}`,
      );
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

  /**
   * Find facts for an entity with rank-based ordering.
   * Returns preferred facts first, then normal, deprecated last (if included).
   */
  async findByEntityWithRanking(
    entityId: string,
    options: { includeDeprecated?: boolean; includeHistory?: boolean } = {},
  ): Promise<EntityFact[]> {
    const queryBuilder = this.factRepo
      .createQueryBuilder('fact')
      .where('fact.entityId = :entityId', { entityId });

    // Exclude deprecated unless requested
    if (!options.includeDeprecated) {
      queryBuilder.andWhere("fact.rank != 'deprecated'");
    }

    // Exclude historical facts unless requested
    if (!options.includeHistory) {
      queryBuilder.andWhere('fact.validUntil IS NULL');
    }

    // Order by rank priority: preferred > normal > deprecated
    queryBuilder.orderBy(
      `CASE fact.rank
        WHEN 'preferred' THEN 1
        WHEN 'normal' THEN 2
        WHEN 'deprecated' THEN 3
        ELSE 4
      END`,
      'ASC',
    );
    queryBuilder.addOrderBy('fact.factType', 'ASC');
    queryBuilder.addOrderBy('fact.createdAt', 'DESC');

    return queryBuilder.getMany();
  }

  /**
   * Find facts that need human review (conflicts).
   */
  async findPendingReview(options: { limit?: number } = {}): Promise<EntityFact[]> {
    return this.factRepo.find({
      where: {
        needsReview: true,
        validUntil: IsNull(),
      },
      relations: ['entity'],
      order: { createdAt: 'DESC' },
      take: options.limit || 50,
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

  /**
   * Find historical facts for an entity (facts with validUntil set).
   * Returns facts ordered by validUntil DESC (most recently expired first).
   */
  async findHistory(
    entityId: string,
    options?: { limit?: number },
  ): Promise<EntityFact[]> {
    return this.factRepo.find({
      where: {
        entityId,
        validUntil: Not(IsNull()),
      },
      order: { validUntil: 'DESC' },
      take: options?.limit ?? 10,
    });
  }

  /**
   * Get structured context for extraction.
   * Returns a formatted string with current facts and history.
   */
  async getContextForExtraction(entityId: string): Promise<string> {
    if (!this.entityService) {
      this.logger.warn('EntityService not available for context extraction');
      return '';
    }

    const entity = await this.entityService.findOne(entityId);
    if (!entity) {
      return '';
    }

    const currentFacts = await this.findByEntityWithRanking(entityId);
    const historyFacts = await this.findHistory(entityId, { limit: 10 });

    return this.formatStructuredContext(entity, currentFacts, historyFacts);
  }

  /**
   * Format entity facts into structured context for LLM.
   */
  private formatStructuredContext(
    entity: EntityRecord,
    current: EntityFact[],
    history: EntityFact[],
  ): string {
    const lines: string[] = [
      `ПАМЯТЬ О ${entity.name}:`,
      '━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ];

    // Current facts (preferred rank)
    const preferredFacts = current.filter((f) => f.rank === 'preferred');
    if (preferredFacts.length > 0) {
      lines.push('ФАКТЫ (текущие):');
      for (const fact of preferredFacts) {
        const since = fact.validFrom
          ? ` (с ${this.formatDate(fact.validFrom)})`
          : '';
        lines.push(`• ${fact.factType}: ${fact.value}${since}`);
      }
      lines.push('');
    }

    // Normal facts
    const normalFacts = current.filter((f) => f.rank === 'normal');
    if (normalFacts.length > 0) {
      if (preferredFacts.length === 0) {
        lines.push('ФАКТЫ:');
      }
      for (const fact of normalFacts) {
        const since = fact.validFrom
          ? ` (с ${this.formatDate(fact.validFrom)})`
          : '';
        lines.push(`• ${fact.factType}: ${fact.value}${since}`);
      }
      lines.push('');
    }

    // History
    if (history.length > 0) {
      lines.push('ИСТОРИЯ:');
      for (const fact of history) {
        const from = fact.validFrom ? this.formatDate(fact.validFrom) : '?';
        const until = fact.validUntil ? this.formatDate(fact.validUntil) : '?';
        lines.push(`• ${fact.factType}: ${fact.value} (${from} — ${until})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format date for display in context.
   */
  private formatDate(date: Date | null): string {
    if (!date) return '?';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }
}
