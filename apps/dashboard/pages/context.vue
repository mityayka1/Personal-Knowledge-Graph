<script setup lang="ts">
import { Sparkles, Search, User, Building2, X } from 'lucide-vue-next';
import { useDebounceFn } from '@vueuse/core';
import { useEntities, type Entity } from '~/composables/useEntities';

definePageMeta({
  title: 'Контекст',
});

const entitySearch = ref('');
const selectedEntity = ref<Entity | null>(null);
const taskHint = ref('');
const contextResult = ref<string | null>(null);
const isGenerating = ref(false);
const error = ref<string | null>(null);
const showResults = ref(false);

const searchParams = computed(() => ({
  search: entitySearch.value,
  limit: 10,
}));

const { data: entitiesData, isLoading: isSearching } = useEntities(searchParams);

const searchResults = computed(() => entitiesData.value?.items || []);

const debouncedSearch = useDebounceFn(() => {
  showResults.value = entitySearch.value.length > 0;
}, 300);

function handleSearchInput() {
  debouncedSearch();
}

function hideResultsDelayed() {
  setTimeout(() => {
    showResults.value = false;
  }, 200);
}

function selectEntity(entity: Entity) {
  selectedEntity.value = entity;
  entitySearch.value = '';
  showResults.value = false;
}

function clearSelection() {
  selectedEntity.value = null;
}

async function generateContext() {
  if (!selectedEntity.value) {
    error.value = 'Сначала выберите сущность';
    return;
  }

  isGenerating.value = true;
  error.value = null;

  try {
    const response = await $fetch<{ contextMarkdown: string }>('/api/context', {
      method: 'POST',
      body: {
        entityId: selectedEntity.value.id,
        taskHint: taskHint.value || undefined,
      },
    });
    contextResult.value = response.contextMarkdown;
  } catch (err) {
    error.value = 'Не удалось сгенерировать контекст';
    console.error(err);
  } finally {
    isGenerating.value = false;
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Генерация контекста</h1>
      <p class="text-muted-foreground">Получить компактный релевантный контекст по любой сущности</p>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <!-- Input form -->
      <Card>
        <CardHeader>
          <CardTitle>Сгенерировать контекст</CardTitle>
          <CardDescription>
            Выберите сущность и при необходимости укажите подсказку для фокусировки контекста
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Entity search -->
          <div class="space-y-2">
            <label class="text-sm font-medium">Сущность</label>

            <!-- Selected entity display -->
            <div v-if="selectedEntity" class="flex items-center gap-2 p-3 bg-muted rounded-md">
              <div class="h-8 w-8 rounded-full bg-background flex items-center justify-center">
                <User v-if="selectedEntity.type === 'person'" class="h-4 w-4 text-muted-foreground" />
                <Building2 v-else class="h-4 w-4 text-muted-foreground" />
              </div>
              <div class="flex-1">
                <p class="font-medium text-sm">{{ selectedEntity.name }}</p>
                <p class="text-xs text-muted-foreground">{{ selectedEntity.type === 'person' ? 'Человек' : 'Организация' }}</p>
              </div>
              <Button variant="ghost" size="sm" @click="clearSelection">
                <X class="h-4 w-4" />
              </Button>
            </div>

            <!-- Search input -->
            <div v-else class="relative">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                v-model="entitySearch"
                placeholder="Поиск сущности по имени..."
                class="pl-10"
                @input="handleSearchInput"
                @focus="showResults = entitySearch.length > 0"
                @blur="hideResultsDelayed"
              />

              <!-- Search results dropdown -->
              <div
                v-if="showResults"
                class="absolute z-10 w-full mt-1 bg-popover border rounded-md shadow-lg max-h-60 overflow-auto"
              >
                <div v-if="isSearching" class="p-3 text-center text-sm text-muted-foreground">
                  Поиск...
                </div>
                <div v-else-if="searchResults.length === 0" class="p-3 text-center text-sm text-muted-foreground">
                  {{ entitySearch ? 'Ничего не найдено' : 'Введите имя для поиска' }}
                </div>
                <div v-else>
                  <button
                    v-for="entity in searchResults"
                    :key="entity.id"
                    class="w-full flex items-center gap-2 p-2 hover:bg-accent text-left"
                    @mousedown.prevent="selectEntity(entity)"
                  >
                    <div class="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <User v-if="entity.type === 'person'" class="h-4 w-4 text-muted-foreground" />
                      <Building2 v-else class="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="font-medium text-sm truncate">{{ entity.name }}</p>
                      <p class="text-xs text-muted-foreground">{{ entity.type === 'person' ? 'Человек' : 'Организация' }}</p>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <p v-if="!selectedEntity" class="text-xs text-muted-foreground">
              Начните вводить имя для поиска
            </p>
          </div>

          <!-- Task hint -->
          <div class="space-y-2">
            <label class="text-sm font-medium">Подсказка (опционально)</label>
            <textarea
              v-model="taskHint"
              placeholder="Например: 'Готовлюсь к встрече по проекту X'"
              class="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>

          <Button
            class="w-full"
            :disabled="isGenerating || !selectedEntity"
            @click="generateContext"
          >
            <Sparkles class="mr-2 h-4 w-4" />
            {{ isGenerating ? 'Генерация...' : 'Сгенерировать контекст' }}
          </Button>

          <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        </CardContent>
      </Card>

      <!-- Result -->
      <Card>
        <CardHeader>
          <CardTitle>Результат</CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="!contextResult" class="text-center py-12 text-muted-foreground">
            <Sparkles class="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Сгенерированный контекст появится здесь</p>
          </div>
          <div v-else class="prose prose-sm dark:prose-invert max-w-none">
            <pre class="whitespace-pre-wrap text-sm">{{ contextResult }}</pre>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
