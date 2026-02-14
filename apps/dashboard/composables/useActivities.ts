import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { Ref, Component } from 'vue';

// ─────────────────────────────────────────────────────────────
// Types (mirror of @pkg/entities enums, kept as string unions)
// ─────────────────────────────────────────────────────────────

export type ActivityType =
  | 'area' | 'business' | 'direction' | 'project' | 'initiative'
  | 'task' | 'milestone' | 'habit' | 'learning' | 'event_series';

export type ActivityStatus =
  | 'draft' | 'idea' | 'active' | 'paused'
  | 'completed' | 'cancelled' | 'archived';

export type ActivityPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type ActivityContext = 'work' | 'personal' | 'any' | 'location_based';

export type ActivityMemberRole =
  | 'owner' | 'member' | 'observer' | 'assignee'
  | 'reviewer' | 'client' | 'consultant';

export interface ActivityMember {
  id: string;
  activityId: string;
  entityId: string;
  role: ActivityMemberRole;
  notes: string | null;
  entity?: { id: string; name: string; type: string };
  createdAt: string;
}

export interface Activity {
  id: string;
  name: string;
  activityType: ActivityType;
  description: string | null;
  status: ActivityStatus;
  priority: ActivityPriority;
  context: ActivityContext;
  parentId: string | null;
  parent?: { id: string; name: string; activityType: ActivityType };
  ownerEntityId: string;
  ownerEntity?: { id: string; name: string };
  clientEntityId: string | null;
  clientEntity?: { id: string; name: string } | null;
  deadline: string | null;
  startDate: string | null;
  endDate: string | null;
  recurrenceRule: string | null;
  tags: string[] | null;
  progress: number | null;
  metadata: Record<string, unknown> | null;
  depth: number;
  materializedPath: string | null;
  childrenCount?: number;
  members?: ActivityMember[];
  createdAt: string;
  updatedAt: string;
}

