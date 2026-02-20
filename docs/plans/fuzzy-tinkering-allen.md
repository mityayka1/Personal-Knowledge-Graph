# Plan: Post-Hierarchy Improvements

> **Статус:** 📋 В планировании
> **Контекст:** После реорганизации Activity hierarchy (3 AREA → 3 BUSINESS → проекты) остались задачи по деплою, классификации сирот, обновлению документации и UI.

## Context

**Что сделано:** Построена полная иерархия Activity:
```
Работа (AREA) → ИИ-Сервисы (BIZ) → Панавто, Butler (PRJ)
              → GoogleSheets.ru (BIZ) → Автоплан, Flowwow, ...
              → Freelance (BIZ) → Opsygen, ЛасФлор (PRJ)
Свои проекты (AREA) → PKG
Личное (AREA) → 5 проектов + 14 задач
```

**Что осталось:**
1. Фикс `activityType` в PATCH endpoint — код готов, нужен commit + deploy
2. 249 задач-сирот на root уровне — нужна автоклассификация
3. INDEX.md содержит устаревшую информацию о пробелах extraction pipeline
4. Нет UI для навигации по иерархии Activity

---

## Шаг 1: Deploy activityType fix

**Файл:** `apps/pkg-core/src/modules/activity/activity.service.ts`

**Статус кода:** Фикс уже на месте:
- Строка 251: `if (dto.activityType !== undefined) activity.activityType = dto.activityType;`
- Строка 325: `activityType: activity.activityType` в updateSet

**Действия:**
1. Commit изменения в `activity.service.ts`
2. Deploy на production: `git pull && cd docker && docker compose build --no-cache pkg-core && docker compose up -d pkg-core`
3. Verify: `PATCH /activities/{id}` с `{ "activityType": "task" }` — должен обновить тип

---

## Шаг 2: Авто-классификация 249 сирот

**Проблема:** 249 задач (type=TASK) висят на root уровне (parentId=null) после реорганизации иерархии.

### 2a. Запустить существующий endpoint

**Endpoint:** `POST /api/v1/data-quality/auto-assign-orphans`

**Файлы:**
- `data-quality/data-quality.controller.ts:138` — endpoint
- `data-quality/data-quality.service.ts:763` — `autoAssignOrphanedTasks()`
- `data-quality/orphan-resolution.service.ts:60` — `resolveOrphans()` с 4 стратегиями

**4 текущих стратегии:**
1. **Name Containment** — имя задачи содержит имя проекта (case-insensitive, `normalizeName()`)
2. **Batch** — общий `draftBatchId` в metadata со знакомой задачей
3. **Single Project** — у владельца ровно один активный проект
4. **Unsorted Fallback** — присвоить к "Unsorted Tasks"

**Проблема:** Стратегия 3 не сработает — у владельца >15 активных проектов. Стратегия 1 сработает только если имя задачи содержит имя проекта (маловероятно для большинства). Fallback свалит всё в "Unsorted Tasks" — нежелательно.

### 2b. Добавить fuzzy matching стратегию

**Файл:** `data-quality/orphan-resolution.service.ts`

**Новая стратегия** (вставить между Strategy 1 и Strategy 2):

```
Strategy 1.5: Fuzzy Name Matching
- Использовать ProjectMatchingService.findBestMatchInList()
- Порог: 0.6 (ниже стандартных 0.8 для лучшего recall)
- Матчит задачи по нечёткому сходству имени с проектами
```

**Изменения:**
1. В `resolveOrphans()` добавить вызов `matchByFuzzyName()` после `matchByNameContainment()` и перед `matchByBatch()`
2. Новый private метод `matchByFuzzyName(task, projects)`:
   ```typescript
   private matchByFuzzyName(task: Activity, projects: Activity[]): Activity | null {
     const projectNames = projects.map(p => ({ id: p.id, name: p.name }));
     const result = this.projectMatchingService.findBestMatchInList(task.name, projectNames);
     if (result && result.score >= 0.6) {
       return projects.find(p => p.id === result.id) ?? null;
     }
     return null;
   }
   ```
