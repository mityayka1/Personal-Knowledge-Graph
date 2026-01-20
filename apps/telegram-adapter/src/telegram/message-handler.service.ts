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
  /** Birthday in format "YYYY-MM-DD" or "MM-DD" (if year not shared) */
  birthday?: string;
}

/**
 * Chat type for import logic and entity resolution.
 * Private chats trigger automatic Entity creation.
 */
export type ChatType = 'private' | 'group' | 'supergroup' | 'channel' | 'forum';

interface MediaMetadata {
  id: string;
  accessHash: string;
  fileReference: string;
  dcId: number;
  sizes?: Array<{ type: string; width: number; height: number; size: number }>;
  mimeType?: string;
  size?: number;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  hasThumb?: boolean;
}

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
  media_metadata?: MediaMetadata;
  /** Type of chat: private, group, supergroup, channel, forum */
  chat_type?: ChatType;
  /** Forum topic ID (for forums with topics) */
  topic_id?: number;
  /** Forum topic name (for display) */
  topic_name?: string;
  /** Number of participants in the chat (for categorization) */
  participants_count?: number;
  /** Chat title (for groups/channels) */
  chat_title?: string;
  /** Recipient info for outgoing messages in private chats */
  recipient_user_id?: string;
  recipient_user_info?: TelegramUserInfo;
}

interface CachedChatInfo {
  participantsCount: number | null;
  title: string | null;
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

