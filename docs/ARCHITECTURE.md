# Архитектура PKG

## Обзор

Система построена по принципу микросервисной архитектуры с тремя основными сервисами, взаимодействующими через REST API.

## Сервисы

### 1. Telegram Adapter

**Назначение:** Подключение к Telegram и поставка сырых данных в PKG Core.

**Ответственность:**
- Подключение к Telegram как userbot (GramJS/MTProto)
- Получение сообщений в реальном времени
- Session management (определение границ сессий по настраиваемому gap threshold, по умолчанию 4 часа)
- Отправка сообщений в PKG Core через API
- Сохранение voice messages в file storage и постановка в очередь транскрипции

**НЕ ответственность:**
- Entity resolution (только передаёт telegram_user_id)
- Хранение истории сообщений
- Транскрипция (только ставит задачу в очередь)

**Локальное состояние:**
- Telegram session (auth credentials)
- Active sessions map: `{ chat_id → last_message_timestamp }`
- Retry queue (при недоступности PKG Core)

```
┌────────────────────────────────────────────────────────────────┐
│                      TELEGRAM ADAPTER                          │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│  │   GramJS     │    │   Session    │    │   HTTP       │     │
│  │   Client     │───►│   Manager    │───►│   Client     │────►│ PKG Core
│  │              │    │              │    │              │     │
│  └──────────────┘    └──────────────┘    └──────────────┘     │
│         │                                                      │
│         │ voice                                                │
│         ▼                                                      │
│  ┌──────────────┐                                             │
│  │   File       │────────────────────────────────────────────►│ Storage
│  │   Handler    │                                             │
│  └──────────────┘                                             │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

### 2. PKG Core Service

**Назначение:** Центральный сервис, владеющий данными и предоставляющий API.

**Ответственность:**
- Entity management (CRUD, merge, связи)
- Entity Resolution (identifier → entity mapping)
- Interaction management (создание, обновление)
- Message и segment storage
- Facts management (CRUD, история, pending, Smart Fusion)
- Search (Full-text + Vector + Hybrid)
- API для всех клиентов
- Генерация embeddings (async queue)
- **Claude Agent SDK** — оркестрация LLM-задач (oneshot structured output, agent mode с tools)
- **Extraction Pipeline** — 3 пути извлечения знаний из переписки (см. ниже)
- **Segmentation & Knowledge Packing** — сегментация обсуждений по темам, консолидация знаний
- **Pending Approval Workflow** — draft entities с подтверждением/отклонением
- **Activity Management** — иерархическая модель дел (closure-table: AREA → BUSINESS → PROJECT → TASK)
- **Data Quality System** — аудит, дедупликация, мерж, orphan resolution
- **Media Proxy** — проксирование медиа-запросов к Telegram Adapter
- **Bot Detection** — фильтрация ботов из summarization, context, search

**НЕ ответственность:**
- Подключение к внешним источникам (Telegram, etc.)
- Транскрипция аудио (делегирует Worker)
- Сложные multi-step AI workflows (делегирует Worker/n8n)

```
┌──────────────────────────────────────────────────────────────────────┐
│                              PKG CORE                                │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                        REST API Layer                          │  │
│  │  /entities  /interactions  /messages  /search  /media          │  │
│  │  /activities  /pending-approvals  /segmentation  /data-quality │  │
│  │  /agent/recall  /agent/prepare                                 │  │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                               │                                      │
│  ┌────────────────────────────┼───────────────────────────────────┐  │
│  │                    Service Layer                                │  │
│  │                                                                │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌─────────────────────────┐  │  │
│  │  │  Entity    │ │ Interaction  │ │ Claude Agent Service    │  │  │
│  │  │  Service   │ │ Service      │ │ (oneshot / agent mode)  │  │  │
│  │  └────────────┘ └──────────────┘ └───────────┬─────────────┘  │  │
│  │                                               │                │  │
│  │  ┌────────────┐ ┌──────────────┐ ┌───────────▼─────────────┐  │  │
│  │  │  Activity  │ │  Pending     │ │    ToolsRegistry        │  │  │
│  │  │  Service   │ │  Approval    │ │  + MCP Server (in-proc) │  │  │
│  │  │ (closure)  │ │  Service     │ └─────────────────────────┘  │  │
│  │  └────────────┘ └──────────────┘                               │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │              Extraction Pipeline                          │  │  │
│  │  │  SecondBrain ─┐                                          │  │  │
│  │  │  DailySynth ──┤─► DraftExtraction ─► PendingApproval     │  │  │
│  │  │  Unified ─────┘   (dedup + fusion)                       │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │                                                                │  │
│  │  ┌────────────────────────────────────────────────────────┐    │  │
│  │  │           Segmentation & Knowledge Packing              │    │  │
│  │  │  TopicBoundaryDetector → Segments → PackingService      │    │  │
│  │  └────────────────────────────────────────────────────────┘    │  │
│  │                                                                │  │
│  │  ┌──────────┐ ┌──────────────┐ ┌────────────────────────┐     │  │
│  │  │  Search  │ │ DataQuality  │ │    Media Proxy         │─────│──│─► Telegram
│  │  │  Service │ │ Service      │ │                        │     │  │   Adapter
│  │  └──────────┘ └──────────────┘ └────────────────────────┘     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                               │                                      │
│  ┌────────────────────────────┴───────────────────────────────────┐  │
│  │              PostgreSQL + pgvector + Redis (BullMQ)            │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

