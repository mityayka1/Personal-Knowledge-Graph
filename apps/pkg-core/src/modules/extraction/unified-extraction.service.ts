import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { EntityRelationService } from '../entity/entity-relation/entity-relation.service';
import { EntityService } from '../entity/entity.service';
import { PromiseRecipientService } from './promise-recipient.service';
import { ExtractionToolsProvider, EXTRACTION_MCP_NAME } from './tools/extraction-tools.provider';
import {
  UnifiedExtractionParams,
  UnifiedExtractionResult,
  UnifiedExtractionResponse,
  EnrichedMessage,
} from './unified-extraction.types';
import { MessageData } from './extraction.types';

/** Minimum message length to process */
const MIN_MESSAGE_LENGTH = 20;

/** Max combined message content for prompt */
const CONTENT_LIMIT = 8000;

/** JSON Schema for agent's final structured response */
const UNIFIED_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    factsCreated: { type: 'number', description: 'Number of successful create_fact calls' },
    eventsCreated: { type: 'number', description: 'Number of successful create_event calls' },
    relationsCreated: { type: 'number', description: 'Number of successful create_relation calls' },
    pendingEntities: { type: 'number', description: 'Number of successful create_pending_entity calls' },
    summary: { type: 'string', description: 'Brief summary of what was extracted' },
  },
  required: ['factsCreated', 'eventsCreated', 'relationsCreated', 'pendingEntities', 'summary'],
};

/**
 * Unified extraction service — single agent call that replaces 3 separate flows:
 * - FactExtractionService.extractFactsAgentBatch() (agent, 5 tools)
 * - EventExtractionService.extractEventsBatch() (oneshot, legacy)
 * - SecondBrainExtractionService.extractFromMessages() (oneshot, 6 types)
 *
 * Uses 6 MCP tools: get_entity_context, find_entity_by_name, create_fact,
 * create_relation, create_pending_entity, create_event
 */
@Injectable()
export class UnifiedExtractionService {
  private readonly logger = new Logger(UnifiedExtractionService.name);

  constructor(
    @Inject(forwardRef(() => ClaudeAgentService))
    private readonly claudeAgentService: ClaudeAgentService,
    @Inject(forwardRef(() => EntityFactService))
    private readonly entityFactService: EntityFactService,
    @Optional()
    @Inject(forwardRef(() => EntityRelationService))
    private readonly entityRelationService: EntityRelationService | null,
    @Inject(forwardRef(() => EntityService))
    private readonly entityService: EntityService,
    @Inject(forwardRef(() => PromiseRecipientService))
    private readonly promiseRecipientService: PromiseRecipientService,
    @Optional()
    @Inject(forwardRef(() => ExtractionToolsProvider))
    private readonly extractionToolsProvider: ExtractionToolsProvider | null,
  ) {}

