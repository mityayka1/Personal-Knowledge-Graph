---
title: "feat: Migrate Telegram Bot UI to Mini Apps"
type: feat
date: 2026-01-31
status: draft
---

# Миграция Telegram Bot UI на Telegram Mini Apps (Vue 3)

## Overview

Полный отказ от интерактивного UI в Telegram Bot (callbacks, inline keyboards, carousels) и перенос всего визуального интерфейса в Telegram Mini App на Vue 3. Bot остаётся только для:
- Приёма команд с текстовым вводом (`/recall query`, `/prepare name`)
- Отправки уведомлений (morning brief, digests)
- Proactive сообщений с кнопкой "Открыть в приложении"

## Problem Statement / Motivation

### Текущие проблемы Bot UI

1. **Ограничения Telegram Bot API:**
   - Callbacks могут содержать max 64 bytes данных
   - Inline keyboards ограничены 8 кнопками в ряд
   - Нет нормальных форм ввода (только reply)
   - Edit message не работает для сложных обновлений

2. **LLM Extraction возвращает неполные данные:**
   - Проекты без названий ("Без названия")
   - Confidence 0% на валидных извлечениях
   - JSON Schema `required` не гарантирует данные от Claude

3. **UX проблемы:**
   - Карусель из 20 элементов неудобна в чате
   - Accordion в Morning Brief — плохой паттерн для Telegram
   - Нет визуальной иерархии (всё текст + emoji)

### Преимущества Mini App

- Полноценный UI с Vue 3 компонентами
- Нормальная навигация (роуты, back button)
- Формы с валидацией
- Pull-to-refresh, infinite scroll
- Отладка в Chrome DevTools
- Adaptive theme (light/dark из Telegram)

## Proposed Solution

### Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                     Telegram Client                          │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │  Bot Chat   │    │         Mini App (Vue 3)          │    │
│  │  /commands  │───▶│  Dashboard, Carousels, Briefs     │    │
│  │  notifications   │                                    │    │
│  └─────────────┘    └──────────────┬───────────────────┘    │
└──────────────────────────────────────┼──────────────────────┘
                                       │ HTTPS + initData
                                       ▼
                            ┌──────────────────────┐
                            │      PKG Core        │
                            │  TelegramAuthGuard   │
                            │  Mini App Endpoints  │
                            └──────────┬───────────┘
                                       │
                            ┌──────────▼───────────┐
                            │     PostgreSQL       │
                            │     + Redis          │
                            └──────────────────────┘
```

### Scope разделения Bot vs Mini App

| Функция | Bot | Mini App | Причина |
|---------|-----|----------|---------|
| `/recall <query>` | ✅ Приём команды | ✅ Отображение результатов | Текстовый ввод удобнее в чате |
| `/prepare <name>` | ✅ Приём команды | ✅ Отображение brief | Быстрый ввод через команду |
| `/daily` | ✅ Приём + уведомление | ✅ Полный UI summary + extraction | Сложный UI |
| Morning Brief | ✅ Notification с кнопкой | ✅ Accordion + actions | Интерактивный UI |
| Extraction Carousel | ❌ Убрать | ✅ Полный UI | Слишком сложный для callbacks |
| Approval Flow | ✅ Быстрые действия | ✅ Edit mode | Confirm/Reject быстрее в боте |
| Fact Conflicts | ✅ Notification | ✅ Resolution UI | Может требовать контекст |
| Entity Profile | ❌ Нет | ✅ Полный профиль | Нужен сложный UI |

### Tech Stack

| Layer | Technology | Version |
|-------|------------|---------|
| **Frontend** | Vue 3 + Composition API | 3.5.x |
| **Build** | Vite | 7.x |
| **State** | Pinia | 3.x |
| **Router** | Vue Router | 4.5.x |
| **TG SDK** | @twa-dev/sdk + vue-tg | latest |
| **TypeScript** | TypeScript | 5.5+ |
| **Backend** | NestJS (existing PKG Core) | - |
| **Auth** | TelegramAuthGuard (new) | - |

## Technical Approach

### Phase 1: Foundation (Infrastructure)

#### 1.1 Mini App Project Setup ✅

**Создать `apps/mini-app/`:** ✅

```
apps/mini-app/
├── src/
│   ├── api/
│   │   └── client.ts              # API client with initData auth
│   ├── components/
│   │   ├── common/
│   │   │   ├── SafeAreaContainer.vue
│   │   │   ├── LoadingSpinner.vue
│   │   │   ├── EmptyState.vue
│   │   │   └── ErrorBoundary.vue
│   │   └── features/
│   │       └── (feature components)
│   ├── composables/
│   │   ├── useApi.ts
│   │   ├── useTelegram.ts
│   │   └── useSmartHaptics.ts
│   ├── pages/
│   │   ├── index.vue              # Dashboard
│   │   ├── recall/
│   │   │   └── [sessionId].vue
│   │   ├── brief/
│   │   │   └── [briefId].vue
│   │   ├── extraction/
│   │   │   └── [carouselId].vue
│   │   └── entity/
│   │       └── [entityId].vue
│   ├── stores/
│   │   ├── user.ts
│   │   ├── brief.ts
│   │   └── extraction.ts
│   ├── styles/
│   │   └── theme.css
│   ├── App.vue
│   └── main.ts
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

