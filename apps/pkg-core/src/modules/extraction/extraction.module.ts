import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import {
  EntityFact,
  EntityEvent,
  ExtractedEvent,
  Message,
  Interaction,
  Activity,
  Commitment,
  PendingApproval,
  EntityRecord,
} from '@pkg/entities';
import { FactExtractionService } from './fact-extraction.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { SecondBrainExtractionService } from './second-brain-extraction.service';
import { ContextEnrichmentService } from './context-enrichment.service';
import { PromiseRecipientService } from './promise-recipient.service';
import { EnrichmentProcessor } from './enrichment.processor';
import { EnrichmentQueueService } from './enrichment-queue.service';
import { ConversationGrouperService } from './conversation-grouper.service';
import { CrossChatContextService } from './cross-chat-context.service';
import { SubjectResolverService } from './subject-resolver.service';
import { RelationInferenceService } from './relation-inference.service';
import { ExtractionController } from './extraction.controller';
import { ExtractedEventController } from './extracted-event.controller';
import { ExtractionToolsProvider } from './tools/extraction-tools.provider';
import { UnifiedExtractionService } from './unified-extraction.service';
import { DailySynthesisExtractionService } from './daily-synthesis-extraction.service';
import { ExtractionPersistenceService } from './extraction-persistence.service';
import { DraftExtractionService } from './draft-extraction.service';
import { ClientResolutionService } from './client-resolution.service';
import { ProjectMatchingService } from './project-matching.service';
import { FactDedupReviewService } from './fact-dedup-review.service';
import { GroupExtractionService } from './group-extraction.service';
import { EventCleanupService } from './event-cleanup.service';
import { LlmDedupService } from './llm-dedup.service';
import { ResolutionModule } from '../resolution/resolution.module';
import { PendingApprovalModule } from '../pending-approval/pending-approval.module';
import { InteractionModule } from '../interaction/interaction.module';
import { EntityModule } from '../entity/entity.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';
import { SettingsModule } from '../settings/settings.module';
import { SearchModule } from '../search/search.module';
import { EmbeddingModule } from '../embedding/embedding.module';
import { ConfirmationModule } from '../confirmation/confirmation.module';
import { ActivityModule } from '../activity/activity.module';
import { DataQualityModule } from '../data-quality/data-quality.module';
import { JobModule } from '../job/job.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      EntityFact,
      EntityEvent,
      ExtractedEvent,
      Message,
      Interaction,
      Activity,
      Commitment,
      PendingApproval,
      EntityRecord,
    ]),
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
    ClaudeAgentCoreModule,
    SettingsModule,
    SearchModule,
    EmbeddingModule,
    forwardRef(() => ConfirmationModule),
    ActivityModule,
    forwardRef(() => DataQualityModule),
    PendingApprovalModule,
    forwardRef(() => JobModule),
  ],
  controllers: [ExtractionController, ExtractedEventController],
  providers: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    SecondBrainExtractionService,
    ContextEnrichmentService,
    PromiseRecipientService,
    EnrichmentProcessor,
    EnrichmentQueueService,
    ConversationGrouperService,
    CrossChatContextService,
    SubjectResolverService,
    RelationInferenceService,
    ExtractionToolsProvider,
    UnifiedExtractionService,
    DailySynthesisExtractionService,
    ExtractionPersistenceService,
    DraftExtractionService,
    ClientResolutionService,
    ProjectMatchingService,
    FactDedupReviewService,
    GroupExtractionService,
    EventCleanupService,
    LlmDedupService,
  ],
  exports: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    SecondBrainExtractionService,
    ContextEnrichmentService,
    PromiseRecipientService,
    EnrichmentQueueService,
    ConversationGrouperService,
    CrossChatContextService,
    SubjectResolverService,
    RelationInferenceService,
    ExtractionToolsProvider,
    UnifiedExtractionService,
    DailySynthesisExtractionService,
    ExtractionPersistenceService,
    DraftExtractionService,
    ClientResolutionService,
    ProjectMatchingService,
    FactDedupReviewService,
    GroupExtractionService,
    LlmDedupService,
  ],
})
export class ExtractionModule {}
