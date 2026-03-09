# Knowledge System Redesign — Design Document

> **Дата:** 2026-03-09
> **Статус:** Утверждён
> **Контекст:** Production аудит показал критические пробелы: 100% orphan segments, мёртвый KnowledgePacking pipeline, отсутствие confidence decay и graph-aware retrieval.

## Проблема

PKG Knowledge System реализован архитектурно (entities, services, cron jobs), но **не работает в production**:

| Метрика | Ожидание | Реальность |
|---------|----------|-----------|
| Segments привязаны к Activity | >80% | **0%** (1804/1804 orphans) |
| KnowledgePacks | Десятки | **2** (обе period-type) |
| Confidence decay | Старые факты менее релевантны | **Нет** (факт 2 года назад = вчерашний) |
| Graph retrieval | Обход связей между entities | **0** graph traversals (6 независимых SQL) |
| Entities с фактами | >80% | **27%** (73% без единого факта) |

**Root cause:** OrphanSegmentLinker использует Levenshtein ≥0.8 для matching topic↔activity name. Это слишком строгий порог — topic "обсуждение интеграции Авито для Панавто" никогда не матчится с activity name "Панавто" на 0.8. Результат: 0% linking → 0 activity-based KnowledgePacks → мёртвый Knowledge layer.

## Решение: 3 волны

### Wave 1 — Critical Path (разблокирует всё)

Три независимых компонента, все в одной волне:

#### 1a. Fix Segment→Activity Linking

**Текущее состояние:**
- `OrphanSegmentLinkerService` (3 стратегии): participant matching → activity candidate selection → Levenshtein similarity
- Порог: 0.8 (совпадает с ProjectMatchingService)
- Результат: 0/1804 linked

**Изменения:**
1. **Снизить порог Levenshtein** с 0.8 до 0.5 (weak match)
2. **Добавить chat→activity mapping** — новая стратегия: telegram_chat_id → Activity через `source_metadata` interaction'ов. Если чат привязан к одной Activity, все сегменты из этого чата наследуют привязку.
3. **LLM fallback** — для нерешённых после стратегий 1-3, батчить по 10-20 сегментов и отправлять Claude Haiku с списком Activities. Порог confidence: 0.6.
4. **Ретро-привязка** — endpoint для запуска на всех 1804 orphans.

**Файлы:**
- `apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts` — новые стратегии
- `apps/pkg-core/src/modules/segmentation/topical-segment.controller.ts` — endpoint для batch re-linking

**Цель:** >70% сегментов привязаны к Activity после запуска.

#### 1b. Confidence Decay

**Текущее состояние:**
- `EntityFact` имеет `confidence` (decimal 3,2), `validFrom`, `validUntil`
- Нет decay — confidence статична от момента создания

**Изменения:**
1. **Конфиг half-life** — JSON в Settings таблице, ключ `factType.halfLifeDays`:
   ```json
   {
     "birthday": null,
     "location": 365,
     "position": 730,
     "company": 730,
     "skill": 1095,
     "project": 180,
     "status": 90,
     "preference": 365,
     "hobby": 730,
     "default": 365
   }
   ```
2. **Decay formula** — в ContextService при retrieval:
   ```
   effective_confidence = base_confidence * e^(-ln(2)/half_life * age_days)
   ```
   Где `age_days = now - validFrom` (или `updatedAt` если validFrom null).
3. **Минимальный порог** — facts с effective_confidence < 0.1 не включаются в контекст.
4. **Сортировка** — по effective_confidence DESC вместо raw confidence.

**Файлы:**
- `apps/pkg-core/src/modules/context/context.service.ts` — decay при retrieval
- `apps/pkg-core/src/modules/entity-fact/entity-fact.service.ts` — helper `getEffectiveConfidence()`

**Принцип:** Decay ТОЛЬКО при чтении, БД не трогаем. Это позволяет менять формулу без миграций.

#### 1c. Fact Taxonomy Cleanup

**Текущее состояние:**
- 18 factTypes в enum EntityFact, 17 в create_fact tool Zod schema
- Чистые 16 в production (после Extraction Quality Sprint)
- Нет конфига per-type кроме enum

**Изменения:**
1. **Конфиг таблица** (или JSON в Settings) с метаданными per factType:
   - `halfLifeDays` (для 1b)
   - `category` (professional/personal/preference/business)
   - `isUnique` (boolean — может быть только один active per entity, e.g., position)
   - `extractionPriority` (high/medium/low)
2. **Мёрж role→position** — role и position семантически идентичны. Миграция: UPDATE entity_facts SET fact_type='position' WHERE fact_type='role'.
3. **Валидация при extraction** — create_fact tool проверяет factType против конфига.

