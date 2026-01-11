<script setup lang="ts">
import { ArrowLeft, RefreshCw, Users, MessageSquare, Radio, Image, Video, Mic, FileText, ChevronLeft, ChevronRight, Hash } from 'lucide-vue-next';
import { useChatMessages, useRefreshChat, type ChatMessage } from '~/composables/useChatMessages';
import { useChatCategory } from '~/composables/useChatCategories';

const route = useRoute();
const telegramChatId = computed(() => route.params.id as string);

definePageMeta({
  title: 'Чат',
});

const limit = ref(50);
const offset = ref(0);

const params = computed(() => ({
  limit: limit.value,
  offset: offset.value,
  order: 'DESC' as const,
}));

// Get chat info using dedicated endpoint
const { data: chatInfo, refetch: refetchChatInfo } = useChatCategory(telegramChatId);

// Get messages
const { data, isLoading, error, refetch } = useChatMessages(telegramChatId, params);

const refreshMutation = useRefreshChat();

const currentPage = computed(() => Math.floor(offset.value / limit.value) + 1);
const totalPages = computed(() => data.value ? Math.ceil(data.value.total / limit.value) : 0);

// Check if this is a forum - prefer API flag, fallback to message topics
const isForum = computed(() => {
  // First check API response
  if (chatInfo.value?.isForum) return true;
  // Fallback: check if any messages have topics
  if (!data.value?.items) return false;
  return data.value.items.some(msg => msg.topicId || msg.topicName);
});

function nextPage() {
  if (data.value && offset.value + limit.value < data.value.total) {
    offset.value += limit.value;
  }
}

function prevPage() {
  if (offset.value > 0) {
    offset.value = Math.max(0, offset.value - limit.value);
  }
}

async function refreshChat() {
  await refreshMutation.mutateAsync(telegramChatId.value);
  refetchChatInfo();
  refetch();
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString('ru-RU');
}

function getSenderName(msg: ChatMessage): string {
  if (msg.isOutgoing) return 'Вы';
  if (msg.senderEntity?.name) return msg.senderEntity.name;
  return msg.senderIdentifierValue || 'Unknown';
}

function getSenderAvatar(msg: ChatMessage): string | undefined {
  return msg.senderEntity?.profilePhoto;
}

function getMediaIcon(mediaType?: string) {
  switch (mediaType) {
    case 'photo': return Image;
    case 'video': return Video;
    case 'video_note': return Video;
    case 'voice': return Mic;
    case 'audio': return Mic;
    case 'document': return FileText;
    case 'sticker': return Image;
    case 'animation': return Video;
    default: return FileText;
  }
}

function getMediaLabel(mediaType?: string): string {
  switch (mediaType) {
    case 'photo': return 'Фото';
    case 'video': return 'Видео';
    case 'video_note': return 'Видео-кружок';
    case 'voice': return 'Голосовое сообщение';
    case 'audio': return 'Аудио';
    case 'sticker': return 'Стикер';
    case 'animation': return 'GIF';
    case 'document': return 'Документ';
    default: return 'Медиа';
  }
}

/**
 * Get media download URL via proxy
 * Works with or without mediaMetadata - only requires sourceMessageId and mediaType
 */
function getMediaUrl(msg: ChatMessage, thumb = false): string | null {
  if (!msg.sourceMessageId || !msg.mediaType) return null;
  const params = new URLSearchParams();
  if (thumb) params.set('thumb', 'true');
  // Use medium size for photos
  if (msg.mediaType === 'photo') params.set('size', 'x');
  return `/api/telegram/media/${telegramChatId.value}/${msg.sourceMessageId}?${params.toString()}`;
}

/**
 * Check if media can be displayed inline
 */
function isInlineMedia(mediaType?: string): boolean {
  return ['photo', 'video', 'video_note', 'sticker', 'animation'].includes(mediaType || '');
}

/**
 * Check if media is audio/voice
 */
