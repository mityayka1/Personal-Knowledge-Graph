---
title: "Preventive Data Quality in Extraction Pipeline"
date: 2026-02-15
category: integration-issues
severity: medium
component: extraction-pipeline
tags:
  - extraction
  - data-quality
  - deduplication
  - noise-filtering
  - shift-left
symptoms:
  - Шумовые события (вагальные фразы, техническая лексика Claude) попадают в pending approvals
  - Дубликаты commitments создаются повторно из-за отсутствия fuzzy dedup
  - Events из unified extraction не привязаны к существующим Activities
  - Проекты с одинаковым клиентом дублируются при пороге 0.8
root_cause: >
  Extraction pipeline имел четыре gap'а между двумя путями извлечения (Daily Synthesis и Unified).
  Daily Synthesis имел фильтрацию шума, но Unified — нет. Commitments имели только ILIKE dedup
  (слабейший фильтр), в отличие от Projects/Tasks с Levenshtein. Unified extraction не загружал
  контекст активностей, поэтому Claude не мог привязать события к проектам.
resolution: >
  Shift-left подход: 4 области улучшений — shared noise constants + tool-level filtering,
  commitment fuzzy dedup (Levenshtein 0.7), auto-link events→activities через контекст в промпте,
  client boost (снижение порога с 0.8 до 0.7 при совпадении клиента).
related_issues: []
---

# Preventive Data Quality in Extraction Pipeline

## Проблема

После реализации `EventCleanupService` (Phase A/B/C для постфактум очистки) стало очевидно, что **лучше предотвращать проблемы при извлечении, чем исправлять их постфактум**.

Анализ extraction pipeline выявил 4 ключевых gap'а:

| # | Gap | Влияние |
|---|-----|---------|
| 1 | **Noise в unified extraction** — `create_event` tool не фильтрует шум | Шумовые события попадают в pending approvals |
| 2 | **Commitment dedup** — только ILIKE, нет fuzzy matching | Дубликаты commitments при переформулировке |
| 3 | **Events не линкуются с Activities** — unified extraction не знает о проектах | 0 events привязаны к Activity при создании |
| 4 | **Project dedup threshold** — фиксированный 0.8 без учёта клиента | Проекты одного клиента дублируются |

### Два пути извлечения

```
Daily Synthesis:
  DailySynthesisExtractionService → DraftExtractionService.createDrafts()
  ✅ Имел фильтрацию шума (VAGUE_PATTERNS), загружал активности

Unified Extraction:
  UnifiedExtractionService → Agent вызывает create_event MCP tool → DraftExtractionService.createDrafts()
  ❌ НЕ имел фильтрации шума, НЕ загружал контекст активностей
```

## Root Cause Analysis

### Gap 1: Noise Filtering (одностороннее)

`VAGUE_PATTERNS` были определены **только** в `daily-synthesis-extraction.service.ts`. Unified extraction path (`create_event` tool в `extraction-tools.provider.ts`) создавал события без какой-либо фильтрации.

Примеры шумовых событий, проникавших в систему:
- "Подтверждение использования инструмента" (техническая лексика Claude)
- "Что-то сделать" (вагальные фразы без контекста)
- "Ок" (слишком короткий контент < 15 символов)

### Gap 2: Commitment Dedup (только ILIKE)

`DraftExtractionService.findExistingPendingCommitment()` использовал **только** `ILIKE` по полю `what`:

```sql
WHERE LOWER(c.title) ILIKE :pattern AND c.status IN ('pending')
```

В то время как `findExistingProjectEnhanced()` и `findExistingTaskEnhanced()` имели двухуровневую проверку: ILIKE + Levenshtein fuzzy matching. Commitments были единственной сущностью без fuzzy dedup.

### Gap 3: Missing Activity Context

`UnifiedExtractionService.buildUnifiedPrompt()` **не загружал** контекст существующих активностей. Claude не знал о проектах и задачах, поэтому не мог указать `activityId` при создании событий.

### Gap 4: Fixed Project Threshold

`findExistingProjectEnhanced()` использовал фиксированный `STRONG_MATCH_THRESHOLD = 0.8`. Но если клиент совпадает, вероятность дубля значительно выше — порог можно безопасно снизить.

## Решение

### Область 1: Shared Noise Constants + Tool-Level Filtering

**Новый файл:** `extraction-quality.constants.ts`

Вынесены из `daily-synthesis-extraction.service.ts` в shared модуль:

