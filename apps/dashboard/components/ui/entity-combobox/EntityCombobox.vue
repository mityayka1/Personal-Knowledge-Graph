<script setup lang="ts">
import { ref, computed, watch, toRef } from 'vue';
import { Search, Loader2, User, Building2, X } from 'lucide-vue-next';
import { useDebounceFn, onClickOutside } from '@vueuse/core';
import { useEntities, useEntity, type EntityListParams } from '~/composables/useEntities';

interface Props {
  modelValue: string;
  entityType?: 'person' | 'organization';
  placeholder?: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: 'Поиск...',
  disabled: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
}>();

// Search state
const searchInput = ref('');
const debouncedSearchQuery = ref('');
const showDropdown = ref(false);
const containerRef = ref<HTMLElement | null>(null);

// Debounced search
const debouncedSearch = useDebounceFn((value: string) => {
  debouncedSearchQuery.value = value;
}, 300);

watch(searchInput, (value) => {
  debouncedSearch(value);
  showDropdown.value = value.length > 0;
});

// Search results
const searchParams = computed<EntityListParams>(() => ({
  search: debouncedSearchQuery.value || undefined,
  limit: 10,
  type: props.entityType,
}));

const { data: searchResults, isLoading: isSearching } = useEntities(searchParams);

const filteredResults = computed(() => {
  if (!debouncedSearchQuery.value) return [];
  return searchResults.value?.items || [];
});

// Resolve selected entity name by ID
const selectedId = toRef(props, 'modelValue');
const { data: selectedEntity } = useEntity(selectedId);

const selectedName = computed(() => {
  if (!props.modelValue) return '';
  return selectedEntity.value?.name || '';
});

const selectedType = computed(() => {
  return selectedEntity.value?.type || 'person';
});

// Actions
function selectEntity(entity: { id: string; name: string }) {
  emit('update:modelValue', entity.id);
  searchInput.value = '';
  debouncedSearchQuery.value = '';
  showDropdown.value = false;
}

function clearSelection() {
  emit('update:modelValue', '');
  searchInput.value = '';
  debouncedSearchQuery.value = '';
}

function handleFocus() {
  if (searchInput.value) {
    showDropdown.value = true;
  }
}

// Close dropdown on click outside
onClickOutside(containerRef, () => {
  showDropdown.value = false;
});
</script>

<template>
  <div ref="containerRef" class="relative">
    <!-- Selected entity display -->
    <div
      v-if="modelValue && selectedName"
      class="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm"
    >
      <div class="flex items-center gap-2 min-w-0">
        <User v-if="selectedType === 'person'" class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Building2 v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="truncate">{{ selectedName }}</span>
      </div>
      <button
        v-if="!disabled"
        type="button"
        class="shrink-0 ml-2 text-muted-foreground hover:text-foreground"
        @click="clearSelection"
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <!-- Search input -->
    <div v-else class="relative">
      <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <input
        v-model="searchInput"
        type="text"
        :placeholder="placeholder"
        :disabled="disabled"
        class="flex h-10 w-full rounded-md border border-input bg-background pl-9 pr-9 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        @focus="handleFocus"
      />
      <Loader2
        v-if="isSearching && searchInput"
        class="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground"
      />
    </div>

    <!-- Dropdown results -->
    <div
      v-if="showDropdown && searchInput"
      class="absolute z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md"
    >
      <button
        v-for="entity in filteredResults"
        :key="entity.id"
        type="button"
        class="flex w-full items-center gap-3 p-2 hover:bg-accent text-left"
        @click="selectEntity(entity)"
      >
        <div
          :class="[
            'h-7 w-7 rounded-full flex items-center justify-center shrink-0',
            entity.type === 'person' ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400',
          ]"
        >
          <User v-if="entity.type === 'person'" class="h-3.5 w-3.5" />
          <Building2 v-else class="h-3.5 w-3.5" />
        </div>
        <div class="min-w-0">
          <div class="text-sm truncate">{{ entity.name }}</div>
          <div class="text-xs text-muted-foreground">
            {{ entity.type === 'person' ? 'Человек' : 'Организация' }}
          </div>
        </div>
      </button>

      <!-- No results -->
      <div
        v-if="!isSearching && filteredResults.length === 0 && debouncedSearchQuery"
        class="text-center py-3 text-sm text-muted-foreground"
      >
        Ничего не найдено
      </div>
    </div>
  </div>
</template>
