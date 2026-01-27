import { EntityType } from '@pkg/entities';
import { EntityIdentifierDto, EntityFactDto } from './merge-suggestion.dto';

export interface EntityMergeDataDto {
  id: string;
  name: string;
  type: EntityType;
  identifiers: EntityIdentifierDto[];
  facts: EntityFactDto[];
  messageCount: number;
  relationsCount: number;
}

export interface MergeConflictDto {
  field: 'identifier' | 'fact';
  type: string;
  sourceValue: string | null;
  targetValue: string | null;
}

export interface MergePreviewDto {
  source: EntityMergeDataDto;
  target: EntityMergeDataDto;
  conflicts: MergeConflictDto[];
}