**vite.config.ts:**
```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3002,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'tg-sdk': ['@twa-dev/sdk'],
        },
      },
    },
  },
})
```

#### 1.2 Backend: TelegramAuthGuard ✅

**`apps/pkg-core/src/modules/telegram-mini-app/guards/telegram-auth.guard.ts`:** ✅

```typescript
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

@Injectable()
export class TelegramAuthGuard implements CanActivate {
  private readonly botToken: string;
  private readonly maxAgeSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.getOrThrow('TELEGRAM_BOT_TOKEN');
    this.maxAgeSeconds = this.configService.get('TG_INIT_DATA_MAX_AGE', 86400);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];

    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const [authType, initDataRaw] = authHeader.split(' ');

    if (authType !== 'tma' || !initDataRaw) {
      throw new UnauthorizedException('Invalid format. Expected: tma <initData>');
    }

    const initData = this.validateAndParse(initDataRaw);

    request.telegramInitData = initData;
    request.telegramUser = initData.user;

    return true;
  }

  private validateAndParse(initDataRaw: string) {
    const decoded = decodeURIComponent(initDataRaw);
    const params = new URLSearchParams(decoded);

    const hash = params.get('hash');
    if (!hash) throw new UnauthorizedException('Missing hash');

    const authDateStr = params.get('auth_date');
    if (!authDateStr) throw new UnauthorizedException('Missing auth_date');

    const authDate = parseInt(authDateStr, 10);
    const now = Math.floor(Date.now() / 1000);

    if (now - authDate > this.maxAgeSeconds) {
      throw new UnauthorizedException('initData expired');
    }

    // Build data check string
    const checkParams: string[] = [];
    params.forEach((value, key) => {
      if (key !== 'hash') checkParams.push(`${key}=${value}`);
    });
    checkParams.sort();
    const dataCheckString = checkParams.join('\n');

    // Calculate expected hash
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(this.botToken)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (hash !== expectedHash) {
      throw new UnauthorizedException('Invalid signature');
    }

    const userStr = params.get('user');
    let user: TelegramUser | undefined;
    if (userStr) {
      user = JSON.parse(userStr);
    }

    return {
      query_id: params.get('query_id') || undefined,
      user,
      auth_date: authDate,
      hash,
      start_param: params.get('start_param') || undefined,
    };
  }
}
```

#### 1.3 API Endpoints for Mini App ✅

**`apps/pkg-core/src/modules/telegram-mini-app/telegram-mini-app.module.ts`:** ✅

```typescript
@Module({
  imports: [
    EntityModule,
    BriefModule,
    ExtractionModule,
    RecallSessionModule,
  ],
  controllers: [TelegramMiniAppController],
  providers: [TelegramAuthGuard],
})
export class TelegramMiniAppModule {}
```

**Endpoints:**
```
GET  /api/mini-app/me                      - Current user + owner status
GET  /api/mini-app/dashboard               - Dashboard data (briefs, pending)
GET  /api/mini-app/brief/:id               - Brief details with items
POST /api/mini-app/brief/:id/item/:idx/action - Brief item action
GET  /api/mini-app/extraction/:carouselId  - Carousel state
POST /api/mini-app/extraction/:carouselId/confirm/:itemId
POST /api/mini-app/extraction/:carouselId/skip/:itemId
GET  /api/mini-app/recall/:sessionId       - Recall session results
GET  /api/mini-app/entity/:id              - Entity profile
```

