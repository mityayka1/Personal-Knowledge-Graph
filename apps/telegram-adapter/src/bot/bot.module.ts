import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiModule } from '../api/api.module';
import { BotService } from './bot.service';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';
import { EventCallbackHandler } from './handlers/event-callback.handler';
import { CarouselCallbackHandler } from './handlers/carousel-callback.handler';
import { NotificationController } from './notification.controller';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Module({
  imports: [ApiModule, ConfigModule],
  controllers: [NotificationController],
  providers: [
    BotService,
    RecallHandler,
    PrepareHandler,
    EventCallbackHandler,
    CarouselCallbackHandler,
    ApiKeyGuard,
  ],
  exports: [BotService],
})
export class BotModule {}
