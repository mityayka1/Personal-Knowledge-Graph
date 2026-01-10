import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import {
  InteractionSummary,
  Interaction,
  Message,
} from '@pkg/entities';
import { SummarizationService } from './summarization.service';
import { SummarizationProcessor } from './summarization.processor';
import { ClaudeCliModule } from '../claude-cli/claude-cli.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([InteractionSummary, Interaction, Message]),
    BullModule.registerQueue({
      name: 'summarization',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      },
    }),
    ScheduleModule.forRoot(),
    ClaudeCliModule,
  ],
  providers: [SummarizationService, SummarizationProcessor],
  exports: [SummarizationService],
})
export class SummarizationModule {}
