import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ExtractedEvent, EntityEvent, EntityRecord } from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { NotificationService } from './notification.service';
import { DigestService } from './digest.service';
import { DigestActionStoreService } from './digest-action-store.service';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationProcessor } from './notification.processor';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([ExtractedEvent, EntityEvent, EntityRecord]),
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
  providers: [
    TelegramNotifierService,
    NotificationService,
    DigestService,
    DigestActionStoreService,
    NotificationSchedulerService,
    NotificationProcessor,
  ],
  exports: [TelegramNotifierService, NotificationService, DigestService, DigestActionStoreService],
})
export class NotificationModule {}
