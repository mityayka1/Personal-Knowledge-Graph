# Extraction Quality Sprint — Design Document

> **Статус:** ✅ Approved
> **Дата:** 2026-02-21
> **Цель:** Устранить дубли задач/entities, привязать факты к проектам, очистить существующие дубли

---

## Проблема

Анализ production БД (730 activities, 324 entities, 1189 facts) выявил 6 корневых проблем:

| # | Проблема | Масштаб | Корневая причина |
|---|----------|---------|-----------------|
| 1 | Дубли задач между сессиями | 24+ пары | Cross-batch дедупликация проверяет только текущий batch |
| 2 | Ghost entities без идентификаторов | 126 (39%) | Упоминание имени → немедленное создание ACTIVE Entity |
| 3 | Дубли entities | 5x Пирекеева, 4x Адам | Exact name match, нет semantic matching |
| 4 | Факты без контекста проектов | 429 (36%) | create_fact не привязывает к Activity |
| 5 | Orphan задачи на root | 260 draft, ~12/день | DailySynthesis использует substring matching |
| 6 | create_fact минует approval | Все факты agent mode | Создаёт ACTIVE EntityFact напрямую |

---

## Решение: Unified Dedup Gateway + LLM

### Архитектура

```
Кандидат (entity/task/fact/commitment)
    ↓
┌─────────────────────────────────────────┐
│        DeduplicationGatewayService       │
├──────────────────────────────────────────┤
│                                          │
│  1. Normalize name                       │
│  2. Exact match → если да, DUPLICATE     │
│  3. Generate embedding                   │
│  4. pgvector cosine ≥ 0.5 → top-5       │
│  5. LLM Decision (Haiku) per candidate   │
│     - context: Activity, Entity rels     │
│     - { isDuplicate, confidence, merge } │
│  6. Action:                              │
│     ≥ 0.9 → auto-merge                  │
│     0.7-0.9 → PendingApproval           │
│     < 0.7 → create new                  │
│                                          │
└──────────────────────────────────────────┘
    ↓
DraftExtractionService / EntityService / etc.
```

### Ключевые принципы

1. **Без Levenshtein** — только semantic (embeddings + LLM). Levenshtein не понимает смысл.
2. **Exact match как shortcut** — нормализованные имена совпадают → сразу DUPLICATE (без LLM вызова)
3. **LLM с контекстом** — Haiku видит оба объекта + их Activity + связи → точное решение
4. **Единая точка** — ВСЕ extraction paths проходят через gateway
5. **Два режима** — real-time (при extraction) + batch (cron для существующих дублей)

---

## Решение по каждой проблеме

### Проблема #1: Дубли задач между сессиями

**Текущее:** `DraftExtractionService.checkTaskDuplicate()` проверяет Levenshtein + semantic только внутри текущего batch + pending approvals.

**Новое:**
- `checkTaskDuplicate()` → вызов `dedupGateway.checkTask(candidate)`
- Gateway ищет по ВСЕЙ БД: все активные tasks (status != archived/cancelled)
- Pre-filter: embedding cosine ≥ 0.5 (top-5 кандидатов)
- LLM Decision: "Задача X — это тоже самое что задача Y в контексте проекта Z?"
- При DUPLICATE → skip создание, вернуть существующий task ID
- При PROBABLE → создать PendingApproval с обоими вариантами

**Файлы:**
- `draft-extraction.service.ts` — заменить checkTaskDuplicate на gateway
- `dedup-gateway.service.ts` — новый

### Проблема #2: Ghost entities (126 без идентификаторов)

**Текущее:** `SecondBrainExtractionService.createExtractedEntity()` создаёт ACTIVE Entity при упоминании неизвестного имени.

**Новое:**
- `createExtractedEntity()` → вызов `dedupGateway.checkEntity(candidate)`
- Gateway: embedding + LLM с контекстом чата: "В чате про Панавто, 'Игорь' — это 'Игорь Куприков'?"
- При DUPLICATE → вернуть существующий entityId
- При NOT_DUPLICATE → создать Entity как DRAFT + PendingApproval для подтверждения

**Файлы:**
- `second-brain-extraction.service.ts` — refactor createExtractedEntity
- `extraction-tools.provider.ts` — refactor create_pending_entity

### Проблема #3: Дубли entities (5x Пирекеева)

**Текущее:** `create_pending_entity` ищет по exact name.

