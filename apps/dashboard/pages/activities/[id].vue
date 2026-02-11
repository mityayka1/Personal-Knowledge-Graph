<script setup lang="ts">
import {
  ArrowLeft,
  Edit,
  Save,
  X,
  Trash2,
  Clock,
  Calendar,
  AlertTriangle,
  Users,
  Plus,
  Globe,
  Building2,
  GitBranch,
  FolderKanban,
  Rocket,
  CheckSquare,
  Flag,
  RefreshCw,
  GraduationCap,
  CalendarRange,
  ChevronRight,
  Link,
} from 'lucide-vue-next';
import {
  useActivity,
  useActivities,
  useActivityMembers,
  useUpdateActivity,
  useDeleteActivity,
  useAddActivityMembers,
  ACTIVITY_TYPE_LABELS,
  ACTIVITY_STATUS_LABELS,
  ACTIVITY_STATUS_COLORS,
  ACTIVITY_PRIORITY_LABELS,
  ACTIVITY_PRIORITY_COLORS,
  ACTIVITY_TYPE_COLORS,
  ACTIVITY_CONTEXT_LABELS,
  ACTIVITY_MEMBER_ROLE_LABELS,
  type ActivityType,
  type ActivityStatus,
  type ActivityPriority,
  type ActivityContext,
  type ActivityMemberRole,
  type UpdateActivityDto,
} from '~/composables/useActivities';
import { ConfirmDialog } from '~/components/ui/confirm-dialog';
import { EntityCombobox } from '~/components/ui/entity-combobox';
import { formatDate, formatDateTime } from '~/lib/utils';

const route = useRoute();
const router = useRouter();

const activityId = computed(() => route.params.id as string);
const { data: activity, isLoading, error } = useActivity(activityId);
const { data: members, refetch: refetchMembers } = useActivityMembers(activityId);

const updateActivity = useUpdateActivity();
const deleteActivity = useDeleteActivity();
const addMembers = useAddActivityMembers();

// ─── Children ───────────────────────────────────────────────
const childrenParams = computed(() => ({
  parentId: activityId.value,
  limit: 50,
}));
const { data: childrenData } = useActivities(childrenParams);
const children = computed(() => childrenData.value?.items || []);

// ─── Parent candidates (for edit mode) ──────────────────────
const parentCandidatesParams = computed(() => ({
  limit: 100,
}));
const { data: parentCandidatesData } = useActivities(parentCandidatesParams);
const parentCandidates = computed(() =>
  (parentCandidatesData.value?.items || []).filter(a => a.id !== activityId.value),
);

// ─── Edit mode ───────────────────────────────────────────────
const isEditing = ref(false);

interface EditFormState {
  name: string;
  activityType: ActivityType;
  description: string;
  status: ActivityStatus;
  priority: ActivityPriority;
  context: ActivityContext;
  ownerEntityId: string;
  clientEntityId: string;
  parentId: string;
  deadline: string;
  startDate: string;
  tags: string[];
  progress: number;
}

const editForm = reactive<EditFormState>({
  name: '',
  activityType: 'project',
  description: '',
  status: 'active',
  priority: 'medium',
  context: 'work',
  ownerEntityId: '',
  clientEntityId: '',
  parentId: '',
  deadline: '',
  startDate: '',
  tags: [],
  progress: 0,
});

function startEditing() {
  if (!activity.value) return;
  const a = activity.value;
  Object.assign(editForm, {
    name: a.name,
    activityType: a.activityType,
    description: a.description || '',
    status: a.status,
    priority: a.priority,
    context: a.context,
    ownerEntityId: a.ownerEntityId,
    clientEntityId: a.clientEntityId || '',
    parentId: a.parentId || '',
    deadline: a.deadline ? a.deadline.slice(0, 10) : '',
    startDate: a.startDate ? a.startDate.slice(0, 10) : '',
    tags: a.tags || [],
    progress: a.progress ?? 0,
  });
  editTagsInput.value = (a.tags || []).join(', ');
  isEditing.value = true;
}

function cancelEditing() {
  isEditing.value = false;
}

const editTagsInput = ref('');

