import {
  IsString,
  IsUUID,
  IsOptional,
  IsArray,
  IsNumber,
  IsDateString,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

export class CreateSegmentDto {
  @IsString()
  @MaxLength(500)
  topic: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  keywords?: string[];

  @IsOptional()
  @IsString()
  summary?: string;

  @IsString()
  @MaxLength(100)
  chatId: string;

  @IsOptional()
  @IsUUID()
  interactionId?: string;

  @IsOptional()
  @IsUUID()
  activityId?: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  participantIds: string[];

  @IsOptional()
  @IsUUID()
  primaryParticipantId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  messageIds?: string[];

  @IsDateString()
  startedAt: string;

  @IsDateString()
  endedAt: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;
}