  /**
   * Run unified extraction on a batch of messages.
   * Single agent call extracts facts, events, and relations.
   */
  async extract(params: UnifiedExtractionParams): Promise<UnifiedExtractionResult> {
    const { entityId, entityName, messages, interactionId } = params;

    // Filter bot and short messages
    const validMessages = messages.filter((m) => {
      if (m.isBotSender) return false;
      if (m.content.length < MIN_MESSAGE_LENGTH) return false;
      return true;
    });

    if (validMessages.length === 0) {
      this.logger.debug(`No valid messages for unified extraction (entity: ${entityId})`);
      return {
        factsCreated: 0,
        eventsCreated: 0,
        relationsCreated: 0,
        pendingEntities: 0,
        turns: 0,
        toolsUsed: [],
        tokensUsed: 0,
      };
    }

    if (!this.extractionToolsProvider) {
      this.logger.error('ExtractionToolsProvider not available — cannot run unified extraction');
      return {
        factsCreated: 0,
        eventsCreated: 0,
        relationsCreated: 0,
        pendingEntities: 0,
        turns: 0,
        toolsUsed: [],
        tokensUsed: 0,
      };
    }

    // 1. Get entity context (existing facts/memory)
    let entityContext = '';
    try {
      entityContext = await this.entityFactService.getContextForExtraction(entityId);
    } catch (error) {
      this.logger.warn(`Failed to get entity context: ${error}`);
    }

    // 2. Get relations context
    const relationsContext = await this.buildRelationsContext(entityId);

    // 3. Enrich messages with reply-to info and promise recipients
    const enrichedMessages = await this.enrichMessages(validMessages, interactionId, entityId, entityName);

    // 4. Build unified prompt
    const prompt = this.buildUnifiedPrompt(entityName, entityId, entityContext, relationsContext, enrichedMessages);

    // 5. Get owner entity ID for draft creation
    let ownerEntityId: string | null = null;
    try {
      const owner = await this.entityService.findMe();
      ownerEntityId = owner?.id ?? null;
      if (!ownerEntityId) {
        this.logger.warn('Owner entity not set - draft entities will not be created');
      }
    } catch (error) {
      this.logger.warn(`Failed to get owner entity: ${error}`);
    }

    // 6. Create MCP server with extraction context
    const extractionContext = {
      messageId: validMessages[0]?.id ?? null,
      interactionId,
      ownerEntityId,
    };
    const mcpServer = this.extractionToolsProvider.createMcpServer(extractionContext);
    const toolNames = this.extractionToolsProvider.getToolNames();

    this.logger.debug(`[unified-extraction] Prompt:\n${prompt}`);

    // 6. Call agent — errors propagate to caller (BullMQ retry)
    const { data, usage, turns, toolsUsed } = await this.claudeAgentService.call<UnifiedExtractionResponse>({
      mode: 'agent',
      taskType: 'unified_extraction',
      prompt,
      model: 'haiku',
      maxTurns: 15,
      timeout: 180_000,
      referenceType: 'interaction',
      referenceId: interactionId,
      customMcp: {
        name: EXTRACTION_MCP_NAME,
        server: mcpServer,
        toolNames,
      },
      outputFormat: {
        type: 'json_schema',
        schema: UNIFIED_EXTRACTION_SCHEMA,
        strict: true,
      },
    });

    const result: UnifiedExtractionResult = {
      factsCreated: data?.factsCreated ?? 0,
      eventsCreated: data?.eventsCreated ?? 0,
      relationsCreated: data?.relationsCreated ?? 0,
      pendingEntities: data?.pendingEntities ?? 0,
      turns: turns ?? 0,
      toolsUsed: toolsUsed ?? [],
      tokensUsed: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    };

    this.logger.log(
      `[unified-extraction] Done for ${entityName}: ` +
        `${result.factsCreated} facts, ${result.eventsCreated} events, ` +
        `${result.relationsCreated} relations, ${result.pendingEntities} pending | ` +
        `${result.turns} turns, tools: [${result.toolsUsed.join(', ')}] | ` +
        `${result.tokensUsed} tokens`,
    );

    return result;
  }

  /**
   * Build relations context string for the prompt.
   */
  private async buildRelationsContext(entityId: string): Promise<string> {
    if (!this.entityRelationService) return '';

    try {
      const relations = await this.entityRelationService.findByEntityWithContext(entityId);
      return this.entityRelationService.formatForContext(relations);
    } catch (error) {
      this.logger.warn(`Failed to get relations context: ${error}`);
      return '';
    }
  }

  /**
   * Enrich messages with reply-to info and resolved promise recipients.
   * Moves this logic from FactExtractionProcessor into the service.
   */
  private async enrichMessages(
    messages: MessageData[],
    interactionId: string,
    defaultEntityId: string,
    defaultEntityName: string,
  ): Promise<EnrichedMessage[]> {
    // Batch-load reply-to info
    const replyToInfoMap = await this.promiseRecipientService.loadReplyToInfo(messages, interactionId);

    const enriched: EnrichedMessage[] = [];

    for (const m of messages) {
      try {
        const replyToInfo = m.replyToSourceMessageId
          ? replyToInfoMap.get(m.replyToSourceMessageId)
          : undefined;

        const messageEntityId = m.senderEntityId || defaultEntityId;
        const messageEntityName = m.senderEntityName || defaultEntityName;

        const promiseToEntityId = await this.promiseRecipientService.resolveRecipient({
          interactionId,
          entityId: messageEntityId,
          isOutgoing: m.isOutgoing ?? false,
          replyToSenderEntityId: replyToInfo?.senderEntityId,
        });

        enriched.push({
          ...m,
          entityId: messageEntityId,
          entityName: messageEntityName,
          promiseToEntityId,
          replyToContent: replyToInfo?.content,
          replyToSenderName: replyToInfo?.senderName,
        });
      } catch (error) {
        this.logger.warn(`Failed to enrich message ${m.id}: ${error}`);
        // Still include message with minimal enrichment
        enriched.push({
          ...m,
          entityId: m.senderEntityId || defaultEntityId,
          entityName: m.senderEntityName || defaultEntityName,
        });
      }
    }

    return enriched;
  }

