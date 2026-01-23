import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityFact, EntityRecord, FactSource } from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { DigestActionStoreService } from './digest-action-store.service';
import { CreateFactDto } from '../entity/dto/create-entity.dto';

/**
 * Resolution options for fact conflicts
 */
export type FactConflictResolution = 'new' | 'old' | 'both';

/**
 * Data stored in Redis for conflict resolution
 */
export interface FactConflictData {
  existingFactId: string;
  newFactData: CreateFactDto;
  entityId: string;
  entityName: string;
}

/**
 * Result of conflict resolution
 */
export interface FactConflictResolutionResult {
  success: boolean;
  action: 'used_new' | 'kept_old' | 'created_both';
  factId?: string;
  error?: string;
}

/**
 * Service for handling fact conflicts via Telegram notifications.
 *
 * When FactFusionService detects a CONFLICT (contradictory facts that need human review),
 * this service sends a Telegram notification with buttons for resolution.
 *
 * Callback format:
 * - fact_new:<shortId>  → Use new fact, deprecate old
 * - fact_old:<shortId>  → Keep old fact, reject new
 * - fact_both:<shortId> → Keep both facts (COEXIST)
 */
@Injectable()
export class FactConflictService {
  private readonly logger = new Logger(FactConflictService.name);

  constructor(
    private readonly telegramNotifier: TelegramNotifierService,
    private readonly digestActionStore: DigestActionStoreService,
    @InjectRepository(EntityFact)
    private readonly factRepo: Repository<EntityFact>,
    @InjectRepository(EntityRecord)
    private readonly entityRepo: Repository<EntityRecord>,
  ) {}

  /**
   * Send Telegram notification about fact conflict.
   * Returns shortId for callback resolution.
   */
  async notifyConflict(
    existingFact: EntityFact,
    newFactData: CreateFactDto,
    entityId: string,
    explanation: string,
    sourceMessageLink?: string,
  ): Promise<string> {
    // Get entity name
    const entity = await this.entityRepo.findOne({ where: { id: entityId } });
    const entityName = entity?.name || 'Неизвестный контакт';

    // Store conflict data in Redis
    const conflictData: FactConflictData = {
      existingFactId: existingFact.id,
      newFactData,
      entityId,
      entityName,
    };

    const shortId = await this.digestActionStore.store([JSON.stringify(conflictData)]);

    // Format notification message
    const message = this.formatConflictMessage(
      existingFact,
      newFactData,
      entityName,
      explanation,
      sourceMessageLink,
    );

    // Create inline buttons
    const buttons = [
      [
        { text: '✅ Новый', callback_data: `fact_new:${shortId}` },
        { text: '❌ Старый', callback_data: `fact_old:${shortId}` },
        { text: '🔀 Оба', callback_data: `fact_both:${shortId}` },
      ],
    ];

    // Send notification
    const sent = await this.telegramNotifier.sendWithButtons(message, buttons, 'HTML');

    if (sent) {
      this.logger.log(`Sent fact conflict notification for entity ${entityId}, shortId: ${shortId}`);
    } else {
      this.logger.warn(`Failed to send fact conflict notification for entity ${entityId}`);
    }

    return shortId;
  }

  /**
   * Resolve conflict based on user's choice.
   */
  async resolveConflict(
    shortId: string,
    resolution: FactConflictResolution,
  ): Promise<FactConflictResolutionResult> {
    // Get stored data
    const storedData = await this.digestActionStore.get(shortId);
    if (!storedData || storedData.length === 0) {
      this.logger.warn(`Conflict data not found for shortId: ${shortId}`);
      return { success: false, action: 'kept_old', error: 'Данные не найдены или устарели' };
    }

    let conflictData: FactConflictData;
    try {
      conflictData = JSON.parse(storedData[0]) as FactConflictData;
    } catch (error) {
      this.logger.error(`Failed to parse conflict data: ${shortId}`);
      return { success: false, action: 'kept_old', error: 'Ошибка данных' };
    }

    const existingFact = await this.factRepo.findOne({
      where: { id: conflictData.existingFactId },
    });

    if (!existingFact) {
      this.logger.warn(`Existing fact not found: ${conflictData.existingFactId}`);
      return { success: false, action: 'kept_old', error: 'Факт не найден' };
    }

    try {
      let result: FactConflictResolutionResult;

      switch (resolution) {
        case 'new':
          result = await this.applyNewFact(existingFact, conflictData);
          break;
        case 'old':
          result = await this.keepOldFact(existingFact);
          break;
        case 'both':
          result = await this.keepBothFacts(existingFact, conflictData);
          break;
        default:
          result = { success: false, action: 'kept_old', error: 'Неизвестное действие' };
      }

      // Delete stored data after resolution
      await this.digestActionStore.delete(shortId);

      return result;
    } catch (error: any) {
      this.logger.error(`Failed to resolve conflict ${shortId}: ${error.message}`);
      return { success: false, action: 'kept_old', error: error.message };
    }
  }

