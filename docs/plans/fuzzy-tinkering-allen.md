# Plan: Превентивное качество данных в Extraction Pipeline

## Context

После успешной реализации `EventCleanupService` (Phase A/B/C) стало очевидно, что лучше предотвращать проблемы при извлечении, чем исправлять их постфактум. Анализ pipeline выявил 4 ключевых gap:

1. **Commitment dedup** — проекты и задачи имеют fuzzy Levenshtein дедупликацию, а commitments — только ILIKE (самый слабый фильтр)
2. **Noise в unified extraction** — create_event tool не фильтрует шум, в отличие от daily synthesis
3. **Events не линкуются с Activities** — unified extraction не загружает контекст активностей, поэтому 0 events привязаны к Activity при создании
4. **Project dedup** — при совпадении клиента порог можно снизить для более агрессивного мержа

## Область 1: Noise Reduction — Shared Constants + Tool-Level Filtering

### Проблема
`VAGUE_PATTERNS` определены только в `daily-synthesis-extraction.service.ts` (строки 32-44). Unified extraction path (`create_event` tool) создаёт шумовые события без фильтрации.

### Решение

**Новый файл:** `apps/pkg-core/src/modules/extraction/extraction-quality.constants.ts`

```typescript
// Перенести из daily-synthesis-extraction.service.ts:
export const VAGUE_PATTERNS: RegExp[] = [
  /(?<!\p{L})что[-\s]?то(?!\p{L})/iu,
  /(?<!\p{L})кое[-\s]?что(?!\p{L})/iu,
  // ... все 11 паттернов
];

// Добавить новые:
export const NOISE_PATTERNS: RegExp[] = [
  /подтвержд/iu,           // "Подтверждение использования инструмента..."
  /инструмент\w*/iu,        // техническая лексика Claude
  /использован/iu,
];

export const MIN_MEANINGFUL_LENGTH = 15;

export function isVagueContent(text: string): boolean { ... }
export function isNoiseContent(text: string): boolean { ... }
```

**Модифицировать:** `extraction-tools.provider.ts` — в `createEventTool()` handler (строки ~537-717):
- Добавить вызов `isVagueContent(what)` и `isNoiseContent(what)` перед созданием через `DraftExtractionService`
- Вернуть `toolError('Content is too vague...')` если шум — Claude научится не создавать такие события

**Модифицировать:** `daily-synthesis-extraction.service.ts` — заменить локальные `VAGUE_PATTERNS` на импорт из shared constants

### Файлы

| Файл | Действие |
|------|----------|
| `extraction-quality.constants.ts` | **Создать** — shared constants + helper functions |
| `extraction-tools.provider.ts` | **Изменить** — добавить noise filter в `createEventTool()` handler |
| `daily-synthesis-extraction.service.ts` | **Изменить** — импорт из shared constants |

## Область 2: Commitment Fuzzy Dedup

### Проблема
`DraftExtractionService.findExistingPendingCommitment()` (строки 974-996) использует ТОЛЬКО `ILIKE` по `what`:
```sql
WHERE LOWER(c.what) LIKE :pattern AND c.status IN ('pending','confirmed')
```
А `findExistingProjectEnhanced()` и `findExistingTaskEnhanced()` имеют двухуровневую проверку: ILIKE + Levenshtein fuzzy matching.

### Решение

**Модифицировать:** `draft-extraction.service.ts` — заменить `findExistingPendingCommitment()` на `findExistingCommitmentEnhanced()`:

```typescript
private async findExistingCommitmentEnhanced(
  what: string,
  entityId: string,
  type?: string,
): Promise<{ commitment: any; similarity: number } | null> {
  // 1. Pending ILIKE (как сейчас)
  const pending = await this.findExistingPendingCommitment(what, entityId);
  if (pending) return { commitment: pending, similarity: 1.0 };

  // 2. Fuzzy Levenshtein по active commitments (как findExistingTaskEnhanced)
  const normalized = this.projectMatchingService.normalizeName(what);
  const candidates = await this.commitmentRepo.find({
    where: {
      entityId,
      status: In(['pending', 'confirmed']),
    },
    take: 50,
  });

  let bestMatch = null;
  let bestSimilarity = 0;
  for (const c of candidates) {
    const sim = this.projectMatchingService.calculateSimilarity(
      normalized,
      this.projectMatchingService.normalizeName(c.what),
    );
    if (sim > bestSimilarity) {
      bestSimilarity = sim;
      bestMatch = c;
    }
  }

  const COMMITMENT_DEDUP_THRESHOLD = 0.7;
  if (bestMatch && bestSimilarity >= COMMITMENT_DEDUP_THRESHOLD) {
    return { commitment: bestMatch, similarity: bestSimilarity };
  }

  return null;
}
```

