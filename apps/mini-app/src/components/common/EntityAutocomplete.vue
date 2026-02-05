<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api } from '@/api/client'

interface EntityOption {
  id: string
  name: string
  type: 'person' | 'organization'
}

const props = defineProps<{
  modelValue: string | null
  placeholder?: string
  disabled?: boolean
  selfOption?: { id: string; name: string } | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string | null]
}>()

// State
const searchQuery = ref('')
const isOpen = ref(false)
const isLoading = ref(false)
const results = ref<EntityOption[]>([])
const selectedEntity = ref<EntityOption | null>(null)
const inputRef = ref<HTMLInputElement | null>(null)

// Throttle timer
let searchTimeout: ReturnType<typeof setTimeout> | null = null
const THROTTLE_MS = 300

// Load selected entity name on mount if we have a value
onMounted(async () => {
  if (props.modelValue && props.modelValue !== 'self') {
    // Check if it's the self option
    if (props.selfOption && props.modelValue === props.selfOption.id) {
      selectedEntity.value = { ...props.selfOption, type: 'person' }
    } else {
      // Try to find in initial search or fetch
      try {
        const response = await api.getEntity(props.modelValue)
        selectedEntity.value = {
          id: response.id,
          name: response.name,
          type: response.type,
        }
      } catch {
        // Entity not found, clear selection
        selectedEntity.value = null
      }
    }
  }
})

// Display value for input
const displayValue = computed(() => {
  if (selectedEntity.value) {
    return selectedEntity.value.name
  }
  return searchQuery.value
})

// Filtered results (exclude self option from regular results if present)
const filteredResults = computed(() => {
  if (props.selfOption) {
    return results.value.filter(e => e.id !== props.selfOption!.id)
  }
  return results.value
})

// Show self option at top if matches search or search is empty
const showSelfOption = computed(() => {
  if (!props.selfOption) return false
  if (!searchQuery.value) return true
  return props.selfOption.name.toLowerCase().includes(searchQuery.value.toLowerCase())
})

function handleInput(event: Event) {
  const value = (event.target as HTMLInputElement).value
  searchQuery.value = value
  selectedEntity.value = null
  emit('update:modelValue', null)

  // Throttled search
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }

  if (value.length >= 2) {
    searchTimeout = setTimeout(() => {
      performSearch(value)
    }, THROTTLE_MS)
  } else {
    results.value = []
  }
}

async function performSearch(query: string) {
  isLoading.value = true
  try {
    const response = await api.getEntities({ search: query, limit: 20 })
    results.value = response.items
    isOpen.value = true
  } catch (e) {
    console.error('Search failed:', e)
    results.value = []
  } finally {
    isLoading.value = false
  }
}

function selectEntity(entity: EntityOption) {
  selectedEntity.value = entity
  searchQuery.value = ''
  isOpen.value = false
  emit('update:modelValue', entity.id)
}

function selectSelf() {
  if (!props.selfOption) return
  selectedEntity.value = { ...props.selfOption, type: 'person' }
  searchQuery.value = ''
  isOpen.value = false
  emit('update:modelValue', props.selfOption.id)
}

function clearSelection() {
  selectedEntity.value = null
  searchQuery.value = ''
  emit('update:modelValue', null)
  inputRef.value?.focus()
}

function handleFocus() {
  isOpen.value = true
  // Show initial results if no search yet
  if (results.value.length === 0 && !searchQuery.value) {
    performSearch('')
  }
}

function handleBlur() {
  // Delay to allow click on dropdown item
  setTimeout(() => {
    isOpen.value = false
  }, 200)
}

// Cleanup on unmount
onUnmounted(() => {
  if (searchTimeout) {
    clearTimeout(searchTimeout)
  }
})

// Watch for external value changes
watch(() => props.modelValue, async (newValue) => {
  if (!newValue) {
    selectedEntity.value = null
    searchQuery.value = ''
  } else if (newValue !== selectedEntity.value?.id) {
    // Value changed externally, fetch entity
    if (props.selfOption && newValue === props.selfOption.id) {
      selectedEntity.value = { ...props.selfOption, type: 'person' }
    } else {
      try {
        const response = await api.getEntity(newValue)
        selectedEntity.value = {
          id: response.id,
          name: response.name,
          type: response.type,
        }
      } catch {
        selectedEntity.value = null
      }
    }
  }
})
</script>

<template>
  <div class="relative">
    <!-- Input with selected value or search -->
    <div class="relative">
      <input
        ref="inputRef"
        type="text"
        :value="displayValue"
        :placeholder="placeholder || 'Поиск...'"
        :disabled="disabled"
        class="w-full px-3 py-2 pr-8 rounded-lg bg-tg-secondary-bg text-tg-text border border-transparent focus:border-tg-button focus:outline-none"
        @input="handleInput"
        @focus="handleFocus"
        @blur="handleBlur"
      />
      <!-- Clear button -->
      <button
        v-if="selectedEntity"
        type="button"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-tg-hint hover:text-tg-text"
        @click.prevent="clearSelection"
      >
        ✕
      </button>
      <!-- Loading indicator -->
      <span
        v-else-if="isLoading"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-tg-hint text-xs"
      >
        ...
      </span>
    </div>

    <!-- Dropdown -->
    <div
      v-if="isOpen && (showSelfOption || filteredResults.length > 0 || isLoading)"
      class="absolute z-50 w-full mt-1 bg-tg-bg border border-tg-secondary-bg rounded-lg shadow-lg max-h-48 overflow-y-auto"
    >
      <!-- Self option -->
      <button
        v-if="showSelfOption && selfOption"
        type="button"
        class="w-full px-3 py-2 text-left hover:bg-tg-secondary-bg text-tg-text border-b border-tg-secondary-bg"
        @mousedown.prevent="selectSelf"
      >
        <span class="font-medium">Себе</span>
        <span class="text-tg-hint text-sm ml-1">({{ selfOption.name }})</span>
      </button>

      <!-- Search results -->
      <button
        v-for="entity in filteredResults"
        :key="entity.id"
        type="button"
        class="w-full px-3 py-2 text-left hover:bg-tg-secondary-bg text-tg-text"
        @mousedown.prevent="selectEntity(entity)"
      >
        <span>{{ entity.name }}</span>
        <span class="text-tg-hint text-xs ml-2">{{ entity.type === 'person' ? '👤' : '🏢' }}</span>
      </button>

      <!-- Loading state -->
      <div v-if="isLoading && filteredResults.length === 0" class="px-3 py-2 text-tg-hint text-sm">
        Поиск...
      </div>

      <!-- No results -->
      <div v-if="!isLoading && filteredResults.length === 0 && searchQuery.length >= 2 && !showSelfOption" class="px-3 py-2 text-tg-hint text-sm">
        Ничего не найдено
      </div>
    </div>
  </div>
</template>
