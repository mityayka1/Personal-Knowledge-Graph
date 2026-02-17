# Plan: Улучшение Extraction Context + Manual Correction

## Context

**Проблема:** При extraction из бесед (SecondBrainExtractionService) обязательства и задачи создаются как **сироты** — без привязки к существующим проектам/активностям.

**Конкретный кейс:** Сообщение "Пойду Максу сделаю договор" создаёт commitment с `activity_id = null`, хотя в системе может быть связанный проект. Claude не знает о существующих проектах, потому что ему не передаётся их список.

**Корневая причина:** SecondBrainExtractionService (real-time extraction) НЕ загружает existing activities, в отличие от DailySynthesisExtractionService, который:
- Вызывает `loadExistingActivities()` — top 100 activities
- Форматирует их для промпта через `formatActivityContext()`
- Передаёт projectName + existingActivityId в schema

**Дополнительные проблемы:**
- CONVERSATION_EXTRACTION_SCHEMA не содержит поля `projectName` для задач/обязательств
- Нет REST endpoint для редактирования draft entities (метод `updateTargetEntity()` есть в сервисе, но не exposed через контроллер)
- Cross-chat context window слишком узкий (30 мин)

---

## Шаги реализации

### Шаг 1: Добавить `projectName` в conversation extraction schema и mappers

**Файл:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

**Зачем:** Без поля `projectName` в выходных данных LLM не может указать привязку к проекту, даже если знает о нём.

**Изменения (4 места в одном файле):**

**1a.** Обновить описания типов в `buildConversationSystemPrompt()` (строки 592-608) — добавить `projectName?` к типам task, promise_by_me, promise_by_them, meeting:

```
4. **task** — задача от собеседника мне
   data: { what, priority?, deadline?, deadlineText?, projectName?: "точное имя проекта из списка" }
```

**1b.** Обновить `mapToExtractedTask()` (строка 369) — добавить `projectName` в деструктуризацию и return:
```typescript
const data = rawEvent.data as {
  what?: string;
  priority?: string;
  deadline?: string;
  deadlineText?: string;
  projectName?: string;  // NEW
};
return {
  ...existing,
  projectName: data.projectName,  // NEW
};
```

**1c.** Обновить `mapToExtractedCommitment()` (строка 394) — аналогично добавить `projectName`.

**1d.** Обновить `mapToExtractedMeeting()` (строка 419) — аналогично.

**Почему schema не меняется:** `CONVERSATION_EXTRACTION_SCHEMA` определяет `data` как `{ type: 'object', additionalProperties: true }` — любые поля уже разрешены. LLM управляется описаниями в system prompt.

**Почему DraftExtractionService не меняется:** Он уже обрабатывает `projectName` для задач (строки 517-529) и обязательств (строки 609-644) через 3-tier fuzzy matching.

---

### Шаг 2: Внедрить activity context в conversation extraction prompt

**Файл:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

**Зачем:** Это ключевое изменение — Claude получит список существующих проектов и сможет привязывать задачи/обязательства к ним.

**Что переиспользуем:**
- `DailySynthesisExtractionService.loadExistingActivities()` (строки 210-227)
- `DailySynthesisExtractionService.formatActivityContext()` (строки 232-259)

**Изменения (4 места):**

**2a.** Activity repo уже доступен — `Activity` есть в `TypeOrmModule.forFeature()` в `extraction.module.ts:61`. Добавить `@InjectRepository(Activity)` в constructor.

**2b.** Скопировать два метода из DailySynthesisExtractionService:
- `loadExistingActivities(ownerEntityId?)` — top 100 non-archived activities с client join
- `formatActivityContext(activities)` — группировка по типу, форматирование с id, name, client, status, tags

**2c.** В `extractFromConversation()` (после строки 179) добавить загрузку активностей:
```typescript
const activities = await this.loadExistingActivities(ownerEntityId);
const activityContext = this.formatActivityContext(activities);
```

Передать в `buildConversationSystemPrompt(entityContext, crossChatContext, activityContext)`.

**2d.** В `buildConversationSystemPrompt()` добавить третий параметр и секцию:
```
═══════════════════════════════════════════════════════════════
СУЩЕСТВУЮЩИЕ АКТИВНОСТИ (проекты, задачи — для привязки):
${activityContext}
═══════════════════════════════════════════════════════════════
```

Добавить правило extraction:
```
6. Используй СУЩЕСТВУЮЩИЕ АКТИВНОСТИ для привязки:
   - Если задача/обещание связано с известным проектом — укажи projectName
   - Используй ТОЧНЫЕ имена проектов из списка
   - Если ничего не подходит — не указывай projectName
```

---

### Шаг 3: REST endpoint для редактирования draft entities

**Файл:** `apps/pkg-core/src/modules/pending-approval/pending-approval.controller.ts`

**Зачем:** Позволит исправлять ошибочные привязки (перепривязать задачу к другому проекту, изменить имя, назначить исполнителя).

**Добавить:**

```typescript
@Patch(':id/target')
async updateTarget(
  @Param('id', ParseUUIDPipe) id: string,
  @Body() body: UpdateTargetDto,
): Promise<{ success: true; id: string }> {
  await this.pendingApprovalService.updateTargetEntity(id, updates);
  return { success: true, id };
}
```