**Использовать** в `createDrafts()` при создании commitments — если найден fuzzy match, пропустить создание.

### Файлы

| Файл | Действие |
|------|----------|
| `draft-extraction.service.ts` | **Изменить** — добавить `findExistingCommitmentEnhanced()`, обновить `createDrafts()` |

## Область 3: Auto-Link Events → Activities при создании

### Проблема
`UnifiedExtractionService.buildUnifiedPrompt()` (строка 256) НЕ загружает контекст существующих активностей. В отличие от `DailySynthesisExtractionService`, который вызывает `loadExistingActivities()` и передаёт их в prompt.

`create_event` tool (строки 537-717 в `extraction-tools.provider.ts`) не имеет параметров `activityId`/`projectName` — Claude не может указать, к какой активности относится событие.

### Решение

**Шаг A — Загрузка контекста активностей в unified extraction:**

**Модифицировать:** `unified-extraction.service.ts` — в методе `extract()`:
```typescript
// Добавить после загрузки relationsContext:
const activitiesContext = await this.loadActivitiesContext();
```

И передать `activitiesContext` в `buildUnifiedPrompt()` → добавить новую секцию `§ АКТИВНОСТИ` в prompt:
```
══════════════════════════════════════════
§ АКТИВНОСТИ — существующие проекты и задачи
══════════════════════════════════════════
Если событие (task/promise) относится к существующей активности, укажи activityId в create_event.
${activitiesContext}
```

**Шаг B — Добавить параметры в create_event tool:**

**Модифицировать:** `extraction-tools.provider.ts` — в `createEventTool()`:
```typescript
// Добавить в schema:
activityId: z.string().uuid().optional().describe('UUID активности, если событие относится к существующему проекту/задаче'),
projectName: z.string().optional().describe('Имя проекта, если не найден activityId - для fuzzy match'),
```

В handler: если `activityId` передан, создать `Commitment` с этим `activityId` через `DraftExtractionService`. Если передан `projectName`, использовать `findExistingProjectEnhanced()` для поиска.

### Файлы

| Файл | Действие |
|------|----------|
| `unified-extraction.service.ts` | **Изменить** — загрузка активностей, новая секция в prompt |
| `extraction-tools.provider.ts` | **Изменить** — добавить `activityId`/`projectName` в create_event schema + handler |

## Область 4: Project Dedup Enhancement — Client Boost

### Проблема
`findExistingProjectEnhanced()` использует фиксированный `STRONG_MATCH_THRESHOLD = 0.8`. Но если клиент совпадает, вероятность дубля намного выше и порог можно снизить.

### Решение

**Модифицировать:** `draft-extraction.service.ts` — в `findExistingProjectEnhanced()`:
```typescript
const effectiveStrongThreshold = clientMatches
  ? STRONG_MATCH_THRESHOLD - 0.1  // 0.7 при совпадении клиента
  : STRONG_MATCH_THRESHOLD;        // 0.8 по умолчанию
```

Это минимальное изменение, которое значительно улучшит dedup проектов с одинаковым клиентом.

### Файлы

| Файл | Действие |
|------|----------|
| `draft-extraction.service.ts` | **Изменить** — добавить client boost в `findExistingProjectEnhanced()` |

## Порядок реализации

| # | Область | Сложность | Зависимости |
|---|---------|-----------|-------------|
| 1 | Noise Reduction (shared constants + tool filter) | Низкая | Нет |
| 2 | Commitment Fuzzy Dedup | Средняя | Нет |
| 3 | Auto-Link Events → Activities | Средняя | #1 (tool changes) |
| 4 | Project Client Boost | Низкая | Нет |

## Итого: файлы

| Файл | Области |
|------|---------|
| `extraction-quality.constants.ts` | **Создать** (#1) |
| `extraction-tools.provider.ts` | **Изменить** (#1, #3) |
| `daily-synthesis-extraction.service.ts` | **Изменить** (#1) |
| `draft-extraction.service.ts` | **Изменить** (#2, #4) |
| `unified-extraction.service.ts` | **Изменить** (#3) |

## Verification

1. `cd apps/pkg-core && npx tsc --noEmit` — компиляция без ошибок
2. Запустить unified extraction на тестовом interaction — проверить:
   - Шумовые события отклоняются с toolError
   - Дубли commitments не создаются (fuzzy match)
   - События привязываются к существующим Activity через activityId
3. Запустить daily synthesis — проверить что shared constants работают корректно
4. Проверить на production через `/extracted-events/auto-cleanup?phases=dedup&dryRun=true` — количество дублей должно уменьшиться после накопления новых данных
