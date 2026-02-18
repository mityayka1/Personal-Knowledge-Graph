# Модель данных PKG

## Обзор

Модель данных построена вокруг трёх ключевых абстракций:
- **Entity** — человек или организация
- **Interaction** — единица взаимодействия (сессия чата, звонок, встреча)
- **Content** — содержимое взаимодействия (сообщения, сегменты транскрипции)

Дополнительные кластеры:
- **Activity** — иерархическая модель всех дел (проекты, задачи, направления)
- **Knowledge** — семантическая сегментация и упаковка знаний
- **Relationships** — связи между сущностями с ролями
- **Approval** — потоки подтверждения извлечённых данных

## ER-диаграмма

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           CORE CLUSTER                                              │
│                                                                                     │
│  ┌─────────────┐        ┌─────────────────┐        ┌─────────────────┐             │
│  │   Entity    │───────►│ EntityIdentifier │        │  EntityFact     │             │
│  │             │ 1   n  │                 │        │                 │             │
│  │  • Person   │        │ • telegram_id   │        │ • birthday      │             │
│  │  • Org      │◄───────│ • phone         │        │ • position      │             │
│  └──────┬──────┘        └─────────────────┘        │ • inn           │             │
│         │                                          └────────┬────────┘             │
│         │ 1                                                 │ n                    │
│         │                                                   │                      │
│         ▼ n                                                 │                      │
│  ┌──────────────────┐                               ┌───────▼────────┐             │
│  │InteractionPartic.│◄──────────────────────────────│    Entity      │             │
│  └────────┬─────────┘                               └────────────────┘             │
│           │ n                                                                      │
│           ▼ 1                                                                      │
│  ┌──────────────────┐                                                              │
│  │   Interaction    │                                                              │
│  │ • tg_session     │                                                              │
│  │ • phone_call     │                                                              │
│  └────────┬─────────┘                                                              │
│           │ 1                                                                      │
│           ▼ n                                                                      │
│  ┌──────────────────┐        ┌─────────────────┐                                   │
│  │    Message       │        │TranscriptSegment│                                   │
│  │ (telegram, etc.) │        │ (phone calls)   │                                   │
│  └────────┬─────────┘        └─────────────────┘                                   │
│           │                                                                        │
├───────────┼────────────────────────────────────────────────────────────────────────-┤
│           │        EXTRACTION & ACTIVITY CLUSTER                                    │
│           │                                                                        │
│           ▼ n                                                                      │
│  ┌──────────────────┐        ┌─────────────────┐        ┌─────────────────┐        │
│  │ ExtractedEvent   │───────►│   Commitment    │───────►│   Activity      │        │
│  │ • meeting        │        │ • promise       │        │ (closure-table) │        │
│  │ • promise        │        │ • agreement     │        │                 │        │
│  │ • task           │        │ • deadline      │        │ • AREA          │        │
│  │ • fact           │        └─────────────────┘        │ • BUSINESS      │        │
│  └──────────────────┘                                   │ • PROJECT       │        │
│                                                         │ • TASK          │        │
│           ┌─────────────────┐                           └────────┬────────┘        │
│           │ ActivityMember  │◄───────────────────────────────────┘ 1:n             │
│           │ • owner         │                                                      │
│           │ • assignee      │                                                      │
│           │ • client        │                                                      │
│           └─────────────────┘                                                      │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                    KNOWLEDGE CLUSTER                                                │
│                                                                                     │
│  ┌──────────────────┐  n:m   ┌─────────────────┐  n:1   ┌─────────────────┐        │
│  │    Message       │◄──────►│ TopicalSegment  │───────►│  KnowledgePack  │        │
│  │                  │        │ • topic         │        │  • summary      │        │
│  │                  │        │ • keywords      │        │  • decisions    │        │
│  └──────────────────┘        └─────────────────┘        │  • key_facts   │        │
│                                                         └─────────────────┘        │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                    APPROVAL & SYSTEM CLUSTER                                        │
│                                                                                     │
│  ┌──────────────────┐  ┌───────────────────┐  ┌───────────────────────┐             │
│  │ PendingApproval  │  │PendingConfirmation│  │ DataQualityReport    │             │
│  │ (polymorphic →   │  │ • fact_subject    │  │ • metrics            │             │
│  │  Fact/Activity/  │  │ • entity_merge    │  │ • issues             │             │
│  │  Commitment)     │  │ • id_attribution  │  │ • resolutions        │             │
│  └──────────────────┘  └───────────────────┘  └───────────────────────┘             │
│                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                    RELATIONSHIPS CLUSTER                                             │
│                                                                                     │
│  ┌──────────────────┐  1:n   ┌─────────────────────────┐                            │
│  │ EntityRelation   │───────►│ EntityRelationMember    │                            │
│  │ • employment     │        │ • role                  │                            │
│  │ • marriage       │        │ • label                 │                            │
│  │ • team           │        └─────────────────────────┘                            │
│  └──────────────────┘                                                               │
│                              ┌─────────────────────────┐                            │
│  ┌──────────────────┐        │EntityRelationshipProfile│                            │
│  │ GroupMembership  │        │ (1:1 with Entity)       │                            │
│  │ (Telegram groups)│        │ • summary, milestones   │                            │
│  └──────────────────┘        └─────────────────────────┘                            │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Таблицы

### entities

