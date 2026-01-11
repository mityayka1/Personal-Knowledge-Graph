<script setup lang="ts">
import { Bot, TrendingUp, Zap } from 'lucide-vue-next';
import {
  useClaudeCliStats,
  getTaskTypeLabel,
  formatCost,
  formatSmallCost,
  type StatsPeriod,
} from '~/composables/useClaudeCliStats';

const period = ref<StatsPeriod>('month');
const { data: stats, isLoading, error } = useClaudeCliStats(period);

const periodOptions = [
  { value: 'day', label: 'День' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
];
</script>

<template>
  <Card>
    <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle class="text-sm font-medium flex items-center gap-2">
        <Bot class="h-4 w-4" />
        Claude CLI Затраты
      </CardTitle>
      <select
        v-model="period"
        class="text-xs border rounded px-2 py-1 bg-background"
      >
        <option v-for="opt in periodOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
    </CardHeader>
    <CardContent>
      <div v-if="isLoading" class="flex items-center justify-center h-32">
        <div class="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
      </div>

      <div v-else-if="error" class="text-sm text-red-500">
        Ошибка загрузки данных
      </div>

      <div v-else>
        <!-- Total Stats -->
        <div class="grid grid-cols-2 gap-4 mb-4">
          <div>
            <p class="text-xs text-muted-foreground">Затраты</p>
            <p class="text-2xl font-bold">{{ formatCost(stats?.totals?.totalCostUsd) }}</p>
          </div>
          <div>
            <p class="text-xs text-muted-foreground">Запусков</p>
            <p class="text-2xl font-bold">{{ stats?.totals?.totalRuns || 0 }}</p>
          </div>
        </div>

        <!-- By Task Type -->
        <div v-if="stats?.byTaskType?.length" class="border-t pt-3">
          <p class="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
            <Zap class="h-3 w-3" />
            По типам задач
          </p>
          <div class="space-y-1.5">
            <div
              v-for="task in stats.byTaskType"
              :key="task.taskType"
              class="flex justify-between items-center text-sm"
            >
              <div class="flex items-center gap-2">
                <span class="text-muted-foreground">{{ getTaskTypeLabel(task.taskType) }}</span>
                <Badge variant="outline" class="text-[10px] px-1 py-0">
                  {{ task.totalRuns }}
                </Badge>
              </div>
              <span class="font-medium">{{ formatSmallCost(task.totalCostUsd) }}</span>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div v-else class="text-center py-4 text-muted-foreground text-sm">
          <TrendingUp class="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p>Нет данных за выбранный период</p>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
