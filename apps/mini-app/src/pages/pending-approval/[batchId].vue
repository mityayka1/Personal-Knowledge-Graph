<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePendingApprovalStore } from '@/stores/pending-approval'
import { useBackButton } from '@/composables/useTelegram'
import { useSmartHaptics } from '@/composables/useSmartHaptics'
import { usePopup } from '@/composables/useTelegram'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const route = useRoute()
const router = useRouter()
const store = usePendingApprovalStore()
const backButton = useBackButton()
const haptics = useSmartHaptics()
const popup = usePopup()

const batchIdParam = computed(() => route.params.batchId as string)

// Edit mode state
const isEditing = ref(false)
const editForm = ref({
  name: '',
  description: '',
  priority: '',
  deadline: '',
})

// Initialize edit form when item changes
watch(() => store.currentItem, (item) => {
  if (item) {
    const target = item.target || {}
    const priorityValue = target.priority
    const dueDateValue = target.dueDate
    const name: string = target.title || target.name || ''
    const description: string = target.description || ''
    const priority: string = typeof priorityValue === 'string' ? priorityValue : ''
    const deadline: string = dueDateValue ? (String(dueDateValue).split('T')[0] ?? '') : ''
    editForm.value = { name, description, priority, deadline }
  }
  // Close edit mode when navigating to different item
  isEditing.value = false
}, { immediate: true })

function startEditing() {
  haptics.selection()
  isEditing.value = true
}

function cancelEditing() {
  haptics.selection()
  isEditing.value = false
  // Reset form to current values
  const target = store.currentItem?.target || {}
  const priorityValue = target.priority
  const dueDateValue = target.dueDate
  const name: string = target.title || target.name || ''
  const description: string = target.description || ''
  const priority: string = typeof priorityValue === 'string' ? priorityValue : ''
  const deadline: string = dueDateValue ? (String(dueDateValue).split('T')[0] ?? '') : ''
  editForm.value = { name, description, priority, deadline }
}

async function saveEdits() {
  haptics.confirm()

  const updates: Record<string, string | null | undefined> = {}

  // Only include changed fields
  const target = store.currentItem?.target || {}
  const originalName = target.title || target.name || ''
  const originalDescription = target.description || ''
  const originalPriority = typeof target.priority === 'string' ? target.priority : ''
  const originalDeadline = target.dueDate ? target.dueDate.split('T')[0] : ''

  if (editForm.value.name !== originalName) {
    updates.name = editForm.value.name
  }
  if (editForm.value.description !== originalDescription) {
    updates.description = editForm.value.description
  }
  if (editForm.value.priority !== originalPriority) {
    updates.priority = editForm.value.priority || undefined
  }
  if (editForm.value.deadline !== originalDeadline) {
    // Convert date to ISO string or null if cleared
    updates.deadline = editForm.value.deadline
      ? new Date(editForm.value.deadline).toISOString()
      : null
  }

  if (Object.keys(updates).length === 0) {
    isEditing.value = false
    return
  }

  const success = await store.updateTarget(updates)
  if (success) {
    isEditing.value = false
  }
}

// Check if current item type supports editing
const canEdit = computed(() => {
  const itemType = store.currentItem?.itemType
  return itemType === 'task' || itemType === 'project' || itemType === 'commitment'
})

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

  // For commitments, use title from target
  if (item.target?.title) return item.target.title
  // For facts/other types
  if (item.target?.name) return item.target.name
  if (item.target?.value) return item.target.value
  // Fallback to source quote
  if (item.sourceQuote) return item.sourceQuote.substring(0, 100)

  return 'Без названия'
}

function getDisplaySubtitle(): string {
  const item = store.currentItem
  if (!item) return ''

  // For commitments, show type name
  if (item.itemType === 'commitment' && item.target?.typeName) {
    return item.target.typeName
  }

  // For facts, show fact type
  if (item.itemType === 'fact' && item.target?.factType) {
    return item.target.factType
  }

  return ''
}

function getCounterparty(): string | null {
  const item = store.currentItem
  if (!item) return null

  // For commitments: fromEntity → toEntity
  if (item.itemType === 'commitment') {
    const from = item.target?.fromEntity?.name
    const to = item.target?.toEntity?.name
    if (from && to) {
      return `${from} → ${to}`
    }
    return from || to || null
  }

  // For tasks: clientEntity (requester) → assignee/ownerEntity
  if (item.itemType === 'task') {
    const from = item.target?.clientEntity?.name
    const to = item.target?.assignee === 'self'
      ? item.target?.ownerEntity?.name
      : item.target?.assignee || item.target?.ownerEntity?.name

    if (from && to) {
      return `${from} → ${to}`
    }
    // If no client, just show who it's assigned to
    if (to) {
      return `→ ${to}`
    }
    return null
  }

  return null
}

function getDueDate(): string | null {
  const item = store.currentItem
  if (!item?.target?.dueDate) return null

  const date = new Date(item.target.dueDate)
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  })
}

