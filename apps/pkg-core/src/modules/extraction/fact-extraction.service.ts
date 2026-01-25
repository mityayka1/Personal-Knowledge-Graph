import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { PendingFactService } from '../resolution/pending-fact/pending-fact.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { ExtractionToolsProvider, EXTRACTION_MCP_NAME } from './tools/extraction-tools.provider';

export interface ExtractedFact {
  factType: string;
  value: string;
  confidence: number;
  sourceQuote: string;
}

export interface ExtractionResult {
  entityId: string;
  facts: ExtractedFact[];
  tokensUsed?: number;
}

export interface AgentExtractionResult {
  /** Primary entity ID for the conversation */
  entityId: string;
  /** Number of facts created (across all entities) */
  factsCreated: number;
  /** Number of relations created */
  relationsCreated: number;
  /** Number of pending entities created */
  pendingEntitiesCreated: number;
  /** Agent turns used */
  turns?: number;
  /** Tools used by agent */
  toolsUsed?: string[];
  /** Token usage */
  tokensUsed?: number;
}

// JSON Schema for structured output
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          factType: { type: 'string' },
          value: { type: 'string' },
          confidence: { type: 'number' },
          sourceQuote: { type: 'string' },
        },
        required: ['factType', 'value', 'confidence', 'sourceQuote'],
      },
    },
  },
  required: ['facts'],
};

interface FactsExtractionResponse {
  facts: ExtractedFact[];
}

// JSON Schema for agent extraction response
const AGENT_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    factsCreated: {
      type: 'number',
      description: 'Number of facts created via create_fact tool',
    },
    relationsCreated: {
      type: 'number',
      description: 'Number of relations created via create_relation tool',
    },
    pendingEntitiesCreated: {
      type: 'number',
      description: 'Number of pending entities created via create_pending_entity tool',
    },
    summary: {
      type: 'string',
      description: 'Brief summary of what was extracted',
    },
  },
  required: ['factsCreated', 'relationsCreated', 'pendingEntitiesCreated'],
};

// Extraction limits
const MIN_MESSAGE_LENGTH = 20;
const ONESHOT_CONTENT_LIMIT = 1500;
const AGENT_CONTENT_LIMIT = 2000;
const CONTEXT_SIZE_LIMIT = 3000;
const SOURCE_QUOTE_MAX_LENGTH = 200;
const SEARCH_TEXT_MAX_LENGTH = 500;

// Chat type Russian localization
const CHAT_TYPE_MAP: Record<string, string> = {
  private: 'личный диалог',
  group: 'групповой чат',
  supergroup: 'супергруппа',
  channel: 'канал',
  forum: 'форум',
};

@Injectable()
export class FactExtractionService {
  private readonly logger = new Logger(FactExtractionService.name);

  constructor(
    private pendingFactService: PendingFactService,
    private claudeAgentService: ClaudeAgentService,
    @Optional()
    @Inject(forwardRef(() => EntityFactService))
    private entityFactService: EntityFactService | null,
    @Optional()
    @Inject(forwardRef(() => ExtractionToolsProvider))
    private extractionToolsProvider: ExtractionToolsProvider | null,
  ) {}

