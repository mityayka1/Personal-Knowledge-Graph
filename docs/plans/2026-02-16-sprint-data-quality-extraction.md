# Sprint: Чистота и полезность извлекаемых данных

> **Старт:** 2026-02-17
> **Фокус:** Устранение разрывов в extraction pipeline, активация Knowledge Packing
> **Принцип:** Все пути извлечения должны давать одинаково качественные данные

---

## Executive Summary

Аудит 2026-02-16 выявил, что **DraftExtractionService** обеспечивает промышленный уровень качества данных (5-уровневая дедупликация фактов, Smart Fusion, semantic dedup через pgvector, бусты подобия), но два других пути извлечения — **DailySynthesisExtraction** и **UnifiedExtraction** — значительно отстают. Кроме того, **Knowledge Packing pipeline бездействует**: сегментация работает по cron, но не связана с extraction, и orphaned сегменты не обрабатываются.

**Цель спринта:** Привести все extraction paths к единому уровню качества и активировать Knowledge Packing.

---

## Приоритеты

### P0 — Critical (блокируют качество данных)

#### 1. DailySynthesis: заменить substring matching на ProjectMatchingService
**Проблема:** `matchProjectsToActivities()` (строки 484-515) использует `toLowerCase().includes()` — пропускает вариации и опечатки.
**DraftExtraction уже делает:** `findExistingProjectEnhanced()` с ProjectMatchingService, client/tags/description бустами, трёхуровневым исходом (strong/weak/no match).

**Решение:** Переиспользовать `findExistingProjectEnhanced()` из DraftExtractionService.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts` — заменить `matchProjectsToActivities()`
- Возможно: извлечь `findExistingProjectEnhanced()` в общий утилитный метод

**Оценка:** 2-3 часа
**Риск:** Низкий — переиспользуем проверенный код

---

#### 2. UnifiedExtraction: добавить post-processing дедупликацию
**Проблема:** `create_fact` tool создаёт факты напрямую, без проверки дубликатов. Промпт говорит агенту "не дублируй", но LLM не имеет полного контекста → дубликаты в БД.

**Что имеем:** DraftExtractionService использует 3-pass дедупликацию:
- Pass 1: `FactDeduplicationService.checkDuplicateHybrid()`
- Pass 2: LLM review для серой зоны
- Pass 3: Smart Fusion (`FactFusionService.decideFusion()`)

**Решение:** Добавить `checkDuplicateHybrid()` проверку **внутрь** `create_fact` tool в ExtractionToolsProvider. Если найден дубликат — вызвать Smart Fusion вместо создания нового факта.

**Файлы:**
- `apps/pkg-core/src/modules/claude-agent/tools/extraction-tools.provider.ts` — модифицировать `create_fact` handler
- Инъектировать `FactDeduplicationService` и `FactFusionService`

**Оценка:** 4-5 часов
**Риск:** Средний — нужно протестировать что Agent не ломается от изменённого поведения tool

---

#### 3. Segmentation → Extraction wiring
**Проблема:** SegmentationJobService работает по cron (каждый час), но **не связан с extraction pipeline**. Extraction создаёт факты/события → но TopicalSegments не создаются для обработанных сообщений.

**Текущий flow:**
```
Messages → Extraction → Facts/Events (нет сегментации)
Messages → Segmentation (отдельный cron, только unsegmented messages)
```

**Целевой flow:**
```
Messages → Extraction → Facts/Events
                      ↘ triggerSegmentation(interactionId)
                        → TopicalSegments для обработанных сообщений
```

**Решение:** После успешного extraction, вызвать `TopicBoundaryDetectorService.detectAndCreate()` для обработанного interaction. Это гарантирует что все extracted messages также сегментированы.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/unified-extraction.service.ts` — добавить post-extraction hook
- `apps/pkg-core/src/modules/extraction/extraction.module.ts` — импортировать SegmentationModule
- Возможно: выделить метод `segmentInteraction(interactionId)` в SegmentationService для reuse

**Оценка:** 3-4 часа
**Риск:** Средний — нужно убедиться что segmentation не блокирует extraction queue
**Зависимости:** Нет

---

### P1 — High (улучшают полноту данных)

#### 4. Реализовать getPendingApprovalsForBatch()
**Проблема:** Stub возвращает `[]` (строки 192-196). Approval flow через Telegram UI не работает для DailySynthesis результатов.

**Решение:** Имплементировать запрос к `PendingApprovalService` по `batchId`. Pending approvals уже создаются в DraftExtractionService, нужен только read-метод.

**Файлы:**
- `apps/pkg-core/src/modules/extraction/daily-synthesis-extraction.service.ts:192-196`
- `apps/pkg-core/src/modules/pending-approval/pending-approval.service.ts` — возможно добавить `findByBatchId()`

**Оценка:** 1-2 часа
**Риск:** Низкий

---

#### 5. Orphaned Segments → автоматическая привязка к Activity
**Проблема:** PackingJobService (weekly) пакует только сегменты с `activityId`. Сегменты без привязки к Activity логируются как orphans и пропускаются → Knowledge Packing бездействует для значительной части данных.

**Решение:** Создать `OrphanSegmentLinkerService`:
1. При создании сегмента — попытаться привязать к Activity через контекст чата (участники, упоминания проектов в сообщениях)
2. При создании Activity — пересканировать orphaned сегменты из того же чата
3. Fallback: semantic similarity между segment summary и Activity description

