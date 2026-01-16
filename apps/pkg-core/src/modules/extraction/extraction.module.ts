import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EntityFact, EntityEvent, ExtractedEvent } from '@pkg/entities';
import { FactExtractionService } from './fact-extraction.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { EventExtractionService } from './event-extraction.service';
import { SecondBrainExtractionService } from './second-brain-extraction.service';
import { ContextEnrichmentService } from './context-enrichment.service';
import { EnrichmentProcessor } from './enrichment.processor';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { ExtractionController } from './extraction.controller';
import { ExtractedEventController } from './extracted-event.controller';
import { ResolutionModule } from '../resolution/resolution.module';
import { InteractionModule } from '../interaction/interaction.module';
import { EntityModule } from '../entity/entity.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { SettingsModule } from '../settings/settings.module';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EntityFact, EntityEvent, ExtractedEvent]),
    BullModule.registerQueue({
      name: 'enrichment',
      defaultJobOptions: {
        removeOnComplete: 500,
        removeOnFail: 100,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }, // 5s -> 10s -> 20s
      },
    }),
    ResolutionModule,
    forwardRef(() => InteractionModule),
    forwardRef(() => EntityModule),
    EntityEventModule,
    ClaudeAgentModule,
    SettingsModule,
    SearchModule,
  ],
  controllers: [ExtractionController, ExtractedEventController],
  providers: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
    SecondBrainExtractionService,
    ContextEnrichmentService,
    EnrichmentProcessor,
    EnrichmentQueueService,
  ],
  exports: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
    SecondBrainExtractionService,
    ContextEnrichmentService,
    EnrichmentQueueService,
  ],
})
export class ExtractionModule {}
