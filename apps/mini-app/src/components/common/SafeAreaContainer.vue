<script setup lang="ts">
defineProps<{
  noPadding?: boolean
}>()
</script>

<template>
  <div
    class="min-h-screen"
    :class="{ 'safe-area-container': !noPadding }"
  >
    <slot />
  </div>
</template>
