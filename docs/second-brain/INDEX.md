# PKG Second Brain — Implementation Roadmap

> Пошаговый план развития Personal Knowledge Graph от текущего состояния до полноценной "второй памяти"

## Executive Summary

Этот документ описывает многофазный план развития PKG, который превратит систему из инструмента хранения данных в проактивного персонального ассистента с полноценной "второй памятью". План построен по принципу "от быстрых побед к сложным фичам": сначала получаем работающий продукт, затем добавляем интеллект и ретроспективный анализ.

**Общая продолжительность:** 12+ недель
**Результат:** Полноценный "Jarvis" — проактивный интеллектуальный ассистент с Activity-based моделью данных

---

## Содержание

| Документ | Описание | Статус |
|----------|----------|--------|
| [00-BASELINE.md](./00-BASELINE.md) | Текущее состояние, готовая инфраструктура | ✅ Verified |
| [01-PHASE-B-RECALL-PREPARE.md](./01-PHASE-B-RECALL-PREPARE.md) | Фаза B: Recall/Prepare API + Telegram | ✅ Completed |
| [02-PHASE-C-EXTRACT-REACT.md](./02-PHASE-C-EXTRACT-REACT.md) | Фаза C: Extract & React (события, уведомления) | ✅ Completed |
| [03-PHASE-A-ACT.md](./03-PHASE-A-ACT.md) | Фаза A: Act Capabilities (отправка сообщений) | 🔄 In Progress |
| [04-TIMELINE-METRICS.md](./04-TIMELINE-METRICS.md) | Timeline, Success Metrics, Risk Mitigation | Reference |
| [05-JARVIS-FOUNDATION.md](./05-JARVIS-FOUNDATION.md) | **Фаза D: Jarvis Foundation** — Activity-based модель, Reasoning Engine | ✅ Completed (Phase 1-6) |
| [06-PHASE-E-KNOWLEDGE-PACKING.md](./06-PHASE-E-KNOWLEDGE-PACKING.md) | **Фаза E: Knowledge Packing** — Сегментация обсуждений, упаковка знаний | ✅ Completed |
| [Knowledge System Evolution](../plans/2026-02-15-knowledge-system-evolution-plan.md) | Эволюция системы знаний — 3 волны улучшений | ✅ Completed |
| [Extraction Quality Sprint](../plans/2026-02-21-extraction-quality-sprint.md) | LLM-powered dedup, DeduplicationGateway, batch cleanup | ✅ Completed |

---

## Фазы проекта

### Phase B: Recall/Prepare ✅
**Цель:** Поиск информации и подготовка к встречам

- POST /agent/recall — поиск в естественном языке
- POST /agent/prepare/:entityId — meeting brief
- Telegram команды /recall и /prepare

### Phase C: Extract & React ✅
**Цель:** Проактивное извлечение событий из переписки

- ExtractedEvent entity
- SecondBrainExtractionService
- Carousel UX для событий
- Context-Aware Extraction
- Morning brief, digests

### Phase A: Act 🔄
**Цель:** Отправка сообщений с подтверждением

- ActionToolsProvider (draft_message, send_telegram)
- Approval Flow через Telegram
- Proactive action buttons

### Phase D: Jarvis Foundation ✅
**Цель:** Полноценный проактивный ассистент

- **Activity entity** — иерархическая модель всех дел (AREA → BUSINESS → PROJECT → TASK)
- **Commitment entity** — обещания и обязательства между людьми
- **Reasoning Engine** — inference rules, context determination
- **Trigger System** — time/event/context-based уведомления
- **Action Engine** — автономные действия с approval flow
- **External Knowledge** — интеграция с web search

#### Foundation Services (Phase 1) -- Completed

Фундаментальные сервисы, созданные для устранения разрыва между моделью данных и её фактическим использованием. Подготовка к интеграции в extraction pipeline.

| Сервис | Описание | Файл |
|--------|----------|------|
| **ProjectMatchingService** | Fuzzy matching для предотвращения дубликатов проектов | `apps/pkg-core/src/modules/extraction/project-matching.service.ts` |
| **ClientResolutionService** | 3-стратегийное определение клиента для Activity | `apps/pkg-core/src/modules/extraction/client-resolution.service.ts` |
| **ActivityValidationService** | Валидация иерархии типов Activity (HIERARCHY_RULES) | `apps/pkg-core/src/modules/activity/activity-validation.service.ts` |
| **ActivityMemberService** | Управление участниками: resolve names → Entity → ActivityMember | `apps/pkg-core/src/modules/activity/activity-member.service.ts` |

