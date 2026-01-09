import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { Ref } from 'vue';

export interface EntityIdentifier {
  id: string;
  identifierType: string;
  identifierValue: string;
  metadata?: Record<string, unknown>;
}

export interface EntityFact {
  id: string;
  type: string;
  category?: string;
  value?: string;
  valueDate?: string;
  source: 'manual' | 'extracted' | 'imported';
}

export interface Entity {
  id: string;
  type: 'person' | 'organization';
  name: string;
  notes?: string;
  organizationId?: string;
  organization?: { id: string; name: string };
  identifiers: EntityIdentifier[];
  facts: EntityFact[];
  createdAt: string;
  updatedAt: string;
}

export interface EntityListParams {
  type?: 'person' | 'organization';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface EntityListResponse {
  items: Entity[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateEntityDto {
  type: 'person' | 'organization';
  name: string;
  organizationId?: string;
  notes?: string;
  identifiers?: Array<{
    type: string;
    value: string;
    metadata?: Record<string, unknown>;
  }>;
  facts?: Array<{
    type: string;
    category?: string;
    value?: string;
    valueDate?: string;
    source?: 'manual' | 'extracted' | 'imported';
  }>;
}

export interface UpdateEntityDto {
  name?: string;
  organizationId?: string | null;
  notes?: string | null;
}

// List entities with filtering and pagination
export function useEntities(params: Ref<EntityListParams>) {
  return useQuery({
    queryKey: ['entities', params],
    queryFn: async () => {
      const query: Record<string, string | number> = {};
      if (params.value.type) query.type = params.value.type;
      if (params.value.search) query.search = params.value.search;
      if (params.value.limit) query.limit = params.value.limit;
      if (params.value.offset) query.offset = params.value.offset;

      return await $fetch<EntityListResponse>('/api/entities', { query });
    },
  });
}

// Get single entity by ID
export function useEntity(id: Ref<string>) {
  return useQuery({
    queryKey: ['entities', id],
    queryFn: async () => {
      return await $fetch<Entity>(`/api/entities/${id.value}`);
    },
    enabled: () => !!id.value,
  });
}

// Create new entity
export function useCreateEntity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateEntityDto) => {
      return await $fetch<Entity>('/api/entities', {
        method: 'POST',
        body: data,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
    },
  });
}

// Update entity
export function useUpdateEntity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateEntityDto }) => {
      return await $fetch<Entity>(`/api/entities/${id}`, {
        method: 'PATCH',
        body: data,
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
      queryClient.invalidateQueries({ queryKey: ['entities', variables.id] });
    },
  });
}

// Delete entity
export function useDeleteEntity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return await $fetch<{ deleted: boolean; id: string }>(`/api/entities/${id}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
    },
  });
}

// Merge entities
export function useMergeEntities() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sourceId, targetId }: { sourceId: string; targetId: string }) => {
      return await $fetch<{
        mergedEntityId: string;
        sourceEntityDeleted: boolean;
        identifiersMoved: number;
        factsMoved: number;
      }>(`/api/entities/${sourceId}/merge/${targetId}`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entities'] });
    },
  });
}

// Add fact to entity
export interface CreateFactDto {
  type: string;
  category?: string;
  value?: string;
  valueDate?: string;
  source?: 'manual' | 'extracted' | 'imported';
}

export function useAddFact() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ entityId, data }: { entityId: string; data: CreateFactDto }) => {
      return await $fetch<EntityFact>(`/api/entities/${entityId}/facts`, {
        method: 'POST',
        body: data,
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['entities', variables.entityId] });
    },
  });
}

// Remove fact from entity
export function useRemoveFact() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ entityId, factId }: { entityId: string; factId: string }) => {
      return await $fetch<{ invalidated: boolean; factId: string }>(`/api/entities/${entityId}/facts/${factId}`, {
        method: 'DELETE',
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['entities', variables.entityId] });
    },
  });
}
