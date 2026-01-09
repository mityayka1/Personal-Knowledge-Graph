import { Controller, Post, Get, Body, HttpException, HttpStatus } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { HistoryImportService, ImportProgress } from './history-import.service';

interface StartImportDto {
  limitPerDialog?: number;
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
    this.historyImportService
      .startImport(client, dto.limitPerDialog || 1000)
      .catch((error) => {
        console.error('Import error:', error);
      });

    return {
      message: 'Import started',
      progress: this.historyImportService.getProgress(),
    };
  }
}
