import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Job as BullJob } from 'bullmq';
import { Message, Interaction, InteractionParticipant } from '@pkg/entities';
import { FactExtractionService } from '../../extraction/fact-extraction.service';
import { EventExtractionService } from '../../extraction/event-extraction.service';
import { SecondBrainExtractionService } from '../../extraction/second-brain-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { ExtractionJobData } from '../job.service';

interface ReplyToInfo {
  content?: string;
  senderEntityId?: string;
  senderName?: string;
}

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
    @InjectRepository(Interaction)
    private interactionRepo: Repository<Interaction>,
    @InjectRepository(InteractionParticipant)
    private participantRepo: Repository<InteractionParticipant>,
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
      // Load reply-to message info (content + sender) for context
      const replyToInfoMap = await this.loadReplyToInfo(messages, interactionId);

      // Determine promiseToEntityId for private chats
      const privateRecipientId = await this.getPrivateChatRecipient(interactionId, entityId);

      const secondBrainMessages = messages.map((m) => {
        const replyToInfo = m.replyToSourceMessageId
          ? replyToInfoMap.get(m.replyToSourceMessageId)
          : undefined;

        // Determine promiseToEntityId:
        // 1. For private chats: the other participant (privateRecipientId)
        // 2. For replies: the sender of the replied message
        // 3. Otherwise: null
        let promiseToEntityId: string | undefined;
        if (m.isOutgoing) {
          if (privateRecipientId) {
            promiseToEntityId = privateRecipientId;
          } else if (replyToInfo?.senderEntityId) {
            promiseToEntityId = replyToInfo.senderEntityId;
          }
        }

        return {
          messageId: m.id,
          messageContent: m.content,
          interactionId,
          entityId,
          entityName: entity.name,
          isOutgoing: m.isOutgoing ?? false,
          replyToContent: replyToInfo?.content,
          replyToSenderName: replyToInfo?.senderName,
          replyToSenderId: replyToInfo?.senderEntityId,
          promiseToEntityId,
          topicName: m.topicName,
        };
      });

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
   * Load info about messages that are being replied to.
   * Returns a map of sourceMessageId -> ReplyToInfo (content, senderEntityId, senderName)
   */
  private async loadReplyToInfo(
    messages: ExtractionJobData['messages'],
    interactionId: string,
  ): Promise<Map<string, ReplyToInfo>> {
    const replyToIds = messages
      .map((m) => m.replyToSourceMessageId)
      .filter((id): id is string => !!id);

    if (replyToIds.length === 0) {
      return new Map();
    }

    // Find messages by their source_message_id (Telegram message ID)
    // Include sender info for determining promiseToEntityId
    const replyToMessages = await this.messageRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.senderEntity', 'sender')
      .where('m.sourceMessageId IN (:...ids)', { ids: replyToIds })
      .andWhere('m.interactionId = :interactionId', { interactionId })
      .getMany();

    const infoMap = new Map<string, ReplyToInfo>();
    for (const msg of replyToMessages) {
      if (msg.sourceMessageId) {
        infoMap.set(msg.sourceMessageId, {
          content: msg.content || undefined,
          senderEntityId: msg.senderEntityId || undefined,
          senderName: msg.senderEntity?.name || undefined,
        });
      }
    }

    this.logger.debug(
      `Loaded ${infoMap.size} reply-to messages for ${replyToIds.length} replies`,
    );

    return infoMap;
  }

  /**
   * Get the other participant's entity ID for private chats.
   * Returns undefined for group chats.
   */
  private async getPrivateChatRecipient(
    interactionId: string,
    currentEntityId: string,
  ): Promise<string | undefined> {
    // Get interaction to check if it's a private chat
    const interaction = await this.interactionRepo.findOne({
      where: { id: interactionId },
    });

    if (!interaction) {
      return undefined;
    }

    // Check if private chat from source_metadata
    const sourceMetadata = interaction.sourceMetadata as Record<string, unknown> | null;
    const chatType = sourceMetadata?.chat_type as string | undefined;

    if (chatType !== 'private') {
      return undefined;
    }

    // Get all participants of this interaction
    const participants = await this.participantRepo.find({
      where: { interactionId },
      relations: ['entity'],
    });

    // Find the OTHER participant (not the current entity and not the user)
    // In private chats there are 2 participants: user and contact
    for (const p of participants) {
      if (p.entityId && p.entityId !== currentEntityId) {
        // Check it's not the user themselves (is_bot = false means it's a person)
        return p.entityId;
      }
    }

    return undefined;
  }
}
