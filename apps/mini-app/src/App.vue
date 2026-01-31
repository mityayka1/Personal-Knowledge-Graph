<script setup lang="ts">
import { onMounted, onUnmounted, provide, ref } from 'vue'
import { useRouter } from 'vue-router'

const router = useRouter()
const isLoading = ref(false)

// Provide loading state to children
provide('isLoading', isLoading)

const webApp = window.Telegram?.WebApp

onMounted(() => {
  if (!webApp) {
    console.warn('Telegram WebApp not available. Running in browser mode.')
    return
  }

  // Setup back button
  webApp.BackButton.onClick(() => {
    if (window.history.length > 1) {
      router.back()
    } else {
      webApp.close()
    }
  })

  // Show/hide back button based on route
  router.afterEach((to) => {
    if (to.path === '/') {
      webApp.BackButton.hide()
    } else {
      webApp.BackButton.show()
    }
  })

  // Apply color scheme
  document.documentElement.style.colorScheme = webApp.colorScheme || 'light'
})

onUnmounted(() => {
  if (webApp) {
    webApp.BackButton.offClick(() => {})
  }
})
</script>

<template>
  <div class="safe-area-container min-h-screen">
    <router-view v-slot="{ Component }">
      <transition name="fade" mode="out-in">
        <component :is="Component" />
      </transition>
    </router-view>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
