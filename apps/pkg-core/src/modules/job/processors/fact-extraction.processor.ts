import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { Job as BullJob } from 'bullmq';
import { FactExtractionService } from '../../extraction/fact-extraction.service';
import { EventExtractionService } from '../../extraction/event-extraction.service';
import { SecondBrainExtractionService } from '../../extraction/second-brain-extraction.service';
import { PromiseRecipientService } from '../../extraction/promise-recipient.service';
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
    @Inject(forwardRef(() => PromiseRecipientService))
    private promiseRecipientService: PromiseRecipientService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
  ) {
    super();
  }

  async process(job: BullJob<ExtractionJobData>) {
    const { interactionId, entityId, messages } = job.data;

    this.logger.log(
      `Processing extraction job ${job.id} for entity ${entityId} with ${messages.length} messages`,
    );

    try {
      // Get entity info
      const entity = await this.entityService.findOne(entityId);

      // Skip extraction for bot messages - they don't contain useful personal information
      if (entity.isBot) {
        this.logger.debug(
          `Skipping extraction for bot entity ${entityId} (${entity.name})`,
        );
        return {
          success: true,
          factsExtracted: 0,
          eventsExtracted: 0,
          pendingEventsExtracted: 0,
          skipped: 'bot',
        };
      }

      // Map messages to the format expected by extractFactsAgentBatch
      // Include context (isOutgoing, senderName, isBotSender) for better extraction accuracy
      const formattedMessages = messages.map((m) => ({
        id: m.id,
        content: m.content,
        interactionId,
        isOutgoing: m.isOutgoing,
        senderName: m.senderEntityName,
        isBotSender: m.isBotSender,
      }));

      // Extract facts using agent mode with Smart Fusion
      // This creates EntityFacts directly (not PendingFacts) with semantic deduplication
      const factResult = await this.factExtractionService.extractFactsAgentBatch({
        entityId,
        entityName: entity.name,
        messages: formattedMessages,
        // TODO: Get chatType from interaction when available
      });

      // Extract events (meetings, deadlines, commitments) - creates EntityEvent directly
      const eventResult = await this.eventExtractionService.extractEventsBatch({
        entityId,
        entityName: entity.name,
        messages: formattedMessages,
      });

      // Second Brain extraction - creates ExtractedEvent (pending confirmation)
      // Load reply-to message info (content + sender) for context
      const replyToInfoMap = await this.promiseRecipientService.loadReplyToInfo(
        messages,
        interactionId,
      );

      // Build messages for second brain extraction
      // Use message-level senderEntityId for proper attribution in group chats
      const secondBrainMessages = await Promise.all(
        messages.map(async (m) => {
          const replyToInfo = m.replyToSourceMessageId
            ? replyToInfoMap.get(m.replyToSourceMessageId)
            : undefined;

          // Use message-level senderEntityId if available, fallback to job-level entityId
          const messageEntityId = m.senderEntityId || entityId;
          // Use message-level senderEntityName if available, fallback to loaded entity.name
          const messageEntityName = m.senderEntityName || entity.name;

          // Determine promiseToEntityId using the dedicated service
          const promiseToEntityId = await this.promiseRecipientService.resolveRecipient({
            interactionId,
            entityId: messageEntityId,
            isOutgoing: m.isOutgoing ?? false,
            replyToSenderEntityId: replyToInfo?.senderEntityId,
          });

          return {
            messageId: m.id,
            messageContent: m.content,
            interactionId,
            entityId: messageEntityId,
            entityName: messageEntityName,
            isOutgoing: m.isOutgoing ?? false,
            replyToContent: replyToInfo?.content,
            replyToSenderName: replyToInfo?.senderName,
            promiseToEntityId,
            topicName: m.topicName,
          };
        }),
      );

      const secondBrainResults =
        await this.secondBrainExtractionService.extractFromMessages(secondBrainMessages);

      const extractedEventsCount = secondBrainResults.reduce(
        (sum, r) => sum + r.extractedEvents.length,
        0,
      );

      this.logger.log(
        `Extraction job ${job.id} completed: ${factResult.factsCreated} facts, ` +
          `${eventResult.events.length} events, ${extractedEventsCount} pending events extracted`,
      );

      return {
        success: true,
        factsExtracted: factResult.factsCreated,
        eventsExtracted: eventResult.events.length,
        pendingEventsExtracted: extractedEventsCount,
      };
    } catch (error: any) {
      this.logger.error(`Extraction job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }
}
