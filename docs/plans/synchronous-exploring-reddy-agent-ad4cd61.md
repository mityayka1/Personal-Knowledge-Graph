# Vue 3 + Vite Framework Research for Mobile-Focused Web App

**Date:** 2026-01-31
**Purpose:** Documentation research for PKG Dashboard mobile web app
**Target:** Small mobile-focused SPA, API-driven state, real-time updates, TypeScript strict mode

---

## Table of Contents

1. [Library Versions (2026)](#1-library-versions-2026)
2. [Vue 3 Composition API Best Practices](#2-vue-3-composition-api-best-practices)
3. [Pinia State Management Patterns](#3-pinia-state-management-patterns)
4. [Vue Router for SPA Navigation](#4-vue-router-for-spa-navigation)
5. [TypeScript Integration](#5-typescript-integration)
6. [Vite Configuration for Production](#6-vite-configuration-for-production)
7. [Component Organization Patterns](#7-component-organization-patterns)
8. [Recommended Project Structure](#8-recommended-project-structure)
9. [Configuration Examples](#9-configuration-examples)
10. [References](#10-references)

---

## 1. Library Versions (2026)

### Recommended Versions

| Package | Version | Notes |
|---------|---------|-------|
| **vue** | `^3.5.x` (stable) / `3.6.x` (beta) | 3.5 is stable; 3.6 beta has Vapor Mode |
| **vite** | `^7.3.x` | Latest stable, Rust-powered Rolldown coming in v8 |
| **pinia** | `^3.0.x` | Dropped Vue 2 support, ESM-first |
| **vue-router** | `^4.5.x` | Stable, typed routes |
| **unplugin-vue-router** | `^0.10.x` | File-based typed routing |
| **typescript** | `^5.5+` | Required for Pinia 3.0 |
| **@vitejs/plugin-vue** | `^5.x` | Vue plugin for Vite 7 |

### Node.js Requirements

- **Vite 7:** Requires Node.js **20.19+** or **22.12+**
- Node.js 18 is EOL (April 2025)

### package.json Dependencies

```json
{
  "dependencies": {
    "vue": "^3.5.13",
    "vue-router": "^4.5.0",
    "pinia": "^3.0.4"
  },
  "devDependencies": {
    "vite": "^7.3.1",
    "@vitejs/plugin-vue": "^5.2.0",
    "typescript": "^5.5.0",
    "unplugin-vue-router": "^0.10.9",
    "vue-tsc": "^2.0.0"
  }
}
```

---

## 2. Vue 3 Composition API Best Practices

### Script Setup with TypeScript

Always use `<script setup lang="ts">` for:
- Better type inference
- Cleaner syntax
- Compile-time optimizations

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'

// Reactive state
const count = ref(0)

// Computed properties
const doubled = computed(() => count.value * 2)

// Methods
function increment() {
  count.value++
}
</script>

<template>
  <button @click="increment">{{ count }} ({{ doubled }})</button>
</template>
```

### Props with TypeScript Interfaces

```vue
<script setup lang="ts">
interface Props {
  title: string
  items: Item[]
  loading?: boolean
  onSelect?: (item: Item) => void
}

interface Item {
  id: string
  name: string
}

// With defaults
const props = withDefaults(defineProps<Props>(), {
  loading: false,
})
</script>
```

### Emits with Type Safety (Vue 3.3+ syntax)

```vue
<script setup lang="ts">
// Modern succinct syntax (Vue 3.3+)
const emit = defineEmits<{
  select: [item: Item]
  update: [value: string]
  close: []
}>()

// Usage
emit('select', selectedItem)
</script>
```

### Composables Pattern

Extract reusable logic into composables:

```typescript
// src/composables/useApi.ts
import { ref, shallowRef } from 'vue'

export function useApi<T>(fetcher: () => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const error = ref<Error | null>(null)
  const loading = ref(false)

  async function execute() {
    loading.value = true
    error.value = null
    try {
      data.value = await fetcher()
    } catch (e) {
      error.value = e as Error
    } finally {
      loading.value = false
    }
  }

  return { data, error, loading, execute }
}
```

Usage in component:

```vue
<script setup lang="ts">
import { useApi } from '@/composables/useApi'
import { api } from '@/services/api'

const { data: users, loading, execute: fetchUsers } = useApi(
  () => api.get('/users')
)

onMounted(fetchUsers)
</script>
```

---

## 3. Pinia State Management Patterns

### Setup Store Syntax (Recommended for TypeScript)

For API-driven state with no local storage:

```typescript
// src/stores/entities.ts
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { Entity } from '@/types'
import { api } from '@/services/api'

export const useEntitiesStore = defineStore('entities', () => {
  // State
  const entities = ref<Entity[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const currentEntityId = ref<string | null>(null)

  // Getters
  const currentEntity = computed(() =>
    entities.value.find(e => e.id === currentEntityId.value)
  )

  const sortedEntities = computed(() =>
    [...entities.value].sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
  )

  // Actions
  async function fetchEntities() {
    loading.value = true
    error.value = null
    try {
      entities.value = await api.get<Entity[]>('/entities')
    } catch (e) {
      error.value = (e as Error).message
    } finally {
      loading.value = false
    }
  }

  async function fetchEntity(id: string) {
    const existing = entities.value.find(e => e.id === id)
    if (existing) {
      currentEntityId.value = id
      return existing
    }

    loading.value = true
    try {
      const entity = await api.get<Entity>(`/entities/${id}`)
      entities.value.push(entity)
      currentEntityId.value = id
      return entity
    } finally {
      loading.value = false
    }
  }

  function setCurrentEntity(id: string | null) {
    currentEntityId.value = id
  }

  // Real-time update handler
  function handleEntityUpdate(entity: Entity) {
    const index = entities.value.findIndex(e => e.id === entity.id)
    if (index >= 0) {
      entities.value[index] = entity
    } else {
      entities.value.push(entity)
    }
  }

  return {
    // State
    entities,
    loading,
    error,
    currentEntityId,
    // Getters
    currentEntity,
    sortedEntities,
    // Actions
    fetchEntities,
    fetchEntity,
    setCurrentEntity,
    handleEntityUpdate,
  }
})
```

### Action Subscriptions for Real-Time Updates

```typescript
// src/plugins/realtime.ts
import { useEntitiesStore } from '@/stores/entities'

export function setupRealtimeSync() {
  const entitiesStore = useEntitiesStore()

  // Subscribe to action calls for logging/analytics
  entitiesStore.$onAction(({ name, args, after, onError }) => {
    const startTime = Date.now()

    after((result) => {
      console.log(`[Pinia] ${name} completed in ${Date.now() - startTime}ms`)
    })

    onError((error) => {
      console.error(`[Pinia] ${name} failed:`, error)
    })
  })

  // WebSocket or SSE integration
  const eventSource = new EventSource('/api/events')

  eventSource.addEventListener('entity:update', (event) => {
    const entity = JSON.parse(event.data)
    entitiesStore.handleEntityUpdate(entity)
  })

  return () => eventSource.close()
}
```

### Store Composition (Store using another Store)

```typescript
// src/stores/context.ts
import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useEntitiesStore } from './entities'
import { useInteractionsStore } from './interactions'

export const useContextStore = defineStore('context', () => {
  const entitiesStore = useEntitiesStore()
  const interactionsStore = useInteractionsStore()

  const currentContext = computed(() => {
    const entity = entitiesStore.currentEntity
    if (!entity) return null

    return {
      entity,
      recentInteractions: interactionsStore.getByEntityId(entity.id),
    }
  })

  return { currentContext }
})
```

---

## 4. Vue Router for SPA Navigation

### File-Based Routing with unplugin-vue-router

For type-safe, automatic route generation:

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueRouter from 'unplugin-vue-router/vite'

export default defineConfig({
  plugins: [
    VueRouter({
      routesFolder: 'src/pages',
      dts: './typed-router.d.ts',
    }),
    vue(),
  ],
})
```

### Router Setup with Guards

```typescript
// src/router/index.ts
import { createRouter, createWebHistory } from 'vue-router'
import { routes } from 'vue-router/auto-routes'

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

// Global navigation guard
router.beforeEach(async (to, from) => {
  // Authentication check
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth)

  if (requiresAuth && !isAuthenticated()) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
})

// Update document title
router.afterEach((to) => {
  document.title = to.meta.title
    ? `${to.meta.title} | PKG`
    : 'PKG Dashboard'
})

export default router
```

### Typed Route Navigation

```vue
<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'

const router = useRouter()
const route = useRoute('/entities/[id]') // Typed!

// Type-safe params
const entityId = route.params.id // string, not string | string[]

// Type-safe navigation
function goToEntity(id: string) {
  router.push({ name: '/entities/[id]', params: { id } })
}
</script>
```

### Lazy Loading Routes

```typescript
// src/pages/entities/[id].vue is auto-loaded
// Or manual lazy loading:
const routes = [
  {
    path: '/admin',
    component: () => import('@/layouts/AdminLayout.vue'),
    children: [
      {
        path: 'users',
        component: () => import('@/pages/admin/users.vue'),
        meta: { requiresAuth: true, roles: ['admin'] },
      },
    ],
  },
]
```

### Route Meta Types

```typescript
// src/router/types.ts
import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    requiresAuth?: boolean
    roles?: string[]
    transition?: string
  }
}
```

---

## 5. TypeScript Integration

### tsconfig.json for Vue 3 + Vite

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "Bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "preserve",

    /* Strict mode */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,

    /* Aliases */
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    },

    /* Vite types */
    "types": ["vite/client", "unplugin-vue-router/client"]
  },
  "include": [
    "src/**/*.ts",
    "src/**/*.tsx",
    "src/**/*.vue",
    "./typed-router.d.ts"
  ],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

### Environment Variables Types

```typescript
// src/env.d.ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_WS_URL: string
  readonly VITE_APP_TITLE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

### Component Type Utilities

```typescript
// src/types/vue.ts
import type { ComponentPublicInstance } from 'vue'

// Extract props type from component
type ComponentProps<T> = T extends new () => { $props: infer P } ? P : never

// Extract emit type from component
type ComponentEmits<T> = T extends new () => { $emit: infer E } ? E : never
```

---

## 6. Vite Configuration for Production

### vite.config.ts (Complete Example)

```typescript
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import VueRouter from 'unplugin-vue-router/vite'
import path from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      VueRouter({
        routesFolder: 'src/pages',
        dts: './typed-router.d.ts',
      }),
      vue(),
    ],

    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },

    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_API_URL || 'http://localhost:3000',
          changeOrigin: true,
        },
      },
    },

    build: {
      // Vite 7 default: 'baseline-widely-available'
      // Targets: chrome111, edge111, firefox114, safari16.4
      target: 'baseline-widely-available',

      outDir: 'dist',
      sourcemap: mode !== 'production',

      // Chunk optimization
      rollupOptions: {
        output: {
          manualChunks: {
            'vue-vendor': ['vue', 'vue-router', 'pinia'],
          },
        },
      },

      // Mobile-optimized
      chunkSizeWarningLimit: 500,
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: mode === 'production',
          drop_debugger: true,
        },
      },
    },

    // Optimize deps
    optimizeDeps: {
      include: ['vue', 'vue-router', 'pinia'],
    },
  }
})
```

### Environment Files

```ini
# .env
VITE_APP_TITLE=PKG Dashboard

