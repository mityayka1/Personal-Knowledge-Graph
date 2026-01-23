import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual, In } from 'typeorm';
import {
  ExtractedEvent,
  ExtractedEventStatus,
  EnrichmentData,
  Message,
} from '@pkg/entities';
import { SearchService } from '../search/search.service';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

/**
 * JSON Schema for context enrichment synthesis
 */
const ENRICHMENT_SYNTHESIS_SCHEMA = {
  type: 'object',
  properties: {
    contextFound: {
      type: 'boolean',
      description: 'Whether relevant context was found',
    },
    linkedEventId: {
      type: 'string',
      description: 'UUID of the most relevant linked event, if found',
      nullable: true,
    },
    synthesis: {
      type: 'string',
      description: 'Brief synthesis of what the abstract event refers to',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Confidence in the context match',
    },
  },
  required: ['contextFound', 'synthesis', 'confidence'],
};

interface EnrichmentSynthesisResult {
  contextFound: boolean;
  linkedEventId?: string;
  synthesis: string;
  confidence: number;
}

/**
 * Configuration constants for enrichment
 */
const ENRICHMENT_CONFIG = {
  /** Number of days to search back for related messages */
  SEARCH_DAYS: 14,
  /** Maximum number of keywords to extract */
  MAX_KEYWORDS: 15,
  /** Minimum word length to consider as keyword */
  MIN_WORD_LENGTH: 3,
  /** Maximum number of related messages to fetch */
  MAX_RELATED_MESSAGES: 20,
  /** Maximum number of candidate events to fetch */
  MAX_CANDIDATE_EVENTS: 20,
  /** Maximum content length for messages in context */
  MAX_CONTENT_LENGTH: 1000,
  /** Confidence threshold below which event needs user context */
  CONFIDENCE_THRESHOLD: 0.4,
  /** Timeout for synthesis LLM call in ms */
  SYNTHESIS_TIMEOUT_MS: 60000,
  /** LLM model to use for synthesis */
  MODEL: 'sonnet' as const,
} as const;

/**
 * Stop words to filter out from keyword extraction (Russian and English)
 */
const STOP_WORDS = new Set([
  // Russian
  'это', 'как', 'что', 'так', 'для', 'при', 'еще', 'уже', 'тоже', 'также',
  'есть', 'был', 'была', 'были', 'будет', 'быть', 'всё', 'все', 'вот',
  'надо', 'нужно', 'можно', 'могу', 'хочу', 'буду', 'мне', 'меня', 'мой',
  // English
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'will',
]);

export interface EnrichmentResult {
  success: boolean;
  linkedEventId?: string;
  needsContext: boolean;
  enrichmentData: EnrichmentData;
}

/**
 * Service for enriching abstract events with context from message history.
 *
 * When an event is abstract (e.g., "приступлю к задаче" without specifying which task),
 * this service searches through message history and existing events to find context
 * and potentially link the abstract event to a concrete one.
 */
@Injectable()
export class ContextEnrichmentService {
  private readonly logger = new Logger(ContextEnrichmentService.name);