Детали: [`docs/plans/2025-02-05-project-creation-improvements-plan.md`](../plans/2025-02-05-project-creation-improvements-plan.md) -- Phase 1: Preparation

#### Extraction Improvements (Phase 2) -- Completed

Интеграция Foundation Services в extraction pipeline, улучшение критериев извлечения и entity wiring.

| Улучшение | Описание |
|-----------|----------|
| **ProjectIndicators** | 5 boolean индикаторов (duration, structure, deliverable, team, explicit context) + filterLowQualityProjects |
| **ProjectMatching Integration** | Fuzzy deduplication в DraftExtractionService (Levenshtein 0.8) |
| **ClientResolution Integration** | 3-strategy определение клиента в обоих extraction сервисах |
| **ActivityMember Wiring** | Участники из extraction автоматически создаются как ActivityMember записи |
| **Commitment.activityId** | Обязательства связываются с проектами через projectMap |
| **Activity Enrichment** | description и tags заполняются при extraction |

Детали: [`docs/plans/2025-02-05-project-creation-improvements-plan.md`](../plans/2025-02-05-project-creation-improvements-plan.md) -- Phase 2: Extraction Improvements

#### REST API (Phase 4) -- Completed

Полноценный REST API для Activity CRUD с валидацией, пагинацией и управлением участниками.

| Endpoint | Описание |
|----------|----------|
| `POST /activities` | Создание Activity с валидацией иерархии типов |
| `GET /activities` | Список с фильтрами (type, status, context, owner, client, search) и пагинацией |
| `GET /activities/:id` | Детали с relations, members и childrenCount |
| `PATCH /activities/:id` | Обновление с валидацией циклов в иерархии |
| `DELETE /activities/:id` | Soft delete (status = ARCHIVED) |
| `GET /activities/:id/tree` | Поддерево (children + descendants) |
| `POST /activities/:id/members` | Добавление участников (дедупликация по entityId + role) |
| `GET /activities/:id/members` | Список участников |

Детали: [`docs/API_CONTRACTS.md`](../API_CONTRACTS.md) -- Activity API section

#### Data Quality Remediation (Phase 5) -- Completed

Автоматическое исправление проблем качества данных, обнаруженных первым DQ-аудитом.

| Фаза | Описание | Статус |
|------|----------|--------|
| **Phase 5.1** | normalizeName() + autoMergeAllDuplicates | ✅ Completed |
| **Phase 5.2** | OrphanResolutionService + auto-assign orphans | ✅ Completed |
| **Phase 5.3** | Auto-resolve missing client entities | ✅ Completed |
| **Phase 5.4** | Agent Tools — Activity CRUD + auto-fix | ✅ Completed |
| **Phase 5.5** | Extraction pipeline prevention (two-tier matching, normalization, task dedup) | ✅ Completed |

Детали: [`docs/plans/proud-prancing-squid.md`](../plans/proud-prancing-squid.md)

#### Data Quality System (Phase 6) -- Completed

Система аудита качества данных: обнаружение дубликатов, сирот, пропущенных связей, а также механизм мержа и разрешения проблем.

| Компонент | Описание |
|-----------|----------|
| **DataQualityReport entity** | JSONB отчёты: metrics, issues, resolutions. Статусы: PENDING, REVIEWED, RESOLVED |
| **DataQualityService** | Полный аудит, поиск дубликатов (LOWER(name) + type), orphaned tasks, merge |
| **DataQualityController** | 7 REST endpoints: audit, reports CRUD, metrics, merge |
| **DataQualityToolsProvider** | 5 AI agent tools для Claude |
| **Tests** | 49 тестов (37 service + 12 controller) |

Детали: [`docs/API_CONTRACTS.md`](../API_CONTRACTS.md) -- Data Quality API section

### Phase E: Knowledge Packing ✅
**Цель:** Сегментация обсуждений по темам и ретроспективная упаковка знаний

- **TopicalSegment entity** — семантические сегменты обсуждений (many-to-many с messages)
- **KnowledgePack entity** — консолидированные знания по Activity
- **SegmentationService** — Claude-based определение границ тем
- **PackingService** — еженедельная упаковка сегментов в знания
- **Conflict Detection** — обнаружение противоречий между фактами
- **Knowledge Traceability** — связь фактов с исходными обсуждениями

#### Knowledge System Evolution — Completed

3 волны улучшений системы знаний, реализованные после базовой Phase E.

