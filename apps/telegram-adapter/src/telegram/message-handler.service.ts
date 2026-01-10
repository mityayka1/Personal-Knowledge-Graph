import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { PkgCoreApiService, MessageResponse } from '../api/pkg-core-api.service';
import { SessionService } from './session.service';

interface TelegramUserInfo {
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  isBot?: boolean;
  isVerified?: boolean;
  isPremium?: boolean;
  photoBase64?: string;
}

/**
 * Chat type for import logic and entity resolution.
 * Private chats trigger automatic Entity creation.
 */
export type ChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'forum';

interface ProcessedMessage {
  source: string;
  telegram_chat_id: string;
  telegram_user_id: string;
  telegram_username?: string;
  telegram_display_name?: string;
  telegram_user_info?: TelegramUserInfo;
  message_id: string;
  text?: string;
  timestamp: string;
  is_outgoing: boolean;
  reply_to_message_id?: string;
  media_type?: string;
  media_url?: string;
  /** Type of chat: private, group, supergroup, channel, forum */
  chat_type?: ChatType;
  /** Forum topic ID (for forums with topics) */
  topic_id?: number;
  /** Forum topic name (for display) */
  topic_name?: string;
  /** Number of participants in the chat (for categorization) */
  participants_count?: number;
}

interface CachedChatInfo {
  participantsCount: number | null;
  cachedAt: number;
}

@Injectable()
export class MessageHandlerService {
  private readonly logger = new Logger(MessageHandlerService.name);
  /** Cache for participants count with TTL (1 hour) */
  private readonly chatInfoCache = new Map<string, CachedChatInfo>();
  private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor(
    private pkgCoreApi: PkgCoreApiService,
    private sessionService: SessionService,
  ) {}

  async processMessage(message: Api.Message, client?: TelegramClient): Promise<MessageResponse> {
    const chatId = this.getChatId(message);
    const senderId = this.getSenderId(message);

    if (!chatId || !senderId) {
      this.logger.warn('Could not extract chat or sender ID from message');
      throw new Error('Could not extract chat or sender ID from message');
    }

    // Check if this is a new session
    const isNewSession = await this.sessionService.checkAndUpdateSession(chatId);

    if (isNewSession) {
      this.logger.log(`New session started for chat ${chatId}`);
    }

    const processedMessage = await this.extractMessageData(message, chatId, senderId, client);

    // Send to PKG Core
    const response = await this.pkgCoreApi.sendMessage(processedMessage);

    this.logger.log(`Message ${message.id} processed, interaction: ${response.interaction_id}, is_update: ${response.is_update || false}`);

    return response;
  }

  private getChatId(message: Api.Message): string | null {
    const peerId = message.peerId;

    if (peerId instanceof Api.PeerUser) {
      return `user_${peerId.userId}`;
    } else if (peerId instanceof Api.PeerChat) {
      return `chat_${peerId.chatId}`;
    } else if (peerId instanceof Api.PeerChannel) {
      return `channel_${peerId.channelId}`;
    }

    return null;
  }

  private getSenderId(message: Api.Message): string | null {
    const fromId = message.fromId;

    if (fromId instanceof Api.PeerUser) {
      return fromId.userId.toString();
    }

    // For messages in private chats without fromId, use peerId
    if (!fromId && message.peerId instanceof Api.PeerUser) {
      return message.peerId.userId.toString();
    }

    return null;
  }

  private async downloadProfilePhoto(client: TelegramClient, user: Api.User): Promise<string | undefined> {
    try {
      if (!user.photo || user.photo instanceof Api.UserProfilePhotoEmpty) {
        return undefined;
      }

      const buffer = await client.downloadProfilePhoto(user, {
        isBig: false, // Use small thumbnail for efficiency
      });

      // Limit photo size to 100KB to prevent memory issues
      const MAX_PHOTO_SIZE = 100 * 1024;
      if (buffer && buffer.length > 0 && buffer.length <= MAX_PHOTO_SIZE) {
        return `data:image/jpeg;base64,${buffer.toString('base64')}`;
      } else if (buffer && buffer.length > MAX_PHOTO_SIZE) {
        this.logger.debug(`Profile photo for user ${user.id} exceeds size limit (${buffer.length} bytes)`);
      }
    } catch (error) {
      this.logger.warn(`Failed to download profile photo for user ${user.id}`, error);
    }
    return undefined;
  }