async function handleSave() {
  if (!activity.value) return;

  const dto: UpdateActivityDto = {};
  const a = activity.value;

  if (editForm.name !== a.name) dto.name = editForm.name;
  if (editForm.activityType !== a.activityType) dto.activityType = editForm.activityType;
  if ((editForm.description || '') !== (a.description || '')) dto.description = editForm.description || null;
  if (editForm.status !== a.status) dto.status = editForm.status;
  if (editForm.priority !== a.priority) dto.priority = editForm.priority;
  if (editForm.context !== a.context) dto.context = editForm.context;
  if (editForm.ownerEntityId !== a.ownerEntityId) dto.ownerEntityId = editForm.ownerEntityId;

  const newClientId = editForm.clientEntityId || null;
  if (newClientId !== a.clientEntityId) dto.clientEntityId = newClientId;

  const newParentId = editForm.parentId || null;
  if (newParentId !== a.parentId) dto.parentId = newParentId;

  const newDeadline = editForm.deadline ? new Date(editForm.deadline as string).toISOString() : null;
  const oldDeadline = a.deadline ? a.deadline.slice(0, 10) : null;
  const editDeadline = editForm.deadline || null;
  if (editDeadline !== oldDeadline) dto.deadline = newDeadline;

  const newStartDate = editForm.startDate ? new Date(editForm.startDate as string).toISOString() : null;
  const oldStartDate = a.startDate ? a.startDate.slice(0, 10) : null;
  const editStartDate = editForm.startDate || null;
  if (editStartDate !== oldStartDate) dto.startDate = newStartDate;

  const newTags = editTagsInput.value.trim()
    ? editTagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
    : null;
  const oldTags = a.tags && a.tags.length > 0 ? a.tags.join(', ') : '';
  const newTagsStr = newTags ? newTags.join(', ') : '';
  if (newTagsStr !== oldTags) dto.tags = newTags;

  if (editForm.progress !== a.progress) dto.progress = editForm.progress;

  if (Object.keys(dto).length === 0) {
    isEditing.value = false;
    return;
  }

  try {
    await updateActivity.mutateAsync({ id: activity.value.id, data: dto });
    isEditing.value = false;
  } catch (err) {
    console.error('Failed to update activity:', err);
  }
}

// ─── Archive (soft delete) ───────────────────────────────────
const showArchiveConfirm = ref(false);

async function confirmArchive() {
  if (!activity.value) return;
  await deleteActivity.mutateAsync(activity.value.id);
  showArchiveConfirm.value = false;
  router.push('/activities');
}

// ─── Add member dialog ──────────────────────────────────────
const showAddMemberDialog = ref(false);
const newMemberEntityId = ref('');
const newMemberRole = ref<ActivityMemberRole>('member');

const memberRoles = Object.entries(ACTIVITY_MEMBER_ROLE_LABELS) as [ActivityMemberRole, string][];

async function handleAddMember() {
  if (!activity.value || !newMemberEntityId.value) return;

  try {
    await addMembers.mutateAsync({
      activityId: activity.value.id,
      members: [{ entityId: newMemberEntityId.value, role: newMemberRole.value }],
    });
    showAddMemberDialog.value = false;
    newMemberEntityId.value = '';
    newMemberRole.value = 'member';
    await refetchMembers();
  } catch (err) {
    console.error('Failed to add member:', err);
  }
}

// ─── Quick parent assignment dialog ─────────────────────────
const showParentDialog = ref(false);
const selectedParentId = ref('');

async function handleQuickParentAssign() {
  if (!activity.value) return;

  const newParentId = selectedParentId.value || null;
  if (newParentId === (activity.value.parentId || null)) {
    showParentDialog.value = false;
    return;
  }

  try {
    await updateActivity.mutateAsync({
      id: activity.value.id,
      data: { parentId: newParentId },
    });
    showParentDialog.value = false;
  } catch (err) {
    console.error('Failed to assign parent:', err);
  }
}

function openParentDialog() {
  selectedParentId.value = activity.value?.parentId || '';
  showParentDialog.value = true;
}

// ─── Enums for selects ──────────────────────────────────────
const activityTypes = Object.entries(ACTIVITY_TYPE_LABELS) as [ActivityType, string][];
const activityStatuses = Object.entries(ACTIVITY_STATUS_LABELS) as [ActivityStatus, string][];
const activityPriorities = Object.entries(ACTIVITY_PRIORITY_LABELS) as [ActivityPriority, string][];
const activityContexts = Object.entries(ACTIVITY_CONTEXT_LABELS) as [ActivityContext, string][];

// ─── Type icons ─────────────────────────────────────────────
const TYPE_ICONS: Record<ActivityType, typeof Globe> = {
  area: Globe,
  business: Building2,
  direction: GitBranch,
  project: FolderKanban,
  initiative: Rocket,
  task: CheckSquare,
  milestone: Flag,
  habit: RefreshCw,
  learning: GraduationCap,
  event_series: CalendarRange,
};

