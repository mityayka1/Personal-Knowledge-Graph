import { useQuery } from '@tanstack/vue-query';
import type { Ref } from 'vue';

export interface TaskTypeStats {
  taskType: string;
  totalRuns: string;
  successfulRuns: string;
  totalTokensIn: string;
  totalTokensOut: string;
  totalCostUsd: string;
  avgDurationMs: string;
}

export interface ClaudeCliStats {
  period: 'day' | 'week' | 'month';
  startDate: string;
  byTaskType: TaskTypeStats[];
  totals: {
    totalRuns: string;
    totalCostUsd: string;
  };
}

export interface DailyStats {
  date: string;
  runs: string;
  costUsd: string;
}

export type StatsPeriod = 'day' | 'week' | 'month';

// Get Claude CLI stats for a period
export function useClaudeCliStats(period: Ref<StatsPeriod>) {
  return useQuery({
    queryKey: ['claude-cli-stats', period],
    queryFn: async () => {
      return await $fetch<ClaudeCliStats>('/api/claude-cli/stats', {
        query: { period: period.value },
      });
    },
    refetchInterval: 60000, // Refetch every minute
  });
}

// Get daily stats for chart
export function useClaudeCliDailyStats(days: Ref<number> = ref(30)) {
  return useQuery({
    queryKey: ['claude-cli-daily', days],
    queryFn: async () => {
      return await $fetch<DailyStats[]>('/api/claude-cli/daily', {
        query: { days: days.value },
      });
    },
  });
}

// Format task type for display
export function getTaskTypeLabel(taskType: string): string {
  const labels: Record<string, string> = {
    summarization: 'Суммаризация',
    profile_aggregation: 'Профили',
    context_synthesis: 'Контекст',
    fact_extraction: 'Извлечение фактов',
  };
  return labels[taskType] || taskType;
}

// Format cost for display
export function formatCost(cost: string | number | null | undefined): string {
  if (cost === null || cost === undefined) return '$0.00';
  const numCost = typeof cost === 'string' ? parseFloat(cost) : cost;
  if (isNaN(numCost)) return '$0.00';
  return `$${numCost.toFixed(2)}`;
}

// Format small cost (for per-task)
export function formatSmallCost(cost: string | number | null | undefined): string {
  if (cost === null || cost === undefined) return '$0.000';
  const numCost = typeof cost === 'string' ? parseFloat(cost) : cost;
  if (isNaN(numCost)) return '$0.000';
  return `$${numCost.toFixed(3)}`;
}
