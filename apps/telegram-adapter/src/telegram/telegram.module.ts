import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { MessageHandlerService } from './message-handler.service';
import { SessionService } from './session.service';
import { HistoryImportService } from './history-import.service';
import { HistoryImportController } from './history-import.controller';
import { ApiModule } from '../api/api.module';

@Module({
  imports: [ApiModule],
  controllers: [HistoryImportController],
  providers: [TelegramService, MessageHandlerService, SessionService, HistoryImportService],
  exports: [TelegramService],
})
export class TelegramModule {}
