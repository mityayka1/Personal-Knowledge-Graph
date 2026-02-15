# Plan: Activity Dashboard UI

## Context

Система PKG имеет полноценный REST API для управления Activity (CRUD, hierarchy, members), но пока нет UI для просмотра и редактирования. Пользователю нужен интерфейс в существующем Dashboard (Nuxt 3 + Vue 3 + Tailwind + shadcn-vue) для работы с проектами, задачами и другими активностями.

**Scope:** Только Dashboard. Mini-app — в будущем.

---

## Архитектура

```
Dashboard (Nuxt 3)                    PKG Core
─────────────────                    ─────────
pages/activities/index.vue  ─►  GET    /activities?type=&status=&search=
pages/activities/[id].vue   ─►  GET    /activities/:id
pages/activities/[id].vue   ─►  PATCH  /activities/:id
pages/activities/[id].vue   ─►  DELETE /activities/:id
pages/activities/new.vue    ─►  POST   /activities
pages/activities/[id].vue   ─►  GET    /activities/:id/tree
pages/activities/[id].vue   ─►  GET    /activities/:id/members
pages/activities/[id].vue   ─►  POST   /activities/:id/members

composables/useActivities.ts  — Vue Query hooks
layouts/default.vue           — + навигация "Активности"
```

API proxy (`server/api/[...path].ts`) уже маршрутизирует `/api/*` → PKG Core, ничего менять не нужно.

---

## Файлы для создания/изменения

| File | Тип | Описание |
|------|-----|----------|
| `apps/dashboard/composables/useActivities.ts` | CREATE | Vue Query composable |
| `apps/dashboard/pages/activities/index.vue` | CREATE | Список с фильтрами |
| `apps/dashboard/pages/activities/[id].vue` | CREATE | Детали + редактирование |
| `apps/dashboard/pages/activities/new.vue` | CREATE | Форма создания |
| `apps/dashboard/layouts/default.vue` | MODIFY | Добавить пункт навигации |

---

## Part 1: Composable `useActivities.ts`

**File:** `apps/dashboard/composables/useActivities.ts`

По паттерну `useEntities.ts` — типизированные Vue Query hooks.

### Интерфейсы

```typescript
interface Activity {
  id: string;
  name: string;
  activityType: ActivityType;
  description: string | null;
  status: ActivityStatus;
  priority: ActivityPriority;
  context: ActivityContext;
  parentId: string | null;
  parent?: { id: string; name: string; activityType: string };
  ownerEntityId: string;
  ownerEntity?: { id: string; name: string };
  clientEntityId: string | null;
  clientEntity?: { id: string; name: string } | null;
  deadline: string | null;
  startDate: string | null;
  tags: string[] | null;
  progress: number | null;
  depth: number;
  childrenCount?: number;
  members?: ActivityMember[];
  createdAt: string;
  updatedAt: string;
}

// Enum'ы дублируем в dashboard (не тянем @pkg/entities в Nuxt)
type ActivityType = 'area' | 'business' | 'direction' | 'project' | 'initiative' | 'task' | 'milestone' | 'habit' | 'learning' | 'event_series';
type ActivityStatus = 'draft' | 'idea' | 'active' | 'paused' | 'completed' | 'cancelled' | 'archived';
type ActivityPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';
type ActivityContext = 'work' | 'personal' | 'any' | 'location_based';
```

### Hooks

| Hook | Описание |
|------|----------|
| `useActivities(params)` | Список с фильтрами и пагинацией |
| `useActivity(id)` | Одна активность по ID (с relations) |
| `useActivityTree(id)` | Поддерево (children + descendants) |
| `useActivityMembers(id)` | Участники |
| `useCreateActivity()` | Mutation: создание |
| `useUpdateActivity()` | Mutation: обновление |
| `useDeleteActivity()` | Mutation: архивирование (soft delete) |
| `useAddActivityMembers()` | Mutation: добавление участников |

### Вспомогательные объекты

Мэппинг enum → русские лейблы + цвета:

```typescript
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  area: 'Сфера', business: 'Бизнес', direction: 'Направление',
  project: 'Проект', initiative: 'Инициатива', task: 'Задача',
  milestone: 'Веха', habit: 'Привычка', learning: 'Обучение',
  event_series: 'Серия событий',
};

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  draft: 'Черновик', idea: 'Идея', active: 'Активна',
  paused: 'Пауза', completed: 'Завершена', cancelled: 'Отменена',
  archived: 'В архиве',
};

export const ACTIVITY_PRIORITY_LABELS: Record<ActivityPriority, string> = {
  critical: 'Критический', high: 'Высокий', medium: 'Средний',
  low: 'Низкий', none: 'Нет',
};

export const ACTIVITY_STATUS_COLORS: Record<ActivityStatus, string> = {
  draft: 'bg-gray-100 text-gray-600',
  idea: 'bg-yellow-100 text-yellow-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-orange-100 text-orange-700',
  completed: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-600',
  archived: 'bg-gray-100 text-gray-500',
};

export const ACTIVITY_PRIORITY_COLORS: Record<ActivityPriority, string> = {
  critical: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-blue-100 text-blue-600',
  none: 'bg-gray-100 text-gray-500',
};
```

---

## Part 2: Список активностей `pages/activities/index.vue`

**File:** `apps/dashboard/pages/activities/index.vue`

По паттерну `pages/entities/index.vue`.

### Функционал

1. **Header:** заголовок "Активности" + кнопка "Добавить" → `/activities/new`
2. **Поиск:** debounced input (300ms через `useDebounceFn` из `@vueuse/core`)
3. **Фильтры:**
   - **Тип:** toggle-кнопки для основных типов (project, task, area, business) + "Все"
   - **Статус:** toggle-кнопки (active, draft, completed, paused) + "Все"
