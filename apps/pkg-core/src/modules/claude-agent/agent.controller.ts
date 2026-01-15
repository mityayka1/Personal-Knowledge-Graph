import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ClaudeAgentService } from './claude-agent.service';
import {
  RecallRequestDto,
  RecallResponse,
  PrepareResponse,
  RecallSource,
} from './claude-agent.types';
import { EntityService } from '../entity/entity.service';

/**
 * Schema for recall agent response
 */
const RECALL_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description: 'Natural language answer to the user query',
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['message', 'interaction'] },
          id: { type: 'string' },
          preview: { type: 'string', maxLength: 200 },
        },
        required: ['type', 'id', 'preview'],
      },
      description: 'References to messages/interactions used in the answer',
    },
  },
  required: ['answer', 'sources'],
};

/**
 * Schema for prepare/meeting brief response
 */
const PREPARE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    brief: {
      type: 'string',
      description: 'Structured markdown brief about the entity',
    },
    recentInteractions: {
      type: 'number',
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

/**
 * Second Brain Agent API Controller
 *
 * Provides natural language interface for:
 * - Recall: search through past conversations
 * - Prepare: get briefing before a meeting
 */
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
  async recall(@Body() dto: RecallRequestDto): Promise<RecallResponse> {
    this.logger.log(`Recall request: "${dto.query.slice(0, 100)}..."`);

    if (!dto.query || dto.query.trim().length < 3) {
      throw new HttpException(
        'Query must be at least 3 characters',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.claudeAgentService.call<{
        answer: string;
        sources: RecallSource[];
      }>({
        mode: 'agent',
        taskType: 'recall',
        prompt: this.buildRecallPrompt(dto.query),
        toolCategories: ['search', 'entities'],
        model: 'sonnet',
        maxTurns: 10,
      });

      return {
        success: true,
        data: {
          answer: result.data?.answer || 'Не удалось найти релевантную информацию.',
          sources: result.data?.sources || [],
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
  async prepare(@Param('entityId') entityId: string): Promise<PrepareResponse> {
    this.logger.log(`Prepare request for entity: ${entityId}`);

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(entityId)) {
      throw new HttpException(
        'Invalid entity ID format (expected UUID)',
        HttpStatus.BAD_REQUEST,
      );
    }

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
      const result = await this.claudeAgentService.call<{
        brief: string;
        recentInteractions: number;
        openQuestions: string[];
      }>({
        mode: 'agent',
        taskType: 'meeting_prep',
        prompt: this.buildPreparePrompt(entity.name || entity.id, entityId),
        toolCategories: ['search', 'context', 'entities', 'events'],
        model: 'sonnet',
        maxTurns: 15,
        referenceType: 'entity',
        referenceId: entityId,
      });

      return {
        success: true,
        data: {
          entityId,
          entityName: entity.name || 'Unknown',
          brief: result.data?.brief || 'Нет достаточной информации для брифа.',
          recentInteractions: result.data?.recentInteractions || 0,
          openQuestions: result.data?.openQuestions || [],
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
   */
  private buildRecallPrompt(query: string): string {
    return `Пользователь спрашивает: "${query}"

Твоя задача:
1. Используй инструменты поиска чтобы найти релевантные сообщения и взаимодействия
2. Проанализируй найденные данные
3. Сформулируй ответ на естественном языке

Ответь в формате:
- answer: краткий ответ на вопрос пользователя на русском языке
- sources: массив ссылок на использованные сообщения/взаимодействия

Если ничего не найдено, так и скажи. Не выдумывай информацию.`;
  }

  /**
   * Build prompt for meeting preparation task
   */
  private buildPreparePrompt(entityName: string, entityId: string): string {
    return `Подготовь бриф для встречи с "${entityName}" (ID: ${entityId})

Твоя задача:
1. Получи информацию о контакте через get_entity_details
2. Найди последние взаимодействия через search_messages
3. Проверь открытые напоминания и события через list_events
4. Сформируй структурированный бриф

Ответь в формате:
- brief: markdown-текст с секциями:
  * О контакте (должность, компания, как познакомились)
  * Последние темы обсуждений
  * Договорённости и открытые вопросы
- recentInteractions: количество взаимодействий за последний месяц
- openQuestions: список открытых вопросов или action items

Пиши на русском языке. Если данных мало — отрази это в брифе.`;
  }
}
