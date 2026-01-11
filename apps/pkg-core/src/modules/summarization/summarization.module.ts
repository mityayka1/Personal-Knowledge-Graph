import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import {
  InteractionSummary,
  Interaction,
  Message,
  EntityRelationshipProfile,
  EntityRecord,
  EntityFact,
} from '@pkg/entities';
import { SummarizationService } from './summarization.service';
import { SummarizationProcessor } from './summarization.processor';
import { SummarizationController } from './summarization.controller';
import { EntityProfileService } from './entity-profile.service';
import { EntityProfileProcessor } from './entity-profile.processor';
import { ClaudeCliModule } from '../claude-cli/claude-cli.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InteractionSummary,
      Interaction,
      Message,
      EntityRelationshipProfile,
      EntityRecord,
      EntityFact,
    ]),
    BullModule.registerQueue({
      name: 'summarization',
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60000 },
      },
    }),
    BullModule.registerQueue({
      name: 'entity-profile',
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 20,
        attempts: 2,
        backoff: { type: 'exponential', delay: 120000 },
      },
    }),
    ScheduleModule.forRoot(),
    ClaudeCliModule,
  ],
  controllers: [SummarizationController],
  providers: [
    SummarizationService,
    SummarizationProcessor,
    EntityProfileService,
    EntityProfileProcessor,
  ],
  exports: [SummarizationService, EntityProfileService],
})
export class SummarizationModule {}
