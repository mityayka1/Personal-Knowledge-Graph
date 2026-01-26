<script setup lang="ts">
import { Search, Loader2, User, Building2 } from 'lucide-vue-next';
import {
  RELATION_TYPES,
  type RelationTypeKey,
  isSymmetricRelation,
  getRoleLabel,
  useCreateRelation,
} from '~/composables/useRelations';
import { useEntities, type Entity } from '~/composables/useEntities';

const props = defineProps<{
  currentEntityId: string;
  currentEntityName: string;
  currentEntityType: 'person' | 'organization';
}>();

const emit = defineEmits<{
  (e: 'success'): void;
}>();

const open = defineModel<boolean>('open', { default: false });

// Form state
const selectedRelationType = ref<RelationTypeKey | ''>('');
const selectedTargetEntity = ref<Entity | null>(null);
const currentEntityRole = ref('');
const targetEntityRole = ref('');

// Entity search
const searchQuery = ref('');
const searchParams = computed(() => ({
  search: searchQuery.value,
  limit: 10,
}));

const { data: searchResults, isLoading: isSearching } = useEntities(searchParams);
const createRelation = useCreateRelation();

// Filter out current entity from search results
const filteredResults = computed(() => {
  if (!searchResults.value?.items) return [];
  return searchResults.value.items.filter(e => e.id !== props.currentEntityId);
});

// Relation type options for select
const relationTypeOptions = computed(() => {
  return Object.entries(RELATION_TYPES).map(([key, value]) => ({
    value: key as RelationTypeKey,
    label: value.label,
    description: value.description,
  }));
});

// Available roles for selected relation type
const availableRoles = computed(() => {
  if (!selectedRelationType.value) return [];
  const typeInfo = RELATION_TYPES[selectedRelationType.value];
  return typeInfo.roles.map(role => ({
    value: role,
    label: typeInfo.roleLabels[role as keyof typeof typeInfo.roleLabels],
  }));
});

// Is symmetric relation (both entities have same role)
const isSymmetric = computed((): boolean => {
  return !!selectedRelationType.value && isSymmetricRelation(selectedRelationType.value);
});

// Watch relation type changes to set default roles
watch(selectedRelationType, (newType) => {
  if (!newType) {
    currentEntityRole.value = '';
    targetEntityRole.value = '';
    return;
  }

  const roles = RELATION_TYPES[newType].roles;
  if (roles.length === 1) {
    // Symmetric relation - both have same role
    currentEntityRole.value = roles[0];
    targetEntityRole.value = roles[0];
  } else if (roles.length === 2) {
    // Asymmetric relation - set first role as default for current entity
    currentEntityRole.value = roles[0];
    targetEntityRole.value = roles[1];
  }
});

// Swap roles (for asymmetric relations)
function swapRoles() {
  const temp = currentEntityRole.value;
  currentEntityRole.value = targetEntityRole.value;
  targetEntityRole.value = temp;
}

// Can submit form
const canSubmit = computed(() => {
  return (
    selectedRelationType.value &&
    selectedTargetEntity.value &&
    currentEntityRole.value &&
    targetEntityRole.value &&
    !createRelation.isPending.value
  );
});

// Handle form submission
async function handleSubmit() {
  if (!canSubmit.value || !selectedTargetEntity.value) return;

  try {
    await createRelation.mutateAsync({
      relationType: selectedRelationType.value,
      members: [
        { entityId: props.currentEntityId, role: currentEntityRole.value },
        { entityId: selectedTargetEntity.value.id, role: targetEntityRole.value },
      ],
      source: 'manual',
    });

    // Reset form and close
    resetForm();
    open.value = false;
    emit('success');
  } catch (error) {
    console.error('Failed to create relation:', error);
  }
}

// Reset form state
function resetForm() {
  selectedRelationType.value = '';
  selectedTargetEntity.value = null;
  currentEntityRole.value = '';
  targetEntityRole.value = '';
  searchQuery.value = '';
}

// Select entity from search results
function selectEntity(entity: Entity) {
  selectedTargetEntity.value = entity;
  searchQuery.value = '';
}

// Clear selected entity
function clearSelectedEntity() {
  selectedTargetEntity.value = null;
}
</script>

