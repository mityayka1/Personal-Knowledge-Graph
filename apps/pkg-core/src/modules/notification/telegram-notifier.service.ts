import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

export interface SendNotificationOptions {
  chatId?: number | string;
  message: string;
  parseMode?: 'Markdown' | 'HTML';
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
}

export interface NotificationResponse {
  success: boolean;
  error?: string;
}

@Injectable()
export class TelegramNotifierService {
  private readonly logger = new Logger(TelegramNotifierService.name);
  private readonly telegramAdapterUrl: string;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.telegramAdapterUrl =
      this.configService.get<string>('TELEGRAM_ADAPTER_URL') || 'http://localhost:3001';
  }

  /**
   * Send notification via Telegram bot
   * If chatId is not provided, sends to the owner
   */
  async send(options: SendNotificationOptions): Promise<boolean> {
    const targetUrl = `${this.telegramAdapterUrl}/notifications/send`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<NotificationResponse>(targetUrl, {
          chatId: options.chatId,
          message: options.message,
          parseMode: options.parseMode,
          buttons: options.buttons,
        }),
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
   * Send notification with inline buttons to owner
   */
  async sendWithButtons(
    message: string,
    buttons: Array<Array<{ text: string; callback_data: string }>>,
  ): Promise<boolean> {
    return this.send({
      message,
      buttons,
    });
  }

  /**
   * Check if notification service is available
   */
  async checkStatus(): Promise<{ ready: boolean; ownerChatId: number | null }> {
    const targetUrl = `${this.telegramAdapterUrl}/notifications/status`;

    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ready: boolean; ownerChatId: number | null }>(targetUrl),
      );
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to check notification status: ${this.getErrorMessage(error)}`);
      return { ready: false, ownerChatId: null };
    }
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'object' && error !== null && 'message' in error) {
      return String((error as { message: unknown }).message);
    }
    return String(error);
  }
}
