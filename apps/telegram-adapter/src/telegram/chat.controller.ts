import { Controller, Get, Param, Query, Logger, NotFoundException, ServiceUnavailableException, Res } from '@nestjs/common';
import { Response } from 'express';
import { TelegramService } from './telegram.service';
import { MessageHandlerService } from './message-handler.service';
import { Api } from 'telegram';
import bigInt from 'big-integer';

export interface ChatInfoResponse {
  telegramChatId: string;
  title: string | null;
  participantsCount: number | null;
  chatType: 'private' | 'group' | 'supergroup' | 'channel' | 'forum';
  username?: string;
  description?: string;
  photoBase64?: string;
  isForum?: boolean;
}

@Controller('chats')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private telegramService: TelegramService,
    private messageHandler: MessageHandlerService,
  ) {}

  /**
   * Get chat info by telegram_chat_id (e.g., channel_1234567890, chat_123456)
   */
  @Get(':chatId/info')
  async getChatInfo(@Param('chatId') chatId: string): Promise<ChatInfoResponse> {
    const client = this.telegramService.getClient();

    if (!client || !this.telegramService.isClientConnected()) {
      throw new ServiceUnavailableException('Telegram client not connected');
    }

    try {
      // Parse chat ID to get raw ID
      let rawIdStr: string;
      let expectedType: 'user' | 'chat' | 'channel';

      if (chatId.startsWith('user_')) {
        rawIdStr = chatId.replace('user_', '');
        expectedType = 'user';
      } else if (chatId.startsWith('chat_')) {
        rawIdStr = chatId.replace('chat_', '');
        expectedType = 'chat';
      } else if (chatId.startsWith('channel_')) {
        rawIdStr = chatId.replace('channel_', '');
        expectedType = 'channel';
      } else {
        throw new NotFoundException(`Invalid chat ID format: ${chatId}`);
      }

      const rawId = bigInt(rawIdStr);

      // For channels, we need to use InputPeerChannel with access_hash
      // Try to get entity from dialogs cache first
      let entity: Api.TypeUser | Api.TypeChat;
      try {
        // Try with PeerChannel/PeerChat/PeerUser
        if (expectedType === 'channel') {
          entity = await client.getEntity(new Api.PeerChannel({ channelId: rawId }));
        } else if (expectedType === 'chat') {
          entity = await client.getEntity(new Api.PeerChat({ chatId: rawId }));
        } else {
          entity = await client.getEntity(new Api.PeerUser({ userId: rawId }));
        }
      } catch {
        // Fallback: try with raw ID
        entity = await client.getEntity(rawId);
      }

      let response: ChatInfoResponse;

      if (entity instanceof Api.User) {
        const firstName = entity.firstName || '';
        const lastName = entity.lastName || '';
        const displayName = `${firstName} ${lastName}`.trim() || entity.username || `User ${rawId}`;

        response = {
          telegramChatId: chatId,
          title: displayName,
          participantsCount: 2, // Private chat always has 2 participants
          chatType: 'private',
          username: entity.username || undefined,
        };
      } else if (entity instanceof Api.Chat) {
        response = {
          telegramChatId: chatId,
          title: entity.title || null,
          participantsCount: entity.participantsCount ?? null,
          chatType: 'group',
        };
      } else if (entity instanceof Api.Channel) {
        // Determine if it's a channel, forum (group with topics), or supergroup
        const isChannel = entity.broadcast === true;
        const isForum = entity.forum === true;

        // Try to get full channel info for description and more accurate count
        let description: string | undefined;
        let participantsCount = entity.participantsCount ?? null;

        try {
          const fullChannel = await client.invoke(
            new Api.channels.GetFullChannel({ channel: entity }),
          );
          if (fullChannel.fullChat instanceof Api.ChannelFull) {
            description = fullChannel.fullChat.about || undefined;
            if (fullChannel.fullChat.participantsCount) {
              participantsCount = fullChannel.fullChat.participantsCount;
            }
          }
        } catch {
          // Ignore errors getting full info
        }

        // Determine chat type: forum > channel > supergroup
        let chatType: 'channel' | 'supergroup' | 'forum';
        if (isForum) {
          chatType = 'forum';
        } else if (isChannel) {
          chatType = 'channel';
        } else {
          chatType = 'supergroup';
        }

        response = {
          telegramChatId: chatId,
          title: entity.title || null,
          participantsCount,
          chatType,
          username: entity.username || undefined,
          description,
          isForum,
        };
      } else {
        throw new NotFoundException(`Unknown entity type for ${chatId}`);
      }

      // Try to download chat photo
      try {
        const photo = await client.downloadProfilePhoto(entity, { isBig: false });
        if (photo && photo.length > 0 && photo.length <= 100 * 1024) {
          response.photoBase64 = `data:image/jpeg;base64,${photo.toString('base64')}`;
        }
      } catch {
        // Ignore photo download errors
      }

      this.logger.log(`Got info for chat ${chatId}: ${response.title}`);
      return response;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(`Failed to get chat info for ${chatId}:`, error);
      throw new NotFoundException(`Chat not found: ${chatId}`);
    }
  }

  /**
   * Get media info for a specific message
   */
  @Get(':chatId/messages/:messageId/media')
  async getMessageMedia(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
  ) {
    const client = this.telegramService.getClient();

    if (!client || !this.telegramService.isClientConnected()) {
      throw new ServiceUnavailableException('Telegram client not connected');
    }

    try {
      // Parse chat ID
      let peer: Api.TypeInputPeer;
      if (chatId.startsWith('channel_')) {
        const rawId = chatId.replace('channel_', '');
        const entity = await client.getEntity(new Api.PeerChannel({ channelId: bigInt(rawId) }));
        if (entity instanceof Api.Channel) {
          peer = new Api.InputPeerChannel({
            channelId: bigInt(rawId),
            accessHash: entity.accessHash || bigInt(0),
          });
        } else {
          throw new NotFoundException('Not a channel');
        }
      } else {
        throw new NotFoundException('Only channel chats supported for now');
      }

      // Get message
      const messages = await client.getMessages(peer, { ids: [parseInt(messageId)] });
      const message = messages[0];

      if (!message || !message.media) {
        throw new NotFoundException('Message or media not found');
      }

      // Extract media info
      const mediaInfo: Record<string, unknown> = {
        messageId,
        chatId,
      };

      if (message.media instanceof Api.MessageMediaPhoto && message.media.photo instanceof Api.Photo) {
        const photo = message.media.photo;
        mediaInfo.type = 'photo';
        mediaInfo.id = photo.id.toString();
        mediaInfo.accessHash = photo.accessHash.toString();
        mediaInfo.fileReference = Buffer.from(photo.fileReference).toString('base64');
        mediaInfo.dcId = photo.dcId;
        mediaInfo.sizes = photo.sizes
          .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
          .map(s => ({ type: s.type, w: s.w, h: s.h, size: s.size }));

        // Construct file_id for Bot API (simplified - may not work)
        // Real file_id is base64 encoded binary with specific format
        mediaInfo.note = 'Bot API file_id requires different format - testing raw values';
      } else if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
        const doc = message.media.document;
        mediaInfo.type = 'document';
        mediaInfo.id = doc.id.toString();
        mediaInfo.accessHash = doc.accessHash.toString();
        mediaInfo.fileReference = Buffer.from(doc.fileReference).toString('base64');
        mediaInfo.dcId = doc.dcId;
        mediaInfo.mimeType = doc.mimeType;
        mediaInfo.size = doc.size.toString();
      }

      return mediaInfo;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(`Failed to get media for ${chatId}/${messageId}:`, error);
      throw new NotFoundException(`Media not found`);
    }
  }

  /**
   * Download/stream media from a message (MTProto proxy)
   * Supports: photo, video, voice, audio, document
   */
  @Get(':chatId/messages/:messageId/download')
  async downloadMessageMedia(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('size') size: string = 'x',
    @Query('thumb') thumb: string = 'false',
    @Res() res: Response,
  ) {
    const client = this.telegramService.getClient();

    if (!client || !this.telegramService.isClientConnected()) {
      throw new ServiceUnavailableException('Telegram client not connected');
    }

    try {
      // Parse chat ID and get peer
      const peer = await this.resolvePeer(client, chatId);

      // Get message
      const messages = await client.getMessages(peer, { ids: [parseInt(messageId)] });
      const message = messages[0];

      if (!message || !message.media) {
        throw new NotFoundException('Message or media not found');
      }

      // Handle different media types
      if (message.media instanceof Api.MessageMediaPhoto && message.media.photo instanceof Api.Photo) {
        await this.streamPhoto(client, message.media.photo, size, res);
      } else if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document) {
        await this.streamDocument(client, message.media.document, thumb === 'true', res);
      } else {
        throw new NotFoundException('Unsupported media type');
      }
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }
      this.logger.error(`Failed to download media for ${chatId}/${messageId}:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download media' });
      }
    }
  }

  /**
   * Resolve chat ID to InputPeer
   */
  private async resolvePeer(client: ReturnType<typeof this.telegramService.getClient>, chatId: string): Promise<Api.TypeInputPeer> {
    if (chatId.startsWith('channel_')) {
      const rawId = chatId.replace('channel_', '');
      const entity = await client!.getEntity(new Api.PeerChannel({ channelId: bigInt(rawId) }));
      if (entity instanceof Api.Channel) {
        return new Api.InputPeerChannel({
          channelId: bigInt(rawId),
          accessHash: entity.accessHash || bigInt(0),
        });
      }
      throw new NotFoundException('Not a channel');
    } else if (chatId.startsWith('user_')) {
      const rawId = chatId.replace('user_', '');
      const entity = await client!.getEntity(new Api.PeerUser({ userId: bigInt(rawId) }));
      if (entity instanceof Api.User) {
        return new Api.InputPeerUser({
          userId: bigInt(rawId),
          accessHash: entity.accessHash || bigInt(0),
        });
      }
      throw new NotFoundException('Not a user');
    } else if (chatId.startsWith('chat_')) {
      const rawId = chatId.replace('chat_', '');
      return new Api.InputPeerChat({ chatId: bigInt(rawId) });
    }
    throw new NotFoundException('Unknown chat type');
  }

  /**
   * Stream photo with specified size
   */
  private async streamPhoto(
    client: ReturnType<typeof this.telegramService.getClient>,
    photo: Api.Photo,
    size: string,
    res: Response,
  ) {
    const availableSizes = photo.sizes
      .filter((s): s is Api.PhotoSize => s instanceof Api.PhotoSize)
      .sort((a, b) => b.size - a.size);

    const targetSize = availableSizes.find(s => s.type === size) || availableSizes[0];

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', targetSize.size.toString());
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const inputLocation = new Api.InputPhotoFileLocation({
      id: photo.id,
      accessHash: photo.accessHash,
      fileReference: photo.fileReference,
      thumbSize: targetSize.type,
    });

    for await (const chunk of client!.iterDownload({
      file: inputLocation,
      requestSize: 256 * 1024,
    })) {
      res.write(chunk);
    }

    res.end();
  }

  /**
   * Stream document (video, audio, voice, file)
   */
  private async streamDocument(
    client: ReturnType<typeof this.telegramService.getClient>,
    doc: Api.Document,
    thumbnail: boolean,
    res: Response,
  ) {
    // If thumbnail requested and available
    if (thumbnail && doc.thumbs && doc.thumbs.length > 0) {
      const thumb = doc.thumbs.find((t): t is Api.PhotoSize => t instanceof Api.PhotoSize);
      if (thumb) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Content-Length', thumb.size.toString());
        res.setHeader('Cache-Control', 'private, max-age=3600');

        const inputLocation = new Api.InputDocumentFileLocation({
          id: doc.id,
          accessHash: doc.accessHash,
          fileReference: doc.fileReference,
          thumbSize: thumb.type,
        });

        for await (const chunk of client!.iterDownload({
          file: inputLocation,
          requestSize: 256 * 1024,
        })) {
          res.write(chunk);
        }

        res.end();
        return;
      }
    }

    // Full document download
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', doc.size.toString());
    res.setHeader('Cache-Control', 'private, max-age=3600');

    // Extract filename from attributes
    const fileNameAttr = doc.attributes?.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    if (fileNameAttr) {
      res.setHeader('Content-Disposition', `inline; filename="${fileNameAttr.fileName}"`);
    }

    const inputLocation = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: '',
    });

    for await (const chunk of client!.iterDownload({
      file: inputLocation,
      requestSize: 512 * 1024,
    })) {
      res.write(chunk);
    }

    res.end();
  }
}
