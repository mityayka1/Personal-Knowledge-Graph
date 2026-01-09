<script setup lang="ts">
import { ArrowLeft, User, Building2 } from 'lucide-vue-next';
import { useCreateEntity, type CreateEntityDto } from '~/composables/useEntities';

const router = useRouter();

const createEntity = useCreateEntity();

const form = reactive<CreateEntityDto>({
  type: 'person',
  name: '',
  notes: '',
});

const errors = reactive({
  name: '',
});

function validateForm() {
  errors.name = '';

  if (!form.name.trim()) {
    errors.name = 'Имя обязательно';
    return false;
  }

  return true;
}

async function handleSubmit() {
  if (!validateForm()) return;

  try {
    const entity = await createEntity.mutateAsync({
      type: form.type,
      name: form.name.trim(),
      notes: form.notes?.trim() || undefined,
    });
    router.push(`/entities/${entity.id}`);
  } catch (err) {
    console.error('Failed to create entity:', err);
  }
}
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

    <Card class="max-w-2xl">
      <CardHeader>
        <CardTitle>Создать сущность</CardTitle>
        <CardDescription>Добавить нового человека или организацию в граф знаний</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-6" @submit.prevent="handleSubmit">
          <!-- Type selection -->
          <div class="space-y-2">
            <label class="text-sm font-medium">Тип</label>
            <div class="flex gap-4">
              <button
                type="button"
                :class="[
                  'flex items-center gap-2 px-4 py-3 rounded-lg border-2 transition-colors',
                  form.type === 'person'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground',
                ]"
                @click="form.type = 'person'"
              >
                <User :class="['h-5 w-5', form.type === 'person' ? 'text-primary' : 'text-muted-foreground']" />
                <span :class="form.type === 'person' ? 'font-medium' : ''">Человек</span>
              </button>
              <button
                type="button"
                :class="[
                  'flex items-center gap-2 px-4 py-3 rounded-lg border-2 transition-colors',
                  form.type === 'organization'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:border-muted-foreground',
                ]"
                @click="form.type = 'organization'"
              >
                <Building2 :class="['h-5 w-5', form.type === 'organization' ? 'text-primary' : 'text-muted-foreground']" />
                <span :class="form.type === 'organization' ? 'font-medium' : ''">Организация</span>
              </button>
            </div>
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
            <label for="notes" class="text-sm font-medium">Заметки (опционально)</label>
            <textarea
              id="notes"
              v-model="form.notes"
              placeholder="Добавьте заметки..."
              class="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <!-- Submit -->
          <div class="flex gap-4">
            <Button type="submit" :disabled="createEntity.isPending.value">
              {{ createEntity.isPending.value ? 'Создание...' : 'Создать' }}
            </Button>
            <NuxtLink to="/entities">
              <Button type="button" variant="outline">Отмена</Button>
            </NuxtLink>
          </div>

          <!-- Error -->
          <p v-if="createEntity.error.value" class="text-sm text-destructive">
            Не удалось создать сущность. Попробуйте ещё раз.
          </p>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
