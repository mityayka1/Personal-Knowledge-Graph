import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TranscriptSegment } from '@pkg/entities';

@Injectable()
export class TranscriptSegmentService {
  constructor(
    @InjectRepository(TranscriptSegment)
    private segmentRepo: Repository<TranscriptSegment>,
  ) {}

  async createMany(interactionId: string, segments: Array<{
    speakerLabel: string;
    speakerEntityId?: string;
    content: string;
    startTime: number;
    endTime: number;
    confidence?: number;
  }>) {
    const created = segments.map(segment =>
      this.segmentRepo.create({
        interactionId,
        speakerLabel: segment.speakerLabel,
        speakerEntityId: segment.speakerEntityId,
        content: segment.content,
        startTime: segment.startTime,
        endTime: segment.endTime,
        confidence: segment.confidence,
      }),
    );

    return this.segmentRepo.save(created);
  }

  async findByInteraction(interactionId: string) {
    return this.segmentRepo.find({
      where: { interactionId },
      order: { startTime: 'ASC' },
    });
  }
}
