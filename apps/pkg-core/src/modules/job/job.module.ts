import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Job, Message } from '@pkg/entities';
import { JobService } from './job.service';
import { EmbeddingProcessor } from './processors/embedding.processor';
import { FactExtractionProcessor } from './processors/fact-extraction.processor';
import { EmbeddingModule } from '../embedding/embedding.module';
import { InteractionModule } from '../interaction/interaction.module';
import { SettingsModule } from '../settings/settings.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { EntityModule } from '../entity/entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job, Message]),
    BullModule.registerQueue({ name: 'embedding' }),
    BullModule.registerQueue({
      name: 'fact-extraction',
      defaultJobOptions: {
        removeOnComplete: 1000, // Keep last 1000 completed for debugging
        removeOnFail: 50,       // Keep last 50 failed
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    }),
    EmbeddingModule,
    SettingsModule,
    forwardRef(() => InteractionModule),
    forwardRef(() => ExtractionModule),
    forwardRef(() => EntityModule),
  ],
  providers: [JobService, EmbeddingProcessor, FactExtractionProcessor],
  exports: [JobService],
})
export class JobModule {}
