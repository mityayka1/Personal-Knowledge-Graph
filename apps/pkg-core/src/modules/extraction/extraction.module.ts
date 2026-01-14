import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityFact, EntityEvent } from '@pkg/entities';
import { FactExtractionService } from './fact-extraction.service';
import { RelevanceFilterService } from './relevance-filter.service';
import { FactDeduplicationService } from './fact-deduplication.service';
import { EventExtractionService } from './event-extraction.service';
import { ExtractionController } from './extraction.controller';
import { ResolutionModule } from '../resolution/resolution.module';
import { InteractionModule } from '../interaction/interaction.module';
import { EntityModule } from '../entity/entity.module';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([EntityFact, EntityEvent]),
    ResolutionModule,
    forwardRef(() => InteractionModule),
    forwardRef(() => EntityModule),
    ClaudeAgentModule,
  ],
  controllers: [ExtractionController],
  providers: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
  ],
  exports: [
    FactExtractionService,
    RelevanceFilterService,
    FactDeduplicationService,
    EventExtractionService,
  ],
})
export class ExtractionModule {}
