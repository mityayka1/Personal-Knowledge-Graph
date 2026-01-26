<script setup lang="ts">
import { AlertTriangle, Loader2 } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    title?: string;
    description?: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'destructive';
    loading?: boolean;
  }>(),
  {
    title: 'Подтверждение',
    description: 'Вы уверены, что хотите выполнить это действие?',
    confirmText: 'Подтвердить',
    cancelText: 'Отмена',
    variant: 'default',
    loading: false,
  }
);

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

const open = defineModel<boolean>('open', { default: false });

function handleConfirm() {
  emit('confirm');
}

function handleCancel() {
  open.value = false;
  emit('cancel');
}
</script>

<template>
  <ClientOnly>
    <Dialog v-model:open="open">
      <DialogContent class="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle
              v-if="variant === 'destructive'"
              class="h-5 w-5 text-destructive"
            />
            {{ title }}
          </DialogTitle>
          <DialogDescription>
            {{ description }}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter class="gap-2 sm:gap-0">
          <Button
            variant="outline"
            :disabled="loading"
            @click="handleCancel"
          >
            {{ cancelText }}
          </Button>
          <Button
            :variant="variant === 'destructive' ? 'destructive' : 'default'"
            :disabled="loading"
            @click="handleConfirm"
          >
            <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
            {{ confirmText }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </ClientOnly>
</template>
