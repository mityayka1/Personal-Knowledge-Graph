import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull, In } from 'typeorm';
import { EntityFact, EntityRecord } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import { ModelType } from '../claude-agent/claude-agent.types';
import { ExtractedFact } from './daily-synthesis-extraction.types';

// ─── Interfaces ──────────────────────────────────────────────────────

export interface ReviewCandidate {
  /** Index of the new fact in the batch */
  index: number;
  /** Entity ID */
  entityId: string;
  /** New fact data */
  newFact: ExtractedFact;
  /** ID of the matched existing fact */
  matchedFactId: string;
  /** Cosine similarity score */
  similarity: number;
  /** Pre-computed embedding for reuse when saving */
  embedding?: number[];
}

export interface ReviewDecision {
  /** Index of the new fact in the batch */
  newFactIndex: number;
  /** skip = duplicate, create = unique new fact */
  action: 'skip' | 'create';
  /** Reason for the decision */
  reason: string;
  /** ID of the existing duplicate fact (when action = skip) */
  duplicateOfId?: string;
}

// ─── JSON Schema for structured output ───────────────────────────────

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          newFactIndex: { type: 'number', description: 'Index of the new fact from the list' },
          action: { type: 'string', enum: ['skip', 'create'], description: 'skip = duplicate, create = new unique fact' },
          reason: { type: 'string', description: 'Short explanation of the decision' },
          duplicateOfId: { type: 'string', description: 'ID of the existing duplicate fact (if action is skip)' },
        },
        required: ['newFactIndex', 'action', 'reason'],
      },
    },
  },
  required: ['decisions'],
};

// ─── LLM response type ──────────────────────────────────────────────

interface ReviewResponse {
  decisions: Array<{
    newFactIndex: number;
    action: 'skip' | 'create';
    reason: string;
    duplicateOfId?: string;
  }>;
}

// ─── Service ─────────────────────────────────────────────────────────

@Injectable()
export class FactDedupReviewService {
  private readonly logger = new Logger(FactDedupReviewService.name);

  constructor(
    @InjectRepository(EntityFact)
    private factRepo: Repository<EntityFact>,
    @InjectRepository(EntityRecord)
    private entityRepo: Repository<EntityRecord>,
    @Optional()
    @Inject(forwardRef(() => ClaudeAgentService))
    private claudeAgentService: ClaudeAgentService | null,
    private settingsService: SettingsService,
  ) {}

  /**
   * Review a batch of grey-zone candidates.
   * Groups candidates by entityId, calls LLM for each group.
   * Graceful degradation: if Claude is unavailable, all candidates get action: 'create'.
   */
  async reviewBatch(candidates: ReviewCandidate[]): Promise<ReviewDecision[]> {
    if (candidates.length === 0) {
      return [];
    }

    this.logger.log(`Starting LLM dedup review for ${candidates.length} candidate(s)`);

    // Graceful degradation: no Claude service available
    if (!this.claudeAgentService) {
      this.logger.warn(
        'ClaudeAgentService is not available, allowing all candidates as new facts',
      );
      return candidates.map((c) => ({
        newFactIndex: c.index,
        action: 'create' as const,
        reason: 'LLM review unavailable, allowing creation',
      }));
    }

    // Load dedup settings
    const { reviewModel } = await this.settingsService.getDedupSettings();

    // Group candidates by entityId
    const groupedByEntity = new Map<string, ReviewCandidate[]>();
    for (const candidate of candidates) {
      const group = groupedByEntity.get(candidate.entityId) || [];
      group.push(candidate);
      groupedByEntity.set(candidate.entityId, group);
    }

    this.logger.debug(
      `Grouped into ${groupedByEntity.size} entity group(s): ${[...groupedByEntity.entries()].map(([id, g]) => `${id.slice(0, 8)}...(${g.length})`).join(', ')}`,
    );

    // Process each entity group
    const allDecisions: ReviewDecision[] = [];

    for (const [entityId, entityCandidates] of groupedByEntity) {
      try {
        const decisions = await this.reviewEntityGroup(entityId, entityCandidates, reviewModel);
        allDecisions.push(...decisions);
      } catch (error: any) {
        this.logger.error(
          `LLM review failed for entity ${entityId}: ${error.message}`,
          error.stack,
        );
        // Graceful degradation: allow all candidates in this group
        const fallbackDecisions: ReviewDecision[] = entityCandidates.map((c) => ({
          newFactIndex: c.index,
          action: 'create' as const,
          reason: `LLM review failed: ${error.message}`,
        }));
        allDecisions.push(...fallbackDecisions);
      }
    }

    const skipCount = allDecisions.filter((d) => d.action === 'skip').length;
    const createCount = allDecisions.filter((d) => d.action === 'create').length;
    this.logger.log(
      `LLM dedup review complete: ${skipCount} duplicates skipped, ${createCount} new facts approved`,
    );

    return allDecisions;
  }

