import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DataQualityReport,
  Activity,
  ActivityMember,
  Commitment,
  EntityRelation,
} from '@pkg/entities';
import { DataQualityService } from './data-quality.service';
import { DataQualityToolsProvider } from './data-quality-tools.provider';
import { DataQualityController } from './data-quality.controller';
import { OrphanResolutionService } from './orphan-resolution.service';
import { ActivityModule } from '../activity/activity.module';
import { ExtractionModule } from '../extraction/extraction.module';

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
    ]),
    ActivityModule,
    forwardRef(() => ExtractionModule),
  ],
  controllers: [DataQualityController],
  providers: [DataQualityService, OrphanResolutionService, DataQualityToolsProvider],
  exports: [DataQualityService, DataQualityToolsProvider],
})
export class DataQualityModule {}
