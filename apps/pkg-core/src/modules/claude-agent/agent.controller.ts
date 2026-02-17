import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Logger,
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { ClaudeAgentService } from './claude-agent.service';
import { RecallSessionService } from './recall-session.service';
import {
  RecallRequestDto,
  RecallResponseDto,
  PrepareResponseDto,
  ActRequestDto,
  ActResponseDto,
  ActActionDto,
  DailyExtractRequestDto,
  DailyExtractResponseDto,
  RecallSessionResponseDto,
  RecallFollowupRequestDto,
  RecallExtractRequestDto,
  RecallSaveRequestDto,
  RecallSaveResponseDto,
} from './dto';
import {
  RecallSource,
} from './claude-agent.types';
import { EntityService } from '../entity/entity.service';
import { EntityFactService } from '../entity/entity-fact/entity-fact.service';
import { DailySynthesisExtractionService } from '../extraction/daily-synthesis-extraction.service';
import { FactType, FactCategory, FactSource } from '@pkg/entities';
import { RecallSession } from './recall-session.service';

/**
 * Maximum length for fact value preview.
 * Full content stored in valueJson.fullContent for retrieval.
 */
const FACT_VALUE_PREVIEW_LENGTH = 500;

/**
 * Raw JSON Schema for recall response
 * NOTE: Use raw JSON Schema, NOT z.toJSONSchema() - SDK doesn't support Zod 4 schema format
 */
const RECALL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'Natural language answer to the user query in Russian',
    },
    sources: {
      type: 'array',
      description: 'List of sources used to answer',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Source type: message or interaction',
          },
          id: {
            type: 'string',
            description: 'UUID of the source',
          },
          preview: {
            type: 'string',
            description: 'Short quote from the source',
          },
        },
        required: ['type', 'id', 'preview'],
      },
    },
  },
  required: ['answer', 'sources'],
};

type RecallStructuredOutput = {
  answer: string;
  sources: Array<{ type: string; id: string; preview: string }>;
};

/**
 * Raw JSON Schema for prepare response (without Zod)
 */
const PREPARE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    brief: {
      type: 'string',
      description: 'Structured markdown brief about the entity',
    },
    recentInteractions: {
      type: 'integer',
      description: 'Count of recent interactions',
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Open questions or pending action items',
    },
  },
  required: ['brief', 'recentInteractions', 'openQuestions'],
};

type PrepareStructuredOutput = {
  brief: string;
  recentInteractions: number;
  openQuestions: string[];
};

/**
 * Raw JSON Schema for act response
 */
const ACT_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    result: {
      type: 'string',
      description: 'Summary of what was done in Russian',
    },
    actions: {
      type: 'array',
      description: 'Actions taken during execution',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Action type: draft_created, message_sent, approval_rejected, followup_created',
          },
          entityId: {
            type: 'string',
            description: 'UUID of entity involved',
          },
          entityName: {
            type: 'string',
            description: 'Name of entity',
          },
          details: {
            type: 'string',
            description: 'Additional details about the action',
          },
        },
        required: ['type'],
      },
    },
  },
  required: ['result', 'actions'],
};

type ActStructuredOutput = {
  result: string;
  actions: Array<{
    type: string;
    entityId?: string;
    entityName?: string;
    details?: string;
  }>;
};

/**
 * Second Brain Agent API Controller
 *
 * Provides natural language interface for:
 * - Recall: search through past conversations
 * - Prepare: get briefing before a meeting
 */
