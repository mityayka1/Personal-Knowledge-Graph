<script setup lang="ts">
import {
  Search,
  Plus,
  Globe,
  Building2,
  GitBranch,
  FolderKanban,
  Rocket,
  CheckSquare,
  Flag,
  RefreshCw,
  GraduationCap,
  CalendarRange,
  Clock,
  AlertTriangle,
  TreePine,
} from 'lucide-vue-next';
import { useDebounceFn } from '@vueuse/core';
import {
  useActivities,
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_STATUS_COLORS,
  ACTIVITY_PRIORITY_LABELS,
  ACTIVITY_PRIORITY_COLORS,
  ACTIVITY_TYPE_COLORS,
  type ActivityListParams,
  type ActivityType,
  type ActivityStatus,
} from '~/composables/useActivities';
import { formatRelativeTime, formatDate } from '~/lib/utils';

definePageMeta({
  title: 'Активности',
});

const router = useRouter();

const searchQuery = ref('');
const typeFilter = ref<ActivityType | undefined>(undefined);
const statusFilter = ref<ActivityStatus | undefined>(undefined);
const currentPage = ref(0);
const pageSize = 20;

const params = computed<ActivityListParams>(() => ({
  search: searchQuery.value || undefined,
  activityType: typeFilter.value,
  status: statusFilter.value,
  limit: pageSize,
  offset: currentPage.value * pageSize,
}));

const { data, isLoading, error } = useActivities(params);

const debouncedSearch = useDebounceFn((value: string) => {
  searchQuery.value = value;
  currentPage.value = 0;
}, 300);

function handleSearchInput(event: Event) {
  const target = event.target as HTMLInputElement;
  debouncedSearch(target.value);
}

function toggleTypeFilter(type: ActivityType) {
  typeFilter.value = typeFilter.value === type ? undefined : type;
  currentPage.value = 0;
}

function toggleStatusFilter(status: ActivityStatus) {
  statusFilter.value = statusFilter.value === status ? undefined : status;
  currentPage.value = 0;
}

