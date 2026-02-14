import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { CrossChatContextService } from './cross-chat-context.service';
import { ConversationGrouperService } from './conversation-grouper.service';
import { SubjectResolverService } from './subject-resolver.service';
import { ConversationGroup, MessageData } from './extraction.types';
import {
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
  ExtractedEventData,
  MeetingEventData,
  PromiseEventData,
  TaskEventData,
  FactEventData,
  EntityType,
  CreationSource,
} from '@pkg/entities';
import { DraftExtractionService } from './draft-extraction.service';
import {
  ExtractedFact,
  ExtractedTask,
  ExtractedCommitment,
} from './daily-synthesis-extraction.types';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { SettingsService } from '../settings/settings.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { EntityService } from '../entity/entity.service';

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
 * JSON Schema for Conversation-Based extraction.
 * Extends the base schema with subjectMention for third-party fact attribution.
 */
const CONVERSATION_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      description: 'Array of extracted events from the conversation',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['meeting', 'promise_by_me', 'promise_by_them', 'task', 'fact'],
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
          subjectMention: {
            type: 'string',
            description:
              'Name/mention of the person this fact is about (only for fact type). ' +
              'Examples: "Игорь", "мой брат", "начальник Иванов". ' +
              'Leave empty if fact is about the direct conversation participant.',
          },
        },
        required: ['type', 'confidence', 'data'],
      },
    },
  },
  required: ['events'],
};

interface RawConversationEvent extends RawExtractedEvent {
  /** Name/mention of person the fact is about (for third-party facts) */
  subjectMention?: string;
}

interface ConversationExtractionResponse {
  events: RawConversationEvent[];
}

/**
 * Result from conversation extraction using new PendingApproval system.
 */
