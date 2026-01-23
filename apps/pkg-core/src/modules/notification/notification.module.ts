import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ExtractedEvent, EntityEvent, EntityRecord, EntityIdentifier, Message, Interaction } from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { NotificationService } from './notification.service';
import { DigestService } from './digest.service';
import { DigestActionStoreService } from './digest-action-store.service';
import { CarouselStateService } from './carousel-state.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationProcessor } from './notification.processor';
import { NotificationTriggerController } from './notification-trigger.controller';
import { DigestActionController } from './digest-action.controller';
import { CarouselController } from './carousel.controller';
import { ApprovalService } from './approval.service';
import { ApprovalController } from './approval.controller';
import { BriefStateService } from './brief-state.service';
import { BriefController } from './brief.controller';
import { TelegramSendService } from './telegram-send.service';
import { SettingsModule } from '../settings/settings.module';
import { EntityModule } from '../entity/entity.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([ExtractedEvent, EntityEvent, EntityRecord, EntityIdentifier, Message, Interaction]),
    BullModule.registerQueue({
      name: 'notification',
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 100,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 }, // 2s -> 4s -> 8s -> 16s -> 32s
      },
    }),
    SettingsModule,
    forwardRef(() => EntityModule),
    forwardRef(() => ClaudeAgentModule),
  ],
  controllers: [NotificationTriggerController, DigestActionController, CarouselController, ApprovalController, BriefController],
  providers: [
    TelegramNotifierService,
    NotificationService,
    DigestService,
    DigestActionStoreService,
    CarouselStateService,
    NotificationSchedulerService,
    NotificationProcessor,
    ApprovalService,
    TelegramSendService,
    BriefStateService,
  ],
  exports: [
    TelegramNotifierService,
    NotificationService,
    DigestService,
    DigestActionStoreService,
    CarouselStateService,
    ApprovalService,
    TelegramSendService,
    BriefStateService,
  ],
})
export class NotificationModule {}