### 3. Worker Service (n8n)

**Назначение:** Выполнение сложных асинхронных задач, требующих визуальной отладки.

**Ответственность:**
- Транскрипция аудио (Whisper)
- Сложные multi-step AI workflows (когда нужна визуальная отладка в n8n):
  - Speaker mapping для звонков (требует итеративную отладку)
  - Сложные entity resolution cases
- Scheduled jobs (digest, cleanup)

**НЕ ответственность:**
- Хранение данных (всё через PKG Core API)
- Бизнес-логика entities/interactions
- Простые LLM задачи (fact extraction, context synthesis — выполняются в PKG Core)

**Принцип разделения:**
- **PKG Core** — простые LLM вызовы с предсказуемым результатом (extraction, synthesis)
- **Worker/n8n** — сложные workflows, требующие визуальной отладки и итераций

```
┌────────────────────────────────────────────────────────────────┐
│                         WORKER (n8n)                           │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    Workflow Engine                       │  │
│  │                                                          │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │  │
│  │  │ WF-1    │  │ WF-2    │  │ WF-3    │  │ WF-4    │    │  │
│  │  │ Voice   │  │ Phone   │  │ Context │  │ Entity  │    │  │
│  │  │ Transcr │  │ Process │  │ Synth   │  │ Resolve │    │  │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘    │  │
│  │       │            │            │            │          │  │
│  └───────┼────────────┼────────────┼────────────┼──────────┘  │
│          │            │            │            │              │
│  ┌───────▼────────────▼────────────▼────────────▼──────────┐  │
│  │                  Tool Layer                              │  │
│  │                                                          │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │  │
│  │  │   Whisper   │  │   Claude    │  │   HTTP Client   │  │  │
│  │  │             │  │   Code CLI  │  │   (PKG Core)    │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────┘  │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

---

## Взаимодействие сервисов

### Паттерн коммуникации

- **Telegram Adapter → PKG Core:** HTTP POST (push model)
- **PKG Core → Worker:** HTTP Webhook (async tasks)
- **Worker → PKG Core:** HTTP POST/PATCH (результаты обработки)

### Sequence: Новое сообщение

```
Telegram       Telegram         PKG Core                    PostgreSQL
Server         Adapter          Service                     
   │               │                │                            │
   │──message─────►│                │                            │
   │               │                │                            │
   │               │──POST /messages────►                        │
   │               │                │                            │
   │               │                │──resolve(telegram_id)─────►│
   │               │                │◄─────entity_id | pending───│
   │               │                │                            │
   │               │                │──insert message───────────►│
   │               │                │                            │
   │               │                │──queue embedding job──────►│
   │               │                │                            │
   │               │◄──200 OK───────│                            │
   │               │                │                            │
