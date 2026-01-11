import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { Dialog } from 'telegram/tl/custom/dialog';
import { MessageHandlerService, ChatType } from './message-handler.service';
import { PkgCoreApiService, ChatStats } from '../api/pkg-core-api.service';

/**
 * Forum topic information from Telegram.
 */
interface ForumTopic {
  id: number;
  title: string;
  iconColor: number;
  isClosed: boolean;
  isPinned: boolean;
  isGeneral: boolean;
}

/**
 * Import progress tracking for UI updates.
 */
export interface ImportProgress {
  status: 'idle' | 'running' | 'completed' | 'error';
  phase: 'private' | 'groups' | 'forums' | 'done';
  totalDialogs: number;
  processedDialogs: number;
  currentDialog?: string;
  currentTopic?: string;
  totalMessages: number;
  processedMessages: number;
  autoCreatedEntities: number;
  errors: string[];
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Import configuration.
 */
interface ImportConfig {
  /** Limit per group chat (default: 1000) */
  groupMessageLimit: number;
  /** Limit per forum topic (default: 1000) */
  forumTopicLimit: number;
  /** Delay between batches to avoid rate limiting (ms) */
  batchDelayMs: number;
  /** Delay between chats (ms) */
  chatDelayMs: number;
  /** Delay between topics (ms) */
  topicDelayMs: number;
}

/**
 * Options for startImport method.
 *
 * Note on skipExisting vs incrementalOnly:
 * - skipExisting=true: Completely skips dialogs that exist in PKG Core (fastest for initial import)
 * - incrementalOnly=true: Imports only NEW messages (id > lastMessageId) from existing dialogs
 * - Both true: skipExisting takes precedence (existing dialogs are skipped entirely)
 * - Both false: Full re-import of all dialogs and all messages
 *
 * Recommended usage:
 * - First import: privateOnly=true (import all private chats fully)
 * - Subsequent imports: skipExisting=true (only import new dialogs)
 * - Sync updates: incrementalOnly=true (fetch only new messages from existing dialogs)
 */
interface StartImportOptions {
  /** If true, import only private chats (personal dialogs) */
  privateOnly?: boolean;
  /** If true, skip dialogs that already have messages in PKG Core (takes precedence over incrementalOnly) */
  skipExisting?: boolean;
  /** If true, only import new messages (using minId from existing data). Does not apply to forums. */
  incrementalOnly?: boolean;
}

/**
 * Dialog with existing stats from PKG Core.
 */
interface DialogWithStats {
  dialog: Dialog;
  existingStats?: ChatStats;
  isNew: boolean;
}

/**
 * Service for importing Telegram history with sequential phases:
 * 1. Private chats - ALL history, auto-create Entity
 * 2. Group chats - with message limit
 * 3. Forums - limit per topic
 */
@Injectable()
export class HistoryImportService {
  private readonly logger = new Logger(HistoryImportService.name);
  private progress: ImportProgress = this.getInitialProgress();
  private config: ImportConfig;

  constructor(
    private messageHandler: MessageHandlerService,
    private configService: ConfigService,
    private pkgCoreApi: PkgCoreApiService,
  ) {
    this.config = {
      groupMessageLimit: this.configService.get<number>('IMPORT_GROUP_LIMIT', 1000),
      forumTopicLimit: this.configService.get<number>('IMPORT_TOPIC_LIMIT', 1000),
      batchDelayMs: this.configService.get<number>('IMPORT_BATCH_DELAY_MS', 200),
      chatDelayMs: this.configService.get<number>('IMPORT_CHAT_DELAY_MS', 1000),
      topicDelayMs: this.configService.get<number>('IMPORT_TOPIC_DELAY_MS', 500),
    };
  }

  private getInitialProgress(): ImportProgress {
    return {
      status: 'idle',
      phase: 'private',
      totalDialogs: 0,
      processedDialogs: 0,
      totalMessages: 0,
      processedMessages: 0,
      autoCreatedEntities: 0,
      errors: [],
    };
  }

