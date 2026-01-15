<script setup lang="ts">
import { MessageSquare, Calendar, Clock, ChevronLeft, ChevronRight } from 'lucide-vue-next';
import { useInteractions, type Interaction, type InteractionParticipant } from '~/composables/useInteractions';

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

// Get display name for a participant (displayName -> entity.name -> identifierValue)
function getParticipantName(p: InteractionParticipant): string {
  return p.displayName || p.entity?.name || p.identifierValue;
}

// Get non-self participants for display
function getOtherParticipants(interaction: Interaction): InteractionParticipant[] {
  return interaction.participants.filter(p => p.role !== 'self');
}

function getParticipantNames(interaction: Interaction): string {
  const others = getOtherParticipants(interaction);
  if (!others.length) return 'Нет участников';
  return others
    .map(p => getParticipantName(p))
    .slice(0, 3)
    .join(', ') + (others.length > 3 ? ` и ещё ${others.length - 3}` : '');
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

            <div class="flex items-center gap-3 text-sm text-muted-foreground">
              <!-- Participant avatars -->
              <div class="flex -space-x-2">
                <template v-for="(participant, idx) in getOtherParticipants(interaction).slice(0, 3)" :key="participant.id">
                  <div
                    class="w-8 h-8 rounded-full border-2 border-background overflow-hidden bg-muted flex items-center justify-center"
                    :title="getParticipantName(participant)"
                  >
                    <img
                      v-if="participant.entity?.profilePhoto"
                      :src="participant.entity.profilePhoto"
                      :alt="getParticipantName(participant)"
                      class="w-full h-full object-cover"
                    />
                    <span v-else class="text-xs font-medium text-muted-foreground">
                      {{ getParticipantName(participant).charAt(0).toUpperCase() }}
                    </span>
                  </div>
                </template>
                <div
                  v-if="getOtherParticipants(interaction).length > 3"
                  class="w-8 h-8 rounded-full border-2 border-background bg-muted flex items-center justify-center text-xs font-medium"
                >
                  +{{ getOtherParticipants(interaction).length - 3 }}
                </div>
              </div>
              <span>{{ getParticipantNames(interaction) }}</span>
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
