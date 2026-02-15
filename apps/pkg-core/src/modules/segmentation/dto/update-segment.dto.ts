import {
  IsString,
  IsUUID,
  IsOptional,
  IsArray,
  IsNumber,
  IsEnum,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { SegmentStatus } from '@pkg/entities';

export class UpdateSegmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  topic?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsUUID()
  activityId?: string | null;

  @IsOptional()
  @IsEnum(SegmentStatus)
  status?: SegmentStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;
}
