<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
import {
  useActivities,
  useCreateActivity,
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_PRIORITY_LABELS,
  ACTIVITY_CONTEXT_LABELS,
  type CreateActivityDto,
  type ActivityType,
  type ActivityStatus,
  type ActivityPriority,
  type ActivityContext,
} from '~/composables/useActivities';
import { useEntities, type EntityListParams } from '~/composables/useEntities';

definePageMeta({
  title: 'Создать активность',
});

const route = useRoute();
const router = useRouter();
const createActivity = useCreateActivity();

// Pre-fill from query params (e.g. /activities/new?parentId=xxx&type=task)
const queryParentId = (route.query.parentId as string) || '';
const queryType = (route.query.type as ActivityType) || 'project';

const form = reactive<CreateActivityDto>({
  name: '',
  activityType: queryType,
  ownerEntityId: '',
  description: '',
  status: 'active',
  priority: 'medium',
  context: 'work',
  parentId: queryParentId || undefined,
});

const deadline = ref('');
const startDate = ref('');
const tagsInput = ref('');
const parentSearch = ref('');
const clientSearch = ref('');

const errors = reactive({
  name: '',
  ownerEntityId: '',
});

// Load entities for owner/client select
const entityParams = computed<EntityListParams>(() => ({
  limit: 200,
}));
const { data: entitiesData } = useEntities(entityParams);

const entities = computed(() => entitiesData.value?.items || []);
const persons = computed(() => entities.value.filter(e => e.type === 'person'));
const organizations = computed(() => entities.value.filter(e => e.type === 'organization'));

// Load activities for parent select
const parentParams = computed(() => ({
  search: parentSearch.value || undefined,
  limit: 50,
}));
const { data: activitiesData } = useActivities(parentParams);
const parentActivities = computed(() => activitiesData.value?.items || []);


const activityTypes = Object.entries(ACTIVITY_TYPE_LABELS) as [ActivityType, string][];
const activityStatuses = Object.entries(ACTIVITY_STATUS_LABELS) as [ActivityStatus, string][];
const activityPriorities = Object.entries(ACTIVITY_PRIORITY_LABELS) as [ActivityPriority, string][];
const activityContexts = Object.entries(ACTIVITY_CONTEXT_LABELS) as [ActivityContext, string][];

function validateForm() {
  errors.name = '';
  errors.ownerEntityId = '';

  let valid = true;

  if (!form.name.trim()) {
    errors.name = 'Название обязательно';
    valid = false;
  }

  if (!form.ownerEntityId) {
    errors.ownerEntityId = 'Владелец обязателен';
    valid = false;
  }

  return valid;
}

async function handleSubmit() {
  if (!validateForm()) return;

  try {
    const dto: CreateActivityDto = {
      name: form.name.trim(),
      activityType: form.activityType,
      ownerEntityId: form.ownerEntityId,
    };

    if (form.description?.trim()) dto.description = form.description.trim();
    if (form.status && form.status !== 'active') dto.status = form.status;
    if (form.priority && form.priority !== 'medium') dto.priority = form.priority;
    if (form.context && form.context !== 'work') dto.context = form.context;
    if (form.parentId) dto.parentId = form.parentId;
    if (form.clientEntityId) dto.clientEntityId = form.clientEntityId;
    if (deadline.value) dto.deadline = new Date(deadline.value).toISOString();
    if (startDate.value) dto.startDate = new Date(startDate.value).toISOString();
    if (tagsInput.value.trim()) {
      dto.tags = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
    }

    const activity = await createActivity.mutateAsync(dto);
    router.push(`/activities/${activity.id}`);
  } catch (err) {
    console.error('Failed to create activity:', err);
  }
}
</script>

