import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ExtractedEvent, EntityEvent, EntityRecord } from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { NotificationService } from './notification.service';
import { DigestService } from './digest.service';
import { NotificationSchedulerService } from './notification-scheduler.service';

@Module({
  imports: [
    HttpModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([ExtractedEvent, EntityEvent, EntityRecord]),
  ],
  providers: [
    TelegramNotifierService,
    NotificationService,
    DigestService,
    NotificationSchedulerService,
  ],
  exports: [TelegramNotifierService, NotificationService, DigestService],
})
export class NotificationModule {}