**UpdateTargetDto** — body с полями: `name?`, `description?`, `priority?`, `deadline?`, `parentId?`, `clientEntityId?`, `assignee?`, `dueDate?`. Даты принимаются как ISO strings, конвертируются в Date.

**Метод `updateTargetEntity()` уже реализован** в pending-approval.service.ts:278-358 — обрабатывает все типы (task/project → Activity fields, commitment → Commitment fields).

---

### Шаг 4: REST endpoint для просмотра target entity

**Файлы:**
- `apps/pkg-core/src/modules/pending-approval/pending-approval.service.ts` — добавить `getTargetEntity()`
- `apps/pkg-core/src/modules/pending-approval/pending-approval.controller.ts` — добавить endpoint

**Зачем:** Для UI — посмотреть текущее состояние draft entity перед редактированием.

```typescript
// Service
async getTargetEntity(id: string): Promise<{ itemType: string; target: Record<string, unknown> } | null> {
  const approval = await this.approvalRepo.findOne({ where: { id } });
  if (!approval) return null;
  const config = getItemTypeConfig(approval.itemType);
  const target = await this.dataSource.manager.findOne(config.entityClass, { where: { id: approval.targetId } });
  if (!target) return null;
  return { itemType: approval.itemType, target };
}

// Controller
@Get(':id/target')
async getTarget(@Param('id', ParseUUIDPipe) id: string) { ... }
```

**Порядок route:** `GET :id/target` должен быть ДО `GET :id` — иначе NestJS может подставить "target" как UUID (ParseUUIDPipe отклонит, но лучше явный порядок).

---

### Шаг 5: Расширить окно cross-chat context

**Файл:** `apps/pkg-core/src/modules/settings/settings.service.ts`

**Изменение:** `DEFAULT_CROSS_CHAT_CONTEXT_MINUTES: 30 → 120` (строка 136)

**Зачем:** 30 минут слишком мало для бизнес-разговоров. 2 часа покрывает большинство связанных обсуждений за день.

**Настраиваемость:** Значение уже можно переопределить через `PATCH /settings` с ключом `extraction.crossChatContextMinutes`.

---

## Зависимости между шагами

```
Шаг 1 + Шаг 2 → деплоить вместе (1 без 2 бесполезен — LLM не знает проектов; 2 без 1 — LLM знает но не может указать projectName)
Шаг 3 → независимый
Шаг 4 → независимый
Шаг 5 → независимый
```

---

## Файлы для изменения

| Файл | Шаг | Описание |
|------|-----|----------|
| `extraction/second-brain-extraction.service.ts` | 1, 2 | Activity context + projectName mappers |
| `pending-approval/pending-approval.controller.ts` | 3, 4 | PATCH + GET target endpoints |
| `pending-approval/pending-approval.service.ts` | 4 | getTargetEntity() метод |
| `settings/settings.service.ts` | 5 | Cross-chat window 30→120 мин |

**Новых файлов: 0. Миграций: 0. Изменений entity: 0.**

---

## Существующие функции для переиспользования

| Функция | Файл | Зачем |
|---------|------|-------|
| `loadExistingActivities()` | daily-synthesis-extraction.service.ts:210 | Копировать в SecondBrain |
| `formatActivityContext()` | daily-synthesis-extraction.service.ts:232 | Копировать в SecondBrain |
| `findExistingProjectEnhanced()` | draft-extraction.service.ts | Уже используется для projectName → parentId |
| `updateTargetEntity()` | pending-approval.service.ts:278 | Уже реализован, нужен только endpoint |
| `getItemTypeConfig()` | item-type-registry.ts:79 | Для getTargetEntity() |
| `ProjectMatchingService.normalizeName()` | project-matching.service.ts | Уже используется в DraftExtraction |

---

## Verification

### Шаг 1+2 (Activity context injection):
1. Создать Activity через `POST /activities` с известным именем
2. Вызвать conversation extraction на беседе с упоминанием этого проекта
3. Проверить PendingApproval — задача должна иметь `parentId` → Activity
4. SQL: `SELECT a.name, a.parent_id FROM activities WHERE id = (SELECT target_id FROM pending_approvals WHERE batch_id = '...' AND item_type = 'task')`

### Шаг 3 (PATCH endpoint):
1. `GET /pending-approval?status=pending` → получить ID
2. `PATCH /pending-approval/{id}/target` с `{ "parentId": "project-uuid" }`
3. Проверить: `SELECT parent_id FROM activities WHERE id = '{targetId}'`
4. Попробовать на non-pending → ожидать 409
5. Попробовать с invalid UUID → ожидать 400

### Шаг 4 (GET target):
1. `GET /pending-approval/{id}/target` → ожидать `{ itemType, target: { name, parentId, status, ... } }`

### Шаг 5 (Cross-chat window):
1. Проверить через `GET /settings` значение `extraction.crossChatContextMinutes`
2. Или по логам: cross-chat context включает сообщения за 2 часа

### Production deploy:
```bash
ssh mityayka@assistant.mityayka.ru
cd /opt/apps/pkg && git pull && cd docker && docker compose build --no-cache pkg-core && docker compose up -d pkg-core
```