Люди и организации, с которыми происходят взаимодействия.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| type | ENUM | 'person' \| 'organization' |
| name | VARCHAR(255) | Отображаемое имя |
| organization_id | UUID | FK → entities (для person, связь с организацией) |
| notes | TEXT | Свободные заметки пользователя |
| profile_photo | TEXT | Base64 фото профиля (data:image/jpeg;base64,...) |
| is_bot | BOOLEAN | TRUE для Telegram ботов (исключаются из summarization/context) |
| creation_source | ENUM | 'manual', 'private_chat', 'working_group' |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

**Индексы:** name (для поиска), organization_id, is_bot (partial WHERE is_bot = true)

---

### entity_identifiers

Идентификаторы сущностей во внешних системах. Используются для Entity Resolution.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| entity_id | UUID | FK → entities |
| identifier_type | VARCHAR(50) | 'telegram_user_id', 'phone', 'email' |
| identifier_value | VARCHAR(255) | Значение идентификатора |
| metadata | JSONB | Дополнительные данные (telegram_username, display_name) |
| created_at | TIMESTAMP | |

**Constraints:** UNIQUE(identifier_type, identifier_value)

---

### entity_facts

Структурированные атрибуты сущностей с историей изменений.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| entity_id | UUID | FK → entities |
| fact_type | VARCHAR(50) | 'birthday', 'position', 'inn', 'phone_work', etc. |
| category | VARCHAR(50) | 'personal', 'contact', 'professional', 'business', 'legal' |
| value | VARCHAR(500) | Текстовое значение |
| value_date | DATE | Для дат (birthday) |
| value_json | JSONB | Для структурированных данных |
| source | VARCHAR(20) | 'manual', 'extracted', 'imported' |
| confidence | DECIMAL(3,2) | 0.00-1.00 для extracted фактов |
| source_interaction_id | UUID | FK → interactions (откуда извлечено) |
| valid_from | DATE | Начало актуальности |
| valid_until | DATE | Конец актуальности (NULL = текущий) |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

---

### interactions

Единицы взаимодействия — сессии чатов, звонки, встречи.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| type | VARCHAR(50) | 'telegram_session', 'phone_call', 'video_meeting' |
| source | VARCHAR(50) | 'telegram', 'manual_upload', 'google_meet' |
| status | VARCHAR(20) | 'active', 'completed', 'pending_review' |
| started_at | TIMESTAMP | Начало взаимодействия |
| ended_at | TIMESTAMP | Конец (NULL для активных) |
| source_metadata | JSONB | Метаданные источника (chat_id, call_duration, etc.) |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

---

### interaction_participants

Связь взаимодействий с участниками.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| interaction_id | UUID | FK → interactions |
| entity_id | UUID | FK → entities (NULL если pending resolution) |
| role | VARCHAR(50) | 'self', 'participant', 'initiator' |
| identifier_type | VARCHAR(50) | 'telegram_user_id', 'phone' |
| identifier_value | VARCHAR(255) | Исходный идентификатор |
| display_name | VARCHAR(255) | Имя на момент взаимодействия |

---

### messages

Сообщения из Telegram и других текстовых источников.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| interaction_id | UUID | FK → interactions |
| sender_entity_id | UUID | FK → entities (NULL если pending) |
| sender_identifier_type | VARCHAR(50) | 'telegram_user_id', 'phone' |
| sender_identifier_value | VARCHAR(255) | Значение идентификатора отправителя |
| content | TEXT | Текст сообщения |
| is_outgoing | BOOLEAN | TRUE если отправлено пользователем |
| timestamp | TIMESTAMP | Время сообщения |
| source_message_id | VARCHAR(100) | ID в исходной системе |
| reply_to_message_id | UUID | FK → messages (resolved) |
| reply_to_source_message_id | VARCHAR(100) | ID reply_to в исходной системе |
| media_type | VARCHAR(50) | 'photo', 'document', 'voice', 'video', 'video_note', 'sticker', 'animation' |
| media_url | VARCHAR(500) | Путь к файлу (deprecated, используй media_metadata) |
| media_metadata | JSONB | Метаданные для скачивания медиа (см. ниже) |
| chat_type | VARCHAR(20) | 'private', 'group', 'supergroup', 'channel', 'forum' |
| topic_id | INTEGER | ID топика форума |
| topic_name | VARCHAR(255) | Название топика форума |
| embedding | VECTOR(1536) | Для semantic search |
| extraction_status | VARCHAR(20) | 'unprocessed', 'pending', 'processing', 'processed', 'error' |
| extraction_metadata | JSONB | {relevanceScore, extractedAt, factsFound, eventsFound, errorMessage} |
| importance_score | DECIMAL(3,2) | 0.00-1.00 для summarization |
| importance_reason | VARCHAR(50) | 'has_date', 'has_amount', 'has_agreement', 'has_deadline', 'long_message' |
| is_archived | BOOLEAN | TRUE для архивированных сообщений |
| archived_at | TIMESTAMP | Время архивации |
| created_at | TIMESTAMP | |

**media_metadata JSONB структура:**
```json
{
  "id": "telegram_file_id",
  "accessHash": "access_hash_string",
  "fileReference": "base64_encoded_file_reference",
  "dcId": 2,
  "sizes": [{"type": "x", "width": 800, "height": 600, "size": 45000}],
  "mimeType": "video/mp4",
  "size": 1234567,
  "fileName": "document.pdf",
  "duration": 120,
  "width": 1920,
  "height": 1080,
  "hasThumb": true
}
```

**FTS:** GIN index на content для full-text search
**Индексы:** media_metadata (GIN, partial WHERE NOT NULL)

---

### transcript_segments

