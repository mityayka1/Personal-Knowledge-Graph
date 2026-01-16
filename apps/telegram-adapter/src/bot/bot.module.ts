import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module';
import { BotService } from './bot.service';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';
import { EventCallbackHandler } from './handlers/event-callback.handler';
import { NotificationController } from './notification.controller';

@Module({
  imports: [ApiModule],
  controllers: [NotificationController],
  providers: [BotService, RecallHandler, PrepareHandler, EventCallbackHandler],
  exports: [BotService],
})
export class BotModule {}
