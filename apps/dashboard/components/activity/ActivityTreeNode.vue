<script setup lang="ts">
import {
  ChevronRight,
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
  Loader2,
} from 'lucide-vue-next';
import {
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_TYPE_COLORS,
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_STATUS_COLORS,
  type Activity,
  type ActivityType,
  type ActivityListResponse,
} from '~/composables/useActivities';

const props = defineProps<{
  node: Activity;
  depth?: number;
}>();

const depth = computed(() => props.depth ?? 0);
const expanded = ref(false);
const children = ref<Activity[] | null>(null);
const loading = ref(false);

const hasChildren = computed(() => (props.node.childrenCount ?? 0) > 0);

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

async function toggle() {
  if (!hasChildren.value) return;

  if (!expanded.value && !children.value) {
    loading.value = true;
    try {
      const response = await $fetch<ActivityListResponse>('/api/activities', {
        query: { parentId: props.node.id, limit: 200 },
      });
      children.value = response.items;
    } catch (e) {
      console.error('Failed to load children:', e);
    } finally {
      loading.value = false;
    }
  }

  expanded.value = !expanded.value;
}
</script>

<template>
  <div>
    <div
      class="flex items-center gap-2 py-1.5 px-2 hover:bg-accent/50 rounded-md cursor-pointer group"
      :style="{ paddingLeft: depth * 24 + 8 + 'px' }"
      @click="toggle"
    >
      <!-- Expand/collapse icon -->
      <div class="w-4 h-4 flex items-center justify-center shrink-0">
        <Loader2 v-if="loading" class="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        <ChevronRight
          v-else-if="hasChildren"
          class="w-3.5 h-3.5 text-muted-foreground transition-transform duration-150"
          :class="{ 'rotate-90': expanded }"
        />
      </div>

      <!-- Type icon -->
      <div
        :class="[
          'h-6 w-6 rounded flex items-center justify-center shrink-0',
          ACTIVITY_TYPE_COLORS[node.activityType],
        ]"
      >
        <component :is="TYPE_ICONS[node.activityType]" class="h-3.5 w-3.5" />
      </div>

      <!-- Name -->
      <NuxtLink
        :to="`/activities/${node.id}`"
        class="hover:underline flex-1 min-w-0 truncate text-sm font-medium"
        @click.stop
      >
        {{ node.name }}
      </NuxtLink>

      <!-- Status badge -->
      <Badge
        :class="ACTIVITY_STATUS_COLORS[node.status]"
        class="text-xs shrink-0 opacity-70 group-hover:opacity-100"
      >
        {{ ACTIVITY_STATUS_LABELS[node.status] }}
      </Badge>

      <!-- Children count -->
      <span
        v-if="hasChildren"
        class="text-xs text-muted-foreground shrink-0 tabular-nums"
      >
        {{ node.childrenCount }}
      </span>
    </div>

    <!-- Children (lazy-loaded on expand) -->
    <div v-if="expanded && children">
      <ActivityTreeNode
        v-for="child in children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
      />
    </div>
  </div>
</template>