function getParentActivity(): string | null {
  const item = store.currentItem
  return item?.target?.parentActivity?.name || null
}

function getPriority(): string | null {
  const item = store.currentItem
  if (!item?.target?.priority) return null

  const priority = item.target.priority

  // Numeric priorities (for Commitment)
  if (typeof priority === 'number') {
    const numericPriorities: Record<number, string> = {
      1: '🔴 Высокий',
      2: '🟡 Средний',
      3: '🟢 Низкий',
    }
    return numericPriorities[priority] || null
  }

  // String priorities (for Activity/Task)
  const stringPriorities: Record<string, string> = {
    critical: '🔴 Критичный',
    high: '🔴 Высокий',
    medium: '🟡 Средний',
    low: '🟢 Низкий',
    none: null as unknown as string,
  }
  return stringPriorities[priority] || null
}

function getCommitmentTypeName(): string | null {
  const item = store.currentItem
  if (item?.itemType !== 'commitment' || !item.target?.typeName) return null

  const typeNames: Record<string, string> = {
    promise: 'Обещание',
    request: 'Просьба',
    offer: 'Предложение',
    agreement: 'Договорённость',
    deadline: 'Дедлайн',
    task: 'Задача',
  }
  return typeNames[item.target.typeName] || item.target.typeName
}

function hasSourceLink(): boolean {
  const item = store.currentItem
  return !!(item?.messageRef || item?.sourceInteractionId)
}

function openSourceMessage() {
  const item = store.currentItem
  if (!item?.messageRef) return

  // messageRef format: "chatId:messageId"
  const [chatId, messageId] = item.messageRef.split(':')
  if (!chatId || !messageId) return

  haptics.selection()

  // Use Telegram deep link to open the message
  // For private chats: tg://privatepost?channel=chatId&post=messageId
  // For public: https://t.me/c/chatId/messageId
  const link = `https://t.me/c/${chatId.replace('-100', '')}/${messageId}`

  // Open in Telegram using WebApp API
  if (window.Telegram?.WebApp?.openTelegramLink) {
    window.Telegram.WebApp.openTelegramLink(link)
  } else {
    window.open(link, '_blank')
  }
}

async function handleApprove() {
  haptics.confirm()
  await store.approve()

  if (store.isComplete) {
    haptics.complete()
  }
}

async function handleReject() {
  haptics.reject()
  await store.reject()
}

function handleSkip() {
  haptics.skip()
  store.skip()
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
  await store.approveAll()
  haptics.complete()
}

async function handleRejectAll() {
  const confirmed = await popup.showConfirm(
    `Отклонить все ${store.progress.pending} элементов?`
  )
  if (!confirmed) return

  haptics.reject()
  await store.rejectAll()
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
  await store.load(batchIdParam.value)

  backButton.onClick(handleBack)
  backButton.show()
})

onUnmounted(() => {
  backButton.hide()
  store.reset()
})
</script>

