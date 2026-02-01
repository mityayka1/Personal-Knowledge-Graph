<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/client'
import { useUserStore } from '@/stores/user'
import { useSmartHaptics } from '@/composables/useSmartHaptics'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'

const router = useRouter()
const userStore = useUserStore()
const haptics = useSmartHaptics()

interface DashboardData {
  pendingActions: Array<{
    type: 'extraction' | 'fact_conflict' | 'approval'
    id: string
    title: string
    count?: number
  }>
  todayBrief: {
    id: string
    itemCount: number
    completedCount: number
  } | null
  recentActivity: Array<{
    type: 'recall' | 'brief' | 'entity'
    id: string
    title: string
    timestamp: string
  }>
}

const data = ref<DashboardData | null>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)

async function loadDashboard() {
  isLoading.value = true
  error.value = null

  try {
    await userStore.fetchMe()
    data.value = await api.getDashboard()
  } catch (e) {
    error.value = 'Не удалось загрузить данные'
    console.error('Failed to load dashboard:', e)
  } finally {
    isLoading.value = false
  }
}

function navigateTo(path: string) {
  haptics.navigate()
  router.push(path)
}

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)

  if (diffMins < 1) return 'только что'
  if (diffMins < 60) return `${diffMins} мин назад`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} ч назад`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'вчера'
  if (diffDays < 7) return `${diffDays} дн назад`

  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

function getActionIcon(type: string): string {
  const icons: Record<string, string> = {
    extraction: '📦',
    fact_conflict: '⚠️',
    approval: '✅',
  }
  return icons[type] || '📌'
}

function getActivityIcon(type: string): string {
  const icons: Record<string, string> = {
    recall: '🔍',
    brief: '📋',
    entity: '👤',
  }
  return icons[type] || '📌'
}

function getActionPath(action: DashboardData['pendingActions'][0]): string {
  // Route approval type to pending-approval page, others to extraction
  if (action.type === 'approval') {
    return `/pending-approval/${action.id}`
  }
  return `/extraction/${action.id}`
}

onMounted(loadDashboard)
</script>

<template>
  <div class="p-4">
    <!-- Header -->
    <div class="mb-6">
      <h1 class="text-2xl font-bold text-tg-text">
        Привет, {{ userStore.displayName }}
      </h1>
      <p class="text-sm text-tg-hint mt-1">
        Что нового в вашей сети контактов
      </p>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="flex justify-center py-12">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="error"
      :message="error"
      :retryable="true"
      @retry="loadDashboard"
    />

    <!-- Content -->
    <template v-else-if="data">
      <!-- Pending Actions -->
      <section v-if="data.pendingActions.length > 0" class="mb-6">
        <h2 class="section-header">Требуют внимания</h2>
        <div class="bg-tg-section-bg rounded-xl overflow-hidden">
          <button
            v-for="action in data.pendingActions"
            :key="action.id"
            class="list-item w-full text-left"
            @click="navigateTo(getActionPath(action))"
          >
            <span class="text-xl mr-3">{{ getActionIcon(action.type) }}</span>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-tg-text truncate">{{ action.title }}</div>
              <div v-if="action.count" class="text-sm text-tg-hint">
                {{ action.count }} элементов
              </div>
            </div>
            <span class="text-tg-hint ml-2">›</span>
          </button>
        </div>
      </section>

      <!-- Today's Brief -->
      <section v-if="data.todayBrief" class="mb-6">
        <h2 class="section-header">Сегодняшний бриф</h2>
        <button
          class="card w-full text-left"
          @click="navigateTo(`/brief/${data.todayBrief!.id}`)"
        >
          <div class="flex items-center justify-between">
            <div>
              <div class="font-medium text-tg-text">Утренний бриф</div>
              <div class="text-sm text-tg-hint mt-1">
                {{ data.todayBrief.completedCount }} из {{ data.todayBrief.itemCount }} выполнено
              </div>
            </div>
            <div class="flex items-center">
              <div class="w-12 h-12 rounded-full bg-tg-secondary-bg flex items-center justify-center">
                <span class="text-lg">📋</span>
              </div>
            </div>
          </div>
          <!-- Progress bar -->
          <div class="mt-3 h-1 bg-tg-secondary-bg rounded-full overflow-hidden">
            <div
              class="h-full bg-tg-button rounded-full transition-all"
              :style="{
                width: `${(data.todayBrief.completedCount / data.todayBrief.itemCount) * 100}%`
              }"
            />
          </div>
        </button>
      </section>

      <!-- Recent Activity -->
      <section v-if="data.recentActivity.length > 0" class="mb-6">
        <h2 class="section-header">Недавняя активность</h2>
        <div class="bg-tg-section-bg rounded-xl overflow-hidden">
          <button
            v-for="activity in data.recentActivity"
            :key="activity.id"
            class="list-item w-full text-left"
            @click="navigateTo(`/${activity.type}/${activity.id}`)"
          >
            <span class="text-xl mr-3">{{ getActivityIcon(activity.type) }}</span>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-tg-text truncate">{{ activity.title }}</div>
              <div class="text-sm text-tg-hint">
                {{ formatRelativeTime(activity.timestamp) }}
              </div>
            </div>
            <span class="text-tg-hint ml-2">›</span>
          </button>
        </div>
      </section>

      <!-- Empty State -->
      <EmptyState
        v-if="!data.pendingActions.length && !data.todayBrief && !data.recentActivity.length"
        icon="🌟"
        title="Всё чисто!"
        description="Нет новых событий или задач"
      />
    </template>
  </div>
</template>