Сегменты транскрипции для звонков и видео.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| interaction_id | UUID | FK → interactions |
| speaker_entity_id | UUID | FK → entities (NULL если pending) |
| speaker_label | VARCHAR(50) | 'Speaker_0', 'Speaker_1' (из diarization) |
| content | TEXT | Текст сегмента |
| start_time | DECIMAL(10,3) | Секунды от начала |
| end_time | DECIMAL(10,3) | Секунды |
| confidence | DECIMAL(3,2) | Confidence транскрипции |
| embedding | VECTOR(1536) | Для semantic search |
| created_at | TIMESTAMP | |

---

### interaction_summaries

Суммарные описания для tiered retrieval старых взаимодействий.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| interaction_id | UUID | FK → interactions (UNIQUE) |
| summary_text | TEXT | Краткое описание (100-200 слов) |
| key_points | JSONB | Массив ключевых моментов |
| decisions | JSONB | Массив решений |
| action_items | JSONB | Массив action items |
| facts_extracted | JSONB | Извлечённые факты |
| embedding | VECTOR(1536) | Embedding summary |
| created_at | TIMESTAMP | |

---

### pending_entity_resolutions

Идентификаторы, ожидающие связывания с Entity.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| identifier_type | VARCHAR(50) | 'telegram_user_id', 'phone' |
| identifier_value | VARCHAR(255) | |
| display_name | VARCHAR(255) | Имя из источника |
| status | VARCHAR(20) | 'pending', 'resolved', 'ignored' |
| resolved_entity_id | UUID | FK → entities (после resolution) |
| suggestions | JSONB | Предложения от Worker `[{entity_id, name, confidence, reason}]` |
| sample_message_ids | JSONB | Примеры сообщений для анализа |
| first_seen_at | TIMESTAMP | |
| resolved_at | TIMESTAMP | |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

**Constraints:** UNIQUE(identifier_type, identifier_value)

---

### pending_facts

Извлечённые факты, ожидающие подтверждения.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| entity_id | UUID | FK → entities |
| fact_type | VARCHAR(50) | |
| value | VARCHAR(500) | |
| value_date | DATE | |
| confidence | DECIMAL(3,2) | |
| source_quote | TEXT | Цитата из источника |
| source_interaction_id | UUID | FK → interactions |
| source_message_id | UUID | FK → messages |
| status | VARCHAR(20) | 'pending', 'approved', 'rejected' |
| created_at | TIMESTAMP | |
| reviewed_at | TIMESTAMP | |

---

### jobs

Очередь асинхронных задач.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| type | VARCHAR(50) | 'transcription', 'embedding', 'summarization' |
| status | VARCHAR(20) | 'pending', 'processing', 'completed', 'failed' |
| payload | JSONB | Данные задачи |
| result | JSONB | Результат выполнения |
| error | TEXT | Ошибка если failed |
| attempts | INTEGER | Количество попыток |
| created_at | TIMESTAMP | |
| started_at | TIMESTAMP | |
| completed_at | TIMESTAMP | |

---

### chat_categories

Категоризация чатов для управления автоматическим созданием Entity.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| telegram_chat_id | VARCHAR(100) | Уникальный ID чата (channel_123, user_456) |
| category | ENUM | 'personal', 'working', 'mass' |
| title | VARCHAR(255) | Название чата/контакта |
| participants_count | INTEGER | Количество участников |
| auto_extraction_enabled | BOOLEAN | Включено ли автоизвлечение фактов |
| is_forum | BOOLEAN | Является ли чат форумом (с топиками) |
| created_at | TIMESTAMP | |
| updated_at | TIMESTAMP | |

**Категории:**
- `personal` — приватные чаты, Entity создаются автоматически
- `working` — рабочие группы (≤20 участников), Entity создаются автоматически
- `mass` — массовые группы/каналы (>20 участников), создаётся PendingResolution

**Constraints:** UNIQUE(telegram_chat_id)

---

### Phase C: Extraction Events

### extracted_events

События, извлечённые из сообщений AI-системой. Ожидают подтверждения пользователем перед конвертацией в EntityEvent или EntityFact.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| source_message_id | UUID | FK → messages (CASCADE) |
| source_interaction_id | UUID | FK → interactions (SET NULL), nullable |
| entity_id | UUID | FK → entities, nullable — сущность, которой касается событие |
| promise_to_entity_id | UUID | FK → entities, nullable — кому адресовано обещание (для PROMISE_BY_ME) |
| event_type | VARCHAR(30) | 'meeting', 'promise_by_me', 'promise_by_them', 'task', 'fact', 'cancellation' |
| extracted_data | JSONB | Структурированные данные события (зависят от event_type) |
| source_quote | TEXT | Оригинальная цитата из сообщения, nullable |
| confidence | NUMERIC(3,2) | 0.00-1.00 — уверенность AI |
| status | VARCHAR(20) | 'pending', 'confirmed', 'rejected', 'auto_processed', 'expired' |
| result_entity_type | VARCHAR(30) | 'EntityEvent' \| 'EntityFact', nullable — тип созданной сущности при подтверждении |
| result_entity_id | UUID | ID созданной сущности, nullable |
| notification_sent_at | TIMESTAMPTZ | Когда уведомление отправлено пользователю, nullable |
| user_response_at | TIMESTAMPTZ | Когда пользователь ответил, nullable |
| linked_event_id | UUID | FK → extracted_events (SET NULL), nullable — связь с другим событием (context-aware) |
| needs_context | BOOLEAN | TRUE если событие абстрактно и требует уточнения. Default: false |
| enrichment_data | JSONB | Данные контекстного обогащения (keywords, relatedMessageIds, synthesis, subject resolution), nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Индексы:** source_message_id, entity_id, event_type, status, linked_event_id, promise_to_entity_id

