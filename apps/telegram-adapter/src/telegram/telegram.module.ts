import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { MessageHandlerService } from './message-handler.service';
import { AgentHandlerService } from './agent-handler.service';
import { SessionService } from './session.service';
import { HistoryImportService } from './history-import.service';
import { HistoryImportController } from './history-import.controller';
import { ChatController } from './chat.controller';
import { ApiModule } from '../api/api.module';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Module({
  imports: [ApiModule],
  controllers: [HistoryImportController, ChatController],
  providers: [
    TelegramService,
    MessageHandlerService,
    AgentHandlerService,
    SessionService,
    HistoryImportService,
    ApiKeyGuard,
  ],
  exports: [TelegramService],
})
export class TelegramModule {}
