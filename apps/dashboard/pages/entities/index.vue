<script setup lang="ts">
import { Search, Plus, User, Building2 } from 'lucide-vue-next';
import { useDebounceFn } from '@vueuse/core';
import { useEntities, type EntityListParams } from '~/composables/useEntities';
import { formatRelativeTime } from '~/lib/utils';

definePageMeta({
  title: 'Сущности',
});

const router = useRouter();

const searchQuery = ref('');
const typeFilter = ref<'person' | 'organization' | undefined>(undefined);
const currentPage = ref(0);
const pageSize = 20;

const params = computed<EntityListParams>(() => ({
  search: searchQuery.value || undefined,
  type: typeFilter.value,
  limit: pageSize,
  offset: currentPage.value * pageSize,
}));

const { data, isLoading, error } = useEntities(params);

const debouncedSearch = useDebounceFn((value: string) => {
  searchQuery.value = value;
  currentPage.value = 0;
}, 300);

function handleSearchInput(event: Event) {
  const target = event.target as HTMLInputElement;
  debouncedSearch(target.value);
}

function toggleTypeFilter(type: 'person' | 'organization') {
  if (typeFilter.value === type) {
    typeFilter.value = undefined;
  } else {
    typeFilter.value = type;
  }
  currentPage.value = 0;
}

function goToEntity(id: string) {
  router.push(`/entities/${id}`);
}

function nextPage() {
  if (data.value && (currentPage.value + 1) * pageSize < data.value.total) {
    currentPage.value++;
  }
}

function prevPage() {
  if (currentPage.value > 0) {
    currentPage.value--;
  }
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Сущности</h1>
        <p class="text-muted-foreground">Люди и организации в вашем графе знаний</p>
      </div>
      <NuxtLink to="/entities/new">
        <Button>
          <Plus class="mr-2 h-4 w-4" />
          Добавить
        </Button>
      </NuxtLink>
    </div>

    <!-- Filters -->
    <div class="flex flex-col sm:flex-row gap-4 mb-6">
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Поиск по имени..."
          class="pl-10"
          :value="searchQuery"
          @input="handleSearchInput"
        />
      </div>
      <div class="flex gap-2">
        <Button
          :variant="typeFilter === 'person' ? 'default' : 'outline'"
          size="sm"
          @click="toggleTypeFilter('person')"
        >
          <User class="mr-2 h-4 w-4" />
          Люди
        </Button>
        <Button
          :variant="typeFilter === 'organization' ? 'default' : 'outline'"
          size="sm"
          @click="toggleTypeFilter('organization')"
        >
          <Building2 class="mr-2 h-4 w-4" />
          Организации
        </Button>
      </div>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-destructive text-center py-8">
      Не удалось загрузить сущности. Попробуйте ещё раз.
    </div>

    <!-- Loading state -->
    <div v-else-if="isLoading" class="space-y-4">
      <Card v-for="i in 5" :key="i">
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
      <User class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>Сущности не найдены</p>
      <p v-if="searchQuery" class="text-sm">Попробуйте изменить поисковый запрос</p>
    </div>

    <!-- Entity list -->
    <div v-else class="space-y-2">
      <Card
        v-for="entity in data.items"
        :key="entity.id"
        class="cursor-pointer hover:bg-accent/50 transition-colors"
        @click="goToEntity(entity.id)"
      >
        <CardContent class="p-4">
          <div class="flex items-center gap-4">
            <div
              :class="[
                'h-10 w-10 rounded-full flex items-center justify-center',
                entity.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
              ]"
            >
              <User v-if="entity.type === 'person'" class="h-5 w-5" />
              <Building2 v-else class="h-5 w-5" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-medium truncate">{{ entity.name }}</h3>
                <Badge variant="secondary" class="text-xs">
                  {{ entity.type === 'person' ? 'человек' : 'организация' }}
                </Badge>
              </div>
              <div class="text-sm text-muted-foreground flex items-center gap-2">
                <span v-if="entity.organization">
                  @ {{ entity.organization.name }}
                </span>
                <span v-if="entity.identifiers?.length">
                  {{ entity.identifiers.length }} идентификатор(ов)
                </span>
                <span v-if="entity.facts?.length">
                  {{ entity.facts.length }} факт(ов)
                </span>
              </div>
            </div>
            <div class="text-sm text-muted-foreground hidden sm:block">
              {{ formatRelativeTime(entity.updatedAt) }}
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Pagination -->
      <div class="flex items-center justify-between pt-4">
        <p class="text-sm text-muted-foreground">
          Показано {{ currentPage * pageSize + 1 }}-{{ Math.min((currentPage + 1) * pageSize, data.total) }}
          из {{ data.total }}
        </p>
        <div class="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="currentPage === 0"
            @click="prevPage"
          >
            Назад
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="(currentPage + 1) * pageSize >= data.total"
            @click="nextPage"
          >
            Вперёд
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
