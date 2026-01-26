import { IsArray, IsEnum, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum ConflictResolution {
  KEEP_TARGET = 'keep_target',
  KEEP_SOURCE = 'keep_source',
  KEEP_BOTH = 'keep_both',
}

export class ConflictResolutionDto {
  @IsEnum(['identifier', 'fact'])
  field: 'identifier' | 'fact';

  @IsString()
  type: string;

  @IsEnum(ConflictResolution)
  resolution: ConflictResolution;
}

export class MergeRequestDto {
  @IsUUID()
  sourceId: string;

  @IsUUID()
  targetId: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  includeIdentifiers: string[];

  @IsArray()
  @IsUUID(undefined, { each: true })
  includeFacts: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConflictResolutionDto)
  conflictResolutions: ConflictResolutionDto[];
}
