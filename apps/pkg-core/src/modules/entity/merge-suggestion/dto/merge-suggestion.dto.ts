import { EntityType } from '@pkg/entities';

export interface EntityIdentifierDto {
  id: string;
  identifierType: string;
  identifierValue: string;
}

export interface EntityFactDto {
  id: string;
  factType: string;
  value: string | null;
  ranking: string;
}

export interface MergeCandidateDto {
  id: string;
  name: string;
  extractedUserId?: string;
  createdAt: Date;
  messageCount: number;
}

export interface PrimaryEntityDto {
  id: string;
  name: string;
  type: EntityType;
  profilePhoto?: string | null;
  identifiers: EntityIdentifierDto[];
}

export interface MergeSuggestionGroupDto {
  primaryEntity: PrimaryEntityDto;
  candidates: MergeCandidateDto[];
  reason: 'orphaned_telegram_id' | 'shared_identifier' | 'similar_name';
}

export interface MergeSuggestionsResponseDto {
  groups: MergeSuggestionGroupDto[];
  total: number;
}
