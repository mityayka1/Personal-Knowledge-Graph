import { Injectable, Logger } from '@nestjs/common';
import { Api } from 'telegram';
import { PkgCoreApiService } from '../api/pkg-core-api.service';
import { SessionService } from './session.service';

interface ProcessedMessage {
  source: string;
  telegram_chat_id: string;
  telegram_user_id: string;
  telegram_username?: string;
  telegram_display_name?: string;
  message_id: string;
  text?: string;
  timestamp: string;
  is_outgoing: boolean;
  reply_to_message_id?: string;
  media_type?: string;
  media_url?: string;
}

@Injectable()
export class MessageHandlerService {
  private readonly logger = new Logger(MessageHandlerService.name);

  constructor(
    private pkgCoreApi: PkgCoreApiService,
    private sessionService: SessionService,
  ) {}

  async processMessage(message: Api.Message): Promise<void> {
    try {
      const chatId = this.getChatId(message);
      const senderId = this.getSenderId(message);

      if (!chatId || !senderId) {
        this.logger.warn('Could not extract chat or sender ID from message');
        return;
      }

      // Check if this is a new session
      const isNewSession = await this.sessionService.checkAndUpdateSession(chatId);

      if (isNewSession) {
        this.logger.log(`New session started for chat ${chatId}`);
      }

      const processedMessage = await this.extractMessageData(message, chatId, senderId);

      // Send to PKG Core
      const response = await this.pkgCoreApi.sendMessage(processedMessage);

      this.logger.log(`Message ${message.id} processed, interaction: ${response.interaction_id}`);
    } catch (error) {
      this.logger.error(`Error processing message ${message.id}`, error);
      throw error;
    }
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

  private async extractMessageData(
    message: Api.Message,
    chatId: string,
    senderId: string,
  ): Promise<ProcessedMessage> {
    const sender = message.sender;
    let username: string | undefined;
    let displayName: string | undefined;

    if (sender && 'username' in sender) {
      username = sender.username || undefined;
    }

    if (sender && 'firstName' in sender) {
      const firstName = sender.firstName || '';
      const lastName = 'lastName' in sender ? sender.lastName || '' : '';
      displayName = `${firstName} ${lastName}`.trim() || undefined;
    }

    const processed: ProcessedMessage = {
      source: 'telegram',
      telegram_chat_id: chatId,
      telegram_user_id: senderId,
      telegram_username: username,
      telegram_display_name: displayName,
      message_id: message.id.toString(),
      text: message.message || undefined,
      timestamp: new Date(message.date * 1000).toISOString(),
      is_outgoing: message.out || false,
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
}