**extracted_data JSONB варианты (по event_type):**
- `meeting`: `{ datetime?, dateText?, topic?, participants? }`
- `promise_by_me` / `promise_by_them`: `{ what, deadline?, deadlineText? }`
- `task`: `{ what, priority?, deadline?, deadlineText? }`
- `fact`: `{ factType, value, quote }`
- `cancellation`: `{ what, newDateTime?, newDateText?, reason? }`

**enrichment_data JSONB структура:**
```json
{
  "keywords": ["отчёт", "дедлайн"],
  "relatedMessageIds": ["uuid1", "uuid2"],
  "candidateEventIds": ["uuid3"],
  "synthesis": "Контекст найден: задача связана с проектом X",
  "enrichmentSuccess": true,
  "enrichedAt": "2025-01-15T10:00:00Z",
  "needsSubjectResolution": false,
  "subjectMention": "Игорь",
  "resolvedEntityId": "uuid4",
  "pendingConfirmationId": "uuid5"
}
```

---

### entity_events

Подтверждённые события и напоминания, связанные с сущностями (reminders, deadlines, follow-ups).

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| entity_id | UUID | FK → entities |
| related_entity_id | UUID | FK → entities, nullable — вторая сторона |
| event_type | VARCHAR(20) | 'meeting', 'deadline', 'commitment', 'follow_up' |
| title | VARCHAR(255) | Заголовок, nullable |
| description | TEXT | Описание, nullable |
| event_date | TIMESTAMPTZ | Дата/время события, nullable |
| status | VARCHAR(20) | 'scheduled', 'completed', 'cancelled', 'dismissed'. Default: 'scheduled' |
| confidence | NUMERIC(3,2) | 0.00-1.00 — уверенность, nullable |
| source_message_id | UUID | FK → messages, nullable — исходное сообщение |
| source_quote | TEXT | Цитата из источника, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Индексы:** entity_id, related_entity_id, event_date, status

---

### Phase D: Activity & Commitments

### activities

Иерархическая модель всех дел человека. Использует closure-table (TypeORM @Tree) + adjacency list + materialized path для гибкого доступа к иерархии.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| name | VARCHAR(500) | Название активности |
| activity_type | VARCHAR(30) | 'area', 'business', 'direction', 'project', 'initiative', 'task', 'milestone', 'habit', 'learning', 'event_series' |
| description | TEXT | Подробное описание, nullable |
| status | VARCHAR(20) | 'draft', 'idea', 'active', 'paused', 'completed', 'cancelled', 'archived'. Default: 'active' |
| priority | VARCHAR(20) | 'critical', 'high', 'medium', 'low', 'none'. Default: 'medium' |
| context | VARCHAR(20) | 'work', 'personal', 'any', 'location_based'. Default: 'any' |
| parent_id | UUID | FK → activities, nullable — родительская активность |
| depth | INTEGER | Глубина в дереве (0 = корень). Default: 0 |
| materialized_path | TEXT | "uuid1/uuid2/uuid3" от корня к текущему, nullable |
| owner_entity_id | UUID | FK → entities — владелец (обычно "я") |
| client_entity_id | UUID | FK → entities, nullable — клиент/заказчик |
| deadline | TIMESTAMPTZ | Дедлайн, nullable |
| start_date | TIMESTAMPTZ | Дата начала, nullable |
| end_date | TIMESTAMPTZ | Фактическая дата завершения, nullable |
| recurrence_rule | VARCHAR(100) | Cron-выражение для повторяющихся активностей, nullable |
| source_segment_id | UUID | FK → topical_segments, nullable — трaceability к Knowledge Layer |
| metadata | JSONB | Расширяемые метаданные: tags, color, external_ids, nullable |
| tags | TEXT[] | Теги для быстрой фильтрации (GIN index), nullable |
| progress | INTEGER | Прогресс выполнения 0-100%, nullable |
| embedding | VECTOR(1536) | Embedding для semantic deduplication, nullable |
| last_activity_at | TIMESTAMPTZ | Timestamp последней активности, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| deleted_at | TIMESTAMPTZ | Soft delete (rejected drafts, отменённые), nullable |

**Иерархия типов (допустимые пары parent → child):**
- `AREA` → `BUSINESS`, `PROJECT`, `HABIT`, `LEARNING`, `EVENT_SERIES`
- `BUSINESS` → `DIRECTION`, `PROJECT`, `TASK`
- `DIRECTION` → `PROJECT`, `TASK`
- `PROJECT` → `INITIATIVE`, `TASK`, `MILESTONE`
- `INITIATIVE` → `TASK`, `MILESTONE`
- `TASK` → `TASK` (подзадачи)

**Closure-table:** Дополнительная таблица `activities_closure` создаётся автоматически TypeORM для ancestor/descendant запросов.

**Индексы:** name, owner_entity_id, client_entity_id, activity_type, status, deadline, materialized_path, tags (GIN), last_activity_at, deleted_at

**Важно:** Из-за бага TypeORM 0.3.x с ClosureSubjectExecutor, для insert/update используется QueryBuilder вместо repository.save().

---

### activity_members

