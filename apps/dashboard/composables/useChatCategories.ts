import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';

export type ChatCategory = 'personal' | 'working' | 'mass';

export interface ChatCategoryRecord {
  id: string;
  telegramChatId: string;
  category: ChatCategory;
  participantsCount: number | null;
  title: string | null;
  isForum: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatCategoriesResponse {
  items: ChatCategoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface ChatCategoryStats {
  total: number;
  byCategory: Record<string, number>;
  personal: number;
  working: number;
  mass: number;
}

export interface GroupMembershipStats {
  totalMemberships: number;
  activeMemberships: number;
  uniqueChats: number;
  uniqueUsers: number;
}

export function useChatCategories(params: Ref<{ category?: ChatCategory; limit?: number; offset?: number }>) {
  return useQuery<ChatCategoriesResponse>({
    queryKey: ['chat-categories', params],
    queryFn: () => {
      const query = new URLSearchParams();
      if (params.value.category) query.set('category', params.value.category);
      if (params.value.limit) query.set('limit', String(params.value.limit));
      if (params.value.offset) query.set('offset', String(params.value.offset));
      return $fetch(`/api/chat-categories?${query.toString()}`);
    },
  });
}

export function useUpdateChatCategory() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ telegramChatId, category }: { telegramChatId: string; category: ChatCategory }) => {
      return $fetch<ChatCategoryRecord>(`/api/chat-categories/${telegramChatId}`, {
        method: 'PUT',
        body: { category },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-categories'] });
    },
  });
}

export function useChatCategoryStats() {
  return useQuery<ChatCategoryStats>({
    queryKey: ['chat-categories', 'stats'],
    queryFn: () => $fetch('/api/chat-categories/stats'),
  });
}

export function useChatCategory(telegramChatId: Ref<string>) {
  return useQuery<ChatCategoryRecord>({
    queryKey: ['chat-category', telegramChatId],
    queryFn: () => $fetch(`/api/chat-categories/${telegramChatId.value}`),
    enabled: computed(() => !!telegramChatId.value),
  });
}

export function useGroupMembershipStats() {
  return useQuery<GroupMembershipStats>({
    queryKey: ['group-memberships', 'stats'],
    queryFn: () => $fetch('/api/group-memberships/stats'),
  });
}
