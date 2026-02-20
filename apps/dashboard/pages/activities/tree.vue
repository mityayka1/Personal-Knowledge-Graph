<script setup lang="ts">
import {
  TreePine,
  FolderKanban,
  List,
  Loader2,
} from 'lucide-vue-next';
import type { Activity, ActivityListResponse } from '~/composables/useActivities';

definePageMeta({
  title: 'Дерево активностей',
});

const showAll = ref(false);

const { data, status, error, refresh } = useAsyncData(
  'root-activities',
  () => $fetch<ActivityListResponse>('/api/activities', {
    query: { parentId: 'null', limit: 200 },
  }),
  { watch: [showAll] },
);

const rootActivities = computed<Activity[]>(() => {
  if (!data.value?.items) return [];
  if (showAll.value) return data.value.items;
  return data.value.items.filter(
    (a) => a.status !== 'archived' && a.status !== 'cancelled',
  );
});
</script>

<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-3xl font-bold tracking-tight flex items-center gap-3">
          <TreePine class="h-8 w-8 text-primary" />
          Дерево активностей
        </h1>
        <p class="text-muted-foreground">
          Иерархическая структура: сферы, бизнесы, проекты, задачи
        </p>
      </div>
      <div class="flex items-center gap-2">
        <NuxtLink to="/activities">
          <Button variant="outline" size="sm">
            <List class="mr-2 h-4 w-4" />
            Список
          </Button>
        </NuxtLink>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex items-center gap-3 mb-4">
      <label class="flex items-center gap-2 text-sm">
        <input
          v-model="showAll"
          type="checkbox"
          class="rounded border-gray-300"
        />
        Показать архивные и отменённые
      </label>
      <span
        v-if="data?.total"
        class="text-sm text-muted-foreground"
      >
        Всего root: {{ data.total }}
      </span>
    </div>

    <!-- Error -->
    <div v-if="error" class="text-destructive text-center py-8">
      Не удалось загрузить дерево. Попробуйте ещё раз.
    </div>

    <!-- Loading -->
    <div v-else-if="status === 'pending'" class="flex items-center justify-center py-12">
      <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
    </div>

    <!-- Empty -->
    <div
      v-else-if="!rootActivities.length"
      class="text-center py-12 text-muted-foreground"
    >
      <FolderKanban class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>Корневых активностей нет</p>
    </div>

    <!-- Tree -->
    <Card v-else>
      <CardContent class="py-3 px-1">
        <ActivityTreeNode
          v-for="activity in rootActivities"
          :key="activity.id"
          :node="activity"
          :depth="0"
        />
      </CardContent>
    </Card>
  </div>
</template>
