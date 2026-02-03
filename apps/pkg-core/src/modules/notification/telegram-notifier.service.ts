import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { BriefState } from '@pkg/entities';

/**
 * Telegram inline button - supports both callback_data and web_app types.
 */
export type TelegramButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } };

export interface SendNotificationOptions {
  chatId?: number | string;
  message: string;
  parseMode?: 'Markdown' | 'HTML';
  buttons?: Array<Array<TelegramButton>>;
}

export interface NotificationResponse {
  success: boolean;
  error?: string;
  messageId?: number;
}

@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);
  private readonly telegramAdapterUrl: string;
  private readonly apiKey: string | undefined;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.telegramAdapterUrl =
      this.configService.get<string>('TELEGRAM_ADAPTER_URL') || 'http://localhost:3001';
    this.apiKey = this.configService.get<string>('PKG_CORE_API_KEY');
  }

  /**
   * Get headers with optional API key.
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
   * Send notification via Telegram bot.
   * If chatId is not provided, sends to the owner.
   */
  async send(options: SendNotificationOptions): Promise<boolean> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/notifications/send`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<NotificationResponse>(
          targetUrl,
          {
            chatId: options.chatId,
            message: options.message,
            parseMode: options.parseMode,
            buttons: options.buttons,
          },
          { headers: this.getHeaders() },
        ),
      );

      if (!response.data.success) {
        this.logger.warn(`Notification failed: ${response.data.error}`);
        return false;
      }

      return true;
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.logger.error(`Failed to send notification: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Send notification with inline buttons to owner.
   * Uses HTML parse mode by default.
   */
  async sendWithButtons(
    message: string,
    buttons: Array<Array<TelegramButton>>,
    parseMode: 'Markdown' | 'HTML' = 'HTML',
  ): Promise<boolean> {
    return this.send({
      message,
      buttons,
      parseMode,
    });
  }

  /**
   * Send notification with buttons and return message ID (for carousel).
   * Uses HTML parse mode by default.
   */
  async sendWithButtonsAndGetId(
    message: string,
    buttons: Array<Array<TelegramButton>>,
    parseMode: 'Markdown' | 'HTML' = 'HTML',
  ): Promise<number | null> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/notifications/send-with-id`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<NotificationResponse>(
          targetUrl,
          {
            message,
            buttons,
            parseMode,
          },
          { headers: this.getHeaders() },
        ),
      );

      if (!response.data.success || !response.data.messageId) {
        this.logger.warn(`Notification failed: ${response.data.error || 'No messageId returned'}`);
        return null;
      }

      return response.data.messageId;
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.logger.error(`Failed to send notification with ID: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Send Morning Brief notification.
   * Formatting is handled by telegram-adapter's BriefFormatterService.
   * Follows Source-Agnostic principle: pkg-core sends raw data, telegram-adapter handles presentation.
   *
   * @param state - Brief state with items to display
   * @param chatId - Optional chat ID (uses owner if not provided)
   * @returns Message ID if successful, null otherwise
   */
  async sendBrief(state: BriefState, chatId?: number | string): Promise<number | null> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/notifications/send-brief`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<NotificationResponse>(
          targetUrl,
          { state, chatId },
          { headers: this.getHeaders() },
        ),
      );

      if (!response.data.success || !response.data.messageId) {
        this.logger.warn(`Send brief failed: ${response.data.error || 'No messageId returned'}`);
        return null;
      }

      return response.data.messageId;
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.logger.error(`Failed to send brief: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Edit an existing message (for carousel navigation).
   */
  async editMessage(
    chatId: number | string,
    messageId: number,
    message: string,
    buttons?: Array<Array<TelegramButton>>,
    parseMode: 'Markdown' | 'HTML' = 'HTML',
  ): Promise<boolean> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/notifications/edit`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<NotificationResponse>(
          targetUrl,
          {
            chatId,
            messageId,
            message,
            parseMode,
            buttons,
          },
          { headers: this.getHeaders() },
        ),
      );

      if (!response.data.success) {
        this.logger.warn(`Edit message failed: ${response.data.error}`);
        return false;
      }

      return true;
    } catch (error) {
      const errorMsg = this.getErrorMessage(error);
      this.logger.error(`Failed to edit message: ${errorMsg}`);
      return false;
    }
  }

  /**
   * Get the owner chat ID from telegram-adapter.
   * Caches the result for subsequent calls.
   */
  private cachedOwnerChatId: number | null | undefined = undefined;

  async getOwnerChatId(): Promise<number | null> {
    if (this.cachedOwnerChatId !== undefined) {
      return this.cachedOwnerChatId;
    }

    const status = await this.checkStatus();
    this.cachedOwnerChatId = status.ownerChatId;
    return this.cachedOwnerChatId;
  }

  /**
   * Check if notification service is available.
   */
  async checkStatus(): Promise<{ ready: boolean; ownerChatId: number | null }> {
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/notifications/status`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ready: boolean; ownerChatId: number | null }>(
          targetUrl,
          {},
          { headers: this.getHeaders() },
        ),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to check notification status: ${this.getErrorMessage(error)}`);
      return { ready: false, ownerChatId: null };
    }
  }

  private getErrorMessage(error: unknown): string {
    // Handle axios errors specifically - they have response data
    if (error && typeof error === 'object') {
      const axiosError = error as {
        response?: { status?: number; data?: unknown };
        code?: string;
        message?: string;
      };

      // Check for axios response error
      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data;
        return `HTTP ${status}: ${JSON.stringify(data)}`;
      }

      // Check for network/connection error
      if (axiosError.code) {
        return `${axiosError.code}: ${axiosError.message || 'Connection error'}`;
      }
    }

    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String((error as { message: unknown }).message);
    }
    return String(error);
  }
}