      // Skip "min" users - they don't have full data to download photos
      if (user.min || !user.accessHash) {
        this.logger.debug(`Skipping profile photo for min user ${user.id} (min=${user.min}, accessHash=${!!user.accessHash})`);
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

  /**
   * Fetch user's birthday from full user info.
   * Returns birthday in "YYYY-MM-DD" or "MM-DD" format.
   */
  private async fetchUserBirthday(client: TelegramClient, user: Api.User): Promise<string | undefined> {
    try {
      const fullUser = await client.invoke(
        new Api.users.GetFullUser({
          id: user,
        }),
      );

      if (fullUser.fullUser?.birthday) {
        const birthday = fullUser.fullUser.birthday;
        // Birthday has day, month, and optionally year
        const day = String(birthday.day).padStart(2, '0');
        const month = String(birthday.month).padStart(2, '0');

        if (birthday.year) {
          return `${birthday.year}-${month}-${day}`;
        } else {
          // Year not shared - return MM-DD format
          return `${month}-${day}`;
        }
      }
    } catch (error) {
      // This is expected for users who don't share birthday or bots
      this.logger.debug(`Could not fetch birthday for user ${user.id}: ${error}`);
    }
    return undefined;
  }

  /**
   * Fetch full user info by user ID.
   * Used for outgoing messages in private chats to get recipient info.
   */
  private async fetchUserInfo(client: TelegramClient, userId: string): Promise<TelegramUserInfo | undefined> {
    try {
      const entity = await client.getEntity(userId);
      if (!(entity instanceof Api.User)) {
        return undefined;
      }

      const userInfo: TelegramUserInfo = {
        username: entity.username || undefined,
        firstName: entity.firstName || undefined,
        lastName: entity.lastName || undefined,
        phone: entity.phone || undefined,
        isBot: entity.bot || undefined,
        isVerified: entity.verified || undefined,
        isPremium: entity.premium || undefined,
      };

      // Fetch photo and birthday in parallel
      const [photoBase64, birthday] = await Promise.all([
        this.downloadProfilePhoto(client, entity),
        this.fetchUserBirthday(client, entity),
      ]);

      if (photoBase64) {
        userInfo.photoBase64 = photoBase64;
      }
      if (birthday) {
        userInfo.birthday = birthday;
      }

      // Remove undefined values
      const cleanedInfo = Object.fromEntries(
        Object.entries(userInfo).filter(([_, v]) => v !== undefined),
      ) as TelegramUserInfo;

      return Object.keys(cleanedInfo).length > 0 ? cleanedInfo : undefined;
    } catch (error) {
      this.logger.warn(`Failed to fetch user info for ${userId}: ${error}`);
      return undefined;
    }
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

    // Determine chat type early for recipient info logic
    const chatType = options?.chatType || this.inferChatType(chatId);
    const isOutgoingPrivateChat = message.out && chatType === 'private';

    // Recipient info for outgoing private chat messages
    let recipientUserId: string | undefined;
    let recipientUserInfo: TelegramUserInfo | undefined;

    // Get sender info
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

      // Try to download profile photo and fetch birthday if client is available
      if (client) {
        const [photoBase64, birthday] = await Promise.all([
          this.downloadProfilePhoto(client, sender),
          this.fetchUserBirthday(client, sender),
        ]);
        if (photoBase64) {
          userInfo.photoBase64 = photoBase64;
        }
        if (birthday) {
          userInfo.birthday = birthday;
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

    // For outgoing messages in private chats, also get RECIPIENT info
    if (isOutgoingPrivateChat && client && chatId.startsWith('user_')) {
      recipientUserId = chatId.replace('user_', '');
      recipientUserInfo = await this.fetchUserInfo(client, recipientUserId);
    }

    // Get chat info (participants count and title) from cache or fetch
    let participantsCount = options?.participantsCount;
    let chatTitle: string | undefined;
    if (client) {
      const chatInfo = await this.getChatInfo(chatId, client);
      if (participantsCount === undefined) {
        participantsCount = chatInfo?.participantsCount ?? undefined;
      }
      chatTitle = chatInfo?.title ?? undefined;
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
      chat_title: chatTitle,
      // Recipient info for outgoing messages in private chats
      recipient_user_id: recipientUserId,
      recipient_user_info: recipientUserInfo,
    };

    // Handle reply
    // In forum chats, replyToMsgId may point to the topic's first message (replyToTopId)
    // We only want to track actual replies to specific messages, not just "message in topic"
    if (message.replyTo && 'replyToMsgId' in message.replyTo && message.replyTo.replyToMsgId) {
      const replyToMsgId = message.replyTo.replyToMsgId;
      const replyToTopId = 'replyToTopId' in message.replyTo ? message.replyTo.replyToTopId : undefined;

      // Only set reply_to_message_id if it's a real reply (not just a topic message)
      // In forums: replyToMsgId === replyToTopId means it's just posted in topic, not a reply
      if (!replyToTopId || replyToMsgId !== replyToTopId) {
        processed.reply_to_message_id = replyToMsgId.toString();
      }
    }

    // Handle media
    if (message.media) {
      const mediaInfo = this.extractMediaInfo(message.media);
      if (mediaInfo) {
        processed.media_type = mediaInfo.type;
        processed.media_url = mediaInfo.url;
        processed.media_metadata = mediaInfo.metadata;
      }
    }

    return processed;
  }

  private extractMediaInfo(media: Api.TypeMessageMedia): { type: string; url?: string; metadata?: MediaMetadata } | null {
    if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
      const photo = media.photo;
      const sizes = photo.sizes
        .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
        .map((s) => ({ type: s.type, width: s.w, height: s.h, size: s.size }));

      return {
        type: 'photo',
        metadata: {
          id: photo.id.toString(),
          accessHash: photo.accessHash.toString(),
          fileReference: Buffer.from(photo.fileReference).toString('base64'),
          dcId: photo.dcId,
          sizes,
        },
      };
    } else if (media instanceof Api.MessageMediaDocument) {
      const document = media.document;
      if (document && document instanceof Api.Document) {
        const metadata: MediaMetadata = {
          id: document.id.toString(),
          accessHash: document.accessHash.toString(),
          fileReference: Buffer.from(document.fileReference).toString('base64'),
          dcId: document.dcId,
          mimeType: document.mimeType,
          size: Number(document.size),
          hasThumb: document.thumbs && document.thumbs.length > 0,
        };

        // Extract filename
        const fileNameAttr = document.attributes?.find(
          (attr): attr is Api.DocumentAttributeFilename => attr instanceof Api.DocumentAttributeFilename,
        );
        if (fileNameAttr) {
          metadata.fileName = fileNameAttr.fileName;
        }

        // Check for voice message
        const audioAttr = document.attributes?.find(
          (attr): attr is Api.DocumentAttributeAudio => attr instanceof Api.DocumentAttributeAudio,
        );
        if (audioAttr) {
          metadata.duration = audioAttr.duration;
          if (audioAttr.voice) {
            return { type: 'voice', metadata };
          }
          return { type: 'audio', metadata };
        }

        // Check for video
        const videoAttr = document.attributes?.find(
          (attr): attr is Api.DocumentAttributeVideo => attr instanceof Api.DocumentAttributeVideo,
        );
        if (videoAttr) {
          metadata.duration = videoAttr.duration;
          metadata.width = videoAttr.w;
          metadata.height = videoAttr.h;
          if (videoAttr.roundMessage) {
            return { type: 'video_note', metadata };
          }
          return { type: 'video', metadata };
        }

        // Check for sticker
        const stickerAttr = document.attributes?.find(
          (attr) => attr instanceof Api.DocumentAttributeSticker,
        );
        if (stickerAttr) {
          return { type: 'sticker', metadata };
        }

        // Check for animation (GIF)
        const animatedAttr = document.attributes?.find(
          (attr) => attr instanceof Api.DocumentAttributeAnimated,
        );
        if (animatedAttr) {
          return { type: 'animation', metadata };
        }

        return { type: 'document', metadata };
      }
    }

    return null;
  }

  /**
   * Get chat info (participants count and title) with caching.
   * Uses TTL cache to avoid hitting Telegram rate limits.
   */
  async getChatInfo(
    chatId: string,
    client?: TelegramClient,
  ): Promise<{ participantsCount: number | null; title: string | null } | null> {
    // Check cache first
    const cached = this.chatInfoCache.get(chatId);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return { participantsCount: cached.participantsCount, title: cached.title };
    }

    // Can't fetch without client
    if (!client) {
      return null;
    }

    // Private chats always have 2 participants (user + self), no title needed
    if (chatId.startsWith('user_')) {
      this.chatInfoCache.set(chatId, {
        participantsCount: 2,
        title: null,
        cachedAt: Date.now(),
      });
      return { participantsCount: 2, title: null };
    }

    try {
      let count: number | null = null;
      let title: string | null = null;

      if (chatId.startsWith('chat_')) {
        // Regular group chat - get info from chat entity
        const rawChatId = chatId.replace('chat_', '');
        try {
          const entity = await client.getEntity(rawChatId);
          if (entity instanceof Api.Chat) {
            count = entity.participantsCount ?? null;
            title = entity.title ?? null;
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
            title = entity.title ?? null;
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
          this.logger.debug(`Could not get chat info for ${chatId}`);
        }
      }

      // Cache the result
      this.chatInfoCache.set(chatId, {
        participantsCount: count,
        title,
        cachedAt: Date.now(),
      });

      return { participantsCount: count, title };
    } catch (error) {
      this.logger.warn(`Failed to get chat info for ${chatId}:`, error);
      return null;
    }
  }

  /**
   * Get participants count for a chat (wrapper for backwards compatibility).
   */
  async getParticipantsCount(
    chatId: string,
    client?: TelegramClient,
  ): Promise<number | null> {
    const info = await this.getChatInfo(chatId, client);
    return info?.participantsCount ?? null;
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
