<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBriefStore } from '@/stores/brief'
import { useSmartHaptics } from '@/composables/useSmartHaptics'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'
import EmptyState from '@/components/common/EmptyState.vue'

const route = useRoute()
const router = useRouter()
const store = useBriefStore()
const haptics = useSmartHaptics()

const briefId = computed(() => route.params.briefId as string)

function getPriorityColor(priority: string): string {
  const colors: Record<string, string> = {
    high: 'bg-red-500',
    medium: 'bg-yellow-500',
    low: 'bg-green-500',
  }
  return colors[priority] || 'bg-gray-500'
}

function getPriorityLabel(priority: string): string {
  const labels: Record<string, string> = {
    high: 'Важное',
    medium: 'Обычное',
    low: 'Отложенное',
  }
  return labels[priority] || priority
}

function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    meeting: '📅',
    followup: '↩️',
    deadline: '⏰',
    reminder: '🔔',
    contact: '👤',
  }
  return icons[type] || '📌'
}

async function handleAction(itemIdx: number, action: string) {
  haptics.tap()
  await store.performAction(itemIdx, action)

  if (action === 'done') {
    haptics.confirm()
  }
}

function handleToggle(itemIdx: number) {
  haptics.selection()
  store.toggleExpanded(itemIdx)
}

function navigateToEntity(entityId: string) {
  haptics.navigate()
  router.push(`/entity/${entityId}`)
}

onMounted(() => {
  store.load(briefId.value)
})

onUnmounted(() => {
  store.reset()
})
</script>

<template>
  <div class="min-h-screen">
    <!-- Loading -->
    <div v-if="store.isLoading" class="flex items-center justify-center py-12">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="store.error"
      :message="store.error"
      :retryable="true"
      @retry="store.load(briefId)"
    />

    <!-- Content -->
    <template v-else-if="store.brief">
      <!-- Header -->
      <div class="p-4 border-b border-tg-secondary-bg">
        <h1 class="text-xl font-bold text-tg-text">Утренний бриф</h1>
        <p class="text-sm text-tg-hint mt-1">
          {{ new Date(store.brief.date).toLocaleDateString('ru-RU', {
            weekday: 'long',
            day: 'numeric',
            month: 'long'
          }) }}
        </p>

        <!-- Progress -->
        <div class="mt-3">
          <div class="flex justify-between text-sm mb-1">
            <span class="text-tg-hint">
              {{ store.progress.completed }} из {{ store.progress.total }}
            </span>
            <span class="text-tg-hint">{{ store.progress.percent }}%</span>
          </div>
          <div class="h-1 bg-tg-secondary-bg rounded-full overflow-hidden">
            <div
              class="h-full bg-tg-button rounded-full transition-all"
              :style="{ width: `${store.progress.percent}%` }"
            />
          </div>
        </div>
      </div>

      <!-- Priority Sections -->
      <div class="p-4">
        <!-- High Priority -->
        <template v-if="store.groupedItems.high.length > 0">
          <h2 class="section-header flex items-center gap-2">
            <span :class="['w-2 h-2 rounded-full', getPriorityColor('high')]" />
            {{ getPriorityLabel('high') }}
          </h2>
          <div class="bg-tg-section-bg rounded-xl overflow-hidden mb-4">
            <div
              v-for="item in store.groupedItems.high"
              :key="item.idx"
              class="border-b border-tg-secondary-bg last:border-0"
            >
              <button
                class="list-item w-full text-left"
                @click="handleToggle(item.idx)"
              >
                <span class="text-xl mr-3">{{ getTypeIcon(item.type) }}</span>
                <div class="flex-1 min-w-0">
                  <div
                    class="font-medium truncate"
                    :class="item.completed ? 'text-tg-hint line-through' : 'text-tg-text'"
                  >
                    {{ item.title }}
                  </div>
                  <div v-if="item.entityName" class="text-sm text-tg-hint">
                    {{ item.entityName }}
                  </div>
                </div>
                <span
                  v-if="item.completed"
                  class="text-green-500 ml-2"
                >✓</span>
                <span
                  v-else
                  class="text-tg-hint ml-2 transition-transform"
                  :class="{ 'rotate-90': store.isExpanded(item.idx) }"
                >›</span>
              </button>

              <!-- Expanded Content -->
              <div
                v-if="store.isExpanded(item.idx)"
                class="px-4 pb-4 bg-tg-secondary-bg/50"
              >
                <p class="text-sm text-tg-text mb-3">{{ item.description }}</p>

                <div v-if="item.entityId" class="mb-3">
                  <button
                    class="text-sm text-tg-link"
                    @click.stop="navigateToEntity(item.entityId)"
                  >
                    Открыть профиль →
                  </button>
                </div>

                <div class="flex gap-2">
                  <button
                    v-if="!item.completed"
                    class="btn btn-primary flex-1 py-2 text-sm"
                    @click.stop="handleAction(item.idx, 'done')"
                  >
                    ✓ Готово
                  </button>
                  <button
                    class="btn btn-secondary flex-1 py-2 text-sm"
                    @click.stop="handleAction(item.idx, 'remind')"
                  >
                    🔔 Напомнить
                  </button>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- Medium Priority -->
        <template v-if="store.groupedItems.medium.length > 0">
          <h2 class="section-header flex items-center gap-2">
            <span :class="['w-2 h-2 rounded-full', getPriorityColor('medium')]" />
            {{ getPriorityLabel('medium') }}
          </h2>
          <div class="bg-tg-section-bg rounded-xl overflow-hidden mb-4">
            <div
              v-for="item in store.groupedItems.medium"
              :key="item.idx"
              class="border-b border-tg-secondary-bg last:border-0"
            >
              <button
                class="list-item w-full text-left"
                @click="handleToggle(item.idx)"
              >
                <span class="text-xl mr-3">{{ getTypeIcon(item.type) }}</span>
                <div class="flex-1 min-w-0">
                  <div
                    class="font-medium truncate"
                    :class="item.completed ? 'text-tg-hint line-through' : 'text-tg-text'"
                  >
                    {{ item.title }}
                  </div>
                </div>
                <span v-if="item.completed" class="text-green-500 ml-2">✓</span>
              </button>
            </div>
          </div>
        </template>

        <!-- Low Priority -->
        <template v-if="store.groupedItems.low.length > 0">
          <h2 class="section-header flex items-center gap-2">
            <span :class="['w-2 h-2 rounded-full', getPriorityColor('low')]" />
            {{ getPriorityLabel('low') }}
          </h2>
          <div class="bg-tg-section-bg rounded-xl overflow-hidden mb-4">
            <div
              v-for="item in store.groupedItems.low"
              :key="item.idx"
            >
              <button
                class="list-item w-full text-left"
                @click="handleToggle(item.idx)"
              >
                <span class="text-xl mr-3">{{ getTypeIcon(item.type) }}</span>
                <div class="flex-1 min-w-0">
                  <div
                    class="font-medium truncate"
                    :class="item.completed ? 'text-tg-hint line-through' : 'text-tg-text'"
                  >
                    {{ item.title }}
                  </div>
                </div>
              </button>
            </div>
          </div>
        </template>

        <!-- Empty State -->
        <EmptyState
          v-if="store.brief.items.length === 0"
          icon="📭"
          title="Бриф пустой"
          description="Сегодня нет запланированных задач"
        />
      </div>
    </template>
  </div>
</template>
