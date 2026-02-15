import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not, ILike } from 'typeorm';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ProjectMatchingService } from '../project-matching.service';
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
import { DraftExtractionService } from '../draft-extraction.service';
import { isVagueContent, isNoiseContent } from '../extraction-quality.constants';
import {
  FactSource,
  RelationType,
  RelationSource,
  FactCategory,
  ExtractedEvent,
  ExtractedEventType,
  ExtractedEventStatus,
  PendingApprovalItemType,
  EntityType,
  CreationSource,
  Activity,
  ActivityType,
  ActivityStatus,
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
  /** Owner entity ID (the user) - required for draft creation */
  ownerEntityId: string | null;
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
    @Optional()
    @Inject(forwardRef(() => DraftExtractionService))
    private readonly draftExtractionService: DraftExtractionService | null,
    @InjectRepository(Activity)
    private readonly activityRepo: Repository<Activity>,
    @Optional()
    private readonly projectMatchingService: ProjectMatchingService | null,
  ) {}

  /**
   * Get extraction tools for a specific context.
   * Tools are created fresh per context to avoid singleton state issues.
   *
   * @param context - Message/interaction context for source tracking
   */
  getTools(context?: ExtractionContext): ToolDefinition[] {
    // Create tools fresh with context to avoid singleton race condition
    const tools = this.createTools(context ?? { messageId: null, interactionId: null, ownerEntityId: null });
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
      this.createFindActivityTool(context),

      // Write tools - all require context for draft creation
      this.createFactTool(context),
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
   * find_activity - Search for existing Activity (project, task) by name.
   * Uses ILIKE + fuzzy matching via ProjectMatchingService to prevent duplicates.
   *
   * @param context - Extraction context with ownerEntityId
   */
  private createFindActivityTool(context: ExtractionContext) {
    return tool(
      'find_activity',
      `Поиск существующей активности (проекта, задачи) по имени.
ОБЯЗАТЕЛЬНО используй ПЕРЕД create_event для проверки — не создавай дубликат!
Возвращает top-5 matches с similarity score.`,
      {
        query: z.string().min(2).describe('Поисковый запрос — имя проекта/задачи'),
        type: z
          .enum(['AREA', 'BUSINESS', 'PROJECT', 'TASK', 'INITIATIVE'])
          .optional()
          .describe('Фильтр по типу активности'),
      },
      async (args) => {
        if (!context.ownerEntityId) {
          return toolError(
            'Owner entity ID not provided',
            'Cannot search activities without owner entity context.',
          );
        }

        try {
          // Run ILIKE search and fuzzy search in parallel
          const excludedStatuses = [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED];

          const ilikeWhereConditions: Record<string, unknown> = {
            ownerEntityId: context.ownerEntityId,
            name: ILike(`%${args.query}%`),
            status: Not(In(excludedStatuses)),
          };
          if (args.type) {
            ilikeWhereConditions.activityType = args.type.toLowerCase() as ActivityType;
          }

          const [ilikeResults, fuzzyResults] = await Promise.all([
            // a. ILIKE search
            this.activityRepo.find({
              where: ilikeWhereConditions,
              select: ['id', 'name', 'activityType', 'status', 'clientEntityId'],
              relations: ['clientEntity'],
              order: { lastActivityAt: { direction: 'DESC', nulls: 'LAST' } },
              take: 10,
            }),
            // b. Fuzzy search via ProjectMatchingService
            this.projectMatchingService
              ? this.projectMatchingService.findCandidates({
                  name: args.query,
                  ownerEntityId: context.ownerEntityId,
                  activityType: args.type
                    ? (args.type.toLowerCase() as ActivityType)
                    : undefined,
                  limit: 5,
                })
              : Promise.resolve([]),
          ]);

          // Merge results, deduplicate by id
          const seenIds = new Set<string>();
          const merged: Array<{
            id: string;
            name: string;
            type: string;
            status: string;
            similarity: number;
            client: string | null;
          }> = [];

          // ILIKE matches first (similarity = 1.0 for exact substring match)
          for (const activity of ilikeResults) {
            if (!seenIds.has(activity.id)) {
              seenIds.add(activity.id);
              merged.push({
                id: activity.id,
                name: activity.name,
                type: activity.activityType,
                status: activity.status,
                similarity: 1.0,
                client: activity.clientEntity?.name || null,
              });
            }
          }

          // Fuzzy matches sorted by similarity
          for (const candidate of fuzzyResults) {
            if (!seenIds.has(candidate.activity.id)) {
              seenIds.add(candidate.activity.id);
              merged.push({
                id: candidate.activity.id,
                name: candidate.activity.name,
                type: candidate.activity.activityType,
                status: candidate.activity.status,
                similarity: Math.round(candidate.similarity * 1000) / 1000,
                client: null, // clientEntity not loaded in fuzzy search
              });
            }
          }

          // Sort: ILIKE matches first (similarity=1.0), then by similarity desc
          merged.sort((a, b) => b.similarity - a.similarity);

          // Return top 5
          const top5 = merged.slice(0, 5);

          if (top5.length === 0) {
            return toolEmptyResult('activities matching query');
          }

          this.logger.debug(
            `[find_activity] Found ${top5.length} matches for "${args.query}" ` +
              `(ILIKE: ${ilikeResults.length}, fuzzy: ${fuzzyResults.length})`,
          );

          return toolSuccess(top5);
        } catch (error) {
          return handleToolError(error, this.logger, 'find_activity');
        }
      },
    );
  }

  /**
   * create_fact - Create a draft fact for an entity (requires approval).
   * Uses DraftExtractionService to create EntityFact with status=DRAFT + PendingApproval.
   */
  private createFactTool(context: ExtractionContext) {
    return tool(
      'create_fact',
      `Создать факт для сущности. Факт создаётся как ЧЕРНОВИК и требует подтверждения пользователем.

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
        if (!this.draftExtractionService) {
          return toolError(
            'DraftExtractionService not available',
            'Draft fact creation is not configured in this environment.',
          );
        }

        if (!context.ownerEntityId) {
          return toolError(
            'Owner entity ID not provided',
            'Cannot create draft fact without owner entity context.',
          );
        }

        try {
          const result = await this.draftExtractionService.createDrafts({
            ownerEntityId: context.ownerEntityId,
            facts: [
              {
                entityId: args.entityId,
                factType: args.factType.toLowerCase(),
                value: args.value.trim(),
                sourceQuote: args.sourceQuote?.substring(0, 200),
                confidence: args.confidence,
              },
            ],
            tasks: [],
            commitments: [],
            projects: [],
            sourceInteractionId: context.interactionId ?? undefined,
          });

          if (result.counts.facts > 0) {
            const approval = result.approvals.find(
              (a) => a.itemType === PendingApprovalItemType.FACT,
            );
            this.logger.log(
              `Created draft fact ${args.factType}="${args.value}" for entity ${args.entityId} ` +
                `(approvalId: ${approval?.id}, batchId: ${result.batchId})`,
            );

            return toolSuccess({
              status: 'draft_created',
              approvalId: approval?.id,
              batchId: result.batchId,
              message: 'Fact created as draft, pending user approval.',
            });
          }

          // Smart Fusion: fact was resolved via fusion (CONFIRM, SUPERSEDE, ENRICH, etc.)
          if (result.fusionActions && result.fusionActions.length > 0) {
            const fa = result.fusionActions[0];
            const fusionMessages: Record<string, string> = {
              confirm: 'Fact confirmed — boosted confidence on existing fact.',
              supersede: 'New value superseded old fact. Old fact deprecated, new fact created.',
              enrich: 'Existing fact enriched with complementary information.',
              conflict: 'Conflict detected — both facts kept for human review.',
              coexist: 'Both values valid (different time periods). New fact created alongside existing.',
            };
            const message = fusionMessages[fa.action] || `Fusion action: ${fa.action}`;
            this.logger.log(
              `Smart Fusion [${fa.action}] for ${args.factType}="${args.value}" entity=${args.entityId} ` +
                `existingFact=${fa.existingFactId} resultFact=${fa.resultFactId ?? 'n/a'} reason="${fa.reason}"`,
            );
            return toolSuccess({
              status: `fusion_${fa.action}`,
              action: fa.action,
              existingFactId: fa.existingFactId,
              resultFactId: fa.resultFactId,
              reason: fa.reason,
              message,
            });
          }

          if (result.skipped.facts > 0) {
            this.logger.debug(
              `Skipped duplicate fact ${args.factType}="${args.value}" for entity ${args.entityId}`,
            );
            return toolSuccess({
              status: 'skipped_duplicate',
              message: 'Similar fact already pending approval.',
            });
          }

          return toolError('Failed to create draft fact', result.errors[0]?.error || 'Unknown error');
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
   * Also creates a real Entity immediately so that create_fact and create_relation
   * can reference it by entityId in the same extraction session.
   *
   * @param context - Message/interaction context for source tracking (avoids singleton state)
   */
  private createPendingEntityTool(context: ExtractionContext) {
    return tool(
      'create_pending_entity',
      `Создать новую сущность для упомянутого человека/организации, которых нет в системе.
Используй когда в сообщении упоминается новый человек, которого не удалось найти через find_entity_by_name.

Создаёт реальную Entity сразу и возвращает entityId — используй его для create_fact и create_relation.`,
      {
        suggestedName: z.string().describe('Предполагаемое имя (например: "Маша", "Иван Петров", "Жена Ивана")'),
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
          // Check if entity with matching telegram_username already exists
          const cleanName = args.suggestedName.replace(/^@/, '');
          if (cleanName.length >= 3) {
            const existing = await this.entityService.findAll({
              search: cleanName,
              limit: 5,
            });
            const match = existing.items.find((e) =>
              e.identifiers?.some(
                (i) =>
                  i.identifierType === 'telegram_username' &&
                  i.identifierValue.toLowerCase() === cleanName.toLowerCase(),
              ),
            );
            if (match) {
              this.logger.log(
                `Found existing entity "${match.name}" (${match.id}) by telegram_username "${cleanName}" — skipping creation`,
              );
              return toolSuccess({
                entityId: match.id,
                suggestedName: match.name,
                status: 'already_exists',
                message: `Entity "${match.name}" already has telegram username "${cleanName}". Use this entityId.`,
              });
            }
          }

          // Create unique identifierValue to avoid collision for same names
          // Format: name::messageId or name::timestamp if no messageId
          const uniqueSuffix = context.messageId || Date.now().toString();
          const identifierValue = `${args.suggestedName}::${uniqueSuffix}`;

          // 1. Create pending resolution with context from mention
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

          // 2. Create real Entity with CreationSource.EXTRACTED
          const entity = await this.entityService.create({
            type: EntityType.PERSON,
            name: args.suggestedName,
            creationSource: CreationSource.EXTRACTED,
            notes: `Автоматически создан из извлечения. Контекст: ${args.mentionedAs}`,
          });

          // 3. Link PendingEntityResolution to the real Entity
          await this.pendingResolutionService.linkToEntity(pending.id, entity.id);

          this.logger.log(
            `Created entity "${args.suggestedName}" (entityId: ${entity.id}) and linked pending resolution (pendingId: ${pending.id})`,
          );

          return toolSuccess({
            pendingId: pending.id,
            entityId: entity.id,
            suggestedName: args.suggestedName,
            status: pending.status,
            message: 'Entity created. Use entityId for create_fact and create_relation.',
          });
        } catch (error) {
          return handleToolError(error, this.logger, 'create_pending_entity');
        }
      },
    );
  }

  /**
   * create_event - Create a draft event (commitment/task) that requires approval.
   * Uses DraftExtractionService to create draft entities + PendingApproval records.
   *
   * Event type mapping:
   * - meeting → Commitment (type=MEETING)
   * - promise_by_me → Commitment (type=PROMISE, from=self)
   * - promise_by_them → Commitment (type=REQUEST, from=contact)
   * - task → Activity (type=TASK)
   * - fact → EntityFact (via create_fact tool instead)
   * - cancellation → skipped (not useful for pending approval flow)
   *
   * @param context - Message/interaction context for source tracking
   */
  private createEventTool(context: ExtractionContext) {
    return tool(
      'create_event',
      `Создать событие (встреча, обещание, задача). Событие создаётся как ЧЕРНОВИК и требует подтверждения.

ТИПЫ СОБЫТИЙ:
- meeting: встречи, созвоны, переговоры — "давай созвонимся", "встреча в 15:00"
- promise_by_me: обещание в ИСХОДЯЩЕМ сообщении (→) — "я пришлю завтра"
- promise_by_them: обещание во ВХОДЯЩЕМ сообщении (←) — "пришлю документы"
- task: задача/запрос — "можешь глянуть документ?"
- fact: личный факт — ИСПОЛЬЗУЙ create_fact вместо этого!
- cancellation: отмена/перенос — пропускается (не требует сохранения)

ПРАВИЛА ОБЕЩАНИЙ:
- promise_by_me: автор ИСХОДЯЩЕГО сообщения обещает что-то сделать
- promise_by_them: автор ВХОДЯЩЕГО сообщения обещает что-то сделать
- ОПРЕДЕЛЯЙ тип ТОЛЬКО по isOutgoing флагу сообщения, НЕ по тексту

ЗАПОЛНЯЙ priority, deadline и tags ЕСЛИ они упоминаются в разговоре.`,
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
        sourceQuote: z.string().max(200).describe('Цитата из сообщения — ОБЯЗАТЕЛЬНО (до 200 символов)'),
        needsEnrichment: z
          .boolean()
          .default(false)
          .describe('true если событие абстрактное (нет даты/деталей) и требует уточнения'),
        promiseToEntityId: z
          .string()
          .uuid()
          .optional()
          .describe('UUID получателя обещания (для promise_by_me, берётся из promiseToEntityId сообщения)'),
        activityId: z
          .string()
          .uuid()
          .optional()
          .describe('UUID существующей активности (проекта/задачи), если событие к ней относится. Берётся из секции АКТИВНОСТИ.'),
        projectName: z
          .string()
          .optional()
          .describe('Имя проекта, если activityId неизвестен — система найдёт ближайшее совпадение через fuzzy match'),
        priority: z
          .enum(['none', 'low', 'medium', 'high', 'urgent'])
          .optional()
          .describe('Приоритет задачи/проекта, если упоминается в разговоре'),
        deadline: z
          .string()
          .optional()
          .describe('Дедлайн в формате ISO 8601 (например: "2026-03-15"), если упоминается'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Теги/категории проекта (например: ["дизайн", "клиент", "срочно"])'),
        metadata: z.record(z.string(), z.unknown()).optional().describe('Доп. данные (participants, location и т.д.)'),
      },
      async (args) => {
        // Skip cancellation events - they don't need to be saved
        if (args.eventType === 'cancellation') {
          this.logger.debug(`Skipping cancellation event: "${args.title}"`);
          return toolSuccess({
            status: 'skipped',
            reason: 'Cancellation events are not saved to pending approval.',
          });
        }

        // Redirect fact type to create_fact tool
        if (args.eventType === 'fact') {
          return toolError(
            'Use create_fact tool instead',
            'For personal facts like birthdays, use the create_fact tool with appropriate factType.',
          );
        }

        if (!this.draftExtractionService) {
          return toolError(
            'DraftExtractionService not available',
            'Draft event creation is not configured in this environment.',
          );
        }

        if (!context.ownerEntityId) {
          return toolError(
            'Owner entity ID not provided',
            'Cannot create draft event without owner entity context.',
          );
        }

        // Noise / vague content filter
        const contentToCheck = args.title + (args.description ? ' ' + args.description : '');
        if (isNoiseContent(contentToCheck)) {
          this.logger.debug(`[create_event] Filtered noise: "${args.title}"`);
          return toolError(
            'Event content is too short or technical noise',
            'Skip this event — it does not carry actionable real-world information. Focus on concrete tasks, promises and meetings.',
          );
        }
        if (isVagueContent(args.title)) {
          this.logger.debug(`[create_event] Filtered vague: "${args.title}"`);
          return toolError(
            'Event title is too vague',
            'Title contains placeholder words (что-то, как-нибудь, кое-что). ' +
            'Use specific details from conversation: project name, action object, person. ' +
            'Example: instead of "переделать что-то" use "перенести транскрибацию на внутренний сервис для invapp-panavto".',
          );
        }

        try {
          // Map event type to appropriate draft entity
          if (args.eventType === 'task') {
            // Create draft task (Activity with type=TASK)
            const taskPriority = args.priority && args.priority !== 'none'
              ? (args.priority === 'urgent' ? 'high' : args.priority as 'high' | 'medium' | 'low')
              : 'medium';
            const result = await this.draftExtractionService.createDrafts({
              ownerEntityId: context.ownerEntityId,
              facts: [],
              tasks: [
                {
                  title: args.title,
                  projectName: args.projectName,
                  deadline: args.deadline ?? args.date,
                  status: 'pending',
                  priority: taskPriority,
                  sourceQuote: args.sourceQuote?.substring(0, 200),
                  confidence: args.confidence,
                },
              ],
              commitments: [],
              projects: [],
              sourceInteractionId: context.interactionId ?? undefined,
            });

            if (result.counts.tasks > 0) {
              const approval = result.approvals.find(
                (a) => a.itemType === PendingApprovalItemType.TASK,
              );
              this.logger.log(
                `Created draft task "${args.title}" (approvalId: ${approval?.id}, batchId: ${result.batchId})`,
              );

              return toolSuccess({
                status: 'draft_created',
                itemType: 'task',
                approvalId: approval?.id,
                batchId: result.batchId,
                message: 'Task created as draft, pending user approval.',
              });
            }

            if (result.skipped.tasks > 0) {
              return toolSuccess({
                status: 'skipped_duplicate',
                message: 'Similar task already pending approval.',
              });
            }

            return toolError('Failed to create draft task', result.errors[0]?.error || 'Unknown error');
          }

          // Map meeting and promises to commitments
          const commitmentType = this.mapEventTypeToCommitmentType(args.eventType);
          const { from, to } = this.resolveCommitmentParties(
            args.eventType,
            args.entityId,
            args.promiseToEntityId,
          );

          const commitPriority = args.priority && args.priority !== 'none'
            ? (args.priority === 'urgent' ? 'high' : args.priority as 'high' | 'medium' | 'low')
            : 'medium';
          const result = await this.draftExtractionService.createDrafts({
            ownerEntityId: context.ownerEntityId,
            facts: [],
            tasks: [],
            commitments: [
              {
                what: args.title,
                from,
                to,
                type: commitmentType,
                deadline: args.deadline ?? args.date,
                priority: commitPriority,
                projectName: args.projectName,
                sourceQuote: args.sourceQuote?.substring(0, 200),
                confidence: args.confidence,
              },
            ],
            projects: [],
            sourceInteractionId: context.interactionId ?? undefined,
          });

          if (result.counts.commitments > 0) {
            const approval = result.approvals.find(
              (a) => a.itemType === PendingApprovalItemType.COMMITMENT,
            );
            this.logger.log(
              `Created draft commitment (${commitmentType}) "${args.title}" ` +
                `(approvalId: ${approval?.id}, batchId: ${result.batchId})`,
            );

            return toolSuccess({
              status: 'draft_created',
              itemType: 'commitment',
              commitmentType,
              approvalId: approval?.id,
              batchId: result.batchId,
              message: 'Commitment created as draft, pending user approval.',
            });
          }

          if (result.skipped.commitments > 0) {
            return toolSuccess({
              status: 'skipped_duplicate',
              message: 'Similar commitment already pending approval.',
            });
          }

          return toolError('Failed to create draft commitment', result.errors[0]?.error || 'Unknown error');
        } catch (error) {
          return handleToolError(error, this.logger, 'create_event');
        }
      },
    );
  }

  /**
   * Map event type to commitment type.
   */
  private mapEventTypeToCommitmentType(
    eventType: string,
  ): 'promise' | 'request' | 'agreement' | 'deadline' | 'reminder' | 'meeting' {
    switch (eventType) {
      case 'meeting':
        return 'meeting';
      case 'promise_by_me':
        return 'promise';
      case 'promise_by_them':
        return 'request';
      default:
        return 'promise';
    }
  }

  /**
   * Resolve from/to parties for commitment based on event type.
   * Returns 'self' or entity ID string.
   */
  private resolveCommitmentParties(
    eventType: string,
    entityId: string,
    promiseToEntityId?: string,
  ): { from: string; to: string } {
    switch (eventType) {
      case 'promise_by_me':
        // I promised something to the contact
        return {
          from: 'self',
          to: promiseToEntityId || entityId,
        };
      case 'promise_by_them':
        // Contact promised something to me
        return {
          from: entityId,
          to: 'self',
        };
      case 'meeting':
        // Mutual agreement
        return {
          from: 'self',
          to: entityId,
        };
      default:
        return {
          from: 'self',
          to: entityId,
        };
    }
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
