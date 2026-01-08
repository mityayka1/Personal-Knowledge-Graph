import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { MessageHandlerService } from './message-handler.service';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private client: TelegramClient | null = null;
  private isConnected = false;

  constructor(
    private configService: ConfigService,
    private messageHandler: MessageHandlerService,
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

      this.logger.log('Message handler registered');
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

      await this.messageHandler.processMessage(message);
    } catch (error) {
      this.logger.error('Error handling message', error);
    }
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
