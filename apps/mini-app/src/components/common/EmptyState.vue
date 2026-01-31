<script setup lang="ts">
defineProps<{
  icon?: string
  title: string
  description?: string
}>()
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 px-6 text-center">
    <div v-if="icon" class="text-4xl mb-4">{{ icon }}</div>
    <h3 class="text-lg font-medium text-tg-text mb-2">{{ title }}</h3>
    <p v-if="description" class="text-sm text-tg-hint">{{ description }}</p>
    <slot />
  </div>
</template>