<template>
  <ClientOnly>
    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Добавить связь</DialogTitle>
          <DialogDescription>
            Создайте связь между {{ currentEntityName }} и другой сущностью
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4 py-4">
          <!-- Relation Type -->
          <div class="space-y-2">
            <label class="text-sm font-medium">Тип связи</label>
            <select
              v-model="selectedRelationType"
              class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Выберите тип связи...</option>
              <option
                v-for="option in relationTypeOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }} — {{ option.description }}
              </option>
            </select>
          </div>

          <!-- Target Entity Search -->
          <div class="space-y-2">
            <label class="text-sm font-medium">Связать с</label>

            <!-- Selected entity display -->
            <div
              v-if="selectedTargetEntity"
              class="flex items-center justify-between p-3 rounded-lg border bg-muted/50"
            >
              <div class="flex items-center gap-3">
                <div
                  :class="[
                    'h-8 w-8 rounded-full flex items-center justify-center',
                    selectedTargetEntity.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
                  ]"
                >
                  <User v-if="selectedTargetEntity.type === 'person'" class="h-4 w-4" />
                  <Building2 v-else class="h-4 w-4" />
                </div>
                <div>
                  <div class="font-medium">{{ selectedTargetEntity.name }}</div>
                  <div class="text-xs text-muted-foreground">
                    {{ selectedTargetEntity.type === 'person' ? 'Человек' : 'Организация' }}
                  </div>
                </div>
              </div>
              <Button variant="ghost" size="sm" @click="clearSelectedEntity">
                Изменить
              </Button>
            </div>

            <!-- Search input -->
            <div v-else class="space-y-2">
              <div class="relative">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  v-model="searchQuery"
                  placeholder="Поиск по имени..."
                  class="pl-9"
                />
                <Loader2
                  v-if="isSearching"
                  class="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground"
                />
              </div>

              <!-- Search results -->
              <div
                v-if="searchQuery && filteredResults.length > 0"
                class="max-h-48 overflow-y-auto rounded-md border bg-popover"
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
                      'h-8 w-8 rounded-full flex items-center justify-center shrink-0',
                      entity.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
                    ]"
                  >
                    <User v-if="entity.type === 'person'" class="h-4 w-4" />
                    <Building2 v-else class="h-4 w-4" />
                  </div>
                  <div class="min-w-0">
                    <div class="font-medium truncate">{{ entity.name }}</div>
                    <div class="text-xs text-muted-foreground">
                      {{ entity.type === 'person' ? 'Человек' : 'Организация' }}
                    </div>
                  </div>
                </button>
              </div>

              <!-- No results -->
              <div
                v-else-if="searchQuery && !isSearching && filteredResults.length === 0"
                class="text-center py-4 text-sm text-muted-foreground"
              >
                Ничего не найдено
              </div>
            </div>
          </div>

          <!-- Role Assignment -->
          <div v-if="selectedRelationType && selectedTargetEntity" class="space-y-3">
            <label class="text-sm font-medium">Роли в связи</label>

            <div class="grid grid-cols-[1fr,auto,1fr] gap-2 items-center">
              <!-- Current entity role -->
              <div class="space-y-1">
                <div class="text-xs text-muted-foreground truncate">{{ currentEntityName }}</div>
                <select
                  v-model="currentEntityRole"
                  :disabled="isSymmetric"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <option
                    v-for="role in availableRoles"
                    :key="role.value"
                    :value="role.value"
                  >
                    {{ role.label }}
                  </option>
                </select>
              </div>

              <!-- Swap button -->
              <Button
                v-if="!isSymmetric"
                variant="ghost"
                size="icon"
                class="h-8 w-8"
                @click="swapRoles"
              >
                ⇄
              </Button>
              <span v-else class="text-center text-muted-foreground">—</span>

              <!-- Target entity role -->
              <div class="space-y-1">
                <div class="text-xs text-muted-foreground truncate">{{ selectedTargetEntity.name }}</div>
                <select
                  v-model="targetEntityRole"
                  :disabled="isSymmetric"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <option
                    v-for="role in availableRoles"
                    :key="role.value"
                    :value="role.value"
                  >
                    {{ role.label }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Role description -->
            <p class="text-xs text-muted-foreground">
              <template v-if="isSymmetric">
                Оба участника имеют одинаковую роль «{{ getRoleLabel(selectedRelationType, currentEntityRole) }}»
              </template>
              <template v-else>
                {{ currentEntityName }} — <strong>{{ getRoleLabel(selectedRelationType, currentEntityRole) }}</strong>,
                {{ selectedTargetEntity.name }} — <strong>{{ getRoleLabel(selectedRelationType, targetEntityRole) }}</strong>
              </template>
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="open = false">Отмена</Button>
          <Button
            :disabled="!canSubmit"
            @click="handleSubmit"
          >
            <Loader2 v-if="createRelation.isPending.value" class="mr-2 h-4 w-4 animate-spin" />
            {{ createRelation.isPending.value ? 'Создание...' : 'Создать связь' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </ClientOnly>
</template>
