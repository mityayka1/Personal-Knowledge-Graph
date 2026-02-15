import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TopicalSegment, KnowledgePack } from '@pkg/entities';
import { SegmentationService } from './segmentation.service';
import { SegmentationController } from './segmentation.controller';

/**
 * SegmentationModule — управление тематическими сегментами и пакетами знаний.
 *
 * TopicalSegment — семантическая единица обсуждения (группа сообщений по теме).
 * KnowledgePack — консолидированные знания из нескольких сегментов.
 *
 * Phase E: Knowledge Segmentation & Packing
 */
@Module({
  imports: [TypeOrmModule.forFeature([TopicalSegment, KnowledgePack])],
  controllers: [SegmentationController],
  providers: [SegmentationService],
  exports: [SegmentationService],
})
export class SegmentationModule {}
