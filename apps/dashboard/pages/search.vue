<script setup lang="ts">
import { Search as SearchIcon, MessageSquare, User, Users, Info } from 'lucide-vue-next';
import { useDebounceFn } from '@vueuse/core';
import { formatDateTime, truncate } from '~/lib/utils';

definePageMeta({
  title: 'Поиск',
});

interface Participant {
  displayName?: string;
  identifierValue?: string;
  entityId?: string;
  entityName?: string;
}

interface SearchResult {
  type: 'message' | 'segment' | 'summary';
  id: string;
  content: string;
  timestamp: string;
  entity?: { id: string; name: string };
  interactionId: string;
  interaction?: {
    type: string;
    participants: Participant[];
  };
  score: number;
  highlight?: string;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  searchType: string;
}

const query = ref('');
const searchType = ref<'hybrid' | 'fts' | 'vector'>('hybrid');
const results = ref<SearchResult[]>([]);
const isSearching = ref(false);
const hasSearched = ref(false);
const error = ref<string | null>(null);

const debouncedSearch = useDebounceFn(search, 500);

function getParticipantName(p: Participant): string {
  return p.entityName || p.displayName || p.identifierValue || 'Неизвестный';
}

function getParticipantsDisplay(participants?: Participant[]): string {
  if (!participants || participants.length === 0) return 'Нет участников';
  const names = participants.map(getParticipantName);
  if (names.length <= 2) return names.join(' и ');
  return `${names.slice(0, 2).join(', ')} и ещё ${names.length - 2}`;
}

function getScoreTooltip(score: number): string {
  const percent = (score * 100).toFixed(1);
  if (searchType.value === 'hybrid') {
    return `Комбинированный рейтинг: ${percent}%\nОснован на Reciprocal Rank Fusion (RRF) - чем выше позиция в текстовом и семантическом поиске, тем выше итоговый рейтинг`;
  }
  if (searchType.value === 'fts') {
    return `Релевантность текста: ${percent}%\nОценка основана на частоте совпадения слов запроса в тексте сообщения`;
  }
  return `Семантическое сходство: ${percent}%\nОценка основана на близости смысла между запросом и сообщением с использованием AI-эмбеддингов`;
}

function highlightContent(content: string): string {
  // Remove HTML tags like <b> from highlight and convert to proper format
  if (!content) return '';
  return content.replace(/<b>/g, '**').replace(/<\/b>/g, '**');
}

async function search() {
  if (!query.value.trim()) {
    results.value = [];
    hasSearched.value = false;
    return;
  }

  isSearching.value = true;
  error.value = null;
  hasSearched.value = true;

  try {
    const response = await $fetch<SearchResponse>('/api/search', {
      method: 'POST',
      body: {
        query: query.value,
        searchType: searchType.value,
        limit: 50,
      },
    });
    results.value = response.results;
  } catch (err) {
    error.value = 'Ошибка поиска. Попробуйте ещё раз.';
    console.error(err);
  } finally {
    isSearching.value = false;
  }
}

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement;
  query.value = target.value;
  debouncedSearch();
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Поиск</h1>
      <p class="text-muted-foreground">Поиск по всем сообщениям и взаимодействиям</p>
    </div>

    <!-- Search input -->
    <div class="flex flex-col sm:flex-row gap-4 mb-6">
      <div class="relative flex-1">
        <SearchIcon class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Поиск сообщений..."
          class="pl-10"
          :value="query"
          @input="handleInput"
          @keyup.enter="search"
        />
      </div>
      <div class="flex gap-2">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                :variant="searchType === 'hybrid' ? 'default' : 'outline'"
                size="sm"
                @click="searchType = 'hybrid'; search()"
              >
                Гибридный
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p class="max-w-xs">Комбинация текстового и семантического поиска. Лучше всего подходит для большинства запросов.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                :variant="searchType === 'fts' ? 'default' : 'outline'"
                size="sm"
                @click="searchType = 'fts'; search()"
              >
                Текстовый
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p class="max-w-xs">Полнотекстовый поиск по точному совпадению слов. Хорош для поиска конкретных терминов.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                :variant="searchType === 'vector' ? 'default' : 'outline'"
                size="sm"
                @click="searchType = 'vector'; search()"
              >
                Семантический
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p class="max-w-xs">Поиск по смыслу с использованием AI. Найдёт связанные темы, даже если слова отличаются.</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-destructive text-center py-8">
      {{ error }}
    </div>

    <!-- Loading state -->
    <div v-else-if="isSearching" class="space-y-4">
      <Card v-for="i in 5" :key="i">
        <CardContent class="p-4">
          <div class="space-y-2">
            <Skeleton class="h-4 w-3/4" />
            <Skeleton class="h-3 w-1/2" />
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="hasSearched && !results.length"
      class="text-center py-12 text-muted-foreground"
    >
      <SearchIcon class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>По запросу "{{ query }}" ничего не найдено</p>
      <p class="text-sm">Попробуйте другой запрос или тип поиска</p>
    </div>

    <!-- Initial state -->
    <div
      v-else-if="!hasSearched"
      class="text-center py-12 text-muted-foreground"
    >
      <SearchIcon class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>Введите поисковый запрос</p>
      <p class="text-sm mt-2">
        <strong>Гибридный:</strong> Комбинация текстового и семантического поиска<br>
        <strong>Текстовый:</strong> Полнотекстовый поиск<br>
        <strong>Семантический:</strong> Поиск по смыслу с помощью ИИ
      </p>
    </div>

    <!-- Results -->
    <div v-else class="space-y-2">
      <p class="text-sm text-muted-foreground mb-4">
        Найдено {{ results.length }} результатов ({{ searchType === 'hybrid' ? 'гибридный' : searchType === 'fts' ? 'текстовый' : 'семантический' }} поиск)
      </p>

      <Card
        v-for="result in results"
        :key="result.id"
        class="hover:bg-accent/50 transition-colors"
      >
        <CardContent class="p-4">
          <div class="flex items-start gap-4">
            <div class="h-10 w-10 rounded-full bg-muted flex items-center justify-center shrink-0">
              <MessageSquare class="h-5 w-5 text-muted-foreground" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2 mb-1">
                <Badge variant="outline" class="text-xs">{{ result.type === 'message' ? 'сообщение' : result.type === 'segment' ? 'сегмент' : 'саммари' }}</Badge>
                <span class="text-xs text-muted-foreground">
                  {{ formatDateTime(result.timestamp) }}
                </span>
                <TooltipProvider v-if="result.score">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <Badge variant="secondary" class="text-xs cursor-help">
                        {{ (result.score * 100).toFixed(1) }}%
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p class="max-w-xs whitespace-pre-line">{{ getScoreTooltip(result.score) }}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>

              <p class="text-sm" v-html="highlightContent(result.highlight || truncate(result.content, 200))" />

              <!-- Interaction info -->
              <div class="flex flex-wrap items-center gap-3 mt-2 text-xs text-muted-foreground">
                <div v-if="result.interaction?.participants?.length" class="flex items-center gap-1">
                  <Users class="h-3 w-3" />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <span class="cursor-help">{{ getParticipantsDisplay(result.interaction.participants) }}</span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p class="font-medium mb-1">Участники чата:</p>
                        <ul class="list-disc list-inside">
                          <li v-for="(p, idx) in result.interaction.participants" :key="idx">
                            {{ getParticipantName(p) }}
                          </li>
                        </ul>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <NuxtLink
                  :to="`/interactions/${result.interactionId}`"
                  class="hover:underline text-primary"
                >
                  Открыть диалог →
                </NuxtLink>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
