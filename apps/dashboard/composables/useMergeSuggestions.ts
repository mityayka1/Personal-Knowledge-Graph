import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { Ref } from 'vue';

// ============================================================
// Types
// ============================================================

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

export interface PrimaryEntityDto {
  id: string;
  name: string;
  type: 'person' | 'organization';
  profilePhoto?: string | null;
  identifiers: EntityIdentifierDto[];
}

export interface MergeCandidateDto {
  id: string;
  name: string;
  extractedUserId?: string;
  createdAt: string;
  messageCount: number;
}

export interface MergeSuggestionGroupDto {
  primaryEntity: PrimaryEntityDto;
  candidates: MergeCandidateDto[];
  reason: 'orphaned_telegram_id' | 'shared_identifier' | 'similar_name';
}

export interface MergeSuggestionsResponse {
  groups: MergeSuggestionGroupDto[];
  total: number;
}

export interface EntityMergeDataDto {
  id: string;
  name: string;
  type: 'person' | 'organization';
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

export type ConflictResolution = 'KEEP_TARGET' | 'KEEP_SOURCE' | 'KEEP_BOTH';

export interface ConflictResolutionDto {
  field: 'identifier' | 'fact';
  type: string;
  resolution: ConflictResolution;
}

export interface MergeRequestDto {
  sourceId: string;
  targetId: string;
  includeIdentifiers: string[];
  includeFacts: string[];
  conflictResolutions: ConflictResolutionDto[];
}

export interface MergeResultDto {
  mergedEntityId: string;
  sourceEntityDeleted: boolean;
  identifiersMoved: number;
  factsMoved: number;
}

// ============================================================
// Composables
// ============================================================

/**
 * Fetch merge suggestions (orphaned entities that can be merged).
 */
export function useMergeSuggestions(params?: Ref<{ limit?: number; offset?: number }>) {
  return useQuery({
    queryKey: ['merge-suggestions', params],
    queryFn: async () => {
      const query: Record<string, number> = {};
      if (params?.value.limit) query.limit = params.value.limit;
      if (params?.value.offset) query.offset = params.value.offset;

      return await $fetch<MergeSuggestionsResponse>('/api/entities/merge-suggestions', {
        query,
      });
    },
  });
}

/**
 * Dismiss a merge suggestion (mark as not-a-duplicate).
 */
export function useDismissSuggestion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      primaryId,
      candidateId,
    }: {
      primaryId: string;
      candidateId: string;
    }) => {
      return await $fetch(`/api/entities/merge-suggestions/${primaryId}/dismiss/${candidateId}`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['merge-suggestions'] });
    },
  });
}

/**
 * Get merge preview (detailed data for both entities + conflicts).
 */
export function useMergePreview(sourceId: Ref<string>, targetId: Ref<string>) {
  return useQuery({
    queryKey: ['merge-preview', sourceId, targetId],
    queryFn: async () => {
      return await $fetch<MergePreviewDto>(
        `/api/entities/merge-suggestions/preview/${sourceId.value}/${targetId.value}`
      );
    },
    enabled: () => !!sourceId.value && !!targetId.value,
  });
}

/**
 * Execute merge with selected fields and conflict resolutions.
 */
export function useExecuteMerge() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (request: MergeRequestDto) => {
      return await $fetch<MergeResultDto>('/api/entities/merge-suggestions/merge', {
        method: 'POST',
        body: request,
      });
    },
    onSuccess: () => {
      // Invalidate related queries
      queryClient.invalidateQueries({ queryKey: ['merge-suggestions'] });
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      queryClient.invalidateQueries({ queryKey: ['merge-preview'] });
    },
  });
}