```

### Sequence: Voice Message

```
Telegram       Telegram         PKG Core         Worker        PostgreSQL
Server         Adapter          Service          (n8n)         
   │               │                │               │               │
   │──voice msg───►│                │               │               │
   │               │                │               │               │
   │               │──save to storage──────────────────────────────►│
   │               │                │               │               │
   │               │──POST /voice-jobs──►          │               │
   │               │                │               │               │
   │               │                │──webhook─────►│               │
   │               │                │               │               │
   │               │                │               │──whisper──────►
   │               │                │               │◄──transcript──│
   │               │                │               │               │
   │               │                │◄─POST /messages               │
   │               │                │               │               │
   │               │                │──insert──────────────────────►│
```

### Sequence: Context Query

```
Client              PKG Core          Worker              PostgreSQL
   │                    │                │                      │
   │──POST /context────►│                │                      │
   │                    │                │                      │
   │                    │──fetch data───────────────────────────►
   │                    │◄──entity + interactions + facts───────│
   │                    │                │                      │
   │                    │──webhook──────►│                      │
   │                    │                │                      │
   │                    │                │──claude synthesize   │
   │                    │                │                      │
   │                    │◄──markdown─────│                      │
   │                    │                │                      │
   │◄──context──────────│                │                      │
```

---

## Bot Detection

### Механизм определения ботов

Entity имеет поле `is_bot: boolean`, которое устанавливается при создании из `telegram_user_info.isBot`.

**Исключение ботов:**
- **Summarization** — interactions с участниками-ботами исключаются из суммаризации через SQL фильтр
- **Context Retrieval** — боты не включаются в контекст для LLM
- **Search** — сообщения от ботов исключаются из результатов поиска

**Пример SQL фильтра (summarization):**
```sql
-- Exclude interactions where any participant is a bot
WHERE NOT EXISTS (
  SELECT 1 FROM interaction_participants ip
  INNER JOIN entities e ON e.id = ip.entity_id
  WHERE ip.interaction_id = i.id AND e.is_bot = true
)
```

---

## Chat Categorization

### Категории чатов

| Категория | Условие | Auto-extraction | Entity auto-create |
|-----------|---------|-----------------|-------------------|
| `personal` | Приватный чат | ✅ | ✅ |
| `working` | Группа ≤ threshold участников | ✅ | ✅ |
| `mass` | Группа > threshold, канал | ❌ | ❌ (→ PendingResolution) |

**Threshold:** настраивается через `session.chatCategoryThreshold` (по умолчанию 20).

### Manual Override

При ручном изменении категории через API устанавливается флаг `isManualOverride: true`.

**Поведение:**
- При `isManualOverride: true` — автоматическая перекатегоризация отключена
- Изменение числа участников не влияет на категорию
- Сброс флага: `POST /chat-categories/{id}/reset-override`

---

## Media Proxy

### Принцип Source-Agnostic

Клиенты (Dashboard, мобильное приложение) НЕ должны обращаться напрямую к Telegram Adapter.

```
┌─────────┐      ┌──────────┐      ┌──────────────────┐
│Dashboard│─────►│ PKG Core │─────►│ Telegram Adapter │
└─────────┘      │  /media  │      │   /download      │
                 └──────────┘      └──────────────────┘
