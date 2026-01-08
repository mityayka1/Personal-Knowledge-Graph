import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { MessageHandlerService } from './message-handler.service';
import { SessionService } from './session.service';
import { ApiModule } from '../api/api.module';

@Module({
  imports: [ApiModule],
  providers: [TelegramService, MessageHandlerService, SessionService],
  exports: [TelegramService],
})
export class TelegramModule {}
