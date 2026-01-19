import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { EntityService } from '../entity/entity.service';

/**
 * Response from telegram-adapter send-as-user endpoint
 */
export interface SendAsUserResponse {
  success: boolean;
  messageId?: number;
  date?: number;
  error?: string;
}

/**
 * Result of sending a message
 */
export interface SendResult {
  success: boolean;
  messageId?: number;
  chatId?: string;
  error?: string;
}

/**
 * Service for sending Telegram messages via userbot.
 *
 * This service calls telegram-adapter's /telegram/send-as-user endpoint,
 * which uses GramJS to send messages as the user (not as a bot).
 *
 * IMPORTANT: Messages should only be sent after user approval.
 * Use ApprovalService to get user confirmation first.
 */
@Injectable()
export class TelegramSendService {
  private readonly logger = new Logger(TelegramSendService.name);
  private readonly telegramAdapterUrl: string;
  private readonly apiKey: string | undefined;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly entityService: EntityService,
  ) {
    this.telegramAdapterUrl =
      this.configService.get<string>('TELEGRAM_ADAPTER_URL') || 'http://localhost:3001';
    this.apiKey = this.configService.get<string>('PKG_CORE_API_KEY');
  }

  /**
   * Get headers with optional API key
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    return headers;
  }

  /**
   * Send message to entity via userbot.
   *
   * @param entityId - UUID of recipient entity
   * @param text - Message text
   * @param replyToMsgId - Optional message ID to reply to
   * @returns SendResult with messageId if successful
   */
  async sendToEntity(
    entityId: string,
    text: string,
    replyToMsgId?: number,
  ): Promise<SendResult> {
    // Get entity with identifiers
    const entity = await this.entityService.findOne(entityId);
    const telegramId = entity.identifiers?.find(
      (i) => i.identifierType === 'telegram_user_id',
    );

    if (!telegramId) {
      return {
        success: false,
        error: `Entity ${entityId} has no Telegram identifier`,
      };
    }

    // Call telegram-adapter
    return this.sendToChat(telegramId.identifierValue, text, replyToMsgId);
  }

  /**
   * Send message to a specific chat via userbot.
   *
   * @param chatId - Telegram chat ID (user ID, group ID, etc.)
   * @param text - Message text
   * @param replyToMsgId - Optional message ID to reply to
   * @returns SendResult with messageId if successful
   */
  async sendToChat(
    chatId: string,
    text: string,
    replyToMsgId?: number,
  ): Promise<SendResult> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/telegram/send-as-user`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<SendAsUserResponse>(
          targetUrl,
          {
            chatId,
            text,
            replyToMsgId,
          },
          { headers: this.getHeaders() },
        ),
      );

      if (!response.data.success) {
        this.logger.warn(
          `Failed to send message to ${chatId}: ${response.data.error}`,
        );
        return {
          success: false,
          error: response.data.error || 'Unknown error',
        };
      }

      this.logger.log(
        `Message sent to ${chatId}, messageId: ${response.data.messageId}`,
      );

      return {
        success: true,
        messageId: response.data.messageId,
        chatId,
      };
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.logger.error(`Failed to send message to ${chatId}: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Check if userbot is available for sending
   */
  async checkStatus(): Promise<{ ready: boolean; error?: string }> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/telegram/status`;

    try {
      const response = await firstValueFrom(
        this.httpService.get<{ connected: boolean }>(
          targetUrl,
          { headers: this.getHeaders() },
        ),
      );

      return {
        ready: response.data.connected,
      };
    } catch (error) {
      return {
        ready: false,
        error: this.getErrorMessage(error),
      };
    }
  }

  /**
   * Extract error message from various error types
   */
  private getErrorMessage(error: unknown): string {
    // Handle axios errors
    if (error && typeof error === 'object') {
      const axiosError = error as {
        response?: { status?: number; data?: unknown };
        code?: string;
        message?: string;
      };

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data;
        return `HTTP ${status}: ${JSON.stringify(data)}`;
      }

      if (axiosError.code) {
        return `${axiosError.code}: ${axiosError.message || 'Connection error'}`;
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
