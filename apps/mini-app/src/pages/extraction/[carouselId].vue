<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useExtractionStore } from '@/stores/extraction'
import { useMainButton } from '@/composables/useTelegram'
import { useSmartHaptics } from '@/composables/useSmartHaptics'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const route = useRoute()
const router = useRouter()
const store = useExtractionStore()
const mainButton = useMainButton()
const haptics = useSmartHaptics()

const carouselId = computed(() => route.params.carouselId as string)

function getTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    project: '📁',
    commitment: '🤝',
    action_item: '✅',
    deadline: '📅',
    contact: '👤',
  }
  return icons[type] || '📌'
}

function getTypeName(type: string): string {
  const names: Record<string, string> = {
    project: 'Проект',
    commitment: 'Обязательство',
    action_item: 'Задача',
    deadline: 'Дедлайн',
    contact: 'Контакт',
  }
  return names[type] || type
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}

async function handleConfirm() {
  haptics.confirm()
  mainButton.showProgress()

  await store.confirmCurrent(carouselId.value)

  mainButton.hideProgress()
  updateMainButton()

  if (store.isComplete) {
    haptics.complete()
  }
}

async function handleSkip() {
  haptics.skip()
  await store.skipCurrent(carouselId.value)
  updateMainButton()
}

function handlePrevious() {
  haptics.selection()
  const currentIndex = store.state?.currentIndex ?? 0
  if (currentIndex > 0) {
    store.goToIndex(currentIndex - 1)
  }
}

function handleNext() {
  haptics.selection()
  const currentIndex = store.state?.currentIndex ?? 0
  const total = store.state?.items.length ?? 0
  if (currentIndex < total - 1) {
    store.goToIndex(currentIndex + 1)
  }
}

function updateMainButton() {
  if (store.isComplete) {
    mainButton.setText('✅ Готово')
    mainButton.onClick(() => {
      haptics.navigate()
      router.push('/')
    })
  } else {
    mainButton.setText('✓ Подтвердить')
    mainButton.onClick(handleConfirm)
  }
  mainButton.show()
}

function handleFinish() {
  haptics.navigate()
  router.push('/')
}

onMounted(async () => {
  await store.load(carouselId.value)
  updateMainButton()
})

watch(() => store.currentItem, () => {
  updateMainButton()
})

onUnmounted(() => {
  mainButton.hide()
  store.reset()
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Loading -->
    <div v-if="store.isLoading" class="flex-1 flex items-center justify-center">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="store.error"
      :message="store.error"
      :retryable="true"
      @retry="store.load(carouselId)"
    />

    <!-- Completion Screen -->
    <div v-else-if="store.isComplete" class="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <div class="text-6xl mb-4">🎉</div>
      <h1 class="text-2xl font-bold text-tg-text mb-2">Готово!</h1>
      <p class="text-tg-hint mb-6">
        Вы обработали все извлечённые данные
      </p>

      <div class="bg-tg-secondary-bg rounded-xl p-4 w-full max-w-xs mb-6">
        <div class="flex justify-between mb-2">
          <span class="text-tg-hint">Подтверждено</span>
          <span class="font-medium text-tg-text">{{ store.stats.confirmed }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-tg-hint">Пропущено</span>
          <span class="font-medium text-tg-text">{{ store.stats.skipped }}</span>
        </div>
      </div>

      <button class="btn btn-primary w-full max-w-xs" @click="handleFinish">
        На главную
      </button>
    </div>

    <!-- Carousel Content -->
    <template v-else-if="store.currentItem">
      <!-- Progress Header -->
      <div class="p-4 border-b border-tg-secondary-bg">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm text-tg-hint">
            {{ store.progress.current }} из {{ store.progress.total }}
          </span>
          <span class="text-sm text-tg-hint">
            {{ store.progress.percent }}%
          </span>
        </div>
        <div class="h-1 bg-tg-secondary-bg rounded-full overflow-hidden">
          <div
            class="h-full bg-tg-button rounded-full transition-all duration-300"
            :style="{ width: `${store.progress.percent}%` }"
          />
        </div>
      </div>

      <!-- Card -->
      <div class="flex-1 p-4 overflow-y-auto">
        <div class="card">
          <!-- Type Badge -->
          <div class="flex items-center gap-2 mb-3">
            <span class="text-xl">{{ getTypeIcon(store.currentItem.type) }}</span>
            <span class="text-sm font-medium text-tg-accent">
              {{ getTypeName(store.currentItem.type) }}
            </span>
            <span class="ml-auto text-sm text-tg-hint">
              {{ formatConfidence(store.currentItem.confidence) }} уверенность
            </span>
          </div>

          <!-- Title -->
          <h2 class="text-xl font-bold text-tg-text mb-2">
            {{ store.currentItem.title || 'Без названия' }}
          </h2>

          <!-- Description -->
          <p v-if="store.currentItem.description" class="text-tg-hint mb-4">
            {{ store.currentItem.description }}
          </p>

          <!-- Fields -->
          <div v-if="Object.keys(store.currentItem.fields).length > 0" class="space-y-2 mt-4">
            <div
              v-for="(value, key) in store.currentItem.fields"
              :key="key"
              class="flex justify-between py-2 border-b border-tg-secondary-bg last:border-0"
            >
              <span class="text-tg-hint capitalize">{{ key }}</span>
              <span class="text-tg-text font-medium">{{ value }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Navigation -->
      <div class="p-4 border-t border-tg-secondary-bg">
        <div class="flex gap-3">
          <!-- Previous -->
          <button
            class="btn btn-secondary flex-1"
            :disabled="store.progress.current <= 1"
            @click="handlePrevious"
          >
            ←
          </button>

          <!-- Skip -->
          <button
            class="btn btn-secondary flex-1"
            :disabled="store.isProcessing"
            @click="handleSkip"
          >
            Пропустить
          </button>

          <!-- Next -->
          <button
            class="btn btn-secondary flex-1"
            :disabled="store.progress.current >= store.progress.total"
            @click="handleNext"
          >
            →
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
