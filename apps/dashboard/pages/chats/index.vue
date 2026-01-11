<script setup lang="ts">
import { MessageSquare, Users, Briefcase, Radio, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-vue-next';
import {
  useChatCategories,
  useChatCategoryStats,
  useUpdateChatCategory,
  type ChatCategory,
  type ChatCategoryRecord,
} from '~/composables/useChatCategories';
import { useBackfillChats } from '~/composables/useChatMessages';

definePageMeta({
  title: 'Чаты',
});

const router = useRouter();

const limit = ref(20);
const offset = ref(0);
const categoryFilter = ref<ChatCategory | undefined>(undefined);

const params = computed(() => ({
  category: categoryFilter.value,
  limit: limit.value,
  offset: offset.value,
}));

const { data, isLoading, error, refetch } = useChatCategories(params);
const { data: stats, refetch: refetchStats } = useChatCategoryStats();
const updateMutation = useUpdateChatCategory();
const backfillMutation = useBackfillChats();

const currentPage = computed(() => Math.floor(offset.value / limit.value) + 1);
const totalPages = computed(() => data.value ? Math.ceil(data.value.total / limit.value) : 0);

// Count chats without titles
const chatsWithoutTitles = computed(() => {
  if (!data.value?.items) return 0;
  return data.value.items.filter(c => !c.title).length;
});

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

function setFilter(category: ChatCategory | undefined) {
  categoryFilter.value = category;
  offset.value = 0;
}

async function updateCategory(record: ChatCategoryRecord, newCategory: ChatCategory, event: Event) {
  event.preventDefault();
  event.stopPropagation();
  if (record.category === newCategory) return;

  await updateMutation.mutateAsync({
    telegramChatId: record.telegramChatId,
    category: newCategory,
  });
}

async function runBackfill() {
  await backfillMutation.mutateAsync({ onlyMissingTitles: true });
  refetch();
  refetchStats();
}

function getCategoryLabel(category: ChatCategory): string {
  const labels: Record<ChatCategory, string> = {
    personal: 'Личный',
    working: 'Рабочий',
    mass: 'Массовый',
  };
  return labels[category];
}

function getCategoryColor(category: ChatCategory): string {
  const colors: Record<ChatCategory, string> = {
    personal: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    working: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    mass: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  };
  return colors[category];
}

function getChatTypeIcon(telegramChatId: string) {
  if (telegramChatId.startsWith('channel_')) return Radio;
  return MessageSquare;
}

function getChatTypeLabel(telegramChatId: string): string {
  if (telegramChatId.startsWith('channel_')) return 'Канал';
  return 'Группа';
}

function formatChatDisplay(record: ChatCategoryRecord): string {
  if (record.title) {
    return record.title;
  }
  const parts = record.telegramChatId.split('_');
  const id = parts.length > 1 ? parts.slice(1).join('_') : record.telegramChatId;
  return `ID: ${id}`;
}

function navigateToChat(telegramChatId: string) {
  router.push(`/chats/${telegramChatId}`);
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Чаты</h1>
        <p class="text-muted-foreground">Управление категориями групповых чатов Telegram</p>
      </div>

      <!-- Backfill button -->
      <Button
        v-if="chatsWithoutTitles > 0 || backfillMutation.isPending.value"
        variant="outline"
        :disabled="backfillMutation.isPending.value"
        @click="runBackfill"
      >
        <RefreshCw class="h-4 w-4 mr-2" :class="{ 'animate-spin': backfillMutation.isPending.value }" />
        {{ backfillMutation.isPending.value ? 'Загрузка названий...' : 'Загрузить названия' }}
      </Button>
    </div>

    <!-- Backfill result -->
    <div
      v-if="backfillMutation.data.value"
      class="mb-4 p-3 rounded-lg bg-green-500/10 text-green-400 text-sm"
    >
      Обновлено {{ backfillMutation.data.value.updated }} из {{ backfillMutation.data.value.total }} чатов
      <span v-if="backfillMutation.data.value.failed > 0" class="text-amber-400">
        ({{ backfillMutation.data.value.failed }} ошибок)
      </span>
    </div>

    <!-- Stats cards -->
    <div v-if="stats" class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
      <Card
        class="cursor-pointer transition-colors"
        :class="categoryFilter === undefined ? 'ring-2 ring-primary' : 'hover:bg-accent'"
        @click="setFilter(undefined)"
      >
        <CardContent class="pt-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-muted-foreground">Всего</p>
              <p class="text-2xl font-bold">{{ stats.total }}</p>
            </div>
            <MessageSquare class="h-8 w-8 text-muted-foreground" />
          </div>
        </CardContent>
      </Card>

      <Card
        class="cursor-pointer transition-colors"
        :class="categoryFilter === 'personal' ? 'ring-2 ring-blue-500' : 'hover:bg-accent'"
        @click="setFilter('personal')"
      >
        <CardContent class="pt-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-muted-foreground">Личные</p>
              <p class="text-2xl font-bold text-blue-400">{{ stats.personal }}</p>
            </div>
            <Users class="h-8 w-8 text-blue-400" />
          </div>
        </CardContent>
      </Card>

      <Card
        class="cursor-pointer transition-colors"
        :class="categoryFilter === 'working' ? 'ring-2 ring-amber-500' : 'hover:bg-accent'"
        @click="setFilter('working')"
      >
        <CardContent class="pt-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-muted-foreground">Рабочие</p>
              <p class="text-2xl font-bold text-amber-400">{{ stats.working }}</p>
            </div>
            <Briefcase class="h-8 w-8 text-amber-400" />
          </div>
        </CardContent>
      </Card>

      <Card
        class="cursor-pointer transition-colors"
        :class="categoryFilter === 'mass' ? 'ring-2 ring-gray-500' : 'hover:bg-accent'"
        @click="setFilter('mass')"
      >
        <CardContent class="pt-6">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-muted-foreground">Массовые</p>
              <p class="text-2xl font-bold text-gray-400">{{ stats.mass }}</p>
            </div>
            <Radio class="h-8 w-8 text-gray-400" />
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="space-y-4">
      <div v-for="i in 5" :key="i" class="animate-pulse">
        <div class="h-20 bg-muted rounded-lg"></div>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="text-center py-12 text-destructive">
      <p>Ошибка загрузки: {{ error.message }}</p>
    </div>

    <!-- Empty -->
    <div v-else-if="!data?.items?.length" class="text-center py-12 text-muted-foreground">
      <MessageSquare class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>Нет групповых чатов</p>
      <p class="text-sm mt-2">Импортируйте историю Telegram для загрузки чатов</p>
    </div>

    <!-- List -->
    <div v-else class="space-y-3">
      <div
        v-for="record in data.items"
        :key="record.id"
        class="block p-4 rounded-lg border bg-card hover:bg-accent transition-colors cursor-pointer"
        @click="navigateToChat(record.telegramChatId)"
      >
        <div class="flex items-center justify-between gap-4">
          <!-- Left: Chat info -->
          <div class="flex items-center gap-3 flex-1 min-w-0">
            <component
              :is="getChatTypeIcon(record.telegramChatId)"
              class="h-5 w-5 text-muted-foreground flex-shrink-0"
            />
            <div class="min-w-0">
              <div class="font-medium truncate">{{ formatChatDisplay(record) }}</div>
              <div class="flex items-center gap-3 text-sm text-muted-foreground">
                <span>{{ getChatTypeLabel(record.telegramChatId) }}</span>
                <span v-if="record.participantsCount" class="flex items-center gap-1">
                  <Users class="h-3 w-3" />
                  {{ record.participantsCount }}
                </span>
              </div>
            </div>
          </div>

          <!-- Right: Category badge + select -->
          <div class="flex items-center gap-3 flex-shrink-0" @click.stop>
            <span
              class="px-2 py-1 rounded text-xs font-medium border whitespace-nowrap"
              :class="getCategoryColor(record.category)"
            >
              {{ getCategoryLabel(record.category) }}
            </span>

            <select
              :value="record.category"
              :disabled="updateMutation.isPending.value"
              class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              @click.stop
              @mousedown.stop
              @change="updateCategory(record, ($event.target as HTMLSelectElement).value as ChatCategory, $event)"
            >
              <option value="personal">Личный</option>
              <option value="working">Рабочий</option>
              <option value="mass">Массовый</option>
            </select>
          </div>
        </div>
      </div>

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

    <!-- Help -->
    <Card class="mt-6">
      <CardHeader>
        <CardTitle class="text-base">Категории групповых чатов</CardTitle>
      </CardHeader>
      <CardContent class="text-sm text-muted-foreground space-y-2">
        <p>
          <strong class="text-blue-400">Личные:</strong> Группы друзей, семьи, хобби.
          Создаются Entity для участников, извлекаются факты, генерируется контекст.
        </p>
        <p>
          <strong class="text-amber-400">Рабочие:</strong> Рабочие группы и проектные чаты.
          Создаются Entity для участников, извлекаются факты, генерируется контекст.
        </p>
        <p>
          <strong class="text-gray-400">Массовые:</strong> Каналы, новостные группы, большие сообщества.
          Entity не создаются, сообщения архивируются без обработки.
        </p>
        <p class="pt-2 border-t">
          <strong>Примечание:</strong> Группы до 20 участников автоматически помечаются как «Рабочие».
          Если это группа друзей или хобби, измените категорию на «Личные» или «Массовые».
        </p>
      </CardContent>
    </Card>
  </div>
</template>
