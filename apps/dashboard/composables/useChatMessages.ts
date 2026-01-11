import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';

export interface MessageSender {
  id: string;
  name: string;
  type: 'person' | 'organization';
  profilePhoto?: string;
}

export interface MediaMetadata {
  id: string;
  accessHash: string;
  fileReference: string;
  dcId: number;
  sizes?: Array<{ type: string; width: number; height: number; size: number }>;
  mimeType?: string;
  size?: number;
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  hasThumb?: boolean;
}

export interface ChatMessage {
  id: string;
  content: string | null;
  timestamp: string;
  isOutgoing: boolean;
  mediaType?: string;
  mediaUrl?: string;
  mediaMetadata?: MediaMetadata;
  sourceMessageId?: string;
  senderIdentifierType: string;
  senderIdentifierValue: string;
  senderEntityId?: string;
  senderEntity?: MessageSender;
  topicId?: number;
  topicName?: string;
}

export interface ChatMessagesResponse {
  items: ChatMessage[];
  total: number;
  limit: number;
  offset: number;
}

export interface BackfillResult {
  total: number;
  updated: number;
  failed: number;
  errors: Array<{ chatId: string; error: string }>;
}

export function useChatMessages(
  telegramChatId: Ref<string>,
  params?: Ref<{ limit?: number; offset?: number; order?: 'ASC' | 'DESC' }>,
) {
  return useQuery<ChatMessagesResponse>({
    queryKey: ['chat-messages', telegramChatId, params],
    queryFn: () => {
      const query = new URLSearchParams();
      if (params?.value?.limit) query.set('limit', String(params.value.limit));
      if (params?.value?.offset) query.set('offset', String(params.value.offset));
      if (params?.value?.order) query.set('order', params.value.order);
      return $fetch(`/api/messages/chat/${telegramChatId.value}?${query.toString()}`);
    },
    enabled: computed(() => !!telegramChatId.value),
  });
}

export function useBackfillChats() {
  const queryClient = useQueryClient();

  return useMutation<BackfillResult, Error, { onlyMissingTitles?: boolean; limit?: number }>({
    mutationFn: async ({ onlyMissingTitles = true, limit }) => {
      const query = new URLSearchParams();
      if (!onlyMissingTitles) query.set('onlyMissingTitles', 'false');
      if (limit) query.set('limit', String(limit));
      return $fetch(`/api/chat-categories/backfill?${query.toString()}`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-categories'] });
    },
  });
}

export function useRefreshChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (telegramChatId: string) => {
      return $fetch(`/api/chat-categories/${telegramChatId}/refresh`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-categories'] });
    },
  });
}
