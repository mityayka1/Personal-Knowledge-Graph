<script setup lang="ts">
import { MessageSquare, Calendar, Users, Clock, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { useInteractions, type Interaction } from '~/composables/useInteractions';

definePageMeta({
  title: 'Взаимодействия',
});

const limit = ref(20);
const offset = ref(0);

const params = computed(() => ({
  limit: limit.value,
  offset: offset.value,
}));

const { data, isLoading, error } = useInteractions(params);

const currentPage = computed(() => Math.floor(offset.value / limit.value) + 1);
const totalPages = computed(() => data.value ? Math.ceil(data.value.total / limit.value) : 0);

function nextPage() {
  if (data.value && offset.value + limit.value < data.value.total) {
    offset.value += limit.value;
  }
}

function prevPage() {
  if (offset.value > 0) {
    offset.value = Math.max(0, offset.value - limit.value);
  }
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(start: string, end?: string): string {
  if (!end) return 'активно';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}ч ${minutes % 60}м`;
  }
  return `${minutes}м`;
}

function getTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    telegram_session: 'Telegram',
    phone_call: 'Звонок',
    video_meeting: 'Видео-встреча',
  };
  return labels[type] || type;
}

function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    active: 'bg-green-500/20 text-green-400',
    completed: 'bg-blue-500/20 text-blue-400',
    archived: 'bg-gray-500/20 text-gray-400',
  };
  return colors[status] || 'bg-gray-500/20 text-gray-400';
}

function getParticipantNames(interaction: Interaction): string {
  if (!interaction.participants.length) return 'Нет участников';
  return interaction.participants
    .map(p => p.displayName || p.identifierValue)
    .slice(0, 3)
    .join(', ') + (interaction.participants.length > 3 ? ` и ещё ${interaction.participants.length - 3}` : '');
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Взаимодействия</h1>
      <p class="text-muted-foreground">Просмотр сессий чатов и истории переписок</p>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="space-y-4">
      <div v-for="i in 5" :key="i" class="animate-pulse">
        <div class="h-24 bg-muted rounded-lg"></div>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="text-center py-12 text-destructive">
      <p>Ошибка загрузки: {{ error.message }}</p>
    </div>

    <!-- Empty -->
    <div v-else-if="!data?.items?.length" class="text-center py-12 text-muted-foreground">
      <MessageSquare class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>Нет взаимодействий</p>
      <p class="text-sm mt-2">Используйте Импорт Telegram для загрузки переписок</p>
    </div>

    <!-- List -->
    <div v-else class="space-y-4">
      <NuxtLink
        v-for="interaction in data.items"
        :key="interaction.id"
        :to="`/interactions/${interaction.id}`"
        class="block p-4 rounded-lg border bg-card hover:bg-accent transition-colors"
      >
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-2">
              <span
                class="px-2 py-0.5 rounded text-xs font-medium"
                :class="getStatusColor(interaction.status)"
              >
                {{ interaction.status === 'active' ? 'Активно' : interaction.status === 'completed' ? 'Завершено' : 'Архив' }}
              </span>
              <span class="text-sm text-muted-foreground">
                {{ getTypeLabel(interaction.type) }}
              </span>
            </div>

            <div class="flex items-center gap-4 text-sm text-muted-foreground">
              <span class="flex items-center gap-1">
                <Users class="h-4 w-4" />
                {{ getParticipantNames(interaction) }}
              </span>
            </div>
          </div>

          <div class="text-right text-sm text-muted-foreground">
            <div class="flex items-center gap-1 justify-end">
              <Calendar class="h-4 w-4" />
              {{ formatDate(interaction.startedAt) }}
            </div>
            <div class="flex items-center gap-1 justify-end mt-1">
              <Clock class="h-4 w-4" />
              {{ formatDuration(interaction.startedAt, interaction.endedAt) }}
            </div>
          </div>
        </div>
      </NuxtLink>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-between pt-4">
        <div class="text-sm text-muted-foreground">
          Показано {{ offset + 1 }}-{{ Math.min(offset + limit, data.total) }} из {{ data.total }}
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="offset === 0"
            @click="prevPage"
          >
            <ChevronLeft class="h-4 w-4" />
          </Button>
          <span class="text-sm">{{ currentPage }} / {{ totalPages }}</span>
          <Button
            variant="outline"
            size="sm"
            :disabled="offset + limit >= data.total"
            @click="nextPage"
          >
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