```typescript
// extraction-quality.constants.ts
export const VAGUE_PATTERNS: RegExp[] = [
  /(?<!\p{L})что[-\s]?то(?!\p{L})/iu,
  /(?<!\p{L})кое[-\s]?что(?!\p{L})/iu,
  // ... всего 11 паттернов для Cyrillic vague words
];

export const NOISE_PATTERNS: RegExp[] = [
  /подтвержд\w*\s+(использовани|инструмент)/iu,
  /использовани\w*\s+инструмент/iu,
  /тестов\w*\s+(запуск|прогон|сообщени)/iu,
  /отправ\w*\s+тестов/iu,
];

export const MIN_MEANINGFUL_LENGTH = 15;

export function isVagueContent(text: string): boolean { ... }
export function isNoiseContent(text: string): boolean { ... }
```

**Ключевая деталь:** `\b` (word boundary) не работает с кириллицей в JavaScript — используются Unicode-aware lookbehind/lookahead: `(?<!\p{L})` и `(?!\p{L})`.

**Tool-level filtering** в `extraction-tools.provider.ts`, handler `createEventTool()`:

```typescript
// Noise / vague content filter
const contentToCheck = args.title + (args.description ? ' ' + args.description : '');
if (isNoiseContent(contentToCheck)) {
  return toolError(
    'Event content is too short or technical noise',
    'Skip this event — it does not carry actionable real-world information.',
  );
}
if (isVagueContent(args.title) && !args.date) {
  return toolError(
    'Event title is too vague without a date anchor',
    'Rephrase with specifics (who, what, when) or skip.',
  );
}
```

**Почему `toolError()` вместо молчаливого пропуска?** `toolError()` — это in-context learning для Claude Agent SDK. Когда Claude получает ошибку инструмента, он учится не создавать подобные события в рамках текущей сессии. Это значительно эффективнее, чем постфактум очистка.

### Область 2: Commitment Fuzzy Dedup

Новый метод `findExistingCommitmentEnhanced()` по образцу `findExistingTaskEnhanced()`:

```typescript
private async findExistingCommitmentEnhanced(
  what: string,
  entityId?: string,
): Promise<{ found: boolean; commitmentId?: string; similarity?: number; source?: string }> {
  // Step 1: Pending ILIKE (существующая точная логика)
  const pendingMatch = await this.findExistingPendingCommitment(what);
  if (pendingMatch) return { found: true, commitmentId: pendingMatch.targetId, source: 'pending_approval' };

  // Step 2: Fuzzy Levenshtein против активных commitments
  const candidates = await this.commitmentRepo.find({
    where: { status: In([CommitmentStatus.PENDING, CommitmentStatus.IN_PROGRESS]) },
    select: ['id', 'title'],
    take: 100,
  });

  const normalizedWhat = ProjectMatchingService.normalizeName(what);
  for (const c of candidates) {
    const similarity = this.projectMatchingService.calculateSimilarity(
      normalizedWhat,
      ProjectMatchingService.normalizeName(c.title),
    );
    if (similarity >= COMMITMENT_DEDUP_THRESHOLD) { // 0.7
      return { found: true, commitmentId: c.id, similarity, source: 'fuzzy_match' };
    }
  }
  return { found: false };
}
```

**Порог 0.7** — аналогичен Task dedup threshold, обеспечивает баланс между дедупликацией и ложными срабатываниями.

### Область 3: Auto-Link Events → Activities

**Шаг A — Контекст активностей в unified extraction:**

Новый метод `buildActivitiesContext()` в `UnifiedExtractionService`:

```typescript
private async buildActivitiesContext(): Promise<string> {
  const activities = await this.activityRepo
    .createQueryBuilder('a')
    .select(['a.id', 'a.name', 'a.activityType', 'a.status', 'a.description', 'a.tags'])
    .leftJoin('a.clientEntity', 'client')
    .addSelect(['client.name'])
    .where('a.status NOT IN (:...excludedStatuses)', {
      excludedStatuses: [ActivityStatus.ARCHIVED, ActivityStatus.CANCELLED],
    })
    .orderBy('a.updatedAt', 'DESC')
    .limit(100)
    .getMany();

  // Группировка по типу: PROJECT, TASK, AREA, BUSINESS
  const grouped: Record<string, Activity[]> = {};
  // ... форматирование с клиентом и тегами
}
```

Новая секция `§ АКТИВНОСТИ` в промпте:

```
══════════════════════════════════════════
§ АКТИВНОСТИ — существующие проекты и задачи
══════════════════════════════════════════
Если событие (task/promise) относится к существующей активности, укажи activityId в create_event.
Если точный activityId неизвестен, укажи projectName — система найдёт ближайшее совпадение.
```

**Шаг B — Новые параметры в `create_event` tool:**

```typescript
activityId: z.string().uuid().optional()
  .describe('UUID существующей активности, если событие к ней относится. Берётся из секции АКТИВНОСТИ.'),
projectName: z.string().optional()
  .describe('Имя проекта, если activityId неизвестен — система найдёт ближайшее совпадение через fuzzy match'),
```