# .env.development
VITE_API_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000

# .env.production
VITE_API_URL=https://api.pkg.example.com
VITE_WS_URL=wss://api.pkg.example.com
```

---

## 7. Component Organization Patterns

### Atomic Design Structure

```
src/
├── components/
│   ├── atoms/           # Basic building blocks
│   │   ├── AppButton.vue
│   │   ├── AppInput.vue
│   │   ├── AppIcon.vue
│   │   └── AppSpinner.vue
│   │
│   ├── molecules/       # Combinations of atoms
│   │   ├── SearchBar.vue
│   │   ├── EntityCard.vue
│   │   └── MessageItem.vue
│   │
│   ├── organisms/       # Complex UI sections
│   │   ├── EntityList.vue
│   │   ├── MessageThread.vue
│   │   └── NavigationBar.vue
│   │
│   └── templates/       # Page layouts
│       ├── DefaultLayout.vue
│       └── AuthLayout.vue
```

### Feature-Based Structure (Recommended for larger apps)

```
src/
├── features/
│   ├── entities/
│   │   ├── components/
│   │   │   ├── EntityCard.vue
│   │   │   ├── EntityList.vue
│   │   │   └── EntityDetails.vue
│   │   ├── composables/
│   │   │   └── useEntitySearch.ts
│   │   ├── stores/
│   │   │   └── entities.ts
│   │   ├── types/
│   │   │   └── index.ts
│   │   └── index.ts      # Public exports
│   │
│   ├── messages/
│   │   ├── components/
│   │   ├── composables/
│   │   └── stores/
│   │
│   └── auth/
│       ├── components/
│       ├── composables/
│       └── stores/
```

### Component Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Base/Atoms | `App` prefix | `AppButton.vue` |
| Single instance | `The` prefix | `TheNavbar.vue` |
| Coupled child | Parent prefix | `TodoList.vue`, `TodoListItem.vue` |
| Feature-specific | Feature prefix | `EntityCard.vue`, `EntityList.vue` |

---

## 8. Recommended Project Structure

### Complete Structure for Mobile-Focused SPA

```
pkg-dashboard/
├── public/
│   ├── favicon.ico
│   └── manifest.json        # PWA manifest
│
├── src/
│   ├── assets/
│   │   ├── styles/
│   │   │   ├── main.css
│   │   │   └── variables.css
│   │   └── images/
│   │
│   ├── components/
│   │   ├── common/          # Shared components
│   │   │   ├── AppButton.vue
│   │   │   ├── AppInput.vue
│   │   │   ├── AppModal.vue
│   │   │   └── AppLoading.vue
│   │   └── layout/
│   │       ├── TheHeader.vue
│   │       ├── TheNavbar.vue
│   │       └── TheSidebar.vue
│   │
│   ├── composables/         # Shared composables
│   │   ├── useApi.ts
│   │   ├── useDebounce.ts
│   │   ├── useLocalStorage.ts  # If needed later
│   │   └── useWebSocket.ts
│   │
│   ├── pages/               # File-based routing
│   │   ├── index.vue        # /
│   │   ├── login.vue        # /login
│   │   ├── entities/
│   │   │   ├── index.vue    # /entities
│   │   │   └── [id].vue     # /entities/:id
│   │   └── messages/
│   │       └── index.vue    # /messages
│   │
│   ├── layouts/
│   │   ├── default.vue
│   │   └── auth.vue
│   │
│   ├── stores/
│   │   ├── index.ts         # Pinia setup
│   │   ├── entities.ts
│   │   ├── messages.ts
│   │   └── ui.ts            # UI state (modals, toasts)
│   │
│   ├── services/
│   │   ├── api.ts           # API client
│   │   └── websocket.ts     # Real-time connection
│   │
│   ├── types/
│   │   ├── index.ts
│   │   ├── entity.ts
│   │   └── message.ts
│   │
│   ├── utils/
│   │   ├── date.ts
│   │   └── format.ts
│   │
│   ├── App.vue
│   ├── main.ts
│   └── env.d.ts
│
├── typed-router.d.ts        # Generated by unplugin-vue-router
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── package.json
└── .env.development
```

---

## 9. Configuration Examples

### main.ts (App Entry Point)

```typescript
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'

