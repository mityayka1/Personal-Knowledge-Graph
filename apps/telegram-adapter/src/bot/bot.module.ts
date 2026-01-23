import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiModule } from '../api/api.module';
import { BotService } from './bot.service';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';
import { ActHandler } from './handlers/act.handler';
import { DigestHandler } from './handlers/digest.handler';
import { EventCallbackHandler } from './handlers/event-callback.handler';
import { CarouselCallbackHandler } from './handlers/carousel-callback.handler';
import { ApprovalCallbackHandler } from './handlers/approval-callback.handler';
import { BriefCallbackHandler } from './handlers/brief-callback.handler';
import { BriefFormatterService } from './services/brief-formatter.service';
import { NotificationController } from './notification.controller';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Module({
  imports: [ApiModule, ConfigModule],
  controllers: [NotificationController],
  providers: [
    BotService,
    RecallHandler,
    PrepareHandler,
    ActHandler,
    DigestHandler,
    EventCallbackHandler,
    CarouselCallbackHandler,
    ApprovalCallbackHandler,
    BriefCallbackHandler,
    BriefFormatterService,
    ApiKeyGuard,
  ],
  exports: [BotService, BriefFormatterService],
})
export class BotModule {}
