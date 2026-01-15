import { Module } from '@nestjs/common';
import { ApiModule } from '../api/api.module';
import { BotService } from './bot.service';
import { RecallHandler } from './handlers/recall.handler';
import { PrepareHandler } from './handlers/prepare.handler';

@Module({
  imports: [ApiModule],
  providers: [BotService, RecallHandler, PrepareHandler],
  exports: [BotService],
})
export class BotModule {}
