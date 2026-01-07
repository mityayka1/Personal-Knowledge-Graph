import { Controller, Post, Body } from '@nestjs/common';
import { TranscriptSegmentService } from './transcript-segment.service';
import { IsString, IsArray, ValidateNested, IsNumber, IsOptional, IsUUID } from 'class-validator';
import { Type } from 'class-transformer';

class SegmentDto {
  @IsString()
  speaker_label: string;

  @IsString()
  content: string;

  @IsNumber()
  start_time: number;

  @IsNumber()
  end_time: number;

  @IsOptional()
  @IsNumber()
  confidence?: number;
}

class SpeakerMappingDto {
  @IsString()
  role: 'self' | 'other';

  @IsOptional()
  @IsUUID()
  suggested_entity_id?: string;

  @IsOptional()
  @IsString()
  suggested_name?: string;

  @IsOptional()
  @IsNumber()
  confidence?: number;
}

class CreateTranscriptSegmentsDto {
  @IsUUID()
  interaction_id: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SegmentDto)
  segments: SegmentDto[];

  speaker_mapping: Record<string, SpeakerMappingDto>;
}

@Controller('transcript-segments')
export class TranscriptSegmentController {
  constructor(private segmentService: TranscriptSegmentService) {}

  @Post()
  async create(@Body() dto: CreateTranscriptSegmentsDto) {
    const segments = dto.segments.map(s => ({
      speakerLabel: s.speaker_label,
      content: s.content,
      startTime: s.start_time,
      endTime: s.end_time,
      confidence: s.confidence,
      speakerEntityId: dto.speaker_mapping[s.speaker_label]?.suggested_entity_id,
    }));

    const created = await this.segmentService.createMany(dto.interaction_id, segments);

    return {
      segments_created: created.length,
      pending_resolution_created: false,
    };
  }
}
