<script setup lang="ts">
import { HelpCircle, Check, X, User, Plus, Search, Link } from 'lucide-vue-next';
import { formatRelativeTime } from '~/lib/utils';
import { useDebounceFn } from '@vueuse/core';

definePageMeta({
  title: 'Связывание',
});

interface TelegramMetadata {
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  about?: string;
  isBot?: boolean;
  isVerified?: boolean;
  isPremium?: boolean;
  photoBase64?: string;
}

interface PendingResolution {
  id: string;
  identifierType: string;
  identifierValue: string;
  displayName?: string;
  metadata?: TelegramMetadata;
  status: 'pending' | 'resolved' | 'ignored';
  suggestions: Array<{
    entityId: string;
    name: string;
    confidence: number;
    reason?: string;
  }> | null;
  firstSeenAt: string;
  messageCount?: number;
}

interface Entity {
  id: string;
  type: string;
  name: string;
}

function getDisplayInfo(resolution: PendingResolution): string {
  if (resolution.displayName) return resolution.displayName;
  if (resolution.metadata) {
    const { firstName, lastName, username } = resolution.metadata;
    if (firstName || lastName) {
      return [firstName, lastName].filter(Boolean).join(' ');
    }
    if (username) return `@${username}`;
  }
  return resolution.identifierValue;
}

function formatMetadata(resolution: PendingResolution): string[] {
  const parts: string[] = [];
  if (!resolution.metadata) return parts;

  const m = resolution.metadata;
  if (m.username) parts.push(`@${m.username}`);
  if (m.phone) parts.push(m.phone);
  if (m.isBot) parts.push('Бот');
  if (m.isVerified) parts.push('Верифицирован');
  if (m.isPremium) parts.push('Premium');

  return parts;
}

function getInitials(resolution: PendingResolution): string {
  if (resolution.metadata) {
    const { firstName, lastName } = resolution.metadata;
    if (firstName || lastName) {
      return [firstName?.[0], lastName?.[0]].filter(Boolean).join('').toUpperCase();
    }
  }
  if (resolution.displayName) {
    const parts = resolution.displayName.split(' ');
    return parts.map(p => p[0]).slice(0, 2).join('').toUpperCase();
  }
  return '?';
}

function getAvatarColor(resolution: PendingResolution): string {
  const hash = resolution.identifierValue.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const colors = [
    'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
    'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300',
    'bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300',
    'bg-pink-100 text-pink-600 dark:bg-pink-900 dark:text-pink-300',
    'bg-indigo-100 text-indigo-600 dark:bg-indigo-900 dark:text-indigo-300',
    'bg-cyan-100 text-cyan-600 dark:bg-cyan-900 dark:text-cyan-300',
    'bg-orange-100 text-orange-600 dark:bg-orange-900 dark:text-orange-300',
    'bg-teal-100 text-teal-600 dark:bg-teal-900 dark:text-teal-300',
  ];
  return colors[hash % colors.length];
}

interface ResolutionListResponse {
  items: PendingResolution[];
  total: number;
}

const { data, pending, error, refresh } = useFetch<ResolutionListResponse>('/api/pending-resolutions', {
  query: { status: 'pending', limit: 50 },
});

// Entity search state
const searchingForResolutionId = ref<string | null>(null);
const entitySearchQuery = ref('');
const entitySearchResults = ref<Entity[]>([]);
const isSearchingEntities = ref(false);

const debouncedEntitySearch = useDebounceFn(async () => {
  if (!entitySearchQuery.value.trim() || entitySearchQuery.value.length < 2) {
    entitySearchResults.value = [];
    return;
  }

  isSearchingEntities.value = true;
  try {
    const response = await $fetch<{ items: Entity[] }>('/api/entities', {
      query: { search: entitySearchQuery.value, limit: 10 },
    });
    entitySearchResults.value = response.items || [];
  } catch (err) {
    console.error('Entity search failed:', err);
    entitySearchResults.value = [];
  } finally {
    isSearchingEntities.value = false;
  }
}, 300);

function openEntitySearch(resolutionId: string) {
  searchingForResolutionId.value = resolutionId;
  entitySearchQuery.value = '';
  entitySearchResults.value = [];
}

function closeEntitySearch() {
  searchingForResolutionId.value = null;
  entitySearchQuery.value = '';
  entitySearchResults.value = [];
}

function handleEntitySearchInput(event: Event) {
  const target = event.target as HTMLInputElement;
  entitySearchQuery.value = target.value;
  debouncedEntitySearch();
}

async function resolveToEntity(resolutionId: string, entityId: string) {
  try {
    await $fetch(`/api/pending-resolutions/${resolutionId}/resolve`, {
      method: 'POST',
      body: { entity_id: entityId },
    });
    closeEntitySearch();
    refresh();
  } catch (err) {
    console.error('Failed to resolve:', err);
  }
}

