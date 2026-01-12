# Модель данных PKG

## Обзор

Модель данных построена вокруг трёх ключевых абстракций:
- **Entity** — человек или организация
- **Interaction** — единица взаимодействия (сессия чата, звонок, встреча)
- **Content** — содержимое взаимодействия (сообщения, сегменты транскрипции)

## ER-диаграмма

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  ┌─────────────┐         ┌─────────────────┐         ┌─────────────────┐   │
│  │   Entity    │────────►│ EntityIdentifier │         │  EntityFact     │   │
│  │             │ 1    n  │                 │         │                 │   │
│  │  • Person   │         │ • telegram_id   │         │ • birthday      │   │
│  │  • Org      │◄────────│ • phone         │         │ • position      │   │
│  └──────┬──────┘         └─────────────────┘         │ • inn           │   │
│         │                                            └────────┬────────┘   │
│         │ 1                                                   │ n          │
│         │                                                     │            │
│         ▼ n                                                   │            │
│  ┌─────────────────────┐                              ┌───────▼────────┐   │
│  │ InteractionParticip.│◄─────────────────────────────│    Entity      │   │
│  └──────────┬──────────┘                              └────────────────┘   │
│             │ n                                                            │
│             │                                                              │
│             ▼ 1                                                            │
│  ┌─────────────────────┐                                                   │
│  │    Interaction      │                                                   │
│  │                     │                                                   │
│  │ • telegram_session  │                                                   │
│  │ • phone_call        │                                                   │
│  │ • video_meeting     │                                                   │
│  └──────────┬──────────┘                                                   │
│             │ 1                                                            │
│             │                                                              │
│             ▼ n                                                            │
│  ┌─────────────────────┐         ┌─────────────────┐                      │
│  │      Message        │         │TranscriptSegment│                      │
│  │  (telegram, etc.)   │         │  (phone calls)  │                      │
│  └─────────────────────┘         └─────────────────┘                      │
│                                                                             │
│  ┌─────────────────────┐         ┌─────────────────┐                      │
│  │ PendingEntityRes.   │         │InteractionSumm. │                      │
│  │                     │         │ (tiered storage)│                      │
│  └─────────────────────┘         └─────────────────┘                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
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
