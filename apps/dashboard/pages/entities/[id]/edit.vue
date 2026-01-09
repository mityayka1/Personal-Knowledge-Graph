<script setup lang="ts">
import { ArrowLeft, User, Building2 } from 'lucide-vue-next';
import { useEntity, useUpdateEntity, type UpdateEntityDto } from '~/composables/useEntities';

const route = useRoute();
const router = useRouter();

const entityId = computed(() => route.params.id as string);
const { data: entity, isLoading, error: loadError } = useEntity(entityId);

const updateEntity = useUpdateEntity();

const form = reactive<UpdateEntityDto>({
  name: '',
  notes: '',
});

const errors = reactive({
  name: '',
});

// Initialize form when entity loads
watch(entity, (newEntity) => {
  if (newEntity) {
    form.name = newEntity.name;
    form.notes = newEntity.notes || '';
  }
}, { immediate: true });

function validateForm() {
  errors.name = '';

  if (!form.name?.trim()) {
    errors.name = 'Имя обязательно';
    return false;
  }

  return true;
}

async function handleSubmit() {
  if (!validateForm() || !entity.value) return;

  try {
    await updateEntity.mutateAsync({
      id: entity.value.id,
      data: {
        name: form.name?.trim(),
        notes: form.notes?.trim() || null,
      },
    });
    router.push(`/entities/${entity.value.id}`);
  } catch (err) {
    console.error('Failed to update entity:', err);
  }
}
</script>

<template>
  <div>
    <!-- Back button -->
    <div class="mb-6">
      <NuxtLink :to="`/entities/${entityId}`" class="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="mr-2 h-4 w-4" />
        Назад к сущности
      </NuxtLink>
    </div>

    <!-- Loading state -->
    <div v-if="isLoading" class="space-y-6 max-w-2xl">
      <Skeleton class="h-8 w-48" />
      <Skeleton class="h-32 w-full" />
      <Skeleton class="h-10 w-24" />
    </div>

    <!-- Error state -->
    <div v-else-if="loadError" class="text-center py-12">
      <p class="text-destructive">Не удалось загрузить сущность</p>
      <NuxtLink to="/entities">
        <Button variant="outline" class="mt-4">Вернуться</Button>
      </NuxtLink>
    </div>

    <!-- Edit form -->
    <Card v-else-if="entity" class="max-w-2xl">
      <CardHeader>
        <CardTitle>Редактировать сущность</CardTitle>
        <CardDescription>Изменить данные "{{ entity.name }}"</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-6" @submit.prevent="handleSubmit">
          <!-- Type (read-only) -->
          <div class="space-y-2">
            <label class="text-sm font-medium">Тип</label>
            <div class="flex gap-4">
              <div
                :class="[
                  'flex items-center gap-2 px-4 py-3 rounded-lg border-2',
                  entity.type === 'person'
                    ? 'border-primary bg-primary/5'
                    : 'border-border opacity-50',
                ]"
              >
                <User :class="['h-5 w-5', entity.type === 'person' ? 'text-primary' : 'text-muted-foreground']" />
                <span :class="entity.type === 'person' ? 'font-medium' : ''">Человек</span>
              </div>
              <div
                :class="[
                  'flex items-center gap-2 px-4 py-3 rounded-lg border-2',
                  entity.type === 'organization'
                    ? 'border-primary bg-primary/5'
                    : 'border-border opacity-50',
                ]"
              >
                <Building2 :class="['h-5 w-5', entity.type === 'organization' ? 'text-primary' : 'text-muted-foreground']" />
                <span :class="entity.type === 'organization' ? 'font-medium' : ''">Организация</span>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">Тип сущности нельзя изменить</p>
          </div>

          <!-- Name -->
          <div class="space-y-2">
            <label for="name" class="text-sm font-medium">Имя</label>
            <Input
              id="name"
              v-model="form.name"
              placeholder="Введите имя"
              :class="errors.name ? 'border-destructive' : ''"
            />
            <p v-if="errors.name" class="text-sm text-destructive">{{ errors.name }}</p>
          </div>

          <!-- Notes -->
          <div class="space-y-2">
            <label for="notes" class="text-sm font-medium">Заметки</label>
            <textarea
              id="notes"
              v-model="form.notes"
              placeholder="Добавьте заметки..."
              class="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <!-- Submit -->
          <div class="flex gap-4">
            <Button type="submit" :disabled="updateEntity.isPending.value">
              {{ updateEntity.isPending.value ? 'Сохранение...' : 'Сохранить' }}
            </Button>
            <NuxtLink :to="`/entities/${entityId}`">
              <Button type="button" variant="outline">Отмена</Button>
            </NuxtLink>
          </div>

          <!-- Error -->
          <p v-if="updateEntity.error.value" class="text-sm text-destructive">
            Не удалось обновить сущность. Попробуйте ещё раз.
          </p>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
