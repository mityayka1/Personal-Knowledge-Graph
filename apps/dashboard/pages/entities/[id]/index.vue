<script setup lang="ts">
import { ArrowLeft, Edit, Trash2, User, Building2, Mail, Phone, Calendar, Tag, Plus, X, Sparkles, Loader2, Check, XCircle } from 'lucide-vue-next';
import { useEntity, useDeleteEntity, useAddFact, useRemoveFact, type CreateFactDto } from '~/composables/useEntities';
import { formatDate, formatDateTime } from '~/lib/utils';

const route = useRoute();
const router = useRouter();

const entityId = computed(() => route.params.id as string);
const { data: entity, isLoading, error, refetch } = useEntity(entityId);

const deleteEntity = useDeleteEntity();
const addFact = useAddFact();
const removeFact = useRemoveFact();

// Extraction settings
const extractionSettings = ref<{ autoSaveThreshold: number; minConfidence: number } | null>(null);

// Fact extraction state
const isExtracting = ref(false);
interface ExtractedFact {
  factType: string;
  value: string;
  confidence: number;
  sourceQuote?: string;
  status?: 'pending' | 'saved' | 'dismissed';
}
const extractedFacts = ref<ExtractedFact[]>([]);

// Load extraction settings on mount
onMounted(async () => {
  try {
    extractionSettings.value = await $fetch<{ autoSaveThreshold: number; minConfidence: number }>('/api/settings/extraction/all');
  } catch (err) {
    console.error('Failed to load extraction settings:', err);
    // Default settings
    extractionSettings.value = { autoSaveThreshold: 0.95, minConfidence: 0.6 };
  }
});

// Fact dialog state
const showFactDialog = ref(false);
const newFact = reactive<CreateFactDto>({
  type: '',
  category: 'personal',
  value: '',
});

const factTypes = [
  { value: 'birthday', label: 'День рождения', category: 'personal' },
  { value: 'position', label: 'Должность', category: 'professional' },
  { value: 'company', label: 'Компания', category: 'professional' },
  { value: 'department', label: 'Отдел', category: 'professional' },
  { value: 'phone_work', label: 'Рабочий телефон', category: 'contact' },
  { value: 'phone_personal', label: 'Личный телефон', category: 'contact' },
  { value: 'email_work', label: 'Рабочий email', category: 'contact' },
  { value: 'email_personal', label: 'Личный email', category: 'contact' },
  { value: 'telegram', label: 'Telegram', category: 'contact' },
  { value: 'address', label: 'Адрес', category: 'contact' },
  { value: 'nickname', label: 'Прозвище', category: 'personal' },
  { value: 'specialization', label: 'Специализация', category: 'professional' },
];

function getFactCategory(type: string): string {
  const factType = factTypes.find(ft => ft.value === type);
  return factType?.category || 'personal';
}

async function handleAddFact() {
  if (!entity.value || !newFact.type || !newFact.value) return;

  await addFact.mutateAsync({
    entityId: entity.value.id,
    data: {
      type: newFact.type,
      category: getFactCategory(newFact.type),
      value: newFact.value,
      source: 'manual',
    },
  });

  showFactDialog.value = false;
  newFact.type = '';
  newFact.value = '';
}

async function handleRemoveFact(factId: string) {
  if (!entity.value) return;

  if (confirm('Удалить этот факт?')) {
    await removeFact.mutateAsync({
      entityId: entity.value.id,
      factId,
    });
  }
}

async function handleDelete() {
  if (!entity.value) return;

  if (confirm(`Вы уверены, что хотите удалить "${entity.value.name}"?`)) {
    await deleteEntity.mutateAsync(entity.value.id);
    router.push('/entities');
  }
}

function getIdentifierIcon(type: string | undefined) {
  if (!type) return Tag;
  switch (type.toLowerCase()) {
    case 'email':
      return Mail;
    case 'phone':
      return Phone;
    default:
      return Tag;
  }
}

async function handleExtractFacts() {
  if (!entity.value) return;

  isExtracting.value = true;
  extractedFacts.value = [];

  try {
    // Extract facts from entity's message history
    const response = await $fetch<{
      entityId: string;
      entityName: string;
      facts: ExtractedFact[];
      messageCount: number;
      message?: string;
    }>(
      `/api/extraction/entity/${entity.value.id}/facts`
    );

    if (response.message && response.facts.length === 0) {
      // No messages or extractable content
      console.log('Extraction info:', response.message);
    }

    // Mark facts based on confidence vs threshold
    const threshold = extractionSettings.value?.autoSaveThreshold ?? 0.95;
    extractedFacts.value = response.facts.map(fact => ({
      ...fact,
      status: fact.confidence >= threshold ? 'saved' : 'pending',
    }));

    // Auto-save high confidence facts
    for (const fact of extractedFacts.value) {
      if (fact.status === 'saved' && entity.value) {
        await saveExtractedFact(fact);
      }
    }

    if (response.facts.length > 0) {
      await refetch();
    }
  } catch (err) {
    console.error('Extraction failed:', err);
  } finally {
    isExtracting.value = false;
  }
}