Участники активности с ролями. Связь между Activity и Entity (person/organization).

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| activity_id | UUID | FK → activities (CASCADE) |
| entity_id | UUID | FK → entities (CASCADE) |
| role | VARCHAR(20) | 'owner', 'member', 'observer', 'assignee', 'reviewer', 'client', 'consultant'. Default: 'member' |
| notes | TEXT | Заметки о роли/обязанностях, nullable |
| is_active | BOOLEAN | Активен ли участник (false = временно исключён). Default: true |
| joined_at | TIMESTAMPTZ | Дата присоединения, nullable |
| left_at | TIMESTAMPTZ | Дата выхода, nullable |
| metadata | JSONB | Дополнительные метаданные: permissions, preferences, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Constraints:** UNIQUE(activity_id, entity_id, role)

**Индексы:** activity_id, entity_id

---

### commitments

Обещания, соглашения и обязательства между людьми. Отслеживает кто кому что обещал, сроки и статус выполнения.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| type | VARCHAR(20) | 'promise', 'request', 'agreement', 'deadline', 'reminder', 'recurring', 'meeting' |
| title | VARCHAR(500) | Краткое описание обязательства |
| description | TEXT | Подробное описание, nullable |
| status | VARCHAR(20) | 'draft', 'pending', 'in_progress', 'completed', 'cancelled', 'overdue', 'deferred'. Default: 'pending' |
| priority | VARCHAR(20) | 'critical', 'high', 'medium', 'low'. Default: 'medium' |
| from_entity_id | UUID | FK → entities — кто дал обещание |
| to_entity_id | UUID | FK → entities — кому дано обещание |
| activity_id | UUID | FK → activities (SET NULL), nullable — связанный проект/задача |
| source_message_id | UUID | FK → messages (SET NULL), nullable — исходное сообщение |
| extracted_event_id | UUID | FK → extracted_events (SET NULL), nullable — связь с extraction pipeline |
| due_date | TIMESTAMPTZ | Срок выполнения, nullable |
| completed_at | TIMESTAMPTZ | Фактическая дата выполнения, nullable |
| recurrence_rule | VARCHAR(100) | Cron-выражение для периодических обязательств, nullable |
| next_reminder_at | TIMESTAMPTZ | Дата/время следующего напоминания, nullable |
| reminder_count | INTEGER | Количество отправленных напоминаний. Default: 0 |
| source_segment_id | UUID | FK → topical_segments, nullable — traceability к Knowledge Layer |
| confidence | FLOAT | Уверенность извлечения 0-1, nullable |
| metadata | JSONB | Дополнительные метаданные: context, extracted_phrases, nullable |
| notes | TEXT | Ручные заметки пользователя, nullable |
| embedding | VECTOR(1536) | Embedding для semantic deduplication, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| deleted_at | TIMESTAMPTZ | Soft delete (rejected drafts), nullable |

**Индексы:** from_entity_id, to_entity_id, status, due_date, activity_id, title, next_reminder_at, deleted_at

---

### Phase E: Knowledge System

### topical_segments

Семантические единицы обсуждения. Группа сообщений, объединённых общей темой. Связь с сообщениями через join-таблицу `segment_messages` (many-to-many).

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| topic | VARCHAR(500) | Название темы обсуждения |
| keywords | TEXT[] | Ключевые слова (для поиска), nullable |
| summary | TEXT | Краткое описание (авто-генерируется), nullable |
| chat_id | VARCHAR(100) | Telegram chat ID (источник сообщений) |
| interaction_id | UUID | FK → interactions (SET NULL), nullable |
| activity_id | UUID | FK → activities (SET NULL), nullable — привязка к проекту |
| participant_ids | UUID[] | Entity IDs участников обсуждения |
| primary_participant_id | UUID | FK → entities, nullable — основной собеседник |
| message_count | INTEGER | Количество сообщений (денормализовано). Default: 0 |
| started_at | TIMESTAMPTZ | Время первого сообщения в сегменте |
| ended_at | TIMESTAMPTZ | Время последнего сообщения |
| extracted_fact_ids | UUID[] | IDs извлечённых фактов. Default: {} |
| extracted_task_ids | UUID[] | IDs извлечённых задач. Default: {} |
| extracted_commitment_ids | UUID[] | IDs извлечённых обязательств. Default: {} |
| status | VARCHAR(20) | 'active', 'closed', 'packed', 'merged'. Default: 'active' |
| knowledge_pack_id | UUID | FK → knowledge_packs, nullable — если status=packed |
| merged_into_id | UUID | FK → topical_segments, nullable — если status=merged |
| related_segment_ids | UUID[] | Cross-chat linking. Default: {} |
| confidence | DECIMAL(3,2) | Уверенность в корректности сегментации 0-1. Default: 0.80 |
| metadata | JSONB | {segmentationReason, rawTopic, isPersonal, isWorkRelated, debugInfo}, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Join-таблица `segment_messages`:**

| Поле | Тип | Описание |
|------|-----|----------|
| segment_id | UUID | FK → topical_segments |
| message_id | UUID | FK → messages |

**Индексы:** topic, chat_id, interaction_id, activity_id, started_at, ended_at, status

---

### knowledge_packs