  getProgress(): ImportProgress {
    return { ...this.progress };
  }

  /**
   * Start sequential import of Telegram history.
   * Phase 1: Private chats (ALL history, auto-create Entity)
   * Phase 2: Group chats (with limit) - skipped if privateOnly=true
   * Phase 3: Forums (limit per topic) - skipped if privateOnly=true
   *
   * Optimization: Dialogs are sorted with new ones first.
   * - skipExisting: Skip dialogs that already exist in PKG Core
   * - incrementalOnly: Only fetch new messages (using minId)
   */
  async startImport(client: TelegramClient, options: StartImportOptions = {}): Promise<void> {
    const { privateOnly = false, skipExisting = false, incrementalOnly = false } = options;
    if (this.progress.status === 'running') {
      throw new Error('Import is already running');
    }

    this.progress = {
      ...this.getInitialProgress(),
      status: 'running',
      startedAt: new Date(),
    };

    try {
      this.logger.log(`Starting Telegram history import...`);
      this.logger.log(`Options: privateOnly=${privateOnly}, skipExisting=${skipExisting}, incrementalOnly=${incrementalOnly}`);
      this.logger.log(`Config: group limit=${this.config.groupMessageLimit}, topic limit=${this.config.forumTopicLimit}`);

      // Fetch existing chat stats from PKG Core for optimization
      let chatStatsMap: Map<string, ChatStats> = new Map();
      try {
        this.logger.log('Fetching existing chat stats from PKG Core...');
        const statsResponse = await this.pkgCoreApi.getChatStats();
        for (const stats of statsResponse.chats) {
          chatStatsMap.set(stats.telegramChatId, stats);
        }
        this.logger.log(`Found ${chatStatsMap.size} existing chats in PKG Core`);
      } catch (error) {
        this.logger.warn(`Could not fetch chat stats, proceeding without optimization: ${error}`);
      }

      // Classify all dialogs
      const { privateChats, groupChats, forumChats } = await this.classifyDialogs(client);

      // Enrich dialogs with existing stats and sort (new first)
      const enrichedPrivateChats = this.enrichAndSortDialogs(privateChats, chatStatsMap);
      const enrichedGroupChats = this.enrichAndSortDialogs(groupChats, chatStatsMap);

      // Count dialogs to process
      const privateToProcess = skipExisting
        ? enrichedPrivateChats.filter(d => d.isNew).length
        : enrichedPrivateChats.length;
      const groupsToProcess = privateOnly ? 0 : (skipExisting
        ? enrichedGroupChats.filter(d => d.isNew).length
        : enrichedGroupChats.length);
      const forumsToProcess = privateOnly ? 0 : forumChats.length;

      this.progress.totalDialogs = privateToProcess + groupsToProcess + forumsToProcess;

      this.logger.log(
        `Found ${privateChats.length} private (${enrichedPrivateChats.filter(d => d.isNew).length} new), ` +
        `${groupChats.length} group (${enrichedGroupChats.filter(d => d.isNew).length} new), ` +
        `${forumChats.length} forum chats` +
        (privateOnly ? ' (importing private only)' : '') +
        (skipExisting ? ' (skipping existing)' : '') +
        (incrementalOnly ? ' (incremental mode)' : ''),
      );

      // Phase 1: Private chats (ALL history, auto-create Entity)
      this.progress.phase = 'private';
      for (const { dialog, existingStats, isNew } of enrichedPrivateChats) {
        // Skip existing if option enabled
        if (skipExisting && !isNew) {
          this.logger.debug(`Skipping existing private chat: ${this.getDialogName(dialog)}`);
          continue;
        }

        try {
          // Use minId for incremental import (validate parsed value)
          let minId: number | undefined;
          if (incrementalOnly && existingStats?.lastMessageId) {
            const parsed = parseInt(existingStats.lastMessageId, 10);
            minId = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
          }
          await this.importPrivateChat(client, dialog, { minId });
          this.progress.processedDialogs++;
        } catch (error) {
          const dialogId = dialog.id?.toString() ?? 'unknown';
          const errMsg = `[private] Dialog ${dialogId}: ${error instanceof Error ? error.message : String(error)}`;
          this.logger.error(errMsg, error instanceof Error ? error.stack : undefined);
          this.progress.errors.push(errMsg);
        }
        await this.delay(this.config.chatDelayMs);
      }

      // Skip groups and forums if privateOnly
      if (!privateOnly) {
        // Phase 2: Group chats (with limit)
        this.progress.phase = 'groups';
        for (const { dialog, existingStats, isNew } of enrichedGroupChats) {
          // Skip existing if option enabled
          if (skipExisting && !isNew) {
            this.logger.debug(`Skipping existing group chat: ${this.getDialogName(dialog)}`);
            continue;
          }

          try {
            // Use minId for incremental import (validate parsed value)
            let minId: number | undefined;
            if (incrementalOnly && existingStats?.lastMessageId) {
              const parsed = parseInt(existingStats.lastMessageId, 10);
              minId = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
            }
            await this.importGroupChat(client, dialog, { minId });
            this.progress.processedDialogs++;
          } catch (error) {
            const dialogId = dialog.id?.toString() ?? 'unknown';
            const errMsg = `[groups] Dialog ${dialogId}: ${error instanceof Error ? error.message : String(error)}`;
            this.logger.error(errMsg, error instanceof Error ? error.stack : undefined);
            this.progress.errors.push(errMsg);
          }
          await this.delay(this.config.chatDelayMs);
        }

        // Phase 3: Forums (limit per topic)
        // Note: Forums do not support skipExisting/incrementalOnly optimizations
        // because topics are imported separately and tracking per-topic stats is not implemented
        this.progress.phase = 'forums';
        for (const { dialog, channel } of forumChats) {
          try {
            await this.importForum(client, dialog, channel);
            this.progress.processedDialogs++;
          } catch (error) {
            const forumName = channel.title ?? dialog.id?.toString() ?? 'unknown';
            const errMsg = `[forums] Forum ${forumName}: ${error instanceof Error ? error.message : String(error)}`;
            this.logger.error(errMsg, error instanceof Error ? error.stack : undefined);
            this.progress.errors.push(errMsg);
          }
          await this.delay(this.config.chatDelayMs);
        }
      }

      this.progress.status = 'completed';
      this.progress.phase = 'done';
      this.progress.completedAt = new Date();

      this.logger.log(
        `Import completed. Messages: ${this.progress.processedMessages}, ` +
          `Auto-created entities: ${this.progress.autoCreatedEntities}, ` +
          `Errors: ${this.progress.errors.length}`,
      );
    } catch (error) {
      this.progress.status = 'error';
      const errorMsg = `Fatal error: ${error instanceof Error ? error.message : String(error)}`;
      this.progress.errors.push(errorMsg);
      this.logger.error('Import failed', error);
      throw error;
    }
  }

