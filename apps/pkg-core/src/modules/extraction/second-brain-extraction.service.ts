import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { EnrichmentQueueService } from './enrichment-queue.service';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
  ExtractedEventData,
  MeetingEventData,
  PromiseEventData,
  TaskEventData,
  FactEventData,
  CancellationEventData,
} from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Raw event extracted by LLM
 */
interface RawExtractedEvent {
  type: string;
  confidence: number;
  data: Record<string, unknown>;
  sourceQuote?: string;
  /** True if event is abstract and needs context enrichment */
  needsEnrichment?: boolean;
}

/**
 * JSON Schema for Second Brain event extraction
 * Extracts: meetings, promises (by me/them), tasks, facts, cancellations
 */
const SECOND_BRAIN_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      description: 'Array of extracted events from the message',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['meeting', 'promise_by_me', 'promise_by_them', 'task', 'fact', 'cancellation'],
            description: 'Event type',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Confidence score 0.0-1.0',
          },
          sourceQuote: {
            type: 'string',
            description: 'Original text fragment that triggered extraction',
          },
          data: {
            type: 'object',
            description: 'Event-specific data (see type descriptions)',
            additionalProperties: true,
          },
          needsEnrichment: {
            type: 'boolean',
            description:
              'True if the event is abstract/vague and needs context enrichment from history. ' +
              'Examples: "приступлю к задаче" (which task?), "созвонимся по нашему вопросу" (what question?)',
          },
        },
        required: ['type', 'confidence', 'data'],
      },
    },
  },
  required: ['events'],
};

interface ExtractionResponse {
  events: RawExtractedEvent[];
}

export interface SecondBrainExtractionResult {
  sourceMessageId: string;
  extractedEvents: ExtractedEvent[];
  tokensUsed: number;
}

/**
 * Service for extracting events from messages for the Second Brain feature.
 *
 * Unlike EventExtractionService which creates EntityEvent directly,
 * this service creates ExtractedEvent records that require user confirmation
 * before being converted to EntityEvent or EntityFact.
 */
@Injectable()
export class SecondBrainExtractionService {
  private readonly logger = new Logger(SecondBrainExtractionService.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    private claudeAgentService: ClaudeAgentService,
    private settingsService: SettingsService,
    @Optional()
    private enrichmentQueueService: EnrichmentQueueService | null,
  ) {}

