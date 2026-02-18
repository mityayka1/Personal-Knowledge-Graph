# LLM-Agent Fact Deduplication Review

> **Статус:** ✅ Completed — Phase D.5 Data Quality Remediation

## Context

Текущая семантическая дедупликация фактов использует единственный порог pgvector cosine similarity (0.70). Факты с similarity ≥ 0.70 автоматически пропускаются, ниже — создаются. Проблема: короткие сокращённые факты ("ДР 15 марта 85го" vs "родился 15 марта 1985 года") имеют similarity 0.39-0.59, ниже порога, и создаются как дубликаты.

**Решение:** Добавить "серую зону" (similarity 0.40-0.70), где факты отправляются LLM-агенту на ревью. Агент видит контекст сущности + все существующие факты + новых кандидатов и принимает решение: дубликат или новый.

## Архитектура

```
Новый поток:
  pgvector query с НИЗКИМ порогом (0.40)
  ├─ similarity ≥ 0.70        → auto-skip (без изменений)
  ├─ similarity 0.40-0.70     → review (серая зона → LLM-агент)
  └─ similarity < 0.40        → create (явно разные)

  DraftExtractionService.createDrafts():
    Pass 1: checkDuplicateHybrid() для каждого факта
      → auto-skip, create, или review
    Pass 2: batch LLM review для всех 'review' кандидатов
      → группировка по entityId
      → загрузка контекста entity + все существующие факты
      → один вызов Claude (oneshot) на группу
      → structured output с решениями
    Pass 3: обработка решений → skip или create
```

## Шаги реализации

### Step 1: Настройки (settings.service.ts)
- Добавить `dedup.reviewThreshold` (default: 0.40) в DEFAULT_SETTINGS
- Добавить `dedup.reviewModel` (default: 'haiku') в DEFAULT_SETTINGS
- **Файл:** `apps/pkg-core/src/modules/settings/settings.service.ts`

### Step 2: Расширить DeduplicationResult (fact-deduplication.service.ts)
- Добавить `'review'` в action union type
- Добавить `similarity?: number` в интерфейс
- Модифицировать `checkSemanticDuplicate()`:
  - Новый параметр `reviewThreshold?: number`
  - SQL query использует `reviewThreshold` (0.40) вместо 0.70
  - similarity ≥ 0.70 → skip, similarity 0.40-0.70 → review
- Модифицировать `checkDuplicateHybrid()` — прокинуть `reviewThreshold`
- **Файл:** `apps/pkg-core/src/modules/extraction/fact-deduplication.service.ts`

### Step 3: Добавить `fact_dedup_review` task type
- Добавить в `ClaudeTaskType` union
- Добавить system prompt в `buildAgentSystemPrompt()`
- **Файлы:** `apps/pkg-core/src/modules/claude-agent/claude-agent.types.ts`, `claude-agent.service.ts`

### Step 4: Создать FactDedupReviewService (НОВЫЙ файл)
- `reviewBatch(candidates)` — группировка по entity, вызов LLM
- `reviewEntityGroup(entityId, group, model)` — загрузка контекста + oneshot call
- `buildReviewPrompt(...)` — промпт с контекстом entity, существующими фактами, кандидатами
- JSON Schema для structured output (decisions: [{newFactIndex, action, reason}])
- Graceful degradation: если Claude недоступен → все candidates → create
- **Новый файл:** `apps/pkg-core/src/modules/extraction/fact-dedup-review.service.ts`
- **Зависимости:** EntityFact repo, EntityRecord repo, @Optional() ClaudeAgentService, SettingsService

### Step 5: Интегрировать в DraftExtractionService
- Inject: `FactDedupReviewService`, `SettingsService`
- Двухпроходная обработка фактов:
  1. checkDuplicateHybrid() для всех фактов → собрать review candidates
  2. reviewBatch() для review candidates → получить решения
  3. Обработать все результаты: skip или createDraftFact()
- **Файл:** `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts`

### Step 6: Регистрация в ExtractionModule
- Добавить `FactDedupReviewService` в providers и exports
- **Файл:** `apps/pkg-core/src/modules/extraction/extraction.module.ts`

### Step 7: Тесты
- **Новый:** `fact-dedup-review.service.spec.ts` — 8+ тестов (empty batch, graceful degradation, LLM skip/create, grouping, error handling, prompt construction)
- **Обновить:** `fact-deduplication.service.spec.ts` — тесты на 'review' action, reviewThreshold parameter
- **Обновить:** `draft-extraction.service.spec.ts` — тесты на двухпроходную обработку с LLM review

## Ключевые файлы

| Файл | Действие |
|------|----------|
| `apps/pkg-core/src/modules/settings/settings.service.ts` | Добавить 2 настройки |
| `apps/pkg-core/src/modules/extraction/fact-deduplication.service.ts` | review action + reviewThreshold |
| `apps/pkg-core/src/modules/claude-agent/claude-agent.types.ts` | Новый task type |
| `apps/pkg-core/src/modules/claude-agent/claude-agent.service.ts` | System prompt для task type |
| `apps/pkg-core/src/modules/extraction/fact-dedup-review.service.ts` | **НОВЫЙ** — LLM review service |
| `apps/pkg-core/src/modules/extraction/draft-extraction.service.ts` | Двухпроходная обработка |
| `apps/pkg-core/src/modules/extraction/extraction.module.ts` | Регистрация сервиса |
| `apps/pkg-core/src/modules/extraction/fact-dedup-review.service.spec.ts` | **НОВЫЙ** — тесты |
| `apps/pkg-core/src/modules/extraction/fact-deduplication.service.spec.ts` | Обновить тесты |
| `apps/pkg-core/src/modules/extraction/draft-extraction.service.spec.ts` | Обновить тесты |

## Верификация

1. `pnpm --filter @pkg/pkg-core test -- --testPathPattern="fact-dedup"` — все dedup тесты
2. `pnpm --filter @pkg/pkg-core test -- --testPathPattern="draft-extraction"` — draft extraction тесты
3. `pnpm --filter @pkg/pkg-core build` — компиляция без ошибок
4. Deploy на production + проверка логов: `grep -i "LLM review" pkg-core logs`
5. Проверка через MCP DB: новые факты с embedding, без дубликатов в серой зоне