| Волна | Описание | Статус |
|-------|----------|--------|
| **Wave 1 — Fix Broken Links** | Persist InferredRelations, fix Commitment↔Activity linking, strengthen project dedup | ✅ Completed |
| **Wave 2 — Deepen Extraction** | Activity enrichment, semantic dedup (embeddings), find_activity tool | ✅ Completed |
| **Wave 3 — Knowledge Layer** | TopicBoundaryDetector, PackingService, Smart Fusion, Cross-Chat Linking, Entity Disambiguation | ✅ Completed |

#### Extraction Quality Sprint — Completed

LLM-powered дедупликация и quality filters для всех путей extraction. Два батча: Batch 1 — quality filters (P1/P3/P4/P5/P6), Batch 2 — activity-scoped commitment dedup (P2).

**Batch 1 — Quality Filters (PR #155)**

| Компонент | Описание |
|-----------|----------|
| **Per-type MIN_CONFIDENCE (P5)** | Раздельные пороги confidence по типам: task 0.7, promise 0.75, fact 0.65 |
| **isInformationalCommitment (P1)** | Фильтр информационных commitment'ов (56% rejection rate): "обсудили", "согласовали", "отправил" |
| **isEphemeralFactValue (P3)** | Фильтр эфемерных фактов: status/health всегда, location/preference по паттернам |
| **isProjectDataFact (P4)** | Фильтр проектных данных, ошибочно извлечённых как личные факты (стоимость, API, бюджет) |
| **isPastTenseTask (P6)** | Фильтр задач в прошедшем времени (39% rejection rate): "настроил CI/CD" → не задача |

**Batch 2 — Activity-Scoped Commitment Dedup (PR #160)**

| Компонент | Описание |
|-----------|----------|
| **LlmDedupService** | Wrapper над Claude Haiku для семантических решений по дедупликации |
| **DeduplicationGatewayService** | Единая точка входа: normalize → exact match → embedding → LLM → решение. Activity-scoped: все 3 канала (exact, semantic/cosine, trigram) поддерживают `activityId` для cross-entity dedup в рамках проекта |
| **DedupBatchCleanupJob** | Daily cron (3:00 AM): cosine similarity по Activity embeddings → LLM confirm → auto-merge |
| **Activity resolution before dedup** | DraftExtractionService: 3-tier matching (projectMap → fuzzy Levenshtein → findByMention) перенесён ДО вызова dedup gateway |
| **Scoping priority** | `activityId > entityId > no scope` — ловит дубли между разными entity pairs внутри одного проекта |
| **create_fact activityId** | Факты привязываются к конкретным проектам через activityId |

Детали: [`docs/plans/2026-02-21-extraction-quality-sprint.md`](../plans/2026-02-21-extraction-quality-sprint.md)

#### Architecture Refactoring — Completed

| Компонент | Описание |
|-----------|----------|
| **ClaudeAgentCoreModule** | Чистый модуль без доменных зависимостей (ClaudeAgentService, SchemaLoader, ToolsRegistry) |
| **Registration Pattern** | Tool providers самостоятельно регистрируются через `onModuleInit()` → `toolsRegistry.registerProvider()` |
| **ToolsProviderInterface** | Декаплинг-интерфейс для tool providers |

Результат: 0 forwardRef (было 7), 0 циклических зависимостей, 8/8 tool providers регистрируются.

Детали: [`docs/plans/fuzzy-tinkering-allen.md`](../plans/fuzzy-tinkering-allen.md) — architecture refactoring + extraction context injection

#### Morning Brief Integration Fixes — Completed (verified 2026-02-16)

Все критические и архитектурные фиксы реализованы. Оставшиеся задачи — product decisions (FK constraints, PAUSED status).

Детали: [`docs/plans/brief-integration-fixes.md`](../plans/brief-integration-fixes.md)

---

## Известные пробелы и технический долг (обновлено 2026-02-21)

### Extraction Pipeline — функциональный паритет между путями

Система имеет три пути extraction. После рефакторинга ExtractionToolsProvider **все три пути** проходят через полный quality pipeline:

| Возможность | DraftExtraction (oneshot) | UnifiedExtraction (agent) | SecondBrainExtraction |
|-------------|:-------------------------:|:-------------------------:|:---------------------:|
| Smart Fusion (FactFusionService) | ✅ | ✅ (через ExtractionToolsProvider) | ✅ (через Draft) |
| ProjectMatchingService | ✅ | ✅ (через ExtractionToolsProvider) | ✅ (через Draft) |
| Task Dedup (Levenshtein) | ✅ | ✅ (через DraftExtractionService) | ✅ (через Draft) |
| Semantic Dedup (embeddings) | ✅ | ✅ (через DraftExtractionService) | ✅ (через Draft) |
| ClientResolutionService | ✅ | ✅ (через DraftExtractionService) | ✅ (через Draft) |
| ActivityMember wiring | ✅ | ✅ (через DraftExtractionService) | ✅ (через Draft) |
| Activity Context (existing projects) | ✅ | ✅ (loadExistingActivities) | ✅ |
| DeduplicationGateway (LLM dedup) | ✅ (через DraftExtraction) | ✅ (через ExtractionToolsProvider) | ✅ (через Draft) |
| DedupBatchCleanupJob (daily cron) | — | — | — |

**Ключевые файлы:**
- `extraction-tools.provider.ts` — `create_fact` tool имеет полный dedup + Smart Fusion
- `extraction-tools.provider.ts` — `create_event` tool делегирует в `draftExtractionService.createDrafts()`
- `dedup-gateway.service.ts` — единая точка входа для дедупликации (normalize → exact → embedding → LLM)
- `llm-dedup.service.ts` — LLM wrapper (Claude Haiku) для семантических решений
- `dedup-batch-cleanup.job.ts` — ежедневный cron для обнаружения и мержа существующих дублей

### ~~Решённые пробелы (2026-02-17..20)~~

| Проблема | Решение | Дата |
|----------|---------|------|
| ~~Birthday lookup — TODO~~ | ✅ Реализован через EntityFact с factType='birthday' и value_date | 2026-02-18 |
| ~~Orphaned TopicalSegments~~ | ✅ OrphanSegmentLinkerService + manual endpoint `POST /segments/run-orphan-linker` | 2026-02-17 |
| ~~Segmentation не вызывается~~ | ✅ Cron каждый час + manual endpoint `POST /segments/run-segmentation` | 2026-02-17 |
| ~~Knowledge tools не интегрированы~~ | ✅ `search_discussions` и `get_knowledge_summary` в recall/prepare agents | 2026-02-18 |
| ~~Activity context не в SecondBrain~~ | ✅ `loadExistingActivities()` + `formatActivityContext()` + `projectName` в mappers | 2026-02-18 |
| ~~Cross-chat context 30 мин~~ | ✅ Расширено до 120 мин (настраиваемо) | 2026-02-18 |
| ~~UnifiedExtraction без dedup/fusion~~ | ✅ ExtractionToolsProvider имеет полный pipeline: `create_fact` с Smart Fusion + dedup, `create_event` через DraftExtractionService | 2026-02-20 |
| ~~`getPendingApprovalsForBatch()` — stub~~ | ✅ Реализован через `pendingApprovalService.list()` в `daily-synthesis-extraction.service.ts` | 2026-02-20 |
| ~~`matchProjectsToActivities()` — substring only~~ | ✅ Использует `ProjectMatchingService.findBestMatchInList()` с порогом 0.8 | 2026-02-20 |
| ~~Confirmation System — неполные обработчики~~ | ✅ Все 4 handler'а реализованы в `confirmation.service.ts`: `fact_created`, `fact_value`, `identifier_attributed`, `entity_merged` | 2026-02-20 |

### Segmentation Pipeline — частично интегрирован

Сегментация (Phase E) **реализована** и работает:
- ✅ `SegmentationJobService` работает по cron (каждый час) — обрабатывает unsegmented messages
- ✅ Manual endpoints: `POST /segments/run-segmentation`, `POST /segments/run-orphan-linker`
- ✅ OrphanSegmentLinkerService автоматически линкует orphan сегменты к activities
- ⚠️ Для чатов с >80 сообщений batch — Sonnet может выдать `error_max_structured_output_retries`
- ⚠️ PackingJobService (weekly) пакует только сегменты с `activityId`

### Тест-покрытие контроллеров — 23%

Из 39 контроллеров только 9 имеют `.spec.ts` файлы. Непокрытые критические контроллеры:
- `message.controller.ts`, `interaction.controller.ts`
- `topical-segment.controller.ts`, `knowledge-pack.controller.ts`
- `entity-fact.controller.ts`, `entity-relation.controller.ts`

---

## Quick Links

- [CLAUDE.md](../../CLAUDE.md) — основные инструкции проекта
- [ARCHITECTURE.md](../ARCHITECTURE.md) — архитектура системы
- [API_CONTRACTS.md](../API_CONTRACTS.md) — API контракты
- [SUMMARIZATION.md](../SUMMARIZATION.md) — система суммаризации и агрегации профилей