```

**Преимущества:**
- Единая точка входа для всех клиентов
- PKG Core контролирует авторизацию
- Легко добавить другие источники (WhatsApp, Email) без изменения клиентов

---

## Claude Agent SDK Architecture

### Обзор

PKG Core использует `@anthropic-ai/claude-agent-sdk` для всех LLM-задач. Центральный сервис `ClaudeAgentService` абстрагирует работу с SDK, предоставляя два режима выполнения и единый интерфейс для логирования, timeout, budget control.

### Режимы выполнения

| Режим | Метод | Описание | Когда использовать |
|-------|-------|----------|-------------------|
| `oneshot` | `executeOneshot<T>()` | Structured output через JSON Schema (constrained decoding) | Извлечение данных, классификация, сегментация |
| `agent` | `executeAgent<T>()` | Multi-turn с MCP tools | Recall, prepare, действия, сложные цепочки |

**Oneshot mode** использует `outputFormat` SDK для гарантированного соответствия JSON Schema. Constrained decoding означает, что модель физически не может сгенерировать невалидный JSON. `maxTurns >= 2` обязателен (Turn 1: вызов StructuredOutput tool, Turn 2: завершение).

**Agent mode** создаёт in-process MCP сервер с tools, который Claude использует для доступа к данным PKG. Поддерживает `outputFormat` для получения структурированного результата после работы с tools, `budgetUsd` для ограничения затрат, `hooks` для мониторинга tool calls.

### Модели

| Alias | Полный идентификатор | Назначение |
|-------|---------------------|------------|
| `haiku` | `claude-haiku-4-5-20251001` | Быстрые/дешёвые задачи: классификация, простая экстракция |
| `sonnet` | `claude-sonnet-4-5-20250929` | Основная модель: экстракция, сегментация, синтез |
| `opus` | `claude-opus-4-5-20251101` | Сложные задачи: архитектурный анализ |

### ToolsRegistryService

Агрегирует tools из специализированных провайдеров. Использует паттерн самостоятельной регистрации: каждый доменный модуль вызывает `registerProvider()` в lifecycle hook `OnModuleInit`.

```
Domain Module                  ToolsRegistryService             ClaudeAgentService
     │                                │                                │
     │── onModuleInit ──────────────►│                                │
     │   registerProvider(category,   │                                │
     │                    provider)   │                                │
     │                                │                                │
     │                                │◄──── createMcpServer(cats) ────│
     │                                │                                │
     │                                │──── createSdkMcpServer() ─────►│ (in-process)
     │                                │     { name: 'pkg-tools',       │
     │                                │       tools: [...] }           │
```

**Кэширование:** `cachedAllTools` и `categoryCache` для предотвращения повторной агрегации. Кэш инвалидируется при регистрации нового провайдера.

**MCP Server:** In-process через `createSdkMcpServer()` — tools работают в том же процессе Node.js, без сетевого overhead. Имя сервера: `pkg-tools`. Tools доступны Claude в формате `mcp__pkg-tools__<tool_name>`.

### Категории tools

| Категория | Провайдер | Tools |
|-----------|-----------|-------|
| `search` | `SearchToolsProvider` | `search_messages` |
| `entities` | `EntityToolsProvider` | `get_entity_details`, `list_entities` |
| `context` | `ContextToolsProvider` | `get_entity_context` |
| `events` | `EventToolsProvider` | `create_reminder`, `list_events` |
| `actions` | `ActionToolsProvider` | `draft_message`, `send_telegram` |
| `activities` | `ActivityToolsProvider` | Activity CRUD, members, tree |
| `knowledge` | `KnowledgeToolsProvider` | `search_discussions`, `get_discussion_context`, `get_knowledge_summary`, `trace_fact_source` |
| `data-quality` | `DataQualityToolsProvider` | Аудит, мерж, дубликаты |
| `all` | Все провайдеры | Объединяет все tools |

### Типы задач (ClaudeTaskType)

29 типов задач, логируемых в таблицу `claude_agent_runs`:

- **Extraction:** `fact_extraction`, `event_extraction`, `unified_extraction`, `group_extraction`
- **Synthesis:** `summarization`, `profile_aggregation`, `context_synthesis`, `context_enrichment`
- **Second Brain:** `recall`, `meeting_prep`, `daily_brief`, `action`, `draft_generation`
- **Dedup/Fusion:** `fact_fusion`, `fact_dedup_review`, `activity_semantic_dedup`, `event_cleanup_dedup`
- **Segmentation:** `topic_segmentation`, `knowledge_packing`
- **Matching:** `project_name_match`, `event_activity_match`, `description_enrichment`
- **Generation:** `message_regeneration`

### Structured Output

```typescript
// Oneshot: JSON Schema → constrained decoding
const result = await claudeAgentService.call<MyType>({
  mode: 'oneshot',
  taskType: 'fact_extraction',
  prompt: '...',
  schema: MY_JSON_SCHEMA,      // Raw JSON Schema (НЕ Zod)
  model: 'sonnet',
});
// result.data гарантированно соответствует schema

