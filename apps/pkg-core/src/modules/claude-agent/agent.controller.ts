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
} from './dto';
import {
  RecallSource,
} from './claude-agent.types';
import { EntityService } from '../entity/entity.service';

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
        model: 'sonnet',
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
2. list_entities — найди упомянутых людей
3. get_entity_details — получи детали по найденным контактам

Заполни поля ответа:
- answer: найденная информация на русском языке
- sources: массив источников [{type:"message", id:"UUID сообщения", preview:"цитата до 200 символов"}]

Если данных мало — так и скажи в answer, sources будет пустым массивом.`;

    if (entityId) {
      prompt += `

ВАЖНО: Фокусируйся ТОЛЬКО на информации, связанной с контактом ID: ${entityId}
При вызове search_messages обязательно передавай параметр entityId для фильтрации результатов.`;
    }

    return prompt;
  }

  /**
   * Build prompt for meeting preparation task
   */
  private buildPreparePrompt(entityName: string, entityId: string): string {
    return `Подготовь бриф для встречи с "${entityName}" (ID: ${entityId})

Используй инструменты:
1. get_entity_details — информация о контакте
2. search_messages — последние сообщения с этим контактом
3. list_events — напоминания и события

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
1. list_entities или get_entity_details — найди нужного контакта
2. draft_message — создай черновик сообщения
3. send_telegram — отправь сообщение (требует подтверждения пользователя)
4. schedule_followup — создай напоминание проверить ответ (опционально)

Порядок действий:
1. Найди нужного контакта по имени/описанию
2. Создай черновик сообщения с draft_message
3. Отправь с send_telegram (система запросит подтверждение)
4. При необходимости создай follow-up напоминание

КРИТИЧЕСКИЕ ПРАВИЛА ДЛЯ СООБЩЕНИЙ:
- ВСЕГДА пиши сообщения НА РУССКОМ ЯЗЫКЕ
- Обращайся к людям по имени НА РУССКОМ (используй русскую форму имени: "Маша" не "Marina", "Галя" не "Galina", "Серёжа" не "Sergey", "Марина" не "Marina")
- Сообщения должны быть короткими и естественными

ВАЖНО:
- Всегда сначала найди контакта перед отправкой
- draft_message показывает черновик перед отправкой
- send_telegram отправляет от имени пользователя через его Telegram

Заполни поля ответа:
- result: что было сделано (на русском)
- actions: массив выполненных действий [{type: "draft_created"|"message_sent"|"approval_rejected"|"followup_created", entityId, entityName, details}]`;
  }
}
