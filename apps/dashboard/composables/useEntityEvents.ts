import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { Ref } from 'vue';

export type EventType = 'meeting' | 'deadline' | 'commitment' | 'follow_up';
export type EventStatus = 'scheduled' | 'completed' | 'cancelled';

export interface EntityEvent {
  id: string;
  entity_id: string;
  related_entity_id?: string;
  event_type: EventType;
  title: string;
  description?: string;
  event_date?: string;
  status: EventStatus;
  confidence?: number;
  source_quote?: string;
  source_message_id?: string;
  created_at: string;
  updated_at: string;
}

export interface EventStats {
  total: number;
  byType: Record<EventType, number>;
  byStatus: Record<EventStatus, number>;
  upcoming: number;
  overdue: number;
}

interface EventsListParams {
  entityId?: string;
  eventType?: EventType;
  status?: EventStatus;
  limit?: number;
  offset?: number;
}

/**
 * Fetch entity events with filters
 */
export function useEntityEvents(params: Ref<EventsListParams>) {
  return useQuery<{ items: EntityEvent[]; total: number }>({
    queryKey: ['entity-events', params],
    queryFn: async () => {
      const query = new URLSearchParams();
      if (params.value.entityId) query.set('entity_id', params.value.entityId);
      if (params.value.eventType) query.set('event_type', params.value.eventType);
      if (params.value.status) query.set('status', params.value.status);
      if (params.value.limit) query.set('limit', params.value.limit.toString());
      if (params.value.offset) query.set('offset', params.value.offset.toString());

      return $fetch(`/api/entity-events?${query.toString()}`);
    },
  });
}

/**
 * Fetch events for a specific entity
 */
export function useEntityEventsByEntity(entityId: Ref<string | undefined>) {
  return useQuery<EntityEvent[]>({
    queryKey: ['entity-events', 'by-entity', entityId],
    queryFn: () => $fetch(`/api/entity-events?entity_id=${entityId.value}&limit=50`).then((r: any) => r.items),
    enabled: () => !!entityId.value,
  });
}

/**
 * Fetch upcoming events
 */
export function useUpcomingEvents(limit: number = 10) {
  return useQuery<EntityEvent[]>({
    queryKey: ['entity-events', 'upcoming', limit],
    queryFn: () => $fetch(`/api/entity-events/upcoming?limit=${limit}`),
  });
}

/**
 * Fetch overdue events
 */
export function useOverdueEvents(limit: number = 10) {
  return useQuery<EntityEvent[]>({
    queryKey: ['entity-events', 'overdue', limit],
    queryFn: () => $fetch(`/api/entity-events/overdue?limit=${limit}`),
  });
}

/**
 * Fetch event statistics
 */
export function useEventStats() {
  return useQuery<EventStats>({
    queryKey: ['entity-events', 'stats'],
    queryFn: () => $fetch('/api/entity-events/stats'),
  });
}

/**
 * Fetch single event
 */
export function useEntityEvent(eventId: Ref<string | undefined>) {
  return useQuery<EntityEvent>({
    queryKey: ['entity-events', eventId],
    queryFn: () => $fetch(`/api/entity-events/${eventId.value}`),
    enabled: () => !!eventId.value,
  });
}

/**
 * Mark event as completed
 */
export function useCompleteEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (eventId: string) =>
      $fetch(`/api/entity-events/${eventId}/complete`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entity-events'] });
    },
  });
}

/**
 * Mark event as cancelled
 */
export function useCancelEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (eventId: string) =>
      $fetch(`/api/entity-events/${eventId}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entity-events'] });
    },
  });
}

/**
 * Delete event
 */
export function useDeleteEvent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (eventId: string) =>
      $fetch(`/api/entity-events/${eventId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entity-events'] });
    },
  });
}

/**
 * Get event type display info
 */
export function getEventTypeInfo(type: EventType): { label: string; icon: string; color: string } {
  const types: Record<EventType, { label: string; icon: string; color: string }> = {
    meeting: { label: 'Встреча', icon: '📅', color: 'bg-blue-100 text-blue-800' },
    deadline: { label: 'Дедлайн', icon: '⏰', color: 'bg-red-100 text-red-800' },
    commitment: { label: 'Договорённость', icon: '🤝', color: 'bg-green-100 text-green-800' },
    follow_up: { label: 'Напоминание', icon: '🔔', color: 'bg-yellow-100 text-yellow-800' },
  };
  return types[type] || { label: type, icon: '📌', color: 'bg-gray-100 text-gray-800' };
}

/**
 * Get event status display info
 */
export function getEventStatusInfo(status: EventStatus): { label: string; color: string } {
  const statuses: Record<EventStatus, { label: string; color: string }> = {
    scheduled: { label: 'Запланировано', color: 'bg-blue-100 text-blue-800' },
    completed: { label: 'Выполнено', color: 'bg-green-100 text-green-800' },
    cancelled: { label: 'Отменено', color: 'bg-gray-100 text-gray-500' },
  };
  return statuses[status] || { label: status, color: 'bg-gray-100 text-gray-800' };
}