  /**
   * Classify dialogs into private, group, and forum categories.
   */
  private async classifyDialogs(client: TelegramClient): Promise<{
    privateChats: Dialog[];
    groupChats: Dialog[];
    forumChats: { dialog: Dialog; channel: Api.Channel }[];
  }> {
    const privateChats: Dialog[] = [];
    const groupChats: Dialog[] = [];
    const forumChats: { dialog: Dialog; channel: Api.Channel }[] = [];

    const dialogs = await client.getDialogs({ limit: 500 });

    for (const dialog of dialogs) {
      const entity = dialog.entity;

      // Skip bots in private chats
      if (entity instanceof Api.User) {
        if (!entity.bot) {
          privateChats.push(dialog);
        }
        continue;
      }

      // Regular group
      if (entity instanceof Api.Chat) {
        groupChats.push(dialog);
        continue;
      }

      // Channel or Supergroup
      if (entity instanceof Api.Channel) {
        // Skip broadcast channels
        if (entity.broadcast) {
          continue;
        }

        // Forum (supergroup with topics)
        if (entity.forum) {
          forumChats.push({ dialog, channel: entity });
          continue;
        }

        // Regular supergroup
        groupChats.push(dialog);
      }
    }

    return { privateChats, groupChats, forumChats };
  }

