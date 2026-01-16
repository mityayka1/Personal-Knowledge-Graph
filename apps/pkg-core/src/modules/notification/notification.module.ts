import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExtractedEvent } from '@pkg/entities';
import { TelegramNotifierService } from './telegram-notifier.service';
import { NotificationService } from './notification.service';

@Module({
  imports: [HttpModule, TypeOrmModule.forFeature([ExtractedEvent])],
  providers: [TelegramNotifierService, NotificationService],
  exports: [TelegramNotifierService, NotificationService],
})
export class NotificationModule {}
