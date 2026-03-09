import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DataQualityReport,
  Activity,
  ActivityMember,
  Commitment,
  EntityRelation,
  EntityFact,
} from '@pkg/entities';
import { DataQualityService } from './data-quality.service';
import { DataQualityToolsProvider } from './data-quality-tools.provider';
import { DataQualityController } from './data-quality.controller';
import { OrphanResolutionService } from './orphan-resolution.service';
import { FactConsolidationJob } from './fact-consolidation.job';
import { ActivityFactReclassificationService } from './activity-fact-reclassification.service';
import { ActivityModule } from '../activity/activity.module';
import { EntityModule } from '../entity/entity.module';
import { ExtractionModule } from '../extraction/extraction.module';
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';

/**
 * DataQualityModule -- data quality auditing and issue resolution.
 *
 * Provides:
 * - DataQualityController -- REST API for audits, reports, merge
 * - DataQualityService -- audit logic, duplicate detection, merge, orphan resolution
 * - OrphanResolutionService -- multi-strategy orphan task assignment
 * - DataQualityToolsProvider -- AI agent tools for quality audits
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DataQualityReport,
      Activity,
      ActivityMember,
      Commitment,
      EntityRelation,
      EntityFact,
    ]),
    ActivityModule,
    EntityModule,
    forwardRef(() => ExtractionModule),
    ClaudeAgentCoreModule,
  ],
  controllers: [DataQualityController],
  providers: [
    DataQualityService,
    OrphanResolutionService,
    DataQualityToolsProvider,
    FactConsolidationJob,
    ActivityFactReclassificationService,
  ],
  exports: [DataQualityService, DataQualityToolsProvider],
})
export class DataQualityModule {}
