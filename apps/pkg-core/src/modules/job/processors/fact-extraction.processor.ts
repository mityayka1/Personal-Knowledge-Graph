import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Job as BullJob } from 'bullmq';
import { Message } from '@pkg/entities';
import { FactExtractionService } from '../../extraction/fact-extraction.service';
import { EventExtractionService } from '../../extraction/event-extraction.service';
import { SecondBrainExtractionService } from '../../extraction/second-brain-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { ExtractionJobData } from '../job.service';

@Processor('fact-extraction')
export class FactExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(FactExtractionProcessor.name);

  constructor(
    @Inject(forwardRef(() => FactExtractionService))
    private factExtractionService: FactExtractionService,
    @Inject(forwardRef(() => EventExtractionService))
    private eventExtractionService: EventExtractionService,
    @Inject(forwardRef(() => SecondBrainExtractionService))
    private secondBrainExtractionService: SecondBrainExtractionService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
    @InjectRepository(Message)
    private messageRepo: Repository<Message>,
  ) {
    super();
  }

  async process(job: BullJob<ExtractionJobData>) {
    const { interactionId, entityId, messages } = job.data;

    this.logger.log(
      `Processing extraction job ${job.id} for entity ${entityId} with ${messages.length} messages`,
    );

    try {
      // Get entity name
      const entity = await this.entityService.findOne(entityId);

      // Map messages to the format expected by extractFactsBatch
      const formattedMessages = messages.map((m) => ({
        id: m.id,
        content: m.content,
        interactionId,
      }));

      // Extract facts using Claude CLI
      const factResult = await this.factExtractionService.extractFactsBatch({
        entityId,
        entityName: entity.name,
        messages: formattedMessages,
      });

      // Extract events (meetings, deadlines, commitments) - creates EntityEvent directly
      const eventResult = await this.eventExtractionService.extractEventsBatch({
        entityId,
        entityName: entity.name,
        messages: formattedMessages,
      });

      // Second Brain extraction - creates ExtractedEvent (pending confirmation)
      // Load reply-to message content for context
      const replyToContents = await this.loadReplyToContents(messages);

      const secondBrainMessages = messages.map((m) => ({
        messageId: m.id,
        messageContent: m.content,
        interactionId,
        entityId,
        entityName: entity.name,
        isOutgoing: m.isOutgoing ?? false,
        replyToContent: m.replyToSourceMessageId
          ? replyToContents.get(m.replyToSourceMessageId)
          : undefined,
        topicName: m.topicName,
      }));

      const secondBrainResults =
        await this.secondBrainExtractionService.extractFromMessages(secondBrainMessages);

      const extractedEventsCount = secondBrainResults.reduce(
        (sum, r) => sum + r.extractedEvents.length,
        0,
      );

      this.logger.log(
        `Extraction job ${job.id} completed: ${factResult.facts.length} facts, ` +
          `${eventResult.events.length} events, ${extractedEventsCount} pending events extracted`,
      );

      return {
        success: true,
        factsExtracted: factResult.facts.length,
        eventsExtracted: eventResult.events.length,
        pendingEventsExtracted: extractedEventsCount,
      };
    } catch (error: any) {
      this.logger.error(`Extraction job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Load content of messages that are being replied to.
   * Returns a map of sourceMessageId -> content
   */
  private async loadReplyToContents(
    messages: ExtractionJobData['messages'],
  ): Promise<Map<string, string>> {
    const replyToIds = messages
      .map((m) => m.replyToSourceMessageId)
      .filter((id): id is string => !!id);

    if (replyToIds.length === 0) {
      return new Map();
    }

    // Find messages by their source_message_id (Telegram message ID)
    const replyToMessages = await this.messageRepo.find({
      where: { sourceMessageId: In(replyToIds) },
      select: ['sourceMessageId', 'content'],
    });

    const contentMap = new Map<string, string>();
    for (const msg of replyToMessages) {
      if (msg.sourceMessageId && msg.content) {
        contentMap.set(msg.sourceMessageId, msg.content);
      }
    }

    this.logger.debug(
      `Loaded ${contentMap.size} reply-to messages for ${replyToIds.length} replies`,
    );

    return contentMap;
  }
}