// ─── Helpers ────────────────────────────────────────────────
function isOverdue(deadline: string | null): boolean {
  if (!deadline) return false;
  return new Date(deadline) < new Date();
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

    <!-- Loading state -->
    <div v-if="isLoading" class="space-y-6">
      <div class="flex items-center gap-4">
        <Skeleton class="h-12 w-12 rounded-lg" />
        <div class="space-y-2">
          <Skeleton class="h-8 w-64" />
          <Skeleton class="h-4 w-40" />
        </div>
      </div>
      <Skeleton class="h-48 w-full" />
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="text-center py-12">
      <p class="text-destructive">Не удалось загрузить активность</p>
      <NuxtLink to="/activities">
        <Button variant="outline" class="mt-4">Вернуться</Button>
      </NuxtLink>
    </div>

    <!-- Activity details -->
    <div v-else-if="activity" class="space-y-6">
      <!-- Header -->
      <div class="flex items-start justify-between">
        <div class="flex items-center gap-4">
          <div
            :class="[
              'h-12 w-12 rounded-lg flex items-center justify-center shrink-0',
              ACTIVITY_TYPE_COLORS[activity.activityType],
            ]"
          >
            <component :is="TYPE_ICONS[activity.activityType]" class="h-6 w-6" />
          </div>
          <div>
            <h1 v-if="!isEditing" class="text-3xl font-bold tracking-tight">{{ activity.name }}</h1>
            <Input
              v-else
              v-model="editForm.name"
              class="text-2xl font-bold h-auto py-1"
            />
            <div class="flex items-center gap-2 mt-1 flex-wrap">
              <Badge :class="ACTIVITY_TYPE_COLORS[activity.activityType]">
                {{ ACTIVITY_TYPE_LABELS[activity.activityType] }}
              </Badge>
              <Badge :class="ACTIVITY_STATUS_COLORS[activity.status]">
                {{ ACTIVITY_STATUS_LABELS[activity.status] }}
              </Badge>
              <Badge
                v-if="activity.priority !== 'medium' && activity.priority !== 'none'"
                :class="ACTIVITY_PRIORITY_COLORS[activity.priority]"
              >
                {{ ACTIVITY_PRIORITY_LABELS[activity.priority] }}
              </Badge>
              <Badge variant="outline">
                {{ ACTIVITY_CONTEXT_LABELS[activity.context] }}
              </Badge>
            </div>
          </div>
        </div>
        <div class="flex gap-2 shrink-0">
          <template v-if="!isEditing">
            <Button variant="outline" size="sm" @click="startEditing">
              <Edit class="mr-2 h-4 w-4" />
              Редактировать
            </Button>
            <Button
              variant="destructive"
              size="sm"
              @click="showArchiveConfirm = true"
            >
              <Trash2 class="mr-2 h-4 w-4" />
              Архивировать
            </Button>
          </template>
          <template v-else>
            <Button
              size="sm"
              :disabled="updateActivity.isPending.value"
              @click="handleSave"
            >
              <Save class="mr-2 h-4 w-4" />
              {{ updateActivity.isPending.value ? 'Сохранение...' : 'Сохранить' }}
            </Button>
            <Button variant="outline" size="sm" @click="cancelEditing">
              <X class="mr-2 h-4 w-4" />
              Отмена
            </Button>
          </template>
        </div>
      </div>

      <!-- Error message -->
      <p v-if="updateActivity.error.value" class="text-sm text-destructive">
        Не удалось сохранить изменения. Попробуйте ещё раз.
      </p>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <!-- Left column: Main info -->
        <div class="lg:col-span-2 space-y-6">
          <!-- Card: Основное -->
          <Card>
            <CardHeader>
              <CardTitle class="text-lg">Основное</CardTitle>
            </CardHeader>
            <CardContent class="space-y-4">
              <!-- Description -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Описание</label>
                <p v-if="!isEditing" class="mt-1 whitespace-pre-wrap">
                  {{ activity.description || 'Нет описания' }}
                </p>
                <textarea
                  v-else
                  v-model="editForm.description"
                  rows="3"
                  placeholder="Описание активности..."
                  class="mt-1 flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              <!-- Type & Status (edit mode) -->
              <div v-if="isEditing" class="grid grid-cols-2 gap-4">
                <div>
                  <label class="text-sm font-medium text-muted-foreground">Тип</label>
                  <select
                    v-model="editForm.activityType"
                    class="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option v-for="[value, label] in activityTypes" :key="value" :value="value">
                      {{ label }}
                    </option>
                  </select>
                </div>
                <div>
                  <label class="text-sm font-medium text-muted-foreground">Статус</label>
                  <select
                    v-model="editForm.status"
                    class="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option v-for="[value, label] in activityStatuses" :key="value" :value="value">
                      {{ label }}
                    </option>
                  </select>
                </div>
              </div>

              <!-- Priority & Context (edit mode) -->
              <div v-if="isEditing" class="grid grid-cols-2 gap-4">
                <div>
                  <label class="text-sm font-medium text-muted-foreground">Приоритет</label>
                  <select
                    v-model="editForm.priority"
                    class="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option v-for="[value, label] in activityPriorities" :key="value" :value="value">
                      {{ label }}
                    </option>
                  </select>
                </div>
                <div>
                  <label class="text-sm font-medium text-muted-foreground">Контекст</label>
                  <select
                    v-model="editForm.context"
                    class="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option v-for="[value, label] in activityContexts" :key="value" :value="value">
                      {{ label }}
                    </option>
                  </select>
                </div>
              </div>

              <!-- Owner -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Владелец</label>
                <div v-if="!isEditing" class="mt-1">
                  <NuxtLink
                    v-if="activity.ownerEntity"
                    :to="`/entities/${activity.ownerEntityId}`"
                    class="text-primary hover:underline"
                  >
                    {{ activity.ownerEntity.name }}
                  </NuxtLink>
                  <span v-else class="text-muted-foreground">Не указан</span>
                </div>
                <EntityCombobox
                  v-else
                  v-model="editForm.ownerEntityId"
                  entity-type="person"
                  placeholder="Поиск владельца..."
                  class="mt-1"
                />
              </div>

              <!-- Client -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Клиент</label>
                <div v-if="!isEditing" class="mt-1">
                  <NuxtLink
                    v-if="activity.clientEntity"
                    :to="`/entities/${activity.clientEntityId}`"
                    class="text-primary hover:underline"
                  >
                    {{ activity.clientEntity.name }}
                  </NuxtLink>
                  <span v-else class="text-muted-foreground">Не указан</span>
                </div>
                <EntityCombobox
                  v-else
                  v-model="editForm.clientEntityId"
                  placeholder="Поиск клиента..."
                  class="mt-1"
                />
              </div>

              <!-- Progress -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Прогресс</label>
                <div v-if="!isEditing" class="mt-1 flex items-center gap-3">
                  <div class="flex-1 bg-muted rounded-full h-2">
                    <div
                      class="bg-primary rounded-full h-2 transition-all"
                      :style="{ width: `${activity.progress || 0}%` }"
                    />
                  </div>
                  <span class="text-sm text-muted-foreground w-10 text-right">{{ activity.progress || 0 }}%</span>
                </div>
                <div v-else class="mt-1 flex items-center gap-3">
                  <Input
                    v-model.number="editForm.progress"
                    type="number"
                    min="0"
                    max="100"
                    class="w-24"
                  />
                  <span class="text-sm text-muted-foreground">%</span>
                </div>
              </div>

              <!-- Tags -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Теги</label>
                <div v-if="!isEditing" class="mt-1 flex flex-wrap gap-1">
                  <Badge
                    v-for="tag in activity.tags"
                    :key="tag"
                    variant="secondary"
                  >
                    {{ tag }}
                  </Badge>
                  <span v-if="!activity.tags?.length" class="text-muted-foreground text-sm">Нет тегов</span>
                </div>
                <Input
                  v-else
                  v-model="editTagsInput"
                  placeholder="web, frontend, клиент"
                  class="mt-1"
                />
              </div>
            </CardContent>
          </Card>

          <!-- Card: Участники -->
          <Card>
            <CardHeader class="flex flex-row items-center justify-between">
              <CardTitle class="text-lg flex items-center gap-2">
                <Users class="h-5 w-5" />
                Участники
              </CardTitle>
              <Button size="sm" variant="outline" @click="showAddMemberDialog = true">
                <Plus class="mr-2 h-4 w-4" />
                Добавить
              </Button>
            </CardHeader>
            <CardContent>
              <div v-if="!members?.length" class="text-muted-foreground text-center py-4">
                <Users class="h-8 w-8 mx-auto mb-2 opacity-30" />
                <p>Нет участников</p>
              </div>
              <div v-else class="space-y-2">
                <div
                  v-for="member in members"
                  :key="member.id"
                  class="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                >
                  <div class="flex items-center gap-3">
                    <div class="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Users class="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <NuxtLink
                        v-if="member.entity"
                        :to="`/entities/${member.entityId}`"
                        class="font-medium text-primary hover:underline"
                      >
                        {{ member.entity.name }}
                      </NuxtLink>
                      <span v-else class="font-medium">{{ member.entityId }}</span>
                      <Badge variant="outline" class="ml-2 text-xs">
                        {{ ACTIVITY_MEMBER_ROLE_LABELS[member.role] }}
                      </Badge>
                    </div>
                  </div>
                  <span v-if="member.notes" class="text-sm text-muted-foreground truncate max-w-[200px]">
                    {{ member.notes }}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- Right column: Sidebar -->
        <div class="space-y-6">
          <!-- Card: Сроки -->
          <Card>
            <CardHeader>
              <CardTitle class="text-lg">Сроки</CardTitle>
            </CardHeader>
            <CardContent class="space-y-3">
              <!-- Start date -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Дата начала</label>
                <div v-if="!isEditing" class="mt-1 flex items-center gap-2">
                  <Calendar class="h-4 w-4 text-muted-foreground" />
                  <span>{{ activity.startDate ? formatDate(activity.startDate) : 'Не указана' }}</span>
                </div>
                <Input
                  v-else
                  v-model="editForm.startDate"
                  type="date"
                  class="mt-1"
                />
              </div>

              <!-- Deadline -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Дедлайн</label>
                <div v-if="!isEditing" class="mt-1 flex items-center gap-2">
                  <AlertTriangle
                    v-if="isOverdue(activity.deadline)"
                    class="h-4 w-4 text-destructive"
                  />
                  <Clock v-else class="h-4 w-4 text-muted-foreground" />
                  <span :class="{ 'text-destructive font-medium': isOverdue(activity.deadline) }">
                    {{ activity.deadline ? formatDate(activity.deadline) : 'Не указан' }}
                  </span>
                </div>
                <Input
                  v-else
                  v-model="editForm.deadline"
                  type="date"
                  class="mt-1"
                />
              </div>

              <!-- Recurrence -->
              <div v-if="activity.recurrenceRule">
                <label class="text-sm font-medium text-muted-foreground">Повторение</label>
                <div class="mt-1 flex items-center gap-2">
                  <RefreshCw class="h-4 w-4 text-muted-foreground" />
                  <span>{{ activity.recurrenceRule }}</span>
                </div>
              </div>

              <div class="border-t pt-3 space-y-2 text-sm">
                <div>
                  <span class="text-muted-foreground">Создано:</span>
                  <span class="ml-2">{{ formatDateTime(activity.createdAt) }}</span>
                </div>
                <div>
                  <span class="text-muted-foreground">Обновлено:</span>
                  <span class="ml-2">{{ formatDateTime(activity.updatedAt) }}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          <!-- Card: Иерархия -->
          <Card>
            <CardHeader class="flex flex-row items-center justify-between">
              <CardTitle class="text-lg">Иерархия</CardTitle>
              <NuxtLink :to="`/activities/new?parentId=${activity.id}&type=task`">
                <Button size="sm" variant="outline">
                  <Plus class="mr-2 h-4 w-4" />
                  Подзадача
                </Button>
              </NuxtLink>
            </CardHeader>
            <CardContent class="space-y-3">
              <!-- Parent -->
              <div>
                <div class="flex items-center justify-between">
                  <label class="text-sm font-medium text-muted-foreground">Родитель</label>
                  <Button
                    v-if="!isEditing"
                    size="sm"
                    variant="ghost"
                    class="h-7 px-2 text-xs"
                    @click="openParentDialog"
                  >
                    <Link class="mr-1 h-3 w-3" />
                    Привязать
                  </Button>
                </div>
                <div v-if="!isEditing" class="mt-1">
                  <NuxtLink
                    v-if="activity.parent"
                    :to="`/activities/${activity.parent.id}`"
                    class="flex items-center gap-2 text-primary hover:underline"
                  >
                    <component :is="TYPE_ICONS[activity.parent.activityType]" class="h-4 w-4" />
                    {{ ACTIVITY_TYPE_LABELS[activity.parent.activityType] }}: {{ activity.parent.name }}
                  </NuxtLink>
                  <span v-else class="text-muted-foreground">Корневая активность</span>
                </div>
                <select
                  v-else
                  v-model="editForm.parentId"
                  class="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Без родителя (корневая)</option>
                  <option v-for="candidate in parentCandidates" :key="candidate.id" :value="candidate.id">
                    {{ ACTIVITY_TYPE_LABELS[candidate.activityType] }}: {{ candidate.name }}
                  </option>
                </select>
              </div>

              <!-- Children -->
              <div>
                <label class="text-sm font-medium text-muted-foreground">Дочерние активности</label>
                <div v-if="children.length" class="mt-1 space-y-1">
                  <NuxtLink
                    v-for="child in children"
                    :key="child.id"
                    :to="`/activities/${child.id}`"
                    class="flex items-center gap-2 p-2 rounded-lg hover:bg-accent/50 transition-colors group"
                  >
                    <component :is="TYPE_ICONS[child.activityType]" class="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
                    <span class="flex-1 truncate text-sm group-hover:text-primary">{{ child.name }}</span>
                    <Badge :class="ACTIVITY_STATUS_COLORS[child.status]" class="text-xs shrink-0">
                      {{ ACTIVITY_STATUS_LABELS[child.status] }}
                    </Badge>
                    <ChevronRight class="h-4 w-4 text-muted-foreground shrink-0" />
                  </NuxtLink>
                </div>
                <p v-else class="mt-1 text-sm text-muted-foreground">Нет дочерних активностей</p>
              </div>

              <!-- Depth & Path -->
              <div v-if="activity.depth > 0" class="text-sm">
                <span class="text-muted-foreground">Глубина:</span>
                <span class="ml-2">{{ activity.depth }}</span>
              </div>
              <div v-if="activity.materializedPath" class="text-sm">
                <span class="text-muted-foreground">Путь:</span>
                <span class="ml-2 font-mono text-xs break-all">{{ activity.materializedPath }}</span>
              </div>
            </CardContent>
          </Card>

          <!-- Card: Метаданные -->
          <Card>
            <CardHeader>
              <CardTitle class="text-lg">Метаданные</CardTitle>
            </CardHeader>
            <CardContent>
              <div class="space-y-2 text-sm">
                <div>
                  <span class="text-muted-foreground">ID:</span>
                  <span class="ml-2 font-mono text-xs">{{ activity.id }}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>

    <!-- Confirm Archive Dialog -->
    <ConfirmDialog
      v-model:open="showArchiveConfirm"
      title="Архивировать активность"
      :description="`Вы уверены, что хотите архивировать «${activity?.name}»?`"
      confirm-text="Архивировать"
      variant="destructive"
      :loading="deleteActivity.isPending.value"
      @confirm="confirmArchive"
    />

    <!-- Add Member Dialog -->
    <ClientOnly>
      <Dialog v-model:open="showAddMemberDialog">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Добавить участника</DialogTitle>
            <DialogDescription>
              Выберите сущность и роль для добавления в активность
            </DialogDescription>
          </DialogHeader>
          <div class="space-y-4 py-4">
            <div class="space-y-2">
              <label class="text-sm font-medium">Сущность</label>
              <EntityCombobox
                v-model="newMemberEntityId"
                placeholder="Поиск сущности..."
              />
            </div>
            <div class="space-y-2">
              <label class="text-sm font-medium">Роль</label>
              <select
                v-model="newMemberRole"
                class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option v-for="[value, label] in memberRoles" :key="value" :value="value">
                  {{ label }}
                </option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="showAddMemberDialog = false">Отмена</Button>
            <Button
              :disabled="!newMemberEntityId || addMembers.isPending.value"
              @click="handleAddMember"
            >
              {{ addMembers.isPending.value ? 'Добавление...' : 'Добавить' }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ClientOnly>

    <!-- Quick Parent Assignment Dialog -->
    <ClientOnly>
      <Dialog v-model:open="showParentDialog">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Привязать к родительской активности</DialogTitle>
            <DialogDescription>
              Выберите проект, направление или другую активность, к которой принадлежит текущая
            </DialogDescription>
          </DialogHeader>
          <div class="py-4">
            <select
              v-model="selectedParentId"
              class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Без родителя (корневая)</option>
              <option v-for="candidate in parentCandidates" :key="candidate.id" :value="candidate.id">
                {{ ACTIVITY_TYPE_LABELS[candidate.activityType] }}: {{ candidate.name }}
              </option>
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="showParentDialog = false">Отмена</Button>
            <Button
              :disabled="updateActivity.isPending.value"
              @click="handleQuickParentAssign"
            >
              {{ updateActivity.isPending.value ? 'Сохранение...' : 'Привязать' }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ClientOnly>
  </div>
</template>
