import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';
import type { Ref } from 'vue';

export interface SummaryData {
  id: string;
  summaryText: string;
  keyPoints: string[];
  tone: string | null;
  messageCount: number | null;
  compressionRatio: number | null;
  createdAt: string;
}

export interface SummarizationStatus {
  interactionId: string;
  hasSummary: boolean;
  summary?: SummaryData;
}

export interface TriggerResult {
  success: boolean;
  summaryId?: string;
  message: string;
}

export interface BatchTriggerResult {
  triggered: number;
  skipped: number;
  results: Array<{ id: string; status: string }>;
}

/**
 * Get summarization status for an interaction
 */
export function useSummarizationStatus(interactionId: Ref<string | null>) {
  return useQuery({
    queryKey: ['summarization-status', interactionId],
    queryFn: async () => {
      if (!interactionId.value) return null;
      return await $fetch<SummarizationStatus>(
        `/api/summarization/status/${interactionId.value}`
      );
    },
    enabled: computed(() => !!interactionId.value),
  });
}

/**
 * Get summary by interaction ID
 */
export function useSummary(interactionId: Ref<string | null>) {
  return useQuery({
    queryKey: ['summary', interactionId],
    queryFn: async () => {
      if (!interactionId.value) return null;
      try {
        return await $fetch<SummaryData>(
          `/api/summarization/interaction/${interactionId.value}`
        );
      } catch (error: any) {
        if (error?.statusCode === 404) return null;
        throw error;
      }
    },
    enabled: computed(() => !!interactionId.value),
  });
}

/**
 * Trigger summarization for a single interaction
 */
export function useTriggerSummarization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (interactionId: string) => {
      return await $fetch<TriggerResult>(
        `/api/summarization/trigger/${interactionId}`,
        { method: 'POST' }
      );
    },
    onSuccess: (_, interactionId) => {
      queryClient.invalidateQueries({
        queryKey: ['summarization-status', interactionId],
      });
      queryClient.invalidateQueries({
        queryKey: ['summary', interactionId],
      });
      queryClient.invalidateQueries({
        queryKey: ['interaction', interactionId],
      });
    },
  });
}

/**
 * Trigger summarization for multiple interactions
 */
export function useTriggerBatchSummarization() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (interactionIds: string[]) => {
      return await $fetch<BatchTriggerResult>('/api/summarization/trigger-batch', {
        method: 'POST',
        body: { interactionIds },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['summarization-status'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
      queryClient.invalidateQueries({ queryKey: ['interactions'] });
    },
  });
}

/**
 * Format tone for display
 */
export function getToneInfo(tone: string | null): { label: string; color: string } {
  const tones: Record<string, { label: string; color: string }> = {
    positive: { label: 'Позитивный', color: 'bg-green-100 text-green-800' },
    negative: { label: 'Негативный', color: 'bg-red-100 text-red-800' },
    neutral: { label: 'Нейтральный', color: 'bg-gray-100 text-gray-800' },
    formal: { label: 'Формальный', color: 'bg-blue-100 text-blue-800' },
    informal: { label: 'Неформальный', color: 'bg-purple-100 text-purple-800' },
  };

  return tones[tone || ''] || { label: tone || 'Неизвестно', color: 'bg-gray-100 text-gray-800' };
}
