import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

export interface PendingApprovalItem {
  id: string
  itemType: 'fact' | 'project' | 'task' | 'commitment'
  targetId: string
  confidence: number
  sourceQuote: string | null
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  target?: {
    // Common fields
    name?: string
    title?: string
    value?: string
    preview?: string
    // Fact fields
    factType?: string
    // Commitment fields
    description?: string
    type?: string
    typeName?: string
    dueDate?: string
    priority?: string
    fromEntity?: {
      id: string
      name: string
    }
    toEntity?: {
      id: string
      name: string
    }
  }
}

export interface BatchStats {
  total: number
  pending: number
  approved: number
  rejected: number
}

export const usePendingApprovalStore = defineStore('pendingApproval', () => {
  // State
  const items = ref<PendingApprovalItem[]>([])
  const currentIndex = ref(0)
  const loading = ref(false)
  const isProcessing = ref(false)
  const error = ref<string | null>(null)
  const batchId = ref<string | null>(null)
  const stats = ref<BatchStats | null>(null)

  // Computed
  const currentItem = computed(() => items.value[currentIndex.value] || null)

  const progress = computed(() => ({
    current: currentIndex.value + 1,
    total: items.value.length,
    percent: items.value.length > 0 ? Math.round(((currentIndex.value + 1) / items.value.length) * 100) : 0,
    pending: stats.value?.pending ?? 0,
    approved: stats.value?.approved ?? 0,
    rejected: stats.value?.rejected ?? 0,
  }))

  const isComplete = computed(() => {
    if (items.value.length === 0) return false
    return currentIndex.value >= items.value.length
  })

  const pendingItems = computed(() => items.value.filter((i) => i.status === 'pending'))

  // Actions
  async function load(id: string) {
    if (loading.value) return

    loading.value = true
    error.value = null
    batchId.value = id

    try {
      const [approvals, batchStats] = await Promise.all([
        api.getPendingApprovals({ batchId: id, status: 'pending', limit: 100 }),
        api.getPendingApprovalBatchStats(id),
      ])

      items.value = approvals.items
      stats.value = batchStats
      currentIndex.value = 0
    } catch (e) {
      error.value = 'Не удалось загрузить данные'
      console.error('Failed to load pending approvals:', e)
    } finally {
      loading.value = false
    }
  }

  async function approve() {
    const item = currentItem.value
    if (!item || isProcessing.value) return

    isProcessing.value = true

    try {
      await api.approvePendingApproval(item.id)

      item.status = 'approved'
      if (stats.value) {
        stats.value.approved++
        stats.value.pending--
      }

      moveToNextPending()
    } catch (e) {
      error.value = 'Не удалось подтвердить'
      console.error('Failed to approve:', e)
    } finally {
      isProcessing.value = false
    }
  }

  async function reject() {
    const item = currentItem.value
    if (!item || isProcessing.value) return

    isProcessing.value = true

    try {
      await api.rejectPendingApproval(item.id)

      item.status = 'rejected'
      if (stats.value) {
        stats.value.rejected++
        stats.value.pending--
      }

      moveToNextPending()
    } catch (e) {
      error.value = 'Не удалось отклонить'
      console.error('Failed to reject:', e)
    } finally {
      isProcessing.value = false
    }
  }

  function skip() {
    moveToNextPending()
  }

  async function approveAll() {
    if (!batchId.value || isProcessing.value) return

    isProcessing.value = true

    try {
      const result = await api.approvePendingBatch(batchId.value)

      // Update local state
      items.value.forEach((item) => {
        if (item.status === 'pending') {
          item.status = 'approved'
        }
      })

      if (stats.value) {
        stats.value.approved += result.approved
        stats.value.pending = 0
      }

      // Mark as complete
      currentIndex.value = items.value.length
    } catch (e) {
      error.value = 'Не удалось подтвердить все'
      console.error('Failed to approve all:', e)
    } finally {
      isProcessing.value = false
    }
  }

  async function rejectAll() {
    if (!batchId.value || isProcessing.value) return

    isProcessing.value = true

    try {
      const result = await api.rejectPendingBatch(batchId.value)

      // Update local state
      items.value.forEach((item) => {
        if (item.status === 'pending') {
          item.status = 'rejected'
        }
      })

      if (stats.value) {
        stats.value.rejected += result.rejected
        stats.value.pending = 0
      }

      // Mark as complete
      currentIndex.value = items.value.length
    } catch (e) {
      error.value = 'Не удалось отклонить все'
      console.error('Failed to reject all:', e)
    } finally {
      isProcessing.value = false
    }
  }

  function moveToNextPending() {
    const startIndex = currentIndex.value
    const total = items.value.length

    // Look for next pending item from current position
    for (let i = startIndex + 1; i < total; i++) {
      if (items.value[i]?.status === 'pending') {
        currentIndex.value = i
        return
      }
    }

    // Wrap around and look from start
    for (let i = 0; i < startIndex; i++) {
      if (items.value[i]?.status === 'pending') {
        currentIndex.value = i
        return
      }
    }

    // No more pending items - mark as complete
    currentIndex.value = total
  }

  function goToIndex(index: number) {
    if (index >= 0 && index < items.value.length) {
      currentIndex.value = index
    }
  }

  function reset() {
    items.value = []
    currentIndex.value = 0
    loading.value = false
    isProcessing.value = false
    error.value = null
    batchId.value = null
    stats.value = null
  }

  return {
    items,
    currentIndex,
    loading,
    isProcessing,
    error,
    batchId,
    stats,
    currentItem,
    progress,
    isComplete,
    pendingItems,
    load,
    approve,
    reject,
    skip,
    approveAll,
    rejectAll,
    goToIndex,
    reset,
  }
})