4. **Список:** Card для каждой активности
   - Иконка типа (Lucide: `FolderKanban` для project, `CheckSquare` для task, `Globe` для area, `Building2` для business и т.д.)
   - Название + Badge типа
   - Status badge (цветной)
   - Priority badge (если не medium/none)
   - Имя клиента (если есть)
   - Дедлайн (если есть, красный если просрочен)
   - `formatRelativeTime(updatedAt)` справа
5. **Пагинация:** Назад/Вперёд + счётчик
6. **States:** Loading (Skeleton), Error, Empty

### Lucide иконки по типу

```typescript
const TYPE_ICONS: Record<ActivityType, Component> = {
  area: Globe, business: Building2, direction: GitBranch,
  project: FolderKanban, initiative: Rocket, task: CheckSquare,
  milestone: Flag, habit: RefreshCw, learning: GraduationCap,
  event_series: CalendarRange,
};
```

---

## Part 3: Детали активности `pages/activities/[id].vue`

**File:** `apps/dashboard/pages/activities/[id].vue`

Совмещённая страница: просмотр + inline-редактирование. По паттерну `pages/entities/[id]/index.vue`, но проще — без отдельной edit-страницы.

### Секции страницы

1. **Header:**
   - Кнопка "← Назад" → `/activities`
   - Иконка типа + Название
   - Badges: тип, статус, приоритет, контекст
   - Кнопки: "Редактировать" (toggle режим), "Архивировать" (ConfirmDialog)

2. **Card "Основное":**
   - Описание (view/edit textarea)
   - Владелец (ссылка на entity)
   - Клиент (ссылка на entity, если есть)
   - Прогресс (progress bar + число, editable)
   - Теги (badge list)

3. **Card "Сроки":**
   - Дата начала
   - Дедлайн (подсветка если просрочен)
   - Повторение (recurrenceRule)
   - Создано / Обновлено

4. **Card "Иерархия":**
   - Родитель (ссылка на parent activity)
   - Дочерние (children, если есть, ссылки)
   - Breadcrumb: path от корня через `materializedPath` или parent chain

5. **Card "Участники":**
   - Список членов с ролями (owner, member, assignee, etc.)
   - Кнопка "Добавить участника" → Dialog с выбором entity

6. **Режим редактирования:**
   - Toggle кнопкой "Редактировать"
   - Поля становятся editable (Input, Select, Textarea)
   - Кнопки "Сохранить" / "Отменить"
   - `useUpdateActivity` mutation

---

## Part 4: Создание активности `pages/activities/new.vue`

**File:** `apps/dashboard/pages/activities/new.vue`

Простая форма по паттерну `pages/entities/new.vue`.

### Поля формы

| Поле | Тип | Обязательно |
|------|-----|-------------|
| name | Input text | Да |
| activityType | Select | Да |
| ownerEntityId | Select (entity search) | Да |
| description | Textarea | Нет |
| status | Select (default: active) | Нет |
| priority | Select (default: medium) | Нет |
| context | Select (default: any) | Нет |
| parentId | Select (activity search) | Нет |
| clientEntityId | Select (entity search) | Нет |
| deadline | Input date | Нет |
| startDate | Input date | Нет |
| tags | Input (comma-separated) | Нет |

`ownerEntityId` — по умолчанию ставить текущего пользователя. Для простоты: пока хардкодим или загружаем из settings.

### После создания
Redirect на `/activities/:newId`.

---

## Part 5: Навигация

**File:** `apps/dashboard/layouts/default.vue`

Добавить пункт "Активности" в массив `navigation`:

```typescript
import { FolderKanban } from 'lucide-vue-next';

// После "Слияние", перед "Взаимодействия":
{ name: 'Активности', href: '/activities', icon: FolderKanban },
```

---

## Переиспользуемые компоненты

| Компонент | Откуда | Как используется |
|-----------|--------|-----------------|
| `Button`, `Card`, `CardContent`, `CardHeader`, `CardTitle` | `components/ui/` | Все страницы |
| `Badge` | `components/ui/badge/` | Типы, статусы, приоритеты |
| `Input` | `components/ui/input/` | Поиск, формы |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` | `components/ui/dialog/` | Добавление участников, подтверждение |
| `Skeleton` | `components/ui/skeleton/` | Loading states |
| `ConfirmDialog` | `components/ui/confirm-dialog/` | Архивирование |
| `Tooltip` | `components/ui/tooltip/` | Подсказки к иконкам |
| `formatRelativeTime`, `formatDate`, `cn` | `lib/utils.ts` | Форматирование дат |
| `useDebounceFn` | `@vueuse/core` | Debounced поиск |
| `useQuery`, `useMutation`, `useQueryClient` | `@tanstack/vue-query` | Data fetching |
| `$fetch` | Nuxt | HTTP запросы через proxy |

---

## Порядок реализации

1. `composables/useActivities.ts` — фундамент (типы, hooks, лейблы)
2. `layouts/default.vue` — добавить навигацию
3. `pages/activities/index.vue` — список
4. `pages/activities/new.vue` — создание
5. `pages/activities/[id].vue` — детали + редактирование

---

## Verification

1. **Dev режим:** `cd apps/dashboard && pnpm dev` — проверить что страницы открываются без ошибок
2. **Навигация:** клик по "Активности" в sidebar → `/activities`
3. **Список:** видны активности из БД, работают фильтры по типу и статусу, поиск
4. **Создание:** форма валидируется, после submit redirect на детали
5. **Детали:** все поля отображаются, работает редактирование
6. **Архивирование:** ConfirmDialog → soft delete → redirect на список
7. **E2E на prod:** `https://assistant.mityayka.ru/dashboard/activities`
