import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, forwardRef, Logger, Optional } from '@nestjs/common';
import { Job as BullJob } from 'bullmq';
import { Interaction } from '@pkg/entities';
import { DataSource } from 'typeorm';
import { UnifiedExtractionService } from '../../extraction/unified-extraction.service';
import { GroupExtractionService } from '../../extraction/group-extraction.service';
import { EntityService } from '../../entity/entity.service';
import { InteractionService } from '../../interaction/interaction.service';
import { ChatCategoryService } from '../../chat-category/chat-category.service';
import { TopicBoundaryDetectorService } from '../../segmentation/topic-boundary-detector.service';
import { SegmentationService } from '../../segmentation/segmentation.service';
import { OrphanSegmentLinkerService } from '../../segmentation/orphan-segment-linker.service';
import { ExtractionJobData } from '../job.service';
import { MessageData } from '../../extraction/extraction.types';

@Processor('fact-extraction')
export class FactExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(FactExtractionProcessor.name);

  constructor(
    @Inject(forwardRef(() => UnifiedExtractionService))
    private unifiedExtractionService: UnifiedExtractionService,
    @Inject(forwardRef(() => GroupExtractionService))
    private groupExtractionService: GroupExtractionService,
    @Inject(forwardRef(() => EntityService))
    private entityService: EntityService,
    @Inject(forwardRef(() => InteractionService))
    private interactionService: InteractionService,
    @Optional()
    @Inject(forwardRef(() => ChatCategoryService))
    private chatCategoryService: ChatCategoryService | null,
    private readonly topicDetector: TopicBoundaryDetectorService,
    private readonly segmentationService: SegmentationService,
    private readonly orphanLinker: OrphanSegmentLinkerService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: BullJob<ExtractionJobData>) {
    const { interactionId, messages } = job.data;

    this.logger.log(
      `Processing extraction job ${job.id} for interaction ${interactionId} with ${messages.length} messages`,
    );

    try {
      // Determine chat type from interaction metadata
      let interaction: Interaction | null = null;
      try {
        interaction = await this.interactionService.findOne(interactionId);
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.logger.error(
          `Failed to load interaction ${interactionId}: ${err.message}. ` +
            `Refusing to process — wrong chat type would corrupt data.`,
          err.stack,
        );
        throw err;
      }

      const chatType = interaction?.sourceMetadata?.chat_type;

      // Resolve chat title from ChatCategory for conversation context
      const chatTitle = await this.resolveChatTitle(interaction);

      if (chatType === 'group' || chatType === 'supergroup') {
        return this.processGroupChat(job, interaction!, chatTitle);
      }

      return this.processPrivateChat(job, chatTitle);
    } catch (error: any) {
      this.logger.error(`Extraction job ${job.id} failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async processPrivateChat(job: BullJob<ExtractionJobData>, chatTitle?: string) {
    const { interactionId, entityId, messages } = job.data;

    // Get entity info
    const entity = await this.entityService.findOne(entityId);

    // Skip extraction for bot entities
    if (entity.isBot) {
      this.logger.debug(
        `Skipping extraction for bot entity ${entityId} (${entity.name})`,
      );
      return { success: true, skipped: 'bot' };
    }

    // Single unified extraction call for facts, events, and relations
    const result = await this.unifiedExtractionService.extract({
      entityId,
      entityName: entity.name,
      messages,
      interactionId,
      chatTitle,
    });

    this.logger.log(
      `Extraction job ${job.id} completed (private): ${result.factsCreated} facts, ` +
        `${result.eventsCreated} events, ${result.relationsCreated} relations, ` +
        `${result.pendingEntities} pending entities`,
    );

    // Fire-and-forget: trigger segmentation for processed messages
    this.triggerSegmentation(interactionId, messages, chatTitle).catch((err) =>
      this.logger.error(`[segmentation] Post-extraction segmentation failed for interaction ${interactionId}: ${err.message}`, err.stack),
    );

    return {
      success: true,
      factsCreated: result.factsCreated,
      eventsCreated: result.eventsCreated,
      relationsCreated: result.relationsCreated,
      pendingEntities: result.pendingEntities,
    };
  }

  private async processGroupChat(job: BullJob<ExtractionJobData>, interaction: Interaction, chatTitle?: string) {
    const { interactionId, messages } = job.data;

    this.logger.log(`Processing GROUP chat extraction for interaction ${interactionId}`);

    const result = await this.groupExtractionService.extract({
      interactionId,
      messages,
      participants: interaction.participants || [],
      chatName: chatTitle,
    });

    this.logger.log(
      `Extraction job ${job.id} completed (group): ${result.factsCreated} facts, ` +
        `${result.eventsCreated} events, ${result.relationsCreated} relations, ` +
        `${result.pendingEntities} pending entities`,
    );

    // Fire-and-forget: trigger segmentation for processed messages
    this.triggerSegmentation(interactionId, messages, chatTitle).catch((err) =>
      this.logger.error(`[segmentation] Post-extraction segmentation failed for interaction ${interactionId}: ${err.message}`, err.stack),
    );

    return {
      success: true,
      factsCreated: result.factsCreated,
      eventsCreated: result.eventsCreated,
      relationsCreated: result.relationsCreated,
      pendingEntities: result.pendingEntities,
    };
  }

  /**
   * Trigger topical segmentation for messages processed by extraction.
   * Runs after extraction completes — detects topic boundaries and creates TopicalSegments.
   * Also links related segments across chats for cross-chat discovery.
   */
  private async triggerSegmentation(
    interactionId: string,
    messages: MessageData[],
    chatTitle?: string,
  ): Promise<void> {
    // Resolve chatId and participants from the interaction
    const interactionRows: Array<{ source_metadata: Record<string, unknown> }> =
      await this.dataSource.query(
        `SELECT source_metadata FROM interactions WHERE id = $1`,
        [interactionId],
      );

    const chatId = interactionRows[0]?.source_metadata?.telegram_chat_id as string | undefined;
    if (!chatId) {
      this.logger.debug(`[segmentation] No telegram_chat_id for interaction ${interactionId}, skipping`);
      return;
    }

    // Get participant entity IDs
    const participants: Array<{ entity_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT ip.entity_id
       FROM interaction_participants ip
       WHERE ip.interaction_id = $1
         AND ip.entity_id IS NOT NULL`,
      [interactionId],
    );
    const participantIds = participants.map((p) => p.entity_id);

    this.logger.log(
      `[segmentation] Triggering post-extraction segmentation for interaction ${interactionId}: ` +
        `${messages.length} messages, ${participantIds.length} participants`,
    );

    // Detect topics and create segments
    const result = await this.topicDetector.detectAndCreate({
      chatId,
      interactionId,
      messages,
      participantIds,
      chatTitle,
    });

    // Link related segments for cross-chat discovery
    for (const segmentId of result.segmentIds) {
      try {
        const related = await this.segmentationService.findRelatedSegments(segmentId);
        if (related.length > 0) {
          const relatedIds = related.map((r) => r.segmentId);
          await this.segmentationService.linkRelatedSegments(segmentId, relatedIds);
        }
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `[segmentation] Failed to link related segments for ${segmentId}: ${err.message}`,
        );
      }
    }

    // Sequentially link orphan segments (no activityId) to Activities
    for (const segmentId of result.segmentIds) {
      try {
        await this.orphanLinker.linkOrphanSegment(segmentId);
      } catch (err) {
        this.logger.warn(
          `[segmentation] Failed to link orphan segment ${segmentId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (result.segmentCount > 0) {
      this.logger.log(
        `[segmentation] Post-extraction segmentation completed for interaction ${interactionId}: ` +
          `${result.segmentCount} segments created, ${result.messagesAssigned} messages assigned`,
      );
    }
  }

  /**
   * Resolve chat title from ChatCategory using interaction's telegram_chat_id.
   * Returns undefined if ChatCategoryService is not available or title not found.
   */
  private async resolveChatTitle(interaction: Interaction | null): Promise<string | undefined> {
    if (!interaction || !this.chatCategoryService) return undefined;

    const telegramChatId = interaction.sourceMetadata?.telegram_chat_id;
    if (!telegramChatId) return undefined;

    try {
      const category = await this.chatCategoryService.getCategory(String(telegramChatId));
      if (category?.title) {
        this.logger.debug(`Resolved chat title: "${category.title}" for chat ${telegramChatId}`);
        return category.title;
      }
    } catch (error) {
      this.logger.warn(`Failed to resolve chat title for ${telegramChatId}: ${error}`);
    }
    return undefined;
  }
}