  private async extractMessageData(
    message: Api.Message,
    chatId: string,
    senderId: string,
    client?: TelegramClient,
    options?: {
      chatType?: ChatType;
      topicId?: number;
      topicName?: string;
      participantsCount?: number;
    },
  ): Promise<ProcessedMessage> {
    const sender = message.sender;
    let username: string | undefined;
    let displayName: string | undefined;
    let userInfo: TelegramUserInfo | undefined;

    if (sender && sender instanceof Api.User) {
      username = sender.username || undefined;
      const firstName = sender.firstName || '';
      const lastName = sender.lastName || '';
      displayName = `${firstName} ${lastName}`.trim() || undefined;

      // Collect all available user info
      userInfo = {
        username: sender.username || undefined,
        firstName: sender.firstName || undefined,
        lastName: sender.lastName || undefined,
        phone: sender.phone || undefined,
        isBot: sender.bot || undefined,
        isVerified: sender.verified || undefined,
        isPremium: sender.premium || undefined,
      };

      // Try to download profile photo if client is available
      if (client) {
        const photoBase64 = await this.downloadProfilePhoto(client, sender);
        if (photoBase64) {
          userInfo.photoBase64 = photoBase64;
        }
      }

      // Remove undefined values
      userInfo = Object.fromEntries(
        Object.entries(userInfo).filter(([_, v]) => v !== undefined),
      ) as TelegramUserInfo;

      if (Object.keys(userInfo).length === 0) {
        userInfo = undefined;
      }
    } else if (sender && 'username' in sender) {
      username = sender.username || undefined;
    }

    if (!displayName && sender && 'firstName' in sender) {
      const firstName = (sender as { firstName?: string }).firstName || '';
      const lastName = (sender as { lastName?: string }).lastName || '';
      displayName = `${firstName} ${lastName}`.trim() || undefined;
    }

    // Determine chat type from chatId prefix if not provided
    const chatType = options?.chatType || this.inferChatType(chatId);

    // Get participants count (from options or fetch with caching)
    let participantsCount = options?.participantsCount;
    if (participantsCount === undefined && client) {
      participantsCount = (await this.getParticipantsCount(chatId, client)) ?? undefined;
    }

    const processed: ProcessedMessage = {
      source: 'telegram',
      telegram_chat_id: chatId,
      telegram_user_id: senderId,
      telegram_username: username,
      telegram_display_name: displayName,
      telegram_user_info: userInfo,
      message_id: message.id.toString(),
      text: message.message || undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
      is_outgoing: message.out || false,
      chat_type: chatType,
      topic_id: options?.topicId,
      topic_name: options?.topicName,
      participants_count: participantsCount,
    };

    // Handle reply
    if (message.replyTo && 'replyToMsgId' in message.replyTo && message.replyTo.replyToMsgId) {
      processed.reply_to_message_id = message.replyTo.replyToMsgId.toString();
    }

    // Handle media
    if (message.media) {
      const mediaInfo = this.extractMediaInfo(message.media);
      if (mediaInfo) {
        processed.media_type = mediaInfo.type;
        processed.media_url = mediaInfo.url;
      }
    }

    return processed;
  }

  private extractMediaInfo(media: Api.TypeMessageMedia): { type: string; url?: string } | null {
    if (media instanceof Api.MessageMediaPhoto) {
      return { type: 'photo' };
    } else if (media instanceof Api.MessageMediaDocument) {
      const document = media.document;
      if (document && document instanceof Api.Document) {
        // Check for voice message
        const voiceAttr = document.attributes?.find(
          (attr) => attr instanceof Api.DocumentAttributeAudio && attr.voice,
        );
        if (voiceAttr) {
          return { type: 'voice' };
        }

        // Check for video
        const videoAttr = document.attributes?.find(
          (attr) => attr instanceof Api.DocumentAttributeVideo,
        );
        if (videoAttr) {
          return { type: 'video' };
        }

        // Check for sticker
        const stickerAttr = document.attributes?.find(
          (attr) => attr instanceof Api.DocumentAttributeSticker,
        );
        if (stickerAttr) {
          return { type: 'sticker' };
        }

        return { type: 'document' };
      }
    }

    return null;
  }