### Phase 2: Core Features ✅

#### 2.1 Dashboard Page ✅

**`apps/mini-app/src/pages/index.vue`:** ✅

Секции:
- **Pending Actions** — события на подтверждение, fact conflicts
- **Today's Brief** — если есть morning brief
- **Recent Activity** — последние recall sessions, entities
- **Quick Actions** — кнопки для частых действий

#### 2.2 Extraction Carousel Page ✅

**`apps/mini-app/src/pages/extraction/[carouselId].vue`:**

- Swipeable cards (один элемент на экране)
- MainButton: "Подтвердить" (динамически меняется)
- Кнопки: ← → навигация, Skip
- Progress indicator (3/20)
- Pull down to refresh
- Completion screen with stats

```vue
<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useMainButton, useBackButton, useHapticFeedback } from 'vue-tg'
import { useExtractionStore } from '@/stores/extraction'

const route = useRoute()
const router = useRouter()
const store = useExtractionStore()
const mainButton = useMainButton()
const backButton = useBackButton()
const haptic = useHapticFeedback()

const carouselId = computed(() => route.params.carouselId as string)

onMounted(async () => {
  await store.load(carouselId.value)

  backButton.show()
  backButton.onClick(() => router.back())

  updateMainButton()
})

function updateMainButton() {
  if (store.isComplete) {
    mainButton.setText('Готово')
    mainButton.onClick(() => router.push('/'))
  } else {
    mainButton.setText('✅ Подтвердить')
    mainButton.onClick(handleConfirm)
  }
  mainButton.show()
}

async function handleConfirm() {
  haptic.impactOccurred('medium')
  mainButton.showProgress()

  await store.confirmCurrent(carouselId.value)

  mainButton.hideProgress()
  updateMainButton()

  haptic.notificationOccurred('success')
}

async function handleSkip() {
  haptic.impactOccurred('light')
  await store.skipCurrent(carouselId.value)
  updateMainButton()
}

onUnmounted(() => {
  mainButton.hide()
  backButton.hide()
})
</script>
```

#### 2.3 Morning Brief Page ✅

**`apps/mini-app/src/pages/brief/[briefId].vue`:** ✅

- Collapsible sections (expand/collapse animations)
- Each item has action buttons (Done, Write, Remind, Prepare)
- Pull down to refresh
- Stats at top (X of Y completed)

#### 2.4 Recall Results Page ✅

**`apps/mini-app/src/pages/recall/[sessionId].vue`:** ✅

- Answer card at top
- Sources list below (expandable)
- Follow-up input at bottom
- Save insights button

### Phase 3: Bot Integration ✅

#### 3.1 Deep Links from Bot ✅

**Формат URL:** `t.me/SeBraBot/app?startapp=<encoded_data>`

**Encoded data examples:**
```
brief_abc123                    → /brief/abc123
extraction_ec_xyz789            → /extraction/ec_xyz789
recall_rs_def456                → /recall/rs_def456
entity_uuid-here                → /entity/uuid-here
```

**Bot message с кнопкой:**
```typescript
// В daily-summary.handler.ts
await this.telegram.sendMessage(chatId, summaryText, {
  reply_markup: {
    inline_keyboard: [[
      {
        text: '📱 Открыть в приложении',
        web_app: { url: `${MINI_APP_URL}?startapp=extraction_${carouselId}` }
      }
    ]]
  }
});
```

#### 3.2 Удаление Bot Callbacks

Постепенно удалить:
1. `CarouselCallbackHandler` → Mini App extraction page
2. `BriefCallbackHandler` → Mini App brief page
3. `DailySummaryHandler.handleExtraction*` → Mini App

Оставить:
- `ApprovalCallbackHandler` — быстрые Confirm/Reject
- `FactCallbackHandler` — простые 3 кнопки

### Phase 4: Deployment

#### 4.1 Docker Configuration

**docker/docker-compose.yml (additions):**
```yaml
services:
  pkg-mini-app:
    build:
      context: ..
      dockerfile: docker/Dockerfile.mini-app
    ports:
      - "3002:80"
    environment:
      - VITE_API_URL=https://api.pkg.example.com
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mini-app.rule=Host(`app.pkg.example.com`)"
```