  /**
   * Enrich dialogs with existing stats and sort (new dialogs first).
   */
  private enrichAndSortDialogs(
    dialogs: Dialog[],
    chatStatsMap: Map<string, ChatStats>,
  ): DialogWithStats[] {
    const enriched: DialogWithStats[] = dialogs.map((dialog) => {
      const telegramChatId = this.buildChatId(dialog);
      const existingStats = telegramChatId ? chatStatsMap.get(telegramChatId) : undefined;
      return {
        dialog,
        existingStats,
        isNew: !existingStats,
      };
    });

    // Sort: new dialogs first, then existing by message count (fewer first)
    return enriched.sort((a, b) => {
      if (a.isNew && !b.isNew) return -1;
      if (!a.isNew && b.isNew) return 1;
      // Both existing: sort by message count (fewer messages = less work already done)
      const aCount = a.existingStats?.messageCount || 0;
      const bCount = b.existingStats?.messageCount || 0;
      return aCount - bCount;
    });
  }

  /**
   * Build telegram_chat_id from dialog.
   * Detects entity type automatically (User -> user_, Chat -> chat_, Channel -> channel_).
   */
  private buildChatId(dialog: Dialog): string | null {
    const entity = dialog.entity;
    if (!entity) return null;

    if (entity instanceof Api.User) {
      return `user_${entity.id}`;
    }
    if (entity instanceof Api.Chat) {
      return `chat_${entity.id}`;
    }
    if (entity instanceof Api.Channel) {
      return `channel_${entity.id}`;
    }
    return null;
  }

  /**
   * Get dialog name for logging.
   */
  private getDialogName(dialog: Dialog): string {
    const entity = dialog.entity;
    if (!entity) return 'Unknown';

    if (entity instanceof Api.User) {
      return `${entity.firstName || ''} ${entity.lastName || ''}`.trim() || entity.username || 'Unknown';
    }
    if ('title' in entity) {
      return (entity as Api.Chat | Api.Channel).title || 'Unknown';
    }
    return 'Unknown';
  }

  /**
   * Import ALL messages from a private chat.
   * No limit - private chats contain valuable personal contacts.
   * Auto-creates Entity for the contact.
   *
   * @param options.minId - If provided, only fetch messages with id > minId (incremental import)
   */
  private async importPrivateChat(
    client: TelegramClient,
    dialog: Dialog,
    options: { minId?: number } = {},
  ): Promise<void> {
    const entity = dialog.entity as Api.User;
    const chatName = `${entity.firstName || ''} ${entity.lastName || ''}`.trim() || entity.username || 'Unknown';
    const userId = dialog.id?.toString();

    if (!userId) {
      this.logger.warn('Could not extract user ID from dialog, skipping');
      return;
    }

    const { minId } = options;
    this.progress.currentDialog = chatName;
    this.logger.log(
      `[Phase 1/3] Importing private chat: ${chatName}` +
      (minId ? ` (incremental, minId=${minId})` : ' (full)'),
    );

    let offsetId = 0;
    let batchCount = 0;
    let reachedMinId = false;

    // No limit for private chats - import everything (or until minId in incremental mode)
    while (true) {
      try {
        const messages = await client.getMessages(dialog.inputEntity, {
          limit: 100,
          offsetId,
          minId: minId, // GramJS supports minId parameter
        });

        if (!messages.length) {
          break;
        }

        for (const message of messages) {
          if (message instanceof Api.Message) {
            // In incremental mode, stop if we've reached messages already imported
            if (minId && message.id <= minId) {
              reachedMinId = true;
              break;
            }

            try {
              const result = await this.messageHandler.processMessageWithContext(
                message,
                client,
                { chatType: 'private' },
              );
              this.progress.totalMessages++;
              this.progress.processedMessages++;

              // Track auto-created entities
              if (result.auto_created_entity) {
                this.progress.autoCreatedEntities++;
              }
            } catch (error) {
              this.handleMessageError(message.id, error);
            }
          }
        }

        // Stop if we've reached minId
        if (reachedMinId) {
          break;
        }

        offsetId = messages[messages.length - 1].id;
        batchCount++;

        // Rate limiting
        await this.delay(this.config.batchDelayMs);

        // Log progress every 10 batches
        if (batchCount % 10 === 0) {
          this.logger.debug(`${chatName}: ${batchCount * 100}+ messages processed`);
        }
      } catch (error) {
        if (await this.handleFloodWait(error)) {
          continue;
        }
        this.logger.error(`Error fetching messages from ${chatName}: ${error}`);
        break;
      }
    }

    this.logger.log(`Imported ${batchCount * 100}+ messages from private chat: ${chatName}`);
  }