// Agent: outputFormat для структурированного результата после tool calls
const result = await claudeAgentService.call<MyType>({
  mode: 'agent',
  taskType: 'recall',
  prompt: '...',
  toolCategories: ['search', 'entities'],
  outputFormat: {
    type: 'json_schema',
    schema: MY_JSON_SCHEMA,
    strict: true,
  },
});
```

### Timeout и Abort

- **Oneshot:** default timeout 120s
- **Agent:** default timeout 300s (5 минут)
- Используется `AbortController` — при timeout SDK call прерывается
- `budgetUsd` — если cumulative cost превышает лимит, agent прерывается

### Логирование

Каждый вызов записывается в `ClaudeAgentRun` entity:
- `taskType`, `mode`, `model`
- `tokensIn`, `tokensOut`, `costUsd`
- `durationMs`, `turnsCount`, `toolsUsed[]`
- `success`, `errorMessage`
- `inputPreview`, `outputPreview` (первые 500 символов)

Статистика доступна через `getStats(period)` и `getDailyStats(days)`.

---

## Extraction Pipeline Architecture

### Обзор

Extraction Pipeline извлекает структурированные знания из переписки и создаёт draft entities (Activity, Commitment, EntityFact) с workflow подтверждения. Три пути извлечения используют общий `DraftExtractionService` для создания и дедупликации сущностей.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Extraction Pipeline                             │
│                                                                         │
│  Telegram Message ──► SecondBrainExtraction ─┐                         │
│                       (real-time, oneshot)    │                         │
│                                              │                         │
│  /daily Synthesis ──► DailySynthesisExtraction┤─► DraftExtractionService│
│                       (batch, oneshot)        │   (dedup + fusion)      │
│                                              │         │               │
│  Private Chat ──────► UnifiedExtraction ─────┘         │               │
│                       (agent mode + tools)             ▼               │
│                                                 PendingApproval        │
│                                                 (draft → approve)      │
└─────────────────────────────────────────────────────────────────────────┘
```

### Три пути извлечения

#### 1. SecondBrainExtractionService — Real-time

**Триггер:** Новые сообщения из Telegram (группы и каналы).
**Режим:** `oneshot` (structured output с `CONVERSATION_EXTRACTION_SCHEMA`).

Извлекает:
- `ExtractedFact` — факты о людях (должность, компания, контакт)
- `ExtractedTask` — задачи и поручения
- `ExtractedCommitment` — обещания и обязательства
- `ExtractedEvent` — события (встречи, дедлайны)

Особенности:
- Атрибуция фактов третьим лицам через `subjectMention` и `SubjectResolverService`
- Результаты передаются в `DraftExtractionService.createDrafts()`

#### 2. DailySynthesisExtractionService — Batch

**Триггер:** Текст ежедневного синтеза (`/daily`).
**Режим:** `oneshot` (structured output с `DAILY_SYNTHESIS_EXTRACTION_SCHEMA`).

Извлекает проекты, задачи, обязательства из синтезированного текста дня.

Особенности:
- **Фильтрация проектов:** 5 boolean индикаторов (duration, structure, deliverable, team, explicit context) — минимум 2 из 5 для прохождения
- **Fuzzy matching:** `ProjectMatchingService` с Levenshtein 0.8 для дедупликации проектов
- Метод `extractAndSave()` объединяет extraction + `DraftExtractionService.createDrafts()`

#### 3. UnifiedExtractionService — Agent Mode

**Триггер:** Сообщения из приватных чатов.
**Режим:** `agent` (multi-turn с custom MCP server).

Создаёт собственный MCP сервер через `ExtractionToolsProvider.createMcpServer()` с 6 специализированными tools. Claude самостоятельно решает, какие tools вызвать и какие данные извлечь.

Особенности:
- Обогащает сообщения информацией о reply-to и получателях обещаний
- Использует `outputFormat` для структурированного результата после tool calls

### DraftExtractionService — Central Dedup & Creation

Центральный сервис создания draft entities. Все три пути извлечения делегируют ему создание сущностей.

**Трёхпроходная дедупликация фактов:**
1. **Pass 1:** Гибридная проверка — Levenshtein (текст) + cosine similarity (embeddings)
2. **Pass 2:** LLM review для "серой зоны" (неоднозначные совпадения)
3. **Pass 3:** Создание approved drafts

