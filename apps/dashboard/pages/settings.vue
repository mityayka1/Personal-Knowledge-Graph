<script setup lang="ts">
import { Settings, Save, RefreshCw } from 'lucide-vue-next';

interface Setting {
  key: string;
  value: unknown;
  description: string;
  category: string;
}

const isLoading = ref(true);
const isSaving = ref(false);
const settings = ref<Setting[]>([]);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);

// Local state for editing
const editedSettings = ref<Record<string, string | number>>({});

async function loadSettings() {
  isLoading.value = true;
  error.value = null;

  try {
    settings.value = await $fetch<Setting[]>('/api/settings');
    // Initialize edited values
    editedSettings.value = {};
    for (const setting of settings.value) {
      editedSettings.value[setting.key] = setting.value as string | number;
    }
  } catch (err) {
    error.value = 'Не удалось загрузить настройки';
    console.error(err);
  } finally {
    isLoading.value = false;
  }
}

async function saveSetting(key: string) {
  isSaving.value = true;
  error.value = null;
  successMessage.value = null;

  try {
    await $fetch(`/api/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: {
        value: editedSettings.value[key],
      },
    });
    successMessage.value = `Настройка "${key}" сохранена`;
    setTimeout(() => {
      successMessage.value = null;
    }, 3000);
  } catch (err) {
    error.value = `Не удалось сохранить настройку "${key}"`;
    console.error(err);
  } finally {
    isSaving.value = false;
  }
}

function formatSettingKey(key: string): string {
  // extraction.autoSaveThreshold -> Порог авто-сохранения
  const labels: Record<string, string> = {
    'extraction.autoSaveThreshold': 'Порог авто-сохранения',
    'extraction.minConfidence': 'Минимальная уверенность',
    'extraction.model': 'Модель Claude',
    'session.gapThresholdMinutes': 'Порог разделения сессий',
  };
  return labels[key] || key;
}

function formatMinutesToHuman(minutes: number | string): string {
  const m = Number(minutes);
  if (isNaN(m)) return '';
  if (m < 60) return `${m} мин`;
  const hours = Math.floor(m / 60);
  const mins = m % 60;
  return mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;
}

function getInputType(value: unknown): 'number' | 'text' | 'select' {
  if (typeof value === 'number') return 'number';
  return 'text';
}

// Group settings by category
const groupedSettings = computed(() => {
  const groups: Record<string, Setting[]> = {};
  for (const setting of settings.value) {
    if (!groups[setting.category]) {
      groups[setting.category] = [];
    }
    groups[setting.category].push(setting);
  }
  return groups;
});

const categoryLabels: Record<string, string> = {
  extraction: 'Извлечение фактов',
  session: 'Настройки сессий',
  general: 'Общие',
};

onMounted(() => {
  loadSettings();
});
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Settings class="h-8 w-8" />
          Настройки
        </h1>
        <p class="text-muted-foreground mt-1">Настройки системы извлечения и обработки фактов</p>
      </div>
      <Button variant="outline" @click="loadSettings" :disabled="isLoading">
        <RefreshCw :class="['h-4 w-4 mr-2', isLoading && 'animate-spin']" />
        Обновить
      </Button>
    </div>

    <!-- Success message -->
    <div v-if="successMessage" class="p-3 rounded-lg bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300">
      {{ successMessage }}
    </div>

    <!-- Error message -->
    <div v-if="error" class="p-3 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">
      {{ error }}
    </div>

    <!-- Loading state -->
    <div v-if="isLoading" class="space-y-4">
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-32 w-full" />
    </div>

    <!-- Settings by category -->
    <div v-else class="space-y-6">
      <Card v-for="(categorySettings, category) in groupedSettings" :key="category">
        <CardHeader>
          <CardTitle>{{ categoryLabels[category] || category }}</CardTitle>
        </CardHeader>
        <CardContent class="space-y-6">
          <div v-for="setting in categorySettings" :key="setting.key" class="space-y-2">
            <div class="flex items-center justify-between">
              <label :for="setting.key" class="text-sm font-medium">
                {{ formatSettingKey(setting.key) }}
              </label>
              <Button
                size="sm"
                variant="outline"
                @click="saveSetting(setting.key)"
                :disabled="isSaving"
              >
                <Save class="h-4 w-4 mr-1" />
                Сохранить
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">{{ setting.description }}</p>

            <!-- Number input for thresholds -->
            <div v-if="getInputType(setting.value) === 'number'" class="flex items-center gap-4">
              <Input
                :id="setting.key"
                v-model.number="editedSettings[setting.key]"
                type="number"
                step="0.05"
                min="0"
                max="1"
                class="w-32"
              />
              <span class="text-sm text-muted-foreground">
                {{ Math.round(Number(editedSettings[setting.key]) * 100) }}%
              </span>
              <!-- Slider for visual feedback -->
              <input
                type="range"
                v-model.number="editedSettings[setting.key]"
                min="0"
                max="1"
                step="0.05"
                class="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer"
              />
            </div>

            <!-- Select for model -->
            <div v-else-if="setting.key === 'extraction.model'">
              <select
                :id="setting.key"
                v-model="editedSettings[setting.key]"
                class="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="haiku">Haiku (быстрый)</option>
                <option value="sonnet">Sonnet (сбалансированный)</option>
                <option value="opus">Opus (мощный)</option>
              </select>
            </div>

            <!-- Session gap threshold in minutes -->
            <div v-else-if="setting.key === 'session.gapThresholdMinutes'" class="flex items-center gap-4">
              <Input
                :id="setting.key"
                v-model.number="editedSettings[setting.key]"
                type="number"
                step="15"
                min="15"
                max="1440"
                class="w-32"
              />
              <span class="text-sm text-muted-foreground min-w-[80px]">
                {{ formatMinutesToHuman(editedSettings[setting.key]) }}
              </span>
              <input
                type="range"
                v-model.number="editedSettings[setting.key]"
                min="15"
                max="1440"
                step="15"
                class="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer"
              />
            </div>

            <!-- Text input fallback -->
            <Input
              v-else
              :id="setting.key"
              v-model="editedSettings[setting.key]"
              class="max-w-md"
            />
          </div>
        </CardContent>
      </Card>

      <!-- Help card -->
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Как это работает</CardTitle>
        </CardHeader>
        <CardContent class="text-sm text-muted-foreground space-y-2">
          <p>
            <strong>Порог авто-сохранения:</strong> Факты с уверенностью выше этого порога
            автоматически сохраняются без подтверждения. Рекомендуется 0.9-0.95.
          </p>
          <p>
            <strong>Минимальная уверенность:</strong> Факты с уверенностью ниже этого порога
            не отображаются. Рекомендуется 0.5-0.7.
          </p>
          <p>
            <strong>Модель Claude:</strong> Haiku — быстрый и дешёвый, Sonnet — баланс
            скорости и качества, Opus — максимальное качество.
          </p>
          <p>
            <strong>Порог разделения сессий:</strong> Если между сообщениями прошло больше
            указанного времени, будет создана новая сессия. Рекомендуемые значения: 60 мин
            для активных переписок, 240 мин (4 часа) стандартно, 480 мин (8 часов) для редких контактов.
          </p>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
