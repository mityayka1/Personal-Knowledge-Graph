import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Logger,
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
} from '@nestjs/swagger';
import { ClaudeAgentService } from './claude-agent.service';
import {
  RecallRequestDto,
  RecallResponseDto,
  PrepareResponseDto,
  ActRequestDto,
  ActResponseDto,
  ActActionDto,
  DailyExtractRequestDto,
  DailyExtractResponseDto,
} from './dto';
import {
  RecallSource,
} from './claude-agent.types';
import { EntityService } from '../entity/entity.service';
import { DailySynthesisExtractionService } from '../extraction/daily-synthesis-extraction.service';

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
    private readonly dailySynthesisExtractionService: DailySynthesisExtractionService,
  ) {}

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
        toolCategories: ['search', 'context', 'entities', 'events'],
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

      return {
        success: true,
        data: {
          answer: structuredData?.answer || 'Не удалось найти информацию.',
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

    // Check if entity exists
    let entity;
    try {
      entity = await this.entityService.findOne(entityId);
    } catch {
      throw new HttpException(
        `Entity not found: ${entityId}`,
        HttpStatus.NOT_FOUND,
      );
    }

    try {
      // Agent with structured output for guaranteed response format
      const result =
        await this.claudeAgentService.call<PrepareStructuredOutput>({
          mode: 'agent',
          taskType: 'meeting_prep',
          prompt: this.buildPreparePrompt(entity.name || entity.id, entityId),
          toolCategories: ['search', 'context', 'entities', 'events'],
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

СТРАТЕГИЯ:
- Для поиска по ключевым словам: search_messages
- Для вопросов о конкретном человеке: сначала list_entities → затем get_entity_context
- get_entity_context возвращает богатый контекст с tiered retrieval (недавние сообщения + summaries)

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

ВАЖНО: Начни с get_entity_context — он уже содержит:
- Текущие факты о человеке (должность, компания, контакты)
- Недавние взаимодействия (< 7 дней — полные сообщения)
- Summaries старых взаимодействий (7-90 дней)
- Синтезированный контекст с рекомендациями

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
