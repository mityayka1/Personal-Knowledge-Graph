import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  toolSuccess,
  toolEmptyResult,
  toolError,
  handleToolError,
  type ToolDefinition,
} from '../../claude-agent/tools/tool.types';
import { EntityFactService } from '../../entity/entity-fact/entity-fact.service';
import { EntityService } from '../../entity/entity.service';
import { EntityRelationService } from '../../entity/entity-relation/entity-relation.service';
import { PendingResolutionService } from '../../resolution/pending-resolution.service';
import { EnrichmentQueueService } from '../enrichment-queue.service';
import {
  FactSource,
  RelationType,
  RelationSource,
  FactCategory,
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
} from '@pkg/entities';

/** MCP server name for extraction tools */
export const EXTRACTION_MCP_NAME = 'extraction-tools';

/**
 * Provider for extraction-specific tools used in agent mode fact extraction.
 *
 * Tools are designed for cross-entity routing:
 * - "Маша перешла в Сбер" → create fact for Маша, not current contact
 * - Supports lazy loading of entity context
 * - Creates pending entities for unknown people
 */
/**
 * Context for extraction tools - passed through createMcpServer() to avoid singleton race condition.
 * Each request gets its own context instance.
 */
export interface ExtractionContext {
  messageId: string | null;
  interactionId: string | null;
}

@Injectable()
export class ExtractionToolsProvider {
  private readonly logger = new Logger(ExtractionToolsProvider.name);

  constructor(
    @Inject(forwardRef(() => EntityFactService))
    private readonly entityFactService: EntityFactService,
    @Inject(forwardRef(() => EntityService))
    private readonly entityService: EntityService,
    @Optional()
    @Inject(forwardRef(() => EntityRelationService))
    private readonly entityRelationService: EntityRelationService | null,
    @Optional()
    @Inject(forwardRef(() => PendingResolutionService))
    private readonly pendingResolutionService: PendingResolutionService | null,
    @InjectRepository(ExtractedEvent)
    private readonly extractedEventRepo: Repository<ExtractedEvent>,
    @Optional()
    private readonly enrichmentQueueService: EnrichmentQueueService | null,
  ) {}

  /**
   * Get extraction tools for a specific context.
   * Tools are created fresh per context to avoid singleton state issues.
   *
   * @param context - Message/interaction context for source tracking
   */
  getTools(context?: ExtractionContext): ToolDefinition[] {
    // Create tools fresh with context to avoid singleton race condition
    const tools = this.createTools(context ?? { messageId: null, interactionId: null });
    this.logger.debug(`Created ${tools.length} extraction tools`);
    return tools;
  }

  /**
   * Check if all required services are available.
   */
  hasRequiredServices(): boolean {
    return !!(this.entityFactService && this.entityService);
  }

  /**
   * Get tool names for allowedTools configuration.
   * Returns MCP-formatted names: mcp__extraction-tools__tool_name
   */
  getToolNames(): string[] {
    // Use empty context just to get tool names (context not needed for names)
    return this.getTools().map((t) => `mcp__${EXTRACTION_MCP_NAME}__${t.name}`);
  }

  /**
   * Create MCP server with extraction tools for a specific context.
   *
   * @param context - Message/interaction context for source tracking
   */
  createMcpServer(context: ExtractionContext): ReturnType<typeof createSdkMcpServer> {
    const tools = this.getTools(context);
    return createSdkMcpServer({
      name: EXTRACTION_MCP_NAME,
      version: '1.0.0',
      tools,
    });
  }

  /**
   * Create tool definitions with context.
   */
  private createTools(context: ExtractionContext): ToolDefinition[] {
    return [
      // Read tools
      this.createGetEntityContextTool(),
      this.createFindEntityByNameTool(),

      // Write tools
      this.createFactTool(),
      this.createRelationTool(),
      this.createPendingEntityTool(context),
      this.createEventTool(context),
    ] as ToolDefinition[];
  }

