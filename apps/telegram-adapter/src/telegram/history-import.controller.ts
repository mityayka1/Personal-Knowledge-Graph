import { Controller, Post, Get, Body, HttpException, HttpStatus } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { HistoryImportService, ImportProgress } from './history-import.service';

interface StartImportDto {
  limitPerDialog?: number;
  /** If true, import only private chats (personal dialogs) */
  privateOnly?: boolean;
  /** If true, skip dialogs that already have messages in PKG Core */
  skipExisting?: boolean;
  /** If true, only import new messages (using minId from existing data) */
  incrementalOnly?: boolean;
}

interface ReimportChatDto {
  chatId: string; // e.g., "channel_1555389091", "chat_123", "user_456"
  limit?: number;
}

@Controller('import')
export class HistoryImportController {
  constructor(
    private telegramService: TelegramService,
    private historyImportService: HistoryImportService,
  ) {}

  @Get('status')
  getStatus(): ImportProgress {
    return this.historyImportService.getProgress();
  }

  @Post('start')
  async startImport(@Body() dto: StartImportDto): Promise<{ message: string; progress: ImportProgress }> {
    const client = this.telegramService.getClient();

    if (!client || !this.telegramService.isClientConnected()) {
      throw new HttpException(
        'Telegram client is not connected',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const progress = this.historyImportService.getProgress();
    if (progress.status === 'running') {
      throw new HttpException(
        'Import is already in progress',
        HttpStatus.CONFLICT,
      );
    }

    // Start import in background (don't await)
    // Limits are configured via environment variables:
    // IMPORT_GROUP_LIMIT (default: 1000) - messages per group chat
    // IMPORT_TOPIC_LIMIT (default: 1000) - messages per forum topic
    this.historyImportService
      .startImport(client, {
        privateOnly: dto.privateOnly,
        skipExisting: dto.skipExisting,
        incrementalOnly: dto.incrementalOnly,
      })
      .catch((error) => {
        console.error('Import error:', error);
      });

    return {
      message: 'Import started',
      progress: this.historyImportService.getProgress(),
    };
  }

  @Post('reimport-chat')
  async reimportChat(@Body() dto: ReimportChatDto): Promise<{
    message: string;
    imported: number;
    updated: number;
    errors: string[];
  }> {
    if (!dto.chatId) {
      throw new HttpException('chatId is required', HttpStatus.BAD_REQUEST);
    }

    const client = this.telegramService.getClient();

    if (!client || !this.telegramService.isClientConnected()) {
      throw new HttpException(
        'Telegram client is not connected',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const result = await this.historyImportService.reimportChat(
      client,
      dto.chatId,
      dto.limit || 1000,
    );

    return {
      message: `Re-import completed for chat ${dto.chatId}`,
      ...result,
    };
  }
}
