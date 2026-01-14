import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EntityEvent, EventType, EventStatus } from '@pkg/entities';
import { ClaudeAgentService } from '../claude-agent/claude-agent.service';

export interface ExtractedEvent {
  eventType: EventType;
  title: string;
  description?: string;
  eventDate?: string; // ISO date string
  relatedEntityName?: string;
  confidence: number;
  sourceQuote: string;
}

export interface EventExtractionResult {
  entityId: string;
  events: ExtractedEvent[];
  tokensUsed?: number;
}

// JSON Schema for event extraction
const EVENTS_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          eventType: {
            type: 'string',
            description: 'Type: meeting, deadline, commitment, follow_up',
          },
          title: { type: 'string' },
          description: { type: 'string' },
          eventDate: {
            type: 'string',
            description: 'ISO date if mentioned, null otherwise',
          },
          relatedEntityName: {
            type: 'string',
            description: 'Name of other person involved, if any',
          },
          confidence: { type: 'number' },
          sourceQuote: { type: 'string' },
        },
        required: ['eventType', 'title', 'confidence', 'sourceQuote'],
      },
    },
  },
  required: ['events'],
};

interface EventsExtractionResponse {
  events: ExtractedEvent[];
}

/**
 * Extracts events (meetings, deadlines, commitments) from messages
 */
@Injectable()
export class EventExtractionService {
  private readonly logger = new Logger(EventExtractionService.name);

  constructor(
    @InjectRepository(EntityEvent)
    private eventRepo: Repository<EntityEvent>,
    private claudeAgentService: ClaudeAgentService,
  ) {}

  /**
   * Extract events from message content
   */
  async extractEvents(params: {
    entityId: string;
    entityName: string;
    messageContent: string;
    messageId?: string;
    interactionId?: string;
  }): Promise<EventExtractionResult> {
    const { entityId, entityName, messageContent, messageId, interactionId } = params;

    // Skip short messages
    if (messageContent.length < 30) {
      return { entityId, events: [] };
    }

    const prompt = this.buildPrompt(entityName, messageContent);

    try {
      const { data, usage } = await this.claudeAgentService.call<EventsExtractionResponse>({
        mode: 'oneshot',
        taskType: 'event_extraction',
        prompt,
        schema: EVENTS_SCHEMA,
        model: 'haiku',
        referenceType: 'message',
        referenceId: messageId,
        timeout: 60000,
      });

      const rawEvents = data.events || [];
      const validEvents = this.normalizeEvents(rawEvents);

      // Save events to database
      for (const event of validEvents) {
        try {
          await this.saveEvent(entityId, event, messageId, interactionId);
        } catch (saveError) {
          const msg = saveError instanceof Error ? saveError.message : String(saveError);
          this.logger.warn(`Failed to save event: ${msg}`);
        }
      }

      this.logger.log(`Extracted ${validEvents.length} events for ${entityName}`);
      return {
        entityId,
        events: validEvents,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Event extraction failed: ${message}`);
      return { entityId, events: [] };
    }
  }

  /**
   * Batch extract events from multiple messages
   */
  async extractEventsBatch(params: {
    entityId: string;
    entityName: string;
    messages: Array<{ id: string; content: string; interactionId?: string }>;
  }): Promise<EventExtractionResult> {
    const { entityId, entityName, messages } = params;

    const combined = messages
      .map((m, i) => `[${i + 1}] ${m.content}`)
      .join('\n---\n')
      .substring(0, 3000);

    const prompt = this.buildBatchPrompt(entityName, combined);

    try {
      const { data, usage } = await this.claudeAgentService.call<EventsExtractionResponse>({
        mode: 'oneshot',
        taskType: 'event_extraction',
        prompt,
        schema: EVENTS_SCHEMA,
        model: 'haiku',
        referenceType: 'interaction',
        referenceId: messages[0]?.interactionId,
        timeout: 60000,
      });

      const rawEvents = data.events || [];
      const validEvents = this.normalizeEvents(rawEvents);

      for (const event of validEvents) {
        await this.saveEvent(entityId, event, undefined, messages[0]?.interactionId);
      }

      return {
        entityId,
        events: validEvents,
        tokensUsed: usage.inputTokens + usage.outputTokens,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Batch event extraction failed: ${message}`);
      return { entityId, events: [] };
    }
  }

  /**
   * Normalize and validate extracted events
   */
  private normalizeEvents(rawEvents: ExtractedEvent[]): ExtractedEvent[] {
    return rawEvents
      .filter((e) => e.eventType && e.title && typeof e.confidence === 'number' && e.confidence >= 0.6)
      .map((e) => ({
        eventType: e.eventType,
        title: String(e.title).trim(),
        description: e.description ? String(e.description).trim() : undefined,
        eventDate: e.eventDate || undefined,
        relatedEntityName: e.relatedEntityName || undefined,
        confidence: Math.min(1, Math.max(0, e.confidence)),
        sourceQuote: String(e.sourceQuote || '').substring(0, 200),
      }));
  }

  /**
   * Save extracted event to database
   */
  private async saveEvent(
    entityId: string,
    event: ExtractedEvent,
    messageId?: string,
    interactionId?: string,
  ): Promise<EntityEvent> {
    const eventEntity = this.eventRepo.create({
      entityId,
      eventType: this.mapEventType(event.eventType),
      title: event.title.substring(0, 255),
      description: event.description,
      eventDate: event.eventDate ? new Date(event.eventDate) : undefined,
      status: EventStatus.SCHEDULED,
      confidence: event.confidence,
      sourceQuote: event.sourceQuote?.substring(0, 500),
      sourceMessageId: messageId,
    });

    return this.eventRepo.save(eventEntity);
  }

  /**
   * Map string to EventType enum
   */
  private mapEventType(type: string | EventType): EventType {
    const typeMap: Record<string, EventType> = {
      meeting: EventType.MEETING,
      deadline: EventType.DEADLINE,
      commitment: EventType.COMMITMENT,
      follow_up: EventType.FOLLOW_UP,
    };

    const normalized = String(type).toLowerCase().replace('-', '_');
    return typeMap[normalized] || EventType.COMMITMENT;
  }

  private buildPrompt(name: string, text: string): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, 800);
    return `Extract events from conversation with ${name}. Event types: meeting (scheduled calls/meetings), deadline (due dates), commitment (promises to do something), follow_up (reminders). Today is ${new Date().toISOString().split('T')[0]}. Text: ${cleanText}`;
  }

  private buildBatchPrompt(name: string, text: string): string {
    const cleanText = text.replace(/\n/g, ' ').substring(0, 1500);
    return `Extract events from conversations with ${name}. Deduplicate. Event types: meeting, deadline, commitment, follow_up. Today is ${new Date().toISOString().split('T')[0]}. Messages: ${cleanText}`;
  }
}
