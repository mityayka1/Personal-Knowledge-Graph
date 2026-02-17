import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Interaction, Message } from '@pkg/entities';
import { TopicBoundaryDetectorService } from './topic-boundary-detector.service';
import { SegmentationService } from './segmentation.service';
import { SettingsService } from '../settings/settings.service';
import { MessageData } from '../extraction/extraction.types';

/** Minimum unsegmented messages required to trigger segmentation for a chat */
const MIN_UNSEGMENTED_MESSAGES = 4;

/** Delay between Claude API calls to avoid rate limiting (ms) */
const INTER_CALL_DELAY_MS = 2_000;

/** How far back to look for unsegmented messages (hours) */
const LOOKBACK_HOURS = 48;

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
    let chatsProcessed = 0;
    let totalSegmentsCreated = 0;
    let errorCount = 0;

    try {
      // Check feature flag
      const enabled = await this.settingsService.getValue<boolean>('segmentation.autoEnabled') ?? true;
      if (!enabled) {
        this.logger.log('[segmentation-job] Disabled via settings, skipping');
        return;
      }

      // Find CHATS (not interactions) with enough unsegmented messages.
      // Previous approach queried per-interaction, but Telegram session management
      // creates many small interactions (1-2 msgs each), so the threshold was never met.
      // Now we aggregate by telegram_chat_id across all interactions.
      const chats: Array<{ chat_id: string; unsegmented_count: string }> =
        await this.dataSource.query(`
          SELECT i.source_metadata->>'telegram_chat_id' AS chat_id,
                 COUNT(m.id) AS unsegmented_count
          FROM messages m
          INNER JOIN interactions i ON i.id = m.interaction_id
          LEFT JOIN segment_messages sm ON sm.message_id = m.id
          WHERE i.source_metadata->>'telegram_chat_id' IS NOT NULL
            AND sm.message_id IS NULL
            AND m.timestamp > NOW() - INTERVAL '${LOOKBACK_HOURS} hours'
          GROUP BY i.source_metadata->>'telegram_chat_id'
          HAVING COUNT(m.id) >= ${MIN_UNSEGMENTED_MESSAGES}
          ORDER BY COUNT(m.id) DESC
        `);

      if (chats.length === 0) {
        this.logger.debug('[segmentation-job] No chats with enough unsegmented messages');
        return;
      }

      this.logger.log(
        `[segmentation-job] Found ${chats.length} chat(s) with unsegmented messages: ` +
          chats.map((c) => `${c.chat_id}(${c.unsegmented_count})`).join(', '),
      );

      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];

        // Rate limiting: delay between Claude API calls (skip before first)
        if (i > 0) {
          await new Promise((resolve) => setTimeout(resolve, INTER_CALL_DELAY_MS));
        }

        try {
          const segmentsCreated = await this.processChat(chat.chat_id);
          if (segmentsCreated > 0) {
            chatsProcessed++;
            totalSegmentsCreated += segmentsCreated;
          }
        } catch (error: unknown) {
          errorCount++;
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            `[segmentation-job] Error processing chat ${chat.chat_id}: ${err.message}`,
            err.stack,
          );
        }
      }

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `[segmentation-job] Completed: ${chatsProcessed} chats processed, ` +
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
   * Process a single chat: collect ALL unsegmented messages across interactions,
   * detect topics, create segments, and link related.
   */
  private async processChat(chatId: string): Promise<number> {
    // Get ALL unsegmented messages for this chat across ALL interactions
    const rawMessages: Array<{
      id: string;
      content: string | null;
      timestamp: Date;
      is_outgoing: boolean;
      sender_entity_id: string | null;
      reply_to_source_message_id: string | null;
      topic_name: string | null;
      interaction_id: string;
    }> = await this.dataSource.query(
      `SELECT m.id, m.content, m.timestamp, m.is_outgoing,
              m.sender_entity_id, m.reply_to_source_message_id,
              m.topic_name, m.interaction_id
       FROM messages m
       INNER JOIN interactions i ON i.id = m.interaction_id
       LEFT JOIN segment_messages sm ON sm.message_id = m.id
       WHERE i.source_metadata->>'telegram_chat_id' = $1
         AND sm.message_id IS NULL
         AND m.timestamp > NOW() - INTERVAL '${LOOKBACK_HOURS} hours'
       ORDER BY m.timestamp ASC`,
      [chatId],
    );

    if (rawMessages.length < MIN_UNSEGMENTED_MESSAGES) {
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

    // Use the first message's interaction_id as the primary interaction
    // (segments may span multiple interactions, but we need one for the FK)
    const primaryInteractionId = rawMessages[0].interaction_id;

    // Get participant entity IDs across all interactions for this chat
    const participants: Array<{ entity_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT ip.entity_id
       FROM interaction_participants ip
       INNER JOIN interactions i ON i.id = ip.interaction_id
       WHERE i.source_metadata->>'telegram_chat_id' = $1
         AND ip.entity_id IS NOT NULL`,
      [chatId],
    );
    const participantIds = participants.map((p) => p.entity_id);

    // Try to get chat title from the most recent interaction
    const chatTitleRow: Array<{ title: string | null }> = await this.dataSource.query(
      `SELECT i.source_metadata->>'chat_title' AS title
       FROM interactions i
       WHERE i.source_metadata->>'telegram_chat_id' = $1
       ORDER BY i.updated_at DESC
       LIMIT 1`,
      [chatId],
    );
    const chatTitle = chatTitleRow?.[0]?.title ?? undefined;

    this.logger.log(
      `[segmentation-job] Processing chat ${chatId}${chatTitle ? ` "${chatTitle}"` : ''}: ` +
        `${messages.length} unsegmented messages, ${participantIds.length} participants`,
    );

    // Detect topics and create segments
    const result = await this.topicDetector.detectAndCreate({
      chatId,
      interactionId: primaryInteractionId,
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
          `[segmentation-job] Failed to link related segments for ${segmentId}: ${err.message}`,
        );
      }
    }

    return result.segmentCount;
  }
}