Консолидированные знания. Объединяет несколько TopicalSegment в компактное представление. Формируется периодически (еженедельно/ежемесячно) или по запросу.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| title | VARCHAR(500) | Название пакета знаний |
| pack_type | VARCHAR(20) | 'activity', 'entity', 'topic', 'period' |
| activity_id | UUID | FK → activities (SET NULL), nullable — для pack_type=activity |
| entity_id | UUID | FK → entities (SET NULL), nullable — для pack_type=entity |
| topic | VARCHAR(500) | Тема, nullable — для pack_type=topic |
| period_start | TIMESTAMPTZ | Начало покрываемого периода |
| period_end | TIMESTAMPTZ | Конец покрываемого периода |
| summary | TEXT | Сжатое summary всех знаний |
| decisions | JSONB | Ключевые решения: [{what, when, context?, sourceSegmentId?}]. Default: [] |
| open_questions | JSONB | Открытые вопросы: [{question, raisedAt, context?, sourceSegmentId?}]. Default: [] |
| key_facts | JSONB | Консолидированные факты: [{factType, value, confidence, sourceSegmentIds, lastUpdated}]. Default: [] |
| participant_ids | UUID[] | Участники обсуждений. Default: {} |
| source_segment_ids | UUID[] | IDs сегментов, вошедших в пакет |
| segment_count | INTEGER | Количество сегментов. Default: 0 |
| total_message_count | INTEGER | Общее количество сообщений. Default: 0 |
| conflicts | JSONB | Обнаруженные конфликты: [{type, description, segmentIds, resolved, resolution?}]. Default: [] |
| is_verified | BOOLEAN | Верифицирован пользователем. Default: false |
| verified_at | TIMESTAMPTZ | Дата верификации, nullable |
| status | VARCHAR(20) | 'draft', 'active', 'superseded', 'archived'. Default: 'draft' |
| superseded_by_id | UUID | FK → knowledge_packs, nullable — замена |
| metadata | JSONB | {packingVersion?, tokensUsed?, debugInfo?}, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Типы конфликтов:** `fact_contradiction`, `decision_change`, `timeline_inconsistency`

**Индексы:** title, pack_type, activity_id, entity_id, period_start, period_end, status

---

### System: Approval & Configuration

### pending_approvals

Тонкий референсный слой для approval workflow извлечённых сущностей. Target entities (EntityFact, Activity, Commitment) создаются с status='draft', а PendingApproval ссылается на них полиморфно (без FK constraint).

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| item_type | VARCHAR(20) | 'fact', 'project', 'task', 'commitment' |
| target_id | UUID | ID target entity (полиморфная ссылка, без FK) |
| batch_id | UUID | Группировка элементов одной extraction-сессии |
| status | VARCHAR(20) | 'pending', 'approved', 'rejected'. Default: 'pending' |
| confidence | DECIMAL(3,2) | 0.00-1.00 — уверенность извлечения |
| source_quote | TEXT | Цитата из исходного сообщения, nullable |
| source_interaction_id | UUID | FK → interactions, nullable |
| source_entity_id | UUID | FK → entities, nullable — денормализовано для быстрой фильтрации |
| context | TEXT | Человекочитаемое описание (e.g., "work: маркетолог"), nullable |
| message_ref | VARCHAR(100) | Telegram message ref "chatId:messageId" для inline keyboards, nullable |
| created_at | TIMESTAMPTZ | |
| reviewed_at | TIMESTAMPTZ | Дата approve/reject, nullable |

**Workflow:**
- On approve: target.status → 'active', approval.status → 'approved'
- On reject: target.deletedAt = now() (soft delete), approval.status → 'rejected'
- Cleanup job hard-deletes rejected items after retention period

**Индексы:** item_type, target_id, batch_id, status, (batch_id + status), (status + reviewed_at), source_interaction_id, source_entity_id

---

### pending_confirmations

Унифицированная сущность для всех потоков подтверждения от пользователя: привязка идентификаторов, merge entity, определение субъекта факта.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| type | VARCHAR(50) | 'identifier_attribution', 'entity_merge', 'fact_subject', 'fact_value' |
| context | JSONB | {title, description, sourceQuote?} — данные для отображения пользователю |
| options | JSONB | Варианты для выбора: [{id, label, sublabel?, entityId?, isCreateNew?, isDecline?, isOther?}] |
| confidence | DECIMAL(3,2) | AI confidence в предложенном варианте, nullable |
| status | VARCHAR(20) | 'pending', 'confirmed', 'declined', 'expired'. Default: 'pending' |
| source_message_id | UUID | FK → messages (SET NULL), nullable |
| source_entity_id | UUID | FK → entities (SET NULL), nullable |
| source_pending_fact_id | UUID | FK → pending_facts (SET NULL), nullable |
| source_extracted_event_id | UUID | FK → extracted_events (SET NULL), nullable |
| selected_option_id | VARCHAR(100) | ID выбранного варианта, nullable |
| resolution | JSONB | Дополнительные данные решения, nullable |
| resolved_by | VARCHAR(20) | 'user', 'auto', 'expired', nullable |
| created_at | TIMESTAMPTZ | |
| expires_at | TIMESTAMPTZ | Дата истечения, nullable |
| resolved_at | TIMESTAMPTZ | Дата решения, nullable |

**Индексы:** type, status, source_entity_id

---

### data_quality_reports

Отчёты о качестве данных: метрики, обнаруженные проблемы и их разрешения.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| report_date | TIMESTAMPTZ | Дата создания отчёта |
| metrics | JSONB | Метрики качества данных |
| issues | JSONB | Обнаруженные проблемы |
| resolutions | JSONB | Записи о разрешении проблем, nullable |
| status | VARCHAR(20) | 'PENDING', 'REVIEWED', 'RESOLVED'. Default: 'PENDING' |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**metrics JSONB структура:**
```json
{
  "totalActivities": 150,
  "duplicateGroups": 3,
  "orphanedTasks": 12,
  "missingClientEntity": 5,
  "activityMemberCoverage": 0.85,
  "commitmentLinkageRate": 0.72,
  "inferredRelationsCount": 45,
  "fieldFillRate": 0.91
}
```

