import {
  IsString,
  MinLength,
  IsOptional,
  IsUUID,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request DTO for POST /agent/recall
 */
export class RecallRequestDto {
  @ApiProperty({
    description: 'Natural language query for searching conversations',
    example: 'что обсуждали с Иваном на прошлой неделе?',
    minLength: 3,
  })
  @IsString()
  @MinLength(3, { message: 'Query must be at least 3 characters' })
  query: string;

  @ApiPropertyOptional({
    description: 'Filter results to specific entity (person/organization) by UUID',
    example: '123e4567-e89b-12d3-a456-426614174000',
  })
  @IsOptional()
  @IsUUID('4', { message: 'entityId must be a valid UUID' })
  entityId?: string;

  @ApiPropertyOptional({
    description: 'Maximum agent iterations (turns)',
    minimum: 1,
    maximum: 20,
    default: 15,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxTurns?: number;
}

/**
 * Source reference in recall response
 */
export class RecallSourceDto {
  @ApiProperty({
    enum: ['message', 'interaction'],
    description: 'Type of source',
  })
  type: 'message' | 'interaction';

  @ApiProperty({ description: 'Source UUID' })
  id: string;

  @ApiProperty({
    description: 'Short preview/quote from source (up to 200 chars)',
  })
  preview: string;
}

/**
 * Response data for recall endpoint
 */
export class RecallResponseDataDto {
  @ApiProperty({ description: 'Agent answer in natural language (Russian)' })
  answer: string;

  @ApiProperty({
    type: [RecallSourceDto],
    description: 'Sources used to generate the answer',
  })
  sources: RecallSourceDto[];

  @ApiProperty({
    type: [String],
    description: 'Tools invoked during agent execution',
  })
  toolsUsed: string[];
}

/**
 * Full response for recall endpoint
 */
export class RecallResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: RecallResponseDataDto })
  data: RecallResponseDataDto;
}

/**
 * Response data for prepare endpoint
 */
export class PrepareResponseDataDto {
  @ApiProperty({ description: 'Entity UUID' })
  entityId: string;

  @ApiProperty({ description: 'Entity display name' })
  entityName: string;

  @ApiProperty({ description: 'Structured markdown brief about the entity' })
  brief: string;

  @ApiProperty({ description: 'Number of recent interactions found' })
  recentInteractions: number;

  @ApiProperty({
    type: [String],
    description: 'Open questions or pending action items',
  })
  openQuestions: string[];
}

/**
 * Full response for prepare endpoint
 */
export class PrepareResponseDto {
  @ApiProperty({ description: 'Operation success flag' })
  success: boolean;

  @ApiProperty({ type: PrepareResponseDataDto })
  data: PrepareResponseDataDto;
}