**Новое:**
- Та же логика gateway что и для #2
- Дополнительно: **batch cleanup cron** (ежедневно):
  1. Найти все пары entities с embedding cosine ≥ 0.6
  2. LLM решает: "Пирекеева (person, no identifiers) и Пирекеева Мария (person, telegram_id=123) — один человек?"
  3. Автомерж при confidence ≥ 0.9, PendingApproval при 0.7-0.9
- **Одноразовая очистка:** скрипт для существующих 5x Пирекеева, 4x Адам и т.д.

**Файлы:**
- `dedup-cleanup.job.ts` — новый cron
- `data-quality.service.ts` — расширение autoMerge

### Проблема #4: Факты без контекста проектов (36%)

**Текущее:** `create_fact` tool не принимает activityId.

**Новое:**
- Добавить параметр `activityId?: string` в `create_fact` tool schema
- В system prompt: "Если факт связан с проектом — укажи activityId. Используй find_activity для поиска."
- Gateway при создании факта без activityId: попробовать auto-match по entityId → найти Activity где этот entity — member
- **Batch fixup:** для существующих 429 фактов — LLM анализирует sourceQuote и привязывает к Activity

**Файлы:**
- `extraction-tools.provider.ts` — create_fact schema + prompt
- `dedup-gateway.service.ts` — auto-match logic

### Проблема #5: Orphan задачи на root (~12/день)

**Текущее:** `DailySynthesisExtractionService.matchProjectsToActivities()` — substring matching.

**Новое:**
- `matchProjectsToActivities()` → embedding + LLM matching (через gateway)
- Расширить `create_event` tool: prompt обязывает указать projectName
- Gateway при создании task без parentId: LLM матчинг с активными проектами по embedding + контексту
- **Batch orphan assignment cron:** ежедневно для новых orphans

**Файлы:**
- `daily-synthesis-extraction.service.ts` — refactor matchProjectsToActivities
- `extraction-tools.provider.ts` — update create_event prompt
- `orphan-assignment.job.ts` — новый cron

### Проблема #6: create_fact минует approval

**Текущее:** `create_fact` в ExtractionToolsProvider создаёт ACTIVE EntityFact напрямую.

**Новое:**
- Рефакторить `create_fact` → создавать через `DraftExtractionService.createDrafts()` вместо прямого `entityFactService.create()`
- Это автоматически даёт: PendingApproval, carousel в Telegram, consistency с другими paths
- **Альтернатива:** Если approval замедляет agent mode слишком сильно — оставить прямое создание, но добавить post-factum review cron

**Решение:** Переключить на DraftExtractionService. Факты из agent mode — не более срочные чем из других paths, могут подождать подтверждения.

**Файлы:**
- `extraction-tools.provider.ts` — refactor create_fact handler

---

## Новые компоненты

### 1. DeduplicationGatewayService

```typescript
@Injectable()
export class DeduplicationGatewayService {
  // Единая точка дедупликации
  async checkTask(candidate: TaskCandidate): Promise<DedupDecision>;
  async checkEntity(candidate: EntityCandidate): Promise<DedupDecision>;
  async checkFact(candidate: FactCandidate): Promise<DedupDecision>;
  async checkCommitment(candidate: CommitmentCandidate): Promise<DedupDecision>;

  // Общий алгоритм:
  // 1. Normalize name
  // 2. Exact match → DUPLICATE
  // 3. Generate embedding
  // 4. pgvector cosine ≥ 0.5 → top-5 candidates
  // 5. LLM decision per candidate
  // 6. Return decision: CREATE | MERGE | PENDING_APPROVAL
}
```

**Файл:** `apps/pkg-core/src/modules/extraction/dedup-gateway.service.ts`
**Module:** ExtractionModule

### 2. LlmDedupService

```typescript
@Injectable()
export class LlmDedupService {
  // Обёртка над Claude Haiku для dedup decisions
  async decideDuplicate(params: {
    newItem: { type: string; name: string; description?: string; context?: string };
    existingItem: { id: string; type: string; name: string; description?: string };
    activityContext?: string;
  }): Promise<{
    isDuplicate: boolean;
    confidence: number;
    mergeIntoId: string | null;
    reason: string;
  }>;

  // Batch: group of candidates
  async decideDuplicateBatch(pairs: DedupPair[]): Promise<DedupDecision[]>;
}
```

**Файл:** `apps/pkg-core/src/modules/extraction/llm-dedup.service.ts`
**Использует:** ClaudeAgentService с model: 'haiku', outputFormat: json_schema

### 3. DedupBatchCleanupJob

