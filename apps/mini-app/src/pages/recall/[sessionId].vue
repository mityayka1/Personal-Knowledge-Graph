<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import { useSmartHaptics } from '@/composables/useSmartHaptics'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const route = useRoute()
const haptics = useSmartHaptics()

const sessionId = computed(() => route.params.sessionId as string)

interface RecallData {
  id: string
  query: string
  answer: string
  sources: Array<{
    id: string
    type: 'message' | 'interaction' | 'fact'
    preview: string
    entityName?: string
    timestamp?: string
  }>
  createdAt: string
}

const data = ref<RecallData | null>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)
const expandedSources = ref<Set<string>>(new Set())

async function loadRecall() {
  isLoading.value = true
  error.value = null

  try {
    data.value = await api.getRecall(sessionId.value)
  } catch (e) {
    error.value = 'Не удалось загрузить результаты'
    console.error('Failed to load recall:', e)
  } finally {
    isLoading.value = false
  }
}

function getSourceIcon(type: string): string {
  const icons: Record<string, string> = {
    message: '💬',
    interaction: '🗓️',
    fact: '📌',
  }
  return icons[type] || '📄'
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

function toggleSource(sourceId: string) {
  haptics.selection()
  if (expandedSources.value.has(sourceId)) {
    expandedSources.value.delete(sourceId)
  } else {
    expandedSources.value.add(sourceId)
  }
}

onMounted(loadRecall)
</script>

<template>
  <div class="min-h-screen">
    <!-- Loading -->
    <div v-if="isLoading" class="flex items-center justify-center py-12">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="error"
      :message="error"
      :retryable="true"
      @retry="loadRecall"
    />

    <!-- Content -->
    <template v-else-if="data">
      <!-- Query Header -->
      <div class="p-4 border-b border-tg-secondary-bg bg-tg-secondary-bg/30">
        <div class="text-sm text-tg-hint mb-1">Вы спросили:</div>
        <div class="text-lg font-medium text-tg-text">{{ data.query }}</div>
      </div>

      <!-- Answer -->
      <div class="p-4">
        <h2 class="section-header">Ответ</h2>
        <div class="card">
          <div class="text-tg-text whitespace-pre-wrap">{{ data.answer }}</div>
        </div>
      </div>

      <!-- Sources -->
      <div v-if="data.sources.length > 0" class="p-4 pt-0">
        <h2 class="section-header">
          Источники ({{ data.sources.length }})
        </h2>
        <div class="bg-tg-section-bg rounded-xl overflow-hidden">
          <div
            v-for="source in data.sources"
            :key="source.id"
            class="border-b border-tg-secondary-bg last:border-0"
          >
            <button
              class="list-item w-full text-left"
              @click="toggleSource(source.id)"
            >
              <span class="text-xl mr-3">{{ getSourceIcon(source.type) }}</span>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-tg-text truncate">
                  {{ source.entityName || 'Источник' }}
                </div>
                <div class="text-sm text-tg-hint">
                  {{ formatTimestamp(source.timestamp) }}
                </div>
              </div>
              <span
                class="text-tg-hint ml-2 transition-transform"
                :class="{ 'rotate-90': expandedSources.has(source.id) }"
              >›</span>
            </button>

            <!-- Expanded Preview -->
            <div
              v-if="expandedSources.has(source.id)"
              class="px-4 pb-4 bg-tg-secondary-bg/50"
            >
              <p class="text-sm text-tg-text whitespace-pre-wrap">
                {{ source.preview }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Timestamp -->
      <div class="p-4 pt-0 text-center">
        <span class="text-sm text-tg-hint">
          {{ new Date(data.createdAt).toLocaleString('ru-RU') }}
        </span>
      </div>
    </template>
  </div>
</template>