  /**
   * Get participants count for a chat with caching.
   * Uses TTL cache to avoid hitting Telegram rate limits.
   */
  async getParticipantsCount(
    chatId: string,
    client?: TelegramClient,
  ): Promise<number | null> {
    // Check cache first
    const cached = this.chatInfoCache.get(chatId);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.participantsCount;
    }

    // Can't fetch without client
    if (!client) {
      return null;
    }

    // Private chats always have 2 participants (user + self)
    if (chatId.startsWith('user_')) {
      this.chatInfoCache.set(chatId, {
        participantsCount: 2,
        cachedAt: Date.now(),
      });
      return 2;
    }

    try {
      let count: number | null = null;

      if (chatId.startsWith('chat_')) {
        // Regular group chat - get participants count from chat entity
        const rawChatId = chatId.replace('chat_', '');
        try {
          const entity = await client.getEntity(rawChatId);
          if (entity instanceof Api.Chat) {
            count = entity.participantsCount ?? null;
          }
        } catch {
          this.logger.debug(`Could not get chat entity for ${chatId}`);
        }
      } else if (chatId.startsWith('channel_')) {
        // Channel or supergroup - get from entity or full channel info
        const rawChannelId = chatId.replace('channel_', '');
        try {
          const entity = await client.getEntity(rawChannelId);
          if (entity instanceof Api.Channel) {
            // First try the count from channel entity itself
            if (entity.participantsCount) {
              count = entity.participantsCount;
            } else {
              // Fallback to full channel info
              const fullChannel = await client.invoke(
                new Api.channels.GetFullChannel({
                  channel: entity,
                }),
              );
              if (fullChannel.fullChat instanceof Api.ChannelFull) {
                count = fullChannel.fullChat.participantsCount ?? null;
              }
            }
          }
        } catch {
          // If we can't get the channel info, skip
          this.logger.debug(`Could not get participants count for ${chatId}`);
        }
      }

      // Cache the result
      this.chatInfoCache.set(chatId, {
        participantsCount: count,
        cachedAt: Date.now(),
      });

      return count;
    } catch (error) {
      this.logger.warn(`Failed to get participants count for ${chatId}:`, error);
      return null;
    }
  }

  /**
   * Invalidate cached chat info (call on join/leave events)
   */
  invalidateChatCache(chatId: string): void {
    this.chatInfoCache.delete(chatId);
  }

  /**
   * Infer chat type from chatId prefix.
   * Note: This is a simple inference based on chatId format.
   * For accurate type detection (especially forum vs supergroup),
   * use determineChatType() with the actual entity.
   */
  private inferChatType(chatId: string): ChatType {
    if (chatId.startsWith('user_')) {
      return 'private';
    } else if (chatId.startsWith('chat_')) {
      return 'group';
    } else if (chatId.startsWith('channel_')) {
      // Could be channel or supergroup - default to supergroup
      // Accurate detection requires entity inspection
      return 'supergroup';
    }
    return 'group'; // fallback
  }

  /**
   * Process a message with explicit chat type and topic info.
   * Used by history import for more accurate type handling.
   */
  async processMessageWithContext(
    message: Api.Message,
    client: TelegramClient,
    context: {
      chatType: ChatType;
      topicId?: number;
      topicName?: string;
      participantsCount?: number;
    },
  ): Promise<MessageResponse> {
    const chatId = this.getChatId(message);
    const senderId = this.getSenderId(message);

    if (!chatId || !senderId) {
      this.logger.warn('Could not extract chat or sender ID from message');
      throw new Error('Could not extract chat or sender ID from message');
    }

    // Check if this is a new session
    const isNewSession = await this.sessionService.checkAndUpdateSession(chatId);

    if (isNewSession) {
      this.logger.log(`New session started for chat ${chatId}`);
    }

    const processedMessage = await this.extractMessageData(
      message,
      chatId,
      senderId,
      client,
      context,
    );

    // Send to PKG Core
    const response = await this.pkgCoreApi.sendMessage(processedMessage);

    this.logger.debug(
      `Message ${message.id} processed with context, interaction: ${response.interaction_id}`,
    );

    return response;
  }
}