3. Добавить `'fuzzy_name'` в `OrphanResolutionMethod` union type
4. Обновить тесты в `orphan-resolution.service.spec.ts`

### 2c. Запустить и проанализировать результат

1. Вызвать `POST /data-quality/auto-assign-orphans`
2. Проанализировать `details` в ответе — сколько matched по каждой стратегии
3. Оставшихся нерешённых — оценить вручную, может потребоваться ручная привязка

**Переиспользуемые функции:**
- `ProjectMatchingService.findBestMatchInList()` → `project-matching.service.ts`
- `ProjectMatchingService.normalizeName()` → strips cost annotations
- `OrphanResolutionService.assignParent()` → sets parentId через `activityService.update()`

---

## Шаг 3: Обновить INDEX.md (устаревшие пробелы)

**Файл:** `docs/second-brain/INDEX.md`

**Проблема:** Таблица "Известные пробелы" содержит устаревшую информацию. Проверка кода показала:

| Утверждение в INDEX.md | Реальность |
|------------------------|-----------|
| `create_fact` без дедупликации в UnifiedExtraction | ❌ Неверно — `create_fact` tool имеет полный dedup + Smart Fusion (`extraction-tools.provider.ts:523-614`) |
| UnifiedExtraction lacks ProjectMatching | ❌ Неверно — `create_event` делегирует в `draftExtractionService.createDrafts()` который использует полный pipeline |
| UnifiedExtraction lacks Task Dedup | ❌ Неверно — через `DraftExtractionService.createDrafts()` |
| UnifiedExtraction lacks Smart Fusion | ❌ Неверно — `create_fact` tool напрямую использует `FactFusionService` |
| UnifiedExtraction lacks ClientResolution | ❌ Неверно — через `DraftExtractionService` |
| ConfirmationService — 3 handler'а TODO | ❌ Неверно — все 4 реализованы (`confirmation.service.ts:171-209`) |

**Что действительно остаётся как пробел:**
- `getPendingApprovalsForBatch()` — проверить актуальность
- Тест-покрытие контроллеров — 23% (факт)

**Действия:**
1. Обновить таблицу "Extraction Pipeline — разрыв функциональности" в INDEX.md
2. Перенести решённые пробелы в секцию "Решённые пробелы"
3. Убрать ConfirmationService из пробелов
4. Обновить секцию "Другие пробелы"

---

## Шаг 4: Dashboard Tree View

**Директория:** `apps/dashboard/`

### 4a. Существующая инфраструктура

| Компонент | Файл | Статус |
|-----------|------|--------|
| `useActivityTree()` | `composables/useActivities.ts:235` | ✅ Готов, не используется |
| `GET /activities/:id/tree` | API | ✅ Работает |
| `GET /activities?parentId=null` | API | ✅ Root activities |
| Activity types/colors/labels | `composables/useActivities.ts:122-199` | ✅ Полные |
| Существующий flat list | `pages/activities/index.vue` | ✅ С фильтрами |

### 4b. Новые компоненты

**1. Рекурсивный TreeNode компонент**

**Файл:** `apps/dashboard/components/ActivityTreeNode.vue`

```
<template>
  <div :style="{ paddingLeft: depth * 20 + 'px' }">
    <div class="flex items-center gap-2 py-1 hover:bg-accent/50 rounded cursor-pointer"
         @click="toggle">
      <!-- Expand/collapse icon -->
      <ChevronRight v-if="hasChildren" :class="{ 'rotate-90': expanded }" class="w-4 h-4" />
      <span v-else class="w-4" />

      <!-- Type badge -->
      <span :class="ACTIVITY_TYPE_COLORS[node.activityType]" class="px-1.5 py-0.5 text-xs rounded">
        {{ ACTIVITY_TYPE_LABELS[node.activityType] }}
      </span>

      <!-- Name -->
      <NuxtLink :to="`/activities/${node.id}`" class="hover:underline flex-1">
        {{ node.name }}
      </NuxtLink>

      <!-- Status badge -->
      <span :class="ACTIVITY_STATUS_COLORS[node.status]" class="px-1.5 py-0.5 text-xs rounded">
        {{ ACTIVITY_STATUS_LABELS[node.status] }}
      </span>

      <!-- Children count -->
      <span v-if="node.childrenCount" class="text-xs text-muted-foreground">
        ({{ node.childrenCount }})
      </span>
    </div>

    <!-- Children (lazy-loaded on expand) -->
    <div v-if="expanded && children">
      <ActivityTreeNode v-for="child in children" :key="child.id"
        :node="child" :depth="depth + 1" />
    </div>
  </div>
</template>
```

