import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TopicalSegment, KnowledgePack } from '@pkg/entities';
import { SegmentationService } from './segmentation.service';
import { SegmentationController } from './segmentation.controller';
import { TopicBoundaryDetectorService } from './topic-boundary-detector.service';
import { ClaudeAgentModule } from '../claude-agent/claude-agent.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * SegmentationModule — управление тематическими сегментами и пакетами знаний.
 *
 * TopicalSegment — семантическая единица обсуждения (группа сообщений по теме).
 * KnowledgePack — консолидированные знания из нескольких сегментов.
 * TopicBoundaryDetector — Claude-based определение границ тем.
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TopicalSegment, KnowledgePack]),
    ClaudeAgentModule,
    SettingsModule,
  ],
  controllers: [SegmentationController],
  providers: [SegmentationService, TopicBoundaryDetectorService],
  exports: [SegmentationService, TopicBoundaryDetectorService],
})
export class SegmentationModule {}
