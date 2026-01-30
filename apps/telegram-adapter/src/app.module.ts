import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { telegramConfig, apiConfig, redisConfig } from './common/config';
import { TelegramModule } from './telegram/telegram.module';
import { ApiModule } from './api/api.module';
import { BotModule } from './bot/bot.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [telegramConfig, apiConfig, redisConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    ScheduleModule.forRoot(),

    TelegramModule,
    ApiModule,
    BotModule,
  ],
})
export class AppModule {}
