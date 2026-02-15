import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Interaction, Message, TopicalSegment } from '@pkg/entities';
import { TopicBoundaryDetectorService } from './topic-boundary-detector.service';
import { SegmentationService } from './segmentation.service';
import { SettingsService } from '../settings/settings.service';
import { MessageData } from '../extraction/extraction.types';

/** Minimum unsegmented messages required to trigger segmentation for a chat */
const MIN_UNSEGMENTED_MESSAGES = 4;

@Injectable()
export class SegmentationJobService {
  private readonly logger = new Logger(SegmentationJobService.name);
  private isRunning = false;

  constructor(
    @InjectRepository(Interaction)
    private readonly interactionRepo: Repository<Interaction>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
    private readonly topicDetector: TopicBoundaryDetectorService,
    private readonly segmentationService: SegmentationService,
    private readonly settingsService: SettingsService,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('0 * * * *', { name: 'segmentation-job', timeZone: 'Europe/Moscow' })
  async handleCron(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('[segmentation-job] Skipping: previous run still in progress');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    let interactionsProcessed = 0;
    let totalSegmentsCreated = 0;
    let errorCount = 0;

    try {
      // Check feature flag
      const enabled = await this.settingsService.getValue<boolean>('segmentation.autoEnabled') ?? true;
      if (!enabled) {
        this.logger.log('[segmentation-job] Disabled via settings, skipping');
        return;
      }

      // Find interactions updated in the last 2 hours with Telegram chat messages
      const interactions: Array<{ id: string; source_metadata: Record<string, unknown> }> =
        await this.dataSource.query(`
          SELECT DISTINCT i.id, i.source_metadata
          FROM interactions i
          INNER JOIN messages m ON m.interaction_id = i.id
          WHERE i.updated_at > NOW() - INTERVAL '2 hours'
            AND i.source_metadata->>'telegram_chat_id' IS NOT NULL
        `);

      if (interactions.length === 0) {
        this.logger.debug('[segmentation-job] No recent interactions to process');
        return;
      }

      this.logger.log(`[segmentation-job] Found ${interactions.length} interaction(s) to check`);

      for (const interaction of interactions) {
        try {
          const segmentsCreated = await this.processInteraction(interaction);
          if (segmentsCreated > 0) {
            interactionsProcessed++;
            totalSegmentsCreated += segmentsCreated;
          }
        } catch (error: unknown) {
          errorCount++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            `[segmentation-job] Error processing interaction ${interaction.id}: ${err.message}`,
            err.stack,
          );
        }
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `[segmentation-job] Completed: ${interactionsProcessed} interactions processed, ` +
          `${totalSegmentsCreated} segments created, ${errorCount} errors, ${durationMs}ms`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `[segmentation-job] Fatal error: ${err.message}`,
        err.stack,
      );
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single interaction: find unsegmented messages, detect topics, link segments.
   * Returns the number of segments created.
   */
  private async processInteraction(
    interaction: { id: string; source_metadata: Record<string, unknown> },
  ): Promise<number> {
    const chatId = interaction.source_metadata?.telegram_chat_id as string;
    if (!chatId) return 0;

    // Find messages NOT already linked to any segment
    // Using LEFT JOIN instead of NOT IN for better performance (avoids full scan of segment_messages)
    // Raw SQL returns snake_case columns — map explicitly to camelCase
    const rawMessages: Array<{
      id: string;
      content: string | null;
      timestamp: Date;
      is_outgoing: boolean;
      sender_entity_id: string | null;
      reply_to_source_message_id: string | null;
      topic_name: string | null;
    }> = await this.dataSource.query(
      `SELECT m.id, m.content, m.timestamp, m.is_outgoing,
              m.sender_entity_id, m.reply_to_source_message_id, m.topic_name
       FROM messages m
       LEFT JOIN segment_messages sm ON sm.message_id = m.id
       WHERE m.interaction_id = $1
         AND sm.message_id IS NULL
       ORDER BY m.timestamp ASC`,
      [interaction.id],
    );

    if (rawMessages.length < MIN_UNSEGMENTED_MESSAGES) {
      this.logger.debug(
        `[segmentation-job] Interaction ${interaction.id}: ` +
          `only ${rawMessages.length} unsegmented message(s), skipping`,
      );
      return 0;
    }

    // Map raw snake_case rows to MessageData format
    const messages: MessageData[] = rawMessages.map((m) => ({
      id: m.id,
      content: m.content || '',
      timestamp: new Date(m.timestamp).toISOString(),
      isOutgoing: m.is_outgoing,
      senderEntityId: m.sender_entity_id ?? undefined,
      replyToSourceMessageId: m.reply_to_source_message_id ?? undefined,
      topicName: m.topic_name ?? undefined,
    }));

    // Get participant entity IDs
    const participants: Array<{ entity_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT ip.entity_id
       FROM interaction_participants ip
       WHERE ip.interaction_id = $1
         AND ip.entity_id IS NOT NULL`,
      [interaction.id],
    );
    const participantIds = participants.map((p) => p.entity_id);

    this.logger.log(
      `[segmentation-job] Processing interaction ${interaction.id} (chat ${chatId}): ` +
        `${messages.length} unsegmented messages, ${participantIds.length} participants`,
    );

    // Detect topics and create segments
    const result = await this.topicDetector.detectAndCreate({
      chatId,
      interactionId: interaction.id,
      messages,
      participantIds,
    });

    // Link related segments for cross-chat discovery
    for (const segmentId of result.segmentIds) {
      try {
        const related = await this.segmentationService.findRelatedSegments(segmentId);
        if (related.length > 0) {
          const relatedIds = related.map((r) => r.segmentId);
          await this.segmentationService.linkRelatedSegments(segmentId, relatedIds);
        }
      } catch (error: any) {
        this.logger.warn(
          `[segmentation-job] Failed to link related segments for ${segmentId}: ${error.message}`,
        );
      }
    }

    return result.segmentCount;
  }
}
