import { Module } from '@nestjs/common';
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

/**
 * DataQualityModule -- data quality auditing and issue resolution.
 *
 * Provides:
 * - DataQualityService -- audit logic, duplicate detection, merge
 * - DataQualityToolsProvider -- AI agent tools for quality audits
 *
 * No controller in this module -- REST API is added separately in P4.3.
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
  ],
  providers: [DataQualityService, DataQualityToolsProvider],
  exports: [DataQualityService, DataQualityToolsProvider],
})
export class DataQualityModule {}