```typescript
@Injectable()
export class DedupBatchCleanupJob {
  // Ежедневный cron: поиск дублей среди существующих записей
  @Cron('0 3 * * *') // 3:00 AM
  async run(): Promise<void>;

  // 1. Entity dedup: embedding cosine ≥ 0.6 → LLM → merge/approve
  private async cleanupEntityDuplicates(): Promise<void>;

  // 2. Task dedup: embedding cosine ≥ 0.6 → LLM → merge/skip
  private async cleanupTaskDuplicates(): Promise<void>;

  // 3. Orphan assignment: tasks без parentId → LLM match с проектами
  private async assignOrphanTasks(): Promise<void>;

  // 4. Fact context: факты без activityId → LLM → привязка
  private async linkFactsToActivities(): Promise<void>;
}
```

**Файл:** `apps/pkg-core/src/modules/extraction/dedup-batch-cleanup.job.ts`
**Module:** ExtractionModule

---

## Стоимость LLM вызовов

| Операция | Частота | Кандидатов | Вызовов/день | Стоимость |
|----------|---------|------------|--------------|-----------|
| Task dedup (real-time) | ~16 tasks/день | ~3 каждый | ~48 | ~$0.05 |
| Entity dedup (real-time) | ~10 entities/день | ~3 каждый | ~30 | ~$0.03 |
| Fact dedup (real-time) | ~20 facts/день | ~2 каждый | ~40 | ~$0.04 |
| Batch cleanup (cron) | 1/день | ~50 пар | ~50 | ~$0.05 |
| Orphan assignment (cron) | 1/день | ~12 orphans × 5 projects | ~60 | ~$0.06 |
| **Итого** | | | **~228** | **~$0.23/день** |

Haiku: ~$0.001 per 1K input tokens, ~$0.005 per 1K output. Средний dedup prompt ~500 tokens = ~$0.001/вызов.

---

## Порядок реализации

| Шаг | Что | Зависимости | Время |
|-----|-----|-------------|-------|
| 1 | LlmDedupService | - | 1 день |
| 2 | DeduplicationGatewayService | Шаг 1 | 2 дня |
| 3 | Интеграция: DraftExtraction, SecondBrain, ExtractionTools | Шаг 2 | 2 дня |
| 4 | Фиксы: activityId в create_fact, substring→gateway (#4, #5) | Шаг 2 | 1 день |
| 5 | create_fact → DraftExtractionService (#6) | Шаг 3 | 0.5 дня |
| 6 | DedupBatchCleanupJob (cron) | Шаг 2 | 1 день |
| 7 | Одноразовая очистка существующих дублей | Шаг 6 | 0.5 дня |
| 8 | Тесты | Все | 1 день |
| **Итого** | | | **~9 дней** |

---

## Файлы для изменения/создания

| Файл | Действие | Описание |
|------|----------|----------|
| `extraction/dedup-gateway.service.ts` | **Новый** | Unified Dedup Gateway |
| `extraction/llm-dedup.service.ts` | **Новый** | LLM wrapper для dedup decisions |
| `extraction/dedup-batch-cleanup.job.ts` | **Новый** | Ежедневный cron cleanup |
| `extraction/draft-extraction.service.ts` | Изменение | Замена checkTaskDuplicate на gateway |
| `extraction/second-brain-extraction.service.ts` | Изменение | Refactor createExtractedEntity |
| `extraction/tools/extraction-tools.provider.ts` | Изменение | create_fact→drafts, activityId param, create_pending_entity→gateway |
| `extraction/daily-synthesis-extraction.service.ts` | Изменение | matchProjectsToActivities→gateway |
| `extraction/extraction.module.ts` | Изменение | Register new services |

---

## Метрики успеха

| Метрика | Текущее | Цель |
|---------|---------|------|
| Дубли задач (пары similarity >0.7) | 24+ | < 3 |
| Ghost entities (без идентификаторов) | 126 | < 20 |
| Дубли entities (группы >1) | ~15 групп | < 3 |
| Факты без activityId | 429 (36%) | < 100 (8%) |
| Orphan задачи (root, draft) | 260, +12/день | < 50, +2/день |
| create_fact без approval | 100% agent mode | 0% |

---

## Риски

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| LLM hallucination (ложный merge) | Низкая | Confidence threshold 0.9 для автомержа, PendingApproval для grey zone |
| Latency увеличение extraction | Средняя | Haiku ~0.5s, параллельные вызовы для batch |
| Стоимость LLM | Низкая | ~$0.23/день, ceiling ~$1/день при пиках |
| Embedding unavailable | Низкая | Fallback на exact match only (skip semantic) |
| Batch cleanup мержит неправильно | Низкая | Dry-run mode, логирование всех решений, undo через DataQuality |
