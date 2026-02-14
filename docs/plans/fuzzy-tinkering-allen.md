# Plan: Улучшение описаний проектов и предотвращение дублей

## Context

Когда ИИ создаёт проект через extraction pipeline, он уже понимает, о чём проект (анализирует daily synthesis). Но это понимание **теряется**:

1. **`description` не обязателен** в JSON Schema — Claude часто его пропускает
2. **Промпт просит слабо:** "Добавь description, priority, deadline, tags где доступны" — звучит как необязательное дополнение
3. **Claude не видит описания существующих проектов** при matching — `loadExistingActivities()` грузит только `id, name, type, status, client`, а `formatActivityContext()` выводит только `- Name (клиент) [status] (id)`. Без описаний Claude не может сопоставить семантически похожие проекты
4. **Dashboard не показывает описание** в списке активностей — пользователь не видит, о чём проект
5. **Metadata extraction (confidence, sourceQuote)** хранится в JSONB, но нигде не показывается в UI

**Цель:** Сделать описание обязательной частью extraction, дать Claude семантический контекст для matching, показать описания и metadata в UI, применить улучшения ко всем extraction pipelines.

## Этап 1: Daily Synthesis Extraction (основной pipeline)

### 1.1 Сделать `description` обязательным в JSON Schema

**File:** `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.types.ts`

В `DAILY_SYNTHESIS_EXTRACTION_SCHEMA.properties.projects.items`:
- Изменить описание поля `description`: `'Описание проекта: что делается, для чего, какой результат ожидается (2-3 предложения). ОБЯЗАТЕЛЬНО для каждого проекта.'`
- Добавить `'description'` в массив `required` (line 244): `['name', 'isNew', 'participants', 'confidence', 'projectIndicators', 'description']`

### 1.2 Усилить промпт для извлечения описаний

**File:** `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts`

В `buildPrompt()` (line 291) заменить:
```
- Добавь description, priority, deadline, tags где доступны
```
на:
```
- ОБЯЗАТЕЛЬНО добавь description (2-3 предложения): что это за проект, какова его цель, что конкретно делается
- Добавь priority, deadline, tags где доступны
```

В секции "КРИТЕРИИ ИЗВЛЕЧЕНИЯ ПРОЕКТОВ" (line 339) добавить акцент:
```
**description ОБЯЗАТЕЛЬНО** — опиши суть проекта своими словами на основе контекста из отчёта.
Хорошее описание: "Разработка системы мониторинга для клиента X. Включает бэкенд на Node.js и дашборд. Текущий этап — интеграция с API клиента."
Плохое описание: "Проект" или "Работа над проектом"
```

### 1.3 Добавить `description` и `tags` в контекст для matching

**File:** `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts`

**1.3a. `loadExistingActivities()`** (line 218):
Добавить `'a.description'` и `'a.tags'` в `.select()`:
```typescript
.select(['a.id', 'a.name', 'a.activityType', 'a.status', 'a.clientEntityId', 'a.description', 'a.tags'])
```

**1.3b. `formatActivityContext()`** (line 254):
Добавить описание и теги в формат вывода:
```typescript
const client = a.clientEntity ? ` (клиент: ${a.clientEntity.name})` : '';
const desc = a.description ? `\n      ${a.description}` : '';
const tags = a.tags?.length ? ` [теги: ${a.tags.join(', ')}]` : '';
lines.push(`  - ${a.name}${client} [${a.status}] (id: ${a.id})${tags}${desc}`);
```

Пример вывода:
```
PROJECT:
  - PKG Second Brain (клиент: —) [active] (id: xxx) [теги: backend, ai]
      Разработка системы персонального графа знаний с AI-ассистентом.
```

## Этап 2: Dashboard — описание в списке и metadata на detail page

### 2.1 Показать описание в списке активностей

**File:** `apps/dashboard/pages/activities/index.vue`

После строки с badges (line 242), перед div с мета-информацией (line 243), добавить строку описания:
```html
<p v-if="activity.description" class="text-sm text-muted-foreground mt-0.5 line-clamp-1">
  {{ activity.description }}
</p>
```

`line-clamp-1` обрежет длинные описания до одной строки с `...` на конце.

### 2.2 Показать extraction metadata на detail page

**File:** `apps/dashboard/pages/activities/[id].vue`

Расширить существующую карточку «Метаданные» (lines 757-769). Сейчас она показывает только ID. Добавить:

