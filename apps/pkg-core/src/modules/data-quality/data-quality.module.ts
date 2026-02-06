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
import { DataQualityController } from './data-quality.controller';

/**
 * DataQualityModule -- data quality auditing and issue resolution.
 *
 * Provides:
 * - DataQualityController -- REST API for audits, reports, merge
 * - DataQualityService -- audit logic, duplicate detection, merge
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
  ],
  controllers: [DataQualityController],
  providers: [DataQualityService, DataQualityToolsProvider],
  exports: [DataQualityService, DataQualityToolsProvider],
})
export class DataQualityModule {}