  /**
   * get_entity_context - Get memory about an entity (facts, history, relations).
   */
  private createGetEntityContextTool() {
    return tool(
      'get_entity_context',
      `Получить память о сущности: текущие факты, историю изменений, связи с другими людьми.
Используй чтобы понять контекст перед созданием новых фактов.`,
      {
        entityId: z.string().uuid().describe('UUID сущности для получения контекста'),
      },
      async (args) => {
        try {
          const context = await this.entityFactService.getContextForExtraction(args.entityId);

          if (!context || context.trim().length === 0) {
            return toolEmptyResult(
              'context for entity',
              'Entity may not have any facts yet. You can still create new facts for it.',
            );
          }

          return toolSuccess(context);
        } catch (error) {
          return handleToolError(error, this.logger, 'get_entity_context');
        }
      },
    );
  }

  /**
   * find_entity_by_name - Search for entity by name or alias.
   */
  private createFindEntityByNameTool() {
    return tool(
      'find_entity_by_name',
      `Найти сущность (человека или организацию) по имени.
Возвращает ID и основную информацию если найдена.
Используй для поиска упомянутых людей перед созданием фактов.`,
      {
        name: z.string().min(2).describe('Имя для поиска (минимум 2 символа, поддерживается частичное совпадение)'),
        type: z.enum(['person', 'organization']).optional().describe('Тип сущности для фильтрации'),
        limit: z.number().int().min(1).max(10).default(5).describe('Максимум результатов'),
      },
      async (args) => {
        try {
          const result = await this.entityService.findAll({
            search: args.name,
            type: args.type as any,
            limit: args.limit,
            offset: 0,
          });

          if (result.items.length === 0) {
            return toolEmptyResult(
              'entities matching name',
              'Try different spelling or create a pending entity if this is a new person.',
            );
          }

          const entities = result.items.map((e) => ({
            id: e.id,
            name: e.name,
            type: e.type,
            organization: e.organization?.name || null,
          }));

          return toolSuccess({
            found: entities.length,
            total: result.total,
            entities,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'find_entity_by_name');
        }
      },
    );
  }

  /**
   * create_fact - Create a fact for an entity with Smart Fusion.
   */
  private createFactTool() {
    return tool(
      'create_fact',
      `Создать факт для сущности. Проходит через Smart Fusion для дедупликации.

Типы фактов:
- position: должность ("Senior Developer", "CTO")
- company: компания ("Сбер", "Яндекс")
- department: отдел ("Отдел разработки")
- phone: телефон ("+7 999 123-45-67")
- email: электронная почта
- telegram: username (@username)
- birthday: день рождения ("15 марта", "1990-03-15")
- location: местоположение ("Москва", "работает удалённо")
- education: образование ("МГУ", "PhD Computer Science")

ВАЖНО: Создавай факт для КОНКРЕТНОЙ сущности. "Маша работает в Сбере" → факт для Маши, не для текущего контакта.`,
      {
        entityId: z.string().uuid().describe('UUID сущности-владельца факта'),
        factType: z.string().describe('Тип факта (position, company, phone, email, etc.)'),
        value: z.string().describe('Значение факта на русском языке'),
        confidence: z.number().min(0).max(1).describe('Уверенность в факте от 0 до 1'),
        sourceQuote: z.string().max(200).describe('Цитата из сообщения (до 200 символов)'),
        category: z
          .enum(['professional', 'personal', 'contact', 'preferences'])
          .optional()
          .describe('Категория факта'),
      },
      async (args) => {
        try {
          // Map category string to enum
          const categoryMap: Record<string, FactCategory> = {
            professional: FactCategory.PROFESSIONAL,
            personal: FactCategory.PERSONAL,
            contact: FactCategory.CONTACT,
            preferences: FactCategory.PREFERENCES,
          };

          const result = await this.entityFactService.createWithDedup(
            args.entityId,
            {
              type: args.factType.toLowerCase() as any, // factType accepts string | FactType
              value: args.value.trim(),
              source: FactSource.EXTRACTED,
              category: args.category ? categoryMap[args.category] : undefined,
              confidence: args.confidence,
            },
            {
              messageContext: args.sourceQuote,
            },
          );

          this.logger.log(
            `Created fact ${args.factType}="${args.value}" for entity ${args.entityId} (action: ${result.action})`,
          );

          return toolSuccess({
            factId: result.fact.id,
            action: result.action,
            reason: result.reason,
            existingFactId: result.existingFactId,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'create_fact');
        }
      },
    );
  }

  /**
   * create_relation - Create a relation between entities.
   * Enhanced description to encourage LLM to use this tool more often.
   */
  private createRelationTool() {
    return tool(
      'create_relation',
      `ОБЯЗАТЕЛЬНО создавай связь при любом упоминании отношений между людьми/организациями!

ТРИГГЕРЫ — вызывай create_relation когда видишь:
• Рабочие: "работает в", "устроился в", "уволился из", "коллега", "начальник", "подчинённый", "сотрудник"
• Семейные: "жена", "муж", "сын", "дочь", "брат", "сестра", "родители", "супруг"
• Социальные: "друг", "подруга", "знакомый", "партнёр"

АЛГОРИТМ:
1. Найди обе сущности через find_entity_by_name
2. Если сущность не найдена — создай через create_pending_entity
3. Вызови create_relation с ID обеих сущностей

ТИПЫ СВЯЗЕЙ И РОЛИ:
• employment: employee ↔ employer — "работает в X", "сотрудник Y", "устроился в"
• reporting: subordinate ↔ manager — "начальник", "руководитель", "подчинённый", "босс"
• team: member ↔ lead — "в команде", "тимлид", "коллега"
• marriage: spouse ↔ spouse — "жена", "муж", "супруг(а)"
• parenthood: parent ↔ child — "отец", "мать", "сын", "дочь", "ребёнок"
• siblinghood: sibling ↔ sibling — "брат", "сестра"
• friendship: friend ↔ friend — "друг", "подруга", "лучший друг"
• acquaintance: acquaintance ↔ acquaintance — "знакомый", "знакомая"
• partnership: partner ↔ partner — "партнёр", "бизнес-партнёр"
• client_vendor: client ↔ vendor — "клиент", "поставщик", "заказчик"

ПРИМЕР ПОЛНОГО FLOW:
Сообщение: "Маша работает в Сбере"
1. find_entity_by_name("Маша") → найдено entityId: "abc-123"
2. find_entity_by_name("Сбер") → найдено entityId: "xyz-789"
3. create_relation(employment, [{entityId: "abc-123", role: "employee"}, {entityId: "xyz-789", role: "employer"}])

Если сущность НЕ найдена:
1. find_entity_by_name("Сбер") → пусто
2. create_pending_entity(suggestedName: "Сбер", mentionedAs: "место работы Маши")
3. Связь будет создана позже, когда pending entity будет resolved`,
      {
        relationType: z
          .enum([
            'employment',
            'reporting',
            'team',
            'marriage',
            'parenthood',
            'siblinghood',
            'friendship',
            'acquaintance',
            'partnership',
            'client_vendor',
          ])
          .describe('Тип связи'),
        members: z
          .array(
            z.object({
              entityId: z.string().uuid().describe('UUID участника связи'),
              role: z.string().describe('Роль в связи (employee, employer, spouse, etc.)'),
              label: z.string().optional().describe('Метка (имя, должность) для отображения'),
            }),
          )
          .min(2)
          .describe('Участники связи (минимум 2)'),
        confidence: z.number().min(0).max(1).optional().describe('Уверенность в связи'),
      },
      async (args) => {
        if (!this.entityRelationService) {
          return toolError(
            'EntityRelationService not available',
            'Relation creation is not configured in this environment.',
          );
        }

        try {
          const relation = await this.entityRelationService.create({
            relationType: args.relationType as RelationType,
            members: args.members.map((m) => ({
              entityId: m.entityId,
              role: m.role,
              label: m.label,
            })),
            source: RelationSource.EXTRACTED,
            confidence: args.confidence,
          });

          this.logger.log(
            `Created relation ${args.relationType} with ${args.members.length} members (id: ${relation.id})`,
          );

          return toolSuccess({
            relationId: relation.id,
            relationType: relation.relationType,
            membersCount: relation.members.length,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'create_relation');
        }
      },
    );
  }

  /**
   * create_pending_entity - Create a pending entity for mentioned unknown person.
   *
   * @param context - Message/interaction context for source tracking (avoids singleton state)
   */
  private createPendingEntityTool(context: ExtractionContext) {
    return tool(
      'create_pending_entity',
      `Создать ожидающую сущность для упомянутого человека, которого нет в системе.
Используй когда в сообщении упоминается новый человек, которого не удалось найти через find_entity_by_name.

Pending entity будет ожидать ручного связывания с реальной сущностью или создания новой.`,
      {
        suggestedName: z.string().describe('Предполагаемое имя (например: "Маша", "Иван Петров")'),
        mentionedAs: z.string().describe('Контекст упоминания (например: "жена Ивана", "коллега по работе")'),
        relatedToEntityId: z.string().uuid().optional().describe('UUID связанной сущности если известна'),
      },
      async (args) => {
        if (!this.pendingResolutionService) {
          return toolError(
            'PendingResolutionService not available',
            'Pending entity creation is not configured in this environment.',
          );
        }

        try {
          // Create unique identifierValue to avoid collision for same names
          // Format: name::messageId or name::timestamp if no messageId
          const uniqueSuffix = context.messageId || Date.now().toString();
          const identifierValue = `${args.suggestedName}::${uniqueSuffix}`;

          // Create pending resolution with context from mention
          const pending = await this.pendingResolutionService.findOrCreate({
            identifierType: 'mentioned_name',
            identifierValue,
            displayName: args.suggestedName,
            metadata: {
              mentionedAs: args.mentionedAs,
              relatedToEntityId: args.relatedToEntityId,
              sourceMessageId: context.messageId,
              sourceInteractionId: context.interactionId,
            },
          });

          this.logger.log(
            `Created pending entity for "${args.suggestedName}" (id: ${pending.id})`,
          );

          return toolSuccess({
            pendingId: pending.id,
            suggestedName: args.suggestedName,
            status: pending.status,
            message: 'Pending entity created. Will be resolved later.',
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'create_pending_entity');
        }
      },
    );
  }

  /**
   * create_event - Create an extracted event (meeting, promise, deadline, etc.).
   *
   * @param context - Message/interaction context for source tracking
   */
  private createEventTool(context: ExtractionContext) {
    return tool(
      'create_event',
      `Создать событие (встреча, обещание, дедлайн, день рождения и т.д.)

ТИПЫ СОБЫТИЙ:
- meeting: встречи, созвоны, переговоры — "давай созвонимся", "встреча в 15:00"
- promise_by_me: обещание в ИСХОДЯЩЕМ сообщении (→) — "я пришлю завтра"
- promise_by_them: обещание во ВХОДЯЩЕМ сообщении (←) — "пришлю документы"
- task: задача/запрос — "можешь глянуть документ?"
- fact: личный факт — "у меня ДР 15 марта"
- cancellation: отмена/перенос — "давай перенесём"

ПРАВИЛА ОБЕЩАНИЙ:
- promise_by_me: автор ИСХОДЯЩЕГО сообщения обещает что-то сделать
- promise_by_them: автор ВХОДЯЩЕГО сообщения обещает что-то сделать
- ОПРЕДЕЛЯЙ тип ТОЛЬКО по isOutgoing флагу сообщения, НЕ по тексту

АБСТРАКТНЫЕ СОБЫТИЯ (needsEnrichment=true):
- "давай встретимся" без даты → meeting + needsEnrichment=true
- "надо обсудить" без деталей → meeting + needsEnrichment=true
- "встреча 15 января в 14:00" → meeting + needsEnrichment=false`,
      {
        eventType: z
          .enum(['meeting', 'promise_by_me', 'promise_by_them', 'task', 'fact', 'cancellation'])
          .describe('Тип события'),
        title: z.string().describe('Краткое название события (например: "Созвон с командой", "Прислать отчёт")'),
        description: z.string().optional().describe('Подробное описание если есть'),
        date: z.string().optional().describe('Дата/время ISO 8601 если известна (например: "2025-01-30T14:00:00")'),
        entityId: z.string().uuid().describe('UUID сущности-владельца события'),
        sourceMessageId: z.string().uuid().describe('UUID исходного сообщения (msgId из метаданных)'),
        confidence: z.number().min(0).max(1).describe('Уверенность 0-1'),
        sourceQuote: z.string().max(200).optional().describe('Цитата из сообщения (до 200 символов)'),
        needsEnrichment: z
          .boolean()
          .default(false)
          .describe('true если событие абстрактное (нет даты/деталей) и требует уточнения'),
        promiseToEntityId: z
          .string()
          .uuid()
          .optional()
          .describe('UUID получателя обещания (для promise_by_me, берётся из promiseToEntityId сообщения)'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Доп. данные (participants, location и т.д.)'),
      },
      async (args) => {
        try {
          const eventType = args.eventType as ExtractedEventType;

          // Build extractedData based on event type
          const extractedData = this.buildEventData(eventType, args);

          const event = this.extractedEventRepo.create({
            sourceMessageId: args.sourceMessageId,
            sourceInteractionId: context.interactionId,
            entityId: args.entityId,
            promiseToEntityId: args.promiseToEntityId || null,
            eventType,
            extractedData,
            sourceQuote: args.sourceQuote?.substring(0, 200) || null,
            confidence: Math.min(1, Math.max(0, args.confidence)),
            status: ExtractedEventStatus.PENDING,
            needsContext: false,
          });

          const saved = await this.extractedEventRepo.save(event);

          // Queue for enrichment if event is abstract
          if (args.needsEnrichment && this.enrichmentQueueService) {
            try {
              await this.enrichmentQueueService.queueForEnrichment(saved.id);
              this.logger.debug(`Queued event ${saved.id} for context enrichment`);
            } catch (queueError) {
              this.logger.warn(`Failed to queue event for enrichment: ${queueError}`);
            }
          }

          this.logger.log(
            `Created event ${eventType} "${args.title}" for entity ${args.entityId} (id: ${saved.id})`,
          );

          return toolSuccess({
            eventId: saved.id,
            eventType: saved.eventType,
            status: saved.status,
            needsEnrichment: args.needsEnrichment,
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'create_event');
        }
      },
    );
  }

  /**
   * Build type-specific extractedData for an event.
   */
  private buildEventData(
    eventType: ExtractedEventType,
    args: {
      title: string;
      description?: string;
      date?: string;
      metadata?: Record<string, unknown>;
    },
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {};

    switch (eventType) {
      case ExtractedEventType.MEETING:
        return {
          ...base,
          topic: args.title,
          datetime: args.date || undefined,
          dateText: args.description || undefined,
          participants: (args.metadata?.participants as string[]) || undefined,
        };

      case ExtractedEventType.PROMISE_BY_ME:
      case ExtractedEventType.PROMISE_BY_THEM:
        return {
          ...base,
          what: args.title,
          deadline: args.date || undefined,
          deadlineText: args.description || undefined,
        };

      case ExtractedEventType.TASK:
        return {
          ...base,
          what: args.title,
          deadline: args.date || undefined,
          deadlineText: args.description || undefined,
          priority: (args.metadata?.priority as string) || undefined,
        };

      case ExtractedEventType.FACT:
        return {
          ...base,
          factType: (args.metadata?.factType as string) || 'general',
          value: args.title,
          quote: args.description || '',
        };

      case ExtractedEventType.CANCELLATION:
        return {
          ...base,
          what: args.title,
          newDateTime: args.date || undefined,
          newDateText: args.description || undefined,
          reason: (args.metadata?.reason as string) || undefined,
        };

      default:
        return { ...base, title: args.title, description: args.description };
    }
  }
}