function isAudioMedia(mediaType?: string): boolean {
  return ['voice', 'audio'].includes(mediaType || '');
}

/**
 * Format file size
 */
function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format duration
 */
function formatDuration(seconds?: number): string {
  if (!seconds) return '';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function openInNewTab(url: string | null) {
  if (url && typeof window !== 'undefined') {
    window.open(url, '_blank');
  }
}

function getChatIcon() {
  // If it's a forum (has topics), show hash icon
  if (isForum.value) return Hash;
  // Check by prefix - channel_ is used for both channels and supergroups
  if (telegramChatId.value.startsWith('channel_')) {
    // If participantsCount is small, it's likely a group, not a channel
    if (chatInfo.value?.participantsCount && chatInfo.value.participantsCount < 50) {
      return MessageSquare;
    }
    return Radio;
  }
  return MessageSquare;
}

function getChatTypeLabel(): string {
  if (isForum.value) return 'Форум';
  if (telegramChatId.value.startsWith('channel_')) {
    // If participantsCount is small, it's likely a group
    if (chatInfo.value?.participantsCount && chatInfo.value.participantsCount < 50) {
      return 'Группа';
    }
    return 'Канал / Группа';
  }
  return 'Группа';
}

function getChatTitle(): string {
  if (chatInfo.value?.title) return chatInfo.value.title;
  const parts = telegramChatId.value.split('_');
  return parts.length > 1 ? `ID: ${parts.slice(1).join('_')}` : telegramChatId.value;
}

function getCategoryBadge() {
  if (!chatInfo.value?.category) return null;
  const badges: Record<string, { label: string; class: string }> = {
    personal: { label: 'Личный', class: 'bg-blue-500/20 text-blue-400' },
    working: { label: 'Рабочий', class: 'bg-amber-500/20 text-amber-400' },
    mass: { label: 'Массовый', class: 'bg-gray-500/20 text-gray-400' },
  };
  return badges[chatInfo.value.category];
}

// Reverse messages for display (newest at bottom)
const reversedMessages = computed(() => {
  if (!data.value?.items) return [];
  return [...data.value.items].reverse();
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center gap-4 mb-4 pb-4 border-b">
      <NuxtLink to="/chats" class="p-2 hover:bg-accent rounded-lg transition-colors">
        <ArrowLeft class="h-5 w-5" />
      </NuxtLink>

      <div class="flex items-center gap-3 flex-1">
        <component :is="getChatIcon()" class="h-6 w-6 text-muted-foreground" />
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-xl font-bold">{{ getChatTitle() }}</h1>
            <span
              v-if="getCategoryBadge()"
              class="px-2 py-0.5 rounded text-xs font-medium"
              :class="getCategoryBadge()?.class"
            >
              {{ getCategoryBadge()?.label }}
            </span>
          </div>
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{{ getChatTypeLabel() }}</span>
            <span v-if="chatInfo?.participantsCount" class="flex items-center gap-1">
              <Users class="h-3 w-3" />
              {{ chatInfo.participantsCount }}
            </span>
            <span v-if="data?.total" class="flex items-center gap-1">
              <MessageSquare class="h-3 w-3" />
              {{ data.total }} сообщений
            </span>
          </div>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        :disabled="refreshMutation.isPending.value"
        @click="refreshChat"
      >
        <RefreshCw class="h-4 w-4 mr-2" :class="{ 'animate-spin': refreshMutation.isPending.value }" />
        Обновить
      </Button>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="flex-1 flex items-center justify-center">
      <div class="animate-pulse text-muted-foreground">Загрузка сообщений...</div>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="flex-1 flex items-center justify-center text-destructive">
      <p>Ошибка загрузки: {{ error.message }}</p>
    </div>

    <!-- Empty -->
    <div v-else-if="!data?.items?.length" class="flex-1 flex flex-col items-center justify-center text-muted-foreground">
      <MessageSquare class="h-12 w-12 mb-4 opacity-50" />
      <p>Нет сообщений в этом чате</p>
    </div>

    <!-- Messages -->
    <div v-else class="flex-1 flex flex-col">
      <!-- Pagination top -->
      <div v-if="totalPages > 1" class="flex items-center justify-between mb-4 pb-4 border-b">
        <div class="text-sm text-muted-foreground">
          Показано {{ offset + 1 }}-{{ Math.min(offset + limit, data.total) }} из {{ data.total }}
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="offset + limit >= data.total"
            @click="nextPage"
          >
            <ChevronLeft class="h-4 w-4" />
            Старше
          </Button>
          <span class="text-sm">{{ currentPage }} / {{ totalPages }}</span>
          <Button
            variant="outline"
            size="sm"
            :disabled="offset === 0"
            @click="prevPage"
          >
            Новее
            <ChevronRight class="h-4 w-4" />
          </Button>
        </div>
      </div>

      <!-- Message list -->
      <div class="flex-1 overflow-y-auto space-y-3">
        <div
          v-for="msg in reversedMessages"
          :key="msg.id"
          class="flex gap-3"
          :class="msg.isOutgoing ? 'flex-row-reverse' : ''"
        >
          <!-- Avatar -->
          <div class="flex-shrink-0 w-8 h-8">
            <img
              v-if="getSenderAvatar(msg)"
              :src="getSenderAvatar(msg)"
              class="w-8 h-8 rounded-full object-cover"
              alt=""
            />
            <div
              v-else
              class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium"
              :class="msg.isOutgoing ? 'bg-primary/20 text-primary' : 'bg-muted'"
            >
              {{ getSenderName(msg).charAt(0).toUpperCase() }}
            </div>
          </div>

          <!-- Message bubble -->
          <div
            class="max-w-[70%] rounded-lg px-3 py-2"
            :class="msg.isOutgoing ? 'bg-primary text-primary-foreground' : 'bg-muted'"
          >
            <!-- Sender name (for incoming) -->
            <div
              v-if="!msg.isOutgoing"
              class="text-xs font-medium mb-1"
              :class="msg.isOutgoing ? 'text-primary-foreground/70' : 'text-muted-foreground'"
            >
              {{ getSenderName(msg) }}
            </div>

            <!-- Topic badge -->
            <div
              v-if="msg.topicName"
              class="text-xs px-1.5 py-0.5 rounded mb-1 inline-block"
              :class="msg.isOutgoing ? 'bg-primary-foreground/20' : 'bg-background'"
            >
              #{{ msg.topicName }}
            </div>

            <!-- Photo/Sticker -->
            <div v-if="msg.mediaType && isInlineMedia(msg.mediaType) && getMediaUrl(msg)" class="mb-2">
              <img
                v-if="msg.mediaType === 'photo' || msg.mediaType === 'sticker'"
                :src="getMediaUrl(msg)!"
                :alt="getMediaLabel(msg.mediaType)"
                class="max-w-full rounded-lg max-h-80 object-contain cursor-pointer hover:opacity-90 transition-opacity"
                loading="lazy"
                @click="openInNewTab(getMediaUrl(msg))"
              />
              <!-- Video/Animation -->
              <video
                v-else-if="msg.mediaType === 'video' || msg.mediaType === 'video_note' || msg.mediaType === 'animation'"
                :src="getMediaUrl(msg)!"
                :class="msg.mediaType === 'video_note' ? 'rounded-full max-w-48 max-h-48' : 'max-w-full rounded-lg max-h-80'"
                controls
                preload="metadata"
                :loop="msg.mediaType === 'animation'"
                :autoplay="msg.mediaType === 'animation'"
                :muted="msg.mediaType === 'animation'"
              >
                <source :src="getMediaUrl(msg)!" :type="msg.mediaMetadata?.mimeType || 'video/mp4'" />
              </video>
              <!-- Duration badge -->
              <div
                v-if="msg.mediaMetadata?.duration"
                class="text-xs mt-1"
                :class="msg.isOutgoing ? 'text-primary-foreground/60' : 'text-muted-foreground'"
              >
                {{ formatDuration(msg.mediaMetadata.duration) }}
              </div>
            </div>

            <!-- Voice/Audio -->
            <div v-else-if="msg.mediaType && isAudioMedia(msg.mediaType) && getMediaUrl(msg)" class="mb-2">
              <div class="flex items-center gap-2 p-2 rounded bg-background/50">
                <component :is="getMediaIcon(msg.mediaType)" class="h-5 w-5 flex-shrink-0" :class="msg.isOutgoing ? 'text-primary-foreground/80' : 'text-muted-foreground'" />
                <audio
                  :src="getMediaUrl(msg)!"
                  controls
                  preload="metadata"
                  class="h-8 flex-1"
                />
              </div>
              <div
                v-if="msg.mediaMetadata?.duration"
                class="text-xs mt-1"
                :class="msg.isOutgoing ? 'text-primary-foreground/60' : 'text-muted-foreground'"
              >
                {{ formatDuration(msg.mediaMetadata.duration) }}
              </div>
            </div>

            <!-- Document -->
            <div v-else-if="msg.mediaType === 'document' && getMediaUrl(msg)" class="mb-2">
              <a
                :href="getMediaUrl(msg)!"
                target="_blank"
                class="flex items-center gap-2 p-2 rounded bg-background/50 hover:bg-background/70 transition-colors"
              >
                <FileText class="h-5 w-5 flex-shrink-0" :class="msg.isOutgoing ? 'text-primary-foreground/80' : 'text-muted-foreground'" />
                <div class="flex-1 min-w-0">
                  <div class="text-sm truncate" :class="msg.isOutgoing ? 'text-primary-foreground' : ''">
                    {{ msg.mediaMetadata?.fileName || 'Документ' }}
                  </div>
                  <div class="text-xs" :class="msg.isOutgoing ? 'text-primary-foreground/60' : 'text-muted-foreground'">
                    {{ formatFileSize(msg.mediaMetadata?.size) }}
                  </div>
                </div>
              </a>
            </div>

            <!-- Media indicator (no metadata available) -->
            <div
              v-else-if="msg.mediaType && !getMediaUrl(msg)"
              class="flex items-center gap-2 mb-1 p-2 rounded bg-background/50"
              :class="msg.isOutgoing ? 'text-primary-foreground/80' : 'text-muted-foreground'"
            >
              <component :is="getMediaIcon(msg.mediaType)" class="h-5 w-5" />
              <span class="text-sm">{{ getMediaLabel(msg.mediaType) }}</span>
              <span class="text-xs opacity-60">(недоступно)</span>
            </div>

            <!-- Message content -->
            <div v-if="msg.content" class="whitespace-pre-wrap break-words">
              {{ msg.content }}
            </div>

            <!-- Empty content with media (no text) -->
            <div
              v-else-if="msg.mediaType && !msg.content && !getMediaUrl(msg)"
              class="text-sm italic"
              :class="msg.isOutgoing ? 'text-primary-foreground/60' : 'text-muted-foreground'"
            >
              {{ getMediaLabel(msg.mediaType) }}
            </div>

            <!-- Timestamp -->
            <div
              class="text-xs mt-1"
              :class="msg.isOutgoing ? 'text-primary-foreground/60 text-right' : 'text-muted-foreground'"
              :title="formatFullDate(msg.timestamp)"
            >
              {{ formatDate(msg.timestamp) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Pagination bottom -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 mt-4 pt-4 border-t">
        <Button
          variant="outline"
          size="sm"
          :disabled="offset + limit >= data.total"
          @click="nextPage"
        >
          <ChevronLeft class="h-4 w-4" />
          Старые
        </Button>
        <span class="text-sm text-muted-foreground">{{ currentPage }} / {{ totalPages }}</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="offset === 0"
          @click="prevPage"
        >
          Новые
          <ChevronRight class="h-4 w-4" />
        </Button>
      </div>
    </div>
  </div>
</template>
