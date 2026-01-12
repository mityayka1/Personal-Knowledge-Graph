import { Injectable, Logger, ServiceUnavailableException, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { firstValueFrom } from 'rxjs';

export interface MediaDownloadOptions {
  chatId: string;
  messageId: string;
  size?: string;
  thumb?: boolean;
}

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

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly telegramAdapterUrl: string;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
  ) {
    this.telegramAdapterUrl = this.configService.get<string>('TELEGRAM_ADAPTER_URL') || '';

    if (!this.telegramAdapterUrl) {
      this.logger.warn(
        'TELEGRAM_ADAPTER_URL not configured, using default: http://localhost:3001. ' +
        'Set TELEGRAM_ADAPTER_URL environment variable for production.',
      );
      this.telegramAdapterUrl = 'http://localhost:3001';
    }
  }

  /**
   * Stream media from Telegram Adapter to client response
   * Acts as a transparent proxy to maintain Source-Agnostic architecture
   */
  async streamMedia(options: MediaDownloadOptions, res: Response): Promise<void> {
    const { chatId, messageId, size = 'x', thumb = false } = options;

    // Build query params with URL encoding for safety
    const queryParams = new URLSearchParams();
    if (size) queryParams.set('size', size);
    if (thumb) queryParams.set('thumb', 'true');

    // Use encodeURIComponent for path segments to prevent injection
    const encodedChatId = encodeURIComponent(chatId);
    const encodedMessageId = encodeURIComponent(messageId);

    const targetUrl = `${this.telegramAdapterUrl}/api/v1/chats/${encodedChatId}/messages/${encodedMessageId}/download?${queryParams.toString()}`;

    this.logger.debug(`Proxying media request to: ${targetUrl}`);

    try {
      const response = await firstValueFrom(
        this.httpService.get(targetUrl, {
          responseType: 'stream',
          validateStatus: (status) => status < 500, // Handle 4xx ourselves
        }),
      );

      // Handle 4xx errors from telegram-adapter
      if (response.status >= 400 && response.status < 500) {
        if (response.status === 404) {
          throw new NotFoundException('Media not found');
        }
        if (response.status === 503) {
          throw new ServiceUnavailableException('Telegram client not connected');
        }
        throw new NotFoundException(`Media request failed: ${response.status}`);
      }

      // Forward response headers
      const contentType = response.headers['content-type'];
      const contentLength = response.headers['content-length'];
      const contentDisposition = response.headers['content-disposition'];
      const cacheControl = response.headers['cache-control'];

      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }
      if (contentDisposition) {
        res.setHeader('Content-Disposition', contentDisposition);
      }
      if (cacheControl) {
        res.setHeader('Cache-Control', cacheControl);
      } else {
        // Default caching for media
        res.setHeader('Cache-Control', 'private, max-age=3600');
      }

      // Stream response data
      const stream = response.data;

      // Handle stream errors
      stream.on('error', (error: Error) => {
        this.logger.error(`Stream error for ${chatId}/${messageId}: ${error.message}`);
        if (!res.writableEnded) {
          res.destroy(error);
        }
      });

      // Handle client disconnect
      res.on('close', () => {
        if (!stream.destroyed) {
          stream.destroy();
        }
      });

      // Pipe the stream to response
      stream.pipe(res);

    } catch (error) {
      // Re-throw NestJS exceptions
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      this.logger.error(`Failed to proxy media ${chatId}/${messageId}: ${error}`);

      // Handle axios errors
      if (this.isAxiosError(error)) {
        if (error.code === 'ECONNREFUSED') {
          throw new ServiceUnavailableException('Telegram adapter is not available');
        }
        if (error.response?.status === 404) {
          throw new NotFoundException('Media not found');
        }
        if (error.response?.status === 503) {
          throw new ServiceUnavailableException('Telegram client not connected');
        }
      }

      throw new ServiceUnavailableException('Failed to download media');
    }
  }

  /**
   * Get chat info from Telegram Adapter
   */
  async getChatInfo(chatId: string): Promise<ChatInfoResponse | null> {
    const encodedChatId = encodeURIComponent(chatId);
    const targetUrl = `${this.telegramAdapterUrl}/api/v1/chats/${encodedChatId}/info`;

    try {
      const response = await firstValueFrom(
        this.httpService.get<ChatInfoResponse>(targetUrl),
      );
      return response.data;
    } catch (error) {
      if (this.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      this.logger.warn(`Failed to get chat info for ${chatId}: ${error}`);
      return null;
    }
  }

  /**
   * Type guard for Axios errors
   */
  private isAxiosError(error: unknown): error is {
    code?: string;
    response?: { status: number };
    message: string;
  } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      (('code' in error) || ('response' in error))
    );
  }
}
