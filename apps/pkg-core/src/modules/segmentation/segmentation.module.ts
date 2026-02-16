import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TopicalSegment, KnowledgePack, Interaction, Message, EntityFact, Commitment, Activity } from '@pkg/entities';
import { SegmentationService } from './segmentation.service';
import { SegmentationController } from './segmentation.controller';
import { TopicBoundaryDetectorService } from './topic-boundary-detector.service';
import { PackingService } from './packing.service';
import { PackingController } from './packing.controller';
import { SegmentationJobService } from './segmentation-job.service';
import { PackingJobService } from './packing-job.service';
import { OrphanSegmentLinkerService } from './orphan-segment-linker.service';
import { KnowledgeToolsProvider } from './knowledge-tools.provider';
import { ClaudeAgentCoreModule } from '../claude-agent/claude-agent-core.module';
import { SettingsModule } from '../settings/settings.module';
import { ExtractionModule } from '../extraction/extraction.module';

/**
 * SegmentationModule — управление тематическими сегментами и пакетами знаний.
 *
 * TopicalSegment — семантическая единица обсуждения (группа сообщений по теме).
 * KnowledgePack — консолидированные знания из нескольких сегментов.
 * TopicBoundaryDetector — Claude-based определение границ тем.
 * PackingService — консолидация сегментов в пакеты знаний через Claude.
 * OrphanSegmentLinker — автоматическая привязка orphan сегментов к Activity.
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TopicalSegment, KnowledgePack, Interaction, Message, EntityFact, Commitment, Activity]),
    ClaudeAgentCoreModule,
    SettingsModule,
    forwardRef(() => ExtractionModule),
  ],
  controllers: [SegmentationController, PackingController],
  providers: [SegmentationService, TopicBoundaryDetectorService, PackingService, SegmentationJobService, PackingJobService, OrphanSegmentLinkerService, KnowledgeToolsProvider],
  exports: [SegmentationService, TopicBoundaryDetectorService, PackingService, OrphanSegmentLinkerService, KnowledgeToolsProvider],
})
export class SegmentationModule {}
