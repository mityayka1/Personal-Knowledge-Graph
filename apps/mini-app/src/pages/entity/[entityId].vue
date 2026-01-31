<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api/client'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ErrorState from '@/components/common/ErrorState.vue'

const route = useRoute()

const entityId = computed(() => route.params.entityId as string)

interface EntityData {
  id: string
  type: 'person' | 'organization'
  name: string
  avatarUrl?: string
  facts: Array<{
    type: string
    value: string
    updatedAt: string
  }>
  recentInteractions: Array<{
    id: string
    type: string
    summary?: string
    timestamp: string
  }>
  identifiers: Array<{
    type: string
    value: string
  }>
}

const data = ref<EntityData | null>(null)
const isLoading = ref(true)
const error = ref<string | null>(null)

async function loadEntity() {
  isLoading.value = true
  error.value = null

  try {
    data.value = await api.getEntity(entityId.value)
  } catch (e) {
    error.value = 'Не удалось загрузить профиль'
    console.error('Failed to load entity:', e)
  } finally {
    isLoading.value = false
  }
}

function getFactIcon(type: string): string {
  const icons: Record<string, string> = {
    birthday: '🎂',
    position: '💼',
    company: '🏢',
    phone: '📞',
    email: '📧',
    location: '📍',
    hobby: '🎯',
    relationship: '👥',
  }
  return icons[type] || '📌'
}

function getFactLabel(type: string): string {
  const labels: Record<string, string> = {
    birthday: 'День рождения',
    position: 'Должность',
    company: 'Компания',
    phone: 'Телефон',
    email: 'Email',
    location: 'Город',
    hobby: 'Интересы',
    relationship: 'Связь',
  }
  return labels[type] || type
}

function getInteractionIcon(type: string): string {
  const icons: Record<string, string> = {
    chat: '💬',
    call: '📞',
    meeting: '🗓️',
  }
  return icons[type] || '📌'
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return 'Сегодня'
  if (diffDays === 1) return 'Вчера'
  if (diffDays < 7) return `${diffDays} дн. назад`

  return date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  })
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

onMounted(loadEntity)
</script>

<template>
  <div class="min-h-screen">
    <!-- Loading -->
    <div v-if="isLoading" class="flex items-center justify-center py-12">
      <LoadingSpinner size="lg" />
    </div>

    <!-- Error -->
    <ErrorState
      v-else-if="error"
      :message="error"
      :retryable="true"
      @retry="loadEntity"
    />

    <!-- Content -->
    <template v-else-if="data">
      <!-- Header -->
      <div class="p-6 text-center border-b border-tg-secondary-bg">
        <!-- Avatar -->
        <div class="w-20 h-20 mx-auto mb-3 rounded-full bg-tg-button flex items-center justify-center">
          <img
            v-if="data.avatarUrl"
            :src="data.avatarUrl"
            :alt="data.name"
            class="w-full h-full rounded-full object-cover"
          />
          <span v-else class="text-2xl font-bold text-tg-button-text">
            {{ getInitials(data.name) }}
          </span>
        </div>

        <!-- Name -->
        <h1 class="text-2xl font-bold text-tg-text">{{ data.name }}</h1>

        <!-- Type Badge -->
        <span class="text-sm text-tg-hint">
          {{ data.type === 'person' ? 'Человек' : 'Организация' }}
        </span>
      </div>

      <!-- Facts -->
      <div v-if="data.facts.length > 0" class="p-4">
        <h2 class="section-header">Информация</h2>
        <div class="bg-tg-section-bg rounded-xl overflow-hidden">
          <div
            v-for="fact in data.facts"
            :key="fact.type"
            class="list-item"
          >
            <span class="text-xl mr-3">{{ getFactIcon(fact.type) }}</span>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-tg-hint">{{ getFactLabel(fact.type) }}</div>
              <div class="font-medium text-tg-text">{{ fact.value }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Identifiers -->
      <div v-if="data.identifiers.length > 0" class="p-4 pt-0">
        <h2 class="section-header">Контакты</h2>
        <div class="bg-tg-section-bg rounded-xl overflow-hidden">
          <div
            v-for="identifier in data.identifiers"
            :key="`${identifier.type}-${identifier.value}`"
            class="list-item"
          >
            <span class="text-xl mr-3">
              {{ identifier.type === 'telegram' ? '✈️' : identifier.type === 'phone' ? '📞' : '📧' }}
            </span>
            <div class="flex-1 min-w-0">
              <div class="text-sm text-tg-hint capitalize">{{ identifier.type }}</div>
              <div class="font-medium text-tg-text">{{ identifier.value }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Recent Interactions -->
      <div v-if="data.recentInteractions.length > 0" class="p-4 pt-0">
        <h2 class="section-header">Недавние взаимодействия</h2>
        <div class="bg-tg-section-bg rounded-xl overflow-hidden">
          <div
            v-for="interaction in data.recentInteractions"
            :key="interaction.id"
            class="list-item"
          >
            <span class="text-xl mr-3">{{ getInteractionIcon(interaction.type) }}</span>
            <div class="flex-1 min-w-0">
              <div class="font-medium text-tg-text truncate">
                {{ interaction.summary || 'Без темы' }}
              </div>
              <div class="text-sm text-tg-hint">
                {{ formatTimestamp(interaction.timestamp) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
