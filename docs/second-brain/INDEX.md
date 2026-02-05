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
| [05-JARVIS-FOUNDATION.md](./05-JARVIS-FOUNDATION.md) | **Фаза D: Jarvis Foundation** — Activity-based модель, Reasoning Engine | 🔄 In Progress (Phase 1-2, REST API Completed) |
| [06-PHASE-E-KNOWLEDGE-PACKING.md](./06-PHASE-E-KNOWLEDGE-PACKING.md) | **Фаза E: Knowledge Packing** — Сегментация обсуждений, упаковка знаний | 📋 Planned |

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

### Phase D: Jarvis Foundation 🔄
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

### Phase E: Knowledge Packing 📋
**Цель:** Сегментация обсуждений по темам и ретроспективная упаковка знаний

- **TopicalSegment entity** — семантические сегменты обсуждений (many-to-many с messages)
- **KnowledgePack entity** — консолидированные знания по Activity
- **SegmentationService** — Claude-based определение границ тем
- **PackingService** — еженедельная упаковка сегментов в знания
- **Conflict Detection** — обнаружение противоречий между фактами
- **Knowledge Traceability** — связь фактов с исходными обсуждениями

---

## Quick Links

- [CLAUDE.md](../../CLAUDE.md) — основные инструкции проекта
- [ARCHITECTURE.md](../ARCHITECTURE.md) — архитектура системы
- [API_CONTRACTS.md](../API_CONTRACTS.md) — API контракты
- [SUMMARIZATION.md](../SUMMARIZATION.md) — система суммаризации и агрегации профилей
