import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
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
import { FactSource, RelationType, RelationSource, FactCategory } from '@pkg/entities';

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
@Injectable()
export class ExtractionToolsProvider {
  private readonly logger = new Logger(ExtractionToolsProvider.name);
  private cachedTools: ToolDefinition[] | null = null;

  /** Current message ID for source tracking - set before tool execution */
  private currentMessageId: string | null = null;
  private currentInteractionId: string | null = null;

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
  ) {}

  /**
   * Set message context for tool execution.
   * Call before running extraction agent.
   */
  setMessageContext(messageId: string | null, interactionId?: string | null): void {
    this.currentMessageId = messageId;
    this.currentInteractionId = interactionId ?? null;
  }

  /**
   * Get extraction tools (cached).
   */
  getTools(): ToolDefinition[] {
    if (!this.cachedTools) {
      this.cachedTools = this.createTools();
      this.logger.debug(`Created ${this.cachedTools.length} extraction tools`);
    }
    return this.cachedTools;
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
    return this.getTools().map((t) => `mcp__${EXTRACTION_MCP_NAME}__${t.name}`);
  }

  /**
   * Create MCP server with extraction tools.
   */
  createMcpServer(): ReturnType<typeof createSdkMcpServer> {
    const tools = this.getTools();
    return createSdkMcpServer({
      name: EXTRACTION_MCP_NAME,
      version: '1.0.0',
      tools,
    });
  }

  /**
   * Create tool definitions.
   */
  private createTools(): ToolDefinition[] {
    return [
      // Read tools
      this.createGetEntityContextTool(),
      this.createFindEntityByNameTool(),

      // Write tools
      this.createFactTool(),
      this.createRelationTool(),
      this.createPendingEntityTool(),
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
            },
            {
              messageContext: args.sourceQuote,
            },
          );

          this.logger.log(
            `Created fact ${args.factType}="${args.value}" for entity ${args.entityId.slice(0, 8)}... (action: ${result.action})`,
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
   */
  private createRelationTool() {
    return tool(
      'create_relation',
      `Создать связь между сущностями.

Типы связей и роли:
- employment: employee (работник), employer (работодатель)
- reporting: subordinate (подчинённый), manager (руководитель)
- team: member (участник), lead (лидер)
- marriage: spouse (супруг/супруга)
- parenthood: parent (родитель), child (ребёнок)
- siblinghood: sibling (брат/сестра)
- friendship: friend (друг)
- acquaintance: acquaintance (знакомый)
- partnership: partner (партнёр)
- client_vendor: client (клиент), vendor (поставщик)

Примеры:
- "работает в Сбере" → employment: [{entityId: person, role: "employee"}, {entityId: org, role: "employer"}]
- "мой начальник" → reporting: [{entityId: me, role: "subordinate"}, {entityId: boss, role: "manager"}]
- "жена" → marriage: [{entityId: p1, role: "spouse"}, {entityId: p2, role: "spouse"}]`,
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
            `Created relation ${args.relationType} with ${args.members.length} members (id: ${relation.id.slice(0, 8)}...)`,
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
   */
  private createPendingEntityTool() {
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
          // Create pending resolution with context from mention
          // Using 'as any' because metadata schema doesn't include extraction-specific fields
          const pending = await this.pendingResolutionService.findOrCreate({
            identifierType: 'mentioned_name',
            identifierValue: args.suggestedName,
            displayName: args.suggestedName,
            metadata: {
              mentionedAs: args.mentionedAs,
              relatedToEntityId: args.relatedToEntityId,
              sourceMessageId: this.currentMessageId,
              sourceInteractionId: this.currentInteractionId,
            } as any,
          });

          this.logger.log(
            `Created pending entity for "${args.suggestedName}" (id: ${pending.id.slice(0, 8)}...)`,
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
}