<template>
  <div class="min-h-screen bg-tg-bg" :style="{ paddingTop: 'var(--tg-content-safe-area-inset-top, 0px)' }">
    <!-- Loading -->
    <div v-if="store.loading" class="min-h-screen flex items-center justify-center">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="store.error"
      :message="store.error"
      :retryable="true"
      @retry="store.load(batchIdParam)"
    />

    <!-- Completion Screen -->
    <div v-else-if="store.isComplete" class="min-h-screen flex flex-col items-center justify-center p-6 text-center">
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
      <!-- Scrollable content area with bottom padding for fixed footer -->
      <div class="pb-56">
        <!-- Progress Header -->
        <div class="p-4 border-b border-tg-secondary-bg bg-tg-bg sticky top-0 z-10">
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
        <div class="p-4">
          <div class="card">
            <!-- Type Badge + Confidence -->
            <div class="flex items-center gap-2 mb-3">
              <span class="w-6 h-6 flex items-center justify-center rounded-full bg-tg-secondary-bg text-xs font-medium text-tg-accent">
                {{ getTypeIcon(store.currentItem.itemType) }}
              </span>
              <span class="text-sm font-medium text-tg-accent">
                {{ getTypeName(store.currentItem.itemType) }}
              </span>
              <span v-if="getCommitmentTypeName()" class="text-xs text-tg-hint">
                · {{ getCommitmentTypeName() }}
              </span>
              <span v-else-if="getDisplaySubtitle()" class="text-xs text-tg-hint">
                · {{ getDisplaySubtitle() }}
              </span>
              <span class="ml-auto text-sm text-tg-hint">
                {{ formatConfidence(store.currentItem.confidence) }}
              </span>
            </div>

            <!-- Parent Activity/Project Badge -->
            <div v-if="getParentActivity()" class="mb-2">
              <span class="inline-flex items-center px-2 py-1 rounded-md bg-tg-secondary-bg text-xs text-tg-hint">
                📁 {{ getParentActivity() }}
              </span>
            </div>

            <!-- Title -->
            <h2 v-if="!isEditing" class="text-lg font-bold text-tg-text mb-2">
              {{ getDisplayTitle() }}
            </h2>

            <!-- Description if available -->
            <p v-if="!isEditing && store.currentItem.target?.description" class="text-sm text-tg-text mb-3">
              {{ store.currentItem.target.description }}
            </p>

            <!-- Edit Form (shown when editing) -->
            <div v-if="isEditing" class="space-y-3 mb-3">
              <!-- Name/Title -->
              <div>
                <label class="block text-xs text-tg-hint mb-1">Название</label>
                <input
                  v-model="editForm.name"
                  type="text"
                  class="w-full px-3 py-2 rounded-lg bg-tg-secondary-bg text-tg-text border border-transparent focus:border-tg-button focus:outline-none"
                  placeholder="Название задачи"
                />
              </div>

              <!-- Description -->
              <div>
                <label class="block text-xs text-tg-hint mb-1">Описание</label>
                <textarea
                  v-model="editForm.description"
                  rows="2"
                  class="w-full px-3 py-2 rounded-lg bg-tg-secondary-bg text-tg-text border border-transparent focus:border-tg-button focus:outline-none resize-none"
                  placeholder="Описание (необязательно)"
                />
              </div>

              <!-- Priority -->
              <div>
                <label class="block text-xs text-tg-hint mb-1">Приоритет</label>
                <select
                  v-model="editForm.priority"
                  class="w-full px-3 py-2 rounded-lg bg-tg-secondary-bg text-tg-text border border-transparent focus:border-tg-button focus:outline-none"
                >
                  <option value="">Не указан</option>
                  <option value="critical">🔴 Критичный</option>
                  <option value="high">🔴 Высокий</option>
                  <option value="medium">🟡 Средний</option>
                  <option value="low">🟢 Низкий</option>
                </select>
              </div>

              <!-- Deadline -->
              <div>
                <label class="block text-xs text-tg-hint mb-1">Дедлайн</label>
                <input
                  v-model="editForm.deadline"
                  type="date"
                  class="w-full px-3 py-2 rounded-lg bg-tg-secondary-bg text-tg-text border border-transparent focus:border-tg-button focus:outline-none"
                />
              </div>

              <!-- Edit actions -->
              <div class="flex gap-2 pt-2">
                <button
                  class="btn btn-secondary flex-1"
                  :disabled="store.isProcessing"
                  @click="cancelEditing"
                >
                  Отмена
                </button>
                <button
                  class="btn btn-primary flex-1"
                  :disabled="store.isProcessing"
                  @click="saveEdits"
                >
                  {{ store.isProcessing ? 'Сохранение...' : 'Сохранить' }}
                </button>
              </div>
            </div>

            <!-- Edit button (shown when not editing) -->
            <button
              v-if="!isEditing && canEdit && store.currentItem.status === 'pending'"
              class="text-sm text-tg-link hover:underline mb-3"
              @click="startEditing"
            >
              ✏️ Редактировать
            </button>

            <!-- Metadata badges row (hidden when editing) -->
            <div v-if="!isEditing && (getCounterparty() || getDueDate() || getPriority())" class="flex flex-wrap gap-2 mb-3">
              <span v-if="getCounterparty()" class="inline-flex items-center px-2 py-1 rounded-md bg-tg-secondary-bg text-xs">
                👤 {{ getCounterparty() }}
              </span>
              <span v-if="getDueDate()" class="inline-flex items-center px-2 py-1 rounded-md bg-tg-secondary-bg text-xs">
                📅 {{ getDueDate() }}
              </span>
              <span v-if="getPriority()" class="inline-flex items-center px-2 py-1 rounded-md bg-tg-secondary-bg text-xs">
                {{ getPriority() }}
              </span>
            </div>

            <!-- Source Quote (reasoning/context) -->
            <div v-if="store.currentItem.sourceQuote" class="mt-3 pt-3 border-t border-tg-secondary-bg">
              <div class="flex items-center justify-between mb-1">
                <p class="text-xs text-tg-hint">Источник:</p>
                <button
                  v-if="hasSourceLink()"
                  class="text-xs text-tg-link hover:underline"
                  @click="openSourceMessage"
                >
                  Открыть в чате →
                </button>
              </div>
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
      </div>

      <!-- Fixed Navigation & Actions Footer -->
      <div
        class="fixed bottom-0 left-0 right-0 p-4 border-t border-tg-secondary-bg bg-tg-bg z-20"
        :style="{ paddingBottom: 'calc(var(--tg-content-safe-area-inset-bottom, 0px) + 1rem)' }"
      >
        <!-- Primary action -->
        <button
          class="btn btn-primary w-full mb-3"
          :disabled="store.isProcessing || store.currentItem.status !== 'pending'"
          @click="handleApprove"
        >
          {{ store.isProcessing ? 'Обработка...' : 'Подтвердить' }}
        </button>

        <!-- Secondary actions row -->
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
    <div v-else class="min-h-screen flex flex-col items-center justify-center p-6 text-center">
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