async function saveExtractedFact(fact: ExtractedFact) {
  if (!entity.value) return;

  try {
    await addFact.mutateAsync({
      entityId: entity.value.id,
      data: {
        type: fact.factType,
        category: getFactCategory(fact.factType),
        value: fact.value,
        source: 'extracted',
      },
    });
    fact.status = 'saved';
    await refetch();
  } catch (err) {
    console.error('Failed to save fact:', err);
  }
}

function dismissExtractedFact(fact: ExtractedFact) {
  fact.status = 'dismissed';
}

// Computed: pending facts that need action
const pendingExtractedFacts = computed(() =>
  extractedFacts.value.filter(f => f.status === 'pending')
);
</script>

<template>
  <div>
    <!-- Back button -->
    <div class="mb-6">
      <NuxtLink to="/entities" class="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="mr-2 h-4 w-4" />
        Назад к сущностям
      </NuxtLink>
    </div>

    <!-- Loading state -->
    <div v-if="isLoading" class="space-y-6">
      <div class="flex items-center gap-4">
        <Skeleton class="h-16 w-16 rounded-full" />
        <div class="space-y-2">
          <Skeleton class="h-8 w-48" />
          <Skeleton class="h-4 w-32" />
        </div>
      </div>
      <Skeleton class="h-48 w-full" />
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="text-center py-12">
      <p class="text-destructive">Не удалось загрузить сущность</p>
      <NuxtLink to="/entities">
        <Button variant="outline" class="mt-4">Вернуться</Button>
      </NuxtLink>
    </div>

    <!-- Entity details -->
    <div v-else-if="entity" class="space-y-6">
      <!-- Header -->
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-4">
          <div
            :class="[
              'h-16 w-16 rounded-full flex items-center justify-center',
              entity.type === 'person' ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600',
            ]"
          >
            <User v-if="entity.type === 'person'" class="h-8 w-8" />
            <Building2 v-else class="h-8 w-8" />
          </div>
          <div>
            <h1 class="text-3xl font-bold tracking-tight">{{ entity.name }}</h1>
            <div class="flex items-center gap-2 mt-1">
              <Badge variant="secondary">{{ entity.type?.toLowerCase() || 'entity' }}</Badge>
              <span v-if="entity.organization" class="text-muted-foreground">
                @ {{ entity.organization.name }}
              </span>
            </div>
          </div>
        </div>
        <div class="flex gap-2">
          <NuxtLink :to="`/entities/${entity.id}/edit`">
            <Button variant="outline" size="sm">
              <Edit class="mr-2 h-4 w-4" />
              Редактировать
            </Button>
          </NuxtLink>
          <Button
            variant="destructive"
            size="sm"
            :disabled="deleteEntity.isPending.value"
            @click="handleDelete"
          >
            <Trash2 class="mr-2 h-4 w-4" />
            Удалить
          </Button>
        </div>
      </div>

      <!-- Notes -->
      <Card v-if="entity.notes">
        <CardHeader>
          <CardTitle class="text-lg">Заметки</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-muted-foreground whitespace-pre-wrap">{{ entity.notes }}</p>
        </CardContent>
      </Card>

      <!-- Identifiers -->
      <Card>
        <CardHeader>
          <CardTitle class="text-lg">Идентификаторы</CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="!entity.identifiers.length" class="text-muted-foreground">
            Нет идентификаторов
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="identifier in entity.identifiers"
              :key="identifier.id"
              class="flex items-center gap-3"
            >
              <div class="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                <component :is="getIdentifierIcon(identifier.identifierType)" class="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <div class="font-medium">{{ identifier.identifierValue }}</div>
                <div class="text-xs text-muted-foreground">{{ identifier.identifierType }}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Facts -->
      <Card>
        <CardHeader class="flex flex-row items-center justify-between">
          <CardTitle class="text-lg">Факты</CardTitle>
          <div class="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              :disabled="isExtracting"
              @click="handleExtractFacts"
            >
              <Loader2 v-if="isExtracting" class="mr-2 h-4 w-4 animate-spin" />
              <Sparkles v-else class="mr-2 h-4 w-4" />
              {{ isExtracting ? 'Извлечение...' : 'Извлечь факты' }}
            </Button>
            <Button size="sm" variant="outline" @click="showFactDialog = true">
              <Plus class="mr-2 h-4 w-4" />
              Добавить
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <!-- Extraction result -->
          <div v-if="extractedFacts.length > 0" class="mb-4 p-3 rounded-lg bg-muted/50 border">
            <div class="flex items-center gap-2 font-medium mb-3">
              <Sparkles class="h-4 w-4 text-yellow-500" />
              Извлечено {{ extractedFacts.length }} фактов
              <span v-if="pendingExtractedFacts.length > 0" class="text-sm text-muted-foreground">
                ({{ pendingExtractedFacts.length }} ожидают подтверждения)
              </span>
            </div>
            <div class="space-y-2">
              <div
                v-for="(fact, i) in extractedFacts"
                :key="i"
                :class="[
                  'flex items-center justify-between p-2 rounded-md text-sm',
                  fact.status === 'saved' ? 'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300' :
                  fact.status === 'dismissed' ? 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 opacity-50' :
                  'bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300'
                ]"
              >
                <div class="flex-1">
                  <span class="font-medium">{{ fact.factType }}:</span>
                  {{ fact.value }}
                  <span class="text-xs opacity-70">({{ Math.round(fact.confidence * 100) }}%)</span>
                </div>
                <div class="flex items-center gap-1 ml-2">
                  <!-- Status badge -->
                  <Badge v-if="fact.status === 'saved'" variant="outline" class="text-green-600 border-green-300">
                    <Check class="h-3 w-3 mr-1" />
                    Сохранён
                  </Badge>
                  <Badge v-else-if="fact.status === 'dismissed'" variant="outline" class="text-red-600 border-red-300">
                    Отклонён
                  </Badge>
                  <!-- Action buttons for pending facts -->
                  <template v-else>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-7 px-2 text-green-600 hover:text-green-700 hover:bg-green-100"
                      @click="saveExtractedFact(fact)"
                    >
                      <Check class="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      class="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-100"
                      @click="dismissExtractedFact(fact)"
                    >
                      <XCircle class="h-4 w-4" />
                    </Button>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <div v-if="!entity.facts.length" class="text-muted-foreground">
            Нет фактов
          </div>
          <div v-if="entity.facts.length" class="space-y-3">
            <div
              v-for="fact in entity.facts"
              :key="fact.id"
              class="flex items-start gap-3 p-3 rounded-lg bg-muted/50 group"
            >
              <div class="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <Calendar v-if="fact.valueDate" class="h-4 w-4 text-muted-foreground" />
                <Tag v-else class="h-4 w-4 text-muted-foreground" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="font-medium">{{ fact.type }}</span>
                  <Badge v-if="fact.category" variant="outline" class="text-xs">
                    {{ fact.category }}
                  </Badge>
                </div>
                <div class="text-sm text-muted-foreground mt-1">
                  <span v-if="fact.value">{{ fact.value }}</span>
                  <span v-else-if="fact.valueDate">{{ formatDate(fact.valueDate) }}</span>
                </div>
                <div class="text-xs text-muted-foreground mt-1">
                  Источник: {{ fact.source?.toLowerCase() || 'unknown' }}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                @click="handleRemoveFact(fact.id)"
              >
                <X class="h-4 w-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Add Fact Dialog -->
      <ClientOnly>
        <Dialog v-model:open="showFactDialog">
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Добавить факт</DialogTitle>
              <DialogDescription>
                Добавьте новый факт о сущности
              </DialogDescription>
            </DialogHeader>
            <div class="space-y-4 py-4">
              <div class="space-y-2">
                <label class="text-sm font-medium">Тип факта</label>
                <select
                  v-model="newFact.type"
                  class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">Выберите тип...</option>
                  <optgroup label="Личное">
                    <option v-for="ft in factTypes.filter(t => t.category === 'personal')" :key="ft.value" :value="ft.value">
                      {{ ft.label }}
                    </option>
                  </optgroup>
                  <optgroup label="Профессиональное">
                    <option v-for="ft in factTypes.filter(t => t.category === 'professional')" :key="ft.value" :value="ft.value">
                      {{ ft.label }}
                    </option>
                  </optgroup>
                  <optgroup label="Контактное">
                    <option v-for="ft in factTypes.filter(t => t.category === 'contact')" :key="ft.value" :value="ft.value">
                      {{ ft.label }}
                    </option>
                  </optgroup>
                </select>
              </div>
              <div class="space-y-2">
                <label class="text-sm font-medium">Значение</label>
                <Input v-model="newFact.value" placeholder="Введите значение..." />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" @click="showFactDialog = false">Отмена</Button>
              <Button
                :disabled="!newFact.type || !newFact.value || addFact.isPending.value"
                @click="handleAddFact"
              >
                {{ addFact.isPending.value ? 'Сохранение...' : 'Сохранить' }}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </ClientOnly>

      <!-- Metadata -->
      <Card>
        <CardHeader>
          <CardTitle class="text-lg">Метаданные</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span class="text-muted-foreground">Создано:</span>
              <span class="ml-2">{{ formatDateTime(entity.createdAt) }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Обновлено:</span>
              <span class="ml-2">{{ formatDateTime(entity.updatedAt) }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">ID:</span>
              <span class="ml-2 font-mono text-xs">{{ entity.id }}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