**docker/Dockerfile.mini-app:**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/mini-app/package.json ./apps/mini-app/
RUN corepack enable && pnpm install --frozen-lockfile
COPY apps/mini-app ./apps/mini-app
RUN pnpm --filter @pkg/mini-app build

FROM nginx:alpine
COPY docker/nginx-mini-app.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/mini-app/dist /usr/share/nginx/html
EXPOSE 80
```

#### 4.2 Bot Configuration

Зарегистрировать Mini App через BotFather:
1. `/mybots` → Select bot → Bot Settings → Menu Button
2. Set URL: `https://app.pkg.example.com`
3. Enable Mini Apps in bot settings

## Acceptance Criteria

### Functional Requirements

- [ ] Mini App открывается из бота через Menu Button
- [ ] Mini App открывается через inline button в сообщениях
- [ ] Deep links работают (brief, extraction, recall, entity)
- [ ] Authentication через initData работает корректно
- [ ] Dashboard показывает pending actions и recent activity
- [ ] Extraction Carousel полностью функционален (confirm, skip, navigate)
- [ ] Morning Brief с expandable items и actions
- [ ] Recall results с sources и follow-up
- [ ] Entity profile page
- [ ] Темы (light/dark) адаптируются к Telegram

### Non-Functional Requirements

- [ ] Время загрузки Mini App < 2 секунды (LCP)
- [ ] Bundle size < 300KB gzipped
- [ ] Работает на iOS 15+, Android 8+
- [ ] initData validation < 10ms
- [ ] Graceful handling of network errors

### Quality Gates

- [ ] Unit tests для Pinia stores
- [ ] E2E tests для critical flows (extraction, brief)
- [ ] TelegramAuthGuard unit tests
- [ ] Manual testing на iOS и Android
- [ ] Accessibility: keyboard navigation, screen reader

## Dependencies & Prerequisites

1. **TELEGRAM_BOT_TOKEN** должен быть доступен в PKG Core
2. BotFather: включить Mini Apps для бота
3. HTTPS домен для Mini App (Telegram требует)
4. Node.js 20+ для Vite 7

## Risk Analysis & Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| initData validation bugs | Medium | High | Thorough testing, use official library |
| Theme inconsistencies | Low | Medium | Use CSS variables exclusively |
| Slow LLM responses | High | Medium | Progress indicators, background processing |
| iOS Safari quirks | Medium | Medium | Test on real devices early |
| State sync issues | Medium | High | Server as single source of truth |

## Migration Strategy

### Week 1-2: Foundation
- Setup project structure
- TelegramAuthGuard
- Basic API endpoints
- Dashboard stub

### Week 3-4: Core Features
- Extraction Carousel
- Morning Brief
- Recall Results

### Week 5: Integration
- Deep links from bot
- Bot message buttons
- Remove old carousel callbacks

### Week 6: Polish & Deploy
- Testing
- Performance optimization
- Production deployment

## Future Considerations

1. **Offline Support** — Service Worker для кеширования
2. **Push Notifications** — Web Push через Mini App
3. **Voice Input** — Speech-to-text для recall queries
4. **Entity Graph Visualization** — D3.js граф связей

## References

### Internal References
- Architecture: `/docs/ARCHITECTURE.md`
- API Contracts: `/docs/API_CONTRACTS.md`
- Second Brain Roadmap: `/docs/second-brain/INDEX.md`
- Source-Agnostic Pattern: `/docs/solutions/integration-issues/source-agnostic-architecture-prevention.md`
- Bot Handlers: `/apps/telegram-adapter/src/bot/handlers/`
- Extraction Carousel: `/apps/pkg-core/src/modules/extraction/extraction-carousel.controller.ts`

### External References
- [Telegram Mini Apps Docs](https://core.telegram.org/bots/webapps)
- [Telegram Mini Apps Community Docs](https://docs.telegram-mini-apps.com/)
- [@twa-dev/sdk](https://www.npmjs.com/package/@twa-dev/sdk)
- [vue-tg](https://github.com/deptyped/vue-telegram)
- [Vue 3 Docs](https://vuejs.org/)
- [Pinia Docs](https://pinia.vuejs.org/)
- [Vite Docs](https://vite.dev/)

### Institutional Learnings Applied
- LLM data requires defensive null checks (a6e00b9)
- DTOs need class-validator decorators (e87de82)
- Source-agnostic: Mini App → PKG Core only
- Centralized state in PKG Core, not adapters
