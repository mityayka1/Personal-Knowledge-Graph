# Глоссарий

## Основные термины

| Термин | Определение |
|--------|-------------|
| **Entity** | Человек (person) или организация (organization), с которой происходят взаимодействия. Центральная сущность системы. |
| **Interaction** | Единица взаимодействия — сессия чата, телефонный звонок или видео-встреча. Группирует связанный контент. |
| **Message** | Текстовое сообщение из Telegram или другого источника. Принадлежит Interaction. |
| **Transcript Segment** | Сегмент транскрипции аудио/видео с указанием говорящего и таймкодов. |

## Entity Resolution

| Термин | Определение |
|--------|-------------|
| **Entity Identifier** | Идентификатор сущности во внешней системе (telegram_user_id, phone, email). |
| **Entity Resolution** | Процесс связывания входящего идентификатора с Entity. |
| **Pending Entity Resolution** | Идентификатор, который не удалось автоматически связать. Ожидает ручного разрешения. |
| **Suggestions** | Предложения от системы по связыванию pending resolution с entities. |

## Entity Facts

| Термин | Определение |
|--------|-------------|
| **Entity Fact** | Структурированный атрибут сущности (день рождения, должность, контакты). |
| **Fact Type** | Категория факта: birthday, position, phone_work, inn и т.д. |
| **Fact Source** | Источник: manual, extracted, imported. |
| **Pending Fact** | Извлечённый факт с confidence < 0.9, ожидающий подтверждения. |
| **Valid From / Valid Until** | Период актуальности факта для хранения истории. |

## Sessions и Interactions

| Термин | Определение |
|--------|-------------|
| **Session** | Логическая группа сообщений Telegram. Новая при gap > 4 часов. |
| **Session Gap** | Временной интервал между сообщениями. Default: 4 часа. |
| **Interaction Type** | Тип: telegram_session, phone_call, video_meeting. |
| **Interaction Status** | Состояние: active, completed, pending_review, processing, error. |

## Search и Retrieval

| Термин | Определение |
|--------|-------------|
| **Context** | Структурированная сводка по Entity для LLM или подготовки к взаимодействию. |
| **Task Hint** | Подсказка для фокусировки контекста на конкретной задаче. |
| **Full-Text Search (FTS)** | Поиск по точному совпадению слов. PostgreSQL tsvector. |
| **Vector Search** | Семантический поиск по embeddings. pgvector. |
| **Hybrid Search** | Комбинация FTS и Vector с RRF. |
| **RRF** | Reciprocal Rank Fusion — алгоритм объединения результатов. |
| **Embedding** | Векторное представление текста (1536 dim для text-embedding-3-small). |

## Tiered Retrieval

| Термин | Определение |
|--------|-------------|
| **Tiered Retrieval** | Стратегия: недавние данные полностью, старые через summaries. |
| **Interaction Summary** | Компактное описание взаимодействия с key points. |
| **Hot Data** | Недавние данные < 7 дней, доступные полностью. |
| **Warm Data** | 7-30 дней, доступны через summaries. |
| **Cold Data** | > 30 дней, archived или только через search. |

## Automation

| Термин | Определение |
|--------|-------------|
| **Worker** | Сервис для асинхронных задач (n8n + Claude Code CLI). |
| **n8n** | Self-hosted workflow automation platform. |
| **Claude Code CLI** | CLI для выполнения LLM задач в headless режиме. |
| **Webhook** | HTTP callback для запуска workflows. |
| **Job** | Единица асинхронной работы. |

## Phone Call Processing

| Термин | Определение |
|--------|-------------|
| **Transcription** | Преобразование аудио в текст (Whisper). |
| **Diarization** | Разделение аудио по говорящим. |
| **Speaker Mapping** | Определение кто из speakers какой Entity. |
| **Speaker Label** | Метка говорящего (Speaker_0, Speaker_1). |

## Activity Management (Phase D)

