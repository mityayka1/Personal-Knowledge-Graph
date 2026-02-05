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
  sourceInteractionId?: string | null
  messageRef?: string | null
  target?: {
    // Common fields
    name?: string
    title?: string
    value?: string
    preview?: string
    description?: string
    dueDate?: string
    priority?: number | string
    // Fact fields
    factType?: string
    // Commitment fields
    type?: string
    typeName?: string
    fromEntity?: { id: string; name: string } | null
    toEntity?: { id: string; name: string } | null
    // Activity fields (task/project)
    parentActivity?: { id: string; name: string } | null
    ownerEntity?: { id: string; name: string } | null
    clientEntity?: { id: string; name: string } | null
    assignee?: string
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
  /**
   * Load pending approvals.
   * @param id - batchId or 'all' to load all pending items
   */
  async function load(id: string) {
    if (loading.value) return

    loading.value = true
    error.value = null
    batchId.value = id === 'all' ? null : id

    try {
      // If 'all', load without batchId filter
      const params =
        id === 'all'
          ? { status: 'pending' as const, limit: 100 }
          : { batchId: id, status: 'pending' as const, limit: 100 }

      const [approvals, approvalStats] = await Promise.all([
        api.getPendingApprovals(params),
        id === 'all' ? api.getPendingApprovalGlobalStats() : api.getPendingApprovalBatchStats(id),
      ])

      items.value = approvals.items
      stats.value = approvalStats
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
    if (isProcessing.value) return

    isProcessing.value = true

    try {
      let approvedCount = 0

      if (batchId.value) {
        // Batch mode - use batch endpoint
        const result = await api.approvePendingBatch(batchId.value)
        approvedCount = result.approved
      } else {
        // All mode - approve one by one
        const pendingToApprove = items.value.filter((i) => i.status === 'pending')
        for (const item of pendingToApprove) {
          await api.approvePendingApproval(item.id)
          item.status = 'approved'
          approvedCount++
        }
      }

      // Update local state
      items.value.forEach((item) => {
        if (item.status === 'pending') {
          item.status = 'approved'
        }
      })

      if (stats.value) {
        stats.value.approved += approvedCount
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
    if (isProcessing.value) return

    isProcessing.value = true

    try {
      let rejectedCount = 0

      if (batchId.value) {
        // Batch mode - use batch endpoint
        const result = await api.rejectPendingBatch(batchId.value)
        rejectedCount = result.rejected
      } else {
        // All mode - reject one by one
        const pendingToReject = items.value.filter((i) => i.status === 'pending')
        for (const item of pendingToReject) {
          await api.rejectPendingApproval(item.id)
          item.status = 'rejected'
          rejectedCount++
        }
      }

      // Update local state
      items.value.forEach((item) => {
        if (item.status === 'pending') {
          item.status = 'rejected'
        }
      })

      if (stats.value) {
        stats.value.rejected += rejectedCount
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

  /**
   * Update the target entity of current pending approval.
   * Used for editing before approval.
   */
  async function updateTarget(updates: {
    name?: string
    description?: string
    priority?: string
    deadline?: string | null
    parentId?: string | null
    clientEntityId?: string | null
    assignee?: string | null
  }) {
    const item = currentItem.value
    if (!item || isProcessing.value) return

    isProcessing.value = true

    try {
      const updatedApproval = await api.updatePendingApprovalTarget(item.id, updates)

      // Update local item with new target data
      const itemIndex = items.value.findIndex((i) => i.id === item.id)
      if (itemIndex !== -1 && updatedApproval.target) {
        const existingItem = items.value[itemIndex]
        if (existingItem) {
          // Merge updated target data
          items.value[itemIndex] = {
            ...existingItem,
            target: updatedApproval.target as PendingApprovalItem['target'],
          }
        }
      }

      return true
    } catch (e) {
      error.value = 'Не удалось сохранить изменения'
      console.error('Failed to update target:', e)
      return false
    } finally {
      isProcessing.value = false
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
    updateTarget,
    reset,
  }
})
