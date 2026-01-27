<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ArrowRight, AlertTriangle, User, Building2, MessageSquare, Link2, Loader2 } from 'lucide-vue-next';
import type {
  MergePreviewDto,
  MergeRequestDto,
  ConflictResolution,
  MergeConflictDto,
} from '~/composables/useMergeSuggestions';

const props = defineProps<{
  preview: MergePreviewDto | null;
  loading?: boolean;
  previewLoading?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [request: MergeRequestDto];
}>();

const open = defineModel<boolean>('open', { default: false });

// Selected identifiers and facts to include
const selectedIdentifiers = ref<Set<string>>(new Set());
const selectedFacts = ref<Set<string>>(new Set());

// Conflict resolutions
const conflictResolutions = ref<Map<string, ConflictResolution>>(new Map());

// Initialize selections when preview changes
watch(
  () => props.preview,
  (preview) => {
    if (!preview) return;

    // Select all identifiers by default
    selectedIdentifiers.value = new Set(preview.source.identifiers.map((i) => i.id));

    // Select all facts by default
    selectedFacts.value = new Set(preview.source.facts.map((f) => f.id));

    // Set default conflict resolutions to KEEP_BOTH
    conflictResolutions.value = new Map();
    for (const conflict of preview.conflicts) {
      const key = `${conflict.field}:${conflict.type}`;
      conflictResolutions.value.set(key, 'KEEP_BOTH');
    }
  },
  { immediate: true }
);

function toggleIdentifier(id: string) {
  const newSet = new Set(selectedIdentifiers.value);
  if (newSet.has(id)) {
    newSet.delete(id);
  } else {
    newSet.add(id);
  }
  selectedIdentifiers.value = newSet;
}

function toggleFact(id: string) {
  const newSet = new Set(selectedFacts.value);
  if (newSet.has(id)) {
    newSet.delete(id);
  } else {
    newSet.add(id);
  }
  selectedFacts.value = newSet;
}

function setConflictResolution(conflict: MergeConflictDto, resolution: ConflictResolution) {
  const key = `${conflict.field}:${conflict.type}`;
  const newMap = new Map(conflictResolutions.value);
  newMap.set(key, resolution);
  conflictResolutions.value = newMap;
}

function getConflictResolution(conflict: MergeConflictDto): ConflictResolution {
  const key = `${conflict.field}:${conflict.type}`;
  return conflictResolutions.value.get(key) || 'KEEP_BOTH';
}

const canSubmit = computed(() => {
  if (!props.preview) return false;
  // All conflicts must have a resolution
  return props.preview.conflicts.every((c) => {
    const key = `${c.field}:${c.type}`;
    return conflictResolutions.value.has(key);
  });
});

function handleConfirm() {
  if (!props.preview) return;

  const request: MergeRequestDto = {
    sourceId: props.preview.source.id,
    targetId: props.preview.target.id,
    includeIdentifiers: Array.from(selectedIdentifiers.value),
    includeFacts: Array.from(selectedFacts.value),
    conflictResolutions: props.preview.conflicts.map((c) => ({
      field: c.field,
      type: c.type,
      resolution: getConflictResolution(c),
    })),
  };

  emit('confirm', request);
}

function handleClose() {
  open.value = false;
  emit('close');
}

function formatIdentifierType(type: string): string {
  const labels: Record<string, string> = {
    telegram_user_id: 'Telegram ID',
    telegram_username: 'Telegram Username',
    phone: 'Телефон',
    email: 'Email',
    viber: 'Viber',
    whatsapp: 'WhatsApp',
  };
  return labels[type] || type;
}