| Термин | Определение |
|--------|-------------|
| **Activity** | Иерархическая единица деятельности. Типы: AREA → BUSINESS → PROJECT → TASK → MILESTONE. Использует closure-table для дерева. |
| **Activity Type** | Тип активности: `AREA` (направление), `BUSINESS` (бизнес), `PROJECT` (проект), `TASK` (задача), `MILESTONE` (веха). Иерархия строго определена HIERARCHY_RULES. |
| **Activity Status** | Состояние: `IDEA`, `ACTIVE`, `PAUSED`, `COMPLETED`, `ARCHIVED`. |
| **Activity Member** | Участник активности — связка Entity + Activity с ролью (owner, member, observer). |
| **Commitment** | Обещание или обязательство между людьми. Типы: PROMISE, REQUEST, AGREEMENT, FOLLOW_UP. Привязывается к Activity через `activityId`. |
| **Commitment Status** | Состояние: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `BROKEN`, `CANCELLED`. |
| **Project Matching** | Fuzzy matching через `ProjectMatchingService` для предотвращения дубликатов проектов. Two-tier: 0.6–0.8 слабое совпадение, ≥0.8 сильное. |
| **Client Resolution** | 3-стратегийное определение клиента для Activity через `ClientResolutionService`: explicit mention → chat context → participant analysis. |
| **Activity Validation** | Валидация иерархии типов (HIERARCHY_RULES) и предотвращение циклов через `ActivityValidationService`. |

## Extraction Pipeline (Phase C–D)

| Термин | Определение |
|--------|-------------|
| **Extraction Pipeline** | Система извлечения структурированных данных из переписки. Три пути: SecondBrain (real-time), DailySynthesis (batch), Unified (agent mode). |
| **SecondBrain Extraction** | Real-time extraction из Telegram. Обрабатывает новые сообщения, использует Claude для oneshot extraction. |
| **DailySynthesis Extraction** | Batch-extraction из daily synthesis. Проходит через DraftExtractionService с полным набором сервисов (fuzzy matching, dedup, client resolution). |
| **Unified Extraction** | Agent-mode extraction для приватных чатов. Использует Claude agent с tools (create_fact, create_event). |
| **Draft Extraction** | Промежуточный этап — создание черновых entities (Activity, Commitment) через `DraftExtractionService` с dedup, matching и validation. |
| **Extracted Event** | Событие, извлечённое из переписки: встреча, дедлайн, напоминание. Хранится в `EntityEvent`. |
| **Smart Fusion** | Алгоритм `FactFusionService` для слияния новых фактов с существующими. Обнаруживает обновления, конфликты и новые данные. |
| **Task Dedup** | Дедупликация задач при extraction: Levenshtein similarity ≥ 0.7 пропускает создание. |
| **Semantic Dedup** | Дедупликация через cosine similarity embeddings (порог 0.92) для более точного сравнения. |
| **Quality Filters** | Фильтры `isVagueContent()` и `isNoiseContent()` для отсеивания нечётких и мусорных extraction. |

## Pending Approval (Phase C–D)

| Термин | Определение |
|--------|-------------|
| **Pending Approval** | Извлечённый элемент (факт, задача, обязательство), ожидающий подтверждения пользователем. |
| **Approval Batch** | Группа pending approvals от одного extraction run. Отправляется как carousel в Telegram. |
| **Confirmation System** | Обработка approve/reject действий пользователя. Обработчики: `fact_created`, (TODO: `fact_value`, `identifier_attributed`, `entity_merged`). |

## Knowledge System (Phase E)

| Термин | Определение |
|--------|-------------|
| **Topical Segment** | Семантический сегмент обсуждения — группа сообщений на одну тему. Many-to-many с messages. Создаётся Claude через `TopicBoundaryDetectorService`. |
| **Knowledge Pack** | Консолидированные знания по Activity или Entity. Типы: `weekly_digest`, `activity_summary`. Создаётся `PackingService`. |
| **Topic Boundary Detection** | Claude-based определение границ тем в переписке. Чанки по ≤80 сообщений, разбивка по time gaps (60 мин). |
| **Segmentation Job** | Cron-задача (каждый час) для обработки unsegmented messages через `SegmentationJobService`. |
| **Orphan Segment Linker** | `OrphanSegmentLinkerService` — автоматическая привязка сегментов без `activityId` к активностям через keyword/embedding matching. |
| **Cross-Chat Topic Linking** | Связывание сегментов из разных чатов по одной теме через embedding similarity. |
| **Entity Disambiguation** | Разрешение неоднозначных упоминаний сущностей в тексте (когда имя может относиться к нескольким Entity). |
| **Packing Service** | Еженедельная упаковка topical segments в knowledge packs. Только сегменты с `activityId`. |

