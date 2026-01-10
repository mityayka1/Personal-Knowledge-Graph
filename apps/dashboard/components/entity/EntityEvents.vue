<script setup lang="ts">
import {
  useEntityEventsByEntity,
  useCompleteEvent,
  useCancelEvent,
  getEventTypeInfo,
  getEventStatusInfo,
  type EntityEvent,
  type EventStatus,
} from '~/composables/useEntityEvents';

const props = defineProps<{
  entityId: string;
}>();

const entityIdRef = computed(() => props.entityId);
const { data: events, isLoading, error } = useEntityEventsByEntity(entityIdRef);

const completeEvent = useCompleteEvent();
const cancelEvent = useCancelEvent();

const filterStatus = ref<EventStatus | 'all'>('all');

const filteredEvents = computed(() => {
  if (!events.value) return [];
  if (filterStatus.value === 'all') return events.value;
  return events.value.filter((e) => e.status === filterStatus.value);
});

const scheduledEvents = computed(() =>
  events.value?.filter((e) => e.status === 'scheduled') || []
);

const pastEvents = computed(() =>
  events.value?.filter((e) => e.status !== 'scheduled') || []
);

function formatDate(dateString?: string): string {
  if (!dateString) return 'Без даты';
  const date = new Date(dateString);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isOverdue(event: EntityEvent): boolean {
  if (event.status !== 'scheduled' || !event.event_date) return false;
  return new Date(event.event_date) < new Date();
}

async function handleComplete(eventId: string) {
  await completeEvent.mutateAsync(eventId);
}

async function handleCancel(eventId: string) {
  await cancelEvent.mutateAsync(eventId);
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h3 class="text-lg font-semibold">События и договорённости</h3>
      <div class="flex gap-2">
        <button
          v-for="status in ['all', 'scheduled', 'completed', 'cancelled'] as const"
          :key="status"
          :class="[
            'px-3 py-1 text-xs rounded-full transition-colors',
            filterStatus === status
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted hover:bg-muted/80',
          ]"
          @click="filterStatus = status"
        >
          {{ status === 'all' ? 'Все' : getEventStatusInfo(status as EventStatus).label }}
        </button>
      </div>
    </div>

    <div v-if="isLoading" class="text-center py-8 text-muted-foreground">
      Загрузка событий...
    </div>

    <div v-else-if="error" class="text-center py-8 text-red-500">
      Ошибка загрузки событий
    </div>

    <div v-else-if="!filteredEvents.length" class="text-center py-8 text-muted-foreground">
      Нет событий
    </div>

    <div v-else class="space-y-3">
      <!-- Scheduled events first -->
      <div
        v-for="event in filteredEvents"
        :key="event.id"
        :class="[
          'p-4 rounded-lg border transition-all',
          event.status === 'cancelled' && 'opacity-50',
          isOverdue(event) && 'border-red-300 bg-red-50',
        ]"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="flex items-start gap-3">
            <span class="text-2xl">{{ getEventTypeInfo(event.event_type).icon }}</span>
            <div>
              <div class="flex items-center gap-2">
                <h4 :class="['font-medium', event.status === 'cancelled' && 'line-through']">
                  {{ event.title }}
                </h4>
                <span
                  :class="[
                    'px-2 py-0.5 text-xs rounded-full',
                    getEventTypeInfo(event.event_type).color,
                  ]"
                >
                  {{ getEventTypeInfo(event.event_type).label }}
                </span>
                <span
                  v-if="isOverdue(event)"
                  class="px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-800"
                >
                  Просрочено
                </span>
              </div>
              <p v-if="event.description" class="text-sm text-muted-foreground mt-1">
                {{ event.description }}
              </p>
              <div class="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                <span v-if="event.event_date">
                  {{ formatDate(event.event_date) }}
                </span>
                <span v-if="event.confidence" class="text-xs">
                  Уверенность: {{ Math.round(event.confidence * 100) }}%
                </span>
              </div>
              <p
                v-if="event.source_quote"
                class="text-xs text-muted-foreground mt-2 italic border-l-2 pl-2"
              >
                "{{ event.source_quote }}"
              </p>
            </div>
          </div>

          <div v-if="event.status === 'scheduled'" class="flex gap-2">
            <button
              class="px-3 py-1 text-xs bg-green-100 text-green-800 rounded hover:bg-green-200 transition-colors"
              :disabled="completeEvent.isPending.value"
              @click="handleComplete(event.id)"
            >
              Выполнено
            </button>
            <button
              class="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
              :disabled="cancelEvent.isPending.value"
              @click="handleCancel(event.id)"
            >
              Отменить
            </button>
          </div>
          <span
            v-else
            :class="['px-2 py-1 text-xs rounded', getEventStatusInfo(event.status).color]"
          >
            {{ getEventStatusInfo(event.status).label }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