**issues JSONB структура:**
```json
[{
  "type": "DUPLICATE|ORPHAN|MISSING_CLIENT|MISSING_MEMBERS|UNLINKED_COMMITMENT|EMPTY_FIELDS",
  "severity": "HIGH|MEDIUM|LOW",
  "activityId": "uuid",
  "activityName": "Проект X",
  "description": "Описание проблемы",
  "suggestedAction": "Рекомендуемое действие"
}]
```

**Индексы:** status, report_date

---

### settings

Key-value хранилище конфигурации.

| Поле | Тип | Описание |
|------|-----|----------|
| key | VARCHAR | PK — ключ настройки |
| value | JSONB | Значение |
| description | VARCHAR | Описание настройки, nullable |
| category | VARCHAR | Категория. Default: 'general' |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

---

### users

Пользователи системы (авторизация dashboard).

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| username | VARCHAR(100) | UNIQUE — логин |
| email | VARCHAR(255) | UNIQUE, nullable |
| password_hash | VARCHAR(255) | Хэш пароля |
| display_name | VARCHAR(100) | Отображаемое имя, nullable |
| role | ENUM | 'admin', 'user'. Default: 'user' |
| status | ENUM | 'active', 'inactive', 'locked'. Default: 'active' |
| last_login_at | TIMESTAMPTZ | Последний вход, nullable |
| failed_login_attempts | SMALLINT | Неудачные попытки входа. Default: 0 |
| locked_until | TIMESTAMPTZ | Блокировка до, nullable |
| metadata | JSONB | Дополнительные метаданные, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Индексы:** username, email, status

---

### Relationships & Inference

### entity_relations

Контейнер связи между сущностями. Поддерживает N-арные связи (команды, семьи) через EntityRelationMember.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| relation_type | VARCHAR(50) | 'employment', 'reporting', 'team', 'marriage', 'parenthood', 'siblinghood', 'friendship', 'acquaintance', 'mentorship', 'partnership', 'client_vendor' |
| metadata | JSONB | Дополнительные метаданные: {since, note}, nullable |
| source | VARCHAR(20) | 'manual', 'extracted', 'imported', 'inferred'. Default: 'extracted' |
| confidence | DECIMAL(3,2) | 0.0-1.0 (для extracted/inferred), nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Связи → entity_relation_members (1:n, cascade, eager)**

**Допустимые роли по типу связи:**

| Тип | Роли | Cardinality |
|-----|------|-------------|
| employment | employee, employer | 2 |
| reporting | subordinate, manager | 2 |
| team | member, lead | 2-100 |
| marriage | spouse | 2 |
| parenthood | parent, child | 2 |
| siblinghood | sibling | 2-20 |
| friendship | friend | 2 |
| acquaintance | acquaintance | 2 |
| mentorship | mentor, mentee | 2 |
| partnership | partner | 2-10 |
| client_vendor | client, vendor | 2 |

---

### entity_relation_members

Участники связи с ролями. Composite PK: (relation_id, entity_id, role).

| Поле | Тип | Описание |
|------|-----|----------|
| relation_id | UUID | PK, FK → entity_relations (CASCADE) |
| entity_id | UUID | PK, FK → entities (CASCADE) |
| role | VARCHAR(50) | PK — роль в связи (employee, spouse, member, etc.) |
| label | VARCHAR(100) | Человекочитаемая метка ('Маша', 'директор'), nullable |
| properties | JSONB | Дополнительные свойства: {position, since}, nullable |
| valid_until | TIMESTAMP | Soft delete для участия (уволился, развёлся), nullable |

**Индексы:** entity_id, entity_id (partial WHERE valid_until IS NULL)

---

### entity_relationship_profiles

Агрегированный профиль отношений с сущностью. One-to-one с Entity. Создаётся/обновляется при profile aggregation.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| entity_id | UUID | FK → entities (CASCADE), UNIQUE |
| relationship_type | VARCHAR(30) | 'client', 'partner', 'colleague', 'friend', 'acquaintance', 'vendor', 'other' |
| communication_frequency | VARCHAR(20) | 'daily', 'weekly', 'monthly', 'quarterly', 'rare' |
| relationship_summary | TEXT | Текстовое описание отношений |
| relationship_timeline | TEXT | Хронология отношений, nullable |
| first_interaction_date | TIMESTAMPTZ | Дата первого взаимодействия |
| last_meaningful_contact | TIMESTAMPTZ | Последний значимый контакт |
| total_interactions | INTEGER | Всего взаимодействий |
| total_messages | INTEGER | Всего сообщений |
| top_topics | JSONB | Основные темы общения. Default: [] |
| milestones | JSONB | Ключевые вехи: [{date, title, description}]. Default: [] |
| key_decisions | JSONB | Ключевые решения: [{date, description, quote?}]. Default: [] |
| open_action_items | JSONB | Открытые задачи: [{description, owner}]. Default: [] |
| summarized_interactions_count | INTEGER | Количество суммаризированных взаимодействий |
| coverage_start | TIMESTAMPTZ | Начало покрытия профиля |
| coverage_end | TIMESTAMPTZ | Конец покрытия |
| model_version | VARCHAR(50) | Версия модели генерации, nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Индексы:** entity_id (UNIQUE)

---

### group_memberships

