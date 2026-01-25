import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { EntityFact, EntityEvent, ExtractedEvent, Message, Interaction } from '@pkg/entities';
import { FactExtractionService } from './fact-extraction.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { EventExtractionService } from './event-extraction.service';
import { SecondBrainExtractionService } from './second-brain-extraction.service';
import { ContextEnrichmentService } from './context-enrichment.service';
import { PromiseRecipientService } from './promise-recipient.service';
import { EnrichmentProcessor } from './enrichment.processor';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { ConversationGrouperService } from './conversation-grouper.service';
import { CrossChatContextService } from './cross-chat-context.service';
import { ExtractionController } from './extraction.controller';
import { ExtractedEventController } from './extracted-event.controller';
import { ExtractionToolsProvider } from './tools/extraction-tools.provider';
import { ResolutionModule } from '../resolution/resolution.module';
import { InteractionModule } from '../interaction/interaction.module';
import { EntityModule } from '../entity/entity.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { SettingsModule } from '../settings/settings.module';
import { SearchModule } from '../search/search.module';
import { EmbeddingModule } from '../embedding/embedding.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EntityFact, EntityEvent, ExtractedEvent, Message, Interaction]),
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
    forwardRef(() => ClaudeAgentModule),
    SettingsModule,
    SearchModule,
    EmbeddingModule,
  ],
  controllers: [ExtractionController, ExtractedEventController],
  providers: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
    SecondBrainExtractionService,
    ContextEnrichmentService,
    PromiseRecipientService,
    EnrichmentProcessor,
    EnrichmentQueueService,
    ConversationGrouperService,
    CrossChatContextService,
    ExtractionToolsProvider,
  ],
  exports: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
    SecondBrainExtractionService,
    ContextEnrichmentService,
    PromiseRecipientService,
    EnrichmentQueueService,
    ConversationGrouperService,
    CrossChatContextService,
    ExtractionToolsProvider,
  ],
})
export class ExtractionModule {}