  /**
   * Build the unified prompt with §FACTS, §EVENTS, §RELATIONS sections.
   */
  private buildUnifiedPrompt(
    entityName: string,
    entityId: string,
    entityContext: string,
    relationsContext: string,
    messages: EnrichedMessage[],
  ): string {
    // Format messages block
    const messageBlock = messages
      .map((m) => {
        const direction = m.isOutgoing ? '→ ИСХОДЯЩЕЕ' : '← ВХОДЯЩЕЕ';
        const sender = m.entityName;
        const reply = m.replyToContent
          ? `\n  [В ответ на: "${m.replyToContent.slice(0, 100)}..." от ${m.replyToSenderName}]`
          : '';
        const topic = m.topicName ? ` [Тема: ${m.topicName}]` : '';
        const promiseTo = m.promiseToEntityId
          ? `\n  [promiseToEntityId: ${m.promiseToEntityId}]`
          : '';
        return `[${m.timestamp || ''}] ${direction} (${sender}, entityId: ${m.entityId}, msgId: ${m.id})${topic}${reply}${promiseTo}\n${m.content}`;
      })
      .join('\n\n')
      .substring(0, CONTENT_LIMIT);

    // Build context section
    const contextSection = entityContext
      ? `\nПАМЯТЬ О ${entityName} (entityId: ${entityId}):\n${entityContext}`
      : `\nПервичная сущность: ${entityName} (entityId: ${entityId})`;

    const relationsSection = relationsContext ? `\n${relationsContext}` : '';

    return `Ты — агент извлечения знаний из переписки.
Анализируй сообщения и создавай факты, события и связи через доступные инструменты.

══════════════════════════════════════════
КОНТЕКСТ СОБЕСЕДНИКА:
${contextSection}
${relationsSection}
══════════════════════════════════════════

══════════════════════════════════════════
§ ФАКТЫ — правила извлечения
══════════════════════════════════════════
1. Факты принадлежат КОНКРЕТНЫМ сущностям.
2. "Маша работает в Сбере" → create_fact для Маши (найди через find_entity_by_name), НЕ для ${entityName}.
3. Если упомянут человек из связей — загрузи его контекст через get_entity_context.
4. Если упомянут новый человек — создай через create_pending_entity.
5. НЕ дублируй уже известные факты (Smart Fusion обработает дубликаты автоматически).
6. Типы фактов: position, company, birthday, phone, email, location, education, hobby, family, preference.
7. [Я] / ИСХОДЯЩЕЕ — сообщения пользователя, [${entityName}] / ВХОДЯЩЕЕ — сообщения собеседника.

══════════════════════════════════════════
§ СОБЫТИЯ — правила извлечения
══════════════════════════════════════════
Сегодняшняя дата: ${new Date().toISOString().split('T')[0]}

1. ТИПЫ:
   - meeting: встречи, созвоны, переговоры
   - promise_by_me: обещание в ИСХОДЯЩЕМ сообщении (→)
   - promise_by_them: обещание во ВХОДЯЩЕМ сообщении (←)
   - task: задача, запрос — "можешь глянуть?", "нужно сделать"
   - fact: личный факт — "у меня ДР 15 марта", "переехал в Москву"
   - cancellation: отмена/перенос — "давай перенесём", "не получится"

2. ОПРЕДЕЛЕНИЕ ТИПА ОБЕЩАНИЙ — ТОЛЬКО по направлению сообщения:
   - Сообщение "→ ИСХОДЯЩЕЕ" + обещание → promise_by_me
   - Сообщение "← ВХОДЯЩЕЕ" + обещание → promise_by_them
   - НИКОГДА не определяй тип обещания по тексту сообщения

3. АБСТРАКТНЫЕ СОБЫТИЯ:
   - Нет конкретной даты или деталей → needsEnrichment: true
   - "давай встретимся" → meeting + needsEnrichment: true
   - "встреча 15 января в 14:00" → meeting + needsEnrichment: false

4. PROMISE RECIPIENT:
   - Для promise_by_me: используй promiseToEntityId из метаданных сообщения

5. entityId и sourceMessageId:
   - entityId: используй entityId из метаданных конкретного сообщения
   - sourceMessageId: используй msgId из метаданных сообщения

6. sourceQuote — ОБЯЗАТЕЛЬНО:
   - Всегда указывай цитату из сообщения (до 200 символов)
   - Это нужно для контекста в уведомлениях
   - Без sourceQuote событие будет непонятным получателю

══════════════════════════════════════════
§ СВЯЗИ — правила извлечения
══════════════════════════════════════════
1. "работает в ..." → create_relation(employment, [person/employee, org/employer])
2. "мой начальник" → create_relation(reporting, [me/subordinate, boss/manager])
3. "жена/муж" → create_relation(marriage, [spouse, spouse])
4. Не дублируй уже известные связи (сверяйся с контекстом).

══════════════════════════════════════════
СООБЩЕНИЯ ДЛЯ АНАЛИЗА:
══════════════════════════════════════════
${messageBlock}

══════════════════════════════════════════
ЗАДАНИЕ:
Проанализируй все сообщения. Для каждого найденного факта, события или связи — вызови соответствующий инструмент.
Посчитай количество успешных вызовов каждого инструмента и заполни итоговую сводку:
- factsCreated: количество успешных вызовов create_fact
- eventsCreated: количество успешных вызовов create_event
- relationsCreated: количество успешных вызовов create_relation
- pendingEntities: количество успешных вызовов create_pending_entity`;
  }
}
