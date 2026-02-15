import { IsString, IsUUID, IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { SegmentStatus } from '@pkg/entities';

export class SegmentQueryDto {
  @IsOptional()
  @IsString()
  chatId?: string;

  @IsOptional()
  @IsUUID()
  activityId?: string;

  @IsOptional()
  @IsUUID()
  interactionId?: string;

  @IsOptional()
  @IsEnum(SegmentStatus)
  status?: SegmentStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
