<script setup lang="ts">
import {
  Users,
  MessageSquare,
  Search,
  Sparkles,
  HelpCircle,
  CheckCircle,
  Menu,
  Download,
} from 'lucide-vue-next';

const route = useRoute();

const navigation = [
  { name: 'Сущности', href: '/entities', icon: Users },
  { name: 'Взаимодействия', href: '/interactions', icon: MessageSquare },
  { name: 'Поиск', href: '/search', icon: Search },
  { name: 'Контекст', href: '/context', icon: Sparkles },
  { name: 'Связывание', href: '/resolutions', icon: HelpCircle },
  { name: 'Факты на проверку', href: '/facts', icon: CheckCircle },
  { name: 'Импорт Telegram', href: '/import', icon: Download },
];

const sidebarOpen = ref(false);

function isActive(href: string) {
  return route.path.startsWith(href);
}
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Mobile sidebar toggle -->
    <div class="lg:hidden fixed top-0 left-0 right-0 z-40 flex items-center justify-between bg-background border-b px-4 py-3">
      <div class="flex items-center gap-4">
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground"
          @click="sidebarOpen = !sidebarOpen"
        >
          <Menu class="h-6 w-6" />
        </button>
        <span class="font-semibold">PKG Dashboard</span>
      </div>
      <ThemeToggle />
    </div>

    <!-- Sidebar -->
    <aside
      :class="[
        'fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-in-out lg:translate-x-0',
        sidebarOpen ? 'translate-x-0' : '-translate-x-full',
      ]"
    >
      <div class="flex h-16 items-center justify-between px-6 border-b">
        <div class="flex items-center gap-2">
          <Sparkles class="h-6 w-6 text-primary" />
          <span class="font-semibold text-lg">PKG Dashboard</span>
        </div>
        <ThemeToggle />
      </div>

      <nav class="flex flex-col gap-1 p-4">
        <NuxtLink
          v-for="item in navigation"
          :key="item.name"
          :to="item.href"
          :class="[
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
            isActive(item.href)
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          ]"
          @click="sidebarOpen = false"
        >
          <component :is="item.icon" class="h-5 w-5" />
          {{ item.name }}
        </NuxtLink>
      </nav>
    </aside>

    <!-- Backdrop for mobile -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-40 bg-black/50 lg:hidden"
      @click="sidebarOpen = false"
    />

    <!-- Main content -->
    <main class="lg:pl-64">
      <div class="pt-16 lg:pt-0">
        <div class="px-4 py-6 sm:px-6 lg:px-8">
          <slot />
        </div>
      </div>
    </main>
  </div>
</template>
