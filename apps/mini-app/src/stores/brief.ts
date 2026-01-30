import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'

interface BriefItem {
  idx: number
  type: string
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  completed: boolean
  entityId?: string
  entityName?: string
}

interface Brief {
  id: string
  date: string
  items: BriefItem[]
}

export const useBriefStore = defineStore('brief', () => {
  const brief = ref<Brief | null>(null)
  const isLoading = ref(false)
  const isProcessing = ref(false)
  const error = ref<string | null>(null)
  const expandedItems = ref<Set<number>>(new Set())

  const completedCount = computed(() => {
    if (!brief.value) return 0
    return brief.value.items.filter(i => i.completed).length
  })

  const progress = computed(() => {
    if (!brief.value) return { completed: 0, total: 0, percent: 0 }
    const total = brief.value.items.length
    const completed = completedCount.value
    return {
      completed,
      total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  })

  const groupedItems = computed(() => {
    if (!brief.value) return { high: [], medium: [], low: [] }

    const groups: Record<'high' | 'medium' | 'low', BriefItem[]> = {
      high: [],
      medium: [],
      low: [],
    }

    for (const item of brief.value.items) {
      groups[item.priority].push(item)
    }

    return groups
  })

  async function load(briefId: string) {
    if (isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const data = await api.getBrief(briefId)
      brief.value = data
    } catch (e) {
      error.value = 'Не удалось загрузить бриф'
      console.error('Failed to load brief:', e)
    } finally {
      isLoading.value = false
    }
  }

  async function performAction(itemIdx: number, action: string) {
    if (!brief.value || isProcessing.value) return

    isProcessing.value = true

    try {
      await api.briefItemAction(brief.value.id, itemIdx, action)

      // Update local state
      const item = brief.value.items.find(i => i.idx === itemIdx)
      if (item && action === 'done') {
        item.completed = true
      }
    } catch (e) {
      error.value = 'Не удалось выполнить действие'
      console.error('Failed to perform action:', e)
    } finally {
      isProcessing.value = false
    }
  }

  function toggleExpanded(itemIdx: number) {
    if (expandedItems.value.has(itemIdx)) {
      expandedItems.value.delete(itemIdx)
    } else {
      expandedItems.value.add(itemIdx)
    }
  }

  function isExpanded(itemIdx: number): boolean {
    return expandedItems.value.has(itemIdx)
  }

  function reset() {
    brief.value = null
    error.value = null
    expandedItems.value.clear()
  }

  return {
    brief,
    isLoading,
    isProcessing,
    error,
    completedCount,
    progress,
    groupedItems,
    expandedItems,
    load,
    performAction,
    toggleExpanded,
    isExpanded,
    reset,
  }
})
