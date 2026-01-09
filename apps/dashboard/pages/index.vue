<script setup lang="ts">
import { Users, MessageSquare, HelpCircle, CheckCircle } from 'lucide-vue-next';

definePageMeta({
  title: 'Главная',
});

// Redirect to entities for now (Dashboard home is deferred)
const router = useRouter();
onMounted(() => {
  router.replace('/entities');
});
</script>

<template>
  <div>
    <h1 class="text-3xl font-bold tracking-tight mb-6">Главная</h1>

    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Сущности</CardTitle>
          <Users class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">-</div>
          <p class="text-xs text-muted-foreground">Люди и организации</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader class="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle class="text-sm font-medium">Взаимодействия</CardTitle>
          <MessageSquare class="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div class="text-2xl font-bold">-</div>
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

    <p class="text-muted-foreground mt-8 text-center">
      Переход к сущностям...
    </p>
  </div>
</template>
