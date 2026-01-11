<script setup lang="ts">
import { ArrowLeft, MessageSquare, User, ExternalLink, Sparkles, Loader2, FileText } from 'lucide-vue-next';
import { formatDateTime } from '~/lib/utils';
import {
  useSummarizationStatus,
  useTriggerSummarization,
  getToneInfo,
} from '~/composables/useSummarization';

const route = useRoute();
const interactionId = computed(() => route.params.id as string);

// Summarization
const { data: summaryStatus, refetch: refetchStatus } = useSummarizationStatus(interactionId);
const triggerSummarization = useTriggerSummarization();

interface Message {
  id: string;
  content: string;
  timestamp: string;
  isOutgoing: boolean;
  senderEntityId?: string;
  senderIdentifierType?: string;
  senderIdentifierValue?: string;
}

interface Participant {
  id: string;
  role: string;
  entityId?: string;
  displayName?: string;
  identifierType?: string;
  identifierValue?: string;
}

interface Interaction {
  id: string;
  type: string;
  source: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  sourceMetadata?: {
    telegram_chat_id?: string;
  };
  participants: Participant[];
  messages: Message[];
}

const { data: interaction, pending, error } = useFetch<Interaction>(`/api/interactions/${interactionId.value}`);

// Create a map of identifier -> participant for quick lookup
const participantMap = computed(() => {
  const map = new Map<string, Participant>();
  interaction.value?.participants?.forEach(p => {
    if (p.identifierValue) {
      map.set(p.identifierValue, p);
    }
  });
  return map;
});

// Get sender display name for a message
function getSenderName(message: Message): string {
  if (message.isOutgoing) return 'Вы';
  if (message.senderIdentifierValue) {
    const participant = participantMap.value.get(message.senderIdentifierValue);
    if (participant?.displayName) return participant.displayName;
    return `ID: ${message.senderIdentifierValue}`;
  }
  return 'Неизвестный';
}

// Get chat display name and link
const chatInfo = computed(() => {
  const chatId = interaction.value?.sourceMetadata?.telegram_chat_id;
  if (!chatId) return null;

  // Parse chat_id format: user_XXX, chat_XXX, channel_XXX
  const parts = chatId.split('_');
  const type = parts[0];
  const id = parts.slice(1).join('_');

  let displayName = chatId;
  let link: string | null = null;

  if (type === 'user') {
    displayName = `Личный чат (${id})`;
    // Find participant to get display name
    const participant = interaction.value?.participants?.find(p =>
      p.identifierValue === id && p.role !== 'self'
    );
    if (participant?.displayName) {
      displayName = `Личный чат с ${participant.displayName}`;
    }
  } else if (type === 'chat') {
    displayName = `Группа (${id})`;
    // Telegram private group/channel links need message ID at the end
    link = `https://t.me/c/${id}/1`;
  } else if (type === 'channel') {
    displayName = `Канал/Группа (${id})`;
    // Telegram private group/channel links need message ID at the end
    link = `https://t.me/c/${id}/1`;
  }

  return { displayName, link, rawId: chatId };
});

// Handle summarization
async function handleSummarize() {
  try {
    await triggerSummarization.mutateAsync(interactionId.value);
    await refetchStatus();
  } catch (error) {
    console.error('Summarization failed:', error);
  }
}
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
        <div class="flex gap-2">
          <Button
            v-if="!summaryStatus?.hasSummary"
            @click="handleSummarize"
            :disabled="triggerSummarization.isPending.value"
          >
            <Loader2 v-if="triggerSummarization.isPending.value" class="mr-2 h-4 w-4 animate-spin" />
            <Sparkles v-else class="mr-2 h-4 w-4" />
            Создать резюме
          </Button>
          <Badge v-else variant="secondary" class="flex items-center gap-1">
            <FileText class="h-3 w-3" />
            Резюме создано
          </Badge>
        </div>
      </div>

      <!-- Summary Card (if exists) -->
      <Card v-if="summaryStatus?.hasSummary && summaryStatus.summary" class="border-primary/20 bg-primary/5">
        <CardHeader>
          <div class="flex items-center justify-between">
            <CardTitle class="text-lg flex items-center gap-2">
              <Sparkles class="h-5 w-5 text-primary" />
              AI Резюме
            </CardTitle>
            <div class="flex items-center gap-2">
              <Badge
                v-if="summaryStatus.summary.tone"
                :class="getToneInfo(summaryStatus.summary.tone).color"
              >
                {{ getToneInfo(summaryStatus.summary.tone).label }}
              </Badge>
              <span class="text-xs text-muted-foreground">
                {{ summaryStatus.summary.messageCount }} сообщений
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- Summary text -->
          <div>
            <p class="text-sm font-medium text-muted-foreground mb-1">Краткое содержание</p>
            <p class="text-sm">{{ summaryStatus.summary.summaryText }}</p>
          </div>

          <!-- Key points -->
          <div v-if="summaryStatus.summary.keyPoints?.length">
            <p class="text-sm font-medium text-muted-foreground mb-2">Ключевые темы</p>
            <div class="flex flex-wrap gap-2">
              <Badge v-for="(point, idx) in summaryStatus.summary.keyPoints" :key="idx" variant="outline">
                {{ point }}
              </Badge>
            </div>
          </div>

          <!-- Compression ratio -->
          <div v-if="summaryStatus.summary.compressionRatio" class="text-xs text-muted-foreground">
            Сжатие: {{ summaryStatus.summary.compressionRatio?.toFixed(1) }}x
          </div>
        </CardContent>
      </Card>

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
            <div>
              <span class="text-muted-foreground">Сообщений:</span>
              <span class="ml-2">{{ interaction.messages?.length || 0 }}</span>
            </div>
            <div>
              <span class="text-muted-foreground">Участников:</span>
              <span class="ml-2">{{ interaction.participants?.length || 0 }}</span>
            </div>
            <div v-if="chatInfo">
              <span class="text-muted-foreground">Чат:</span>
              <a
                v-if="chatInfo.link"
                :href="chatInfo.link"
                target="_blank"
                rel="noopener noreferrer"
                class="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
              >
                {{ chatInfo.displayName }}
                <ExternalLink class="h-3 w-3" />
              </a>
              <span v-else class="ml-2">{{ chatInfo.displayName }}</span>
            </div>
          </div>

          <!-- Participants list -->
          <div v-if="interaction.participants?.length" class="mt-4 pt-4 border-t">
            <div class="text-sm text-muted-foreground mb-2">Участники:</div>
            <div class="flex flex-wrap gap-2">
              <Badge
                v-for="participant in interaction.participants"
                :key="participant.id"
                variant="secondary"
                class="text-xs"
              >
                {{ participant.displayName || participant.identifierValue || 'Неизвестный' }}
              </Badge>
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
                <!-- Sender name -->
                <p
                  :class="[
                    'text-xs font-medium mb-1',
                    message.isOutgoing ? 'text-primary-foreground/80' : 'text-foreground/80',
                  ]"
                >
                  {{ getSenderName(message) }}
                </p>
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
