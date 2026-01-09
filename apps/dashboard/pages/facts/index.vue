<script setup lang="ts">
import { CheckCircle, XCircle, Check, User, Quote } from 'lucide-vue-next';
import { formatRelativeTime } from '~/lib/utils';

definePageMeta({
  title: 'Факты на проверку',
});

interface PendingFact {
  id: string;
  entityId: string;
  entity?: { id: string; name: string };
  factType: string;
  value?: string;
  valueDate?: string;
  confidence: number;
  sourceQuote?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
}

interface FactListResponse {
  items: PendingFact[];
  total: number;
}

const { data, pending, error, refresh } = useFetch<FactListResponse>('/api/pending-facts', {
  query: { status: 'PENDING', limit: 50 },
});

async function approve(factId: string) {
  try {
    await $fetch(`/api/pending-facts/${factId}/approve`, {
      method: 'PATCH',
    });
    refresh();
  } catch (err) {
    console.error('Failed to approve:', err);
  }
}

async function reject(factId: string) {
  try {
    await $fetch(`/api/pending-facts/${factId}/reject`, {
      method: 'PATCH',
    });
    refresh();
  } catch (err) {
    console.error('Failed to reject:', err);
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold tracking-tight">Факты на проверку</h1>
      <p class="text-muted-foreground">Проверить и подтвердить извлечённые факты</p>
    </div>

    <!-- Error state -->
    <div v-if="error" class="text-destructive text-center py-8">
      Не удалось загрузить факты. Попробуйте ещё раз.
    </div>

    <!-- Loading state -->
    <div v-else-if="pending" class="space-y-4">
      <Card v-for="i in 3" :key="i">
        <CardContent class="p-4">
          <div class="space-y-2">
            <Skeleton class="h-4 w-1/3" />
            <Skeleton class="h-3 w-1/2" />
          </div>
        </CardContent>
      </Card>
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!data?.items.length"
      class="text-center py-12 text-muted-foreground"
    >
      <Check class="h-12 w-12 mx-auto mb-4 text-green-500" />
      <p class="text-lg font-medium text-foreground">Всё обработано!</p>
      <p>Нет фактов для проверки</p>
    </div>

    <!-- Fact list -->
    <div v-else class="space-y-4">
      <Card v-for="fact in data.items" :key="fact.id">
        <CardContent class="p-6">
          <div class="flex items-start gap-4">
            <div class="flex-1 min-w-0">
              <!-- Header -->
              <div class="flex items-center gap-2 mb-2">
                <Badge>{{ fact.factType }}</Badge>
                <Badge variant="secondary">
                  {{ Math.round(fact.confidence * 100) }}% уверенность
                </Badge>
              </div>

              <!-- Value -->
              <p class="text-lg font-medium mb-2">
                {{ fact.value || fact.valueDate }}
              </p>

              <!-- Entity -->
              <div v-if="fact.entity" class="flex items-center gap-2 text-sm text-muted-foreground mb-3">
                <User class="h-4 w-4" />
                <NuxtLink :to="`/entities/${fact.entity.id}`" class="hover:underline">
                  {{ fact.entity.name }}
                </NuxtLink>
              </div>

              <!-- Source quote -->
              <div v-if="fact.sourceQuote" class="bg-muted rounded-lg p-3 mb-3">
                <div class="flex items-start gap-2">
                  <Quote class="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                  <p class="text-sm italic">{{ fact.sourceQuote }}</p>
                </div>
              </div>

              <!-- Metadata -->
              <p class="text-xs text-muted-foreground mb-4">
                Извлечено {{ formatRelativeTime(fact.createdAt) }}
              </p>

              <!-- Actions -->
              <div class="flex gap-2">
                <Button size="sm" @click="approve(fact.id)">
                  <CheckCircle class="mr-2 h-4 w-4" />
                  Подтвердить
                </Button>
                <Button variant="outline" size="sm" @click="reject(fact.id)">
                  <XCircle class="mr-2 h-4 w-4" />
                  Отклонить
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Stats -->
      <p class="text-sm text-muted-foreground text-center">
        Показано {{ data.items.length }} из {{ data.total }} фактов на проверку
      </p>
    </div>
  </div>
</template>
