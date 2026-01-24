import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, FactSource, FactCategory } from '@pkg/entities';
import { ClaudeAgentService } from '../../claude-agent/claude-agent.service';
import { EmbeddingService } from '../../embedding/embedding.service';
import { FactConflictService } from '../../notification/fact-conflict.service';
import { CreateFactDto } from '../dto/create-entity.dto';
import { CreateFactResult } from './entity-fact.service';
import {
  FusionAction,
  FusionDecision,
  FUSION_DECISION_SCHEMA,
  FUSION_CONFIDENCE_THRESHOLD,
  CONFIDENCE_INCREMENT_CONFIRM,
  CONFIDENCE_INCREMENT_ENRICH,
  DEFAULT_CONFIDENCE,
  FALLBACK_CONFIDENCE,
  FUSION_CACHE_MAX_SIZE,
  FUSION_CACHE_TTL_MS,
  buildFusionPrompt,
} from './fact-fusion.constants';

/**
 * Simple LRU cache entry for fusion decisions
 */
interface CacheEntry {
  decision: FusionDecision;
  timestamp: number;
}

@Injectable()
export class FactFusionService {
  private readonly logger = new Logger(FactFusionService.name);
  private readonly fusionCache = new Map<string, CacheEntry>();

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    @Optional()
    @Inject(EmbeddingService)
    private readonly embeddingService: EmbeddingService | null,
    @Optional()
    @Inject(forwardRef(() => FactConflictService))
    private readonly factConflictService: FactConflictService | null,
  ) {}

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Create and save a new fact entity from DTO with embedding (DRY helper)
   */
  private async createAndSaveFactFromDto(
    entityId: string,
    dto: CreateFactDto,
    rank: 'preferred' | 'normal',
  ): Promise<EntityFact> {
    const fact = this.factRepo.create({
      entityId,
      factType: dto.type,
      category: dto.category || FactCategory.PROFESSIONAL,
      value: dto.value,
      valueDate: dto.valueDate,
      valueJson: dto.valueJson,
      source: dto.source || FactSource.EXTRACTED,
      rank,
      validFrom: new Date(),
    });

    // Generate embedding for the fact value to enable future semantic matching
    if (dto.value && this.embeddingService) {
      try {
        const embedding = await this.embeddingService.generate(dto.value);
        fact.embedding = embedding;
        this.logger.debug(`Generated embedding for fusion fact: "${dto.value.slice(0, 50)}..."`);
      } catch (error: any) {
        this.logger.warn(`Failed to generate embedding for fusion fact: ${error.message}`);
        // Continue without embedding - fact will still be created
      }
    }

    return this.factRepo.save(fact);
  }

  /**
   * Parse confidence from entity (handles PostgreSQL decimal-as-string)
   */
  private parseConfidence(fact: EntityFact, fallback: number = FALLBACK_CONFIDENCE): number {
    const confidence = fact.confidence ? parseFloat(String(fact.confidence)) : fallback;
    return isNaN(confidence) ? fallback : confidence;
  }

  /**
   * Generate cache key for fusion decision
   */
  private getCacheKey(existingFactId: string, newFactValue: string): string {
    return `${existingFactId}:${newFactValue}`;
  }

  /**
   * Get cached decision if valid
   */
  private getCachedDecision(key: string): FusionDecision | null {
    const entry = this.fusionCache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.timestamp;
    if (age > FUSION_CACHE_TTL_MS) {
      this.fusionCache.delete(key);
      return null;
    }

    return entry.decision;
  }

  /**
   * Cache a fusion decision
   */
  private cacheDecision(key: string, decision: FusionDecision): void {
    // LRU eviction: remove oldest if cache is full
    if (this.fusionCache.size >= FUSION_CACHE_MAX_SIZE) {
      const oldestKey = this.fusionCache.keys().next().value;
      if (oldestKey) {
        this.fusionCache.delete(oldestKey);
      }
    }

    this.fusionCache.set(key, {
      decision,
      timestamp: Date.now(),
    });
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Use LLM to decide how to handle duplicate/similar facts.
   * Implements caching to avoid redundant LLM calls for identical fact pairs.
   */
  async decideFusion(
    existingFact: EntityFact,
    newFactValue: string,
    newFactSource: FactSource,
    context?: { messageContent?: string },
  ): Promise<FusionDecision> {
    // Check cache first
    const cacheKey = this.getCacheKey(existingFact.id, newFactValue);
    const cachedDecision = this.getCachedDecision(cacheKey);
    if (cachedDecision) {
      this.logger.debug(`Cache hit for fusion decision: ${cacheKey}`);
      return cachedDecision;
    }

    const prompt = buildFusionPrompt({
      existingFact: {
        factType: existingFact.factType,
        value: existingFact.value,
        source: existingFact.source,
        confidence: existingFact.confidence,
        createdAt: existingFact.createdAt,
      },
      newFactValue,
      newFactSource,
      messageContext: context?.messageContent,
    });

    try {
      const { data } = await this.claudeAgentService.call<FusionDecision>({
        mode: 'oneshot',
        taskType: 'fact_fusion',
        prompt,
        schema: FUSION_DECISION_SCHEMA,
        model: 'haiku', // Fast + cheap for decisions
        timeout: 30000,
      });

      this.logger.debug(
        `Fusion decision for "${newFactValue}": ${data.action} (confidence: ${data.confidence})`,
      );

      let decision = data;

      // If confidence is too low, escalate to CONFLICT
      if (data.confidence < FUSION_CONFIDENCE_THRESHOLD && data.action !== FusionAction.CONFLICT) {
        this.logger.warn(
          `Low confidence (${data.confidence}) for ${data.action}, escalating to CONFLICT`,
        );
        decision = {
          action: FusionAction.CONFLICT,
          explanation: `Низкая уверенность в решении (${data.confidence}). ${data.explanation}`,
          confidence: data.confidence,
        };
      }

      // Cache the decision
      this.cacheDecision(cacheKey, decision);
      return decision;
    } catch (error: any) {
      this.logger.error(`Fusion decision failed: ${error.message}`);
      // On error, be conservative and mark as conflict
      return {
        action: FusionAction.CONFLICT,
        explanation: `Ошибка при анализе: ${error.message}`,
        confidence: 0,
      };
    }
  }

  /**
   * Apply fusion decision to facts
   */
  async applyDecision(
    existingFact: EntityFact,
    newFactDto: CreateFactDto,
    decision: FusionDecision,
    entityId: string,
  ): Promise<CreateFactResult> {
    switch (decision.action) {
      case FusionAction.CONFIRM:
        return this.handleConfirm(existingFact, decision);

      case FusionAction.ENRICH:
        return this.handleEnrich(existingFact, decision);

      case FusionAction.SUPERSEDE:
        return this.handleSupersede(existingFact, newFactDto, entityId, decision);

      case FusionAction.COEXIST:
        return this.handleCoexist(existingFact, newFactDto, entityId, decision);

      case FusionAction.CONFLICT:
        return this.handleConflict(existingFact, newFactDto, decision, entityId);

      default:
        this.logger.warn(`Unknown fusion action: ${decision.action}`);
        return {
          fact: existingFact,
          action: 'skipped',
          reason: `Unknown action: ${decision.action}`,
          existingFactId: existingFact.id,
        };
    }
  }

  // ============================================
  // Fusion Action Handlers
  // ============================================

  /**
   * CONFIRM: Same information, increase confirmation count
   */
  private async handleConfirm(
    existingFact: EntityFact,
    decision: FusionDecision,
  ): Promise<CreateFactResult> {
    const currentConfidence = this.parseConfidence(existingFact, DEFAULT_CONFIDENCE);

    await this.factRepo.update(existingFact.id, {
      confirmationCount: existingFact.confirmationCount + 1,
      confidence: Math.min(1, currentConfidence + CONFIDENCE_INCREMENT_CONFIRM),
    });

    const updatedFact = await this.factRepo.findOne({ where: { id: existingFact.id } });

    return {
      fact: updatedFact || existingFact,
      action: 'updated',
      reason: `CONFIRM: ${decision.explanation}. Подтверждений: ${(existingFact.confirmationCount || 1) + 1}`,
      existingFactId: existingFact.id,
    };
  }

  /**
   * ENRICH: Merge values into richer fact
   */
  private async handleEnrich(
    existingFact: EntityFact,
    decision: FusionDecision,
  ): Promise<CreateFactResult> {
    if (!decision.mergedValue) {
      this.logger.warn('ENRICH decision without mergedValue, using existing');
      return {
        fact: existingFact,
        action: 'skipped',
        reason: 'ENRICH без mergedValue',
        existingFactId: existingFact.id,
      };
    }

    const currentConfidence = this.parseConfidence(existingFact, FALLBACK_CONFIDENCE);

    await this.factRepo.update(existingFact.id, {
      value: decision.mergedValue,
      confirmationCount: existingFact.confirmationCount + 1,
      confidence: Math.min(1, currentConfidence + CONFIDENCE_INCREMENT_ENRICH),
    });

    const updatedFact = await this.factRepo.findOne({ where: { id: existingFact.id } });

    return {
      fact: updatedFact || existingFact,
      action: 'updated',
      reason: `ENRICH: ${decision.explanation}. Было: "${existingFact.value}" → Стало: "${decision.mergedValue}"`,
      existingFactId: existingFact.id,
    };
  }

  /**
   * SUPERSEDE: Deprecate old, create new as preferred
   */
  private async handleSupersede(
    existingFact: EntityFact,
    newFactDto: CreateFactDto,
    entityId: string,
    decision: FusionDecision,
  ): Promise<CreateFactResult> {
    // Create and save new fact with embedding
    const savedNewFact = await this.createAndSaveFactFromDto(entityId, newFactDto, 'preferred');

    // Deprecate old fact
    await this.factRepo.update(existingFact.id, {
      rank: 'deprecated',
      validUntil: new Date(),
      supersededById: savedNewFact.id,
    });

    return {
      fact: savedNewFact,
      action: 'created',
      reason: `SUPERSEDE: ${decision.explanation}. Старый факт "${existingFact.value}" помечен deprecated.`,
      existingFactId: existingFact.id,
    };
  }

  /**
   * COEXIST: Keep both facts (different time periods or both valid)
   */
  private async handleCoexist(
    existingFact: EntityFact,
    newFactDto: CreateFactDto,
    entityId: string,
    decision: FusionDecision,
  ): Promise<CreateFactResult> {
    // Create and save new fact with embedding (without deprecating old)
    const savedNewFact = await this.createAndSaveFactFromDto(entityId, newFactDto, 'normal');

    return {
      fact: savedNewFact,
      action: 'created',
      reason: `COEXIST: ${decision.explanation}. Оба факта сохранены.`,
      existingFactId: existingFact.id,
    };
  }

  /**
   * CONFLICT: Mark for human review and send Telegram notification
   */
  private async handleConflict(
    existingFact: EntityFact,
    newFactDto: CreateFactDto,
    decision: FusionDecision,
    entityId?: string,
  ): Promise<CreateFactResult> {
    // Mark existing fact as needing review
    await this.factRepo.update(existingFact.id, {
      needsReview: true,
      reviewReason: `Конфликт с новым фактом: "${newFactDto.value}". ${decision.explanation}`,
    });

    const updatedFact = await this.factRepo.findOne({ where: { id: existingFact.id } });

    // Send Telegram notification if service is available
    if (this.factConflictService && entityId) {
      try {
        await this.factConflictService.notifyConflict(
          existingFact,
          newFactDto,
          entityId,
          decision.explanation,
        );
        this.logger.log(`Sent fact conflict notification for fact ${existingFact.id}`);
      } catch (error: any) {
        this.logger.warn(`Failed to send conflict notification: ${error.message}`);
      }
    }

    return {
      fact: updatedFact || existingFact,
      action: 'skipped',
      reason: `CONFLICT: ${decision.explanation}. Требуется проверка.`,
      existingFactId: existingFact.id,
      needsReview: true,
      newFactData: newFactDto,
    };
  }
}
