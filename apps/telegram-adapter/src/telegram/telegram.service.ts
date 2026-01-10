import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent, Raw } from 'telegram/events';
import { Api } from 'telegram';
import { MessageHandlerService } from './message-handler.service';
import { PkgCoreApiService } from '../api/pkg-core-api.service';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private client: TelegramClient | null = null;
  private isConnected = false;

  constructor(
    private configService: ConfigService,
    private messageHandler: MessageHandlerService,
    private pkgCoreApi: PkgCoreApiService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.disconnect();
  }

  async connect(): Promise<void> {
    const apiId = this.configService.get<number>('telegram.apiId');
    const apiHash = this.configService.get<string>('telegram.apiHash');
    const sessionString = this.configService.get<string>('telegram.sessionString');
    const connectionRetries = this.configService.get<number>('telegram.connectionRetries', 5);

    if (!apiId || !apiHash) {
      this.logger.warn('Telegram API credentials not configured, skipping connection');
      return;
    }

    try {
      const session = new StringSession(sessionString || '');

      this.client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries,
        useWSS: true,
      });

      await this.client.connect();

      if (!sessionString) {
        this.logger.log('No session string provided. Run authentication flow to get one.');
        // In production, you would implement interactive auth here
        // For now, we'll just log the warning
        return;
      }

      this.isConnected = true;
      this.logger.log('Connected to Telegram');

      // Register message handler
      this.client.addEventHandler(
        (event: NewMessageEvent) => this.handleNewMessage(event),
        new NewMessage({}),
      );

      // Register raw update handler for membership changes
      this.client.addEventHandler(
        (update: Api.TypeUpdate) => this.handleRawUpdate(update),
        new Raw({}),
      );

      this.logger.log('Message and membership handlers registered');
    } catch (error) {
      this.logger.error('Failed to connect to Telegram', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      try {
        await this.client.disconnect();
        this.isConnected = false;
        this.logger.log('Disconnected from Telegram');
      } catch (error) {
        this.logger.error('Error disconnecting from Telegram', error);
      }
    }
  }

  private async handleNewMessage(event: NewMessageEvent): Promise<void> {
    try {
      const message = event.message;

      if (!message || !message.peerId) {
        return;
      }

      await this.messageHandler.processMessage(message, this.client || undefined);
    } catch (error) {
      this.logger.error('Error handling message', error);
    }
  }

  /**
   * Handle raw Telegram updates for membership changes
   */
  private async handleRawUpdate(update: Api.TypeUpdate): Promise<void> {
    try {
      // Handle channel participant updates (supergroups)
      if (update instanceof Api.UpdateChannelParticipant) {
        await this.handleMembershipChange({
          chatId: `channel_${update.channelId}`,
          userId: update.userId.toString(),
          prevParticipant: update.prevParticipant,
          newParticipant: update.newParticipant,
          timestamp: new Date(update.date * 1000),
          actorId: update.actorId?.toString(),
        });
      }

      // Handle chat participant updates (regular groups)
      if (update instanceof Api.UpdateChatParticipant) {
        await this.handleMembershipChange({
          chatId: `chat_${update.chatId}`,
          userId: update.userId.toString(),
          prevParticipant: update.prevParticipant,
          newParticipant: update.newParticipant,
          timestamp: new Date(update.date * 1000),
          actorId: update.actorId?.toString(),
        });
      }
    } catch (error) {
      this.logger.error('Error handling raw update', error);
    }
  }

  /**
   * Process membership change (join/leave)
   */
  private async handleMembershipChange(params: {
    chatId: string;
    userId: string;
    prevParticipant: Api.TypeChannelParticipant | Api.TypeChatParticipant | undefined;
    newParticipant: Api.TypeChannelParticipant | Api.TypeChatParticipant | undefined;
    timestamp: Date;
    actorId?: string;
  }): Promise<void> {
    const { chatId, userId, prevParticipant, newParticipant, timestamp } = params;

    // Determine action: joined, left, or other change
    const wasParticipant = this.isActiveParticipant(prevParticipant);
    const isParticipant = this.isActiveParticipant(newParticipant);

    let action: 'joined' | 'left' | null = null;

    if (!wasParticipant && isParticipant) {
      action = 'joined';
    } else if (wasParticipant && !isParticipant) {
      action = 'left';
    }

    // Only handle join/leave events
    if (!action) {
      return;
    }

    this.logger.log(`Membership change: user ${userId} ${action} chat ${chatId}`);

    // Invalidate cache for this chat
    this.messageHandler.invalidateChatCache(chatId);

    // Get display name if available
    let displayName: string | undefined;
    if (this.client && action === 'joined') {
      try {
        const entity = await this.client.getEntity(userId);
        if (entity instanceof Api.User) {
          const firstName = entity.firstName || '';
          const lastName = entity.lastName || '';
          displayName = `${firstName} ${lastName}`.trim() || entity.username || undefined;
        }
      } catch {
        // Ignore errors getting user info
      }
    }

    // Report to PKG Core
    try {
      await this.pkgCoreApi.reportMembershipChange({
        telegram_chat_id: chatId,
        telegram_user_id: userId,
        display_name: displayName,
        action,
        timestamp: timestamp.toISOString(),
      });
    } catch (error) {
      this.logger.error(`Failed to report membership change: ${error}`);
    }
  }

  /**
   * Check if participant status indicates active membership
   */
  private isActiveParticipant(
    participant: Api.TypeChannelParticipant | Api.TypeChatParticipant | undefined,
  ): boolean {
    if (!participant) {
      return false;
    }

    // Channel participants
    if (participant instanceof Api.ChannelParticipant) return true;
    if (participant instanceof Api.ChannelParticipantSelf) return true;
    if (participant instanceof Api.ChannelParticipantCreator) return true;
    if (participant instanceof Api.ChannelParticipantAdmin) return true;
    if (participant instanceof Api.ChannelParticipantBanned) {
      // Banned but not left
      return !participant.left;
    }
    if (participant instanceof Api.ChannelParticipantLeft) return false;

    // Chat participants
    if (participant instanceof Api.ChatParticipant) return true;
    if (participant instanceof Api.ChatParticipantCreator) return true;
    if (participant instanceof Api.ChatParticipantAdmin) return true;

    return false;
  }

  getClient(): TelegramClient | null {
    return this.client;
  }

  isClientConnected(): boolean {
    return this.isConnected;
  }

  async getSessionString(): Promise<string | null> {
    if (!this.client) return null;
    return (this.client.session as StringSession).save();
  }
}
