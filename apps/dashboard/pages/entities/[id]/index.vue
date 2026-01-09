<script setup lang="ts">
import { ArrowLeft, Edit, Trash2, User, Building2, Mail, Phone, Calendar, Tag } from 'lucide-vue-next';
import { useEntity, useDeleteEntity } from '~/composables/useEntities';
import { formatDate, formatDateTime } from '~/lib/utils';

const route = useRoute();
const router = useRouter();

const entityId = computed(() => route.params.id as string);
const { data: entity, isLoading, error } = useEntity(entityId);

const deleteEntity = useDeleteEntity();

async function handleDelete() {
  if (!entity.value) return;

  if (confirm(`Вы уверены, что хотите удалить "${entity.value.name}"?`)) {
    await deleteEntity.mutateAsync(entity.value.id);
    router.push('/entities');
  }
}

function getIdentifierIcon(type: string) {
  switch (type.toLowerCase()) {
    case 'email':
      return Mail;
    case 'phone':
      return Phone;
    default:
      return Tag;
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
              <Badge variant="secondary">{{ entity.type.toLowerCase() }}</Badge>
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
                <component :is="getIdentifierIcon(identifier.type)" class="h-4 w-4 text-muted-foreground" />
              </div>
              <div>
                <div class="font-medium">{{ identifier.value }}</div>
                <div class="text-xs text-muted-foreground">{{ identifier.type }}</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Facts -->
      <Card>
        <CardHeader>
          <CardTitle class="text-lg">Факты</CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="!entity.facts.length" class="text-muted-foreground">
            Нет фактов
          </div>
          <div v-else class="space-y-3">
            <div
              v-for="fact in entity.facts"
              :key="fact.id"
              class="flex items-start gap-3 p-3 rounded-lg bg-muted/50"
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
                  Источник: {{ fact.source.toLowerCase() }}
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

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