export interface ActivityListParams {
  activityType?: ActivityType;
  status?: ActivityStatus;
  context?: ActivityContext;
  parentId?: string;
  ownerEntityId?: string;
  clientEntityId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ActivityListResponse {
  items: Activity[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateActivityDto {
  name: string;
  activityType: ActivityType;
  ownerEntityId: string;
  description?: string;
  status?: ActivityStatus;
  priority?: ActivityPriority;
  context?: ActivityContext;
  parentId?: string;
  clientEntityId?: string;
  deadline?: string;
  startDate?: string;
  recurrenceRule?: string;
  tags?: string[];
  progress?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateActivityDto {
  name?: string;
  activityType?: ActivityType;
  description?: string | null;
  status?: ActivityStatus;
  priority?: ActivityPriority;
  context?: ActivityContext;
  parentId?: string | null;
  ownerEntityId?: string;
  clientEntityId?: string | null;
  deadline?: string | null;
  startDate?: string | null;
  recurrenceRule?: string | null;
  tags?: string[] | null;
  progress?: number | null;
  metadata?: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────────
// Labels & Colors
// ─────────────────────────────────────────────────────────────

export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  area: 'Сфера',
  business: 'Бизнес',
  direction: 'Направление',
  project: 'Проект',
  initiative: 'Инициатива',
  task: 'Задача',
  milestone: 'Веха',
  habit: 'Привычка',
  learning: 'Обучение',
  event_series: 'Серия событий',
};

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  draft: 'Черновик',
  idea: 'Идея',
  active: 'Активна',
  paused: 'Пауза',
  completed: 'Завершена',
  cancelled: 'Отменена',
  archived: 'В архиве',
};

export const ACTIVITY_PRIORITY_LABELS: Record<ActivityPriority, string> = {
  critical: 'Критический',
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
  none: 'Нет',
};

export const ACTIVITY_CONTEXT_LABELS: Record<ActivityContext, string> = {
  work: 'Работа',
  personal: 'Личное',
  any: 'Любой',
  location_based: 'По локации',
};

export const ACTIVITY_MEMBER_ROLE_LABELS: Record<ActivityMemberRole, string> = {
  owner: 'Владелец',
  member: 'Участник',
  observer: 'Наблюдатель',
  assignee: 'Исполнитель',
  reviewer: 'Ревьюер',
  client: 'Клиент',
  consultant: 'Консультант',
};

export const ACTIVITY_STATUS_COLORS: Record<ActivityStatus, string> = {
  draft: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  idea: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  active: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  paused: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  completed: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  cancelled: 'bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-400',
  archived: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

export const ACTIVITY_PRIORITY_COLORS: Record<ActivityPriority, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  medium: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  low: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
  none: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

export const ACTIVITY_TYPE_COLORS: Record<ActivityType, string> = {
  area: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  business: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  direction: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300',
  project: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  initiative: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  task: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  milestone: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  habit: 'bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300',
  learning: 'bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300',
  event_series: 'bg-rose-100 text-rose-700 dark:bg-rose-900 dark:text-rose-300',
};

// ─────────────────────────────────────────────────────────────
// Query Hooks
// ─────────────────────────────────────────────────────────────

export function useActivities(params: Ref<ActivityListParams>) {
  return useQuery({
    queryKey: ['activities', params],
    queryFn: async () => {
      const query: Record<string, string | number> = {};
      if (params.value.activityType) query.activityType = params.value.activityType;
      if (params.value.status) query.status = params.value.status;
      if (params.value.context) query.context = params.value.context;
      if (params.value.parentId) query.parentId = params.value.parentId;
      if (params.value.ownerEntityId) query.ownerEntityId = params.value.ownerEntityId;
      if (params.value.clientEntityId) query.clientEntityId = params.value.clientEntityId;
      if (params.value.search) query.search = params.value.search;
      if (params.value.limit) query.limit = params.value.limit;
      if (params.value.offset != null) query.offset = params.value.offset;

      return await $fetch<ActivityListResponse>('/api/activities', { query });
    },
  });
}

export function useActivity(id: Ref<string>) {
  return useQuery({
    queryKey: ['activities', id],
    queryFn: async () => {
      return await $fetch<Activity>(`/api/activities/${id.value}`);
    },
    enabled: () => !!id.value,
  });
}

export function useActivityTree(id: Ref<string>) {
  return useQuery({
    queryKey: ['activities', id, 'tree'],
    queryFn: async () => {
      return await $fetch<Activity>(`/api/activities/${id.value}/tree`);
    },
    enabled: () => !!id.value,
  });
}

export function useActivityMembers(id: Ref<string>) {
  return useQuery({
    queryKey: ['activities', id, 'members'],
    queryFn: async () => {
      return await $fetch<ActivityMember[]>(`/api/activities/${id.value}/members`);
    },
    enabled: () => !!id.value,
  });
}

// ─────────────────────────────────────────────────────────────
// Mutation Hooks
// ─────────────────────────────────────────────────────────────

export function useCreateActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (data: CreateActivityDto) => {
      return await $fetch<Activity>('/api/activities', {
        method: 'POST',
        body: data,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
  });
}

export function useUpdateActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: UpdateActivityDto }) => {
      return await $fetch<Activity>(`/api/activities/${id}`, {
        method: 'PATCH',
        body: data,
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      queryClient.invalidateQueries({ queryKey: ['activities', variables.id] });
    },
  });
}

export function useDeleteActivity() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      return await $fetch<{ id: string; status: string; message: string }>(`/api/activities/${id}`, {
        method: 'DELETE',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
  });
}

export function useAddActivityMembers() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ activityId, members }: {
      activityId: string;
      members: Array<{ entityId: string; role?: ActivityMemberRole; notes?: string }>;
    }) => {
      return await $fetch<{ added: number; skipped: number; members: ActivityMember[] }>(
        `/api/activities/${activityId}/members`,
        {
          method: 'POST',
          body: { members },
        },
      );
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['activities', variables.activityId, 'members'] });
      queryClient.invalidateQueries({ queryKey: ['activities', variables.activityId] });
    },
  });
}