  /**
   * Review a group of candidates for a single entity.
   * Loads entity context and all existing facts, then calls Claude oneshot.
   */
  private async reviewEntityGroup(
    entityId: string,
    candidates: ReviewCandidate[],
    model: ModelType,
  ): Promise<ReviewDecision[]> {
    // Load entity info
    const entity = await this.entityRepo.findOne({
      where: { id: entityId },
      select: ['id', 'name', 'type'],
    });

    if (!entity) {
      this.logger.warn(`Entity ${entityId} not found, allowing all candidates`);
      return candidates.map((c) => ({
        newFactIndex: c.index,
        action: 'create' as const,
        reason: 'Entity not found, allowing creation',
      }));
    }

    // Load all active (non-deleted, non-expired) facts for this entity
    const existingFacts = await this.factRepo.find({
      where: {
        entityId,
        validUntil: IsNull(),
      },
      select: ['id', 'factType', 'value'],
      order: { createdAt: 'DESC' },
      take: 100,
    });

    // Load matched fact values in a single query
    const matchedFactIds = [...new Set(candidates.map((c) => c.matchedFactId))];
    const matchedFacts = matchedFactIds.length > 0
      ? await this.factRepo.find({
          where: { id: In(matchedFactIds) },
          select: ['id', 'factType', 'value'],
          withDeleted: true, // include soft-deleted in case matched fact was deleted
        })
      : [];

    const matchedFactMap = new Map(matchedFacts.map((f) => [f.id, f]));

    // Build candidate data for the prompt
    const candidateData = candidates.map((c) => {
      const matched = matchedFactMap.get(c.matchedFactId);
      return {
        index: c.index,
        factType: c.newFact.factType,
        value: c.newFact.value,
        similarity: c.similarity,
        matchedFactValue: matched?.value ?? '(not found)',
      };
    });

    // Build prompt
    const prompt = this.buildReviewPrompt(
      entity.name,
      entity.type,
      existingFacts.map((f) => ({
        id: f.id,
        factType: f.factType as string,
        value: f.value ?? '',
      })),
      candidateData,
    );

    // Call Claude oneshot
    const { data } = await this.claudeAgentService!.call<ReviewResponse>({
      mode: 'oneshot',
      taskType: 'fact_dedup_review',
      prompt,
      schema: REVIEW_SCHEMA,
      model,
    });

    // Map LLM decisions to ReviewDecision format
    const decisions: ReviewDecision[] = [];

    for (const candidate of candidates) {
      const llmDecision = data.decisions?.find(
        (d) => d.newFactIndex === candidate.index,
      );

      if (llmDecision) {
        decisions.push({
          newFactIndex: llmDecision.newFactIndex,
          action: llmDecision.action,
          reason: llmDecision.reason,
          duplicateOfId: llmDecision.action === 'skip'
            ? llmDecision.duplicateOfId || candidate.matchedFactId
            : undefined,
        });
      } else {
        // LLM did not return decision for this candidate — allow creation
        this.logger.warn(
          `LLM did not return decision for candidate index=${candidate.index}, allowing creation`,
        );
        decisions.push({
          newFactIndex: candidate.index,
          action: 'create',
          reason: 'LLM did not return decision for this fact',
        });
      }
    }

    return decisions;
  }

  /**
   * Build the review prompt for Claude.
   */
  private buildReviewPrompt(
    entityName: string,
    entityType: string,
    existingFacts: Array<{ id: string; factType: string; value: string }>,
    candidates: Array<{
      index: number;
      factType: string;
      value: string;
      similarity: number;
      matchedFactValue: string;
    }>,
  ): string {
    // Format existing facts
    const existingFactsBlock = existingFacts.length > 0
      ? existingFacts
          .map((f) => `- [${f.id}] ${f.factType}: "${f.value}"`)
          .join('\n')
      : '(нет фактов)';

    // Format candidates
    const candidatesBlock = candidates
      .map(
        (c) =>
          `- #${c.index}: тип="${c.factType}", значение="${c.value}"\n` +
          `  Ближайший совпавший факт: "${c.matchedFactValue}" (similarity: ${c.similarity.toFixed(3)})`,
      )
      .join('\n');

    return `Ты анализируешь факты о сущности "${entityName}" (тип: ${entityType}).

## Существующие факты в базе данных:
${existingFactsBlock}

## Новые факты для проверки:
${candidatesBlock}

## Задача:
Для каждого нового факта определи: это дубликат существующего или уникальный новый факт?

Примеры дубликатов:
- "ДР 15 марта 85го" и "день рождения 15.03.1985" -- ДУБЛИКАТ (одна дата, разный формат)
- "работает в Сбере" и "сотрудник Сбербанка" -- ДУБЛИКАТ (одна организация)
- "живёт в Мск" и "проживает в Москве" -- ДУБЛИКАТ (одно место)
- "CEO компании" и "генеральный директор" -- ДУБЛИКАТ (одна должность)

Примеры НЕ дубликатов:
- "день рождения 15.03.1985" и "возраст 40 лет" -- НЕ ДУБЛИКАТ (разные типы информации)
- "работает в Сбере" и "раньше работал в Яндексе" -- НЕ ДУБЛИКАТ (разные организации)
- "телефон +7 999 111 22 33" и "email user@mail.ru" -- НЕ ДУБЛИКАТ (разные типы контакта)

Верни решение для КАЖДОГО нового факта. Если факт является дубликатом, укажи ID существующего факта-дубликата в поле duplicateOfId.`;
  }
}
