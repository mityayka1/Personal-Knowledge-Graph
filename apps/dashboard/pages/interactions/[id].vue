<script setup lang="ts">
import { ArrowLeft, MessageSquare, User } from 'lucide-vue-next';
import { formatDateTime } from '~/lib/utils';

const route = useRoute();
const interactionId = computed(() => route.params.id as string);

interface Message {
  id: string;
  content: string;
  timestamp: string;
  isOutgoing: boolean;
  senderEntityId?: string;
}

interface Interaction {
  id: string;
  type: string;
  source: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  participants: Array<{
    id: string;
    role: string;
    entityId?: string;
    displayName?: string;
  }>;
  messages: Message[];
}

const { data: interaction, pending, error } = useFetch<Interaction>(`/api/interactions/${interactionId.value}`);
</script>

<template>
  <div>
    <!-- Back button -->
    <div class="mb-6">
      <NuxtLink to="/interactions" class="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="mr-2 h-4 w-4" />
        Назад к взаимодействиям
      </NuxtLink>
    </div>

    <!-- Loading state -->
    <div v-if="pending" class="space-y-6">
      <Skeleton class="h-8 w-48" />
      <Skeleton class="h-64 w-full" />
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="text-center py-12">
      <p class="text-destructive">Не удалось загрузить взаимодействие</p>
      <NuxtLink to="/interactions">
        <Button variant="outline" class="mt-4">Вернуться</Button>
      </NuxtLink>
    </div>

    <!-- Interaction details -->
    <div v-else-if="interaction" class="space-y-6">
      <!-- Header -->
      <div class="flex items-start justify-between">
        <div>
          <h1 class="text-3xl font-bold tracking-tight">Взаимодействие</h1>
          <div class="flex items-center gap-2 mt-2">
            <Badge>{{ interaction.type }}</Badge>
            <Badge variant="outline">{{ interaction.source }}</Badge>
            <Badge :variant="interaction.status === 'COMPLETED' ? 'secondary' : 'default'">
              {{ interaction.status }}
            </Badge>
          </div>
        </div>
      </div>

      <!-- Metadata -->
      <Card>
        <CardHeader>
          <CardTitle class="text-lg">Детали</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span class="text-muted-foreground">Начало:</span>
              <span class="ml-2">{{ formatDateTime(interaction.startedAt) }}</span>
            </div>
            <div v-if="interaction.endedAt">
              <span class="text-muted-foreground">Завершение:</span>
              <span class="ml-2">{{ formatDateTime(interaction.endedAt) }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Сообщений:</span>
              <span class="ml-2">{{ interaction.messages?.length || 0 }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Участников:</span>
              <span class="ml-2">{{ interaction.participants?.length || 0 }}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Messages -->
      <Card>
        <CardHeader>
          <CardTitle class="text-lg">Сообщения</CardTitle>
        </CardHeader>
        <CardContent>
          <div v-if="!interaction.messages?.length" class="text-muted-foreground text-center py-8">
            Нет сообщений в этом взаимодействии
          </div>
          <div v-else class="space-y-4 max-h-[600px] overflow-y-auto">
            <div
              v-for="message in interaction.messages"
              :key="message.id"
              :class="[
                'flex gap-3',
                message.isOutgoing ? 'flex-row-reverse' : '',
              ]"
            >
              <div class="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                <User class="h-4 w-4 text-muted-foreground" />
              </div>
              <div
                :class="[
                  'max-w-[70%] rounded-lg p-3',
                  message.isOutgoing
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted',
                ]"
              >
                <p class="text-sm whitespace-pre-wrap">{{ message.content }}</p>
                <p
                  :class="[
                    'text-xs mt-1',
                    message.isOutgoing ? 'text-primary-foreground/70' : 'text-muted-foreground',
                  ]"
                >
                  {{ formatDateTime(message.timestamp) }}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