@ApiTags('agent')
@Controller('agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly claudeAgentService: ClaudeAgentService,
    private readonly entityService: EntityService,
    private readonly entityFactService: EntityFactService,
    private readonly dailySynthesisExtractionService: DailySynthesisExtractionService,
    private readonly recallSessionService: RecallSessionService,
  ) {}

  // ────────────────────────────────────────────────────────────────────────────
  // Helper methods
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Verify session exists and user has access.
   * Centralizes 404/403 logic to avoid duplication across endpoints.
   *
   * @param sessionId - Session ID to verify
   * @param userId - Optional user ID for access control
   * @param operation - Operation name for logging (e.g., 'get', 'save', 'extract')
   * @returns RecallSession if valid
   * @throws NotFoundException if session not found
   * @throws ForbiddenException if userId mismatch
   */
  private async verifySessionAccess(
    sessionId: string,
    userId: string | undefined,
    operation: string,
  ): Promise<RecallSession> {
    const session = await this.recallSessionService.get(sessionId);

    if (!session) {
      throw new NotFoundException(`Session not found or expired: ${sessionId}`);
    }

    // Multi-user safety: if session has userId, request MUST provide matching userId
    // SECURITY: Don't skip check when userId is not provided - that's an auth bypass!
    if (session.userId) {
      if (!userId) {
        this.logger.warn(
          `Missing userId for protected session: session=${sessionId}, operation=${operation}`,
        );
        throw new ForbiddenException('userId required to access this session');
      }
      if (session.userId !== userId) {
        this.logger.warn(
          `Unauthorized ${operation} attempt: session=${sessionId}, expected=${session.userId}, got=${userId}`,
        );
        throw new ForbiddenException('Access denied: session belongs to another user');
      }
    }

    return session;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Endpoints
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * POST /agent/recall
   *
   * Natural language search through past conversations
   *
   * @example
   * POST /agent/recall
   * { "query": "что обсуждали с Иваном на прошлой неделе?" }
   */
  @Post('recall')
  @ApiOperation({
    summary: 'Search through past conversations',
    description:
      'Natural language search with optional entity filter and configurable turns',
  })
  @ApiResponse({
    status: 200,
    description: 'Search completed successfully',
    type: RecallResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid query or parameters' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async recall(@Body() dto: RecallRequestDto): Promise<RecallResponseDto> {
    this.logger.log(
      `Recall request: "${dto.query.slice(0, 100)}..." entityId=${dto.entityId || 'none'} maxTurns=${dto.maxTurns || 15}`,
    );

    // Validation handled by class-validator decorators in DTO, but keep defensive check
    if (!dto.query || dto.query.trim().length < 3) {
      throw new HttpException(
        'Query must be at least 3 characters',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // Agent with structured output for guaranteed response format
      const result = await this.claudeAgentService.call<RecallStructuredOutput>({
        mode: 'agent',
        taskType: 'recall',
        prompt: this.buildRecallPrompt(dto.query, dto.entityId),
        toolCategories: ['search', 'context', 'entities', 'events', 'knowledge'],
        model: dto.model || 'sonnet',
        maxTurns: dto.maxTurns || 15,
        outputFormat: {
          type: 'json_schema',
          schema: RECALL_RESPONSE_SCHEMA,
          strict: true,
        },
      });

      const structuredData = result.data as RecallStructuredOutput;

      // Map sources to response format
      const sources: RecallSource[] = (structuredData?.sources || []).map(
        (s) => ({
          type: (s.type === 'interaction' ? 'interaction' : 'message') as
            | 'message'
            | 'interaction',
          id: s.id,
          preview: s.preview || '',
        }),
      );

      const answer = structuredData?.answer || 'Не удалось найти информацию.';

      // Create session for follow-up operations
      const sessionId = await this.recallSessionService.create({
        query: dto.query,
        dateStr: new Date().toISOString().split('T')[0],
        answer,
        sources,
        model: dto.model || 'sonnet',
        userId: dto.userId,
      });

      this.logger.log(`Created recall session: ${sessionId}`);

      return {
        success: true,
        data: {
          sessionId,
          answer,
          sources,
          toolsUsed: result.toolsUsed || [],
        },
      };
    } catch (error) {
      this.logger.error(`Recall failed: ${error}`);
      throw new HttpException(
        'Failed to process recall request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /agent/recall/session/:sessionId
   *
   * Get recall session by ID for displaying context or continuing conversation
   *
   * @example
   * GET /agent/recall/session/rs_a1b2c3d4e5f6
   */
  @Get('recall/session/:sessionId')
  @ApiOperation({
    summary: 'Get recall session',
    description: 'Retrieve recall session data by ID for follow-up operations',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID from recall response',
    example: 'rs_a1b2c3d4e5f6',
  })
  @ApiResponse({
    status: 200,
    description: 'Session found',
    type: RecallSessionResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Unauthorized - userId mismatch' })
  @ApiResponse({ status: 404, description: 'Session not found or expired' })
  async getRecallSession(
    @Param('sessionId') sessionId: string,
    @Query('userId') userId?: string,
  ): Promise<RecallSessionResponseDto> {
    this.logger.log(`Get recall session: ${sessionId}, userId=${userId || 'none'}`);

    const session = await this.verifySessionAccess(sessionId, userId, 'get');

    return {
      success: true,
      data: {
        sessionId: session.id,
        query: session.query,
        dateStr: session.dateStr,
        answer: session.answer,
        sources: session.sources,
        model: session.model,
        createdAt: session.createdAt,
      },
    };
  }

  /**
   * POST /agent/recall/session/:sessionId/extract
   *
   * Extract structured data from recall session synthesis
   *
   * @example
   * POST /agent/recall/session/rs_a1b2c3d4e5f6/extract
   * { "focusTopic": "Панавто" }
   */
  @Post('recall/session/:sessionId/extract')
  @ApiOperation({
    summary: 'Extract structured data from recall session',
    description:
      'Extracts projects, tasks, commitments from recall session answer',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID from recall response',
    example: 'rs_a1b2c3d4e5f6',
  })
  @ApiResponse({
    status: 200,
    description: 'Extraction completed',
    type: DailyExtractResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Unauthorized - userId mismatch' })
  @ApiResponse({ status: 404, description: 'Session not found or expired' })
  async extractFromSession(
    @Param('sessionId') sessionId: string,
    @Body() dto: RecallExtractRequestDto,
  ): Promise<DailyExtractResponseDto> {
    this.logger.log(
      `Extract from recall session: ${sessionId}, focus=${dto.focusTopic || 'none'}, userId=${dto.userId || 'none'}`,
    );

    const session = await this.verifySessionAccess(sessionId, dto.userId, 'extract');

    try {
      const result = await this.dailySynthesisExtractionService.extract({
        synthesisText: session.answer,
        date: session.dateStr,
        focusTopic: dto.focusTopic,
      });

      return {
        success: true,
        data: {
          projects: result.projects,
          tasks: result.tasks,
          commitments: result.commitments,
          inferredRelations: result.inferredRelations,
          extractionSummary: result.extractionSummary,
          tokensUsed: result.tokensUsed,
          durationMs: result.durationMs,
        },
      };
    } catch (error) {
      this.logger.error(`Extract from session failed: ${error}`);
      throw new HttpException(
        'Failed to extract structured data from session',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /agent/recall/session/:sessionId/followup
   *
   * Continue conversation in context of recall session
   *
   * @example
   * POST /agent/recall/session/rs_a1b2c3d4e5f6/followup
   * { "query": "А что насчёт дедлайнов?" }
   */
  @Post('recall/session/:sessionId/followup')
  @ApiOperation({
    summary: 'Continue recall conversation',
    description: 'Send follow-up query in context of existing recall session',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID from recall response',
    example: 'rs_a1b2c3d4e5f6',
  })
  @ApiResponse({
    status: 200,
    description: 'Follow-up completed',
    type: RecallResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Unauthorized - userId mismatch' })
  @ApiResponse({ status: 404, description: 'Session not found or expired' })
  async followupRecall(
    @Param('sessionId') sessionId: string,
    @Body() dto: RecallFollowupRequestDto,
  ): Promise<RecallResponseDto> {
    this.logger.log(`Follow-up recall session: ${sessionId}, query="${dto.query.slice(0, 50)}...", userId=${dto.userId || 'none'}`);

    const session = await this.verifySessionAccess(sessionId, dto.userId, 'followup');

    try {
      // Build context-aware prompt with previous answer
      const contextPrompt = this.buildFollowupPrompt(
        dto.query,
        session.query,
        session.answer,
      );

      const result = await this.claudeAgentService.call<RecallStructuredOutput>({
        mode: 'agent',
        taskType: 'recall',
        prompt: contextPrompt,
        toolCategories: ['search', 'context', 'entities', 'events'],
        model: dto.model || session.model || 'sonnet',
        maxTurns: 10,
        outputFormat: {
          type: 'json_schema',
          schema: RECALL_RESPONSE_SCHEMA,
          strict: true,
        },
      });

      const structuredData = result.data as RecallStructuredOutput;

      const sources: RecallSource[] = (structuredData?.sources || []).map(
        (s) => ({
          type: (s.type === 'interaction' ? 'interaction' : 'message') as
            | 'message'
            | 'interaction',
          id: s.id,
          preview: s.preview || '',
        }),
      );

      const answer = structuredData?.answer || 'Не удалось найти дополнительную информацию.';

      // Update session with new answer (with userId for authorization)
      const updated = await this.recallSessionService.updateAnswer(sessionId, answer, sources, dto.userId);
      if (!updated) {
        // Session expired or unauthorized during follow-up - log but don't fail
        // User still gets the answer, it just won't be persisted in session
        this.logger.warn(
          `Failed to update session ${sessionId} - may be expired or unauthorized. Answer returned but not persisted.`,
        );
      }

      return {
        success: true,
        data: {
          sessionId,
          answer,
          sources,
          toolsUsed: result.toolsUsed || [],
        },
      };
    } catch (error) {
      this.logger.error(`Follow-up recall failed: ${error}`);
      throw new HttpException(
        'Failed to process follow-up request',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /agent/recall/session/:sessionId/save
   *
   * Mark recall session insights as saved (idempotent operation).
   * Used by adapters to prevent duplicate saves when user clicks "Save" button multiple times.
   *
   * @example
   * POST /agent/recall/session/rs_a1b2c3d4e5f6/save
   * { "userId": "864381617" }
   */
  @Post('recall/session/:sessionId/save')
  @ApiOperation({
    summary: 'Save recall session insights',
    description:
      'Mark session as saved with idempotency protection. Returns existing factId if already saved.',
  })
  @ApiParam({
    name: 'sessionId',
    description: 'Session ID from recall response',
    example: 'rs_a1b2c3d4e5f6',
  })
  @ApiResponse({
    status: 200,
    description: 'Save operation completed',
    type: RecallSaveResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Session not found or expired' })
  @ApiResponse({ status: 403, description: 'Unauthorized - userId mismatch' })
  async saveRecallSession(
    @Param('sessionId') sessionId: string,
    @Body() dto: RecallSaveRequestDto,
  ): Promise<RecallSaveResponseDto> {
    this.logger.log(`Save recall session: ${sessionId}, userId=${dto.userId || 'none'}`);

    const session = await this.verifySessionAccess(sessionId, dto.userId, 'save');

    // Check if already saved (idempotency - before creating fact)
    if (session.savedAt && session.savedFactId) {
      this.logger.log(`Session ${sessionId} already saved as fact ${session.savedFactId}`);
      return {
        success: true,
        alreadySaved: true,
        factId: session.savedFactId,
      };
    }

    // ATOMIC SAVE: Create fact in PostgreSQL FIRST, then mark session
    // This follows Source-Agnostic Architecture - PKG Core handles fact creation

    // 1. Find owner entity ("me")
    const owner = await this.entityService.findMe();
    if (!owner) {
      this.logger.error('Owner entity not found - cannot save daily summary');
      return {
        success: false,
        error: 'Owner entity not configured. Please set an owner entity first.',
      };
    }

    // 2. Create fact with daily_summary type
    try {
      const fact = await this.entityFactService.create(owner.id, {
        type: FactType.DAILY_SUMMARY,
        category: FactCategory.PERSONAL,
        value: session.answer.slice(0, FACT_VALUE_PREVIEW_LENGTH),
        valueJson: {
          fullContent: session.answer,
          dateStr: session.dateStr,
          sessionId: session.id,
          query: session.query,
        },
        source: FactSource.EXTRACTED,
        confidence: 1.0,
      });

      const factId = fact.id;

      // 3. Mark session as saved with REAL PostgreSQL factId
      const markResult = await this.recallSessionService.markAsSaved(
        sessionId,
        factId,
        dto.userId,
      );

      // Handle race condition - another request saved in parallel
      if (markResult.alreadySaved) {
        this.logger.log(
          `Session ${sessionId} was saved by concurrent request, factId=${markResult.existingFactId}`,
        );
        // Compensation: invalidate the duplicate fact we just created
        try {
          await this.entityFactService.invalidate(factId);
          this.logger.log(`Invalidated duplicate fact ${factId} (concurrent save detected)`);
        } catch (invalidateError) {
          this.logger.warn(`Failed to invalidate duplicate fact ${factId}: ${invalidateError}`);
        }
        return {
          success: true,
          alreadySaved: true,
          factId: markResult.existingFactId,
        };
      }

      // Handle Redis failure - markAsSaved returned success: false
      if (!markResult.success) {
        this.logger.error(`Failed to mark session ${sessionId} as saved in Redis`);
        // Compensation: invalidate the orphaned fact to prevent duplicates
        try {
          await this.entityFactService.invalidate(factId);
          this.logger.log(`Invalidated orphaned fact ${factId} (Redis mark failed)`);
        } catch (invalidateError) {
          this.logger.warn(`Failed to invalidate orphaned fact ${factId}: ${invalidateError}`);
        }
        return {
          success: false,
          error: 'Failed to mark session as saved. Please try again.',
        };
      }

      this.logger.log(`Session ${sessionId} saved as fact ${factId} for owner ${owner.name}`);

      return {
        success: true,
        alreadySaved: false,
        factId,
      };
    } catch (error) {
      this.logger.error(`Failed to create fact for session ${sessionId}: ${error}`);
      return {
        success: false,
        error: `Failed to save daily summary: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Build prompt for follow-up query with context
   */
  private buildFollowupPrompt(
    followupQuery: string,
    originalQuery: string,
    previousAnswer: string,
  ): string {
    return `Контекст предыдущего запроса:
Вопрос: "${originalQuery}"
Ответ: ${previousAnswer}

Уточняющий вопрос: "${followupQuery}"

Найди дополнительную информацию по уточняющему вопросу, учитывая контекст предыдущего разговора.

Используй инструменты:
1. search_messages — поиск по сообщениям
2. get_entity_context — контекст о человеке
3. list_entities — поиск контактов

Заполни поля ответа:
- answer: ответ на уточняющий вопрос на русском языке
- sources: массив источников [{type:"message", id:"UUID", preview:"цитата"}]`;
  }

  /**
   * GET /agent/prepare/:entityId
   *
   * Get a briefing before meeting with a person/organization
   *
   * @example
   * GET /agent/prepare/123e4567-e89b-12d3-a456-426614174000
   */
  @Get('prepare/:entityId')
  @ApiOperation({
    summary: 'Get meeting briefing',
    description:
      'Prepare context brief before meeting with a person or organization',
  })
  @ApiParam({
    name: 'entityId',
    description: 'Entity UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @ApiResponse({
    status: 200,
    description: 'Brief generated successfully',
    type: PrepareResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid UUID format' })
  @ApiResponse({ status: 404, description: 'Entity not found' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async prepare(
    @Param('entityId', ParseUUIDPipe) entityId: string,
  ): Promise<PrepareResponseDto> {
    this.logger.log(`Prepare request for entity: ${entityId}`);

    // EntityService.findOne() throws NotFoundException if not found
    // Let it propagate directly - don't mask other errors as "not found"
    const entity = await this.entityService.findOne(entityId);

    try {
      // Agent with structured output for guaranteed response format
      const result =
        await this.claudeAgentService.call<PrepareStructuredOutput>({
          mode: 'agent',
          taskType: 'meeting_prep',
          prompt: this.buildPreparePrompt(entity.name || entity.id, entityId),
          toolCategories: ['search', 'context', 'entities', 'events', 'knowledge'],
          model: 'sonnet',
          maxTurns: 15,
          referenceType: 'entity',
          referenceId: entityId,
          outputFormat: {
            type: 'json_schema',
            schema: PREPARE_RESPONSE_SCHEMA,
            strict: true,
          },
        });

      const structuredData = result.data as PrepareStructuredOutput;

      return {
        success: true,
        data: {
          entityId,
          entityName: entity.name || 'Unknown',
          brief:
            structuredData?.brief || 'Нет достаточной информации для брифа.',
          recentInteractions: structuredData?.recentInteractions || 0,
          openQuestions: structuredData?.openQuestions || [],
        },
      };
    } catch (error) {
      this.logger.error(`Prepare failed for ${entityId}: ${error}`);
      throw new HttpException(
        'Failed to prepare meeting brief',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Build prompt for recall task
   * Following prepare's structure which successfully triggers StructuredOutput
   * Supports optional entityId filter
   */
  private buildRecallPrompt(query: string, entityId?: string): string {
    let prompt = `Найди информацию по запросу: "${query}"

Используй инструменты:
1. search_messages — найди релевантные сообщения по запросу
2. list_entities — найди упомянутых людей по имени
3. get_entity_details — базовая информация о контакте (факты, идентификаторы)
4. get_entity_context — полный контекст о человеке (история взаимодействий, синтезированная сводка)
5. search_discussions — поиск по тематическим сегментам обсуждений (topic, keywords, summary)
6. get_knowledge_summary — консолидированные знания по проекту/человеку (решения, факты, открытые вопросы)

СТРАТЕГИЯ:
- Для поиска по ключевым словам: search_messages + search_discussions (параллельно)
- Для вопросов о конкретном человеке: list_entities → get_entity_context
- Для вопросов о проекте/теме: search_discussions → get_knowledge_summary
- get_entity_context возвращает богатый контекст с tiered retrieval (недавние сообщения + summaries)
- search_discussions ищет по тематическим сегментам — структурированным блокам обсуждений с topic и summary

Заполни поля ответа:
- answer: найденная информация на русском языке
- sources: массив источников [{type:"message", id:"UUID сообщения", preview:"цитата до 200 символов"}]

Если данных мало — так и скажи в answer, sources будет пустым массивом.`;

    if (entityId) {
      prompt += `

ВАЖНО: Фокусируйся ТОЛЬКО на информации, связанной с контактом ID: ${entityId}
Используй get_entity_context для получения полного контекста об этом контакте.
При вызове search_messages передавай параметр entityId для фильтрации результатов.`;
    }

    return prompt;
  }

  /**
   * Build prompt for meeting preparation task
   */
  private buildPreparePrompt(entityName: string, entityId: string): string {
    return `Подготовь бриф для встречи с "${entityName}" (ID: ${entityId})

Используй инструменты:
1. get_entity_context — ГЛАВНЫЙ: полный контекст о контакте (факты, история, синтезированная сводка)
2. search_messages — дополнительный поиск по конкретным темам если нужно
3. list_events — напоминания и события связанные с контактом
4. search_discussions — поиск тематических обсуждений с участием этого контакта
5. get_knowledge_summary — консолидированные знания по проектам/темам этого контакта

ВАЖНО: Начни с get_entity_context — он уже содержит:
- Текущие факты о человеке (должность, компания, контакты)
- Недавние взаимодействия (< 7 дней — полные сообщения)
- Summaries старых взаимодействий (7-90 дней)
- Синтезированный контекст с рекомендациями

ДОПОЛНИТЕЛЬНО: Используй search_discussions для поиска тематических обсуждений и get_knowledge_summary для консолидированных знаний — там могут быть решения, договорённости и открытые вопросы по проектам.

Заполни поля ответа:
- brief: структурированный markdown бриф (кто это, о чём общались, важные факты)
- recentInteractions: количество найденных сообщений/взаимодействий
- openQuestions: список открытых вопросов, обещаний, задач (пустой массив если нет)

Если данных мало — так и скажи в brief.`;
  }

  /**
   * POST /agent/act
   *
   * Execute an action based on natural language instruction
   *
   * @example
   * POST /agent/act
   * { "instruction": "напиши Сергею что встреча переносится" }
   */
  @Post('act')
  @ApiOperation({
    summary: 'Execute an action',
    description:
      'Execute an action based on natural language instruction. Supports sending messages with approval flow.',
  })
  @ApiResponse({
    status: 200,
    description: 'Action executed successfully',
    type: ActResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid instruction' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async act(@Body() dto: ActRequestDto): Promise<ActResponseDto> {
    this.logger.log(
      `Act request: "${dto.instruction.slice(0, 100)}..." maxTurns=${dto.maxTurns || 10}`,
    );

    // Validation handled by class-validator decorators in DTO
    if (!dto.instruction || dto.instruction.trim().length < 5) {
      throw new HttpException(
        'Instruction must be at least 5 characters',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // Agent with actions tools and structured output
      const result = await this.claudeAgentService.call<ActStructuredOutput>({
        mode: 'agent',
        taskType: 'action',
        prompt: this.buildActPrompt(dto.instruction),
        toolCategories: ['search', 'entities', 'events', 'actions'],
        model: 'sonnet',
        maxTurns: dto.maxTurns || 10,
        outputFormat: {
          type: 'json_schema',
          schema: ACT_RESPONSE_SCHEMA,
          strict: true,
        },
      });

      const structuredData = result.data as ActStructuredOutput;

      // Map actions to response format
      const actions: ActActionDto[] = (structuredData?.actions || []).map(
        (a) => ({
          type: a.type as ActActionDto['type'],
          entityId: a.entityId,
          entityName: a.entityName,
          details: a.details,
        }),
      );

      return {
        success: true,
        data: {
          result: structuredData?.result || 'Действие выполнено.',
          actions,
          toolsUsed: result.toolsUsed || [],
        },
      };
    } catch (error) {
      this.logger.error(`Act failed: ${error}`);
      throw new HttpException(
        'Failed to execute action',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Build prompt for act task
   */
  private buildActPrompt(instruction: string): string {
    return `Выполни действие по инструкции пользователя: "${instruction}"

Используй инструменты:
1. list_entities — найди контакта по имени
2. get_entity_context — получи контекст о человеке (для персонализации сообщения)
3. draft_message — создай черновик сообщения
4. send_telegram — отправь сообщение (требует подтверждения пользователя)
5. schedule_followup — создай напоминание проверить ответ (опционально)

Порядок действий:
1. Найди контакта: list_entities по имени
2. Получи контекст: get_entity_context — поможет написать релевантное сообщение
3. Создай черновик: draft_message с учётом контекста
4. Отправь: send_telegram (система запросит подтверждение)
5. Опционально: schedule_followup для напоминания

КРИТИЧЕСКИЕ ПРАВИЛА ДЛЯ СООБЩЕНИЙ:
- ВСЕГДА пиши сообщения НА РУССКОМ ЯЗЫКЕ
- Обращайся к людям по имени НА РУССКОМ (используй русскую форму имени: "Маша" не "Marina", "Галя" не "Galina", "Серёжа" не "Sergey", "Марина" не "Marina")
- Сообщения должны быть короткими и естественными
- Учитывай контекст из get_entity_context при формулировке сообщения

ВАЖНО:
- Всегда сначала найди контакта перед отправкой
- draft_message показывает черновик перед отправкой
- send_telegram отправляет от имени пользователя через его Telegram

Заполни поля ответа:
- result: что было сделано (на русском)
- actions: массив выполненных действий [{type: "draft_created"|"message_sent"|"approval_rejected"|"followup_created", entityId, entityName, details}]`;
  }

  /**
   * POST /agent/daily/extract
   *
   * Extract structured data (projects, tasks, commitments) from daily synthesis text.
   * This is Phase 2 of Jarvis Foundation — converting natural language summaries into
   * structured Activity/Commitment entities.
   *
   * @example
   * POST /agent/daily/extract
   * { "synthesisText": "Сегодня работал над Хабом для Панавто с Машей...", "date": "2026-01-30" }
   */
  @Post('daily/extract')
  @ApiOperation({
    summary: 'Extract structured data from daily synthesis',
    description:
      'Extracts projects, tasks, commitments, and entity relations from /daily synthesis text',
  })
  @ApiResponse({
    status: 200,
    description: 'Extraction completed successfully',
    type: DailyExtractResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid synthesis text' })
  @ApiResponse({ status: 500, description: 'Internal server error' })
  async extractDaily(
    @Body() dto: DailyExtractRequestDto,
  ): Promise<DailyExtractResponseDto> {
    this.logger.log(
      `Daily extract request: text length=${dto.synthesisText.length}, ` +
        `date=${dto.date || 'today'}, focus=${dto.focusTopic || 'none'}`,
    );

    try {
      const result = await this.dailySynthesisExtractionService.extract({
        synthesisText: dto.synthesisText,
        date: dto.date,
        focusTopic: dto.focusTopic,
      });

      return {
        success: true,
        data: {
          projects: result.projects,
          tasks: result.tasks,
          commitments: result.commitments,
          inferredRelations: result.inferredRelations,
          extractionSummary: result.extractionSummary,
          tokensUsed: result.tokensUsed,
          durationMs: result.durationMs,
        },
      };
    } catch (error) {
      this.logger.error(`Daily extract failed: ${error}`);
      throw new HttpException(
        'Failed to extract structured data from synthesis',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
