import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityFact, EntityEvent, ExtractedEvent } from '@pkg/entities';
import { FactExtractionService } from './fact-extraction.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { EventExtractionService } from './event-extraction.service';
import { SecondBrainExtractionService } from './second-brain-extraction.service';
import { ExtractionController } from './extraction.controller';
import { ExtractedEventController } from './extracted-event.controller';
import { ResolutionModule } from '../resolution/resolution.module';
import { InteractionModule } from '../interaction/interaction.module';
import { EntityModule } from '../entity/entity.module';
import { EntityEventModule } from '../entity-event/entity-event.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EntityFact, EntityEvent, ExtractedEvent]),
    ResolutionModule,
    forwardRef(() => InteractionModule),
    forwardRef(() => EntityModule),
    EntityEventModule,
    ClaudeAgentModule,
    SettingsModule,
  ],
  controllers: [ExtractionController, ExtractedEventController],
  providers: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
    SecondBrainExtractionService,
  ],
  exports: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
    SecondBrainExtractionService,
  ],
})
export class ExtractionModule {}