**Smart Fusion** через `FactFusionService.decideFusion()`:
- `CONFIRM` — новый факт подтверждает существующий
- `SUPERSEDE` — новый факт заменяет устаревший
- `ENRICH` — новый факт дополняет существующий
- `CONFLICT` — противоречие, требует разрешения
- `COEXIST` — оба факта верны одновременно

**Дедупликация проектов:**
- Двухуровневая: 0.6-0.8 (weak match, запрос LLM), >= 0.8 (strong match, считается дубликатом)
- Учитывает клиента, tags, description для boost
- Проверяет pending approvals для предотвращения создания дублей draft entities

**Дедупликация задач:**
- Pending approvals check + fuzzy Levenshtein (>= 0.7) + semantic embedding cosine (>= 0.85)

**Activity insert** использует QueryBuilder вместо `save()` для обхода бага TypeORM closure-table.

---

## Pending Approval Workflow

### Обзор

Draft Entities Pattern — все извлечённые данные создаются как черновики (status = `DRAFT`) и требуют подтверждения перед активацией. Это обеспечивает контроль качества извлечённых данных.

### Flow

```
Extraction Pipeline
       │
       ▼
┌──────────────────────────┐
│  DraftExtractionService  │
│  creates entity with     │
│  status = DRAFT          │
│          +               │
│  PendingApproval record  │
│  (links to target)       │
└──────────┬───────────────┘
           │
     ┌─────▼─────┐
     │  Telegram  │  Carousel UI или
     │  Dashboard │  REST API
     └─────┬─────┘
           │
     ┌─────┴─────┐
     │           │
  Approve     Reject
     │           │
     ▼           ▼
  status =    soft delete
  ACTIVE      (deletedAt)
```

### ItemTypeRegistry

Единый источник правды для маппинга типов `PendingApproval` на target entities:

| ItemType | Entity Class | Table | Active Status | Draft Status |
|----------|-------------|-------|---------------|-------------|
| `FACT` | `EntityFact` | `entity_facts` | `active` | `draft` |
| `PROJECT` | `Activity` | `activities` | `active` | `draft` |
| `TASK` | `Activity` | `activities` | `active` | `draft` |
| `COMMITMENT` | `Commitment` | `commitments` | `pending` | `draft` |

**Расширение:** Для добавления нового типа достаточно добавить запись в `ITEM_TYPE_REGISTRY` — все сервисы подхватят автоматически.

### Операции

| Операция | Метод | Описание |
|----------|-------|----------|
| `approve(id)` | `PendingApprovalService.approve()` | Target entity: `DRAFT` → `ACTIVE`. PendingApproval: `pending` → `approved` |
| `reject(id)` | `PendingApprovalService.reject()` | Target entity: soft delete. PendingApproval: `pending` → `rejected` |
| `approveAll()` | Batch | Массовое подтверждение всех pending |
| `rejectAll()` | Batch | Массовое отклонение всех pending |

### Файлы

| Файл | Описание |
|------|----------|
| `pending-approval.service.ts` | CRUD и batch операции над PendingApproval |
| `item-type-registry.ts` | Registry маппинга ItemType → EntityClass, table, statuses |
| `pending-approval.controller.ts` | REST endpoints: list, approve, reject, batch |
| `confirmation-handlers/` | Telegram UI: carousel с кнопками approve/reject |

---

## Segmentation & Knowledge Packing

### Обзор

Система сегментации разбивает переписку на тематические блоки (TopicalSegment), а затем консолидирует знания из связанных сегментов в компактные пакеты (KnowledgePack). Это обеспечивает структурированное хранение и быстрый доступ к знаниям по проектам и людям.

```
Messages ──► TopicBoundaryDetector ──► TopicalSegments ──► PackingService ──► KnowledgePacks
               (Claude, hourly)          (per topic)         (Claude, weekly)    (per activity)
                     │                       │                      │
                     │                       │                      │
              SegmentationJob          OrphanSegmentLinker     PackingJob
              (cron: 0 * * * *)        (fuzzy → Activity)     (cron: 0 3 * * 0)
```

### TopicBoundaryDetectorService

Определяет границы тем в переписке с помощью Claude (semantic segmentation).

