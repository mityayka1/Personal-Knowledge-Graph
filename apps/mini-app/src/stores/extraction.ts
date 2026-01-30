import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

interface ExtractionItem {
  id: string
  type: 'project' | 'commitment' | 'action_item' | 'deadline' | 'contact'
  title: string
  description?: string
  confidence: number
  fields: Record<string, unknown>
  status: 'pending' | 'confirmed' | 'skipped'
}

interface ExtractionState {
  id: string
  items: ExtractionItem[]
  currentIndex: number
  totalCount: number
  confirmedCount: number
  skippedCount: number
}

export const useExtractionStore = defineStore('extraction', () => {
  const state = ref<ExtractionState | null>(null)
  const isLoading = ref(false)
  const isProcessing = ref(false)
  const error = ref<string | null>(null)

  const currentItem = computed(() => {
    if (!state.value) return null
    return state.value.items[state.value.currentIndex] || null
  })

  const progress = computed(() => {
    if (!state.value) return { current: 0, total: 0, percent: 0 }
    const { currentIndex, totalCount } = state.value
    return {
      current: currentIndex + 1,
      total: totalCount,
      percent: Math.round(((currentIndex + 1) / totalCount) * 100),
    }
  })

  const isComplete = computed(() => {
    if (!state.value) return false
    return state.value.currentIndex >= state.value.items.length
  })

  const stats = computed(() => {
    if (!state.value) return { confirmed: 0, skipped: 0, remaining: 0 }
    return {
      confirmed: state.value.confirmedCount,
      skipped: state.value.skippedCount,
      remaining: state.value.items.filter(i => i.status === 'pending').length,
    }
  })

  async function load(carouselId: string) {
    if (isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const data = await api.getExtraction(carouselId)
      state.value = data
    } catch (e) {
      error.value = 'Не удалось загрузить данные'
      console.error('Failed to load extraction:', e)
    } finally {
      isLoading.value = false
    }
  }

  async function confirmCurrent(carouselId: string, edits?: Record<string, unknown>) {
    const item = currentItem.value
    if (!item || isProcessing.value) return

    isProcessing.value = true

    try {
      const result = await api.confirmExtraction(carouselId, item.id, edits)

      if (state.value) {
        item.status = 'confirmed'
        state.value.confirmedCount++

        if (result.nextIndex !== undefined) {
          state.value.currentIndex = result.nextIndex
        } else {
          moveToNextPending()
        }
      }
    } catch (e) {
      error.value = 'Не удалось подтвердить'
      console.error('Failed to confirm:', e)
    } finally {
      isProcessing.value = false
    }
  }

  async function skipCurrent(carouselId: string, reason?: string) {
    const item = currentItem.value
    if (!item || isProcessing.value) return

    isProcessing.value = true

    try {
      const result = await api.skipExtraction(carouselId, item.id, reason)

      if (state.value) {
        item.status = 'skipped'
        state.value.skippedCount++

        if (result.nextIndex !== undefined) {
          state.value.currentIndex = result.nextIndex
        } else {
          moveToNextPending()
        }
      }
    } catch (e) {
      error.value = 'Не удалось пропустить'
      console.error('Failed to skip:', e)
    } finally {
      isProcessing.value = false
    }
  }

  function moveToNextPending() {
    if (!state.value) return

    const startIndex = state.value.currentIndex
    const items = state.value.items

    // Look for next pending item
    for (let i = startIndex + 1; i < items.length; i++) {
      if (items[i]?.status === 'pending') {
        state.value.currentIndex = i
        return
      }
    }

    // Wrap around and look from start
    for (let i = 0; i < startIndex; i++) {
      if (items[i]?.status === 'pending') {
        state.value.currentIndex = i
        return
      }
    }

    // No more pending items - mark as complete
    state.value.currentIndex = items.length
  }

  function goToIndex(index: number) {
    if (!state.value) return
    if (index >= 0 && index < state.value.items.length) {
      state.value.currentIndex = index
    }
  }

  function reset() {
    state.value = null
    error.value = null
  }

  return {
    state,
    isLoading,
    isProcessing,
    error,
    currentItem,
    progress,
    isComplete,
    stats,
    load,
    confirmCurrent,
    skipCurrent,
    goToIndex,
    reset,
  }
})