**Файлы:**
- `apps/pkg-core/src/modules/entity-fact/fact-type-config.ts` — новый конфиг-файл
- `apps/pkg-core/src/modules/extraction/tools/extraction-tools.provider.ts` — валидация
- Миграция для role→position

---

### Wave 2 — Architectural Lift

**Зависит от Wave 1** (нужны привязанные сегменты и рабочий KP pipeline).

#### 2a. Activity-level KnowledgePacks

**Текущее состояние:**
- PackingJobService (weekly Sunday 3AM) — требует MIN_SEGMENTS=2 per activity
- Мёртв: 0 segments с activityId → 0 packs

**Изменения:**
1. **Активация pipeline** — после Wave 1a будут привязанные сегменты → pipeline заработает
2. **Hierarchical aggregation** — при паковке PROJECT, подтягивать сегменты из дочерних TASK'ов
3. **Structured community summary** — шаблон KP:
   - `keyFacts`: основные факты по Activity
   - `decisions`: принятые решения
   - `openQuestions`: нерешённые вопросы
   - `conflicts`: противоречия между фактами
   - `timeline`: хронология ключевых событий
4. **Incremental update** — при новых сегментах обновлять существующий KP (не создавать новый)

**Файлы:**
- `apps/pkg-core/src/modules/segmentation/packing-job.service.ts` — hierarchical packing
- `apps/pkg-core/src/modules/segmentation/packing.service.ts` — incremental update

#### 2b. Graph-aware Retrieval

**Текущее состояние:**
- ContextService выполняет 6 независимых SQL запросов
- Нет обхода relations между entities
- Нет Activity hierarchy traversal

**Изменения:**
1. **Relation traversal** — при запросе контекста по Entity:
   - 1 hop: Entity → relations → related entities → их факты
   - Пример: Иванов → works_at → Панавто → другие сотрудники Панавто
   - Max 2 hops, ограничение на количество related entities (top 5 by interaction count)
2. **Activity hierarchy traversal** — при запросе контекста по Activity:
   - Parent chain: TASK → PROJECT → BUSINESS → AREA
   - Children: PROJECT → все TASK'ы
   - KnowledgePacks на каждом уровне
3. **Unified scoring** — все результаты ранжируются по:
   ```
   score = decayed_confidence × recency_weight × hop_penalty
   ```
   Где `hop_penalty = 0.8^hop_count` (чем дальше от запрашиваемого entity, тем меньше вес).

**Файлы:**
- `apps/pkg-core/src/modules/context/context.service.ts` — graph traversal
- `apps/pkg-core/src/modules/context/graph-traversal.service.ts` — **новый сервис**

---

### Wave 3 — Scale (переизвлечение)

**Зависит от Wave 1c** (нужна обновлённая таксономия).

#### 3a. Full Re-extraction

- Batch re-extraction всех 131K сообщений через UnifiedExtraction
- Чанки по 200-500 сообщений, rate-limited (2s between Claude calls)
- С обновлёнными fact types, валидацией, и decay конфигом
- Оценка: ~$5-15 (Claude Haiku), ~2-4 часа

#### 3b. Full Re-segmentation

- Re-segment всех чатов (снять ограничение LOOKBACK_HOURS=48)
- С новым linking (Wave 1a) — сегменты сразу привязываются к Activity
- Запуск PackingJob после завершения → первые реальные KnowledgePacks

---

## Порядок реализации

```
Wave 1a (Segment Linking)  ──┐
Wave 1b (Confidence Decay)  ─┼── Параллельно ──► Wave 2a (KP Pipeline) ──► Wave 3b (Re-segment)
Wave 1c (Taxonomy Cleanup)  ─┘                   Wave 2b (Graph Retrieval)   Wave 3a (Re-extract)
```

## Метрики успеха

| Метрика | Текущее | Wave 1 | Wave 2 | Wave 3 |
|---------|---------|--------|--------|--------|
| Segments linked to Activity | 0% | >70% | >85% | >95% |
| KnowledgePacks | 2 | 2 | >20 | >50 |
| Entities с фактами | 27% | 27% | 35% | >60% |
| Retrieval hops | 0 | 0 | 2-3 | 2-3 |
| Fact types с half-life | 0 | 16 | 16 | 16 |
| Decayed facts filtered | 0% | >10% | >10% | >10% |

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| LLM linking низкое качество | Средняя | Dry-run на 100 segments, ручная проверка перед batch |
| Re-extraction дорого | Низкая | Haiku ($0.25/1M in), оценка ~$10 max |
| Graph traversal медленный | Средняя | Max 2 hops, top-5 related, SQL optimization |
| Decay формула неоптимальна | Низкая | Конфиг в Settings, легко менять без деплоя |
