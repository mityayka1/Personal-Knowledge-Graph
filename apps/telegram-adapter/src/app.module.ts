import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { telegramConfig, apiConfig } from './common/config';
import { TelegramModule } from './telegram/telegram.module';
import { ApiModule } from './api/api.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [telegramConfig, apiConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    ScheduleModule.forRoot(),

    TelegramModule,
    ApiModule,
  ],
})
export class AppModule {}
