import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TopicalSegment, KnowledgePack, Interaction, Message, EntityFact, Commitment } from '@pkg/entities';
import { SegmentationService } from './segmentation.service';
import { SegmentationController } from './segmentation.controller';
import { TopicBoundaryDetectorService } from './topic-boundary-detector.service';
import { PackingService } from './packing.service';
import { PackingController } from './packing.controller';
import { SegmentationJobService } from './segmentation-job.service';
import { PackingJobService } from './packing-job.service';
import { KnowledgeToolsProvider } from './knowledge-tools.provider';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * SegmentationModule — управление тематическими сегментами и пакетами знаний.
 *
 * TopicalSegment — семантическая единица обсуждения (группа сообщений по теме).
 * KnowledgePack — консолидированные знания из нескольких сегментов.
 * TopicBoundaryDetector — Claude-based определение границ тем.
 * PackingService — консолидация сегментов в пакеты знаний через Claude.
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TopicalSegment, KnowledgePack, Interaction, Message, EntityFact, Commitment]),
    ClaudeAgentModule,
    SettingsModule,
  ],
  controllers: [SegmentationController, PackingController],
  providers: [SegmentationService, TopicBoundaryDetectorService, PackingService, SegmentationJobService, PackingJobService, KnowledgeToolsProvider],
  exports: [SegmentationService, TopicBoundaryDetectorService, PackingService, KnowledgeToolsProvider],
})
export class SegmentationModule {}