function formatFactType(type: string): string {
  const labels: Record<string, string> = {
    position: 'Должность',
    company: 'Компания',
    birthday: 'День рождения',
    location: 'Местоположение',
    note: 'Заметка',
  };
  return labels[type] || type;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Объединение сущностей</DialogTitle>
        <DialogDescription>
          Выберите данные для переноса и разрешите конфликты
        </DialogDescription>
      </DialogHeader>

      <div v-if="preview" class="space-y-6 py-4">
        <!-- Entity Cards -->
        <div class="grid grid-cols-2 gap-4">
          <!-- Source (will be deleted) -->
          <div class="p-4 border rounded-lg bg-red-50/50 dark:bg-red-950/20 border-red-200 dark:border-red-900">
            <div class="text-xs font-medium text-red-600 dark:text-red-400 uppercase mb-2">
              Удалить
            </div>
            <div class="flex items-center gap-2 mb-2">
              <User v-if="preview.source.type === 'person'" class="h-5 w-5 text-muted-foreground" />
              <Building2 v-else class="h-5 w-5 text-muted-foreground" />
              <span class="font-medium truncate">{{ preview.source.name }}</span>
            </div>
            <div class="flex items-center gap-3 text-xs text-muted-foreground">
              <span class="flex items-center gap-1">
                <MessageSquare class="h-3 w-3" />
                {{ preview.source.messageCount }} сообщений
              </span>
              <span class="flex items-center gap-1">
                <Link2 class="h-3 w-3" />
                {{ preview.source.relationsCount }} связей
              </span>
            </div>
          </div>

          <!-- Arrow -->
          <div class="absolute left-1/2 top-[108px] -translate-x-1/2 z-10 bg-background px-2">
            <ArrowRight class="h-5 w-5 text-muted-foreground" />
          </div>

          <!-- Target (will be kept) -->
          <div class="p-4 border rounded-lg bg-green-50/50 dark:bg-green-950/20 border-green-200 dark:border-green-900">
            <div class="text-xs font-medium text-green-600 dark:text-green-400 uppercase mb-2">
              Оставить
            </div>
            <div class="flex items-center gap-2 mb-2">
              <User v-if="preview.target.type === 'person'" class="h-5 w-5 text-muted-foreground" />
              <Building2 v-else class="h-5 w-5 text-muted-foreground" />
              <span class="font-medium truncate">{{ preview.target.name }}</span>
            </div>
            <div class="flex items-center gap-3 text-xs text-muted-foreground">
              <span class="flex items-center gap-1">
                <MessageSquare class="h-3 w-3" />
                {{ preview.target.messageCount }} сообщений
              </span>
              <span class="flex items-center gap-1">
                <Link2 class="h-3 w-3" />
                {{ preview.target.relationsCount }} связей
              </span>
            </div>
          </div>
        </div>

        <!-- Identifiers Section -->
        <div v-if="preview.source.identifiers.length > 0">
          <h4 class="text-sm font-medium mb-2">Идентификаторы</h4>
          <div class="space-y-2">
            <label
              v-for="identifier in preview.source.identifiers"
              :key="identifier.id"
              class="flex items-center gap-3 p-2 rounded border cursor-pointer hover:bg-muted/50"
              :class="{ 'bg-muted/30': selectedIdentifiers.has(identifier.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedIdentifiers.has(identifier.id)"
                class="rounded"
                @change="toggleIdentifier(identifier.id)"
              />
              <span class="flex-1">
                <span class="text-sm font-medium">
                  {{ formatIdentifierType(identifier.identifierType) }}:
                </span>
                <span class="text-sm text-muted-foreground ml-1">
                  {{ identifier.identifierValue }}
                </span>
              </span>
              <Badge variant="secondary" class="text-xs">перенести</Badge>
            </label>
          </div>
        </div>

        <!-- Facts Section -->
        <div v-if="preview.source.facts.length > 0">
          <h4 class="text-sm font-medium mb-2">Факты</h4>
          <div class="space-y-2">
            <label
              v-for="fact in preview.source.facts"
              :key="fact.id"
              class="flex items-center gap-3 p-2 rounded border cursor-pointer hover:bg-muted/50"
              :class="{ 'bg-muted/30': selectedFacts.has(fact.id) }"
            >
              <input
                type="checkbox"
                :checked="selectedFacts.has(fact.id)"
                class="rounded"
                @change="toggleFact(fact.id)"
              />
              <span class="flex-1">
                <span class="text-sm font-medium">
                  {{ formatFactType(fact.factType) }}:
                </span>
                <span class="text-sm text-muted-foreground ml-1">
                  {{ fact.value || '—' }}
                </span>
              </span>
              <Badge variant="secondary" class="text-xs">перенести</Badge>
            </label>
          </div>
        </div>

        <!-- Conflicts Section -->
        <div v-if="preview.conflicts.length > 0">
          <div class="flex items-center gap-2 mb-2">
            <AlertTriangle class="h-4 w-4 text-amber-500" />
            <h4 class="text-sm font-medium">Конфликты (требуют решения)</h4>
          </div>
          <div class="space-y-3">
            <div
              v-for="conflict in preview.conflicts"
              :key="`${conflict.field}:${conflict.type}`"
              class="p-3 rounded border bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900"
            >
              <div class="text-sm font-medium mb-2">
                {{ conflict.field === 'identifier' ? formatIdentifierType(conflict.type) : formatFactType(conflict.type) }}
              </div>
              <div class="space-y-2">
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    :name="`conflict-${conflict.field}-${conflict.type}`"
                    :checked="getConflictResolution(conflict) === 'KEEP_TARGET'"
                    @change="setConflictResolution(conflict, 'KEEP_TARGET')"
                  />
                  <span>
                    Оставить: <span class="text-muted-foreground">{{ conflict.targetValue || '—' }}</span>
                    <span class="text-xs text-muted-foreground ml-1">(у {{ preview.target.name }})</span>
                  </span>
                </label>
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    :name="`conflict-${conflict.field}-${conflict.type}`"
                    :checked="getConflictResolution(conflict) === 'KEEP_SOURCE'"
                    @change="setConflictResolution(conflict, 'KEEP_SOURCE')"
                  />
                  <span>
                    Заменить на: <span class="text-muted-foreground">{{ conflict.sourceValue || '—' }}</span>
                    <span class="text-xs text-muted-foreground ml-1">(у {{ preview.source.name }})</span>
                  </span>
                </label>
                <label class="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    :name="`conflict-${conflict.field}-${conflict.type}`"
                    :checked="getConflictResolution(conflict) === 'KEEP_BOTH'"
                    @change="setConflictResolution(conflict, 'KEEP_BOTH')"
                  />
                  <span>Сохранить оба значения</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        <!-- Auto-transferred data info -->
        <div class="p-3 rounded bg-muted/50 text-sm text-muted-foreground">
          <p class="font-medium mb-1">Автоматически:</p>
          <ul class="list-disc list-inside space-y-1">
            <li>{{ preview.source.messageCount }} сообщений будут перепривязаны</li>
            <li v-if="preview.source.relationsCount > 0">
              {{ preview.source.relationsCount }} связей будут перенесены
            </li>
          </ul>
        </div>
      </div>

      <!-- Loading state -->
      <div v-else-if="previewLoading" class="flex items-center justify-center py-12">
        <Loader2 class="h-8 w-8 animate-spin text-muted-foreground" />
      </div>

      <!-- No preview state -->
      <div v-else class="flex items-center justify-center py-12">
        <div class="text-muted-foreground">Нет данных для отображения</div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="handleClose" :disabled="loading">
          Отмена
        </Button>
        <Button @click="handleConfirm" :disabled="!canSubmit || loading">
          {{ loading ? 'Объединение...' : 'Объединить' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
