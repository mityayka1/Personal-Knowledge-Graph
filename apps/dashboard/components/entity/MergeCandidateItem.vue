<script setup lang="ts">
import { GitMerge, X, MessageSquare, Calendar } from 'lucide-vue-next';
import type { MergeCandidateDto } from '~/composables/useMergeSuggestions';
import { formatDate } from '~/lib/utils';

const props = defineProps<{
  candidate: MergeCandidateDto;
  loading?: boolean;
}>();

const emit = defineEmits<{
  merge: [];
  dismiss: [];
}>();
</script>

<template>
  <div class="flex items-center justify-between p-3 rounded-lg border bg-muted/30 hover:bg-muted/50 transition-colors">
    <div class="flex-1 min-w-0">
      <div class="font-medium text-sm truncate">
        {{ candidate.name }}
      </div>
      <div class="flex items-center gap-3 text-xs text-muted-foreground mt-1">
        <span class="flex items-center gap-1">
          <MessageSquare class="h-3 w-3" />
          {{ candidate.messageCount }} сообщений
        </span>
        <span class="flex items-center gap-1">
          <Calendar class="h-3 w-3" />
          {{ formatDate(candidate.createdAt) }}
        </span>
      </div>
    </div>
    <div class="flex items-center gap-2 ml-4">
      <Button
        size="sm"
        :disabled="loading"
        @click="emit('merge')"
      >
        <GitMerge class="h-4 w-4 mr-1" />
        Слить
      </Button>
      <Button
        variant="ghost"
        size="sm"
        :disabled="loading"
        @click="emit('dismiss')"
      >
        <X class="h-4 w-4 mr-1" />
        Не дубликат
      </Button>
    </div>
  </div>
</template>