**Алгоритм:**
1. **Pre-filter:** минимум 4 сообщения для сегментации
2. **Split by time gaps:** разбивка на chunks по паузам > 60 минут
3. **Batch limit:** максимум 80 сообщений на вызов Claude (больше вызывает ошибки structured output)
4. **Claude call:** `oneshot` mode, модель `sonnet`, timeout 180s, maxTurns 7
5. **Validation:** фильтрация сегментов с confidence < 0.5, минимум 2 сообщения в сегменте
6. **Dedup indices:** каждое сообщение принадлежит максимум одному сегменту

**Prompt:** На русском языке. Claude определяет:
- Границы тем (topic_change, time_gap, explicit_marker)
- Название каждого сегмента (конкретное, не абстрактное)
- Summary, keywords, isWorkRelated
- `skippedMessageIndices` для сообщений без контекста (приветствия, emoji)

### SegmentationJobService — Hourly Cron

**Расписание:** `0 * * * *` (каждый час, Europe/Moscow).
**Feature flag:** `segmentation.autoEnabled` (default: true).

**Алгоритм:**
1. Находит чаты с >= 4 несегментированных сообщений (агрегация по `telegram_chat_id`, не по interaction)
2. Lookback: 48 часов
3. Для каждого чата загружает все unsegmented messages across all interactions
4. Вызывает `TopicBoundaryDetector.detectAndCreate()`
5. Линкует связанные сегменты через `SegmentationService.findRelatedSegments()`
6. Inter-call delay: 2s для rate limiting

### PackingService

Консолидирует TopicalSegments в KnowledgePacks через Claude synthesis.

**Три режима пакования:**

| Метод | Описание | Scope |
|-------|----------|-------|
| `packByActivity(activityId)` | Все сегменты привязанные к Activity | По проекту/задаче |
| `packByEntity(entityId)` | Сегменты с данным primary participant | По человеку |
| `packByPeriod(chatId, dates)` | Сегменты в чате за период | По времени |

**Flow:**
1. Загрузка packable segments (статусы `ACTIVE`, `CLOSED`)
2. Batch-загрузка сообщений для всех сегментов (один SQL, без N+1)
3. Claude synthesis (oneshot, sonnet, timeout 180s)
4. Supersession: существующие ACTIVE packs для того же scope помечаются `SUPERSEDED`
5. Создание KnowledgePack record
6. Пометка segments как `PACKED` с ссылкой на `knowledgePackId`

**KnowledgePack содержит:**
- `summary` — консолидированная сводка (3-5 абзацев)
- `decisions[]` — ключевые решения с контекстом
- `openQuestions[]` — нерешённые вопросы
- `keyFacts[]` — важные факты с confidence
- `conflicts[]` — обнаруженные противоречия между сегментами

### OrphanSegmentLinkerService

Привязывает "осиротевшие" сегменты (без `activityId`) к Activities через fuzzy matching.

**Алгоритм:**
1. Из сегмента получает `participantIds` (или resolves через `interactionId`)
2. Для каждого участника ищет Activities (PROJECT/TASK/INITIATIVE, не ARCHIVED/CANCELLED)
3. Сравнивает `segment.topic + segment.summary` с `activity.name + activity.description`
4. Levenshtein similarity через `ProjectMatchingService`
5. Если similarity >= 0.8 — привязывает сегмент к лучшей Activity

### PackingJobService — Weekly Cron

**Расписание:** `0 3 * * 0` (воскресенье 03:00, Europe/Moscow).
**Feature flag:** `packing.autoEnabled` (default: true).

**Flow:**
1. Запуск `OrphanSegmentLinker.linkAllOrphans()` — максимизация coverage
2. Поиск Activities с >= 2 packable segments
3. Для каждой Activity вызов `PackingService.packByActivity()`

### Knowledge Agent Tools

`KnowledgeToolsProvider` (категория `knowledge`, 4 tools):

| Tool | Описание |
|------|----------|
| `search_discussions` | Поиск сегментов по теме, участнику, чату |
| `get_discussion_context` | Полный контекст сегмента с сообщениями |
| `get_knowledge_summary` | KnowledgePacks для Activity или Entity |
| `trace_fact_source` | Трассировка факта/обязательства к исходному сегменту |

### Файлы

