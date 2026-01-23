import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, FactSource } from '@pkg/entities';
import { ClaudeAgentService } from '../../claude-agent/claude-agent.service';
import { FactConflictService } from '../../notification/fact-conflict.service';
import { CreateFactDto } from '../dto/create-entity.dto';
import { CreateFactResult } from './entity-fact.service';
import {
  FusionAction,
  FusionDecision,
  FUSION_DECISION_SCHEMA,
  FUSION_CONFIDENCE_THRESHOLD,
  buildFusionPrompt,
} from './fact-fusion.constants';

@Injectable()
export class FactFusionService {
  private readonly logger = new Logger(FactFusionService.name);

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    @Optional()
    @Inject(forwardRef(() => FactConflictService))
    private readonly factConflictService: FactConflictService | null,
  ) {}

  /**
   * Use LLM to decide how to handle duplicate/similar facts
   */
  async decideFusion(
    existingFact: EntityFact,
    newFactValue: string,
    newFactSource: FactSource,
    context?: { messageContent?: string },
  ): Promise<FusionDecision> {
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

      // If confidence is too low, escalate to CONFLICT
      if (data.confidence < FUSION_CONFIDENCE_THRESHOLD && data.action !== FusionAction.CONFLICT) {
        this.logger.warn(
          `Low confidence (${data.confidence}) for ${data.action}, escalating to CONFLICT`,
        );
        return {
          action: FusionAction.CONFLICT,
          explanation: `Низкая уверенность в решении (${data.confidence}). ${data.explanation}`,
          confidence: data.confidence,
        };
      }

      return data;
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

  /**
   * CONFIRM: Same information, increase confirmation count
   */
  private async handleConfirm(
    existingFact: EntityFact,
    decision: FusionDecision,
  ): Promise<CreateFactResult> {
    // Parse confidence as number (PostgreSQL returns decimal as string)
    const currentConfidence = existingFact.confidence
      ? parseFloat(String(existingFact.confidence))
      : null;

    await this.factRepo.update(existingFact.id, {
      confirmationCount: existingFact.confirmationCount + 1,
      // Optionally increase confidence
      confidence: currentConfidence !== null && !isNaN(currentConfidence)
        ? Math.min(1, currentConfidence + 0.05)
        : 0.85,
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

    // Parse confidence as number (PostgreSQL returns decimal as string)
    const currentConfidence = existingFact.confidence
      ? parseFloat(String(existingFact.confidence))
      : 0.7;

    await this.factRepo.update(existingFact.id, {
      value: decision.mergedValue,
      confirmationCount: existingFact.confirmationCount + 1,
      confidence: Math.min(1, (isNaN(currentConfidence) ? 0.7 : currentConfidence) + 0.1),
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
    // Create new fact first
    const newFact = this.factRepo.create({
      entityId,
      factType: newFactDto.type,
      category: newFactDto.category,
      value: newFactDto.value,
      valueDate: newFactDto.valueDate,
      valueJson: newFactDto.valueJson,
      source: newFactDto.source || FactSource.EXTRACTED,
      rank: 'preferred',
      validFrom: new Date(),
    });

    const savedNewFact = await this.factRepo.save(newFact);

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
    // Create new fact without deprecating old
    const newFact = this.factRepo.create({
      entityId,
      factType: newFactDto.type,
      category: newFactDto.category,
      value: newFactDto.value,
      valueDate: newFactDto.valueDate,
      valueJson: newFactDto.valueJson,
      source: newFactDto.source || FactSource.EXTRACTED,
      rank: 'normal',
      validFrom: new Date(),
    });

    const savedNewFact = await this.factRepo.save(newFact);

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