  /**
   * Import messages from a group chat with a limit.
   *
   * @param options.minId - If provided, only fetch messages with id > minId (incremental import)
   */
  private async importGroupChat(
    client: TelegramClient,
    dialog: Dialog,
    options: { minId?: number } = {},
  ): Promise<void> {
    const entity = dialog.entity;
    if (!entity) {
      this.logger.warn('Skipping group chat with no entity');
      return;
    }
    const chatName = 'title' in entity ? (entity as Api.Chat | Api.Channel).title : 'Unknown Group';
    const chatType: ChatType = entity instanceof Api.Channel ? 'supergroup' : 'group';
    const { minId } = options;

    this.progress.currentDialog = chatName;
    this.logger.log(
      `[Phase 2/3] Importing ${chatType}: ${chatName} (limit: ${this.config.groupMessageLimit})` +
      (minId ? ` (incremental, minId=${minId})` : ''),
    );

    let offsetId = 0;
    let messagesImported = 0;
    let reachedMinId = false;

    while (messagesImported < this.config.groupMessageLimit) {
      const batchSize = Math.min(100, this.config.groupMessageLimit - messagesImported);

      try {
        const messages = await client.getMessages(dialog.inputEntity, {
          limit: batchSize,
          offsetId,
          minId: minId, // GramJS supports minId parameter
        });

        if (!messages.length) {
          break;
        }

        for (const message of messages) {
          if (message instanceof Api.Message) {
            // In incremental mode, stop if we've reached messages already imported
            if (minId && message.id <= minId) {
              reachedMinId = true;
              break;
            }

            try {
              await this.messageHandler.processMessageWithContext(message, client, {
                chatType,
              });
              this.progress.totalMessages++;
              this.progress.processedMessages++;
            } catch (error) {
              this.handleMessageError(message.id, error);
            }
          }
        }

        // Stop if we've reached minId
        if (reachedMinId) {
          break;
        }

        messagesImported += messages.length;
        offsetId = messages[messages.length - 1].id;

        await this.delay(this.config.batchDelayMs);
      } catch (error) {
        if (await this.handleFloodWait(error)) {
          continue;
        }
        this.logger.error(`Error fetching messages from ${chatName}: ${error}`);
        break;
      }
    }

    this.logger.log(`Imported ${messagesImported} messages from ${chatType}: ${chatName}`);
  }