| Файл | Описание |
|------|----------|
| `segmentation.service.ts` | CRUD для TopicalSegment и KnowledgePack |
| `topic-boundary-detector.service.ts` | Claude-based определение границ тем |
| `topic-boundary-detector.types.ts` | Типы и JSON Schema для сегментации |
| `segmentation-job.service.ts` | Hourly cron для автосегментации |
| `packing.service.ts` | Консолидация сегментов в KnowledgePacks |
| `packing.types.ts` | Типы и JSON Schema для packing synthesis |
| `packing-job.service.ts` | Weekly cron для автопакования |
| `orphan-segment-linker.service.ts` | Привязка orphan segments к Activities |
| `knowledge-tools.provider.ts` | Agent tools для knowledge/segmentation |

---

## База данных

### Централизованная PostgreSQL

Проект использует **единую удалённую базу данных** для всех окружений (development, staging, production).

**Преимущества:**
- Единая точка истины для данных
- Нет необходимости синхронизировать данные между окружениями
- Упрощённый деплой — не нужен локальный PostgreSQL
- pgvector установлен и настроен

**Подключение:**
```bash
# Получите credentials у администратора
# Скопируйте .env.example в .env и заполните значения

# Переменные окружения
DB_HOST=your-db-host
DB_PORT=5432
DB_USERNAME=your-username
DB_PASSWORD=your-password
DB_DATABASE=pkg
DB_SSL=true  # Рекомендуется для remote connections
```

**Миграции:**
```bash
cd apps/pkg-core
npm run migration:run    # Применить миграции
npm run migration:revert # Откатить последнюю
```

> ⚠️ **ВАЖНО:** `synchronize: false` всегда! Используем только миграции.

---

## Deployment

### Option A: Single Server (Dev / Small Scale)

```
┌────────────────────────────────────────────────────────────────┐
│                      VPS / Home Server                         │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Telegram │  │ PKG Core │  │   n8n    │  │  PostgreSQL  │  │
│  │ Adapter  │  │  :3000   │  │  :5678   │  │   + Redis    │  │
│  │  :3001   │  │          │  │          │  │              │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │
│                                                                │
│  • Claude Code CLI installed                                   │
│  • Whisper installed                                           │
│  • Shared file storage: /data/files                            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Option B: Docker Compose

```yaml
version: '3.8'

services:
  telegram-adapter:
    build: ./telegram-adapter
    environment:
      PKG_CORE_URL: http://pkg-core:3000
      FILE_STORAGE_PATH: /data/files
    volumes:
      - ./session:/app/session
      - file-storage:/data/files
    depends_on:
      - pkg-core

  pkg-core:
    build: ./pkg-core
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://pkg:pkg@postgres:5432/pkg
      REDIS_URL: redis://redis:6379
      WORKER_WEBHOOK_URL: http://n8n:5678/webhook
      FILE_STORAGE_PATH: /data/files
    volumes:
      - file-storage:/data/files
    depends_on:
      - postgres
      - redis

  n8n:
    image: n8nio/n8n
    ports:
      - "5678:5678"
    environment:
      PKG_CORE_URL: http://pkg-core:3000
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    volumes:
      - n8n-data:/home/node/.n8n
      - ./workdir:/workdir
      - file-storage:/data/files

  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: pkg
      POSTGRES_PASSWORD: pkg
      POSTGRES_DB: pkg
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

volumes:
  postgres-data:
  redis-data:
  n8n-data:
  file-storage:
```

---

## Масштабирование

### Horizontal Scaling

| Сервис | Масштабируемость | Примечания |
|--------|------------------|------------|
| Telegram Adapter | Нет (1 instance per account) | Telegram session привязана к одному процессу |
| PKG Core | Да | Stateless, можно запустить несколько instances за load balancer |
| Worker (n8n) | Да | Можно распределить workflows между instances |
| PostgreSQL | Vertical + Read replicas | pgvector требует основной инстанс для write |

### Performance Considerations

- **Embeddings:** Генерируются асинхронно в очереди, не блокируют основной поток
- **Search:** Hybrid search (FTS + vector) с ограничением кандидатов для vector search
- **Large conversations:** Tiered retrieval — недавние полностью, старые через summaries