## Data Quality (Phase D.6)

| Термин | Определение |
|--------|-------------|
| **Data Quality Report** | JSONB отчёт аудита: metrics, issues, resolutions. Статусы: PENDING, REVIEWED, RESOLVED. |
| **Data Quality Audit** | Полный аудит БД: поиск дубликатов (LOWER(name) + type), orphaned tasks, missing relations. |
| **Merge** | Слияние двух Entity: перенос всех FK references (identifiers, facts, interactions) на target, удаление source. |
| **Orphan Activity** | Task/Milestone без parent activity (PROJECT/BUSINESS). Разрешается через `OrphanResolutionService`. |

## Agent System

| Термин | Определение |
|--------|-------------|
| **Claude Agent SDK** | SDK от Anthropic для построения AI-агентов. Используется в PKG для recall, prepare, extraction. |
| **Tools Provider** | Injectable NestJS сервис, предоставляющий MCP tools. Самостоятельно регистрируется в ToolsRegistry через `onModuleInit()`. |
| **Tools Registry** | Центральный реестр всех tool providers. `ToolsRegistryService` в `ClaudeAgentCoreModule`. |
| **MCP Server** | Model Context Protocol server — in-process сервер, предоставляющий tools агенту. Создаётся через `createSdkMcpServer()`. |
| **Recall** | AI-powered поиск по базе знаний в естественном языке. `POST /agent/recall`. |
| **Prepare / Meeting Brief** | Генерация структурированного контекста для подготовки к встрече с Entity. `POST /agent/prepare/:entityId`. |
| **Morning Brief** | Ежедневная проактивная сводка: встречи, дедлайны, дни рождения, просроченные задачи. Отправляется в Telegram. |

## Notifications (Phase C)

| Термин | Определение |
|--------|-------------|
| **Entity Event** | Событие, привязанное к Entity: встреча, дедлайн, commitment, follow-up. Типы в `EventType` enum. |
| **Event Status** | Состояние события: `SCHEDULED`, `COMPLETED`, `CANCELLED`, `MISSED`. |
| **Digest** | Дайджест новых извлечённых данных за период. Отправляется как summary в Telegram. |

## Architecture

| Термин | Определение |
|--------|-------------|
| **Telegram Adapter** | Сервис для подключения к Telegram (GramJS/MTProto). Userbot + Bot mode. |
| **PKG Core** | Центральный сервис с данными, API, extraction pipeline и agent system. |
| **Adapter** | Компонент интеграции источника данных. |
| **Source-Agnostic** | Core логика не зависит от источника. Все клиенты работают через PKG Core. |
| **Cross-Chat Context** | Контекст из других чатов за последние N минут (default: 120 мин). Используется при extraction для обогащения. |

## Technical

| Термин | Определение |
|--------|-------------|
| **pgvector** | PostgreSQL extension для vector search. |
| **BullMQ** | Redis-based queue для Node.js. |
| **GramJS** | Библиотека для Telegram MTProto API. |
| **TypeORM** | ORM для TypeScript. Activity использует closure-table (`@Tree('closure-table')`). |
| **NestJS** | Node.js backend framework. |
| **Closure Table** | Паттерн хранения деревьев в РСУБД. TypeORM 0.3.x имеет баг с `save()` — используем QueryBuilder для Activity. |
| **Levenshtein Distance** | Метрика расстояния между строками. Используется для fuzzy matching проектов и task dedup. |

## Metrics

| Термин | Определение |
|--------|-------------|
| **Resolution Rate** | Процент автоматически resolved identifiers. |
| **Confidence Score** | Оценка уверенности 0.0-1.0. |