function goToActivity(id: string) {
  router.push(`/activities/${id}`);
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

const TYPE_ICONS: Record<ActivityType, typeof Globe> = {
  area: Globe,
  business: Building2,
  direction: GitBranch,
  project: FolderKanban,
  initiative: Rocket,
  task: CheckSquare,
  milestone: Flag,
  habit: RefreshCw,
  learning: GraduationCap,
  event_series: CalendarRange,
};

const mainTypeFilters: ActivityType[] = ['project', 'task', 'area', 'business'];
const mainStatusFilters: ActivityStatus[] = ['active', 'draft', 'completed', 'paused'];

function isOverdue(deadline: string | null): boolean {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Активности</h1>
        <p class="text-muted-foreground">Проекты, задачи и другие активности</p>
      </div>
      <div class="flex items-center gap-2">
        <NuxtLink to="/activities/tree">
          <Button variant="outline">
            <TreePine class="mr-2 h-4 w-4" />
            Дерево
          </Button>
        </NuxtLink>
        <NuxtLink to="/activities/new">
          <Button>
            <Plus class="mr-2 h-4 w-4" />
            Добавить
          </Button>
        </NuxtLink>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-col gap-4 mb-6">
      <!-- Search -->
      <div class="relative flex-1">
        <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          type="text"
          placeholder="Поиск по названию..."
          class="pl-10"
          :value="searchQuery"
          @input="handleSearchInput"
        />
      </div>

      <!-- Type filters -->
      <div class="flex flex-wrap gap-2">
        <span class="text-sm text-muted-foreground self-center mr-1">Тип:</span>
        <Button
          v-for="type in mainTypeFilters"
          :key="type"
          :variant="typeFilter === type ? 'default' : 'outline'"
          size="sm"
          @click="toggleTypeFilter(type)"
        >
          <component :is="TYPE_ICONS[type]" class="mr-1.5 h-3.5 w-3.5" />
          {{ ACTIVITY_TYPE_LABELS[type] }}
        </Button>
      </div>

      <!-- Status filters -->
      <div class="flex flex-wrap gap-2">
        <span class="text-sm text-muted-foreground self-center mr-1">Статус:</span>
        <Button
          v-for="status in mainStatusFilters"
          :key="status"
          :variant="statusFilter === status ? 'default' : 'outline'"
          size="sm"
          @click="toggleStatusFilter(status)"
        >
          {{ ACTIVITY_STATUS_LABELS[status] }}
        </Button>
      </div>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-destructive text-center py-8">
      Не удалось загрузить активности. Попробуйте ещё раз.
    </div>

    <!-- Loading state -->
    <div v-else-if="isLoading" class="space-y-2">
      <Card v-for="i in 5" :key="i">
        <CardContent class="p-4">
          <div class="flex items-center gap-4">
            <Skeleton class="h-10 w-10 rounded-lg" />
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
      <FolderKanban class="h-12 w-12 mx-auto mb-4 opacity-50" />
      <p>Активности не найдены</p>
      <p v-if="searchQuery || typeFilter || statusFilter" class="text-sm">
        Попробуйте изменить фильтры
      </p>
    </div>

    <!-- Activity list -->
    <div v-else class="space-y-2">
      <Card
        v-for="activity in data.items"
        :key="activity.id"
        class="cursor-pointer hover:bg-accent/50 transition-colors"
        @click="goToActivity(activity.id)"
      >
        <CardContent class="p-4">
          <div class="flex items-center gap-4">
            <!-- Type icon -->
            <div
              :class="[
                'h-10 w-10 rounded-lg flex items-center justify-center shrink-0',
                ACTIVITY_TYPE_COLORS[activity.activityType],
              ]"
            >
              <component :is="TYPE_ICONS[activity.activityType]" class="h-5 w-5" />
            </div>

            <!-- Content -->
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="font-medium truncate">{{ activity.name }}</h3>
                <Badge :class="ACTIVITY_TYPE_COLORS[activity.activityType]" class="text-xs">
                  {{ ACTIVITY_TYPE_LABELS[activity.activityType] }}
                </Badge>
                <Badge :class="ACTIVITY_STATUS_COLORS[activity.status]" class="text-xs">
                  {{ ACTIVITY_STATUS_LABELS[activity.status] }}
                </Badge>
                <Badge
                  v-if="activity.priority !== 'medium' && activity.priority !== 'none'"
                  :class="ACTIVITY_PRIORITY_COLORS[activity.priority]"
                  class="text-xs"
                >
                  {{ ACTIVITY_PRIORITY_LABELS[activity.priority] }}
                </Badge>
              </div>
              <p v-if="activity.description" class="text-sm text-muted-foreground mt-0.5 line-clamp-1">
                {{ activity.description }}
              </p>
              <div class="text-sm text-muted-foreground flex items-center gap-3 mt-1">
                <span v-if="activity.clientEntity">
                  @ {{ activity.clientEntity.name }}
                </span>
                <span v-if="activity.parent" class="truncate">
                  {{ ACTIVITY_TYPE_LABELS[activity.parent.activityType] }}: {{ activity.parent.name }}
                </span>
                <span
                  v-if="activity.deadline"
                  :class="{ 'text-destructive font-medium': isOverdue(activity.deadline) }"
                  class="flex items-center gap-1"
                >
                  <AlertTriangle v-if="isOverdue(activity.deadline)" class="h-3 w-3" />
                  <Clock v-else class="h-3 w-3" />
                  {{ formatDate(activity.deadline) }}
                </span>
                <span v-if="activity.childrenCount">
                  {{ activity.childrenCount }} подзадач
                </span>
              </div>
            </div>

            <!-- Timestamp -->
            <div class="text-sm text-muted-foreground hidden sm:block shrink-0">
              {{ formatRelativeTime(activity.updatedAt) }}
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Pagination -->
      <div v-if="data.total > pageSize" class="flex items-center justify-between pt-4">
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