  /**
   * Extract events from a single message
   */
  async extractFromMessage(params: {
    messageId: string;
    messageContent: string;
    interactionId?: string;
    entityId?: string;
    entityName: string;
    isOutgoing: boolean;
    /** Content of the message this message is replying to (for context) */
    replyToContent?: string;
    /** Forum topic name (if message is from a forum topic) */
    topicName?: string;
    /** Name of the sender of the replied-to message */
    replyToSenderName?: string;
    /**
     * Entity ID of who the promise was made to.
     * For private chats: the other participant.
     * For group chats with reply: sender of replied message.
     */
    promiseToEntityId?: string;
  }): Promise<SecondBrainExtractionResult> {
    const {
      messageId,
      messageContent,
      interactionId,
      entityId,
      entityName,
      isOutgoing,
      replyToContent,
      topicName,
      replyToSenderName,
      promiseToEntityId,
    } = params;

    // Get settings for extraction
    const settings = await this.settingsService.getExtractionSettings();

    // Skip very short messages
    if (messageContent.length < settings.minMessageLength) {
      return { sourceMessageId: messageId, extractedEvents: [], tokensUsed: 0 };
    }

    const prompt = this.buildPrompt(
      entityName,
      messageContent,
      isOutgoing,
      settings.maxContentLength,
      replyToContent,
      topicName,
      replyToSenderName,
    );

    try {
      const { data, usage } = await this.claudeAgentService.call<ExtractionResponse>({
        mode: 'oneshot',
        taskType: 'event_extraction',
        prompt,
        schema: SECOND_BRAIN_EXTRACTION_SCHEMA,
        model: 'haiku', // Fast and cheap for extraction
        referenceType: 'message',
        referenceId: messageId,
        timeout: 60000,
      });

      const rawEvents = data.events || [];
      const savedEvents: ExtractedEvent[] = [];

      for (const rawEvent of rawEvents) {
        // Skip low confidence
        if (rawEvent.confidence < settings.minConfidence) {
          continue;
        }

        const eventType = this.mapEventType(rawEvent.type);
        if (!eventType) {
          this.logger.warn(`Unknown event type: ${rawEvent.type}`);
          continue;
        }

        const extractedData = this.normalizeEventData(eventType, rawEvent.data);

        try {
          // Prepare enrichment data if event needs context enrichment
          const enrichmentData = rawEvent.needsEnrichment
            ? {
                needsEnrichment: true,
                enrichmentSuccess: false,
                enrichedAt: undefined,
              }
            : null;

          // Determine promiseToEntityId for promise_by_me events from outgoing messages
          // Note: PROMISE_BY_THEM should never appear in outgoing messages (isOutgoing=true)
          // because promise type is determined by message author, not message content
          const shouldSetPromiseTo =
            isOutgoing &&
            promiseToEntityId &&
            eventType === ExtractedEventType.PROMISE_BY_ME;

          // Log warning if LLM incorrectly returns PROMISE_BY_THEM for outgoing message
          if (isOutgoing && eventType === ExtractedEventType.PROMISE_BY_THEM) {
            this.logger.warn(
              `LLM bug: PROMISE_BY_THEM extracted from outgoing message ${messageId}. ` +
                `Promise type should be determined by isOutgoing flag, not message content.`,
            );
          }

          const event = this.extractedEventRepo.create({
            sourceMessageId: messageId,
            sourceInteractionId: interactionId || null,
            entityId: entityId || null,
            promiseToEntityId: shouldSetPromiseTo ? promiseToEntityId : null,
            eventType,
            extractedData,
            sourceQuote: rawEvent.sourceQuote?.substring(0, settings.maxQuoteLength) || null,
            confidence: Math.min(1, Math.max(0, rawEvent.confidence)),
            status: ExtractedEventStatus.PENDING,
            // New context-aware fields
            needsContext: false, // Will be set to true after enrichment if context not found
            enrichmentData,
          });

          const saved = await this.extractedEventRepo.save(event);
          savedEvents.push(saved);

          // Queue for enrichment if event needs context
          if (rawEvent.needsEnrichment && this.enrichmentQueueService) {
            try {
              await this.enrichmentQueueService.queueForEnrichment(saved.id);
              this.logger.debug(`Queued event ${saved.id} for context enrichment`);
            } catch (queueError) {
              this.logger.warn(`Failed to queue event for enrichment: ${queueError}`);
            }
          }
        } catch (saveError) {
          const msg = saveError instanceof Error ? saveError.message : String(saveError);
          this.logger.warn(`Failed to save extracted event: ${msg}`);
        }
      }

      this.logger.log(
        `Extracted ${savedEvents.length} events from message ${messageId} (${entityName})`,
      );

      return {
        sourceMessageId: messageId,
        extractedEvents: savedEvents,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Event extraction failed for message ${messageId}: ${message}`);
      return { sourceMessageId: messageId, extractedEvents: [], tokensUsed: 0 };
    }
  }

  /**
   * Batch extract events from multiple messages
   */
  async extractFromMessages(
    messages: Array<{
      messageId: string;
      messageContent: string;
      interactionId?: string;
      entityId?: string;
      entityName: string;
      isOutgoing: boolean;
      replyToContent?: string;
      topicName?: string;
      replyToSenderName?: string;
      replyToSenderId?: string;
      promiseToEntityId?: string;
    }>,
  ): Promise<SecondBrainExtractionResult[]> {
    const results: SecondBrainExtractionResult[] = [];

    for (const msg of messages) {
      const result = await this.extractFromMessage(msg);
      results.push(result);
    }

    return results;
  }

  /**
   * Get pending events for notification
   */
  async getPendingEvents(limit = 20): Promise<ExtractedEvent[]> {
    return this.extractedEventRepo.find({
      where: {
        status: ExtractedEventStatus.PENDING,
      },
      order: { createdAt: 'DESC' },
      take: limit,
      relations: ['sourceMessage'],
    });
  }

  /**
   * Get pending events that haven't been notified yet
   */
  async getUnnotifiedPendingEvents(limit = 10): Promise<ExtractedEvent[]> {
    return this.extractedEventRepo
      .createQueryBuilder('event')
      .where('event.status = :status', { status: ExtractedEventStatus.PENDING })
      .andWhere('event.notificationSentAt IS NULL')
      .orderBy('event.createdAt', 'ASC')
      .take(limit)
      .getMany();
  }

  /**
   * Mark event as notified
   */
  async markAsNotified(eventId: string): Promise<void> {
    await this.extractedEventRepo.update(eventId, {
      notificationSentAt: new Date(),
    });
  }

  /**
   * Confirm event (will trigger creation of EntityEvent or EntityFact)
   */
  async confirmEvent(
    eventId: string,
    resultEntityType: 'EntityEvent' | 'EntityFact',
    resultEntityId: string,
  ): Promise<ExtractedEvent> {
    await this.extractedEventRepo.update(eventId, {
      status: ExtractedEventStatus.CONFIRMED,
      resultEntityType,
      resultEntityId,
      userResponseAt: new Date(),
    });

    return this.extractedEventRepo.findOneOrFail({ where: { id: eventId } });
  }

  /**
   * Reject event
   */
  async rejectEvent(eventId: string): Promise<ExtractedEvent> {
    await this.extractedEventRepo.update(eventId, {
      status: ExtractedEventStatus.REJECTED,
      userResponseAt: new Date(),
    });

    return this.extractedEventRepo.findOneOrFail({ where: { id: eventId } });
  }

  /**
   * Auto-process high confidence events
   * @param threshold - Override threshold (default from settings: extraction.autoSaveThreshold)
   */
  async autoProcessHighConfidence(threshold?: number): Promise<number> {
    const settings = await this.settingsService.getExtractionSettings();
    const effectiveThreshold = threshold ?? settings.autoSaveThreshold;

    const result = await this.extractedEventRepo.update(
      {
        status: ExtractedEventStatus.PENDING,
        confidence: MoreThanOrEqual(effectiveThreshold),
      },
      {
        status: ExtractedEventStatus.AUTO_PROCESSED,
      },
    );

    return result.affected || 0;
  }

  /**
   * Expire old pending events
   * @param olderThanDays - Override days (default from settings: notification.expirationDays)
   */
  async expireOldEvents(olderThanDays?: number): Promise<number> {
    const notificationSettings = await this.settingsService.getNotificationSettings();
    const days = olderThanDays ?? notificationSettings.expirationDays;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const result = await this.extractedEventRepo
      .createQueryBuilder()
      .update()
      .set({ status: ExtractedEventStatus.EXPIRED })
      .where('status = :status', { status: ExtractedEventStatus.PENDING })
      .andWhere('createdAt < :cutoff', { cutoff: cutoffDate })
      .execute();

    return result.affected || 0;
  }

  /**
   * Get event by ID
   */
  async getById(eventId: string): Promise<ExtractedEvent | null> {
    return this.extractedEventRepo.findOne({ where: { id: eventId } });
  }

  /**
   * Get events that need context enrichment
   * These are events marked with needsEnrichment=true in enrichmentData
   * but haven't been enriched yet (enrichmentData.enrichedAt is null)
   */
  async getEventsNeedingEnrichment(limit = 10): Promise<ExtractedEvent[]> {
    return this.extractedEventRepo
      .createQueryBuilder('event')
      .where('event.status = :status', { status: ExtractedEventStatus.PENDING })
      .andWhere("event.enrichment_data->>'needsEnrichment' = 'true'")
      .andWhere("event.enrichment_data->>'enrichedAt' IS NULL")
      .orderBy('event.createdAt', 'ASC')
      .take(limit)
      .getMany();
  }

  /**
   * Update enrichment data for an event
   */
  async updateEnrichmentData(
    eventId: string,
    enrichmentData: Record<string, unknown>,
  ): Promise<void> {
    await this.extractedEventRepo.update(eventId, { enrichmentData });
  }

  /**
   * Mark event as needing context (enrichment failed to find context)
   */
  async markNeedsContext(eventId: string): Promise<void> {
    await this.extractedEventRepo.update(eventId, { needsContext: true });
  }

  /**
   * Link event to another event (enrichment found related event)
   */
  async linkToEvent(eventId: string, linkedEventId: string): Promise<void> {
    await this.extractedEventRepo.update(eventId, {
      linkedEventId,
      needsContext: false,
    });
  }

  /**
   * Map string type to enum
   */
  private mapEventType(type: string): ExtractedEventType | null {
    const typeMap: Record<string, ExtractedEventType> = {
      meeting: ExtractedEventType.MEETING,
      promise_by_me: ExtractedEventType.PROMISE_BY_ME,
      promise_by_them: ExtractedEventType.PROMISE_BY_THEM,
      task: ExtractedEventType.TASK,
      fact: ExtractedEventType.FACT,
      cancellation: ExtractedEventType.CANCELLATION,
    };

    const normalized = String(type).toLowerCase().replace('-', '_');
    return typeMap[normalized] || null;
  }

  /**
   * Normalize event data based on type
   */
  private normalizeEventData(
    type: ExtractedEventType,
    data: Record<string, unknown>,
  ): ExtractedEventData {
    switch (type) {
      case ExtractedEventType.MEETING:
        return {
          datetime: data.datetime as string | undefined,
          dateText: data.dateText as string | undefined,
          topic: data.topic as string | undefined,
          participants: data.participants as string[] | undefined,
        } as MeetingEventData;

      case ExtractedEventType.PROMISE_BY_ME:
      case ExtractedEventType.PROMISE_BY_THEM:
        return {
          what: String(data.what || data.description || ''),
          deadline: data.deadline as string | undefined,
          deadlineText: data.deadlineText as string | undefined,
        } as PromiseEventData;

      case ExtractedEventType.TASK:
        return {
          what: String(data.what || data.description || ''),
          priority: data.priority as 'low' | 'normal' | 'high' | 'urgent' | undefined,
          deadline: data.deadline as string | undefined,
          deadlineText: data.deadlineText as string | undefined,
        } as TaskEventData;

      case ExtractedEventType.FACT:
        return {
          factType: String(data.factType || data.type || 'other'),
          value: String(data.value || ''),
          quote: String(data.quote || data.sourceQuote || ''),
        } as FactEventData;

      case ExtractedEventType.CANCELLATION:
        return {
          what: String(data.what || data.description || ''),
          newDateTime: data.newDateTime as string | undefined,
          newDateText: data.newDateText as string | undefined,
          reason: data.reason as string | undefined,
        } as CancellationEventData;

      default:
        return data as ExtractedEventData;
    }
  }

  /**
   * Build extraction prompt
   */
  private buildPrompt(
    entityName: string,
    content: string,
    isOutgoing: boolean,
    maxContentLength: number = 1000,
    replyToContent?: string,
    topicName?: string,
    replyToSenderName?: string,
  ): string {
    const sender = isOutgoing ? 'я (пользователь)' : entityName;
    const cleanContent = content.replace(/\n/g, ' ').substring(0, maxContentLength);
    const today = new Date().toISOString().split('T')[0];

    // Build topic context section if available
    let topicContext = '';
    if (topicName) {
      topicContext = `
ТЕМА ФОРУМА: "${topicName}"
Это сообщение из форумного чата в теме "${topicName}". Учитывай это при анализе контекста.

`;
    }

    // Build reply context section if available
    let replyContext = '';
    if (replyToContent) {
      const cleanReplyContent = replyToContent.replace(/\n/g, ' ').substring(0, 500);
      const replyAuthor = replyToSenderName || 'неизвестно';
      replyContext = `
КОНТЕКСТ (сообщение на которое отвечают):
Автор: ${replyAuthor}
"${cleanReplyContent}"

`;
    }

    // Build recipient context for outgoing messages
    let recipientContext = '';
    if (isOutgoing && replyToSenderName) {
      recipientContext = `Адресат (кому отвечаю): ${replyToSenderName}
`;
    }

    return `Проанализируй сообщение и извлеки события для "второй памяти".
${topicContext}${replyContext}
Собеседник: ${entityName}
Автор сообщения: ${sender}
${recipientContext}Сегодня: ${today}

Сообщение: "${cleanContent}"

═══════════════════════════════════════════════════════════════
КРИТИЧЕСКОЕ ПРАВИЛО ДЛЯ ОБЕЩАНИЙ (promise_by_me / promise_by_them):
═══════════════════════════════════════════════════════════════
Тип обещания определяется ТОЛЬКО по автору сообщения, НЕ по тексту!

• Автор = "я (пользователь)" → ВСЕ обещания в сообщении = promise_by_me
• Автор = "${entityName}" → ВСЕ обещания в сообщении = promise_by_them

НЕ АНАЛИЗИРУЙ текст для определения типа! Даже если в тексте написано
"я сделаю" или "напишу" — тип зависит ТОЛЬКО от того, кто автор сообщения.

Примеры:
- Автор: я (пользователь), текст: "сделаю завтра" → promise_by_me ✓
- Автор: Марина, текст: "напишу инструкцию" → promise_by_them ✓
- Автор: Марина, текст: "я пришлю документы" → promise_by_them ✓ (НЕ promise_by_me!)
═══════════════════════════════════════════════════════════════

Извлеки:
1. **meeting** — планируемые встречи/созвоны с датой/временем
   data: { datetime?: ISO, dateText?: "завтра в 15:00", topic?, participants?: [] }

2. **promise_by_me** — обещание в сообщении от меня (пользователя)
   data: { what: "что обещано", deadline?: ISO, deadlineText?: "до пятницы" }

3. **promise_by_them** — обещание в сообщении от собеседника
   data: { what: "что обещано", deadline?, deadlineText? }

4. **task** — просьба/задача от собеседника ко мне
   data: { what: "что просят", priority?: "low"|"normal"|"high"|"urgent", deadline?, deadlineText? }

5. **fact** — личная информация о человеке (ДР, телефон, email, должность, компания)
   data: { factType: "birthday"|"phone"|"email"|"position"|"company"|..., value: "значение", quote: "цитата" }

6. **cancellation** — отмена или перенос чего-либо
   data: { what: "что отменяется", newDateTime?, newDateText?, reason? }

ВАЖНО:
- confidence 0.0-1.0 (высокий если явно указано, низкий если домыслы)
- sourceQuote — оригинальный фрагмент текста
- Не извлекай события из сообщений-шуток или гипотетических ситуаций
- ВСЕ ОПИСАНИЯ (what, topic, value) ПИШИ НА РУССКОМ ЯЗЫКЕ, даже если оригинал на английском!
  Пример: "Think about improvements" → "Подумать об улучшениях"
- ЕСЛИ ЕСТЬ КОНТЕКСТ (сообщение на которое отвечают) — используй его для понимания смысла!
  Пример: контекст "Подготовь отчёт до пятницы", сообщение "Ок, сделаю" → promise_by_me с what="подготовить отчёт"

АБСТРАКТНЫЕ СОБЫТИЯ (needsEnrichment = true):
Устанавливай needsEnrichment=true ТОЛЬКО если:
1. Событие ссылается на что-то без конкретики
2. И НЕТ контекста (сообщения на которое отвечают), который проясняет смысл

Примеры БЕЗ контекста (needsEnrichment: true):
- "приступлю к задаче" → какая задача? нужен контекст
- "созвонимся по нашему вопросу" → какой вопрос?
- "подготовлю документы" → какие документы?

Примеры С контекстом (needsEnrichment: false):
- Контекст: "Сможешь сделать презентацию?", Сообщение: "Да, сделаю" → КОНКРЕТНО, what="сделать презентацию"
- Контекст: "Созвонимся завтра в 15:00?", Сообщение: "Ок" → КОНКРЕТНО, meeting с datetime

Примеры КОНКРЕТНЫХ событий (needsEnrichment: false):
- "приступлю к отчёту Q4" → задача ясна
- "созвонимся по проекту Alpha" → тема указана
- "у меня ДР 15 марта" → факт конкретный`;
  }
}
