<script setup lang="ts">
import { User, Building2, AtSign, Phone, Mail } from 'lucide-vue-next';
import type { MergeSuggestionGroupDto } from '~/composables/useMergeSuggestions';

const props = defineProps<{
  group: MergeSuggestionGroupDto;
  loading?: boolean;
}>();

const emit = defineEmits<{
  merge: [candidateId: string];
  dismiss: [candidateId: string];
}>();

const reasonLabels: Record<string, string> = {
  orphaned_telegram_id: 'Осиротевший Telegram ID',
  shared_identifier: 'Общий идентификатор',
  similar_name: 'Похожее имя',
};

function getIdentifierIcon(type: string) {
  switch (type) {
    case 'telegram_user_id':
    case 'telegram_username':
      return AtSign;
    case 'phone':
      return Phone;
    case 'email':
      return Mail;
    default:
      return null;
  }
}

function formatIdentifier(type: string, value: string): string {
  switch (type) {
    case 'telegram_username':
      return `@${value}`;
    case 'telegram_user_id':
      return `tg:${value}`;
    default:
      return value;
  }
}
</script>

<template>
  <Card>
    <CardContent class="p-4">
      <!-- Primary Entity Header -->
      <div class="flex items-start gap-4">
        <div
          :class="[
            'h-12 w-12 rounded-full flex items-center justify-center flex-shrink-0',
            group.primaryEntity.type === 'person'
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400'
              : 'bg-purple-100 text-purple-600 dark:bg-purple-950 dark:text-purple-400',
          ]"
        >
          <User v-if="group.primaryEntity.type === 'person'" class="h-6 w-6" />
          <Building2 v-else class="h-6 w-6" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="text-lg font-semibold truncate">
              {{ group.primaryEntity.name }}
            </h3>
            <Badge variant="outline" class="text-xs">
              {{ reasonLabels[group.reason] || group.reason }}
            </Badge>
          </div>
          <!-- Identifiers -->
          <div
            v-if="group.primaryEntity.identifiers.length > 0"
            class="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted-foreground"
          >
            <span
              v-for="identifier in group.primaryEntity.identifiers.slice(0, 3)"
              :key="identifier.id"
              class="flex items-center gap-1"
            >
              <component
                :is="getIdentifierIcon(identifier.identifierType)"
                v-if="getIdentifierIcon(identifier.identifierType)"
                class="h-3 w-3"
              />
              {{ formatIdentifier(identifier.identifierType, identifier.identifierValue) }}
            </span>
            <span
              v-if="group.primaryEntity.identifiers.length > 3"
              class="text-xs"
            >
              +{{ group.primaryEntity.identifiers.length - 3 }}
            </span>
          </div>
        </div>
      </div>

      <!-- Candidates Section -->
      <div class="mt-4">
        <p class="text-sm text-muted-foreground mb-2">
          Возможные дубликаты ({{ group.candidates.length }}):
        </p>
        <div class="space-y-2">
          <MergeCandidateItem
            v-for="candidate in group.candidates"
            :key="candidate.id"
            :candidate="candidate"
            :loading="loading"
            @merge="emit('merge', candidate.id)"
            @dismiss="emit('dismiss', candidate.id)"
          />
        </div>
      </div>
    </CardContent>
  </Card>
</template>