<template>
  <div>
    <!-- Back button -->
    <div class="mb-6">
      <NuxtLink to="/activities" class="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="mr-2 h-4 w-4" />
        Назад к активностям
      </NuxtLink>
    </div>

    <Card class="max-w-2xl">
      <CardHeader>
        <CardTitle>Создать активность</CardTitle>
        <CardDescription>Добавить новый проект, задачу или другую активность</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-6" @submit.prevent="handleSubmit">
          <!-- Name -->
          <div class="space-y-2">
            <label for="name" class="text-sm font-medium">Название *</label>
            <Input
              id="name"
              v-model="form.name"
              placeholder="Введите название"
              :class="errors.name ? 'border-destructive' : ''"
            />
            <p v-if="errors.name" class="text-sm text-destructive">{{ errors.name }}</p>
          </div>

          <!-- Type & Status row -->
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <label for="activityType" class="text-sm font-medium">Тип *</label>
              <select
                id="activityType"
                v-model="form.activityType"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option v-for="[value, label] in activityTypes" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </div>

            <div class="space-y-2">
              <label for="status" class="text-sm font-medium">Статус</label>
              <select
                id="status"
                v-model="form.status"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option v-for="[value, label] in activityStatuses" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </div>
          </div>

          <!-- Priority & Context row -->
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <label for="priority" class="text-sm font-medium">Приоритет</label>
              <select
                id="priority"
                v-model="form.priority"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option v-for="[value, label] in activityPriorities" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </div>

            <div class="space-y-2">
              <label for="context" class="text-sm font-medium">Контекст</label>
              <select
                id="context"
                v-model="form.context"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option v-for="[value, label] in activityContexts" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </div>
          </div>

          <!-- Owner -->
          <div class="space-y-2">
            <label for="ownerEntityId" class="text-sm font-medium">Владелец *</label>
            <select
              id="ownerEntityId"
              v-model="form.ownerEntityId"
              :class="[
                'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                errors.ownerEntityId ? 'border-destructive' : '',
              ]"
            >
              <option value="">Выберите владельца</option>
              <option v-for="entity in persons" :key="entity.id" :value="entity.id">
                {{ entity.name }}
              </option>
            </select>
            <p v-if="errors.ownerEntityId" class="text-sm text-destructive">{{ errors.ownerEntityId }}</p>
          </div>

          <!-- Client -->
          <div class="space-y-2">
            <label for="clientEntityId" class="text-sm font-medium">Клиент (опционально)</label>
            <select
              id="clientEntityId"
              v-model="form.clientEntityId"
              class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Без клиента</option>
              <option v-for="entity in entities" :key="entity.id" :value="entity.id">
                {{ entity.name }} ({{ entity.type === 'person' ? 'человек' : 'организация' }})
              </option>
            </select>
          </div>

          <!-- Parent Activity -->
          <div class="space-y-2">
            <label for="parentId" class="text-sm font-medium">Родительская активность (опционально)</label>
            <select
              id="parentId"
              v-model="form.parentId"
              class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Без родителя (корневая)</option>
              <option v-for="activity in parentActivities" :key="activity.id" :value="activity.id">
                {{ ACTIVITY_TYPE_LABELS[activity.activityType] }}: {{ activity.name }}
              </option>
            </select>
          </div>

          <!-- Description -->
          <div class="space-y-2">
            <label for="description" class="text-sm font-medium">Описание (опционально)</label>
            <textarea
              id="description"
              v-model="form.description"
              placeholder="Описание активности..."
              rows="3"
              class="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>

          <!-- Dates row -->
          <div class="grid grid-cols-2 gap-4">
            <div class="space-y-2">
              <label for="startDate" class="text-sm font-medium">Дата начала</label>
              <Input
                id="startDate"
                v-model="startDate"
                type="date"
              />
            </div>

            <div class="space-y-2">
              <label for="deadline" class="text-sm font-medium">Дедлайн</label>
              <Input
                id="deadline"
                v-model="deadline"
                type="date"
              />
            </div>
          </div>

          <!-- Tags -->
          <div class="space-y-2">
            <label for="tags" class="text-sm font-medium">Теги (через запятую)</label>
            <Input
              id="tags"
              v-model="tagsInput"
              placeholder="web, frontend, клиент"
            />
          </div>

          <!-- Submit -->
          <div class="flex gap-4">
            <Button type="submit" :disabled="createActivity.isPending.value">
              {{ createActivity.isPending.value ? 'Создание...' : 'Создать' }}
            </Button>
            <NuxtLink to="/activities">
              <Button type="button" variant="outline">Отмена</Button>
            </NuxtLink>
          </div>

          <!-- Error -->
          <p v-if="createActivity.error.value" class="text-sm text-destructive">
            Не удалось создать активность. Попробуйте ещё раз.
          </p>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