export interface ConversationExtractionResultV2 {
  /** Batch ID for PendingApproval records */
  batchId: string;
  /** IDs of all messages in the conversation */
  sourceMessageIds: string[];
  /** Total items extracted */
  extractedCount: number;
  /** Breakdown by type */
  counts: {
    facts: number;
    tasks: number;
    commitments: number;
  };
  /** Total tokens used for extraction */
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
    private draftExtractionService: DraftExtractionService,
    @Optional()
    private enrichmentQueueService: EnrichmentQueueService | null,
    @Optional()
    @Inject(forwardRef(() => CrossChatContextService))
    private crossChatContextService: CrossChatContextService | null,
    @Optional()
    @Inject(forwardRef(() => ConversationGrouperService))
    private conversationGrouperService: ConversationGrouperService | null,
    @Optional()
    @Inject(forwardRef(() => EntityFactService))
    private entityFactService: EntityFactService | null,
    @Optional()
    @Inject(forwardRef(() => SubjectResolverService))
    private subjectResolverService: SubjectResolverService | null,
    @Optional()
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService | null,
  ) {}

  /**
   * Extract events from a grouped conversation (multiple messages together).
   *
   * This provides better context than single-message extraction:
   * - Understands references across messages
   * - Resolves ambiguous pronouns
   * - Detects third-party mentions for fact attribution
   *
   * Creates draft entities (EntityFact, Activity, Commitment) with PendingApproval
   * records for user confirmation via Mini App.
   *
   * @param conversation - Grouped conversation with messages
   * @param entityId - Entity ID of the main participant (other than user)
   * @param interactionId - ID of the interaction
   * @param ownerEntityId - ID of the owner entity (user's own entity)
   */
  async extractFromConversation(
    conversation: ConversationGroup,
    entityId: string,
    interactionId: string,
    ownerEntityId: string,
  ): Promise<ConversationExtractionResultV2> {
    const sourceMessageIds = conversation.messages.map((m) => m.id);

    // Check if required services are available
    if (!this.conversationGrouperService) {
      this.logger.warn('ConversationGrouperService not available');
      return {
        batchId: '',
        sourceMessageIds,
        extractedCount: 0,
        counts: { facts: 0, tasks: 0, commitments: 0 },
        tokensUsed: 0,
      };
    }

    // Get entity context for better extraction
    let entityContext = '';
    if (this.entityFactService && entityId) {
      try {
        entityContext = await this.entityFactService.getContextForExtraction(entityId);
      } catch (e) {
        this.logger.warn(`Failed to get entity context: ${e}`);
      }
    }

    // Get cross-chat context
    let crossChatContext: string | null = null;
    if (this.crossChatContextService && conversation.participantEntityIds.length > 0) {
      try {
        crossChatContext = await this.crossChatContextService.getContext(
          interactionId,
          conversation.participantEntityIds,
          conversation.endedAt,
        );
      } catch (e) {
        this.logger.warn(`Failed to get cross-chat context: ${e}`);
      }
    }

    // Format conversation for prompt
    const formattedConversation = this.conversationGrouperService.formatConversationForPrompt(
      conversation,
      { includeTimestamps: true, maxLength: 6000 },
    );

    // Build full prompt with system instructions and context
    const systemInstructions = this.buildConversationSystemPrompt(entityContext, crossChatContext);
    const fullPrompt = `${systemInstructions}\n\n---\n\nБеседа:\n\n${formattedConversation}`;

    // Get extraction settings
    const settings = await this.settingsService.getExtractionSettings();

    try {
      const { data, usage } = await this.claudeAgentService.call<ConversationExtractionResponse>({
        mode: 'oneshot',
        taskType: 'event_extraction',
        prompt: fullPrompt,
        schema: CONVERSATION_EXTRACTION_SCHEMA,
        model: 'haiku',
        referenceType: 'interaction',
        referenceId: interactionId,
        timeout: 90000, // Longer timeout for conversation
      });

      const rawEvents = data?.events || [];

      // Map raw events to DraftExtractionInput format
      const facts: ExtractedFact[] = [];
      const tasks: ExtractedTask[] = [];
      const commitments: ExtractedCommitment[] = [];

      for (const rawEvent of rawEvents) {
        // Skip low confidence
        if (rawEvent.confidence < settings.minConfidence) {
          continue;
        }

        switch (rawEvent.type) {
          case 'fact': {
            const rawConvEvent = rawEvent as RawConversationEvent;
            let factEntityId = entityId;

            if (rawConvEvent.subjectMention) {
              try {
                factEntityId = await this.resolveFactSubject(
                  rawConvEvent.subjectMention,
                  conversation.participantEntityIds,
                  rawConvEvent.confidence ?? 0.7,
                  entityId,
                );
              } catch (e) {
                this.logger.warn(
                  `Failed to resolve subject "${rawConvEvent.subjectMention}": ${e}`,
                );
              }
            }

            facts.push(this.mapToExtractedFact(rawEvent, factEntityId));
            break;
          }

          case 'task':
            // Task from conversation: requested by counterparty, assigned to self
            tasks.push(this.mapToExtractedTask(rawEvent, entityId));
            break;

          case 'promise_by_me':
            commitments.push(
              this.mapToExtractedCommitment(rawEvent, 'promise', 'self', entityId),
            );
            break;

          case 'promise_by_them':
            commitments.push(
              this.mapToExtractedCommitment(rawEvent, 'request', entityId, 'self'),
            );
            break;

          case 'meeting':
            commitments.push(this.mapToExtractedMeeting(rawEvent, entityId));
            break;

          default:
            this.logger.warn(`Unknown event type: ${rawEvent.type}`);
        }
      }

      // Create drafts using DraftExtractionService
      const draftResult = await this.draftExtractionService.createDrafts({
        ownerEntityId,
        facts,
        projects: [],
        tasks,
        commitments,
        sourceInteractionId: interactionId,
      });

      this.logger.log(
        `Extracted from conversation (${conversation.messages.length} messages): ` +
          `${draftResult.counts.facts} facts, ${draftResult.counts.tasks} tasks, ` +
          `${draftResult.counts.commitments} commitments (batch=${draftResult.batchId})`,
      );

      return {
        batchId: draftResult.batchId,
        sourceMessageIds,
        extractedCount:
          draftResult.counts.facts + draftResult.counts.tasks + draftResult.counts.commitments,
        counts: {
          facts: draftResult.counts.facts,
          tasks: draftResult.counts.tasks,
          commitments: draftResult.counts.commitments,
        },
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Conversation extraction failed: ${message}`);
      return {
        batchId: '',
        sourceMessageIds,
        extractedCount: 0,
        counts: { facts: 0, tasks: 0, commitments: 0 },
        tokensUsed: 0,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Private: Mapping helpers for DraftExtractionService
  // ─────────────────────────────────────────────────────────────

  /**
   * Map raw event to ExtractedFact format.
   */
  private mapToExtractedFact(rawEvent: RawExtractedEvent, entityId: string): ExtractedFact {
    const data = rawEvent.data as { factType?: string; value?: string };
    return {
      entityId,
      factType: String(data.factType || 'other'),
      value: String(data.value || ''),
      sourceQuote: rawEvent.sourceQuote,
      confidence: rawEvent.confidence,
    };
  }

  /**
   * Map raw event to ExtractedTask format.
   * @param rawEvent - Raw extracted event from LLM
   * @param requestedBy - Entity ID of who requested the task (counterparty) or 'self'
   */
  private mapToExtractedTask(
    rawEvent: RawExtractedEvent,
    requestedBy: string,
  ): ExtractedTask {
    const data = rawEvent.data as {
      what?: string;
      priority?: string;
      deadline?: string;
      deadlineText?: string;
    };
    return {
      title: String(data.what || ''),
      status: 'pending',
      priority: this.mapTaskPriority(data.priority),
      deadline: data.deadline,
      requestedBy, // Who asked for this task (counterparty entity ID or 'self')
      assignee: 'self', // Tasks from conversation are assigned to system owner
      sourceQuote: rawEvent.sourceQuote,
      confidence: rawEvent.confidence,
    };
  }

  /**
   * Map raw event to ExtractedCommitment format.
   */
  private mapToExtractedCommitment(
    rawEvent: RawExtractedEvent,
    type: 'promise' | 'request',
    from: string,
    to: string,
  ): ExtractedCommitment {
    const data = rawEvent.data as {
      what?: string;
      deadline?: string;
      deadlineText?: string;
    };
    return {
      what: String(data.what || ''),
      from,
      to,
      type,
      deadline: data.deadline,
      sourceQuote: rawEvent.sourceQuote,
      confidence: rawEvent.confidence,
    };
  }

  /**
   * Map raw meeting event to ExtractedCommitment format.
   */
  private mapToExtractedMeeting(
    rawEvent: RawExtractedEvent,
    entityId: string,
  ): ExtractedCommitment {
    const data = rawEvent.data as {
      topic?: string;
      datetime?: string;
      dateText?: string;
    };
    return {
      what: data.topic || 'Встреча',
      from: 'self',
      to: entityId,
      type: 'meeting',
      deadline: data.datetime,
      sourceQuote: rawEvent.sourceQuote,
      confidence: rawEvent.confidence,
    };
  }

  /**
   * Map task priority string to expected format.
   */
  private mapTaskPriority(priority?: string): 'high' | 'medium' | 'low' | undefined {
    switch (priority?.toLowerCase()) {
      case 'high':
      case 'urgent':
        return 'high';
      case 'low':
        return 'low';
      case 'normal':
      case 'medium':
        return 'medium';
      default:
        return undefined;
    }
  }

  /**
   * Resolve the subject (owner) of a fact when subjectMention indicates a third party.
   *
   * 1. Tries SubjectResolverService for name-based matching against known entities
   * 2. Falls back to creating a new extracted Entity for unresolved subjects
   *
   * @param subjectMention - Text mentioning the subject (e.g., "Игорь", "жена")
   * @param conversationParticipants - Entity IDs of conversation participants
   * @param confidence - LLM confidence score for this extraction
   * @param defaultEntityId - Fallback entity ID (main conversation partner)
   * @returns Entity ID to attribute the fact to
   */
  private async resolveFactSubject(
    subjectMention: string,
    conversationParticipants: string[],
    confidence: number,
    defaultEntityId: string,
  ): Promise<string> {
    // 1. Try SubjectResolverService (already injected)
    if (this.subjectResolverService) {
      try {
        const resolution = await this.subjectResolverService.resolve(
          subjectMention,
          conversationParticipants,
          confidence,
        );
        if (resolution.status === 'resolved' && resolution.entityId) {
          this.logger.log(
            `Resolved subject "${subjectMention}" to entity ${resolution.entityId}`,
          );
          return resolution.entityId;
        }
        if (resolution.status === 'pending') {
          this.logger.log(
            `Subject "${subjectMention}" pending confirmation (${resolution.confirmationId})`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `SubjectResolver failed for "${subjectMention}": ${error}`,
        );
      }
    }

    // 2. Unknown subject -> create Entity with CreationSource.EXTRACTED
    return this.createExtractedEntity(subjectMention, defaultEntityId);
  }

  /**
   * Create a new Entity for an extracted third-party subject.
   *
   * @param name - Name/mention of the person (e.g., "жена", "Игорь")
   * @param relatedToEntityId - Entity ID of the main conversation partner (for context)
   * @returns ID of the newly created entity
   */
  private async createExtractedEntity(
    name: string,
    relatedToEntityId: string,
  ): Promise<string> {
    if (!this.entityService) {
      throw new Error(
        `EntityService not available, cannot create extracted entity for "${name}"`,
      );
    }

    const entity = await this.entityService.create({
      type: EntityType.PERSON,
      name,
      creationSource: CreationSource.EXTRACTED,
      notes: `Автоматически создан из извлечения. Упомянут в контексте entity ${relatedToEntityId}`,
    });

    this.logger.log(
      `Created extracted entity "${name}" (${entity.id}) related to ${relatedToEntityId}`,
    );

    return entity.id;
  }

  /**
   * Build system prompt for conversation-based extraction.
   */
  private buildConversationSystemPrompt(
    entityContext: string,
    crossChatContext: string | null,
  ): string {
    const today = new Date().toISOString().split('T')[0];

    let prompt = `Ты — агент для извлечения событий из БЕСЕД (не отдельных сообщений).
Сегодня: ${today}

`;

    if (entityContext) {
      prompt += `═══════════════════════════════════════════════════════════════
ИЗВЕСТНЫЕ ФАКТЫ О СОБЕСЕДНИКЕ:
${entityContext}
═══════════════════════════════════════════════════════════════

`;
    }

    if (crossChatContext) {
      prompt += `═══════════════════════════════════════════════════════════════
СВЯЗАННЫЙ КОНТЕКСТ (другие чаты за последние 30 мин):
${crossChatContext}
═══════════════════════════════════════════════════════════════

`;
    }

    prompt += `ПРАВИЛА ИЗВЛЕЧЕНИЯ:

1. Анализируй БЕСЕДУ ЦЕЛИКОМ, не отдельные сообщения
   - Учитывай контекст предыдущих сообщений
   - Если сообщение неясно без контекста — смотри на предыдущие

2. СУБЪЕКТ ФАКТА — не всегда собеседник!
   - "У Игоря ДР 10 августа" → subjectMention: "Игорь" (третье лицо)
   - "Мой ДР 15 марта" → subjectMention: null (сам собеседник)
   - "У начальника жена врач" → subjectMention: "начальник"

3. PROMISE определяется по АВТОРУ сообщения:
   - Автор = "Я" → promise_by_me
   - Автор = собеседник → promise_by_them

4. Используй СВЯЗАННЫЙ КОНТЕКСТ для понимания отсылок:
   - "как договорились" → смотри crossChatContext
   - "по нашему вопросу" → ищи тему в истории

5. НЕ извлекай:
   - Вопросы (только утверждения)
   - Гипотетические ситуации
   - Шутки и сарказм

ТИПЫ СОБЫТИЙ:

1. **meeting** — встреча/созвон с датой
   data: { datetime?, dateText?, topic?, participants?: [] }

2. **promise_by_me** — моё обещание
   data: { what, deadline?, deadlineText? }

3. **promise_by_them** — обещание собеседника
   data: { what, deadline?, deadlineText? }

4. **task** — задача от собеседника мне
   data: { what, priority?: "low"|"normal"|"high"|"urgent", deadline?, deadlineText? }

5. **fact** — факт о человеке (ДР, телефон, email, должность, компания)
   data: { factType, value, quote }
   + subjectMention если факт о третьем лице

ОПИСАНИЯ — ОБЯЗАТЕЛЬНО:
- Для task, promise_by_me, promise_by_them: описывай what подробно
- НЕ "сделать задачу", А "подготовить отчёт по метрикам для клиента X в рамках проекта мониторинга"
- Контекст (проект, цель, детали) помогает пользователю понять суть без возврата к беседе

ВАЖНО:
- confidence 0.0-1.0 (высокий если явно, низкий если вывод)
- sourceQuote — цитата из беседы
- ВСЕ ОПИСАНИЯ НА РУССКОМ (даже если оригинал на английском)
- value должен содержать ТОЛЬКО факт, без пояснений
- НЕ добавляй: "это новый факт", "раньше не упоминался", "важная информация"
- ПРАВИЛЬНО: value: "курсы по дизайну интерьеров"
- НЕПРАВИЛЬНО: value: "учится на курсах, это новый факт который раньше не упоминался"`;

    return prompt;
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

      default:
        return data as ExtractedEventData;
    }
  }

}