  /**
   * Use new fact, deprecate old
   */
  private async applyNewFact(
    existingFact: EntityFact,
    conflictData: FactConflictData,
  ): Promise<FactConflictResolutionResult> {
    const { newFactData, entityId } = conflictData;

    // Create new fact as preferred
    const newFact = this.factRepo.create({
      entityId,
      factType: newFactData.type,
      category: newFactData.category,
      value: newFactData.value,
      valueDate: newFactData.valueDate,
      valueJson: newFactData.valueJson,
      source: newFactData.source || FactSource.EXTRACTED,
      rank: 'preferred',
      validFrom: new Date(),
    });

    const savedNewFact = await this.factRepo.save(newFact);

    // Deprecate old fact
    await this.factRepo.update(existingFact.id, {
      rank: 'deprecated',
      validUntil: new Date(),
      supersededById: savedNewFact.id,
      needsReview: false,
      reviewReason: null,
    });

    this.logger.log(
      `Resolved conflict: used new fact ${savedNewFact.id}, deprecated ${existingFact.id}`,
    );

    return {
      success: true,
      action: 'used_new',
      factId: savedNewFact.id,
    };
  }

  /**
   * Keep old fact, reject new
   */
  private async keepOldFact(existingFact: EntityFact): Promise<FactConflictResolutionResult> {
    // Clear review flag and increase confirmation count
    await this.factRepo.update(existingFact.id, {
      needsReview: false,
      reviewReason: null,
      confirmationCount: (existingFact.confirmationCount || 1) + 1,
    });

    this.logger.log(`Resolved conflict: kept old fact ${existingFact.id}`);

    return {
      success: true,
      action: 'kept_old',
      factId: existingFact.id,
    };
  }

  /**
   * Keep both facts (COEXIST - different time periods or both valid)
   */
  private async keepBothFacts(
    existingFact: EntityFact,
    conflictData: FactConflictData,
  ): Promise<FactConflictResolutionResult> {
    const { newFactData, entityId } = conflictData;

    // Clear review flag on existing
    await this.factRepo.update(existingFact.id, {
      needsReview: false,
      reviewReason: null,
    });

    // Create new fact as normal (not deprecating old)
    const newFact = this.factRepo.create({
      entityId,
      factType: newFactData.type,
      category: newFactData.category,
      value: newFactData.value,
      valueDate: newFactData.valueDate,
      valueJson: newFactData.valueJson,
      source: newFactData.source || FactSource.EXTRACTED,
      rank: 'normal',
      validFrom: new Date(),
    });

    const savedNewFact = await this.factRepo.save(newFact);

    this.logger.log(
      `Resolved conflict: kept both facts ${existingFact.id} and ${savedNewFact.id}`,
    );

    return {
      success: true,
      action: 'created_both',
      factId: savedNewFact.id,
    };
  }

  /**
   * Format conflict notification message
   */
  private formatConflictMessage(
    existingFact: EntityFact,
    newFactData: CreateFactDto,
    entityName: string,
    explanation: string,
    sourceMessageLink?: string,
  ): string {
    const existingDate = existingFact.createdAt
      ? new Date(existingFact.createdAt).toLocaleDateString('ru-RU')
      : 'неизвестно';

    const newDate = new Date().toLocaleDateString('ru-RU');

    let message = `⚠️ <b>Конфликт фактов</b>\n\n`;
    message += `👤 <b>${this.escapeHtml(entityName)}</b>\n`;
    message += `📋 Тип: <code>${this.escapeHtml(existingFact.factType)}</code>\n\n`;

    message += `<b>Существующий:</b>\n`;
    message += `"${this.escapeHtml(existingFact.value || '')}"`;
    if (existingFact.source) {
      message += ` <i>(${this.getSourceLabel(existingFact.source)})</i>`;
    }
    message += `\n📅 Добавлен: ${existingDate}\n\n`;

    message += `<b>Новый:</b>\n`;
    message += `"${this.escapeHtml(newFactData.value || '')}"`;
    if (newFactData.source) {
      message += ` <i>(${this.getSourceLabel(newFactData.source)})</i>`;
    }
    message += `\n📅 Извлечён: ${newDate}`;

    if (sourceMessageLink) {
      message += `\n💬 <a href="${sourceMessageLink}">Из сообщения</a>`;
    }

    if (explanation) {
      message += `\n\n💡 ${this.escapeHtml(explanation)}`;
    }

    message += `\n\n<i>Какой факт корректен?</i>`;

    return message;
  }

  /**
   * Get human-readable source label
   */
  private getSourceLabel(source: FactSource): string {
    switch (source) {
      case FactSource.MANUAL:
        return 'вручную';
      case FactSource.EXTRACTED:
        return 'извлечено';
      case FactSource.IMPORTED:
        return 'импортировано';
      default:
        return source;
    }
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
