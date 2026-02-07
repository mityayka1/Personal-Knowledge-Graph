<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  message?: string
  retryable?: boolean
}>()

const emit = defineEmits<{
  retry: []
}>()

const showDebug = ref(false)
let tapCount = 0
let tapTimer: ReturnType<typeof setTimeout> | null = null

function handleTitleTap() {
  tapCount++
  if (tapTimer) clearTimeout(tapTimer)
  tapTimer = setTimeout(() => { tapCount = 0 }, 800)
  if (tapCount >= 5) {
    showDebug.value = !showDebug.value
    tapCount = 0
  }
}

function getDebugInfo(): string {
  const webApp = window.Telegram?.WebApp
  const lines: string[] = []
  lines.push(`Telegram SDK: ${window.Telegram ? 'loaded' : 'NOT loaded'}`)
  lines.push(`WebApp: ${webApp ? 'available' : 'NOT available'}`)
  if (webApp) {
    lines.push(`initData: ${webApp.initData ? `"${webApp.initData.substring(0, 50)}..."` : 'EMPTY'}`)
    lines.push(`initData length: ${webApp.initData?.length || 0}`)
    lines.push(`platform: ${webApp.platform || 'unknown'}`)
    lines.push(`version: ${webApp.version || 'unknown'}`)
    lines.push(`colorScheme: ${webApp.colorScheme || 'unknown'}`)
    const unsafe = webApp.initDataUnsafe
    if (unsafe) {
      lines.push(`user: ${unsafe.user ? `${unsafe.user.id} (${unsafe.user.first_name})` : 'none'}`)
      lines.push(`start_param: ${unsafe.start_param || 'none'}`)
      lines.push(`auth_date: ${unsafe.auth_date || 'none'}`)
      lines.push(`hash: ${unsafe.hash ? `${unsafe.hash.substring(0, 8)}...` : 'none'}`)
    } else {
      lines.push('initDataUnsafe: EMPTY')
    }
  }
  lines.push(`location.hash: ${window.location.hash ? `"${window.location.hash.substring(0, 80)}..."` : 'EMPTY'}`)
  lines.push(`location.href: ${window.location.href}`)
  lines.push(`UA: ${navigator.userAgent.substring(0, 80)}`)
  return lines.join('\n')
}
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 px-6 text-center">
    <div class="text-4xl mb-4">😕</div>
    <h3 class="text-lg font-medium text-tg-text mb-2" @click="handleTitleTap">Что-то пошло не так</h3>
    <p class="text-sm text-tg-hint mb-4">{{ message || 'Произошла ошибка при загрузке данных' }}</p>
    <button
      v-if="retryable"
      class="btn btn-secondary"
      @click="emit('retry')"
    >
      Попробовать снова
    </button>
    <!-- Debug info (hidden by default, 5 taps on title to show) -->
    <pre
      v-if="showDebug"
      class="mt-4 p-3 bg-tg-secondary-bg rounded-lg text-left text-xs text-tg-hint overflow-auto max-w-full whitespace-pre-wrap"
    >{{ getDebugInfo() }}</pre>
  </div>
</template>
