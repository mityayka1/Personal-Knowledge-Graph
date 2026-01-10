import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatCategoryRecord } from '@pkg/entities';
import { ChatCategoryService } from './chat-category.service';
import { ChatCategoryController } from './chat-category.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatCategoryRecord]),
    SettingsModule,
  ],
  controllers: [ChatCategoryController],
  providers: [ChatCategoryService],
  exports: [ChatCategoryService],
})
export class ChatCategoryModule {}