  /**
   * Extract facts from message - optimized for token economy
   */
  async extractFacts(params: {
    entityId: string;
    entityName: string;
    messageContent: string;
    messageId?: string;
    interactionId?: string;
    /** Message context for better extraction accuracy */
    context?: {
      /** Is this an outgoing message (from user to contact)? */
      isOutgoing?: boolean;
      /** Chat type: private, group, supergroup, channel */
      chatType?: string;
      /** Name of message sender */
      senderName?: string;
    };
  }): Promise<ExtractionResult> {
    const { entityId, entityName, messageContent, messageId, interactionId, context } = params;

    // Skip very short messages
    if (messageContent.length < MIN_MESSAGE_LENGTH) {
      return { entityId, facts: [] };
    }

    // Truncate very long messages to save tokens
    const truncatedContent = messageContent.length > ONESHOT_CONTENT_LIMIT
      ? messageContent.substring(0, ONESHOT_CONTENT_LIMIT) + '...'
      : messageContent;

    // Get entity memory context for context-aware extraction
    let entityMemory = '';
    if (this.entityFactService) {
      try {
        entityMemory = await this.entityFactService.getContextForExtraction(entityId);
      } catch (error) {
        this.logger.warn(`Failed to get entity context: ${error}`);
      }
    }

    const prompt = this.buildCompactPrompt(entityName, truncatedContent, context, entityMemory);

    try {
      const { data, usage } = await this.claudeAgentService.call<FactsExtractionResponse>({
        mode: 'oneshot',
        taskType: 'fact_extraction',
        prompt,
        schema: FACTS_SCHEMA,
        model: 'haiku',
        maxTurns: 5,
        referenceType: 'message',
        referenceId: messageId,
        timeout: 60000,
      });

      const rawFacts = data.facts || [];

      // Filter and normalize facts
      const validFacts = rawFacts
        .filter(f => f.factType && f.value && typeof f.confidence === 'number' && f.confidence >= 0.6)
        .map(f => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, SOURCE_QUOTE_MAX_LENGTH),
        }));

      // Try to save extracted facts as pending (don't fail if save fails)
      for (const fact of validFacts) {
        try {
          await this.pendingFactService.create({
            entityId,
            factType: fact.factType,
            value: fact.value,
            confidence: fact.confidence,
            sourceQuote: fact.sourceQuote,
            sourceMessageId: messageId,
            sourceInteractionId: interactionId,
          });
        } catch (saveError) {
          const msg = saveError instanceof Error ? saveError.message : String(saveError);
          this.logger.warn(`Failed to save pending fact: ${msg}`);
        }
      }

      this.logger.log(`Extracted ${validFacts.length} facts for ${entityName}`);
      return {
        entityId,
        facts: validFacts,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Extraction failed: ${message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Batch extract from multiple messages - more efficient
   */
  async extractFactsBatch(params: {
    entityId: string;
    entityName: string;
    messages: Array<{
      id: string;
      content: string;
      interactionId?: string;
      /** Is this an outgoing message (from user to contact)? */
      isOutgoing?: boolean;
      /** Name of message sender (for group chats) */
      senderName?: string;
    }>;
    /** Chat type for context */
    chatType?: string;
  }): Promise<ExtractionResult> {
    const { entityId, entityName, messages, chatType } = params;

    // Get entity memory context for context-aware extraction
    let entityMemory = '';
    if (this.entityFactService) {
      try {
        entityMemory = await this.entityFactService.getContextForExtraction(entityId);
      } catch (error) {
        this.logger.warn(`Failed to get entity context for batch: ${error}`);
      }
    }

    // Combine messages into single context with direction markers
    const combined = messages
      .map((m, i) => {
        const direction = m.isOutgoing !== undefined
          ? (m.isOutgoing ? '[Я]' : `[${m.senderName || entityName}]`)
          : `[${i + 1}]`;
        return `${direction} ${m.content}`;
      })
      .join('\n---\n')
      .substring(0, CONTEXT_SIZE_LIMIT); // Limit total size

    const prompt = this.buildBatchPrompt(entityName, combined, chatType, entityMemory);

    try {
      const { data, usage } = await this.claudeAgentService.call<FactsExtractionResponse>({
        mode: 'oneshot',
        taskType: 'fact_extraction',
        prompt,
        schema: FACTS_SCHEMA,
        model: 'haiku',
        maxTurns: 5,
        timeout: 90000,
      });

      const rawFacts = data.facts || [];

      // Filter and normalize facts
      const validFacts = rawFacts
        .filter(f => f.factType && f.value && typeof f.confidence === 'number' && f.confidence >= 0.6)
        .map(f => ({
          factType: f.factType.toLowerCase(),
          value: String(f.value).trim(),
          confidence: Math.min(1, Math.max(0, f.confidence)),
          sourceQuote: String(f.sourceQuote || '').substring(0, SOURCE_QUOTE_MAX_LENGTH),
        }));

      for (const fact of validFacts) {
        await this.pendingFactService.create({
          entityId,
          factType: fact.factType,
          value: fact.value,
          confidence: fact.confidence,
          sourceQuote: fact.sourceQuote,
          sourceInteractionId: messages[0]?.interactionId,
        });
      }

      return {
        entityId,
        facts: validFacts,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch extraction failed: ${message}`);
      return { entityId, facts: [] };
    }
  }

  /**
   * Compact prompt for single message with context
   */
  private buildCompactPrompt(
    name: string,
    text: string,
    context?: { isOutgoing?: boolean; chatType?: string; senderName?: string },
    entityMemory?: string,
  ): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, SEARCH_TEXT_MAX_LENGTH);

    // Build context description
    let contextDesc = '';
    if (context) {
      const parts: string[] = [];

      if (context.isOutgoing !== undefined) {
        parts.push(context.isOutgoing ? 'Я написал собеседнику' : 'Собеседник написал мне');
      }

      if (context.chatType) {
        parts.push(`чат: ${CHAT_TYPE_MAP[context.chatType] || context.chatType}`);
      }

      if (context.senderName) {
        parts.push(`автор: ${context.senderName}`);
      }

      if (parts.length > 0) {
        contextDesc = `\nКонтекст: ${parts.join(', ')}`;
      }
    }

    // Build memory section
    const memorySection = entityMemory
      ? `\n═══════════════════════════════════════════════════════════\n${entityMemory}\n═══════════════════════════════════════════════════════════\n`
      : '';

    return `Извлеки факты о ${name}. Типы фактов: position (должность), company (компания), department (отдел), phone, email, telegram, birthday (день рождения).
ВАЖНО:
- Все значения фактов должны быть на русском языке
- Извлекай факты ТОЛЬКО о ${name}, не о других людях
- Если факт уже известен из памяти — не дублируй его
- Извлекай ТОЛЬКО НОВЫЕ факты, которых нет в памяти${contextDesc}
${memorySection}
Текст: ${cleanText}`;
  }

  /**
   * Batch prompt for multiple messages
   */
  private buildBatchPrompt(
    name: string,
    text: string,
    chatType?: string,
    entityMemory?: string,
  ): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, 1000);

    // Build context description
    let contextDesc = '';
    if (chatType) {
      contextDesc = `\nЭто ${CHAT_TYPE_MAP[chatType] || chatType}.`;
    }

    // Build memory section
    const memorySection = entityMemory
      ? `\n═══════════════════════════════════════════════════════════\n${entityMemory}\n═══════════════════════════════════════════════════════════\n`
      : '';

    return `Извлеки факты о ${name}. Удали дубликаты. Типы фактов: position (должность), company (компания), department (отдел), phone, email, telegram, birthday (день рождения).
ВАЖНО:
- Все значения фактов должны быть на русском языке
- Извлекай факты ТОЛЬКО о ${name}, не о других людях
- Если факт уже известен из памяти — не дублируй его
- Извлекай ТОЛЬКО НОВЫЕ факты, которых нет в памяти
- [Я] — это сообщения пользователя, [${name}] — сообщения собеседника${contextDesc}
${memorySection}
Сообщения: ${cleanText}`;
  }

  // ============================================
  // Agent Mode Extraction
  // ============================================

  /**
   * Extract facts using agent mode with tools.
   * Supports cross-entity routing: "Маша в Сбере" → fact for Маша.
   *
   * Key differences from oneshot mode:
   * - Agent can query entity context on-demand via tools
   * - Facts are created directly (not as pending) via Smart Fusion
   * - Can create relations and pending entities for unknown people
   */
  async extractFactsAgent(params: {
    entityId: string;
    entityName: string;
    messageContent: string;
    messageId?: string;
    interactionId?: string;
    context?: {
      isOutgoing?: boolean;
      chatType?: string;
      senderName?: string;
    };
  }): Promise<AgentExtractionResult> {
    const { entityId, entityName, messageContent, messageId, interactionId, context } = params;

    // Check if agent mode is available
    if (!this.extractionToolsProvider) {
      this.logger.warn('ExtractionToolsProvider not available, falling back to oneshot');
      const result = await this.extractFacts(params);
      return {
        entityId,
        // Note: result.facts are PENDING facts, not committed to DB in oneshot mode
        // Return 0 to avoid misleading counts - facts are pending for review
        factsCreated: 0,
        relationsCreated: 0,
        pendingEntitiesCreated: result.facts.length, // These are pending, not created
        tokensUsed: result.tokensUsed,
      };
    }

    // Skip very short messages
    if (messageContent.length < MIN_MESSAGE_LENGTH) {
      return {
        entityId,
        factsCreated: 0,
        relationsCreated: 0,
        pendingEntitiesCreated: 0,
      };
    }

    // Truncate very long messages to save tokens
    const truncatedContent =
      messageContent.length > AGENT_CONTENT_LIMIT ? messageContent.substring(0, AGENT_CONTENT_LIMIT) + '...' : messageContent;

    // Get base context for primary entity
    let baseContext = '';
    if (this.entityFactService) {
      try {
        baseContext = await this.entityFactService.getContextForExtraction(entityId);
      } catch (error) {
        this.logger.warn(`Failed to get base context: ${error}`);
      }
    }

    // Create extraction context (passed to tools to avoid singleton state issues)
    const extractionContext = {
      messageId: messageId ?? null,
      interactionId: interactionId ?? null,
    };

    // Create custom MCP config with context
    const mcpServer = this.extractionToolsProvider.createMcpServer(extractionContext);
    const toolNames = this.extractionToolsProvider.getToolNames();

    // Build agent prompt
    const prompt = this.buildAgentPrompt(entityId, entityName, truncatedContent, context, baseContext);

    try {
      const { data, usage, turns, toolsUsed } = await this.claudeAgentService.call<AgentExtractionResponse>({
        mode: 'agent',
        taskType: 'fact_extraction',
        prompt,
        model: 'haiku',
        maxTurns: 10,
        timeout: 120000,
        referenceType: 'message',
        referenceId: messageId,
        customMcp: {
          name: EXTRACTION_MCP_NAME,
          server: mcpServer,
          toolNames,
        },
        outputFormat: {
          type: 'json_schema',
          schema: AGENT_EXTRACTION_SCHEMA,
          strict: true,
        },
      });

      const result: AgentExtractionResult = {
        entityId,
        factsCreated: data?.factsCreated ?? 0,
        relationsCreated: data?.relationsCreated ?? 0,
        pendingEntitiesCreated: data?.pendingEntitiesCreated ?? 0,
        turns,
        toolsUsed,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };

      this.logger.log(
        `Agent extraction for ${entityName}: ${result.factsCreated} facts, ` +
          `${result.relationsCreated} relations, ${result.pendingEntitiesCreated} pending ` +
          `(${turns} turns, ${result.tokensUsed} tokens)`,
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent extraction failed: ${message}`);

      // Fallback to oneshot mode
      this.logger.warn('Falling back to oneshot extraction');
      const result = await this.extractFacts(params);
      return {
        entityId,
        // Note: result.facts are PENDING facts, not committed to DB in oneshot mode
        // Return 0 to avoid misleading counts - facts are pending for review
        factsCreated: 0,
        relationsCreated: 0,
        pendingEntitiesCreated: result.facts.length, // These are pending, not created
        tokensUsed: result.tokensUsed,
      };
    }
  }

  /**
   * Batch extract from multiple messages using agent mode with Smart Fusion.
   *
   * Key advantages over extractFactsBatch():
   * - Uses Smart Fusion (semantic deduplication) via create_fact tool
   * - Creates EntityFacts directly (not PendingFacts)
   * - Supports cross-entity routing (facts about mentioned people)
   * - Single API call for cost efficiency (like oneshot batch)
   *
   * @param params - Entity info and array of messages to process
   * @returns AgentExtractionResult with counts of created entities
   */
  async extractFactsAgentBatch(params: {
    entityId: string;
    entityName: string;
    messages: BatchExtractionMessage[];
    chatType?: string;
  }): Promise<AgentExtractionResult> {
    const { entityId, entityName, messages, chatType } = params;

    // Filter out bot messages and very short messages
    const validMessages = messages.filter((m) => {
      if (m.isBotSender) {
        this.logger.debug(`Skipping bot message ${m.id}`);
        return false;
      }
      if (m.content.length < MIN_MESSAGE_LENGTH) {
        return false;
      }
      return true;
    });

    if (validMessages.length === 0) {
      this.logger.debug(`No valid messages to extract for entity ${entityId}`);
      return {
        entityId,
        factsCreated: 0,
        relationsCreated: 0,
        pendingEntitiesCreated: 0,
      };
    }

    // Check if agent mode is available
    if (!this.extractionToolsProvider) {
      this.logger.warn('ExtractionToolsProvider not available, falling back to oneshot batch');
      const result = await this.extractFactsBatch({
        entityId,
        entityName,
        messages: validMessages,
        chatType,
      });
      return {
        entityId,
        factsCreated: 0, // Oneshot creates PendingFacts, not EntityFacts
        relationsCreated: 0,
        pendingEntitiesCreated: result.facts.length,
        tokensUsed: result.tokensUsed,
      };
    }

    // Get entity memory context for context-aware extraction
    let entityMemory = '';
    if (this.entityFactService) {
      try {
        entityMemory = await this.entityFactService.getContextForExtraction(entityId);
      } catch (error) {
        this.logger.warn(`Failed to get entity context for agent batch: ${error}`);
      }
    }

    // Combine messages into single context with direction markers
    const combined = validMessages
      .map((m) => {
        const direction =
          m.isOutgoing !== undefined
            ? m.isOutgoing
              ? '[Я]'
              : `[${m.senderName || entityName}]`
            : `[${m.senderName || entityName}]`;
        return `${direction} ${m.content}`;
      })
      .join('\n---\n')
      .substring(0, CONTEXT_SIZE_LIMIT);

    // Create extraction context
    const extractionContext = {
      messageId: validMessages[0]?.id ?? null,
      interactionId: validMessages[0]?.interactionId ?? null,
    };

    // Create custom MCP config with context
    const mcpServer = this.extractionToolsProvider.createMcpServer(extractionContext);
    const toolNames = this.extractionToolsProvider.getToolNames();

    // Build agent batch prompt
    const prompt = this.buildAgentBatchPrompt(entityId, entityName, combined, chatType, entityMemory);

    try {
      const { data, usage, turns, toolsUsed } = await this.claudeAgentService.call<AgentExtractionResponse>({
        mode: 'agent',
        taskType: 'fact_extraction',
        prompt,
        model: 'haiku',
        maxTurns: 15, // More turns for batch processing
        timeout: 180000, // 3 minutes for larger batches
        customMcp: {
          name: EXTRACTION_MCP_NAME,
          server: mcpServer,
          toolNames,
        },
        outputFormat: {
          type: 'json_schema',
          schema: AGENT_EXTRACTION_SCHEMA,
          strict: true,
        },
      });

      const result: AgentExtractionResult = {
        entityId,
        factsCreated: data?.factsCreated ?? 0,
        relationsCreated: data?.relationsCreated ?? 0,
        pendingEntitiesCreated: data?.pendingEntitiesCreated ?? 0,
        turns,
        toolsUsed,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };

      this.logger.log(
        `Agent batch extraction for ${entityName}: ${result.factsCreated} facts, ` +
          `${result.relationsCreated} relations, ${result.pendingEntitiesCreated} pending ` +
          `(${validMessages.length} messages, ${turns} turns, ${result.tokensUsed} tokens)`,
      );

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent batch extraction failed: ${message}`);

      // Fallback to oneshot batch mode
      this.logger.warn('Falling back to oneshot batch extraction');
      const result = await this.extractFactsBatch({
        entityId,
        entityName,
        messages: validMessages,
        chatType,
      });
      return {
        entityId,
        factsCreated: 0,
        relationsCreated: 0,
        pendingEntitiesCreated: result.facts.length,
        tokensUsed: result.tokensUsed,
      };
    }
  }

  /**
   * Build prompt for agent batch mode extraction.
   */
  private buildAgentBatchPrompt(
    entityId: string,
    entityName: string,
    combinedMessages: string,
    chatType?: string,
    entityMemory?: string,
  ): string {
    // Build context description
    let contextDesc = '';
    if (chatType) {
      contextDesc = `Это ${CHAT_TYPE_MAP[chatType] || chatType}.\n`;
    }

    // Build base context section
    const baseContextSection = entityMemory
      ? `\n═══════════════════════════════════════════════════════════
ПАМЯТЬ О ${entityName} (entityId: ${entityId}):
${entityMemory}
═══════════════════════════════════════════════════════════\n`
      : `\nПервичная сущность: ${entityName} (entityId: ${entityId})\n`;

    return `Ты — агент для извлечения фактов из сообщений.

ПРАВИЛА:
1. Факты принадлежат КОНКРЕТНЫМ сущностям
2. "Маша работает в Сбере" → создай факт для Маши (найди через find_entity_by_name), НЕ для ${entityName}
3. Если упомянут человек — найди его через find_entity_by_name, затем получи контекст через get_entity_context
4. Если человек не найден — создай pending entity через create_pending_entity
5. Smart Fusion автоматически обрабатывает дубликаты (не нужно проверять вручную)
6. Создавай связи через create_relation для упоминаний отношений ("мой начальник", "работает в")
7. [Я] — это сообщения пользователя, [${entityName}] — сообщения собеседника

ТИПЫ ФАКТОВ:
- position: должность ("Senior Developer", "CTO")
- company: компания ("Сбер", "Яндекс")
- department: отдел
- phone, email, telegram: контакты
- birthday: день рождения
- location: местоположение
- education: образование
${baseContextSection}
${contextDesc}
═══════════════════════════════════════════════════════════
СООБЩЕНИЯ:
${combinedMessages}
═══════════════════════════════════════════════════════════

Извлеки все факты и связи из ВСЕХ сообщений. Используй инструменты для создания:
- create_fact — для каждого факта
- create_relation — для связей между сущностями
- create_pending_entity — для новых упомянутых людей

ВАЖНО: Посчитай сколько раз ты успешно вызвал каждый инструмент и верни:
- factsCreated: количество успешных вызовов create_fact
- relationsCreated: количество успешных вызовов create_relation
- pendingEntitiesCreated: количество успешных вызовов create_pending_entity`;
  }

  /**
   * Build prompt for agent mode extraction.
   */
  private buildAgentPrompt(
    entityId: string,
    entityName: string,
    messageContent: string,
    context?: { isOutgoing?: boolean; chatType?: string; senderName?: string },
    baseContext?: string,
  ): string {
    // Build context description
    let contextDesc = '';
    if (context) {
      const parts: string[] = [];
      if (context.isOutgoing !== undefined) {
        parts.push(context.isOutgoing ? 'Я написал собеседнику' : 'Собеседник написал мне');
      }
      if (context.chatType) {
        parts.push(`чат: ${CHAT_TYPE_MAP[context.chatType] || context.chatType}`);
      }
      if (context.senderName) {
        parts.push(`автор: ${context.senderName}`);
      }
      if (parts.length > 0) {
        contextDesc = `Контекст: ${parts.join(', ')}\n`;
      }
    }

    // Build base context section
    const baseContextSection = baseContext
      ? `\n═══════════════════════════════════════════════════════════
ПАМЯТЬ О ${entityName} (entityId: ${entityId}):
${baseContext}
═══════════════════════════════════════════════════════════\n`
      : `\nПервичная сущность: ${entityName} (entityId: ${entityId})\n`;

    return `Ты — агент для извлечения фактов из сообщений.

ПРАВИЛА:
1. Факты принадлежат КОНКРЕТНЫМ сущностям
2. "Маша работает в Сбере" → создай факт для Маши (найди через find_entity_by_name), НЕ для ${entityName}
3. Если упомянут человек — найди его через find_entity_by_name, затем получи контекст через get_entity_context
4. Если человек не найден — создай pending entity через create_pending_entity
5. Smart Fusion автоматически обрабатывает дубликаты (не нужно проверять вручную)
6. Создавай связи через create_relation для упоминаний отношений ("мой начальник", "работает в")

ТИПЫ ФАКТОВ:
- position: должность ("Senior Developer", "CTO")
- company: компания ("Сбер", "Яндекс")
- department: отдел
- phone, email, telegram: контакты
- birthday: день рождения
- location: местоположение
- education: образование
${baseContextSection}
${contextDesc}
═══════════════════════════════════════════════════════════
СООБЩЕНИЕ:
${messageContent}
═══════════════════════════════════════════════════════════

Извлеки все факты и связи. Используй инструменты для создания:
- create_fact — для каждого факта
- create_relation — для связей между сущностями
- create_pending_entity — для новых упомянутых людей

ВАЖНО: Посчитай сколько раз ты успешно вызвал каждый инструмент и верни:
- factsCreated: количество успешных вызовов create_fact
- relationsCreated: количество успешных вызовов create_relation
- pendingEntitiesCreated: количество успешных вызовов create_pending_entity`;
  }
}

/** Response from agent extraction */
interface AgentExtractionResponse {
  factsCreated: number;
  relationsCreated: number;
  pendingEntitiesCreated: number;
}

/** Message input for batch extraction */
export interface BatchExtractionMessage {
  id: string;
  content: string;
  interactionId?: string;
  /** Is this an outgoing message (from user to contact)? */
  isOutgoing?: boolean;
  /** Name of message sender (for group chats) */
  senderName?: string;
  /** Is sender a bot? Messages from bots should be skipped */
  isBotSender?: boolean;
}