```html
<!-- Extraction metadata -->
<div v-if="activity.metadata?.extractedFrom" class="space-y-2 text-sm">
  <div>
    <span class="text-muted-foreground">Источник:</span>
    <Badge variant="outline" class="ml-2 text-xs">
      {{ activity.metadata.extractedFrom === 'daily_synthesis' ? 'Daily Synthesis' : activity.metadata.extractedFrom }}
    </Badge>
  </div>
  <div v-if="activity.metadata?.confidence">
    <span class="text-muted-foreground">Уверенность:</span>
    <span class="ml-2">{{ Math.round((activity.metadata.confidence as number) * 100) }}%</span>
  </div>
  <div v-if="activity.metadata?.synthesisDate">
    <span class="text-muted-foreground">Дата извлечения:</span>
    <span class="ml-2">{{ activity.metadata.synthesisDate }}</span>
  </div>
  <div v-if="activity.metadata?.sourceQuote">
    <span class="text-muted-foreground">Цитата из источника:</span>
    <p class="mt-1 text-xs italic border-l-2 border-muted pl-2">
      {{ activity.metadata.sourceQuote }}
    </p>
  </div>
</div>
```

## Этап 3: Second Brain Extraction Service

**File:** `apps/pkg-core/src/modules/extraction/second-brain-extraction.service.ts`

Second Brain не извлекает проекты напрямую — он работает с событиями (tasks, commitments, meetings) из переписок. Эти события передаются в `DraftExtractionService`, который через `ProjectMatchingService` сопоставляет с существующими проектами.

**Ситуация:** `DraftExtractionService` использует `ProjectMatchingService.findBestMatch()` для сопоставления — это чисто Levenshtein по имени. Описание и теги не участвуют в matching.

**Изменения:**

**3.1** В `second-brain-extraction.service.ts`, функция `buildConversationSystemPrompt()` (lines 539-620):
Добавить в инструкции для извлечения задач и обязательств указание генерировать описание, чтобы создаваемые через DraftExtractionService Activity тоже имели описания:
```
Для каждой задачи и обязательства: добавь контекст в описание — зачем это нужно, в рамках чего.
```

**3.2** Проверить `CONVERSATION_EXTRACTION_SCHEMA` в `extraction.types.ts` — если task description не обязательный, сделать обязательным аналогично projects.

## Этап 4: Unified Extraction Service

**File:** `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts`

Unified extraction работает через Agent mode с MCP tools (`create_fact`, `create_event`, `create_relation`). Он **не создаёт Activity/проекты** напрямую — нет tool для этого.

**Изменения:**

**4.1** В `buildUnifiedPrompt()` (lines 256-377):
В инструкциях для `create_event` добавить указание включать описание контекста в поле `what`:
```
При создании событий (tasks, commitments) описывай подробно: не "сделать задачу", а "подготовить отчёт по метрикам производительности для клиента X в рамках проекта мониторинга".
```

**4.2** Если `create_event` tool имеет ограниченную длину поля `what` — рассмотреть добавление поля `description` к tool.

## Files to modify

| File | Этап | Что меняем |
|------|------|-----------|
| `daily-synthesis-extraction.types.ts` | 1 | `description` → required, улучшенное описание поля |
| `daily-synthesis-extraction.service.ts` | 1 | Промпт, loadExistingActivities, formatActivityContext |
| `pages/activities/index.vue` | 2 | Показать description в карточке списка |
| `pages/activities/[id].vue` | 2 | Показать extraction metadata в карточке «Метаданные» |
| `second-brain-extraction.service.ts` | 3 | Добавить описание в инструкции для tasks/commitments |
| `unified-extraction.service.ts` | 4 | Добавить описание контекста в create_event инструкции |

## Verification

1. `cd apps/pkg-core && npx jest --testPathPattern=daily-synthesis` — тесты Daily Synthesis
2. `cd apps/pkg-core && npx jest --testPathPattern=second-brain` — тесты Second Brain
3. `cd apps/dashboard && npx nuxi build` — компиляция dashboard
4. Вызвать extraction на реальном daily synthesis → description заполнен у каждого проекта
5. `/activities` → описания видны под названиями проектов
6. `/activities/:id` → metadata карточка показывает source, confidence, цитату
7. Повторный extraction → Claude матчит существующие проекты по описанию/тегам
