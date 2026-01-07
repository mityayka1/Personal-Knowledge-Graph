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

## Architecture

| Термин | Определение |
|--------|-------------|
| **Telegram Adapter** | Сервис для подключения к Telegram. |
| **PKG Core** | Центральный сервис с данными и API. |
| **Adapter** | Компонент интеграции источника данных. |
| **Source-Agnostic** | Core логика не зависит от источника. |

## Technical

| Термин | Определение |
|--------|-------------|
| **pgvector** | PostgreSQL extension для vector search. |
| **BullMQ** | Redis-based queue для Node.js. |
| **GramJS** | Библиотека для Telegram MTProto API. |
| **TypeORM** | ORM для TypeScript. |
| **NestJS** | Node.js backend framework. |

## Metrics

| Термин | Определение |
|--------|-------------|
| **Resolution Rate** | Процент автоматически resolved identifiers. |
| **Confidence Score** | Оценка уверенности 0.0-1.0. |
