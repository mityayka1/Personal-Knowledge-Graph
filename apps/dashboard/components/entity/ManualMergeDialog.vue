<script setup lang="ts">
import { Search, Loader2, User, Building2, ArrowRight, AlertCircle } from 'lucide-vue-next';
import { useDebounceFn } from '@vueuse/core';
import { useEntities, type Entity } from '~/composables/useEntities';

const emit = defineEmits<{
  select: [sourceId: string, targetId: string];
}>();

const open = defineModel<boolean>('open', { default: false });

// Step: 1 = select source, 2 = select target
const step = ref<1 | 2>(1);

// Selected entities
const selectedSource = ref<Entity | null>(null);
const selectedTarget = ref<Entity | null>(null);

// Search for source entity (step 1)
const sourceSearchInput = ref('');
const debouncedSourceQuery = ref('');
const debouncedSourceSearch = useDebounceFn((value: string) => {
  debouncedSourceQuery.value = value;
}, 300);

// Search for target entity (step 2)
const targetSearchInput = ref('');
const debouncedTargetQuery = ref('');
const debouncedTargetSearch = useDebounceFn((value: string) => {
  debouncedTargetQuery.value = value;
}, 300);

// Watch search inputs
watch(sourceSearchInput, (value) => debouncedSourceSearch(value));
watch(targetSearchInput, (value) => debouncedTargetSearch(value));

// Source search params
const sourceSearchParams = computed(() => ({
  search: debouncedSourceQuery.value,
  limit: 10,
}));

// Target search params
const targetSearchParams = computed(() => ({
  search: debouncedTargetQuery.value,
  limit: 10,
}));

const { data: sourceResults, isLoading: isSourceSearching } = useEntities(sourceSearchParams);
const { data: targetResults, isLoading: isTargetSearching } = useEntities(targetSearchParams);

// Filter out already selected source from target results
const filteredTargetResults = computed(() => {
  if (!targetResults.value?.items) return [];
  if (!selectedSource.value) return targetResults.value.items;
  return targetResults.value.items.filter(e => e.id !== selectedSource.value!.id);
});

// Filter source results (all entities available)
const filteredSourceResults = computed(() => {
  return sourceResults.value?.items || [];
});

function selectSource(entity: Entity) {
  selectedSource.value = entity;
  sourceSearchInput.value = '';
  debouncedSourceQuery.value = '';
  step.value = 2;
}

function selectTarget(entity: Entity) {
  selectedTarget.value = entity;
  targetSearchInput.value = '';
  debouncedTargetQuery.value = '';
}

function changeSource() {
  selectedSource.value = null;
  selectedTarget.value = null;
  step.value = 1;
}

function changeTarget() {
  selectedTarget.value = null;
}

function handleConfirm() {
  if (selectedSource.value && selectedTarget.value) {
    emit('select', selectedSource.value.id, selectedTarget.value.id);
    resetAndClose();
  }
}

function resetAndClose() {
  selectedSource.value = null;
  selectedTarget.value = null;
  sourceSearchInput.value = '';
  targetSearchInput.value = '';
  debouncedSourceQuery.value = '';
  debouncedTargetQuery.value = '';
  step.value = 1;
  open.value = false;
}

// Reset when dialog closes
watch(open, (isOpen) => {
  if (!isOpen) {
    selectedSource.value = null;
    selectedTarget.value = null;
    sourceSearchInput.value = '';
    targetSearchInput.value = '';
    debouncedSourceQuery.value = '';
    debouncedTargetQuery.value = '';
    step.value = 1;
  }
});

const canConfirm = computed(() => {
  return selectedSource.value && selectedTarget.value;
});
</script>

