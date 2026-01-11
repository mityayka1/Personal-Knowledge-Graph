import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { ChatCategoryRecord } from '@pkg/entities';
import { ChatCategoryService } from './chat-category.service';
import { ChatCategoryController } from './chat-category.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatCategoryRecord]),
    SettingsModule,
    HttpModule.register({
      timeout: 30000, // 30 seconds for Telegram API calls
    }),
  ],
  controllers: [ChatCategoryController],
  providers: [ChatCategoryService],
  exports: [ChatCategoryService],
})
export class ChatCategoryModule {}