**Файлы:**
- Новый: `apps/pkg-core/src/modules/segmentation/orphan-segment-linker.service.ts`
- `apps/pkg-core/src/modules/segmentation/segmentation-job.service.ts` — вызвать linker после создания сегментов
- `apps/pkg-core/src/modules/segmentation/segmentation.module.ts` — зарегистрировать сервис

**Оценка:** 5-6 часов
**Риск:** Средний — нужна правильная стратегия линковки

---

#### 6. Confirmation handlers: fact_value, identifier_attributed, entity_merged
**Проблема:** 3 из 4 обработчиков в `confirmation.service.ts:149-195` — TODO stubs. Пользователь не может подтвердить/отклонить изменения значений фактов, привязку идентификаторов и мерж сущностей.

**Решение:** Реализовать по аналогии с `FactSubjectHandler`:
- `FactValueHandler` — обновляет `value` поле EntityFact
- `IdentifierAttributionHandler` — создаёт/привязывает EntityIdentifier
- `EntityMergeHandler` — вызывает DataQualityService.mergeEntities()

**Файлы:**
- Новые: `apps/pkg-core/src/modules/confirmation/handlers/fact-value.handler.ts`
- Новые: `apps/pkg-core/src/modules/confirmation/handlers/identifier-attribution.handler.ts`
- Новые: `apps/pkg-core/src/modules/confirmation/handlers/entity-merge.handler.ts`
- `apps/pkg-core/src/modules/confirmation/confirmation.service.ts` — подключить handlers
- `apps/pkg-core/src/modules/confirmation/confirmation.module.ts` — зарегистрировать

**Оценка:** 4-5 часов (3 handler'а)
**Риск:** Низкий — паттерн уже установлен FactSubjectHandler

---

### P2 — Medium (улучшают наблюдаемость и покрытие)

#### 7. Birthday lookup в Morning Brief
**Проблема:** TODO в `brief-data-provider.service.ts:103`. Дни рождения не показываются в Morning Brief.

**Решение:** Запрос EntityFact WHERE factType = 'birthday' AND value matches today's date.

**Оценка:** 1-2 часа
**Риск:** Низкий

---

#### 8. Controller test coverage: критические контроллеры
**Проблема:** 23% покрытие (9/39). Непокрытые критические: message, interaction, topical-segment, knowledge-pack.

**Решение:** Написать базовые spec-файлы для 4 наиболее критичных контроллеров.

**Оценка:** 4-6 часов
**Риск:** Низкий

---

## Граф зависимостей

```
P0:
  [1] DailySynthesis matching ──────────────────► (независим)
  [2] UnifiedExtraction dedup ──────────────────► (независим)
  [3] Segmentation wiring ─────────────────────► (независим)

P1:
  [4] getPendingApprovalsForBatch() ───────────► (независим)
  [5] Orphan segment linker ───────────────────► зависит от [3]
  [6] Confirmation handlers ───────────────────► (независим)

P2:
  [7] Birthday lookup ─────────────────────────► (независим)
  [8] Controller tests ────────────────────────► (независим)
```

Задачи 1, 2, 3, 4, 6 полностью независимы и могут выполняться параллельно.

---

## Порядок выполнения (рекомендуемый)

| День | Задачи | Суммарно |
|------|--------|----------|
| 1 | [1] DailySynthesis matching + [4] getPendingApprovals | ~4 часа |
| 2 | [2] UnifiedExtraction dedup | ~5 часов |
| 3 | [3] Segmentation wiring | ~4 часа |
| 4 | [6] Confirmation handlers (3 шт) | ~5 часов |
| 5 | [5] Orphan segment linker | ~6 часов |
| 6 | [7] Birthday + [8] Tests (начало) | ~4 часа |

**Итого:** ~28 часов работы, 6 рабочих дней

---

## Метрики успеха

| Метрика | Текущее | Целевое |
|---------|---------|---------|
| Дубликаты фактов от UnifiedExtraction | Неизвестно (нет мониторинга) | 0 новых дубликатов |
| Проекты-дубликаты от DailySynthesis | Возможны | 0 (fuzzy matching ≥0.8) |
| Orphaned TopicalSegments | ~100% | < 30% |
| Confirmation handlers | 1/4 (25%) | 4/4 (100%) |
| Knowledge Packs created (weekly) | 0 | > 0 |
| Controller test coverage | 23% | ~35% |

---

## Риски и митигация

| Риск | Вероятность | Митигация |
|------|-------------|-----------|
| Smart Fusion в create_fact tool замедляет agent loop | Средняя | Кэшировать embedding, async dedup post-factum |
| Segmentation после extraction создаёт bottleneck | Низкая | Запускать асинхронно через BullMQ job |
| Orphan linker даёт ложные привязки | Средняя | Порог подобия ≥ 0.8, логирование всех решений |
| Confirmation handlers ломают approval flow | Низкая | Тесты по аналогии с FactSubjectHandler |

---

## Проверка (Definition of Done)

Для каждой задачи:
- [ ] `npx tsc --noEmit` — без ошибок
- [ ] Unit тесты для нового кода
- [ ] Ручная проверка на production данных
- [ ] Логирование ключевых решений (dedup skip/create/fusion)
- [ ] Обновление INDEX.md — убрать решённые пробелы
