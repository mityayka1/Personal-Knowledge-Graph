<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePendingApprovalStore } from '@/stores/pending-approval'
import { useMainButton, useBackButton } from '@/composables/useTelegram'
import { useSmartHaptics } from '@/composables/useSmartHaptics'
import { usePopup } from '@/composables/useTelegram'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const route = useRoute()
const router = useRouter()
const store = usePendingApprovalStore()
const mainButton = useMainButton()
const backButton = useBackButton()
const haptics = useSmartHaptics()
const popup = usePopup()

const batchId = computed(() => route.params.batchId as string)

function getTypeIcon(itemType: string): string {
  const icons: Record<string, string> = {
    fact: 'i',
    project: 'P',
    task: 'T',
    commitment: 'C',
  }
  return icons[itemType] || '?'
}

function getTypeName(itemType: string): string {
  const names: Record<string, string> = {
    fact: 'Факт',
    project: 'Проект',
    task: 'Задача',
    commitment: 'Обязательство',
  }
  return names[itemType] || itemType
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`
}

function getDisplayTitle(): string {
  const item = store.currentItem
  if (!item) return 'Без названия'

  if (item.target?.title) return item.target.title
  if (item.target?.name) return item.target.name
  if (item.target?.value) return item.target.value

  return 'Без названия'
}

function getDisplaySubtitle(): string {
  const item = store.currentItem
  if (!item) return ''

  if (item.itemType === 'fact' && item.target?.factType) {
    return item.target.factType
  }

  return ''
}

async function handleApprove() {
  haptics.confirm()
  mainButton.showProgress()

  await store.approve()

  mainButton.hideProgress()
  updateMainButton()

  if (store.isComplete) {
    haptics.complete()
  }
}

async function handleReject() {
  haptics.reject()
  await store.reject()
  updateMainButton()
}

function handleSkip() {
  haptics.skip()
  store.skip()
  updateMainButton()
}

function handlePrevious() {
  haptics.selection()
  const currentIndex = store.currentIndex
  if (currentIndex > 0) {
    store.goToIndex(currentIndex - 1)
  }
}

function handleNext() {
  haptics.selection()
  const currentIndex = store.currentIndex
  const total = store.items.length
  if (currentIndex < total - 1) {
    store.goToIndex(currentIndex + 1)
  }
}

async function handleApproveAll() {
  const confirmed = await popup.showConfirm(
    `Подтвердить все ${store.progress.pending} элементов?`
  )
  if (!confirmed) return

  haptics.confirm()
  mainButton.showProgress()

  await store.approveAll()

  mainButton.hideProgress()
  updateMainButton()
  haptics.complete()
}

async function handleRejectAll() {
  const confirmed = await popup.showConfirm(
    `Отклонить все ${store.progress.pending} элементов?`
  )
  if (!confirmed) return

  haptics.reject()
  mainButton.showProgress()

  await store.rejectAll()

  mainButton.hideProgress()
  updateMainButton()
}

function updateMainButton() {
  if (store.isComplete) {
    mainButton.setText('Готово')
    mainButton.onClick(() => {
      haptics.navigate()
      router.push('/')
    })
  } else {
    mainButton.setText('Подтвердить')
    mainButton.onClick(handleApprove)
  }
  mainButton.show()
}

function handleBack() {
  haptics.navigate()
  router.push('/')
}

function handleFinish() {
  haptics.navigate()
  router.push('/')
}

onMounted(async () => {
  await store.load(batchId.value)
  updateMainButton()

  backButton.onClick(handleBack)
  backButton.show()
})

watch(() => store.currentItem, () => {
  updateMainButton()
})

onUnmounted(() => {
  mainButton.hide()
  backButton.hide()
  store.reset()
})
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <!-- Loading -->
    <div v-if="store.loading" class="flex-1 flex items-center justify-center">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="store.error"
      :message="store.error"
      :retryable="true"
      @retry="store.load(batchId)"
    />

    <!-- Completion Screen -->
    <div v-else-if="store.isComplete" class="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <div class="text-6xl mb-4">
        {{ store.progress.approved > 0 ? '' : '' }}
      </div>
      <h1 class="text-2xl font-bold text-tg-text mb-2">Готово!</h1>
      <p class="text-tg-hint mb-6">
        Вы обработали все элементы
      </p>

      <div class="bg-tg-secondary-bg rounded-xl p-4 w-full max-w-xs mb-6">
        <div class="flex justify-between mb-2">
          <span class="text-tg-hint">Подтверждено</span>
          <span class="font-medium text-green-500">{{ store.progress.approved }}</span>
        </div>
        <div class="flex justify-between mb-2">
          <span class="text-tg-hint">Отклонено</span>
          <span class="font-medium text-red-500">{{ store.progress.rejected }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-tg-hint">Всего</span>
          <span class="font-medium text-tg-text">{{ store.progress.total }}</span>
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
        <!-- Stats row -->
        <div class="flex items-center justify-center gap-4 mt-2 text-xs">
          <span class="text-tg-hint">
            <span class="text-green-500">{{ store.progress.approved }}</span> подтв.
          </span>
          <span class="text-tg-hint">
            <span class="text-red-500">{{ store.progress.rejected }}</span> откл.
          </span>
          <span class="text-tg-hint">
            <span class="text-yellow-500">{{ store.progress.pending }}</span> ожид.
          </span>
        </div>
      </div>

      <!-- Card -->
      <div class="flex-1 p-4 overflow-y-auto">
        <div class="card">
          <!-- Type Badge -->
          <div class="flex items-center gap-2 mb-3">
            <span class="w-6 h-6 flex items-center justify-center rounded-full bg-tg-secondary-bg text-xs font-medium text-tg-accent">
              {{ getTypeIcon(store.currentItem.itemType) }}
            </span>
            <span class="text-sm font-medium text-tg-accent">
              {{ getTypeName(store.currentItem.itemType) }}
            </span>
            <span class="ml-auto text-sm text-tg-hint">
              {{ formatConfidence(store.currentItem.confidence) }}
            </span>
          </div>

          <!-- Title -->
          <h2 class="text-xl font-bold text-tg-text mb-1">
            {{ getDisplayTitle() }}
          </h2>

          <!-- Subtitle (e.g., fact type) -->
          <p v-if="getDisplaySubtitle()" class="text-sm text-tg-accent mb-3">
            {{ getDisplaySubtitle() }}
          </p>

          <!-- Source Quote -->
          <div v-if="store.currentItem.sourceQuote" class="mt-4">
            <p class="text-xs text-tg-hint mb-1">Источник:</p>
            <blockquote class="border-l-2 border-tg-accent pl-3 py-1 text-sm text-tg-hint italic">
              "{{ store.currentItem.sourceQuote }}"
            </blockquote>
          </div>

          <!-- Status indicator for current item -->
          <div
            v-if="store.currentItem.status !== 'pending'"
            class="mt-4 px-3 py-2 rounded-lg text-sm text-center"
            :class="{
              'bg-green-500/10 text-green-500': store.currentItem.status === 'approved',
              'bg-red-500/10 text-red-500': store.currentItem.status === 'rejected',
            }"
          >
            {{ store.currentItem.status === 'approved' ? 'Подтверждено' : 'Отклонено' }}
          </div>
        </div>

        <!-- Batch Actions -->
        <div v-if="store.progress.pending > 1" class="mt-4 p-4 bg-tg-secondary-bg rounded-xl">
          <p class="text-sm text-tg-hint mb-3 text-center">
            Быстрые действия для всех {{ store.progress.pending }} ожидающих
          </p>
          <div class="flex gap-2">
            <button
              class="btn btn-secondary flex-1 text-green-500"
              :disabled="store.isProcessing"
              @click="handleApproveAll"
            >
              Все подтвердить
            </button>
            <button
              class="btn btn-secondary flex-1 text-red-500"
              :disabled="store.isProcessing"
              @click="handleRejectAll"
            >
              Все отклонить
            </button>
          </div>
        </div>
      </div>

      <!-- Navigation & Actions -->
      <div class="p-4 border-t border-tg-secondary-bg">
        <!-- Action buttons row -->
        <div class="flex gap-3 mb-3">
          <button
            class="btn btn-secondary flex-1 text-red-500"
            :disabled="store.isProcessing || store.currentItem.status !== 'pending'"
            @click="handleReject"
          >
            Отклонить
          </button>
          <button
            class="btn btn-secondary flex-1"
            :disabled="store.isProcessing"
            @click="handleSkip"
          >
            Пропустить
          </button>
        </div>

        <!-- Navigation row -->
        <div class="flex gap-3">
          <!-- Previous -->
          <button
            class="btn btn-secondary flex-1"
            :disabled="store.progress.current <= 1"
            @click="handlePrevious"
          >
            &#8592;
          </button>

          <!-- Next -->
          <button
            class="btn btn-secondary flex-1"
            :disabled="store.progress.current >= store.progress.total"
            @click="handleNext"
          >
            &#8594;
          </button>
        </div>
      </div>
    </template>

    <!-- Empty state -->
    <div v-else class="flex-1 flex flex-col items-center justify-center p-6 text-center">
      <div class="text-6xl mb-4">

      </div>
      <h1 class="text-xl font-bold text-tg-text mb-2">Нет элементов</h1>
      <p class="text-tg-hint mb-6">
        Все элементы уже обработаны
      </p>
      <button class="btn btn-primary w-full max-w-xs" @click="handleFinish">
        На главную
      </button>
    </div>
  </div>
</template>
