import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';
import { MediaService } from './media.service';

/**
 * Media Proxy Controller
 *
 * This controller provides a Source-Agnostic interface for media access.
 * Dashboard and other clients should use this endpoint instead of
 * directly accessing Telegram Adapter.
 *
 * Flow: Dashboard -> PKG Core (this) -> Telegram Adapter -> Telegram
 *
 * Authentication: JWT Bearer token or API Key via combined auth guard.
 * Media requests go through Nuxt server proxy which adds the auth header.
 */
@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(private mediaService: MediaService) {}

  /**
   * Download/stream media for a message
   *
   * @param chatId - Telegram chat ID (e.g., channel_123456, user_123, chat_123)
   * @param messageId - Telegram message ID
   * @param size - Photo size: 's' (small), 'm' (medium), 'x' (large), 'y' (max) - default 'x'
   * @param thumb - If 'true', returns thumbnail for videos/documents
   */
  @Get(':chatId/:messageId')
  async downloadMedia(
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('size') size: string = 'x',
    @Query('thumb') thumb: string = 'false',
    @Res() res: Response,
  ) {
    try {
      await this.mediaService.streamMedia(
        {
          chatId,
          messageId,
          size,
          thumb: thumb === 'true',
        },
        res,
      );
    } catch (error) {
      // Re-throw NestJS exceptions for proper HTTP response
      if (error instanceof NotFoundException || error instanceof ServiceUnavailableException) {
        throw error;
      }

      this.logger.error(`Failed to stream media ${chatId}/${messageId}: ${error}`);

      // If headers not sent, we can still send error response
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to download media' });
      } else if (!res.writableEnded) {
        // Headers sent but stream not ended - destroy connection
        res.destroy();
      }
    }
  }

  /**
   * Get chat info (title, participants count, etc.)
   *
   * @param chatId - Telegram chat ID
   */
  @Get('chat/:chatId/info')
  async getChatInfo(@Param('chatId') chatId: string) {
    const info = await this.mediaService.getChatInfo(chatId);

    if (!info) {
      throw new NotFoundException(`Chat not found: ${chatId}`);
    }

    return info;
  }
}
