<script setup lang="ts">
import { Download, RefreshCw, CheckCircle, XCircle, Loader2 } from 'lucide-vue-next';

definePageMeta({
  title: 'Импорт',
});

interface ImportProgress {
  status: 'idle' | 'running' | 'completed' | 'error';
  totalDialogs: number;
  processedDialogs: number;
  currentDialog?: string;
  totalMessages: number;
  processedMessages: number;
  errors: string[];
  startedAt?: string;
  completedAt?: string;
}

const progress = ref<ImportProgress>({
  status: 'idle',
  totalDialogs: 0,
  processedDialogs: 0,
  totalMessages: 0,
  processedMessages: 0,
  errors: [],
});

const isLoading = ref(false);
const error = ref<string | null>(null);
const limitPerDialog = ref(1000);

// Poll status while importing
let pollInterval: ReturnType<typeof setInterval> | null = null;

function startPolling() {
  if (!pollInterval) {
    pollInterval = setInterval(fetchStatus, 2000);
  }
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Fetch status on mount and start polling if needed
onMounted(async () => {
  await fetchStatus();
  if (progress.value.status === 'running') {
    startPolling();
  }
});

watch(
  () => progress.value.status,
  (status) => {
    if (status === 'running') {
      startPolling();
    } else {
      stopPolling();
    }
  },
);

onUnmounted(() => {
  stopPolling();
});

async function fetchStatus() {
  try {
    const data = await $fetch<ImportProgress>('/api/telegram/import/status');
    progress.value = data;
  } catch (err) {
    console.error('Failed to fetch import status:', err);
  }
}

async function startImport() {
  isLoading.value = true;
  error.value = null;

  try {
    const response = await $fetch<{ message: string; progress: ImportProgress }>(
      '/api/telegram/import/start',
      {
        method: 'POST',
        body: { limitPerDialog: limitPerDialog.value },
      },
    );
    progress.value = response.progress;
  } catch (err: unknown) {
    const fetchError = err as { statusCode?: number; message?: string };
    error.value = fetchError.message || 'Не удалось запустить импорт';
  } finally {
    isLoading.value = false;
  }
}

function formatDuration(start?: string, end?: string): string {
  if (!start) return '-';
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : new Date();
  const seconds = Math.round((endDate.getTime() - startDate.getTime()) / 1000);

  if (seconds < 60) return `${seconds} сек`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин ${seconds % 60} сек`;
  return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}

function getProgressPercent(): number {
  if (progress.value.totalDialogs === 0) return 0;
  return Math.round((progress.value.processedDialogs / progress.value.totalDialogs) * 100);
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Импорт истории Telegram</h1>
      <p class="text-muted-foreground">Выгрузка истории сообщений из всех личных чатов</p>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Control panel -->
      <Card>
        <CardHeader>
          <CardTitle>Управление</CardTitle>
          <CardDescription>
            Импорт выгрузит историю сообщений из всех личных чатов Telegram
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <label class="text-sm font-medium">Лимит сообщений на диалог</label>
            <Input
              v-model.number="limitPerDialog"
              type="number"
              :min="100"
              :max="10000"
              :disabled="progress.status === 'running'"
            />
            <p class="text-xs text-muted-foreground">
              Максимальное количество сообщений для выгрузки из каждого диалога
            </p>
          </div>

          <div v-if="error" class="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {{ error }}
          </div>

          <Button
            class="w-full"
            :disabled="progress.status === 'running' || isLoading"
            @click="startImport"
          >
            <Loader2 v-if="isLoading" class="mr-2 h-4 w-4 animate-spin" />
            <Download v-else class="mr-2 h-4 w-4" />
            {{ progress.status === 'running' ? 'Импорт в процессе...' : 'Запустить импорт' }}
          </Button>

          <Button variant="outline" class="w-full" @click="fetchStatus">
            <RefreshCw class="mr-2 h-4 w-4" />
            Обновить статус
          </Button>
        </CardContent>
      </Card>

      <!-- Progress -->
      <Card>
        <CardHeader>
          <CardTitle>Прогресс</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Status badge -->
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">Статус:</span>
            <Badge
              :variant="
                progress.status === 'completed'
                  ? 'default'
                  : progress.status === 'running'
                    ? 'secondary'
                    : progress.status === 'error'
                      ? 'destructive'
                      : 'outline'
              "
            >
              <CheckCircle v-if="progress.status === 'completed'" class="mr-1 h-3 w-3" />
              <Loader2 v-else-if="progress.status === 'running'" class="mr-1 h-3 w-3 animate-spin" />
              <XCircle v-else-if="progress.status === 'error'" class="mr-1 h-3 w-3" />
              {{
                progress.status === 'idle'
                  ? 'Ожидание'
                  : progress.status === 'running'
                    ? 'Выполняется'
                    : progress.status === 'completed'
                      ? 'Завершено'
                      : 'Ошибка'
              }}
            </Badge>
          </div>

          <!-- Progress bar -->
          <div v-if="progress.status !== 'idle'" class="space-y-2">
            <div class="flex justify-between text-sm">
              <span>Диалоги</span>
              <span>{{ progress.processedDialogs }} / {{ progress.totalDialogs }}</span>
            </div>
            <div class="h-2 bg-muted rounded-full overflow-hidden">
              <div
                class="h-full bg-primary transition-all duration-300"
                :style="{ width: `${getProgressPercent()}%` }"
              />
            </div>
          </div>

          <!-- Stats -->
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span class="text-muted-foreground">Сообщений:</span>
              <span class="ml-2 font-medium">{{ progress.processedMessages }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Время:</span>
              <span class="ml-2 font-medium">
                {{ formatDuration(progress.startedAt, progress.completedAt) }}
              </span>
            </div>
            <div v-if="progress.currentDialog">
              <span class="text-muted-foreground">Текущий диалог:</span>
              <span class="ml-2 font-mono text-xs">{{ progress.currentDialog }}</span>
            </div>
          </div>

          <!-- Errors -->
          <div v-if="progress.errors.length" class="space-y-2">
            <p class="text-sm font-medium text-destructive">Ошибки ({{ progress.errors.length }}):</p>
            <div class="max-h-32 overflow-y-auto space-y-1">
              <p
                v-for="(err, index) in progress.errors"
                :key="index"
                class="text-xs text-muted-foreground"
              >
                {{ err }}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