import './assets/styles/main.css'

const app = createApp(App)

// Pinia (state management)
const pinia = createPinia()
app.use(pinia)

// Router
app.use(router)

// Global error handler
app.config.errorHandler = (err, instance, info) => {
  console.error('Global error:', err, info)
  // Send to error tracking service
}

app.mount('#app')
```

### API Service with TypeScript

```typescript
// src/services/api.ts
const BASE_URL = import.meta.env.VITE_API_URL

interface ApiOptions {
  headers?: Record<string, string>
}

class ApiClient {
  private baseUrl: string
  private defaultHeaders: Record<string, string>

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
    this.defaultHeaders = {
      'Content-Type': 'application/json',
    }
  }

  setAuthToken(token: string | null) {
    if (token) {
      this.defaultHeaders['Authorization'] = `Bearer ${token}`
    } else {
      delete this.defaultHeaders['Authorization']
    }
  }

  async request<T>(
    method: string,
    endpoint: string,
    data?: unknown,
    options?: ApiOptions
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`

    const response = await fetch(url, {
      method,
      headers: { ...this.defaultHeaders, ...options?.headers },
      body: data ? JSON.stringify(data) : undefined,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      throw new Error(error.message || `HTTP ${response.status}`)
    }

    return response.json()
  }

  get<T>(endpoint: string, options?: ApiOptions) {
    return this.request<T>('GET', endpoint, undefined, options)
  }

  post<T>(endpoint: string, data: unknown, options?: ApiOptions) {
    return this.request<T>('POST', endpoint, data, options)
  }

  put<T>(endpoint: string, data: unknown, options?: ApiOptions) {
    return this.request<T>('PUT', endpoint, data, options)
  }

  delete<T>(endpoint: string, options?: ApiOptions) {
    return this.request<T>('DELETE', endpoint, undefined, options)
  }
}

export const api = new ApiClient(BASE_URL)
```

### WebSocket Service for Real-Time Updates

```typescript
// src/services/websocket.ts
import { ref, shallowRef } from 'vue'

type MessageHandler = (data: unknown) => void

class WebSocketService {
  private ws: WebSocket | null = null
  private handlers = new Map<string, Set<MessageHandler>>()
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5

  public connected = ref(false)
  public error = shallowRef<Error | null>(null)

  connect(url: string) {
    if (this.ws?.readyState === WebSocket.OPEN) return

    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.connected.value = true
      this.error.value = null
      this.reconnectAttempts = 0
    }

    this.ws.onclose = () => {
      this.connected.value = false
      this.scheduleReconnect(url)
    }

    this.ws.onerror = (event) => {
      this.error.value = new Error('WebSocket error')
    }

    this.ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data)
        this.handlers.get(type)?.forEach(handler => handler(data))
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e)
      }
    }
  }

  private scheduleReconnect(url: string) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++

    setTimeout(() => this.connect(url), delay)
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set())
    }
    this.handlers.get(type)!.add(handler)

    // Return unsubscribe function
    return () => this.handlers.get(type)?.delete(handler)
  }

  send(type: string, data: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, data }))
    }
  }

  disconnect() {
    this.ws?.close()
    this.ws = null
  }
}

export const ws = new WebSocketService()
```

### Real-Time Store Integration

```typescript
// src/stores/realtime.ts
import { defineStore } from 'pinia'
import { onMounted, onUnmounted } from 'vue'
import { ws } from '@/services/websocket'
import { useEntitiesStore } from './entities'
import { useMessagesStore } from './messages'

export const useRealtimeStore = defineStore('realtime', () => {
  const entitiesStore = useEntitiesStore()
  const messagesStore = useMessagesStore()

  function setupListeners() {
    const unsubscribers: (() => void)[] = []

    unsubscribers.push(
      ws.on('entity:created', entitiesStore.handleEntityUpdate),
      ws.on('entity:updated', entitiesStore.handleEntityUpdate),
      ws.on('message:new', messagesStore.handleNewMessage),
    )

    ws.connect(import.meta.env.VITE_WS_URL)

    return () => {
      unsubscribers.forEach(unsub => unsub())
      ws.disconnect()
    }
  }

  return { setupListeners, connected: ws.connected }
})

// Composable for components
export function useRealtime() {
  const store = useRealtimeStore()

  onMounted(() => {
    const cleanup = store.setupListeners()
    onUnmounted(cleanup)
  })

  return { connected: store.connected }
}
```

---

## 10. References

### Official Documentation
- [Vue.js Official Docs](https://vuejs.org/)
- [Vue 3.5 Announcement](https://blog.vuejs.org/posts/vue-3-5)
- [Vue 3.6 Preview - Vapor Mode](https://vueschool.io/articles/news/vn-talk-evan-you-preview-of-vue-3-6-vapor-mode/)
- [Vite Official Docs](https://vite.dev/)
- [Vite 7.0 Announcement](https://vite.dev/blog/announcing-vite7)
- [Pinia Official Docs](https://pinia.vuejs.org/)
- [Vue Router Official Docs](https://router.vuejs.org/)
- [unplugin-vue-router](https://github.com/posva/unplugin-vue-router)

### Version Information
- [Vue.js 2025 Review and 2026 Peek](https://vueschool.io/articles/news/vue-js-2025-in-review-and-a-peek-into-2026/)
- [Vite Releases](https://github.com/vitejs/vite/releases)
- [Pinia Releases](https://github.com/vuejs/pinia/releases)

### Best Practices
- [VoidZero - What's New in ViteLand Dec 2025](https://voidzero.dev/posts/whats-new-dec-2025)
- [Vite 7 - What's New](https://blog.openreplay.com/whats-new-vite-7-rust-baseline-beyond/)

---

## Summary

### Key Recommendations for Mobile-Focused, API-Driven SPA:

1. **Use Vue 3.5 (stable)** - Solid foundation, no breaking changes
2. **Vite 7.3** - Latest stable with `baseline-widely-available` target
3. **Pinia 3.0 Setup Stores** - Better TypeScript, no local storage needed
4. **unplugin-vue-router** - File-based routing with type safety
5. **TypeScript strict mode** - All strict flags enabled
6. **WebSocket service** - For real-time updates
7. **Feature-based structure** - Scales well, clear boundaries
8. **Composables pattern** - Extract reusable logic

### Mobile Optimization Tips:

- Use `chunkSizeWarningLimit: 500` for smaller chunks
- Enable `manualChunks` to separate vendor code
- Use lazy loading for routes
- Consider PWA manifest for installability
- Test on real mobile devices with throttling
