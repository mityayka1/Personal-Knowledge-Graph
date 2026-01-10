<script setup lang="ts">
import {
  Users,
  MessageSquare,
  HelpCircle,
  CheckCircle,
  UserCircle,
  Building2,
  MessagesSquare,
  Calendar,
  AlertTriangle,
} from 'lucide-vue-next';
import { useChatCategoryStats, useGroupMembershipStats } from '~/composables/useChatCategories';
import {
  useEventStats,
  useUpcomingEvents,
  useOverdueEvents,
  getEventTypeInfo,
  useCompleteEvent,
} from '~/composables/useEntityEvents';

definePageMeta({
  title: 'Главная',
});

// Fetch stats
const { data: entities } = useEntities(ref({ limit: 1 }));
const { data: interactions } = useInteractions(ref({ limit: 1 }));
const { data: categoryStats } = useChatCategoryStats();
const { data: membershipStats } = useGroupMembershipStats();
const { data: eventStats } = useEventStats();
const { data: upcomingEvents } = useUpcomingEvents(5);
const { data: overdueEvents } = useOverdueEvents(5);

const completeEvent = useCompleteEvent();

function formatEventDate(dateString?: string): string {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Сегодня';
  if (diffDays === 1) return 'Завтра';
  if (diffDays === -1) return 'Вчера';
  if (diffDays < 0) return `${Math.abs(diffDays)} дн. назад`;
  if (diffDays <= 7) return `Через ${diffDays} дн.`;

  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

async function handleComplete(eventId: string) {
  await completeEvent.mutateAsync(eventId);
}
</script>

<template>
  <div>
    <h1 class="text-3xl font-bold tracking-tight mb-6">Главная</h1>

    <!-- Main Stats -->
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Сущности</CardTitle>
          <Users class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ entities?.total ?? '-' }}</div>
          <p class="text-xs text-muted-foreground">Люди и организации</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Взаимодействия</CardTitle>
          <MessageSquare class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ interactions?.total ?? '-' }}</div>
          <p class="text-xs text-muted-foreground">Сессии чатов</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">На связывание</CardTitle>
          <HelpCircle class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">-</div>
          <p class="text-xs text-muted-foreground">Ожидают связывания</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Факты на проверку</CardTitle>
          <CheckCircle class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">-</div>
          <p class="text-xs text-muted-foreground">Ожидают проверки</p>
        </CardContent>
      </Card>
    </div>

    <!-- Chat Categories -->
    <h2 class="text-xl font-semibold mb-4">Категории чатов</h2>
    <div class="grid gap-4 md:grid-cols-3 mb-8">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Личные</CardTitle>
          <UserCircle class="h-4 w-4 text-green-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ categoryStats?.personal ?? 0 }}</div>
          <p class="text-xs text-muted-foreground">Приватные чаты</p>
          <Badge variant="outline" class="mt-2 text-green-600">Auto-extraction</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Рабочие</CardTitle>
          <Building2 class="h-4 w-4 text-blue-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ categoryStats?.working ?? 0 }}</div>
          <p class="text-xs text-muted-foreground">Группы ≤20 человек</p>
          <Badge variant="outline" class="mt-2 text-blue-600">Auto-extraction</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Массовые</CardTitle>
          <MessagesSquare class="h-4 w-4 text-gray-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ categoryStats?.mass ?? 0 }}</div>
          <p class="text-xs text-muted-foreground">Группы &gt;20 человек</p>
          <Badge variant="outline" class="mt-2 text-gray-500">Manual import</Badge>
        </CardContent>
      </Card>
    </div>

    <!-- Group Memberships -->
    <h2 class="text-xl font-semibold mb-4">Членство в группах</h2>
    <div class="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Всего записей</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ membershipStats?.totalMemberships ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Активных</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold text-green-600">{{ membershipStats?.activeMemberships ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Уникальных чатов</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ membershipStats?.uniqueChats ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Уникальных юзеров</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ membershipStats?.uniqueUsers ?? 0 }}</div>
        </CardContent>
      </Card>
    </div>

    <!-- Entity Events -->
    <h2 class="text-xl font-semibold mb-4 mt-8">События и договорённости</h2>
    <div class="grid gap-4 md:grid-cols-4 mb-6">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Всего событий</CardTitle>
          <Calendar class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ eventStats?.total ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Запланировано</CardTitle>
          <Calendar class="h-4 w-4 text-blue-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold text-blue-600">{{ eventStats?.byStatus?.scheduled ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Предстоящие</CardTitle>
          <Calendar class="h-4 w-4 text-green-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold text-green-600">{{ eventStats?.upcoming ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Просрочено</CardTitle>
          <AlertTriangle class="h-4 w-4 text-red-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold text-red-600">{{ eventStats?.overdue ?? 0 }}</div>
        </CardContent>
      </Card>
    </div>

    <!-- Overdue Events -->
    <div v-if="overdueEvents?.length" class="mb-6">
      <h3 class="text-lg font-medium mb-3 text-red-600 flex items-center gap-2">
        <AlertTriangle class="h-5 w-5" />
        Просроченные события
      </h3>
      <div class="space-y-2">
        <Card
          v-for="event in overdueEvents"
          :key="event.id"
          class="border-red-200 bg-red-50"
        >
          <CardContent class="p-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-xl">{{ getEventTypeInfo(event.event_type).icon }}</span>
                <div>
                  <p class="font-medium">{{ event.title }}</p>
                  <p class="text-sm text-muted-foreground">
                    {{ formatEventDate(event.event_date) }}
                  </p>
                </div>
              </div>
              <button
                class="px-3 py-1 text-xs bg-green-100 text-green-800 rounded hover:bg-green-200 transition-colors"
                :disabled="completeEvent.isPending.value"
                @click="handleComplete(event.id)"
              >
                Выполнено
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- Upcoming Events -->
    <div v-if="upcomingEvents?.length">
      <h3 class="text-lg font-medium mb-3 flex items-center gap-2">
        <Calendar class="h-5 w-5 text-blue-500" />
        Ближайшие события
      </h3>
      <div class="space-y-2">
        <Card v-for="event in upcomingEvents" :key="event.id">
          <CardContent class="p-4">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-xl">{{ getEventTypeInfo(event.event_type).icon }}</span>
                <div>
                  <p class="font-medium">{{ event.title }}</p>
                  <div class="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>{{ formatEventDate(event.event_date) }}</span>
                    <span
                      :class="[
                        'px-2 py-0.5 text-xs rounded-full',
                        getEventTypeInfo(event.event_type).color,
                      ]"
                    >
                      {{ getEventTypeInfo(event.event_type).label }}
                    </span>
                  </div>
                </div>
              </div>
              <button
                class="px-3 py-1 text-xs bg-green-100 text-green-800 rounded hover:bg-green-200 transition-colors"
                :disabled="completeEvent.isPending.value"
                @click="handleComplete(event.id)"
              >
                Выполнено
              </button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </div>
</template>
