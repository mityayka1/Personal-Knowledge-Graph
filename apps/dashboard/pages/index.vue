<script setup lang="ts">
import {
  Users,
  MessageSquare,
  HelpCircle,
  CheckCircle,
  UserCircle,
  Building2,
  MessagesSquare,
} from 'lucide-vue-next';
import { useChatCategoryStats, useGroupMembershipStats } from '~/composables/useChatCategories';

definePageMeta({
  title: 'Главная',
});

// Fetch stats
const { data: entities } = useEntities(ref({ limit: 1 }));
const { data: interactions } = useInteractions(ref({ limit: 1 }));
const { data: categoryStats } = useChatCategoryStats();
const { data: membershipStats } = useGroupMembershipStats();

// TODO: Add resolutions and facts stats when API is ready
</script>

<template>
  <div>
    <h1 class="text-3xl font-bold tracking-tight mb-6">Главная</h1>

    <!-- Main Stats -->
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Сущности</CardTitle>
          <Users class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ entities?.total ?? '-' }}</div>
          <p class="text-xs text-muted-foreground">Люди и организации</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Взаимодействия</CardTitle>
          <MessageSquare class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ interactions?.total ?? '-' }}</div>
          <p class="text-xs text-muted-foreground">Сессии чатов</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">На связывание</CardTitle>
          <HelpCircle class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">-</div>
          <p class="text-xs text-muted-foreground">Ожидают связывания</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Факты на проверку</CardTitle>
          <CheckCircle class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">-</div>
          <p class="text-xs text-muted-foreground">Ожидают проверки</p>
        </CardContent>
      </Card>
    </div>

    <!-- Chat Categories -->
    <h2 class="text-xl font-semibold mb-4">Категории чатов</h2>
    <div class="grid gap-4 md:grid-cols-3 mb-8">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Личные</CardTitle>
          <UserCircle class="h-4 w-4 text-green-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ categoryStats?.personal ?? 0 }}</div>
          <p class="text-xs text-muted-foreground">Приватные чаты</p>
          <Badge variant="outline" class="mt-2 text-green-600">Auto-extraction</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Рабочие</CardTitle>
          <Building2 class="h-4 w-4 text-blue-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ categoryStats?.working ?? 0 }}</div>
          <p class="text-xs text-muted-foreground">Группы ≤20 человек</p>
          <Badge variant="outline" class="mt-2 text-blue-600">Auto-extraction</Badge>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Массовые</CardTitle>
          <MessagesSquare class="h-4 w-4 text-gray-500" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ categoryStats?.mass ?? 0 }}</div>
          <p class="text-xs text-muted-foreground">Группы &gt;20 человек</p>
          <Badge variant="outline" class="mt-2 text-gray-500">Manual import</Badge>
        </CardContent>
      </Card>
    </div>

    <!-- Group Memberships -->
    <h2 class="text-xl font-semibold mb-4">Членство в группах</h2>
    <div class="grid gap-4 md:grid-cols-4">
      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Всего записей</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ membershipStats?.totalMemberships ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Активных</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold text-green-600">{{ membershipStats?.activeMemberships ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Уникальных чатов</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ membershipStats?.uniqueChats ?? 0 }}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="pb-2">
          <CardTitle class="text-sm font-medium">Уникальных юзеров</CardTitle>
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">{{ membershipStats?.uniqueUsers ?? 0 }}</div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
