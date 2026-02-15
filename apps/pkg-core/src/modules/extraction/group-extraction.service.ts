import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { EntityRelationService } from '../entity/entity-relation/entity-relation.service';
import { EntityService } from '../entity/entity.service';
import { PromiseRecipientService } from './promise-recipient.service';
import { ExtractionToolsProvider, EXTRACTION_MCP_NAME } from './tools/extraction-tools.provider';
import {
  UnifiedExtractionResult,
  UnifiedExtractionResponse,
  EnrichedMessage,
} from './unified-extraction.types';
import { MessageData } from './extraction.types';
import { InteractionParticipant, ParticipantRole } from '@pkg/entities';

/** Minimum message length to process */
const MIN_MESSAGE_LENGTH = 20;

/** Max combined message content for prompt (larger than unified — more participants) */
const CONTENT_LIMIT = 12000;

/** JSON Schema for agent's final structured response */
const GROUP_EXTRACTION_SCHEMA = {
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
 * Parameters for group chat extraction.
 */
export interface GroupExtractionParams {
  interactionId: string;
  messages: MessageData[];
  /** Participants with loaded entity relation */
  participants: InteractionParticipant[];
  chatName?: string;
}

/**
 * Participant context loaded for prompt building.
 */
interface ParticipantContext {
  entityId: string;
  name: string;
  role: ParticipantRole | string;
  factsContext: string;
  relationsContext: string;
}

/**
 * Group extraction service — extracts facts, events, and relations from GROUP chats.
 *
 * Unlike UnifiedExtractionService (1:1 chats), this service handles multi-entity
 * context: each participant has their own facts/relations loaded into the prompt.
 *
 * Uses the same 6 MCP tools: get_entity_context, find_entity_by_name, create_fact,
 * create_relation, create_pending_entity, create_event
 */
@Injectable()
export class GroupExtractionService {
  private readonly logger = new Logger(GroupExtractionService.name);

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
   * Run extraction on a batch of messages from a group chat.
   * Single agent call extracts facts, events, and relations for all participants.
   */
  async extract(params: GroupExtractionParams): Promise<UnifiedExtractionResult> {
    const { interactionId, messages, participants, chatName } = params;

    // 1. Filter bot and short messages
    const validMessages = messages.filter((m) => {
      if (m.isBotSender) return false;
      if (m.content.length < MIN_MESSAGE_LENGTH) return false;
      return true;
    });

    if (validMessages.length === 0) {
      this.logger.debug(`[group-extraction] No valid messages (interaction: ${interactionId})`);
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
      this.logger.error('[group-extraction] ExtractionToolsProvider not available');
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

    // 2. Load context for each participant
    const participantsContext = await this.loadParticipantsContext(participants);

    // 3. Get owner entity ID
    let ownerEntityId: string | null = null;
    try {
      const owner = await this.entityService.findMe();
      ownerEntityId = owner?.id ?? null;
      if (!ownerEntityId) {
        this.logger.warn('[group-extraction] Owner entity not set - draft entities will not be created');
      }
    } catch (error) {
      this.logger.warn(`[group-extraction] Failed to get owner entity: ${error}`);
    }

    // 4. Enrich messages with reply-to info and promise recipients
    const enrichedMessages = await this.enrichMessages(validMessages, interactionId, ownerEntityId);

    // 5. Build group prompt
    const prompt = this.buildGroupPrompt(
      participantsContext,
      enrichedMessages,
      chatName,
      ownerEntityId,
    );

    // 6. Create MCP server with extraction context
    const extractionContext = {
      messageId: validMessages[0]?.id ?? null,
      interactionId,
      ownerEntityId,
    };
    const mcpServer = this.extractionToolsProvider.createMcpServer(extractionContext);
    const toolNames = this.extractionToolsProvider.getToolNames();

    this.logger.debug(`[group-extraction] Prompt:\n${prompt}`);

    // 7. Call agent
    const { data, usage, turns, toolsUsed } = await this.claudeAgentService.call<UnifiedExtractionResponse>({
      mode: 'agent',
      taskType: 'group_extraction',
      prompt,
      model: 'haiku',
      maxTurns: 25,
      timeout: 300_000,
      referenceType: 'interaction',
      referenceId: interactionId,
      customMcp: {
        name: EXTRACTION_MCP_NAME,
        server: mcpServer,
        toolNames,
      },
      outputFormat: {
        type: 'json_schema',
        schema: GROUP_EXTRACTION_SCHEMA,
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
      `[group-extraction] Done for "${chatName || interactionId}" (${participants.length} participants): ` +
        `${result.factsCreated} facts, ${result.eventsCreated} events, ` +
        `${result.relationsCreated} relations, ${result.pendingEntities} pending | ` +
        `${result.turns} turns, tools: [${result.toolsUsed.join(', ')}] | ` +
        `${result.tokensUsed} tokens`,
    );

    return result;
  }

  /**
   * Load facts and relations context for each participant.
   */
  private async loadParticipantsContext(
    participants: InteractionParticipant[],
  ): Promise<ParticipantContext[]> {
    const contexts: ParticipantContext[] = [];

    for (const participant of participants) {
      if (!participant.entityId) {
        continue;
      }

      const name = participant.entity?.name || participant.displayName || 'Unknown';

      let factsContext = '';
      try {
        factsContext = await this.entityFactService.getContextForExtraction(participant.entityId);
      } catch (error) {
        this.logger.warn(`[group-extraction] Failed to get facts for ${name}: ${error}`);
      }

      const relationsContext = await this.buildRelationsContext(participant.entityId);

      contexts.push({
        entityId: participant.entityId,
        name,
        role: participant.role,
        factsContext,
        relationsContext,
      });
    }

    return contexts;
  }

  /**
   * Build relations context string for a participant.
   */
  private async buildRelationsContext(entityId: string): Promise<string> {
    if (!this.entityRelationService) return '';

    try {
      const relations = await this.entityRelationService.findByEntityWithContext(entityId);
      return this.entityRelationService.formatForContext(relations);
    } catch (error) {
      this.logger.warn(`[group-extraction] Failed to get relations context: ${error}`);
      return '';
    }
  }

  /**
   * Enrich messages with reply-to info and resolved promise recipients.
   * For group chats, defaultEntityId is ownerEntityId (the system owner).
   */
  private async enrichMessages(
    messages: MessageData[],
    interactionId: string,
    ownerEntityId: string | null,
  ): Promise<EnrichedMessage[]> {
    const fallbackEntityId = ownerEntityId || '';
    const fallbackEntityName = 'Unknown';

    // Batch-load reply-to info
    const replyToInfoMap = await this.promiseRecipientService.loadReplyToInfo(messages, interactionId);

    const enriched: EnrichedMessage[] = [];

    for (const m of messages) {
      try {
        const replyToInfo = m.replyToSourceMessageId
          ? replyToInfoMap.get(m.replyToSourceMessageId)
          : undefined;

        const messageEntityId = m.senderEntityId || fallbackEntityId;
        const messageEntityName = m.senderEntityName || fallbackEntityName;

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
        this.logger.warn(`[group-extraction] Failed to enrich message ${m.id}: ${error}`);
        enriched.push({
          ...m,
          entityId: m.senderEntityId || fallbackEntityId,
          entityName: m.senderEntityName || fallbackEntityName,
        });
      }
    }

    return enriched;
  }

  /**
   * Build the group extraction prompt with participant context and message block.
   */
  private buildGroupPrompt(
    participantsContext: ParticipantContext[],
    messages: EnrichedMessage[],
    chatName: string | undefined,
    ownerEntityId: string | null,
  ): string {
    // Format participants section
    const participantsSection = this.buildParticipantsSection(participantsContext, ownerEntityId);

    // Format messages block (group format — no INCOMING/OUTGOING)
    const messageBlock = messages
      .map((m) => {
        const senderName = m.entityName;
        const topic = m.topicName ? ` [Тема: ${m.topicName}]` : '';
        const reply = m.replyToContent
          ? `\n  [В ответ на: "${m.replyToContent.slice(0, 100)}..." от ${m.replyToSenderName}]`
          : '';
        const promiseTo = m.promiseToEntityId
          ? `\n  [promiseToEntityId: ${m.promiseToEntityId}]`
          : '';
        return `[${m.timestamp || ''}] (${senderName}, entityId: ${m.entityId}, msgId: ${m.id})${topic}${reply}${promiseTo}\n${m.content}`;
      })
      .join('\n\n')
      .substring(0, CONTENT_LIMIT);

    const chatTitle = chatName ? ` "${chatName}"` : '';
    const today = new Date().toISOString().split('T')[0];

    return `Ты — агент извлечения знаний из ГРУППОВОГО чата${chatTitle}.
Анализируй сообщения от нескольких участников и создавай факты, события и связи через доступные инструменты.

══════════════════════════════════════════
УЧАСТНИКИ ГРУППЫ:
══════════════════════════════════════════
${participantsSection}

══════════════════════════════════════════
§ ФАКТЫ — правила извлечения (групповой чат)
══════════════════════════════════════════
1. Факты принадлежат КОНКРЕТНЫМ сущностям. Определяй автора факта по контексту сообщения.
2. Каждое сообщение подписано отправителем (entityId). Используй этот entityId для атрибуции.
3. Если участник упоминает третье лицо — используй create_pending_entity (с relatedToEntityId отправителя).
4. Если упомянут человек из участников — загрузи его контекст через get_entity_context.
5. ФАКТЫ О ТРЕТЬИХ ЛИЦАХ:
   a) find_entity_by_name("имя") — поиск
   b) Если НЕ найдено → create_pending_entity
   c) Используй ВОЗВРАЩЁННЫЙ entityId для create_fact
   d) Создай связь через create_relation
6. НЕ дублируй уже известные факты.
7. Типы фактов: position, company, birthday, phone, email, location, education, hobby, family, preference.
8. value поля create_fact должен содержать ТОЛЬКО сам факт. БЕЗ пояснений.
9. В групповом чате НЕТ понятия "ИСХОДЯЩЕЕ/ВХОДЯЩЕЕ". Каждое сообщение атрибутировано автору.

══════════════════════════════════════════
§ СОБЫТИЯ — правила извлечения
══════════════════════════════════════════
Сегодняшняя дата: ${today}

1. ТИПЫ:
   - meeting: встречи, созвоны, переговоры
   - promise_by_me: обещание от участника с role=self (владелец системы)
   - promise_by_them: обещание от любого другого участника
   - task: задача, запрос — "можешь глянуть?", "нужно сделать"
   - fact: личный факт — "у меня ДР 15 марта", "переехал в Москву"
   - cancellation: отмена/перенос — "давай перенесём", "не получится"

2. ОПРЕДЕЛЕНИЕ ТИПА ОБЕЩАНИЙ — по role участника:
   - Сообщение от участника с role=self + обещание → promise_by_me
   - Сообщение от любого другого участника + обещание → promise_by_them
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

7. АНТИ-ПРИМЕРЫ — НЕ извлекай подобное:
   ❌ "Переделать что-то в будущем" — нет конкретики. Правильно: "Перенести транскрибацию на внутренний сервис для invapp-panavto"
   ❌ "Обсудить вопрос" — нет объекта. Правильно: "Согласовать стоимость лицензии $200/мес с клиентом X"
   ❌ "Сделать задачу" — пересказ, не извлечение. Указывай ЧТО конкретно.
   Правило: если title можно приложить к ЛЮБОМУ разговору — оно слишком абстрактное.

══════════════════════════════════════════
§ СВЯЗИ — правила извлечения
══════════════════════════════════════════
1. "работает в ..." → create_relation(employment, [person/employee, org/employer])
2. "мой начальник" → create_relation(reporting, [me/subordinate, boss/manager])
3. "жена/муж" → create_relation(marriage, [spouse, spouse])
4. Не дублируй уже известные связи (сверяйся с контекстом участников).

══════════════════════════════════════════
§ АКТИВНОСТИ — существующие проекты и задачи
══════════════════════════════════════════
ПЕРЕД созданием задачи/обещания через create_event — ОБЯЗАТЕЛЬНО вызови find_activity(query) для проверки.
Если find_activity вернул совпадение (similarity ≥ 0.6) — используй его activityId в create_event.
Если точный activityId неизвестен, укажи projectName — система найдёт ближайшее совпадение.
НЕ создавай дубликатов — всегда проверяй через find_activity!

══════════════════════════════════════════
СООБЩЕНИЯ ДЛЯ АНАЛИЗА:
══════════════════════════════════════════
${messageBlock}

══════════════════════════════════════════
ЗАДАНИЕ (2 фазы):
══════════════════════════════════════════

ФАЗА 1 — ПОЙМИ КОНТЕКСТ РАЗГОВОРА:
Прочитай ВСЕ сообщения целиком. Определи:
- О чём разговор в целом? Какая основная тема?
- Какие решения были приняты?
- Какие конкретные действия обсуждались?
НЕ начинай извлечение до понимания общего контекста.

ФАЗА 2 — ИЗВЛЕКИ ЗНАЧИМЫЕ ЭЛЕМЕНТЫ:
Основываясь на понимании разговора, извлеки:
- Конкретные факты (должность, компания, контакты)
- Конкретные обещания и задачи с ясным описанием ЧТО ИМЕННО
- Связи между людьми/организациями

КРИТИЧНО: Каждый извлечённый элемент должен:
1. Быть понятен БЕЗ возврата к переписке
2. Содержать конкретику, а не расплывчатые формулировки
3. Быть привязан к контексту разговора (проект, тема, цель)

Для каждого найденного факта, события или связи — вызови соответствующий инструмент.
Посчитай количество успешных вызовов каждого инструмента и заполни итоговую сводку:
- factsCreated: количество успешных вызовов create_fact
- eventsCreated: количество успешных вызовов create_event
- relationsCreated: количество успешных вызовов create_relation
- pendingEntities: количество успешных вызовов create_pending_entity`;
  }

  /**
   * Build the participants section for the group prompt.
   */
  private buildParticipantsSection(
    participantsContext: ParticipantContext[],
    ownerEntityId: string | null,
  ): string {
    if (participantsContext.length === 0) {
      return 'Контекст участников не загружен.';
    }

    const lines: string[] = [];

    for (const ctx of participantsContext) {
      const isOwner = ctx.role === ParticipantRole.SELF || ctx.entityId === ownerEntityId;

      if (isOwner) {
        lines.push(`**Я** (entityId: ${ctx.entityId}, role: self) — Владелец системы.`);
        continue;
      }

      const parts: string[] = [`**${ctx.name}** (entityId: ${ctx.entityId}, role: ${ctx.role})`];

      if (ctx.factsContext || ctx.relationsContext) {
        if (ctx.factsContext) {
          parts.push(`  Известные факты: ${ctx.factsContext}`);
        }
        if (ctx.relationsContext) {
          parts.push(`  Связи: ${ctx.relationsContext}`);
        }
      } else {
        parts.push('  Новый участник, контекст не загружен.');
      }

      lines.push(parts.join('\n'));
    }

    return lines.join('\n\n');
  }
}
