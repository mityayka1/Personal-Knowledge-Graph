import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '@/api/client'
import { useTelegram } from '@/composables/useTelegram'

interface User {
  id: number
  firstName: string
  lastName?: string
  username?: string
}

export const useUserStore = defineStore('user', () => {
  const { user: telegramUser } = useTelegram()

  const user = ref<User | null>(null)
  const isOwner = ref(false)
  const isLoading = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => !!user.value || !!telegramUser.value)

  const displayName = computed(() => {
    const u = user.value
    if (!u) return telegramUser.value?.first_name || 'Пользователь'
    return [u.firstName, u.lastName].filter(Boolean).join(' ')
  })

  async function fetchMe() {
    if (isLoading.value) return

    isLoading.value = true
    error.value = null

    try {
      const data = await api.getMe()
      user.value = data.user
      isOwner.value = data.isOwner
    } catch (e) {
      error.value = 'Не удалось загрузить профиль'
      console.error('Failed to fetch user:', e)
    } finally {
      isLoading.value = false
    }
  }

  return {
    user,
    isOwner,
    isLoading,
    error,
    isAuthenticated,
    displayName,
    fetchMe,
  }
})
