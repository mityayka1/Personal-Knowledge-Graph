import { useQuery } from '@tanstack/vue-query';
import type { Ref } from 'vue';

export interface InteractionParticipant {
  id: string;
  entityId?: string;
  role: 'initiator' | 'recipient' | 'participant';
  identifierType: string;
  identifierValue: string;
  displayName?: string;
}

export interface Interaction {
  id: string;
  type: 'telegram_session' | 'phone_call' | 'video_meeting';
  source: string;
  status: 'active' | 'completed' | 'archived';
  startedAt: string;
  endedAt?: string;
  sourceMetadata?: Record<string, unknown>;
  participants: InteractionParticipant[];
  createdAt: string;
  updatedAt: string;
}

export interface InteractionListParams {
  limit?: number;
  offset?: number;
}

export interface InteractionListResponse {
  items: Interaction[];
  total: number;
  limit: number;
  offset: number;
}

// List interactions with pagination
export function useInteractions(params: Ref<InteractionListParams>) {
  return useQuery({
    queryKey: ['interactions', params],
    queryFn: async () => {
      const query: Record<string, string | number> = {};
      if (params.value.limit) query.limit = params.value.limit;
      if (params.value.offset) query.offset = params.value.offset;

      return await $fetch<InteractionListResponse>('/api/interactions', { query });
    },
  });
}

// Get single interaction by ID with messages
export function useInteraction(id: Ref<string>) {
  return useQuery({
    queryKey: ['interactions', id],
    queryFn: async () => {
      return await $fetch<Interaction & { messages: unknown[] }>(`/api/interactions/${id.value}`);
    },
    enabled: () => !!id.value,
  });
}
