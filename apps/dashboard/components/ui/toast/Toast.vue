<script setup lang="ts">
import { X } from 'lucide-vue-next';
import type { Toast } from '~/composables/useToast';

const props = defineProps<{
  toast: Toast;
}>();

const emit = defineEmits<{
  dismiss: [id: string];
}>();
</script>

<template>
  <div
    :class="[
      'pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-4 shadow-lg transition-all',
      toast.variant === 'destructive'
        ? 'border-destructive bg-destructive text-destructive-foreground'
        : 'border bg-background text-foreground',
    ]"
  >
    <div class="flex-1">
      <div class="text-sm font-semibold">{{ toast.title }}</div>
      <div v-if="toast.description" class="text-sm opacity-90 mt-1">
        {{ toast.description }}
      </div>
    </div>
    <button
      class="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted/50"
      @click="emit('dismiss', toast.id)"
    >
      <X class="h-4 w-4" />
    </button>
  </div>
</template>