  constructor(
    @InjectRepository(ExtractedEvent)
    private extractedEventRepo: Repository<ExtractedEvent>,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
    private searchService: SearchService,
    private claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Enrich an abstract event with context from message history
   */
  async enrichEvent(event: ExtractedEvent): Promise<EnrichmentResult> {
    const startTime = Date.now();

    try {
      // 1. Load reply context (if message is a reply to another message)
      const replyContext = await this.loadReplyContext(event.sourceMessageId);
      if (replyContext) {
        this.logger.debug(`Found reply context for event ${event.id}`);
      }

      // 1b. Load topic name (if message is from a forum topic)
      const topicName = await this.loadTopicName(event.sourceMessageId);
      if (topicName) {
        this.logger.debug(`Found topic context for event ${event.id}: ${topicName}`);
      }

      // 2. Extract keywords from the event
      const keywords = this.extractKeywords(event);
      this.logger.debug(`Extracted keywords for event ${event.id}: ${keywords.join(', ')}`);

      // 3. Search for related messages
      const relatedMessages = await this.searchRelatedMessages(
        keywords,
        event.entityId,
        ENRICHMENT_CONFIG.SEARCH_DAYS,
      );
      this.logger.debug(`Found ${relatedMessages.length} related messages`);

      // 4. Search for related events with same entity
      const candidateEvents = await this.findCandidateEvents(
        event.entityId,
        event.id,
      );
      this.logger.debug(`Found ${candidateEvents.length} candidate events`);

      // 5. If no context found at all (no reply, no messages, no events), mark as needing context
      if (!replyContext && relatedMessages.length === 0 && candidateEvents.length === 0) {
        return this.buildNoContextResult(event, keywords);
      }

      // 6. Use LLM to synthesize context and find links
      const synthesisResult = await this.synthesizeContext(
        event,
        relatedMessages,
        candidateEvents,
        replyContext,
        topicName,
      );

      // 7. Build enrichment result
      return this.buildEnrichmentResult(
        event,
        keywords,
        relatedMessages,
        candidateEvents,
        synthesisResult,
        startTime,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to enrich event ${event.id}: ${message}`);

      return {
        success: false,
        needsContext: true,
        enrichmentData: {
          enrichmentSuccess: false,
          enrichmentFailureReason: message,
          enrichedAt: new Date().toISOString(),
        },
      };
    }
  }

  /**
   * Extract keywords from event for searching
   */
  private extractKeywords(event: ExtractedEvent): string[] {
    const keywords: string[] = [];
    const data = event.extractedData as Record<string, unknown>;

    // Add words from "what" field (common in tasks, promises)
    if (data.what && typeof data.what === 'string') {
      keywords.push(...this.tokenize(data.what));
    }

    // Add words from "topic" field (meetings)
    if (data.topic && typeof data.topic === 'string') {
      keywords.push(...this.tokenize(data.topic));
    }

    // Add source quote if available
    if (event.sourceQuote) {
      keywords.push(...this.tokenize(event.sourceQuote));
    }

    // Deduplicate and filter
    const unique = [...new Set(keywords)]
      .filter(k => k.length >= ENRICHMENT_CONFIG.MIN_WORD_LENGTH)
      .filter(k => !STOP_WORDS.has(k));

    return unique.slice(0, ENRICHMENT_CONFIG.MAX_KEYWORDS);
  }

  /**
   * Tokenize text into words
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  /**
   * Load reply chain context for a message.
   * If the source message is a reply to another message, load that message's content.
   */
  private async loadReplyContext(
    sourceMessageId: string | null,
  ): Promise<string | null> {
    if (!sourceMessageId) {
      return null;
    }

    try {
      // Load the source message to get its replyToSourceMessageId
      const sourceMessage = await this.messageRepo.findOne({
        where: { id: sourceMessageId },
        select: ['id', 'replyToSourceMessageId'],
      });

      if (!sourceMessage?.replyToSourceMessageId) {
        return null;
      }

      // Load the message being replied to (by Telegram message ID)
      const replyToMessage = await this.messageRepo.findOne({
        where: { sourceMessageId: sourceMessage.replyToSourceMessageId },
        select: ['id', 'content'],
      });

      if (!replyToMessage?.content) {
        return null;
      }

      this.logger.debug(
        `Loaded reply context for message ${sourceMessageId}: ` +
          `${replyToMessage.content.substring(0, 50)}...`,
      );

      return replyToMessage.content;
    } catch (error) {
      this.logger.warn(`Failed to load reply context: ${error}`);
      return null;
    }
  }

  /**
   * Load topic name for a message (if it's from a forum topic).
   */
  private async loadTopicName(
    sourceMessageId: string | null,
  ): Promise<string | null> {
    if (!sourceMessageId) {
      return null;
    }

    try {
      const sourceMessage = await this.messageRepo.findOne({
        where: { id: sourceMessageId },
        select: ['id', 'topicName'],
      });

      if (!sourceMessage?.topicName) {
        return null;
      }

      this.logger.debug(
        `Loaded topic name for message ${sourceMessageId}: ${sourceMessage.topicName}`,
      );

      return sourceMessage.topicName;
    } catch (error) {
      this.logger.warn(`Failed to load topic name: ${error}`);
      return null;
    }
  }

  /**
   * Search for related messages in history
   */
  private async searchRelatedMessages(
    keywords: string[],
    entityId: string | null,
    days: number,
  ): Promise<Array<{ id: string; content: string; timestamp: string }>> {
    if (keywords.length === 0) {
      return [];
    }

    const query = keywords.join(' ');
    const now = new Date();
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    try {
      const { results } = await this.searchService.search({
        query,
        entityId: entityId || undefined,
        period: {
          from: from.toISOString(),
          to: now.toISOString(),
        },
        searchType: 'hybrid',
        limit: ENRICHMENT_CONFIG.MAX_RELATED_MESSAGES,
      });

      return results.map(r => ({
        id: r.id,
        content: r.content.substring(0, ENRICHMENT_CONFIG.MAX_CONTENT_LENGTH),
        timestamp: r.timestamp,
      }));
    } catch (error) {
      this.logger.warn(`Search failed: ${error}`);
      return [];
    }
  }

  /**
   * Find candidate events that might be related
   */
  private async findCandidateEvents(
    entityId: string | null,
    excludeEventId: string,
  ): Promise<ExtractedEvent[]> {
    if (!entityId) {
      return [];
    }

    const searchFromDate = new Date();
    searchFromDate.setDate(searchFromDate.getDate() - ENRICHMENT_CONFIG.SEARCH_DAYS);

    return this.extractedEventRepo.find({
      where: {
        entityId,
        createdAt: MoreThanOrEqual(searchFromDate),
        status: In([
          ExtractedEventStatus.PENDING,
          ExtractedEventStatus.CONFIRMED,
          ExtractedEventStatus.AUTO_PROCESSED,
        ]),
      },
      order: { createdAt: 'DESC' },
      take: ENRICHMENT_CONFIG.MAX_CANDIDATE_EVENTS,
    }).then(events => events.filter(e => e.id !== excludeEventId));
  }

  /**
   * Use LLM to synthesize context and find links
   */
  private async synthesizeContext(
    event: ExtractedEvent,
    messages: Array<{ id: string; content: string; timestamp: string }>,
    candidateEvents: ExtractedEvent[],
    replyContext: string | null,
    topicName: string | null,
  ): Promise<EnrichmentSynthesisResult> {
    const prompt = this.buildSynthesisPrompt(event, messages, candidateEvents, replyContext, topicName);

    try {
      const { data } = await this.claudeAgentService.call<EnrichmentSynthesisResult>({
        mode: 'oneshot',
        taskType: 'context_enrichment',
        prompt,
        schema: ENRICHMENT_SYNTHESIS_SCHEMA,
        model: ENRICHMENT_CONFIG.MODEL,
        referenceType: 'extracted_event',
        referenceId: event.id,
        timeout: ENRICHMENT_CONFIG.SYNTHESIS_TIMEOUT_MS,
      });

      return data;
    } catch (error) {
      this.logger.warn(`Synthesis failed: ${error}`);
      return {
        contextFound: false,
        synthesis: 'Не удалось синтезировать контекст',
        confidence: 0,
      };
    }
  }

  /**
   * Build prompt for context synthesis
   */
  private buildSynthesisPrompt(
    event: ExtractedEvent,
    messages: Array<{ id: string; content: string; timestamp: string }>,
    candidateEvents: ExtractedEvent[],
    replyContext: string | null,
    topicName: string | null,
  ): string {
    const eventData = event.extractedData as Record<string, unknown>;
    const eventDescription = eventData.what || eventData.topic || event.sourceQuote || 'неизвестно';

    let prompt = `Определи, к чему относится это абстрактное событие:

АБСТРАКТНОЕ СОБЫТИЕ:
Тип: ${event.eventType}
Описание: ${eventDescription}
${event.sourceQuote ? `Цитата: "${event.sourceQuote}"` : ''}

`;

    // Add topic context if available (message is from a forum topic)
    if (topicName) {
      prompt += `ТЕМА ФОРУМА: "${topicName}"
Это сообщение из форумного чата в теме "${topicName}". Учитывай это при анализе контекста.

`;
    }

    // Add reply context first (most important for understanding)
    if (replyContext) {
      const cleanReplyContent = replyContext.replace(/\n/g, ' ').substring(0, ENRICHMENT_CONFIG.MAX_CONTENT_LENGTH);
      prompt += `КОНТЕКСТ ОТВЕТА (сообщение, на которое отвечали):
"${cleanReplyContent}"

ВАЖНО: Это сообщение напрямую связано с событием — используй его для понимания контекста!

`;
    }

    if (messages.length > 0) {
      prompt += `СВЯЗАННЫЕ СООБЩЕНИЯ (последние 7 дней):
${messages.map((m, i) => `${i + 1}. [${m.timestamp}] ${m.content}`).join('\n')}

`;
    }

    if (candidateEvents.length > 0) {
      prompt += `СУЩЕСТВУЮЩИЕ СОБЫТИЯ (тот же контакт):
${candidateEvents.map((e, i) => {
  const data = e.extractedData as Record<string, unknown>;
  return `${i + 1}. [ID: ${e.id}] ${e.eventType}: ${data.what || data.topic || 'без описания'}`;
}).join('\n')}

`;
    }

    prompt += `ЗАДАЧА:
1. Определи, к какому конкретному событию или теме относится абстрактное событие
2. ${replyContext ? 'ПРИОРИТЕТ: используй КОНТЕКСТ ОТВЕТА — это прямая связь!' : ''}
3. Если найдено соответствие среди СУЩЕСТВУЮЩИХ СОБЫТИЙ, укажи его UUID в linkedEventId
4. Если контекст понятен${replyContext ? ' из КОНТЕКСТА ОТВЕТА или' : ''} из СООБЩЕНИЙ, опиши его в synthesis
5. Если контекст не найден, установи contextFound=false

ВАЖНО:
- linkedEventId должен быть точным UUID из списка выше или null
- synthesis ВСЕГДА пиши на РУССКОМ ЯЗЫКЕ, даже если исходные сообщения на английском`;

    return prompt;
  }

  /**
   * Build result when no context found at all
   */
  private buildNoContextResult(
    event: ExtractedEvent,
    keywords: string[],
  ): EnrichmentResult {
    return {
      success: true,
      needsContext: true,
      enrichmentData: {
        keywords,
        relatedMessageIds: [],
        candidateEventIds: [],
        enrichmentSuccess: true,
        enrichmentFailureReason: 'Контекст не найден в истории сообщений',
        enrichedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Build enrichment result from synthesis
   */
  private buildEnrichmentResult(
    event: ExtractedEvent,
    keywords: string[],
    messages: Array<{ id: string; content: string; timestamp: string }>,
    candidateEvents: ExtractedEvent[],
    synthesis: EnrichmentSynthesisResult,
    startTime: number,
  ): EnrichmentResult {
    const durationMs = Date.now() - startTime;

    // Validate linkedEventId if provided
    let validLinkedEventId: string | undefined;
    if (synthesis.linkedEventId) {
      const found = candidateEvents.find(e => e.id === synthesis.linkedEventId);
      if (found) {
        validLinkedEventId = synthesis.linkedEventId;
      } else {
        this.logger.warn(`Invalid linkedEventId: ${synthesis.linkedEventId} not in candidates`);
      }
    }

    const enrichmentData: EnrichmentData = {
      keywords,
      relatedMessageIds: messages.map(m => m.id),
      candidateEventIds: candidateEvents.map(e => e.id),
      synthesis: synthesis.synthesis,
      enrichmentSuccess: synthesis.contextFound,
      enrichedAt: new Date().toISOString(),
    };

    // Determine if event still needs context (user clarification)
    const needsContext = !synthesis.contextFound && synthesis.confidence < ENRICHMENT_CONFIG.CONFIDENCE_THRESHOLD;

    this.logger.log(
      `Enriched event ${event.id}: contextFound=${synthesis.contextFound}, ` +
      `linkedEventId=${validLinkedEventId || 'none'}, needsContext=${needsContext}, ` +
      `duration=${durationMs}ms`,
    );

    return {
      success: true,
      linkedEventId: validLinkedEventId,
      needsContext,
      enrichmentData,
    };
  }

  /**
   * Apply enrichment result to event
   */
  async applyEnrichmentResult(
    eventId: string,
    result: EnrichmentResult,
  ): Promise<void> {
    await this.extractedEventRepo.update(eventId, {
      linkedEventId: result.linkedEventId || null,
      needsContext: result.needsContext,
      enrichmentData: result.enrichmentData,
    });

    this.logger.debug(`Applied enrichment result to event ${eventId}`);
  }
}
