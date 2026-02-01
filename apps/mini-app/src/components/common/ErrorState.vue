<script setup lang="ts">
defineProps<{
  message?: string
  retryable?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 px-6 text-center">
    <div class="text-4xl mb-4">😕</div>
    <h3 class="text-lg font-medium text-tg-text mb-2">Что-то пошло не так</h3>
    <p class="text-sm text-tg-hint mb-4">{{ message || 'Произошла ошибка при загрузке данных' }}</p>
    <button
      v-if="retryable"
      class="btn btn-secondary"
      @click="emit('retry')"
    >
      Попробовать снова
    </button>
  </div>
</template>