async function ignore(resolutionId: string) {
  if (!confirm('Вы уверены, что хотите игнорировать этот идентификатор?')) return;

  try {
    await $fetch(`/api/pending-resolutions/${resolutionId}/ignore`, {
      method: 'POST',
    });
    refresh();
  } catch (err) {
    console.error('Failed to ignore:', err);
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Связывание идентификаторов</h1>
      <p class="text-muted-foreground">Связать неизвестные идентификаторы с сущностями</p>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-destructive text-center py-8">
      Не удалось загрузить данные. Попробуйте ещё раз.
    </div>

    <!-- Loading state -->
    <div v-else-if="pending" class="space-y-4">
      <Card v-for="i in 3" :key="i">
        <CardContent class="p-4">
          <div class="flex items-center gap-4">
            <Skeleton class="h-10 w-10 rounded-full" />
            <div class="space-y-2 flex-1">
              <Skeleton class="h-4 w-1/3" />
              <Skeleton class="h-3 w-1/4" />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!data?.items.length"
      class="text-center py-12 text-muted-foreground"
    >
      <Check class="h-12 w-12 mx-auto mb-4 text-green-500" />
      <p class="text-lg font-medium text-foreground">Всё обработано!</p>
      <p>Нет ожидающих связывания идентификаторов</p>
    </div>

    <!-- Resolution list -->
    <div v-else class="space-y-4">
      <Card v-for="resolution in data.items" :key="resolution.id">
        <CardContent class="p-6">
          <div class="flex items-start gap-4">
            <!-- Avatar with photo or initials -->
            <div class="h-12 w-12 shrink-0">
              <img
                v-if="resolution.metadata?.photoBase64"
                :src="resolution.metadata.photoBase64"
                :alt="getDisplayInfo(resolution)"
                class="h-12 w-12 rounded-full object-cover"
              />
              <div
                v-else
                :class="[
                  'h-12 w-12 rounded-full flex items-center justify-center font-semibold text-lg',
                  getAvatarColor(resolution)
                ]"
              >
                {{ getInitials(resolution) }}
              </div>
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="font-medium text-lg">{{ getDisplayInfo(resolution) }}</span>
                <Badge variant="outline">{{ resolution.identifierType }}</Badge>
              </div>

              <!-- Additional metadata -->
              <div class="flex flex-wrap items-center gap-2 mb-2">
                <span class="text-sm text-muted-foreground font-mono">ID: {{ resolution.identifierValue }}</span>
                <Badge
                  v-for="tag in formatMetadata(resolution)"
                  :key="tag"
                  variant="secondary"
                  class="text-xs"
                >
                  {{ tag }}
                </Badge>
              </div>

              <p class="text-sm text-muted-foreground mb-4">
                Первое появление {{ formatRelativeTime(resolution.firstSeenAt) }}
                <span v-if="resolution.messageCount"> · {{ resolution.messageCount }} сообщений</span>
              </p>

              <!-- Suggestions -->
              <div v-if="resolution.suggestions?.length" class="space-y-2 mb-4">
                <p class="text-sm font-medium">Предложения:</p>
                <div class="flex flex-wrap gap-2">
                  <Button
                    v-for="suggestion in resolution.suggestions"
                    :key="suggestion.entityId"
                    variant="outline"
                    size="sm"
                    @click="resolveToEntity(resolution.id, suggestion.entityId)"
                  >
                    <User class="mr-2 h-4 w-4" />
                    {{ suggestion.name }}
                    <Badge variant="secondary" class="ml-2">
                      {{ Math.round(suggestion.confidence * 100) }}%
                    </Badge>
                  </Button>
                </div>
              </div>

              <!-- Entity search -->
              <div
                v-if="searchingForResolutionId === resolution.id"
                class="mb-4 p-4 rounded-lg border bg-muted/50"
              >
                <p class="text-sm font-medium mb-2">Поиск существующей сущности:</p>
                <div class="relative mb-2">
                  <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    placeholder="Введите имя для поиска..."
                    class="pl-10"
                    :value="entitySearchQuery"
                    @input="handleEntitySearchInput"
                    autofocus
                  />
                </div>

                <!-- Search results -->
                <div v-if="isSearchingEntities" class="py-2 text-sm text-muted-foreground">
                  Поиск...
                </div>
                <div
                  v-else-if="entitySearchResults.length"
                  class="max-h-48 overflow-y-auto space-y-1"
                >
                  <button
                    v-for="entity in entitySearchResults"
                    :key="entity.id"
                    class="w-full text-left px-3 py-2 rounded-md hover:bg-accent flex items-center gap-2 transition-colors"
                    @click="resolveToEntity(resolution.id, entity.id)"
                  >
                    <User class="h-4 w-4 text-muted-foreground shrink-0" />
                    <span class="font-medium">{{ entity.name }}</span>
                    <Badge variant="outline" class="ml-auto text-xs">{{ entity.type }}</Badge>
                  </button>
                </div>
                <div
                  v-else-if="entitySearchQuery.length >= 2"
                  class="py-2 text-sm text-muted-foreground"
                >
                  Ничего не найдено. Создайте новую сущность.
                </div>
                <div v-else class="py-2 text-sm text-muted-foreground">
                  Введите минимум 2 символа для поиска
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  class="mt-2"
                  @click="closeEntitySearch"
                >
                  Отмена
                </Button>
              </div>

              <!-- Actions -->
              <div class="flex flex-wrap gap-2">
                <Button
                  v-if="searchingForResolutionId !== resolution.id"
                  variant="outline"
                  size="sm"
                  @click="openEntitySearch(resolution.id)"
                >
                  <Link class="mr-2 h-4 w-4" />
                  Связать с существующей
                </Button>
                <NuxtLink :to="`/entities/new?identifier_type=${resolution.identifierType}&identifier_value=${resolution.identifierValue}&resolution_id=${resolution.id}`">
                  <Button size="sm">
                    <Plus class="mr-2 h-4 w-4" />
                    Создать сущность
                  </Button>
                </NuxtLink>
                <Button variant="ghost" size="sm" @click="ignore(resolution.id)">
                  <X class="mr-2 h-4 w-4" />
                  Игнорировать
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Stats -->
      <p class="text-sm text-muted-foreground text-center">
        Показано {{ data.items.length }} из {{ data.total }} ожидающих связывания
      </p>
    </div>
  </div>
</template>