  /**
   * Import messages from a forum with limit per topic.
   */
  private async importForum(
    client: TelegramClient,
    dialog: Dialog,
    channel: Api.Channel,
  ): Promise<void> {
    const forumName = channel.title;
    this.progress.currentDialog = forumName;
    this.logger.log(`[Phase 3/3] Importing forum: ${forumName}`);

    // Get all topics
    const topics = await this.getForumTopics(client, channel);
    this.logger.log(`Found ${topics.length} topics in forum: ${forumName}`);

    for (const topic of topics) {
      try {
        this.progress.currentTopic = topic.title;
        this.logger.debug(`Importing topic: ${topic.title} (limit: ${this.config.forumTopicLimit})`);

        let offsetId = 0;
        let messagesImported = 0;

        while (messagesImported < this.config.forumTopicLimit) {
          const batchSize = Math.min(100, this.config.forumTopicLimit - messagesImported);

          try {
            const messages = await this.getTopicMessages(client, channel, topic.id, {
              limit: batchSize,
              offsetId,
            });

            if (!messages.length) {
              break;
            }

            for (const message of messages) {
              try {
                await this.messageHandler.processMessageWithContext(message, client, {
                  chatType: 'forum',
                  topicId: topic.id,
                  topicName: topic.title,
                });
                this.progress.totalMessages++;
                this.progress.processedMessages++;
              } catch (error) {
                this.handleMessageError(message.id, error);
              }
            }

            messagesImported += messages.length;
            offsetId = messages[messages.length - 1].id;

            await this.delay(this.config.batchDelayMs);
          } catch (error) {
            if (await this.handleFloodWait(error)) {
              continue;
            }
            this.logger.error(`Error fetching messages from topic ${topic.title}: ${error}`);
            break;
          }
        }

        this.logger.debug(`Imported ${messagesImported} messages from topic: ${topic.title}`);
      } catch (error) {
        const errMsg = `Topic "${topic.title}" (id=${topic.id}): ${error instanceof Error ? error.message : String(error)}`;
        this.logger.error(`[forums] ${errMsg}`, error instanceof Error ? error.stack : undefined);
        this.progress.errors.push(`[forums] ${forumName}/${errMsg}`);
      }
      await this.delay(this.config.topicDelayMs);
    }

    this.progress.currentTopic = undefined;
    this.logger.log(`Completed forum import: ${forumName}`);
  }

  /**
   * Get all topics from a forum.
   */
  private async getForumTopics(
    client: TelegramClient,
    channel: Api.Channel,
  ): Promise<ForumTopic[]> {
    const topics: ForumTopic[] = [];

    let offsetDate = 0;
    let offsetId = 0;
    let offsetTopic = 0;

    while (true) {
      try {
        const result = await client.invoke(
          new Api.channels.GetForumTopics({
            channel: new Api.InputChannel({
              channelId: channel.id,
              accessHash: channel.accessHash!,
            }),
            offsetDate,
            offsetId,
            offsetTopic,
            limit: 100,
          }),
        );

        if (!(result instanceof Api.messages.ForumTopics)) {
          break;
        }

        for (const topic of result.topics) {
          if (topic instanceof Api.ForumTopic) {
            topics.push({
              id: topic.id,
              title: topic.title,
              iconColor: topic.iconColor ?? 0,
              isClosed: topic.closed ?? false,
              isPinned: topic.pinned ?? false,
              isGeneral: topic.id === 1,
            });
          }
        }

        // Pagination
        if (result.topics.length < 100) {
          break;
        }

        const lastTopic = result.topics[result.topics.length - 1];
        if (lastTopic instanceof Api.ForumTopic) {
          offsetDate = lastTopic.date;
          offsetId = lastTopic.id;
          offsetTopic = lastTopic.id;
        } else {
          break;
        }

        await this.delay(this.config.batchDelayMs);
      } catch (error) {
        if (await this.handleFloodWait(error)) {
          continue;
        }
        this.logger.error(`Error fetching forum topics: ${error}`);
        break;
      }
    }

    return topics;
  }

  /**
   * Get messages from a specific forum topic.
   */
  private async getTopicMessages(
    client: TelegramClient,
    channel: Api.Channel,
    topicId: number,
    options: { limit: number; offsetId: number },
  ): Promise<Api.Message[]> {
    const result = await client.invoke(
      new Api.messages.GetReplies({
        peer: new Api.InputPeerChannel({
          channelId: channel.id,
          accessHash: channel.accessHash!,
        }),
        msgId: topicId,
        offsetId: options.offsetId,
        addOffset: 0,
        limit: options.limit,
      }),
    );

    const messages: Api.Message[] = [];
    if ('messages' in result) {
      for (const msg of result.messages) {
        if (msg instanceof Api.Message) {
          messages.push(msg);
        }
      }
    }

    return messages;
  }