**Загрузка детей:** При expand → `GET /activities?parentId={id}&limit=100` через `useActivities()` composable.

**2. Tree page**

**Файл:** `apps/dashboard/pages/activities/tree.vue`

- Загружает root activities: `GET /activities?parentId=null&limit=100`
  (Примечание: `parentId=null` не поддерживается текущим API — нужно `depth=0` или null filter)
- Рендерит `ActivityTreeNode` для каждого root
- Фильтры: статус (active/all), поиск
- "Expand All" / "Collapse All" кнопки

### 4c. Backend: фильтр root activities

**Файл:** `apps/pkg-core/src/modules/activity/activity.controller.ts`

Проверить поддержку фильтра `parentId=null` (root activities) в `GET /activities`. Если нет — добавить: `where.parentId = IsNull()` когда `query.parentId === 'null'`.

### 4d. Навигация

Добавить ссылку "Дерево" в sidebar или как tab на странице `/activities`.

---

## Зависимости

```
Шаг 1 → независимый (deploy)
Шаг 2a → зависит от Шага 1 (deploy, чтобы иерархия была видна)
Шаг 2b → независимый (code change)
Шаг 2c → зависит от 2a + 2b
Шаг 3 → независимый (documentation)
Шаг 4 → независимый (dashboard, может делаться параллельно)
```

---

## Файлы для изменения

| Файл | Шаг | Описание |
|------|-----|----------|
| `activity/activity.service.ts` | 1 | Commit существующего фикса |
| `data-quality/orphan-resolution.service.ts` | 2b | Добавить fuzzy matching стратегию |
| `data-quality/orphan-resolution.service.spec.ts` | 2b | Тесты для fuzzy strategy |
| `docs/second-brain/INDEX.md` | 3 | Обновить устаревшие пробелы |
| `dashboard/components/ActivityTreeNode.vue` | 4 | **Новый** — рекурсивный tree node |
| `dashboard/pages/activities/tree.vue` | 4 | **Новый** — tree page |
| `activity/activity.controller.ts` | 4c | parentId=null фильтр (если нет) |

---

## Verification

### Шаг 1 (Deploy):
```bash
curl -X PATCH https://assistant.mityayka.ru/api/v1/activities/{id} \
  -H "x-api-key: ..." -H "Content-Type: application/json" \
  -d '{"activityType": "task"}'
# Ожидание: 200 OK, activityType обновлён
```

### Шаг 2 (Orphan resolution):
```bash
curl -X POST https://assistant.mityayka.ru/api/v1/data-quality/auto-assign-orphans \
  -H "x-api-key: ..."
# Ожидание: JSON с resolved/unresolved/details
# Цель: resolved > 100 из 249
```

### Шаг 3 (INDEX.md):
- Визуальная проверка — таблица пробелов отражает реальность

### Шаг 4 (Dashboard tree):
- Открыть `/activities/tree` в браузере
- Root nodes: Работа, Свои проекты, Личное
- Expand Работа → ИИ-Сервисы, GoogleSheets.ru, Freelance
- Expand ИИ-Сервисы → Панавто, Butler
- Клик по проекту → переход на `/activities/{id}`

### Production deploy:
```bash
ssh mityayka@assistant.mityayka.ru
cd /opt/apps/pkg && git pull && cd docker && docker compose build --no-cache pkg-core && docker compose up -d pkg-core
```