Участники Telegram групп. Отслеживает кто состоит/состоял в каких группах.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| telegram_chat_id | VARCHAR(100) | ID группы в Telegram |
| entity_id | UUID | FK → entities, nullable |
| telegram_user_id | VARCHAR(100) | Telegram user ID |
| display_name | VARCHAR(255) | Имя участника, nullable |
| joined_at | TIMESTAMPTZ | Дата присоединения |
| left_at | TIMESTAMPTZ | Дата выхода (NULL = активен), nullable |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**Computed:** `isActive` = (left_at IS NULL)

**Индексы:** telegram_chat_id, telegram_user_id, (telegram_chat_id + telegram_user_id)

---

### dismissed_merge_suggestions

Отклонённые предложения merge сущностей. Предотвращает повторное предложение одних и тех же пар.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| primary_entity_id | UUID | FK → entities (CASCADE) |
| dismissed_entity_id | UUID | FK → entities (CASCADE) |
| dismissed_by | VARCHAR(50) | Кто отклонил. Default: 'user' |
| dismissed_at | TIMESTAMPTZ | Дата отклонения |

**Constraints:** UNIQUE(primary_entity_id, dismissed_entity_id)

**Индексы:** primary_entity_id

---

### Audit & Monitoring

### claude_agent_runs

Аудит запусков Claude Agent SDK. Фиксирует каждый вызов AI: стоимость, токены, инструменты, результат.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| task_type | VARCHAR(50) | Тип задачи (см. полный список ниже) |
| mode | VARCHAR(20) | 'oneshot' \| 'agent'. Default: 'oneshot' |
| model | VARCHAR(50) | Модель (e.g., 'claude-sonnet-4-5-20250514') |
| tokens_in | INTEGER | Входные токены, nullable |
| tokens_out | INTEGER | Выходные токены, nullable |
| cost_usd | DECIMAL(10,6) | Стоимость в USD, nullable |
| duration_ms | INTEGER | Длительность в миллисекундах |
| turns_count | INTEGER | Количество оборотов агента. Default: 1 |
| tools_used | JSONB | Использованные инструменты, nullable |
| success | BOOLEAN | Успешно ли завершилось |
| error_message | TEXT | Сообщение об ошибке, nullable |
| reference_type | VARCHAR(50) | 'interaction', 'entity', 'message', 'extracted_event', nullable |
| reference_id | UUID | ID связанной сущности, nullable |
| input_preview | TEXT | Первые 500 символов входных данных, nullable |
| output_preview | TEXT | Первые 500 символов выходных данных, nullable |
| created_at | TIMESTAMPTZ | |
| created_date | DATE | Дата для аналитической группировки |

**Типы задач:** `summarization`, `profile_aggregation`, `context_synthesis`, `fact_extraction`, `event_extraction`, `context_enrichment`, `fact_fusion`, `recall`, `meeting_prep`, `daily_brief`, `action`, `draft_generation`, `message_regeneration`, `unified_extraction`, `group_extraction`, `fact_dedup_review`, `description_enrichment`, `event_cleanup_dedup`, `event_activity_match`, `activity_semantic_dedup`, `topic_segmentation`, `knowledge_packing`, `project_name_match`

**Индексы:** task_type, reference_id, created_date

---

### claude_cli_runs

Legacy-аудит запусков Claude CLI (до миграции на Agent SDK). Сохраняется для обратной совместимости.

| Поле | Тип | Описание |
|------|-----|----------|
| id | UUID | PK |
| task_type | VARCHAR(50) | 'summarization', 'profile_aggregation', 'context_synthesis', 'fact_extraction' |
| model | VARCHAR(50) | Модель |
| agent_name | VARCHAR(50) | Имя агента, nullable |
| tokens_in | INTEGER | Входные токены, nullable |
| tokens_out | INTEGER | Выходные токены, nullable |
| cost_usd | DECIMAL(10,6) | Стоимость, nullable |
| duration_ms | INTEGER | Длительность |
| success | BOOLEAN | |
| error_message | TEXT | nullable |
| reference_type | VARCHAR(50) | 'interaction', 'entity', 'message', nullable |
| reference_id | UUID | nullable |
| input_preview | TEXT | nullable |
| output_preview | TEXT | nullable |
| created_at | TIMESTAMPTZ | |
| created_date | DATE | |

**Индексы:** reference_id, created_date

---

## Типы фактов (fact_type)

### Personal
| Тип | Описание |
|-----|----------|
| birthday | День рождения |
| name_full | Полное имя |
| nickname | Прозвище |

### Contact
| Тип | Описание |
|-----|----------|
| phone_work | Рабочий телефон |
| phone_personal | Личный телефон |
| email_work | Рабочий email |
| email_personal | Личный email |
| address | Адрес |
| telegram | Telegram username |

### Professional
| Тип | Описание |
|-----|----------|
| position | Должность |
| department | Отдел |
| company | Компания |
| specialization | Специализация |

### Business (для Organization)
| Тип | Описание |
|-----|----------|
| inn | ИНН |
| kpp | КПП |
| ogrn | ОГРН |
| legal_address | Юридический адрес |
| actual_address | Фактический адрес |
| bank_account | Расчётный счёт |

---

## Миграции

### Включение pgvector

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Создание индексов для vector search

```sql
CREATE INDEX ON messages
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

CREATE INDEX ON transcript_segments
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

### Full-text search index

```sql
CREATE INDEX messages_content_fts ON messages
USING GIN (to_tsvector('russian', content));
```
