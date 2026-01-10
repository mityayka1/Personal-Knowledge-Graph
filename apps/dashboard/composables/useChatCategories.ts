import { useQuery } from '@tanstack/vue-query';

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

export function useChatCategoryStats() {
  return useQuery<ChatCategoryStats>({
    queryKey: ['chat-categories', 'stats'],
    queryFn: () => $fetch('/api/chat-categories/stats'),
  });
}

export function useGroupMembershipStats() {
  return useQuery<GroupMembershipStats>({
    queryKey: ['group-memberships', 'stats'],
    queryFn: () => $fetch('/api/group-memberships/stats'),
  });
}