В handler: `projectName` пробрасывается в `DraftExtractionService.createDrafts()`, где `findExistingProjectEnhanced()` ищет fuzzy match через `ProjectMatchingService`.

### Область 4: Project Client Boost

В `findExistingProjectEnhanced()` добавлен client boost:

```typescript
let effectiveStrongThreshold = STRONG_MATCH_THRESHOLD; // 0.8

if (clientName && matchResult.activity.clientEntityId) {
  const clientEntity = await this.entityRepo.findOne({
    where: { id: matchResult.activity.clientEntityId },
    select: ['id', 'name'],
  });
  if (clientEntity) {
    const clientSimilarity = this.projectMatchingService.calculateSimilarity(
      ProjectMatchingService.normalizeName(clientName),
      ProjectMatchingService.normalizeName(clientEntity.name),
    );
    if (clientSimilarity >= 0.7) {
      effectiveStrongThreshold = STRONG_MATCH_THRESHOLD - 0.1; // 0.7
    }
  }
}
```

**Логика:** Если кандидат-проект имеет `clientEntityId`, загружается имя клиента из Entity. Сравнение через Levenshtein (>= 0.7) учитывает различия в написании ("Панавто" vs "Ассистент Панавто"). При совпадении клиента порог strong match снижается с 0.8 до 0.7.

## Изменённые файлы

| Файл | Действие | Область |
|------|----------|---------|
| `extraction-quality.constants.ts` | Создан | #1 — Shared noise constants |
| `extraction-tools.provider.ts` | Изменён | #1 — Tool-level noise filter, #3 — activityId/projectName params |
| `daily-synthesis-extraction.service.ts` | Изменён | #1 — Import shared constants |
| `draft-extraction.service.ts` | Изменён | #2 — Commitment fuzzy dedup, #4 — Client boost |
| `unified-extraction.service.ts` | Изменён | #3 — Activities context in prompt |

## Verification

### Production тест (2026-02-15)

**Первый запуск** — синтетический текст с шумом и вагальными фразами:
- 2 проекта, 1 задача, 1 commitment создано
- Шумовые фразы ("подтверждение использования инструмента") отфильтрованы
- Клиент "Панавто" автоматически resolved к entity "Ассистент Панавто"

**Второй запуск** — тот же текст повторно:
- 0 создано, 2 пропущено как дубликаты
- Fuzzy dedup работает для projects и commitments

### TypeScript compilation
```bash
cd apps/pkg-core && npx tsc --noEmit  # ✅ No errors
```

## Стратегии предотвращения

### 1. Pattern Management

При добавлении новых VAGUE/NOISE паттернов:
- Добавлять **только** в `extraction-quality.constants.ts` (single source of truth)
- Использовать Unicode-aware boundaries `(?<!\p{L})` / `(?!\p{L})` вместо `\b` для кириллицы
- Compound паттерны (>1 слово) предпочтительнее одиночных слов для снижения false positives

### 2. Threshold Tuning

| Сущность | Threshold | Обоснование |
|----------|-----------|-------------|
| Project strong match | 0.8 (0.7 с client boost) | Строгий по умолчанию, гибкий при контексте |
| Project weak match | 0.6 | Сохранить для metadata флагов |
| Task dedup | 0.7 | Баланс precision/recall |
| Commitment dedup | 0.7 | Аналогично Task |
| Client name match | 0.7 | Учитывает вариации написания |

### 3. Context Injection Best Practices

- `buildActivitiesContext()` загружает top 100 активностей, отсортированных по `updatedAt DESC`
- Группировка по типу (PROJECT, TASK, AREA) для structured prompt
- Включение client name и tags для контекста
- Лимит 15 элементов на тип для контроля размера промпта

### 4. In-Context Learning через toolError()

Паттерн из Claude Agent SDK:
```
toolError() + actionable message → Claude адаптируется в текущей сессии
```

Каждое сообщение об ошибке должно **подсказывать как исправить**:
- "Skip this event — it does not carry actionable real-world information"
- "Rephrase with specifics (who, what, when) or skip"

## Cross-References

- [docs/plans/fuzzy-tinkering-allen.md](../../plans/fuzzy-tinkering-allen.md) — исходный план реализации
- [docs/plans/proud-prancing-squid.md](../../plans/proud-prancing-squid.md) — Phase 5 Data Quality Remediation
- [docs/second-brain/05-JARVIS-FOUNDATION.md](../../second-brain/05-JARVIS-FOUNDATION.md) — Jarvis Foundation (Phase D)
- [docs/solutions/integration-issues/data-source-mismatch-prevention.md](data-source-mismatch-prevention.md) — Prevention patterns
