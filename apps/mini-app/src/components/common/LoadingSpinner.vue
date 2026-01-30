<script setup lang="ts">
defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>()
</script>

<template>
  <div
    class="spinner"
    :class="{
      'w-4 h-4 border': size === 'sm',
      'w-6 h-6 border-2': size === 'md' || !size,
      'w-10 h-10 border-2': size === 'lg',
    }"
  />
</template>