<template>
  <ClientOnly>
    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Объединить сущности вручную</DialogTitle>
          <DialogDescription>
            <template v-if="step === 1">
              Шаг 1: Выберите сущность, которая будет <span class="text-red-500 font-medium">удалена</span> (её данные перенесутся)
            </template>
            <template v-else>
              Шаг 2: Выберите сущность, которая <span class="text-green-500 font-medium">останется</span> (получит данные)
            </template>
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4 py-4">
          <!-- Progress indicator -->
          <div class="flex items-center gap-2 text-sm">
            <div
              :class="[
                'h-6 w-6 rounded-full flex items-center justify-center text-xs font-medium',
                step >= 1 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              ]"
            >
              1
            </div>
            <div class="h-px flex-1 bg-muted" />
            <div
              :class="[
                'h-6 w-6 rounded-full flex items-center justify-center text-xs font-medium',
                step >= 2 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
              ]"
            >
              2
            </div>
          </div>

          <!-- Source entity selection (step 1) or display -->
          <div class="space-y-2">
            <label class="text-sm font-medium flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-red-500" />
              Удалить (источник)
            </label>

            <!-- Selected source display -->
            <div
              v-if="selectedSource"
              class="flex items-center justify-between p-3 rounded-lg border bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-900"
            >
              <div class="flex items-center gap-3">
                <div
                  :class="[
                    'h-8 w-8 rounded-full flex items-center justify-center',
                    selectedSource.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
                  ]"
                >
                  <User v-if="selectedSource.type === 'person'" class="h-4 w-4" />
                  <Building2 v-else class="h-4 w-4" />
                </div>
                <div>
                  <div class="font-medium">{{ selectedSource.name }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ selectedSource.type === 'person' ? 'Человек' : 'Организация' }}
                    <span v-if="selectedSource.identifiers?.length">
                      · {{ selectedSource.identifiers.length }} идент.
                    </span>
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="sm" @click="changeSource">
                Изменить
              </Button>
            </div>

            <!-- Source search (step 1) -->
            <div v-else-if="step === 1" class="space-y-2">
              <div class="relative">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  v-model="sourceSearchInput"
                  placeholder="Поиск по имени..."
                  class="pl-9"
                  autofocus
                />
                <Loader2
                  v-if="isSourceSearching"
                  class="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground"
                />
              </div>

              <!-- Search results -->
              <div
                v-if="sourceSearchInput && filteredSourceResults.length > 0"
                class="max-h-48 overflow-y-auto rounded-md border bg-popover"
              >
                <button
                  v-for="entity in filteredSourceResults"
                  :key="entity.id"
                  type="button"
                  class="flex w-full items-center gap-3 p-2 hover:bg-accent text-left"
                  @click="selectSource(entity)"
                >
                  <div
                    :class="[
                      'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
                      entity.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
                    ]"
                  >
                    <User v-if="entity.type === 'person'" class="h-4 w-4" />
                    <Building2 v-else class="h-4 w-4" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="font-medium truncate">{{ entity.name }}</div>
                    <div class="text-xs text-muted-foreground">
                      {{ entity.type === 'person' ? 'Человек' : 'Организация' }}
                      <span v-if="entity.identifiers?.length">
                        · {{ entity.identifiers.length }} идент.
                      </span>
                    </div>
                  </div>
                </button>
              </div>

              <!-- No results -->
              <div
                v-else-if="sourceSearchInput && !isSourceSearching && filteredSourceResults.length === 0"
                class="text-center py-4 text-sm text-muted-foreground"
              >
                Ничего не найдено
              </div>
            </div>
          </div>

          <!-- Arrow between entities -->
          <div v-if="selectedSource" class="flex justify-center">
            <ArrowRight class="h-5 w-5 text-muted-foreground" />
          </div>

          <!-- Target entity selection (step 2) -->
          <div v-if="step === 2" class="space-y-2">
            <label class="text-sm font-medium flex items-center gap-2">
              <span class="h-2 w-2 rounded-full bg-green-500" />
              Оставить (цель)
            </label>

            <!-- Selected target display -->
            <div
              v-if="selectedTarget"
              class="flex items-center justify-between p-3 rounded-lg border bg-green-50/50 dark:bg-green-950/20 border-green-200 dark:border-green-900"
            >
              <div class="flex items-center gap-3">
                <div
                  :class="[
                    'h-8 w-8 rounded-full flex items-center justify-center',
                    selectedTarget.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
                  ]"
                >
                  <User v-if="selectedTarget.type === 'person'" class="h-4 w-4" />
                  <Building2 v-else class="h-4 w-4" />
                </div>
                <div>
                  <div class="font-medium">{{ selectedTarget.name }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ selectedTarget.type === 'person' ? 'Человек' : 'Организация' }}
                    <span v-if="selectedTarget.identifiers?.length">
                      · {{ selectedTarget.identifiers.length }} идент.
                    </span>
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="sm" @click="changeTarget">
                Изменить
              </Button>
            </div>

            <!-- Target search -->
            <div v-else class="space-y-2">
              <div class="relative">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  v-model="targetSearchInput"
                  placeholder="Поиск по имени..."
                  class="pl-9"
                  autofocus
                />
                <Loader2
                  v-if="isTargetSearching"
                  class="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground"
                />
              </div>

              <!-- Search results -->
              <div
                v-if="targetSearchInput && filteredTargetResults.length > 0"
                class="max-h-48 overflow-y-auto rounded-md border bg-popover"
              >
                <button
                  v-for="entity in filteredTargetResults"
                  :key="entity.id"
                  type="button"
                  class="flex w-full items-center gap-3 p-2 hover:bg-accent text-left"
                  @click="selectTarget(entity)"
                >
                  <div
                    :class="[
                      'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
                      entity.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
                    ]"
                  >
                    <User v-if="entity.type === 'person'" class="h-4 w-4" />
                    <Building2 v-else class="h-4 w-4" />
                  </div>
                  <div class="min-w-0 flex-1">
                    <div class="font-medium truncate">{{ entity.name }}</div>
                    <div class="text-xs text-muted-foreground">
                      {{ entity.type === 'person' ? 'Человек' : 'Организация' }}
                      <span v-if="entity.identifiers?.length">
                        · {{ entity.identifiers.length }} идент.
                      </span>
                    </div>
                  </div>
                </button>
              </div>

              <!-- No results -->
              <div
                v-else-if="targetSearchInput && !isTargetSearching && filteredTargetResults.length === 0"
                class="text-center py-4 text-sm text-muted-foreground"
              >
                Ничего не найдено
              </div>
            </div>
          </div>

          <!-- Warning about same type -->
          <div
            v-if="selectedSource && selectedTarget && selectedSource.type !== selectedTarget.type"
            class="flex items-center gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 text-sm"
          >
            <AlertCircle class="h-4 w-4 shrink-0" />
            <span>Типы сущностей различаются. Убедитесь, что это намеренно.</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="resetAndClose">Отмена</Button>
          <Button
            :disabled="!canConfirm"
            @click="handleConfirm"
          >
            Далее: Предпросмотр
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </ClientOnly>
</template>