  /**
   * Handle FloodWait errors with automatic retry.
   * Returns true if should retry, false otherwise.
   */
  private async handleFloodWait(error: unknown): Promise<boolean> {
    if (
      error instanceof Api.RpcError &&
      error.errorMessage.startsWith('FLOOD_WAIT_')
    ) {
      const parts = error.errorMessage.split('_');
      const waitSeconds = parseInt(parts[2] ?? '', 10);

      // Validate parsed value
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
        this.logger.warn(
          `FloodWait: could not parse wait time from "${error.errorMessage}", skipping retry`,
        );
        return false;
      }

      this.logger.warn(`FloodWait: waiting ${waitSeconds}s`);
      await this.delay((waitSeconds + 1) * 1000);
      return true;
    }
    return false;
  }

  /**
   * Handle message processing error.
   */
  private handleMessageError(messageId: number, error: unknown): void {
    const errMsg = `Message ${messageId}: ${error instanceof Error ? error.message : String(error)}`;
    this.logger.warn(`Failed to process message: ${errMsg}`);
    this.progress.errors.push(errMsg);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Re-import messages from a specific chat (supports groups/channels/forums).
   * This will update sender_identifier for existing messages.
   */
  async reimportChat(
    client: TelegramClient,
    chatId: string,
    limit = 1000,
  ): Promise<{ imported: number; updated: number; errors: string[] }> {
    const errors: string[] = [];
    let imported = 0;
    let updated = 0;

    this.logger.log(`Re-importing messages from chat ${chatId}...`);

    try {
      // Parse chat_id format: user_XXX, chat_XXX, channel_XXX
      const parts = chatId.split('_');
      const type = parts[0];
      const id = parts.slice(1).join('_');

      if (!type || !id) {
        throw new Error(`Invalid chat_id format: ${chatId}`);
      }

      // Find the entity from dialogs
      let inputEntity: Api.TypeInputPeer | undefined;
      let chatType: ChatType = 'group';

      const dialogs = await client.getDialogs({ limit: 500 });

      for (const dialog of dialogs) {
        const peer = dialog.inputEntity;
        if (type === 'user' && peer instanceof Api.InputPeerUser) {
          if (peer.userId.toString() === id) {
            inputEntity = peer;
            chatType = 'private';
            break;
          }
        } else if (type === 'chat' && peer instanceof Api.InputPeerChat) {
          if (peer.chatId.toString() === id) {
            inputEntity = peer;
            chatType = 'group';
            break;
          }
        } else if (type === 'channel' && peer instanceof Api.InputPeerChannel) {
          if (peer.channelId.toString() === id) {
            inputEntity = peer;
            const entity = dialog.entity;
            if (entity instanceof Api.Channel) {
              chatType = entity.forum ? 'forum' : 'supergroup';
            }
            break;
          }
        }
      }

      if (!inputEntity) {
        throw new Error(`Chat ${chatId} not found in dialogs`);
      }

      // Fetch messages
      let offsetId = 0;
      let messagesProcessed = 0;

      while (messagesProcessed < limit) {
        const batchSize = Math.min(100, limit - messagesProcessed);

        const messages = await client.getMessages(inputEntity, {
          limit: batchSize,
          offsetId,
        });

        if (!messages.length) {
          break;
        }

        for (const message of messages) {
          if (message instanceof Api.Message) {
            try {
              const result = await this.messageHandler.processMessageWithContext(
                message,
                client,
                { chatType },
              );
              if (result.is_update) {
                updated++;
              } else {
                imported++;
              }
            } catch (error) {
              const errMsg = `Message ${message.id}: ${error instanceof Error ? error.message : String(error)}`;
              errors.push(errMsg);
            }
          }
        }

        messagesProcessed += messages.length;
        offsetId = messages[messages.length - 1].id;

        await this.delay(this.config.batchDelayMs);
      }

      this.logger.log(`Re-import completed: ${imported} new, ${updated} updated`);
    } catch (error) {
      const errMsg = `Fatal error: ${error instanceof Error ? error.message : String(error)}`;
      errors.push(errMsg);
      this.logger.error(errMsg);
    }

    return { imported, updated, errors };
  }
}
