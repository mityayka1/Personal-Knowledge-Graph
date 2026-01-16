import { Module } from '@nestjs/common';
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
import { SettingsModule } from '../settings/settings.module';

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
  ],
  controllers: [NotificationTriggerController, DigestActionController, CarouselController],
  providers: [
    TelegramNotifierService,
    NotificationService,
    DigestService,
    DigestActionStoreService,
    CarouselStateService,
    NotificationSchedulerService,
    NotificationProcessor,
  ],
  exports: [TelegramNotifierService, NotificationService, DigestService, DigestActionStoreService, CarouselStateService],
})
export class NotificationModule {}
